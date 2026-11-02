variable "name" {
  description = "Pool name, <app>-<env>-users (e.g. inspect-clan-dev-users)."
  type        = string
}

variable "domain_prefix" {
  description = "Hosted-UI domain prefix (<prefix>.auth.<region>.amazoncognito.com, globally unique). Empty = no domain (SRP-only apps)."
  type        = string
  default     = ""
}

variable "phone_sign_in" {
  description = "Allow phone-number usernames (adds an SMS sender role). ForceNew on an existing pool."
  type        = bool
  default     = false
}

variable "custom_message_lambda" {
  description = "The shared CustomMessage Lambda (ADR 0002) as { arn, function_name }, from the shared stack outputs. Null = Cognito's default messages."
  type = object({
    arn           = string
    function_name = string
  })
  default = null
}

variable "ses" {
  description = "Verified SES identity for account emails as { identity_arn, from }. Null = Cognito's default sender."
  type = object({
    identity_arn = string
    from         = string
  })
  default = null

  validation {
    condition     = var.ses == null || try(var.ses.identity_arn != "" && var.ses.from != "", false)
    error_message = "ses needs both identity_arn and from (e.g. \"DressClan <accounts@dressclan.com>\")."
  }
}

variable "branding" {
  description = <<-EOT
    Branded managed-login pages (sign in, sign up, reset) for the app clients that show
    Cognito's page (OAuth / hosted UI). Null = no branding; the domain keeps its current
    login version. Needs domain_prefix. assets: images (category e.g. FORM_LOGO,
    PAGE_HEADER_LOGO, FAVICON_SVG; color_mode LIGHT / DARK / DYNAMIC; extension PNG / SVG /
    JPEG / WEBP / ICO; path to the file in the repo). settings_json: the style document
    exported from Cognito's branding editor; null keeps Cognito's default style. With
    neither, the pages use Cognito's default look.
  EOT
  type = object({
    clients       = map(string) # static name => app client id, e.g. { console = aws_cognito_user_pool_client.console.id }
    settings_json = optional(string)
    assets = optional(list(object({
      category   = string
      color_mode = string
      extension  = string
      path       = string
    })), [])
  })
  default = null

  validation {
    condition     = var.branding == null || try(length(var.branding.clients) > 0, false)
    error_message = "branding.clients needs at least one app client."
  }

  validation {
    condition     = var.branding == null || var.domain_prefix != ""
    error_message = "branding needs a domain_prefix (the branded pages are served from it)."
  }
}

variable "custom_domain" {
  description = <<-EOT
    Optional custom hosted-UI domain as { domain, certificate_arn } (e.g. login.example.com with an
    ISSUED us-east-1 ACM certificate that covers it). Served alongside the prefix domain, with the
    same managed-login branding. Point a CNAME at the `custom_domain_target` output. Null = none.
  EOT
  type = object({
    domain          = string
    certificate_arn = string
  })
  default = null
}

variable "deletion_protection" {
  description = "Refuse to delete (or replace) the pool while it holds users."
  type        = bool
  default     = true
}

variable "tags" {
  description = "Tags for the pool and the SMS role."
  type        = map(string)
  default     = {}
}
