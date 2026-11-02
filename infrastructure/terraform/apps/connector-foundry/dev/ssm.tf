# ─── Runtime configuration in SSM (D-86) ────────────────────────────────────
# Every parameter under /connector-foundry/<env>/env/ becomes one line of the
# host's .env (NAME=value) — deploy.sh rebuilds the file from this path on
# every deploy, so config changes are `aws ssm put-parameter` + redeploy.
# Secrets are SecureString (aws/ssm key); generated ones never touch tfvars.
#
# Parameters Terraform seeds but does not own afterwards (lifecycle
# ignore_changes): CF_IMAGE (each deploy pins a tag) and the LLM choice
# (Monday's switch to Muse Spark is a put-parameter, not an apply). The
# Muse key and base URL are created by hand then (apply-runbook.md).

locals {
  ssm_prefix = "/${var.project_name}/${var.environment}/env"

  # Public URLs: the custom domains once they're enabled, else CloudFront's.
  console_url = var.enable_custom_domains ? "https://${local.console_host}" : "https://${aws_cloudfront_distribution.console.domain_name}"
  api_url     = var.enable_custom_domains ? "https://${local.api_host}" : "https://${aws_cloudfront_distribution.api.domain_name}"

  env_plain = {
    NODE_ENV               = "production"
    CF_DEV_AUTH            = "false"
    AWS_REGION             = var.aws_region
    COGNITO_REGION         = var.aws_region
    COGNITO_USER_POOL_ID   = module.user_pool.id
    COGNITO_CLIENT_ID      = aws_cognito_user_pool_client.console.id
    CONSOLE_BASE_URL       = local.console_url
    CF_CORS_ORIGINS        = local.console_url
    CF_PUBLIC_API_BASE_URL = local.api_url
    CF_REPORT_S3_BUCKET    = aws_s3_bucket.reports.id
    CF_REPORT_S3_PREFIX    = var.cf_report_s3_prefix
    CF_BROKER_KMS_KEY_ID   = aws_kms_key.credentials.key_id
  }
}

resource "aws_ssm_parameter" "env" {
  for_each = local.env_plain
  name     = "${local.ssm_prefix}/${each.key}"
  type     = "String"
  value    = each.value
}

# ─── Generated secrets ───────────────────────────────────────────────────────

resource "random_password" "signing" {
  length  = 64
  special = false
}

resource "random_password" "origin" {
  length  = 48
  special = false
}

resource "random_password" "postgres" {
  length  = 40
  special = false
}

resource "aws_ssm_parameter" "signing_secret" {
  name  = "${local.ssm_prefix}/CF_SIGNING_SECRET"
  type  = "SecureString"
  value = random_password.signing.result
}

# Shared with the API distribution's origin header (cdn.tf).
resource "aws_ssm_parameter" "origin_secret" {
  name  = "${local.ssm_prefix}/CF_ORIGIN_SECRET"
  type  = "SecureString"
  value = random_password.origin.result
}

resource "aws_ssm_parameter" "postgres_password" {
  name  = "${local.ssm_prefix}/POSTGRES_PASSWORD"
  type  = "SecureString"
  value = random_password.postgres.result
}

resource "aws_ssm_parameter" "stripe_secret_key" {
  count = var.stripe_secret_key != "" ? 1 : 0
  name  = "${local.ssm_prefix}/STRIPE_SECRET_KEY"
  type  = "SecureString"
  value = var.stripe_secret_key
}

resource "aws_ssm_parameter" "stripe_webhook_secret" {
  count = var.stripe_webhook_secret != "" ? 1 : 0
  name  = "${local.ssm_prefix}/STRIPE_WEBHOOK_SECRET"
  type  = "SecureString"
  value = var.stripe_webhook_secret
}

# ─── Seeded, then owned by operations ────────────────────────────────────────

resource "aws_ssm_parameter" "image" {
  name  = "${local.ssm_prefix}/CF_IMAGE"
  type  = "String"
  value = "${aws_ecr_repository.backend.repository_url}:latest"

  lifecycle {
    ignore_changes = [value]
  }
}

resource "aws_ssm_parameter" "llm_provider" {
  name  = "${local.ssm_prefix}/CF_LLM_PROVIDER"
  type  = "String"
  value = var.llm_provider

  lifecycle {
    ignore_changes = [value]
  }
}

resource "aws_ssm_parameter" "llm_model" {
  name  = "${local.ssm_prefix}/CF_LLM_MODEL"
  type  = "String"
  value = var.llm_model

  lifecycle {
    ignore_changes = [value]
  }
}

# HACKATHON-ONLY (H-01): Muse Spark endpoint + key. Remove after the demo
# (back to Bedrock) — see ../HACKATHON-CHANGES.md.
resource "aws_ssm_parameter" "llm_base_url" {
  name  = "${local.ssm_prefix}/CF_LLM_BASE_URL"
  type  = "String"
  value = var.llm_base_url

  lifecycle {
    ignore_changes = [value]
  }
}

resource "aws_ssm_parameter" "llm_api_key" {
  count = var.llm_api_key != "" ? 1 : 0
  name  = "${local.ssm_prefix}/CF_LLM_API_KEY"
  type  = "SecureString"
  value = var.llm_api_key
}
