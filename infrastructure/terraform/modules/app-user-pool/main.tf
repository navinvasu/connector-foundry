# ─── One app's Cognito user pool (ADR 0005) ──────────────────────────────────
# Every app owns its pool in its own stack, all in the one account + region.
# Users belong to the app: the same email or phone can sign up in two apps and
# gets two accounts, and the pool's user count is the app's user count.
#
# Settings are the same for every app (the reason this is a module): password
# policy, verified-email recovery, MFA off, self sign-up on, deletion
# protection on. App clients, federated IdPs and the account-email app
# profile stay in the app stack — they differ per app.
#
# NOTE: username_attributes is ForceNew — flipping phone_sign_in on an existing
# pool recreates it (deletion protection makes that apply fail first).

resource "aws_cognito_user_pool" "this" {
  name = var.name

  username_attributes      = var.phone_sign_in ? ["email", "phone_number"] : ["email"]
  auto_verified_attributes = var.phone_sign_in ? ["email", "phone_number"] : ["email"]

  deletion_protection = var.deletion_protection ? "ACTIVE" : "INACTIVE"

  # The provider perpetually diffs the auto-created standard attribute schema
  # (email), even when declared to match AWS defaults exactly. These pools use
  # only standard attributes, so let AWS own the schema and never diff it.
  lifecycle {
    ignore_changes = [schema]
  }

  # Branded account emails / SMS (ADR 0002): the shared CustomMessage Lambda.
  dynamic "lambda_config" {
    for_each = var.custom_message_lambda == null ? [] : [1]
    content {
      custom_message = var.custom_message_lambda.arn
    }
  }

  # SES sender once the app's identity is verified; otherwise Cognito's default.
  dynamic "email_configuration" {
    for_each = var.ses == null ? [] : [1]
    content {
      email_sending_account = "DEVELOPER"
      source_arn            = var.ses.identity_arn
      from_email_address    = var.ses.from
    }
  }

  # Phone-number usernames need an SMS sender role for the verification codes.
  dynamic "sms_configuration" {
    for_each = var.phone_sign_in ? [1] : []
    content {
      external_id    = "${var.name}-sms"
      sns_caller_arn = aws_iam_role.sms[0].arn
    }
  }

  password_policy {
    minimum_length                   = 12
    require_lowercase                = true
    require_uppercase                = true
    require_numbers                  = true
    require_symbols                  = false
    temporary_password_validity_days = 7
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  admin_create_user_config {
    allow_admin_create_user_only = false
  }

  schema {
    name                = "email"
    attribute_data_type = "String"
    required            = false
    mutable             = true
  }

  tags = var.tags
}

# Hosted-UI domain — only for apps whose clients use OAuth (federated IdPs,
# hosted UI). SRP-only apps can leave domain_prefix empty.
resource "aws_cognito_user_pool_domain" "this" {
  count        = var.domain_prefix == "" ? 0 : 1
  domain       = var.domain_prefix
  user_pool_id = aws_cognito_user_pool.this.id

  # 2 = managed login (brandable per client); null leaves an existing domain as it is.
  managed_login_version = var.branding == null ? null : 2
}

# Optional custom domain (e.g. login.<app domain>) on top of the prefix domain.
resource "aws_cognito_user_pool_domain" "custom" {
  count           = var.custom_domain == null ? 0 : 1
  domain          = var.custom_domain.domain
  certificate_arn = var.custom_domain.certificate_arn
  user_pool_id    = aws_cognito_user_pool.this.id

  managed_login_version = var.branding == null ? null : 2
}

# One brand per app client that shows Cognito's page: the app's logo and style on its
# sign-in, sign-up and password-reset pages (ADR 0005 — every app looks like itself).
resource "aws_cognito_managed_login_branding" "this" {
  # Keyed by static names: client ids are unknown until the clients exist.
  for_each     = var.branding == null ? {} : var.branding.clients
  user_pool_id = aws_cognito_user_pool.this.id
  client_id    = each.value

  use_cognito_provided_values = var.branding.settings_json == null && length(var.branding.assets) == 0
  settings                    = var.branding.settings_json

  dynamic "asset" {
    for_each = var.branding.assets
    content {
      category   = asset.value.category
      color_mode = asset.value.color_mode
      extension  = asset.value.extension
      bytes      = filebase64(asset.value.path)
    }
  }

  depends_on = [aws_cognito_user_pool_domain.this]
}

resource "aws_lambda_permission" "custom_message" {
  count         = var.custom_message_lambda == null ? 0 : 1
  statement_id  = "AllowCognito-${var.name}"
  action        = "lambda:InvokeFunction"
  function_name = var.custom_message_lambda.function_name
  principal     = "cognito-idp.amazonaws.com"
  source_arn    = aws_cognito_user_pool.this.arn
}

resource "aws_iam_role" "sms" {
  count = var.phone_sign_in ? 1 : 0
  name  = "${var.name}-sms"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "cognito-idp.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = {
        StringEquals = { "sts:ExternalId" = "${var.name}-sms" }
      }
    }]
  })

  tags = var.tags
}

resource "aws_iam_role_policy" "sms" {
  count = var.phone_sign_in ? 1 : 0
  name  = "${var.name}-sms"
  role  = aws_iam_role.sms[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["sns:Publish"]
      Resource = "*"
    }]
  })
}
