# Apply runbook — Connector Foundry `dev` (lite stack, D-86)

Everything runs on **Naveen's Mac**, from `feat/infrastructure` **synced with `main`** after the
`feat/connector-foundry` PR has merged (this stack reads
`projects/connector-foundry/backend/deploy/compose.host.yml` from that PR). Region: **us-east-1**.

```bash
git checkout feat/infrastructure && git pull && git merge origin/main   # or the founder's usual sync
ls projects/connector-foundry/backend/deploy/compose.host.yml           # must exist
```

What gets created: a tiny public VPC (no NAT), one EC2 t4g.small with a separate encrypted data
volume (daily snapshots), an Elastic IP, ECR, two CloudFront distributions (console, API), the
console + reports S3 buckets, Connector Foundry's own Cognito pool with branded login, KMS, SES
identity, SSM parameters (generated secrets + config). About **$20/month running, $7 stopped**.

Prerequisite: the shared stack (`shared/dev`) is applied — this stack reads only its
CustomMessage Lambda output.

---

## Phase 1 — Apply (AWS-generated URLs only)

Dev has **no custom domains and no DNS work**: `enable_custom_domains`
stays `false`, no certificate is created, and the demo uses the URLs AWS
generates — the two `*.cloudfront.net` distributions and Cognito's default
`*.auth.us-east-1.amazoncognito.com` login domain, all printed by
`terraform output` (`console_url`, `api_url`, `login_url`). Branded
domains are production-only and live in [`path-to-prod.md`](path-to-prod.md) §1.

```bash
cd infrastructure/terraform/apps/connector-foundry/dev
terraform init
terraform plan -out cf.plan
```

**Read the plan** (`infrastructure/terraform/README.md` → "Before you apply"): it must be
**additions only, about 65 to add, 0 to change, 0 to destroy** — this stack has never been applied,
so there is no state. Stop on any destroy/replace.

```bash
terraform apply cf.plan
terraform output   # note console_url / api_url / login_url — these are the demo URLs
```

## Phase 2 — Push the API image and deploy

```bash
REPO=$(terraform output -raw ecr_repository_url)
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin "${REPO%%/*}"
cd ../../../../../projects/connector-foundry/backend/server
docker buildx build --platform linux/arm64 -t "$REPO:$(git rev-parse --short HEAD)" -t "$REPO:latest" --push .
cd -
aws ssm put-parameter --overwrite --name /connector-foundry/dev/env/CF_IMAGE --value "$REPO:$(git rev-parse --short HEAD)"
```

Deploy (rebuilds `.env` from SSM, pulls the image, restarts; the schema applies on boot):

```bash
aws ssm send-command --instance-ids "$(terraform output -raw instance_id)" \
  --document-name AWS-RunShellScript --parameters 'commands=["/opt/connector-foundry/deploy.sh"]' \
  --query Command.CommandId --output text
curl -s "$(terraform output -raw api_url)/health"        # {"ok":true,...}
```

Every later backend change: build + push a new tag, `put-parameter CF_IMAGE`, `send-command`.

## Phase 3 — Console

```bash
cd projects/connector-foundry/web
cp .env.production.example .env.production
# fill from `terraform output` (AWS URLs, no branded domains in dev):
#   VITE_API_BASE_URL=$(terraform -chdir=<tf dir> output -raw api_url)
#   VITE_COGNITO_DOMAIN=$(terraform -chdir=<tf dir> output -raw cognito_domain)
#   VITE_COGNITO_CLIENT_ID=$(terraform -chdir=<tf dir> output -raw cognito_client_id)
#   VITE_COGNITO_REDIRECT_URI=$(terraform -chdir=<tf dir> output -raw console_url)/auth/callback
npm ci && npm run build
aws s3 sync dist/ "s3://$(terraform -chdir=<tf dir> output -raw console_bucket)/" --delete
aws cloudfront create-invalidation --distribution-id "$(terraform -chdir=<tf dir> output -raw console_distribution_id)" --paths '/*'
```

## Phase 4 — Smoke test (the hackathon path)

1. Open `terraform output -raw console_url` (the CloudFront demo console) → sign up via
   `login_url` (Cognito's AWS domain) → email code → back in the console → create the organization.
2. Sign out, sign in again; try **Forgot password** once.
3. `CF_TOKEN=<access token from the browser's storage> CF_BASE=$(terraform output -raw api_url) npm run smoke -- --spec-url https://api.twelvedata.com/doc/swagger/openapi.json --api-key <Twelve Data key>`
   from `backend/server` — must end with `✅ Smoke run passed.`
4. Evaluate → Propose tasks → Run evaluation → *Agent behavior* shows model `muse-spark-1.3` (H-01). If it shows Nova, the Muse SSM config is not live — stop and fix before recording.

Sign-up emails come from Cognito's default sender (50/day, any address). Invites sent by the API
use SES, which stays in the sandbox (verified recipients only) until production access is granted.

## Muse Spark config (hackathon H-01 — seeded by Terraform)

The apply already seeds Muse Spark (H-01): set `llm_api_key` in
`terraform.tfvars` before Phase 1. To rotate the key or fix config without
an apply:

```bash
P=/connector-foundry/dev/env
aws ssm put-parameter --overwrite --name $P/CF_LLM_PROVIDER --value openai_compatible
aws ssm put-parameter --overwrite --name $P/CF_LLM_MODEL    --value muse-spark-1.3
aws ssm put-parameter --overwrite --name $P/CF_LLM_BASE_URL --type String       --value https://api.meta.ai/v1
aws ssm put-parameter --overwrite --name $P/CF_LLM_API_KEY  --type SecureString --value '<Meta key>'
# then the Phase 2 send-command (deploy.sh) to restart with the new config
```

Post-hackathon revert (Nova/Bedrock default): follow H-01 in
`HACKATHON-CHANGES.md` — restore the bedrock TF defaults, apply, redeploy.
Terraform ignores later `put-parameter` values (`ignore_changes`).

## Operating it

- **Stop between demos:** `aws ec2 stop-instances --instance-ids $(terraform output -raw instance_id)`;
  `start-instances` before the next one (the stack restarts by itself; URLs don't change).
- **Shell:** `aws ssm start-session --target <instance_id>` (no SSH, no open port 22).
- **Backups:** DLM snapshots the data volume daily (keep 7). Before a demo, also
  `docker compose exec postgres pg_dump -U connector_foundry connector_foundry > /var/lib/connector-foundry/backup.sql`.
- **Compose file changes** (`compose.host.yml`) reach the host only on a new instance; copy by hand
  over a session if needed.

## Cleanup (only if something went badly wrong)

```bash
terraform destroy
```

Empty the S3 buckets first (`aws s3 rm --recursive`). The KMS key has a 7-day deletion window;
the data volume and its snapshots are deleted with the stack.
