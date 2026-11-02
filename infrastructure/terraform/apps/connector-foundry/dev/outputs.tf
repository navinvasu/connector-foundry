# ─── ConnectorFoundry dev outputs (lite profile, D-86) ──────────────────────
# What the console build, the deploy commands and the Hostinger DNS need.

# ─── URLs ────────────────────────────────────────────────────────────────────

output "console_url" {
  description = "Console URL (custom domain once enable_custom_domains = true)."
  value       = local.console_url
}

output "api_url" {
  description = "API + hosted MCP base URL — VITE_API_BASE_URL and CF_PUBLIC_API_BASE_URL."
  value       = local.api_url
}

output "mcp_url_template" {
  description = "Hosted MCP endpoint for a project (connect with a gateway key)."
  value       = "${local.api_url}/v1/mcp/<project-id>"
}

# ─── Cognito ─────────────────────────────────────────────────────────────────

output "cognito_user_pool_id" {
  description = "COGNITO_USER_POOL_ID: Connector Foundry's own pool (ADR 0005)."
  value       = module.user_pool.id
}

output "cognito_client_id" {
  description = "COGNITO_CLIENT_ID for the backend and VITE_COGNITO_CLIENT_ID for the console."
  value       = aws_cognito_user_pool_client.console.id
}

output "cognito_domain" {
  description = "VITE_COGNITO_DOMAIN: the branded managed-login base URL."
  value       = var.enable_custom_domains ? "https://${local.login_host}" : "https://${module.user_pool.domain}.auth.${var.aws_region}.amazoncognito.com"
}

output "login_url" {
  description = "The branded sign-in page for the console client (open it to try the login)."
  value       = "${var.enable_custom_domains ? "https://${local.login_host}" : "https://${module.user_pool.domain}.auth.${var.aws_region}.amazoncognito.com"}/login?client_id=${aws_cognito_user_pool_client.console.id}&response_type=code&scope=openid+email+profile&redirect_uri=${urlencode("${local.console_url}/auth/callback")}"
}

# ─── DNS records to create at Hostinger ──────────────────────────────────────

output "acm_validation_records" {
  description = "Production only (path-to-prod.md): CNAME(s) validating the wildcard certificate. Empty in dev."
  value = [
    for o in flatten([for c in aws_acm_certificate.wildcard : c.domain_validation_options]) : {
      name  = o.resource_record_name
      type  = o.resource_record_type
      value = o.resource_record_value
    }
  ]
}

output "dns_records" {
  description = "Production only (path-to-prod.md, after enable_custom_domains = true): CNAMEs for console., api. and login. Unused in dev."
  value = {
    (local.console_host) = aws_cloudfront_distribution.console.domain_name
    (local.api_host)     = aws_cloudfront_distribution.api.domain_name
    (local.login_host)   = module.user_pool.custom_domain_target
  }
}

output "ses_dkim_tokens" {
  description = "DKIM CNAME tokens — <token>._domainkey.<domain> → <token>.dkim.amazonses.com."
  value       = aws_sesv2_email_identity.domain.dkim_signing_attributes[0].tokens
}

# ─── Deploy ──────────────────────────────────────────────────────────────────

output "ecr_repository_url" {
  description = "Push the arm64 backend image here."
  value       = aws_ecr_repository.backend.repository_url
}

output "instance_id" {
  description = "API host — for deploy (SSM Run Command), stop and start."
  value       = aws_instance.host.id
}

output "ssm_env_prefix" {
  description = "SSM path whose parameters become the host's .env."
  value       = local.ssm_prefix
}

output "console_bucket" {
  description = "S3 bucket to sync the console build (web/dist) into."
  value       = aws_s3_bucket.console.id
}

output "console_distribution_id" {
  description = "CloudFront distribution to invalidate after a console upload."
  value       = aws_cloudfront_distribution.console.id
}

output "reports_bucket" {
  description = "CF_REPORT_S3_BUCKET for eval report exports."
  value       = aws_s3_bucket.reports.id
}

output "kms_key_id" {
  description = "KMS key for credential-broker envelope encryption (AB-02)."
  value       = aws_kms_key.credentials.key_id
}

output "ses_configuration_set" {
  description = "SES configuration set for app mail."
  value       = aws_sesv2_configuration_set.main.configuration_set_name
}
