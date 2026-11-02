# ─── ConnectorFoundry app-stack variables ────────────────────────────────────
# Service-specific infrastructure for the Connector Foundry platform. Shared
# resources (VPC, Aurora, Cognito pool, telemetry) come from the shared stack
# via terraform_remote_state (see data.tf) — they are NOT re-created here.

variable "project_name" {
  description = "Project slug used to prefix resource names. Must match the shared stack."
  type        = string
  default     = "connector-foundry"
}

variable "environment" {
  description = "Environment name (staging, prod). Must match the shared stack."
  type        = string
  default     = "prod"
}

variable "aws_region" {
  description = "AWS region for all resources."
  type        = string
  default     = "us-east-1"
}

variable "tags" {
  description = "Extra tags merged into every resource."
  type        = map(string)
  default     = {}
}

# ─── Domains ───────────────────────────────────────────────────────────────

variable "domain_name" {
  description = "Apex domain for SES identity and ACM certificate."
  type        = string
  default     = "connectorfoundry.com"
}

variable "api_subdomain" {
  description = "Subdomain for the backend ALB (api.<domain_name>)."
  type        = string
  default     = "api"
}

variable "console_subdomain" {
  description = "Subdomain for the console CloudFront distribution."
  type        = string
  default     = "console"
}

# ─── Compute (ECS Fargate) ─────────────────────────────────────────────────

variable "backend_image_uri" {
  description = "Full ECR image URI for the backend (e.g. 123456789012.dkr.ecr.us-east-1.amazonaws.com/connector-foundry-backend-staging:latest). Push the image first (see README), then set this."
  type        = string
  default     = ""

  validation {
    condition     = var.backend_image_uri != ""
    error_message = "backend_image_uri must be set to a pushed ECR image before the service can run. See README for the two-step first deploy."
  }
}

variable "ecs_cpu" {
  description = "Fargate task CPU units."
  type        = number
  default     = 512
}

variable "ecs_memory" {
  description = "Fargate task memory (MiB)."
  type        = number
  default     = 1024
}

variable "ecs_desired_count" {
  description = "Desired number of backend tasks."
  type        = number
  default     = 1
}

# ─── Cognito app client (on Connector Foundry's own pool, ADR 0005) ─────────

variable "cognito_callback_urls" {
  description = "Allowed OAuth callback URLs for the console app client."
  type        = list(string)
  default     = ["https://console.connectorfoundry.com/auth/callback"]
}

variable "cognito_logout_urls" {
  description = "Allowed sign-out URLs for the console app client."
  type        = list(string)
  default     = ["https://console.connectorfoundry.com/"]
}

# ─── Secrets (pass via tfvars at apply time; never commit) ─────────────────

variable "cf_signing_secret" {
  description = "CF_SIGNING_SECRET for release manifest signing. Generate with: openssl rand -hex 32"
  type        = string
  sensitive   = true
  default     = ""
}

variable "stripe_secret_key" {
  description = "STRIPE_SECRET_KEY. Leave empty until ready to take payments; billing endpoints return 503 without it."
  type        = string
  sensitive   = true
  default     = ""
}

variable "stripe_webhook_secret" {
  description = "STRIPE_WEBHOOK_SECRET from `stripe listen` or the dashboard webhook endpoint."
  type        = string
  sensitive   = true
  default     = ""
}

# ─── Backend runtime configuration ─────────────────────────────────────────

variable "console_base_url" {
  description = "CONSOLE_BASE_URL — where Stripe sends the customer after checkout (no trailing slash)."
  type        = string
  default     = "https://console.connectorfoundry.com"
}

variable "cf_cors_origins" {
  description = "CF_CORS_ORIGINS — comma-separated allowlist for the backend CORS policy."
  type        = string
  default     = "https://console.connectorfoundry.com"
}

variable "cf_dev_email" {
  description = "CF_DEV_EMAIL — only used when CF_DEV_AUTH is true (never in this stack)."
  type        = string
  default     = "dev@connectorfoundry.local"
}

variable "cf_upstream_timeout_ms" {
  description = "CF_UPSTREAM_TIMEOUT_MS — per-request upstream timeout for runtime invoke."
  type        = string
  default     = "20000"
}

variable "cf_circuit_failure_threshold" {
  description = "CF_CIRCUIT_FAILURE_THRESHOLD — consecutive failures before the circuit opens."
  type        = string
  default     = "5"
}

variable "cf_circuit_cooldown_ms" {
  description = "CF_CIRCUIT_COOLDOWN_MS — how long an open circuit stays open before a half-open probe."
  type        = string
  default     = "30000"
}

variable "cf_dunning_restrict_days" {
  description = "CF_DUNNING_RESTRICT_DAYS — days past-due before an account is restricted."
  type        = string
  default     = "7"
}

variable "cf_dunning_suspend_days" {
  description = "CF_DUNNING_SUSPEND_DAYS — days past-due before an account is suspended."
  type        = string
  default     = "14"
}

variable "cf_report_s3_prefix" {
  description = "CF_REPORT_S3_PREFIX — key prefix for eval report objects."
  type        = string
  default     = "eval-reports"
}

variable "cf_report_url_ttl_seconds" {
  description = "CF_REPORT_URL_TTL_SECONDS — lifetime of presigned eval-report URLs."
  type        = string
  default     = "3600"
}

variable "reports_retention_days" {
  description = "S3 lifecycle: expire eval report objects after this many days."
  type        = number
  default     = 90
}

# ─── Support-ticket intake (CD-04) ──────────────────────────────────────────

variable "support_inbox_address" {
  description = "Front-door support address (CD-04). SES inbound receipt rule archives mail to this address."
  type        = string
  default     = "hello@connectorfoundry.com"
}

variable "support_ops_email" {
  description = "Address that gets the SNS new-ticket ping. Empty = no email subscription (confirm via tfvars)."
  type        = string
  default     = ""
}
