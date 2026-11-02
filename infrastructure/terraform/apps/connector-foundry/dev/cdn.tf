# ─── Edge: two CloudFront distributions + one wildcard certificate ─────────
# console.<domain> → S3 (the SPA) and api.<domain> → the EC2 host (API +
# hosted MCP). login.<domain> is Cognito's custom domain (cognito-client.tf).
# The certificate covers all three; the aliases attach only once it is
# ISSUED (var.enable_custom_domains) — until then both distributions answer
# on their *.cloudfront.net names.

locals {
  api_host     = "${var.api_subdomain}.${var.domain_name}"
  console_host = "${var.console_subdomain}.${var.domain_name}"
  login_host   = "${var.login_subdomain}.${var.domain_name}"
}

# Custom domains are a production concern (see ../path-to-prod.md): in dev
# nothing is created for them unless enable_custom_domains is explicitly
# turned on, and the demo runs on the AWS-generated URLs instead.
resource "aws_acm_certificate" "wildcard" {
  count                     = var.enable_custom_domains ? 1 : 0
  domain_name               = "*.${var.domain_name}"
  subject_alternative_names = [var.domain_name]
  validation_method         = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = { Name = "${local.name}-wildcard-cert" }
}

# ─── Console: private S3 + Origin Access Control, SPA fallback ──────────────

resource "aws_cloudfront_origin_access_control" "console" {
  name                              = "${local.name}-console-oac"
  description                       = "OAC for the console bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_s3_bucket_policy" "console" {
  bucket = aws_s3_bucket.console.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "CloudFrontOACRead"
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.console.arn}/*"
      Condition = {
        StringEquals = {
          "AWS:SourceArn" = aws_cloudfront_distribution.console.arn
        }
      }
    }]
  })

  depends_on = [aws_s3_bucket_public_access_block.console]
}

resource "aws_cloudfront_distribution" "console" {
  enabled             = true
  is_ipv6_enabled     = true
  default_root_object = "index.html"
  aliases             = var.enable_custom_domains ? [local.console_host] : []
  price_class         = "PriceClass_100" # US/EU only — cheapest

  origin {
    domain_name              = aws_s3_bucket.console.bucket_regional_domain_name
    origin_id                = "console-s3"
    origin_access_control_id = aws_cloudfront_origin_access_control.console.id
  }

  default_cache_behavior {
    target_origin_id       = "console-s3"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    forwarded_values {
      query_string = false
      cookies {
        forward = "none"
      }
    }

    min_ttl     = 0
    default_ttl = 3600
    max_ttl     = 86400
  }

  # SPA fallback: unknown paths serve index.html.
  custom_error_response {
    error_code            = 403
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 10
  }

  custom_error_response {
    error_code            = 404
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 10
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn            = var.enable_custom_domains ? one(aws_acm_certificate.wildcard[*].arn) : null
    cloudfront_default_certificate = !var.enable_custom_domains
    ssl_support_method             = var.enable_custom_domains ? "sni-only" : null
    minimum_protocol_version       = var.enable_custom_domains ? "TLSv1.2_2021" : "TLSv1"
  }

  tags = { Name = "${local.name}-console-cdn" }
}

# ─── API: CloudFront → EC2 (HTTP origin on the Elastic IP) ──────────────────
# Nothing cached; every header (Authorization, Mcp-Session-Id, …), query and
# body goes through. CloudFront adds x-origin-verify, which the API requires
# (CF_ORIGIN_SECRET), and the host's security group admits only CloudFront.

data "aws_cloudfront_cache_policy" "disabled" {
  name = "Managed-CachingDisabled"
}

data "aws_cloudfront_origin_request_policy" "all_viewer_except_host" {
  name = "Managed-AllViewerExceptHostHeader"
}

resource "aws_cloudfront_distribution" "api" {
  enabled         = true
  is_ipv6_enabled = true
  comment         = "${local.name} API + hosted MCP"
  aliases         = var.enable_custom_domains ? [local.api_host] : []
  price_class     = "PriceClass_100"

  origin {
    domain_name = aws_eip.host.public_dns
    origin_id   = "api-host"

    custom_origin_config {
      http_port                = 80
      https_port               = 443
      origin_protocol_policy   = "http-only"
      origin_ssl_protocols     = ["TLSv1.2"]
      origin_read_timeout      = 60 # agent runs and suggestion generation take tens of seconds
      origin_keepalive_timeout = 5
    }

    custom_header {
      name  = "x-origin-verify"
      value = random_password.origin.result
    }
  }

  default_cache_behavior {
    target_origin_id         = "api-host"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods           = ["GET", "HEAD"]
    compress                 = true
    cache_policy_id          = data.aws_cloudfront_cache_policy.disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn            = var.enable_custom_domains ? one(aws_acm_certificate.wildcard[*].arn) : null
    cloudfront_default_certificate = !var.enable_custom_domains
    ssl_support_method             = var.enable_custom_domains ? "sni-only" : null
    minimum_protocol_version       = var.enable_custom_domains ? "TLSv1.2_2021" : "TLSv1"
  }

  tags = { Name = "${local.name}-api-cdn" }
}
