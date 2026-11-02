# ─── CloudFront for the console SPA ────────────────────────────────────────
# Private S3 bucket + Origin Access Control. SPA fallback: 403/404 from S3
# serve /index.html with a 200 so client-side routing works. The wildcard ACM
# cert (compute.tf) covers console.<domain>; add the DNS records from the
# `acm_validation_records` output first.

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
  aliases             = [local.console_host]
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
    acm_certificate_arn      = aws_acm_certificate.wildcard.arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  tags = { Name = "${local.name}-console-cdn" }
}
