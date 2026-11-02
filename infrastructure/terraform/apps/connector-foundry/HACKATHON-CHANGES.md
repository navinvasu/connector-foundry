# Hackathon-only changes — Connector Foundry (revert list)

**Purpose:** every change made *only* to run the hackathon demo, in one place,
so it can be removed cleanly afterwards. Maintained in this folder
(`infrastructure/terraform/apps/connector-foundry/`) next to the stacks it
describes. Founder updates this file in the same commit as any hackathon-only
change — no entry, no change.

**Scope guardrails (hackathon):**

- `dev` lite stack only (D-86 / IN-10). `prod/` is not applied or edited.
- No other app's infrastructure is touched: `apps/dressclan/`,
  `apps/inspect-clan/` and their stacks are untouched (verified: no diff).
- Demo API: **Twelve Data** (`https://api.twelvedata.com/doc/swagger/openapi.json`).
- Demo model: **Meta Muse Spark only** (`muse-spark-1.3` via
  `https://api.meta.ai/v1`). Amazon Nova 2 Lite / Bedrock is **not** run for
  the demo (code path stays as the post-hackathon default — see H-01 revert).

## How to use after the demo

Work top to bottom: for each row, do **Revert**, then `terraform plan` on
`dev/` and confirm the expected diff (config values only — no destroy of the
host, buckets, pool or data volume), then apply from `feat/infrastructure`
synced with `main` (founder only). Runtime-only rows need no apply — just the
SSM / console action. Finally delete the demo data (H-04) and stop the host.

## Register

| ID | Where | Hackathon-only change | Why | Revert after demo | Status |
|---|---|---|---|---|---|
| H-01 | `dev/variables.tf`, `dev/ssm.tf`, `dev/terraform.tfvars.example` | LLM defaults flipped `bedrock` / `us.amazon.nova-2-lite-v1:0` → `openai_compatible` / `muse-spark-1.3` + `https://api.meta.ai/v1`; added `llm_base_url` / `llm_api_key` (sensitive) vars and `CF_LLM_BASE_URL` / `CF_LLM_API_KEY` SSM params (key only when set) | Demo runs Muse Spark on hackathon credits; Nova must not be the demo model | Restore `llm_provider = "bedrock"`, `llm_model = "us.amazon.nova-2-lite-v1:0"`, remove `llm_base_url`/`llm_api_key` vars + the two SSM resources, restore `terraform.tfvars.example`; `put-parameter` the bedrock values (or rely on apply) and redeploy via `deploy.sh`. Expected plan: SSM value updates + 1–2 SSM destroys, nothing else | **Done in code, not applied.** Key still to be supplied in `terraform.tfvars` (never committed) |
| H-02 | SSM runtime only (no TF) | `CF_LLM_API_KEY` value (Meta key) under `/connector-foundry/dev/env/`; if set by hand instead of tfvars, same path | Secret must not live in git or tfstate beyond the SecureString | `aws ssm delete-parameter --name /connector-foundry/dev/env/CF_LLM_API_KEY` (and `CF_LLM_BASE_URL` if H-01 TF is reverted first, delete after apply), then redeploy | Pending (with first apply) |
| H-03 | `dev/host.tf` IAM `BedrockInvoke` statement | **Kept, not removed for the demo.** The statement costs nothing and is the revert target for H-01 | Removing it and re-adding it later doubles plan churn for zero saving | None. Optional post-demo cleanup only if Bedrock is abandoned permanently (then also remove `var.bedrock_model_arns`) | Kept by decision |
| H-04 | Hosted demo data (Postgres on the dev host, not TF) | Demo organisation/project for Twelve Data, vaulted Twelve Data API key (KMS envelope), curated tools (~8 of ~187 operations), eval runs, releases v1/v2, gateway keys (`cf_live_…`) minted for the recording | The live demo dataset | In the console: revoke gateway keys (Operate), delete the demo project (owner delete, SE-04), delete the demo organisation if created only for the demo; verify with `npm run smoke` cleanup behaviour (smoke projects self-delete). Vaulted key ciphertext is deleted with the project | Pending (created at rehearsal) |
| H-05 | Custom domains / Hostinger DNS | **Removed from dev (D-94): not done for the demo.** The demo uses AWS-generated URLs (`console_url` / `api_url` / `login_url` outputs); the ACM certificate is not even created in dev (`count` gated on `enable_custom_domains`, which stays `false`). The full DNS/ACM/Cognito-domain procedure moved to `path-to-prod.md` §1 for production | Branded URLs are production polish, not demo value; skipping DNS removes the propagation wait from the critical path | Nothing to revert in dev. In prod, follow `path-to-prod.md` §1; teardown there removes CNAMEs after the domains are detached | Done (removed from dev plan) |
| H-06 | `shared/dev` (shared infrastructure) | **None.** The lite stack reads only the existing `cognito_custom_message_lambda` output via remote state (`dev/data.tf`). No shared resource is created, changed or re-applied for the hackathon | Shared stack serves every app; hackathon must not move it | Nothing to revert. If a future hackathon need forces a shared change, add a row here *before* applying, with its own revert | None — verified |
| H-07 | Other apps (`apps/dressclan`, `apps/inspect-clan`, app code) | **None.** No file under another app's Terraform or code is edited for this demo | Founder scope: Connector Foundry only | Nothing to revert | None — verified (`git status` clean outside Connector Foundry + this file) |

## Baseline that is NOT hackathon-only (do not revert)

The `dev/` lite stack itself (VPC, EC2 host, CloudFront ×2, S3 ×2, Cognito
pool, KMS, SES identity, SSM config, ECR, DLM) is the standing dev
environment (D-86), not demo scaffolding. After the demo the cost control is
`aws ec2 stop-instances --instance-ids $(terraform output -raw instance_id)`
(~$7/mo stopped), not a destroy. Full teardown, only if decided later:
empty both S3 buckets, `terraform destroy` in `dev/`, wait out the 7-day
KMS deletion window (see apply-runbook Cleanup). No DNS records exist in
dev to remove (D-94).

## Pre-apply readiness (checked 2026-10-26)

- `terraform fmt -check -recursive` on `dev/` + `shared/dev`: **clean**.
- `terraform validate` in this sandbox fails loading the AWS/random provider
  plugins (sandbox exec restriction, not a config error) — **must be re-run
  on the founder's Mac** before apply; expected: `Success!`.
- Apply expectation (apply-runbook): first plan **additions only, ~65 to
  add, 0 to change, 0 to destroy** (never applied; H-01 adds 1–2 SSM params
  to that count). Stop on any destroy/replace.
- Prerequisites: `shared/dev` already applied (only its CustomMessage
  Lambda output is read); state bucket `vir-terraform-state` exists;
  backend image (`backend/server/Dockerfile`, arm64) + `backend/deploy/compose.host.yml`
  present; console `.env.production.example` present.
- Known non-blockers: SES stays in sandbox (Cognito default sender covers
  sign-up); managed-login dark/amber style JSON is optional
  (`../branding/managed-login-settings.json` picked up only if present);
  Stripe vars stay empty (billing answers 503, not demoed).

## Change log for this file

| Date | Entry |
|---|---|
| 2026-10-26 | Created. H-01 applied to `dev/` TF (Muse Spark defaults + SSM params). H-06/H-07 recorded as none. Demo pinned to Twelve Data; Nova excluded from the demo run. |
