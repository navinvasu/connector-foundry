# ─── S3: eval-report bucket (EV-03) + console static-hosting bucket ─────────

# ─── Eval reports: private bucket, the host role has Put/Get ─────────────────

resource "aws_s3_bucket" "reports" {
  bucket = "${local.name}-eval-reports"

  tags = { Name = "${local.name}-eval-reports" }
}

resource "aws_s3_bucket_versioning" "reports" {
  bucket = aws_s3_bucket.reports.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "reports" {
  bucket = aws_s3_bucket.reports.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "reports" {
  bucket = aws_s3_bucket.reports.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "reports" {
  bucket = aws_s3_bucket.reports.id

  rule {
    id     = "expire-old-reports"
    status = "Enabled"

    filter {}

    expiration {
      days = var.reports_retention_days
    }
  }
}

resource "aws_s3_bucket_policy" "reports" {
  bucket = aws_s3_bucket.reports.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "HostRoleAccess"
        Effect    = "Allow"
        Principal = { AWS = aws_iam_role.host.arn }
        Action = [
          "s3:PutObject",
          "s3:GetObject",
          "s3:DeleteObject",
        ]
        Resource = "${aws_s3_bucket.reports.arn}/${var.cf_report_s3_prefix}/*"
      },
    ]
  })

  depends_on = [aws_s3_bucket_public_access_block.reports]
}

# ─── Console: private bucket served through CloudFront (cdn.tf) ─────────────

resource "aws_s3_bucket" "console" {
  bucket = "${local.name}-console"

  tags = { Name = "${local.name}-console" }
}

resource "aws_s3_bucket_versioning" "console" {
  bucket = aws_s3_bucket.console.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "console" {
  bucket = aws_s3_bucket.console.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "console" {
  bucket = aws_s3_bucket.console.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
