# ConnectorFoundry app stack — service-specific infrastructure

Two profiles:

- **`dev/` — lite (D-86, applied first).** One EC2 t4g.small runs the API and Postgres 16 in Docker
  (`projects/connector-foundry/backend/deploy/compose.host.yml`) behind CloudFront; the console is
  S3 + CloudFront; Connector Foundry's **own** Cognito pool with a branded sign-in page (ADR 0005);
  KMS for the credential broker (AB-02); SSM for config and secrets; the LLM seam (D-88) —
  Muse Spark for the hackathon (H-01, seeded in SSM), Bedrock (Nova 2 Lite) as the
  post-hackathon default through the instance role. Dev URLs are the AWS-generated
  CloudFront / Cognito domains from `terraform output` — branded `console.`, `api.`,
  `login.connectorfoundry.com` domains are production-only ([`path-to-prod.md`](path-to-prod.md) §1). About
  $20/month running, $7 stopped. No NAT, ALB, ECS or Aurora — the written exception to the
  no-new-VPC rule is D-86 (`projects/connector-foundry/docs/decisions.md`).
- **`prod/` — the full design (not applied):** ECS Fargate behind an ALB, Aurora on the shared
  cluster, support intake. It needs the shared VPC/Aurora re-enabled first.

**How to apply `dev/`:** [`apply-runbook.md`](apply-runbook.md) — one apply on AWS-generated
URLs (no DNS, no certificate), image push + deploy through SSM, console upload, Muse Spark
seeded by H-01. Custom domains / Hostinger DNS live in [`path-to-prod.md`](path-to-prod.md).

## Login page (ADR 0005)

The console signs in through Cognito's managed login (`@vir/web-auth`), served at
`https://login.connectorfoundry.com` once `enable_custom_domains = true` (always also at
`https://connector-foundry-<env>.auth.us-east-1.amazoncognito.com`; `terraform output -raw login_url`).
The page carries its own logo through managed-login branding (`cognito-client.tf`,
`modules/app-user-pool`):
- **Logos:** `projects/connector-foundry/docs/logos/`, used on both themes of the page.
  - `connector-foundry-logo-light.svg`: the light theme (Cognito's default white page).
  - `connector-foundry-logo.svg`: the dark theme.
- **Dark page with amber buttons** (Naveen's call; console `#060b16` background, `#ffa02e`
  accent):
  1. After the first apply, open Cognito console → `connector-foundry-dev-users` →
     Branding → Managed login → Edit, and set the colours (dark mode, primary button
     `#ffa02e`).
  2. Export the style:
     `aws cognito-idp describe-managed-login-branding-by-client --user-pool-id <id> --client-id <id> --return-merged-resources --query ManagedLoginBranding.Settings > ../branding/managed-login-settings.json`
  3. Commit the file. `cognito-client.tf` picks it up automatically, and it applies with
     the next plan.
- **Preview:** Cognito console → the pool → Branding → Managed login → *View login page*.

State backend: **S3** (`s3://vir-terraform-state`, key `apps/connector-foundry/dev/terraform.tfstate`,
native locking). Region: **us-east-1** for everything. No secrets live in these files: the signing,
origin and Postgres secrets are generated (`random_password`) into SSM SecureString; Stripe keys are
optional `sensitive` variables; the Muse key is put into SSM by hand.

## What lives where (`dev/`)

| Concern | File |
|---|---|
| Shared-stack remote state (CustomMessage Lambda only) + naming | `data.tf` |
| VPC, public subnet, internet gateway, host security group (HTTP from CloudFront only) | `network.tf` |
| ECR, host IAM role, EC2 instance, data volume, Elastic IP, DLM snapshots | `host.tf`, `host-user-data.sh.tftpl` |
| Runtime config + generated secrets (the host's `.env`) | `ssm.tf` |
| Wildcard certificate, console + API CloudFront distributions | `cdn.tf` |
| Own Cognito pool (module), custom login domain, console client, branding, email profile | `cognito-client.tf` |
| SES domain identity, configuration set, DKIM | `ses.tf` |
| Eval-reports bucket + console bucket | `storage.tf` |
| KMS envelope-encryption key (AB-02) | `kms.tf` |
| URLs, DNS records, deploy handles | `outputs.tf` |

Security posture: CloudFront is the only public entry. The host's security group admits port 80
from CloudFront's origin-facing prefix list only, and the API rejects requests without the
`x-origin-verify` secret CloudFront adds. No SSH (SSM Session Manager). IMDSv2 only. Both S3
buckets are private (reports via the host role, console via CloudFront OAC). Postgres listens only
inside the Docker network; its data volume is encrypted and snapshotted daily.
