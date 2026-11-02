# ─── Compute: ECR + ECS Fargate + ALB (HTTPS) ────────────────────────────────

# ─── Wildcard ACM certificate (api.* + console.*) ────────────────────────────
# DNS validation: add the records from the `acm_validation_records` output to
# the domain's DNS, then `terraform apply` again to complete validation.
# (ALB needs the cert in us-east-1 — which is our region — and CloudFront
# also requires us-east-1, so one cert serves both.)

resource "aws_acm_certificate" "wildcard" {
  domain_name               = "*.${var.domain_name}"
  subject_alternative_names = [var.domain_name]
  validation_method         = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = { Name = "${local.name}-wildcard-cert" }
}

# ─── ECR ─────────────────────────────────────────────────────────────────────

resource "aws_ecr_repository" "backend" {
  name                 = "${local.name}-backend"
  image_tag_mutability = "MUTABLE"
  force_delete         = var.environment != "prod"

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = { Name = "${local.name}-backend" }
}

# ─── Security groups ─────────────────────────────────────────────────────────

resource "aws_security_group" "alb" {
  name        = "${local.name}-alb-sg"
  description = "ALB — public HTTPS"
  vpc_id      = data.terraform_remote_state.shared.outputs.vpc_id

  tags = { Name = "${local.name}-alb-sg" }
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
  description       = "Public HTTPS"
}

resource "aws_vpc_security_group_ingress_rule" "alb_http" {
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 80
  to_port           = 80
  ip_protocol       = "tcp"
  description       = "HTTP for redirect to HTTPS"
}

resource "aws_vpc_security_group_egress_rule" "alb_all" {
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
  description       = "Allow all outbound"
}

resource "aws_security_group" "backend" {
  name        = "${local.name}-backend-sg"
  description = "Backend tasks — ALB only"
  vpc_id      = data.terraform_remote_state.shared.outputs.vpc_id

  tags = { Name = "${local.name}-backend-sg" }
}

resource "aws_vpc_security_group_ingress_rule" "backend_from_alb" {
  security_group_id            = aws_security_group.backend.id
  referenced_security_group_id = aws_security_group.alb.id
  from_port                    = 4000
  to_port                      = 4000
  ip_protocol                  = "tcp"
  description                  = "Backend port from ALB"
}

resource "aws_vpc_security_group_egress_rule" "backend_all" {
  security_group_id = aws_security_group.backend.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
  description       = "Allow all outbound (upstream APIs, SES, S3)"
}

# Aurora ingress — the DB security group lives in the shared stack; the rule
# lives here next to the backend SG it references (avoids a cross-stack
# cycle: shared -> app -> shared).
resource "aws_vpc_security_group_ingress_rule" "db_from_backend" {
  security_group_id            = data.terraform_remote_state.shared.outputs.db_security_group_id
  referenced_security_group_id = aws_security_group.backend.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  description                  = "PostgreSQL from backend tasks"
}

# ─── ALB ─────────────────────────────────────────────────────────────────────

resource "aws_lb" "api" {
  # Name capped at 32 chars (AWS limit): "${local.name}" is 25 chars here.
  name               = "${local.name}-alb"
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = data.terraform_remote_state.shared.outputs.public_subnet_ids

  tags = { Name = "${local.name}-api-alb" }
}

resource "aws_lb_target_group" "backend" {
  # Name capped at 32 chars (AWS limit).
  name        = "${local.name}-tg"
  port        = 4000
  protocol    = "HTTP"
  vpc_id      = data.terraform_remote_state.shared.outputs.vpc_id
  target_type = "ip"

  health_check {
    path                = "/health"
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 2
  }

  tags = { Name = "${local.name}-backend-tg" }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.api.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate.wildcard.arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.backend.arn
  }
}

