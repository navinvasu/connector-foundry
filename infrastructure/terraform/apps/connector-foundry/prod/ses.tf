# ─── SES: domain identity + configuration set + DKIM ────────────────────────
# After apply, add the DKIM CNAME records from the `ses_dkim_tokens` output to
# the domain's DNS (Hostinger), then SES marks the identity verified. Sandbox
# limits apply until AWS support moves the account to production access.

resource "aws_sesv2_email_identity" "domain" {
  email_identity = var.domain_name
}

resource "aws_sesv2_configuration_set" "main" {
  configuration_set_name = "${local.name}-mail"

  reputation_options {
    reputation_metrics_enabled = true
  }

  sending_options {
    sending_enabled = true
  }
}

# Default event destination is intentionally omitted: CloudWatch export of
# send/bounce/complaint events is wired in IN-05 (monitoring).
