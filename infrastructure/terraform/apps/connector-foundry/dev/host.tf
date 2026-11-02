# ─── The API host (IN-10, D-86) ──────────────────────────────────────────────
# One arm64 EC2 instance runs backend/deploy/compose.host.yml: the API
# container and Postgres 16. Postgres data lives on a separate encrypted EBS
# volume (survives instance replacement; daily DLM snapshots). Stop the
# instance between demos: CloudFront keeps the URL, the Elastic IP keeps the
# origin, and only the EIP + EBS + KMS keep billing (~$7/month).

# ─── ECR ─────────────────────────────────────────────────────────────────────

resource "aws_ecr_repository" "backend" {
  name                 = "${local.name}-backend"
  image_tag_mutability = "MUTABLE"
  force_delete         = true

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = { Name = "${local.name}-backend" }
}

resource "aws_ecr_lifecycle_policy" "backend" {
  repository = aws_ecr_repository.backend.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the 3 newest images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 3
      }
      action = { type = "expire" }
    }]
  })
}

# ─── IAM: instance role ──────────────────────────────────────────────────────

resource "aws_iam_role" "host" {
  name = "${local.name}-host"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = { Name = "${local.name}-host" }
}

# Session Manager (no SSH) + Run Command for deploys.
resource "aws_iam_role_policy_attachment" "host_ssm_core" {
  role       = aws_iam_role.host.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "host_runtime" {
  name = "${local.name}-host-runtime"
  role = aws_iam_role.host.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ReadOwnConfig"
        Effect   = "Allow"
        Action   = ["ssm:GetParametersByPath", "ssm:GetParameters", "ssm:GetParameter"]
        Resource = "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter${local.ssm_prefix}*"
      },
      {
        Sid      = "EcrAuth"
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken"]
        Resource = "*"
      },
      {
        Sid      = "EcrPull"
        Effect   = "Allow"
        Action   = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"]
        Resource = aws_ecr_repository.backend.arn
      },
      {
        Sid      = "EvalReportsS3"
        Effect   = "Allow"
        Action   = ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"]
        Resource = "${aws_s3_bucket.reports.arn}/${var.cf_report_s3_prefix}/*"
      },
      {
        Sid      = "CredentialBrokerKms"
        Effect   = "Allow"
        Action   = ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey", "kms:DescribeKey"]
        Resource = aws_kms_key.credentials.arn
      },
      {
        # D-88: agent tasks, fix suggestions and the playground (Nova 2 Lite).
        Sid      = "BedrockInvoke"
        Effect   = "Allow"
        Action   = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]
        Resource = var.bedrock_model_arns
      },
      {
        Sid      = "SesSend"
        Effect   = "Allow"
        Action   = ["ses:SendEmail", "ses:SendRawEmail"]
        Resource = "*"
        Condition = {
          StringEquals = { "ses:FromAddress" = "noreply@${var.domain_name}" }
        }
      },
    ]
  })
}

resource "aws_iam_instance_profile" "host" {
  name = "${local.name}-host"
  role = aws_iam_role.host.name
}

# ─── Instance + data volume ──────────────────────────────────────────────────

data "aws_ssm_parameter" "al2023_arm64" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"
}

resource "aws_ebs_volume" "data" {
  availability_zone = aws_subnet.public.availability_zone
  size              = var.data_volume_gb
  type              = "gp3"
  encrypted         = true

  tags = {
    Name     = "${local.name}-data"
    Snapshot = "${local.name}-data" # DLM target
  }
}

resource "aws_instance" "host" {
  # The AMI id moves with every AL2023 release; ignore it so a plan never
  # proposes replacing the host just because a newer image exists.
  ami                    = data.aws_ssm_parameter.al2023_arm64.value
  instance_type          = var.instance_type
  subnet_id              = aws_subnet.public.id
  vpc_security_group_ids = [aws_security_group.host.id]
  iam_instance_profile   = aws_iam_instance_profile.host.name

  metadata_options {
    http_tokens                 = "required" # IMDSv2 only
    http_put_response_hop_limit = 2          # containers reach the role through the host
  }

  root_block_device {
    volume_type = "gp3"
    volume_size = 20
    encrypted   = true
  }

  user_data = templatefile("${path.module}/host-user-data.sh.tftpl", {
    region         = var.aws_region
    ssm_prefix     = local.ssm_prefix
    data_volume_id = aws_ebs_volume.data.id
    compose_yaml   = file("${path.module}/../../../../../projects/connector-foundry/backend/deploy/compose.host.yml")
  })

  lifecycle {
    ignore_changes = [ami, user_data]
  }

  tags = { Name = "${local.name}-host" }
}

resource "aws_volume_attachment" "data" {
  device_name = "/dev/sdf"
  volume_id   = aws_ebs_volume.data.id
  instance_id = aws_instance.host.id
}

# Stable origin for CloudFront across stop/start.
resource "aws_eip" "host" {
  domain   = "vpc"
  instance = aws_instance.host.id

  tags = { Name = "${local.name}-host" }

  depends_on = [aws_internet_gateway.main]
}

# ─── Daily snapshots of the data volume (keep N) ─────────────────────────────

resource "aws_iam_role" "dlm" {
  name = "${local.name}-dlm"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "dlm.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "dlm" {
  role       = aws_iam_role.dlm.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRole"
}

resource "aws_dlm_lifecycle_policy" "data" {
  description        = "${local.name} data volume: daily snapshots"
  execution_role_arn = aws_iam_role.dlm.arn
  state              = "ENABLED"

  policy_details {
    resource_types = ["VOLUME"]
    target_tags    = { Snapshot = "${local.name}-data" }

    schedule {
      name      = "daily"
      copy_tags = true

      create_rule {
        interval      = 24
        interval_unit = "HOURS"
        times         = ["08:00"]
      }

      retain_rule {
        count = var.snapshot_retain_count
      }
    }
  }
}