resource "aws_lb_listener" "http_redirect" {
  load_balancer_arn = aws_lb.api.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"

    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

# ─── IAM: execution role + task role ─────────────────────────────────────────

resource "aws_iam_role" "backend_execution" {
  name = "${local.name}-backend-execution"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = { Name = "${local.name}-backend-execution" }
}

resource "aws_iam_role_policy_attachment" "backend_execution" {
  role       = aws_iam_role.backend_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Execution role also reads the DATABASE_URL secret at task start.
resource "aws_iam_role_policy" "backend_execution_secrets" {
  name = "${local.name}-execution-secrets"
  role = aws_iam_role.backend_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
      Resource = concat(
        [data.terraform_remote_state.shared.outputs.database_url_secret_arn],
        aws_secretsmanager_secret.signing_secret[*].arn,
        aws_secretsmanager_secret.stripe_secret_key[*].arn,
        aws_secretsmanager_secret.stripe_webhook_secret[*].arn,
      )
    }]
  })
}

resource "aws_iam_role" "backend_task" {
  name = "${local.name}-backend-task"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = { Name = "${local.name}-backend-task" }
}

# Task role: S3 eval reports (bucket policy also grants this role), KMS
# envelope encryption for the credential broker, SES for invite/dunning mail.
resource "aws_iam_role_policy" "backend_task_runtime" {
  name = "${local.name}-task-runtime"
  role = aws_iam_role.backend_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "EvalReportsS3"
        Effect = "Allow"
        Action = [
          "s3:PutObject",
          "s3:GetObject",
          "s3:DeleteObject",
        ]
        Resource = "${aws_s3_bucket.reports.arn}/${var.cf_report_s3_prefix}/*"
      },
      {
        Sid    = "CredentialBrokerKms"
        Effect = "Allow"
        Action = [
          "kms:Encrypt",
          "kms:Decrypt",
          "kms:GenerateDataKey",
          "kms:DescribeKey",
        ]
        Resource = aws_kms_key.credentials.arn
      },
      {
        Sid      = "SesSend"
        Effect   = "Allow"
        Action   = ["ses:SendEmail", "ses:SendRawEmail"]
        Resource = "*"
        Condition = {
          StringEquals = {
            "ses:FromAddress" = "noreply@${var.domain_name}"
          }
        }
      },
    ]
  })
}

# ─── CloudWatch logs ─────────────────────────────────────────────────────────

resource "aws_cloudwatch_log_group" "backend" {
  name              = "/ecs/${local.name}-backend"
  retention_in_days = var.environment == "prod" ? 90 : 30

  tags = { Name = "${local.name}-backend-logs" }
}

# ─── ECS cluster + task definition + service ─────────────────────────────────

resource "aws_ecs_cluster" "main" {
  name = "${local.name}-cluster"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = { Name = "${local.name}-cluster" }
}

locals {
  api_host     = "${var.api_subdomain}.${var.domain_name}"
  console_host = "${var.console_subdomain}.${var.domain_name}"

  backend_env = [
    { name = "PORT", value = "4000" },
    { name = "CF_DEV_AUTH", value = "false" },
    { name = "CF_DEV_EMAIL", value = var.cf_dev_email },
    { name = "COGNITO_REGION", value = var.aws_region },
    { name = "COGNITO_USER_POOL_ID", value = module.user_pool.id },
    { name = "COGNITO_CLIENT_ID", value = aws_cognito_user_pool_client.console.id },
    { name = "CONSOLE_BASE_URL", value = var.console_base_url },
    { name = "CF_REPORT_S3_BUCKET", value = aws_s3_bucket.reports.id },
    { name = "CF_REPORT_S3_PREFIX", value = var.cf_report_s3_prefix },
    { name = "CF_REPORT_URL_TTL_SECONDS", value = var.cf_report_url_ttl_seconds },
    { name = "CF_UPSTREAM_TIMEOUT_MS", value = var.cf_upstream_timeout_ms },
    { name = "CF_CIRCUIT_FAILURE_THRESHOLD", value = var.cf_circuit_failure_threshold },
    { name = "CF_CIRCUIT_COOLDOWN_MS", value = var.cf_circuit_cooldown_ms },
    { name = "CF_DUNNING_RESTRICT_DAYS", value = var.cf_dunning_restrict_days },
    { name = "CF_DUNNING_SUSPEND_DAYS", value = var.cf_dunning_suspend_days },
    { name = "CF_CORS_ORIGINS", value = var.cf_cors_origins },
  ]

  backend_secrets = [
    { name = "DATABASE_URL", valueFrom = data.terraform_remote_state.shared.outputs.database_url_secret_arn },
  ]
}

