# terraform test (mocked AWS, no credentials): the module's switches behave as documented.

mock_provider "aws" {
  mock_resource "aws_cognito_user_pool" {
    defaults = {
      id  = "us-east-1_TEST"
      arn = "arn:aws:cognito-idp:us-east-1:123456789012:userpool/us-east-1_TEST"
    }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/test-sms" }
  }
}

run "email_only_pool_has_no_extras" {
  command = plan

  variables {
    name = "app-dev-users"
  }

  assert {
    condition     = aws_cognito_user_pool.this.username_attributes == toset(["email"])
    error_message = "email-only by default"
  }
  assert {
    condition     = aws_cognito_user_pool.this.deletion_protection == "ACTIVE"
    error_message = "deletion protection on by default"
  }
  assert {
    condition     = length(aws_cognito_user_pool_domain.this) == 0 && length(aws_iam_role.sms) == 0 && length(aws_cognito_managed_login_branding.this) == 0
    error_message = "no domain, SMS role or branding unless asked for"
  }
}

run "phone_sign_in_adds_the_sms_role" {
  command = plan

  variables {
    name          = "app-dev-users"
    phone_sign_in = true
  }

  assert {
    condition     = aws_cognito_user_pool.this.username_attributes == toset(["email", "phone_number"]) && length(aws_iam_role.sms) == 1
    error_message = "phone usernames need the SMS sender role"
  }
}

run "branding_brands_each_client_on_managed_login" {
  command = apply # mocked: nothing is created

  variables {
    name          = "app-dev-users"
    domain_prefix = "app-auth-dev"
    branding = {
      clients = { console = "client-123" }
      assets  = [{ category = "FORM_LOGO", color_mode = "LIGHT", extension = "SVG", path = "tests/fixtures/logo.svg" }]
    }
  }

  assert {
    condition     = aws_cognito_user_pool_domain.this[0].managed_login_version == 2
    error_message = "branding needs managed login (version 2)"
  }
  assert {
    condition     = aws_cognito_managed_login_branding.this["console"].client_id == "client-123"
    error_message = "one brand per named client"
  }
  assert {
    condition     = aws_cognito_managed_login_branding.this["console"].use_cognito_provided_values == false
    error_message = "a logo means our own values, not Cognito's defaults"
  }
}

run "branding_without_a_domain_is_refused" {
  command = plan

  variables {
    name = "app-dev-users"
    branding = {
      clients = { console = "client-123" }
    }
  }

  expect_failures = [var.branding]
}
