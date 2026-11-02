# ─── Network: one small public VPC, no NAT (D-86) ───────────────────────────
# The host needs outbound internet (customer APIs, Bedrock, ECR) and inbound
# HTTP from CloudFront only. A public subnet with an internet gateway does
# both for free; a NAT gateway (~$33/month) would only add cost. No SSH:
# administration is SSM Session Manager.

data "aws_availability_zones" "available" {
  state = "available"
}

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = "${local.name}-vpc" }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = { Name = "${local.name}-igw" }
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 1, 0)
  availability_zone       = data.aws_availability_zones.available.names[0]
  map_public_ip_on_launch = false # the host gets the stable Elastic IP

  tags = { Name = "${local.name}-public" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = { Name = "${local.name}-public" }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

# Inbound: HTTP from CloudFront's origin-facing ranges only. The API also
# rejects requests without the x-origin-verify header (CF_ORIGIN_SECRET).
data "aws_ec2_managed_prefix_list" "cloudfront" {
  name = "com.amazonaws.global.cloudfront.origin-facing"
}

resource "aws_security_group" "host" {
  name        = "${local.name}-host"
  description = "Connector Foundry API host: HTTP from CloudFront only"
  vpc_id      = aws_vpc.main.id

  tags = { Name = "${local.name}-host" }
}

resource "aws_vpc_security_group_ingress_rule" "host_http_cloudfront" {
  security_group_id = aws_security_group.host.id
  prefix_list_id    = data.aws_ec2_managed_prefix_list.cloudfront.id
  from_port         = 80
  to_port           = 80
  ip_protocol       = "tcp"
  description       = "CloudFront origin-facing"
}

# Outbound: anything — customer APIs live on arbitrary hosts and ports; the
# app's egress policy (SE-08) blocks private addresses.
resource "aws_vpc_security_group_egress_rule" "host_all" {
  security_group_id = aws_security_group.host.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
  description       = "All outbound"
}