resource "aws_ecs_task_definition" "backend" {
  family                   = "${local.name}-backend"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = tostring(var.ecs_cpu)
  memory                   = tostring(var.ecs_memory)
  execution_role_arn       = aws_iam_role.backend_execution.arn
  task_role_arn            = aws_iam_role.backend_task.arn

  container_definitions = jsonencode([
    {
      name      = "backend"
      image     = var.backend_image_uri
      essential = true

      portMappings = [{
        containerPort = 4000
        protocol      = "tcp"
      }]

      environment = local.backend_env

      # Secrets injected by the execution role. CF_SIGNING_SECRET and the
      # Stripe keys are only added when non-empty so a staging deploy can
      # run before payments are configured.
      secrets = concat(
        local.backend_secrets,
        var.cf_signing_secret != "" ? [
          {
            name      = "CF_SIGNING_SECRET"
            valueFrom = aws_secretsmanager_secret.signing_secret[0].arn
          },
        ] : [],
        var.stripe_secret_key != "" ? [
          {
            name      = "STRIPE_SECRET_KEY"
            valueFrom = aws_secretsmanager_secret.stripe_secret_key[0].arn
          },
        ] : [],
        var.stripe_webhook_secret != "" ? [
          {
            name      = "STRIPE_WEBHOOK_SECRET"
            valueFrom = aws_secretsmanager_secret.stripe_webhook_secret[0].arn
          },
        ] : [],
      )

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.backend.name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "backend"
        }
      }

      # Liveness is covered by the ALB target-group health check (/health);
      # no container health check so we don't depend on wget/curl existing
      # in the image.
    },
  ])

  tags = { Name = "${local.name}-backend-task" }
}

# Optional secrets — created only when the corresponding variable is set, so
# `terraform plan` stays honest about what is and isn't configured.
resource "aws_secretsmanager_secret" "signing_secret" {
  count                   = var.cf_signing_secret != "" ? 1 : 0
  name                    = "${local.name}/signing-secret"
  description             = "CF_SIGNING_SECRET for release manifest signing"
  recovery_window_in_days = var.environment == "prod" ? 30 : 0
}

resource "aws_secretsmanager_secret_version" "signing_secret" {
  count         = var.cf_signing_secret != "" ? 1 : 0
  secret_id     = aws_secretsmanager_secret.signing_secret[0].id
  secret_string = var.cf_signing_secret
}

resource "aws_secretsmanager_secret" "stripe_secret_key" {
  count                   = var.stripe_secret_key != "" ? 1 : 0
  name                    = "${local.name}/stripe-secret-key"
  description             = "STRIPE_SECRET_KEY"
  recovery_window_in_days = var.environment == "prod" ? 30 : 0
}

resource "aws_secretsmanager_secret_version" "stripe_secret_key" {
  count         = var.stripe_secret_key != "" ? 1 : 0
  secret_id     = aws_secretsmanager_secret.stripe_secret_key[0].id
  secret_string = var.stripe_secret_key
}

resource "aws_secretsmanager_secret" "stripe_webhook_secret" {
  count                   = var.stripe_webhook_secret != "" ? 1 : 0
  name                    = "${local.name}/stripe-webhook-secret"
  description             = "STRIPE_WEBHOOK_SECRET"
  recovery_window_in_days = var.environment == "prod" ? 30 : 0
}

resource "aws_secretsmanager_secret_version" "stripe_webhook_secret" {
  count         = var.stripe_webhook_secret != "" ? 1 : 0
  secret_id     = aws_secretsmanager_secret.stripe_webhook_secret[0].id
  secret_string = var.stripe_webhook_secret
}

resource "aws_ecs_service" "backend" {
  name            = "${local.name}-backend"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.backend.arn
  desired_count   = var.ecs_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = data.terraform_remote_state.shared.outputs.private_subnet_ids
    security_groups  = [aws_security_group.backend.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.backend.arn
    container_name   = "backend"
    container_port   = 4000
  }

  # Let the deployment controller replace tasks on new revisions.
  deployment_minimum_healthy_percent = 50
  deployment_maximum_percent         = 200

  depends_on = [aws_lb_listener.https]

  tags = { Name = "${local.name}-backend-service" }
}
