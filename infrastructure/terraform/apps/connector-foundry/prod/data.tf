# ─── Cross-stack references ──────────────────────────────────────────────────
# Everything shared (VPC, Aurora, the Cognito pool, telemetry) lives in the
# shared stack (infrastructure/terraform/shared). This app stack reads its
# outputs via remote state — it never re-creates shared resources.
#
# Apply order: shared/ first, then this stack.

data "terraform_remote_state" "shared" {
  backend = "s3"
  config = {
    bucket = "vir-terraform-state"
    key    = "shared/prod/terraform.tfstate"
    region = "us-east-1"
  }
}

data "aws_caller_identity" "current" {}

locals {
  # Same naming formula as the shared stack: connector-foundry-prod-*
  name = "${var.project_name}-${var.environment}"
}
