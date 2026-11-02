output "id" {
  description = "User pool ID (for app clients, JWT authorizers, app config)."
  value       = aws_cognito_user_pool.this.id
}

output "arn" {
  description = "User pool ARN (for IAM policies, e.g. AdminCreateUser)."
  value       = aws_cognito_user_pool.this.arn
}

output "custom_domain" {
  description = "Custom hosted-UI domain, or null when none is configured."
  value       = one(aws_cognito_user_pool_domain.custom[*].domain)
}

output "custom_domain_target" {
  description = "CloudFront target for the custom domain's CNAME record, or null."
  value       = one(aws_cognito_user_pool_domain.custom[*].cloudfront_distribution)
}

output "domain" {
  description = "Hosted-UI domain prefix, or null when the app has none."
  value       = one(aws_cognito_user_pool_domain.this[*].domain)
}
