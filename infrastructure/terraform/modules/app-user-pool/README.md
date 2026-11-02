# app-user-pool

One app's Cognito user pool ([ADR 0005](../../../../docs/adr/0005-one-user-pool-per-app.md)): every
app calls this from its own stack, so every pool has the same password policy, recovery and
deletion protection. Consumers: `apps/inspect-clan/{dev,prod}`.

```hcl
module "user_pool" {
  source = "../../../modules/app-user-pool"

  name          = "${local.prefix}-users"      # <app>-<env>-users
  domain_prefix = "dressclan-auth-dev"         # only if a client uses OAuth / hosted UI
  phone_sign_in = true                          # phone-number usernames (adds an SMS role)
  tags          = local.common_tags

  # Branded account emails (ADR 0002) — from the shared stack's outputs:
  custom_message_lambda = data.terraform_remote_state.shared.outputs.cognito_custom_message_lambda

  # Branded sign-in / sign-up / reset pages for clients that show Cognito's page:
  branding = {
    clients = { console = aws_cognito_user_pool_client.console.id } # static key => client id
    assets = [
      { category = "FORM_LOGO", color_mode = "LIGHT", extension = "SVG", path = "${path.module}/branding/logo.svg" },
    ]
    # settings_json = file("${path.module}/branding/settings.json") # colours etc., exported from the
    #                                                                # Cognito console branding editor
  }
}
```

**Branding:** each app's login pages show that app's logo and style. Cognito serves them from the
app's own domain using managed login, which the module turns on when `branding` is set.
- Only apps whose clients use the hosted UI need it. DressClan and Fleet sign in from their own
  screens, and their Apple/Google buttons go straight to Apple/Google.
- Colours and layout: design them once in the Cognito console's branding editor and export the
  style (`aws cognito-idp describe-managed-login-branding-by-client --user-pool-id … --client-id …`)
  into `settings_json`.
- Without `settings_json`, the logo sits on Cognito's default style.
- Needs AWS provider 6.x. Both live pools are on the Essentials tier, which includes managed login.

App clients, federated IdPs and the SSM account-email profile stay in the app stack.

Outputs:
- `id`: for clients, the JWT authorizer issuer and app config.
- `arn`: for IAM, e.g. `AdminCreateUser`.
- `domain`: the hosted-UI prefix, or null when the app has none.

Note: `phone_sign_in` sets `username_attributes`, which is ForceNew. Decide it before the first
apply.

Test (mocked AWS, no credentials): `terraform init -backend=false && terraform test` in this folder.
