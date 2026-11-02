# Path to production — Connector Foundry

Everything the **dev/demo stack deliberately skips**, in the order it must
happen when Connector Foundry goes to production. Dev (`dev/`, the hackathon
demo) runs entirely on AWS-generated URLs — this document is the only place
the custom-domain work lives now (moved out of the dev apply runbook
2026-10-26, D-94). Nothing here is needed for the demo; do not start it
before the production decision.

Production stack: `prod/` (ECS Fargate + ALB + Aurora design, not applied)
plus the domain work below. Founder applies, from `feat/infrastructure`
synced with `main`; read every plan against
`infrastructure/terraform/README.md` → "Before you apply" (stop on any
destroy/replace you did not expect).

## 1. Custom domains — console. / api. / login.connectorfoundry.com

Was "Phase 2 — DNS at Hostinger" in the dev runbook. DNS stays at Hostinger;
certificates must be in `us-east-1`.

1. **Create + validate the wildcard certificate.** In `dev/` terms this is
   `enable_custom_domains`: apply once with it `true` so
   `aws_acm_certificate.wildcard` exists, then read the validation record:
   `terraform output acm_validation_records`. Add that **CNAME** at
   Hostinger (one record covers `*.connectorfoundry.com`). Wait until the
   certificate shows **Issued**:
   `aws acm list-certificates --region us-east-1 --query "CertificateSummaryList[?DomainName=='*.connectorfoundry.com'].Status"`
   (≈15 min + DNS propagation.)
2. **Attach the domains.** Apply again with `enable_custom_domains = true`
   (put it in `terraform.tfvars` so later plans stay quiet). Expected:
   **1 to add** (Cognito custom domain `login.connectorfoundry.com`),
   **in-place updates** to the two CloudFront distributions (aliases +
   certificate), the Cognito client (callback URLs) and the SSM URL
   parameters. **0 to destroy.**
3. **Point DNS at AWS.** `terraform output dns_records`, then add the three
   **CNAMEs** at Hostinger:

   | Host | CNAME → |
   |---|---|
   | `console` | console distribution (`dxxxx.cloudfront.net`) |
   | `api` | API distribution (`dyyyy.cloudfront.net`) |
   | `login` | Cognito's CloudFront target |

   (Cognito's custom domain needs the apex `connectorfoundry.com` to
   resolve — the Hostinger marketing site already does.)
4. **Rebuild the console** against the new URLs (`VITE_API_BASE_URL`,
   `VITE_COGNITO_DOMAIN`, `VITE_COGNITO_REDIRECT_URI` in
   `web/.env.production`), re-sync to the console bucket, invalidate
   CloudFront. Verify sign-up → login → console on the branded domains and
   that `api.` answers `/health`.

For the `prod/` stack, repeat the same pattern against its own outputs —
the steps are identical, only the distribution/domain targets differ.

## 2. Email that can reach anyone (SES production)

Dev/demo sign-up uses Cognito's default sender (50/day) and SES stays in
the sandbox (verified recipients only). For production:

1. Add the **DKIM CNAMEs** from `terraform output ses_dkim_tokens` at
   Hostinger (`<token>._domainkey.connectorfoundry.com` →
   `<token>.dkim.amazonses.com`); wait for the SES identity to show verified.
2. Request **SES production access** (AWS Support quota case) so invite and
   account mail can go to unverified addresses.
3. Only then wire the invite-email leg (BE-14) and drift-alert notification
   (O-13) to SES.

## 3. Branded login finish (optional polish)

Export the managed-login style from the Cognito console (dark page, amber
buttons) to `../branding/managed-login-settings.json` per
`infrastructure/terraform/apps/connector-foundry/README.md` → "Login page";
`cognito-client.tf` picks it up on the next apply. Logos already ship.

## 4. Payments on (Stripe)

Create the tier prices in Stripe, set `stripe_secret_key` /
`stripe_webhook_secret` (tfvars, never committed), and run a live test-mode
purchase + webhook pass (BL-01 caveat). Until then billing answers 503.

## 5. Production stack apply

Apply `prod/` (ECS/ALB/Aurora) per its own README once the shared VPC/Aurora
decision is made; run the §1 domain steps against it; one-command deploy,
monitoring/alarms (IN-05), backup/restore drill (IN-06) and the launch
checklist (roadmap LA-02) close the path.
