# ─── ConnectorFoundry app-stack outputs ──────────────────────────────────────
# Everything the backend .env / console .env / DNS setup needs.

# ─── Cognito ─────────────────────────────────────────────────────────────────

output "cognito_user_pool_id" {
  description = "COGNITO_USER_POOL_ID: Connector Foundry's own pool (ADR 0005)."
  value       = module.user_pool.id
}

output "cognito_client_id" {
  description = "COGNITO_CLIENT_ID for the backend and console (VITE_COGNITO_CLIENT_ID)."
  value       = aws_cognito_user_pool_client.console.id
}

output "cognito_domain" {
  description = "VITE_COGNITO_DOMAIN: the branded hosted-UI base URL (@vir/web-auth wants https://…)."
  value       = "https://${module.user_pool.domain}.auth.${var.aws_region}.amazoncognito.com"
}

output "login_url" {
  description = "The branded sign-in page for the console client (open in a browser to try it)."
  value       = "https://${module.user_pool.domain}.auth.${var.aws_region}.amazoncognito.com/login?client_id=${aws_cognito_user_pool_client.console.id}&response_type=code&scope=openid+email+profile&redirect_uri=${urlencode(var.cognito_callback_urls[0])}"
}

# ─── Storage ─────────────────────────────────────────────────────────────────

output "reports_bucket" {
  description = "CF_REPORT_S3_BUCKET for eval report exports."
  value       = aws_s3_bucket.reports.id
}

output "console_bucket" {
  description = "S3 bucket to upload the console build (web/dist) into."
  value       = aws_s3_bucket.console.id
}

# ─── KMS ─────────────────────────────────────────────────────────────────────

output "kms_key_id" {
  description = "KMS key ID for credential-broker envelope encryption (AB-02)."
  value       = aws_kms_key.credentials.key_id
}

output "kms_credentials_key_arn" {
  description = "KMS key ARN for credential-broker envelope encryption (AB-02)."
  value       = aws_kms_key.credentials.arn
}

# ─── Compute / networking ────────────────────────────────────────────────────

output "alb_dns_name" {
  description = "ALB DNS name — point api.<domain> at it with a CNAME (or ALIAS)."
  value       = aws_lb.api.dns_name
}

output "api_url" {
  description = "Public base URL for the backend API."
  value       = "https://${local.api_host}"
}

output "ecr_repository_url" {
  description = "ECR repo URL — tag and push the backend image here."
  value       = aws_ecr_repository.backend.repository_url
}

output "cloudwatch_log_group" {
  description = "CloudWatch log group for backend container logs."
  value       = aws_cloudwatch_log_group.backend.name
}

# ─── Console CDN ─────────────────────────────────────────────────────────────

output "cloudfront_domain_name" {
  description = "CloudFront domain — point console.<domain> at it with a CNAME."
  value       = aws_cloudfront_distribution.console.domain_name
}

output "console_url" {
  description = "Public URL for the console once DNS is pointed."
  value       = "https://${local.console_host}"
}

# ─── Email ───────────────────────────────────────────────────────────────────

output "ses_configuration_set" {
  description = "SES configuration set for app mail."
  value       = aws_sesv2_configuration_set.main.configuration_set_name
}

output "ses_dkim_tokens" {
  description = "DKIM CNAME tokens — add <token>._domainkey.<domain> CNAME records pointing at <token>.dkim.amazonses.com."
  value       = aws_sesv2_email_identity.domain.dkim_signing_attributes[0].tokens
}

# ─── TLS ─────────────────────────────────────────────────────────────────────

output "acm_validation_records" {
  description = "DNS records to create for ACM wildcard-cert validation (name/type/value)."
  value = [
    for o in aws_acm_certificate.wildcard.domain_validation_options : {
      name  = o.resource_record_name
      type  = o.resource_record_type
      value = o.resource_record_value
    }
  ]
}

# ─── Support tickets (CD-04) ─────────────────────────────────────────────────

output "support_inbox_bucket" {
  description = "S3 bucket archiving inbound support mail."
  value       = aws_s3_bucket.support_inbox.id
}

output "support_topic_arn" {
  description = "SNS topic fanned out on each inbound support email."
  value       = aws_sns_topic.support_tickets.arn
}

output "support_receipt_rule_set" {
  description = "Active SES receipt rule set for support intake (needs the MX cutover at the registrar to receive mail)."
  value       = aws_ses_receipt_rule_set.support.rule_set_name
}
