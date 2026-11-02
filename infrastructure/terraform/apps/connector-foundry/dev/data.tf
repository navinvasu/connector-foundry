# ─── Cross-stack references ──────────────────────────────────────────────────
# The lite dev stack (D-86) needs only one shared output: the CustomMessage
# Lambda for branded account emails (ADR 0002). It does not use the shared
# VPC or Aurora. Apply order: shared/ first, then this stack.

data "terraform_remote_state" "shared" {
  backend = "s3"
  config = {
    bucket = "vir-terraform-state"
    key    = "shared/dev/terraform.tfstate"
    region = "us-east-1"
  }
}

data "aws_caller_identity" "current" {}

locals {
  # Same naming formula as the shared stack: connector-foundry-dev-*
  name = "${var.project_name}-${var.environment}"
}
