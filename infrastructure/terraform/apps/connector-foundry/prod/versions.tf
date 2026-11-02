# ConnectorFoundry app stack — service-specific infrastructure.
# Region: us-east-1 (same as the shared stack; the ALB/CloudFront ACM certs
# must be us-east-1).

terraform {
  # >= 1.10: the S3 backend below uses native state locking (use_lockfile).
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0" # modules/app-user-pool (managed login branding)
    }
  }

  # Remote state from the first apply. The bucket must exist before
  # `terraform init` (one-time manual creation, versioning enabled).
  # Apply the shared stack FIRST — this stack reads its outputs.
  backend "s3" {
    bucket       = "vir-terraform-state"
    key          = "apps/connector-foundry/prod/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = merge(
      {
        Project     = var.project_name
        Environment = var.environment
        ManagedBy   = "terraform"
      },
      var.tags,
    )
  }
}
