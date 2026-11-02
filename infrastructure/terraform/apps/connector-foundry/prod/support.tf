# ─── Support-ticket intake: SES inbound → S3 archive + SNS notify (CD-04) ────
# hello@connectorfoundry.com is the single front door (CD-04 support runbook:
# email triage, no in-app ticket widget — D-77). Every inbound email is
# archived immutably to S3 and fanned out to SNS so the operator gets a
# per-ticket ping.
#
# DNS step (registrar, manual — do this when ready to cut over):
#   MX connectorfoundry.com → inbound-smtp.us-east-1.amazonaws.com (priority 10)
# Until the MX cutover, mail keeps flowing to the current host and this
# pipeline simply stays idle — safe to apply now. Activating the rule set is
# also safe pre-cutover: rules only fire on mail SES actually receives.
#
# SNS email subscription: set var.support_ops_email (e.g. your personal
# address) to get the new-ticket ping. AWS sends a confirmation email first —
# click it, or notifications stay "PendingConfirmation".

# ─── S3: immutable mail archive ─────────────────────────────────────────────

resource "aws_s3_bucket" "support_inbox" {
  bucket = "${local.name}-support-inbox"

  tags = { Name = "${local.name}-support-inbox" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "support_inbox" {
  bucket = aws_s3_bucket.support_inbox.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "support_inbox" {
  bucket = aws_s3_bucket.support_inbox.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "support_inbox" {
  bucket = aws_s3_bucket.support_inbox.id

  rule {
    id     = "expire-old-tickets"
    status = "Enabled"

    filter {}

    expiration {
      days = 730 # 2 years of ticket history
    }
  }
}

# SES needs explicit permission to write inbound mail here.
resource "aws_s3_bucket_policy" "support_inbox" {
  bucket = aws_s3_bucket.support_inbox.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "SESInboundWrite"
      Effect    = "Allow"
      Principal = { Service = "ses.amazonaws.com" }
      Action    = "s3:PutObject"
      Resource  = "${aws_s3_bucket.support_inbox.arn}/*"
      Condition = {
        StringEquals = {
          "aws:Referer" = data.aws_caller_identity.current.account_id
        }
      }
    }]
  })

  depends_on = [aws_s3_bucket_public_access_block.support_inbox]
}

# ─── SNS: new-ticket ping ───────────────────────────────────────────────────

resource "aws_sns_topic" "support_tickets" {
  name = "${local.name}-support-tickets"

  tags = { Name = "${local.name}-support-tickets" }
}

resource "aws_sns_topic_subscription" "ops_email" {
  count     = var.support_ops_email != "" ? 1 : 0
  topic_arn = aws_sns_topic.support_tickets.arn
  protocol  = "email"
  endpoint  = var.support_ops_email
}

# ─── SES: receipt rule → S3 + SNS ───────────────────────────────────────────

resource "aws_ses_receipt_rule_set" "support" {
  rule_set_name = "${local.name}-support"
}

resource "aws_ses_receipt_rule" "inbox" {
  name          = "${local.name}-support-inbox"
  rule_set_name = aws_ses_receipt_rule_set.support.rule_set_name
  recipients    = [var.support_inbox_address]
  enabled       = true
  scan_enabled  = true # spam/virus scan before archiving

  s3_action {
    bucket_name       = aws_s3_bucket.support_inbox.id
    object_key_prefix = "inbound/"
    position          = 1
  }

  sns_action {
    topic_arn = aws_sns_topic.support_tickets.arn
    encoding  = "UTF-8"
    position  = 2
  }
}

# One active receipt rule set per region — this is it.
resource "aws_ses_active_receipt_rule_set" "support" {
  rule_set_name = aws_ses_receipt_rule_set.support.rule_set_name
}
