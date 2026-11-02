# ─── ConnectorFoundry dev stack variables (lite profile, D-86) ──────────────
# One EC2 host (API + Postgres in Docker) behind CloudFront, the console on
# S3 + CloudFront, Connector Foundry's own Cognito pool. Only the shared
# CustomMessage Lambda comes from the shared stack (data.tf).

variable "project_name" {
  description = "Project slug used to prefix resource names."
  type        = string
  default     = "connector-foundry"
}

variable "environment" {
  description = "Environment name."
  type        = string
  default     = "dev"
}

variable "aws_region" {
  description = "AWS region for all resources (CloudFront certificates must be us-east-1)."
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
  description = "Apex domain (DNS at Hostinger)."
  type        = string
  default     = "connectorfoundry.com"
}

variable "api_subdomain" {
  description = "API + hosted MCP host: <api_subdomain>.<domain_name>."
  type        = string
  default     = "api"
}

variable "console_subdomain" {
  description = "Console host: <console_subdomain>.<domain_name>."
  type        = string
  default     = "console"
}

variable "login_subdomain" {
  description = "Cognito managed-login host: <login_subdomain>.<domain_name>."
  type        = string
  default     = "login"
}

variable "enable_custom_domains" {
  description = <<-EOT
    Attach console./api./login.<domain_name> to CloudFront and Cognito. Production only
    (see ../path-to-prod.md): dev and the hackathon demo run on the AWS-generated
    CloudFront / Cognito URLs and this stays false, so no certificate or DNS
    records are created. Enabling it needs the wildcard certificate ISSUED first.
  EOT
  type        = bool
  default     = false
}

# ─── Host ──────────────────────────────────────────────────────────────────

variable "instance_type" {
  description = "EC2 instance type for the API + Postgres host (arm64)."
  type        = string
  default     = "t4g.small"
}

variable "data_volume_gb" {
  description = "Size of the EBS data volume (Postgres data) in GiB."
  type        = number
  default     = 20
}

variable "snapshot_retain_count" {
  description = "Daily EBS snapshots of the data volume to keep (DLM)."
  type        = number
  default     = 7
}

variable "vpc_cidr" {
  description = "CIDR of the stack's small public VPC (no NAT)."
  type        = string
  default     = "10.40.0.0/24"
}

# ─── Cognito app client (on Connector Foundry's own pool, ADR 0005) ─────────

variable "extra_callback_urls" {
  description = "Extra OAuth callback URLs (local development) on top of the console's own."
  type        = list(string)
  default     = ["http://localhost:5174/auth/callback"]
}

variable "extra_logout_urls" {
  description = "Extra sign-out URLs (local development)."
  type        = list(string)
  default     = ["http://localhost:5174/"]
}

# ─── Optional secrets (pass via tfvars at apply time; never commit) ─────────

variable "stripe_secret_key" {
  description = "STRIPE_SECRET_KEY. Leave empty until taking payments; billing endpoints return 503 without it."
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

# ─── Language model (D-88) — initial values; switch later with put-parameter ─

variable "llm_provider" {
  description = "Initial CF_LLM_PROVIDER: bedrock | openai_compatible. Later changes go straight to SSM (Terraform ignores them)."
  type        = string
  # HACKATHON-ONLY (H-01): Muse Spark for the demo; revert to "bedrock" after. See ../HACKATHON-CHANGES.md.
  default = "openai_compatible"
}

variable "llm_model" {
  description = "Initial CF_LLM_MODEL (Bedrock inference profile or OpenAI-compatible model id)."
  type        = string
  # HACKATHON-ONLY (H-01): Muse Spark for the demo; revert to "us.amazon.nova-2-lite-v1:0" after.
  default = "muse-spark-1.3"
}

variable "llm_base_url" {
  description = "Initial CF_LLM_BASE_URL (openai_compatible only). Empty for bedrock."
  type        = string
  # HACKATHON-ONLY (H-01): Meta Model API endpoint for Muse Spark.
  default = "https://api.meta.ai/v1"
}

variable "llm_api_key" {
  description = "CF_LLM_API_KEY (openai_compatible only). Pass via tfvars at apply time; never commit. Empty = LLM features answer 503."
  type        = string
  sensitive   = true
  default     = ""
}

variable "bedrock_model_arns" {
  description = "Bedrock resources the host may invoke: the cross-region inference profile and the foundation model in each region it routes to."
  type        = list(string)
  default = [
    "arn:aws:bedrock:us-east-1:*:inference-profile/us.amazon.nova-2-lite-v1:0",
    "arn:aws:bedrock:*::foundation-model/amazon.nova-2-lite-v1:0",
  ]
}

# ─── Backend runtime configuration ─────────────────────────────────────────

variable "cf_report_s3_prefix" {
  description = "CF_REPORT_S3_PREFIX — key prefix for eval report objects."
  type        = string
  default     = "eval-reports"
}

variable "reports_retention_days" {
  description = "S3 lifecycle: expire eval report objects after this many days."
  type        = number
  default     = 30
}
