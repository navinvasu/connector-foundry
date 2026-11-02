# ─── Cognito: Connector Foundry's own user pool (ADR 0005) ───────────────────
# A Connector Foundry account belongs to Connector Foundry only; the same email
# can sign up separately in the other apps. The console signs in through
# Cognito's hosted UI (@vir/web-auth), so this is the one app whose Cognito
# page users see — it carries the Connector Foundry logo and style (managed
# login branding, served from login.connectorfoundry.com once custom domains
# are enabled, and always from connector-foundry-<env>.auth.us-east-1...).

module "user_pool" {
  source = "../../../modules/app-user-pool"

  name                  = "${local.name}-users"
  domain_prefix         = local.name
  custom_message_lambda = data.terraform_remote_state.shared.outputs.cognito_custom_message_lambda

  # login.<domain> once the wildcard certificate is issued (cdn.tf).
  custom_domain = var.enable_custom_domains ? {
    domain          = local.login_host
    certificate_arn = one(aws_acm_certificate.wildcard[*].arn)
  } : null

  branding = {
    clients = { console = aws_cognito_user_pool_client.console.id }
    assets = [
      { category = "FORM_LOGO", color_mode = "LIGHT", extension = "SVG", path = "${local.logos}/connector-foundry-logo-light.svg" },
      { category = "FORM_LOGO", color_mode = "DARK", extension = "SVG", path = "${local.logos}/connector-foundry-logo.svg" },
    ]
    # Dark page + amber (#ffa02e) buttons: design it once in the Cognito console's branding
    # editor, export it to ../branding/managed-login-settings.json (see ../README.md), and it
    # is picked up here. Until then: the logos on Cognito's default style.
    settings_json = fileexists(local.login_style) ? file(local.login_style) : null
  }
}

locals {
  logos       = "${path.module}/../../../../../projects/connector-foundry/docs/logos"
  login_style = "${path.module}/../branding/managed-login-settings.json"
}

resource "aws_cognito_user_pool_client" "console" {
  name            = "${local.name}-console"
  user_pool_id    = module.user_pool.id
  generate_secret = false # public SPA client; PKCE instead of a secret

  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  supported_identity_providers         = ["COGNITO"]

  callback_urls = concat(["${local.console_url}/auth/callback"], var.extra_callback_urls)
  logout_urls   = concat(["${local.console_url}/"], var.extra_logout_urls)

  prevent_user_existence_errors = "ENABLED"
  enable_token_revocation       = true

  explicit_auth_flows = [
    "ALLOW_USER_SRP_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH",
  ]
}

# Branded account emails (ADR 0002): the shared Lambda reads this profile by client id.
resource "aws_ssm_parameter" "cognito_app_profile" {
  name = "/vir/${var.environment}/cognito/apps/${aws_cognito_user_pool_client.console.id}"
  type = "String"
  value = jsonencode({
    name         = "Connector Foundry"
    supportEmail = ""
    website      = "https://connectorfoundry.com"
  })
}
