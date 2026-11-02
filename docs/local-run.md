# Run Connector Foundry completely locally (before any AWS apply)

The full product on one machine: **real PostgreSQL + local backend + local
console**, login skipped. Nothing in AWS is created, called or needed.
Verify everything here first; only then apply the lite stack
(`infrastructure/terraform/apps/connector-foundry/apply-runbook.md`).

**How login is skipped:** the server runs with `CF_DEV_AUTH=true`, which
signs every request in as a seeded platform-admin dev user
(`dev@connectorfoundry.local`, "Dev Workspace"). No Cognito pool, no login
page, no token. The console needs no auth config at all — leave every
`VITE_COGNITO_*` value empty and no sign-in button renders. AWS APIs that
would need credentials simply answer honestly: Stripe/S3-report endpoints
return `503 … not configured`, the credential vault uses a local dev key
instead of KMS (Step 2), and the LLM talks straight to Meta's API.

## Prerequisites

- Node.js 20+ and npm (`node -v`)
- PostgreSQL 16: **Docker Desktop** (Step 1a, the normal path) *or* a local
  Postgres install (Step 1b fallback)
- Optional, only for the agent-task/fix-suggestion beats: a Twelve Data API
  key (free at twelvedata.com) and a Meta Model API key (Muse Spark credits)

## Step 1 — Database (real Postgres, database `connector_foundry`)

**1a. Docker Desktop running (normal path):**

```bash
cd projects/connector-foundry/backend
docker compose up -d
docker compose ps            # postgres must show "healthy"
```

**1b. No Docker (Homebrew Postgres):**

```bash
brew install postgresql@16 && brew services start postgresql@16
psql postgres -c "CREATE ROLE postgres LOGIN SUPERUSER PASSWORD 'postgres';"   # if the role is missing
createdb connector_foundry   # owned by your user is fine; DATABASE_URL below must match
```

Either way the server expects (override with `DATABASE_URL` if yours differ):
`postgres://postgres:postgres@localhost:5432/connector_foundry`

## Step 2 — Backend (port 4000)

```bash
cd projects/connector-foundry/backend/server
npm install                  # once per machine / after package.json changes
cp .env.example .env
```

Set these in `.env` (the rest can stay as shipped):

```bash
CF_DEV_AUTH=true                                   # skip Cognito login entirely
CF_BROKER_DEV_KEY=<64 hex chars>                   # local vault key — generate it, see below
# Optional — Muse Spark for agent tasks, fix suggestions, playground.
# Without them the product still runs; those beats answer 503 llm_not_configured.
CF_LLM_PROVIDER=openai_compatible
CF_LLM_MODEL=muse-spark-1.3
CF_LLM_BASE_URL=https://api.meta.ai/v1
CF_LLM_API_KEY=<Meta Model API key>                # from dev.meta.ai — see "Getting CF_LLM_API_KEY" below
# Leave empty locally: COGNITO_*, STRIPE_*, CF_REPORT_S3_BUCKET, AWS_* keys.
```

### Getting `CF_BROKER_DEV_KEY` (you generate it — it comes from nowhere)

There is nothing to sign up for and no key to fetch: the dev vault key is a
random 32-byte secret **you make up locally**. It only encrypts credentials
in your local database. You need it the first time you store an API key,
run eval on a key-protected tool, or invoke one — until then those actions
answer `503 credential_storage_not_configured` (the rest of the app works
without it). Do this once:

```bash
openssl rand -hex 32
# → e.g. 9f2c… (exactly 64 hex characters — copy the whole line)
```

No `openssl`? Use Node instead (same output):

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Paste the result as `CF_BROKER_DEV_KEY=<the 64 chars>` in
`backend/server/.env`, restart the backend (`Ctrl-C`, then `./dev.sh`), and
confirm the boot log says `"broker":"dev-key"`. Keep the same key for the
life of your local database — changing it makes previously vaulted
credentials unreadable (delete and re-store them, or reset with
`docker compose down -v`). Never reuse this key anywhere else, and never
set it in a deployment: production uses KMS and refuses to boot with a dev
key. If boot fails with `CF_BROKER_DEV_KEY must be 32 bytes as hex
(64 chars) or base64 (44 chars)`, the pasted value is truncated or has
stray spaces/quotes — regenerate and paste it bare.

### Getting `CF_LLM_API_KEY` (Meta Model API key) — needed only for the Muse beats

**Is it needed for local-run? Not for the core product.** Without it (or
with any of the four `CF_LLM_*` vars unset) everything else works: database,
sign-up-less dev login, import, vault, compile, harness evaluation,
release, invoke, console. What you lose is everything Muse Spark powers —
**Propose tasks**, the **agent task suite** in Evaluate, **Suggest fixes**,
and the **playground** — those answer `503 llm_not_configured` and the agent
suite reports `not_tested`. Since those are demo beats 4, 5 and 7, get a
key before verifying the demo locally; skip it for plain backend testing.

How to get one (a Meta developer account, pay-as-you-go; hackathon credits
are applied to this account/team — if your credits live in a hackathon
dashboard, claim them into the same Meta account first):

1. Go to [dev.meta.ai](https://dev.meta.ai/) and sign in / create a Meta
   developer account. Create or select the **team** the key (and any
   hackathon credit) belongs to — keys, usage and billing are per team.
2. Open the API keys page: [dev.meta.ai/api-keys](https://dev.meta.ai/api-keys)
   → **Create API key**. Give it a name (e.g. `connector-foundry-local`).
3. **Copy the key immediately — it is shown only once** (keys start with
   `LLM_`). Lost it? Delete that key on the same page and create a new one;
   the old value cannot be shown again.
4. Paste it in `backend/server/.env` (all four lines from Step 2 —
   `CF_LLM_PROVIDER=openai_compatible`, `CF_LLM_MODEL=muse-spark-1.3`,
   `CF_LLM_BASE_URL=https://api.meta.ai/v1`, `CF_LLM_API_KEY=<key>`),
   restart the backend, and sanity-check the key itself:

   ```bash
   curl -s https://api.meta.ai/v1/chat/completions \
     -H "Authorization: Bearer <key>" -H 'Content-Type: application/json' \
     -d '{"model":"muse-spark-1.3","max_tokens":16,"messages":[{"role":"user","content":"Say ok"}]}'
   # a JSON chat completion = key works; 401 Unauthorized = wrong/truncated key
   ```

5. Watch spend at dev.meta.ai → Usage/Billing; locally each run is also
   capped by `CF_LLM_MAX_TOKENS_PER_RUN` (default 60000).

Treat the key like any secret: `.env` only, never commit it, never paste it
into the console or a spec. A leaked key is revoked on the api-keys page.

Boot it (schema applies automatically on first boot — no migration step):

```bash
./dev.sh                     # = DATABASE_URL default + CF_DEV_AUTH=true + tsx watch
curl -s http://localhost:4000/health
# {"ok":true,"service":"connector-foundry-server","version":"0.1.0"}
```

One-shot alternative to check the DDL without booting: `npm run db:init`.

## Step 3 — Console (port 5174)

```bash
cd projects/connector-foundry/web
npm install
npm run dev                  # http://localhost:5174
```

No `.env` needed: the console defaults to `http://localhost:4000` and, with
no Cognito values, renders no login. You land in the Dev Workspace. (To try
other roles without any login, use the dev persona switcher —
`docs/testing.md` §0.)

## Step 4 — Verify the whole flow (no AWS anywhere)

1. **Smoke the backend end to end** (project → import → compile → approve →
   eval → release → invoke → telemetry → cleanup). With no `CF_TOKEN` it
   uses the dev login:

   ```bash
   cd projects/connector-foundry/backend/server
   # Small/fast first (any small public spec), then the real demo API:
   npm run smoke -- --spec-url https://api.twelvedata.com/doc/swagger/openapi.json --api-key <Twelve Data key> --keep
   # must end with: ✅ Smoke run passed.
   ```

   Note: the Twelve Data spec has 187 operations, so this import/compile is
   the slow one (minutes). The run always uses the fixed project name
   "Test - Twelve Data" on all three targets (MCP + OpenAI + Meta Muse),
   deleting any previous project with that name first. `--keep` leaves the
   project for Step 4.2; a run without it deletes its project at the end.
2. **Click the demo in the console** (http://localhost:5174): open the kept
   project (or create "Twelve Data" and import the same spec URL in Import),
   vault the Twelve Data key in Tools (this exercises `CF_BROKER_DEV_KEY` —
   locally encrypted, never KMS), curate the ~8 demo tools
   (`../demo/demo-twelve-data-muse.md` §3), Evaluate → Propose tasks → approve
   → Run evaluation (agent evidence must name `muse-spark-1.3` when the
   Step 2 LLM vars are set), Publish → release → playground prompt.
3. **Database sanity** (proves it's a real DB, not a mock):

   ```bash
   docker compose -f ../docker-compose.yml exec postgres psql -U postgres -d connector_foundry -c '\dt'
   # 27 tables; then: SELECT name, status FROM canonical_tools LIMIT 8;
   ```

## Step 5 — Reset / stop

```bash
# stop console + backend: Ctrl-C in their terminals
cd projects/connector-foundry/backend && docker compose down        # keep data
docker compose down -v                                               # wipe data, start clean next time
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Cannot find package 'dotenv'` on boot | Run `./dev.sh` (it reinstalls when deps are stale) or `npm install`. |
| Boot fails connecting to Postgres | Step 1 first: `docker compose ps` healthy, or `pg_isready -h localhost -p 5432`. Check `DATABASE_URL`. |
| Boot fails: `schema apply failed … column "invite_token_hash" does not exist` (or `this database predates the single-schema layout`) | Your local database was created by the old migration chain and holds an earlier table shape; the single schema file cannot upgrade it in place (nothing deployed exists, by design). **Reset it:** `cd projects/connector-foundry/backend && docker compose down -v && docker compose up -d`, then `./dev.sh` again. (`down -v` deletes local data — that is the point.) Homebrew fallback: `dropdb connector_foundry && createdb connector_foundry`. |
| Storing a key / eval-auth / invoke of a key tool → `503 credential_storage_not_configured` | `CF_BROKER_DEV_KEY` unset. Generate one (`openssl rand -hex 32` — full steps in Step 2 "Getting `CF_BROKER_DEV_KEY`"), put it in `backend/server/.env`, restart the backend, confirm `"broker":"dev-key"` in the boot log, retry. |
| Boot fails: `CF_BROKER_DEV_KEY must be 32 bytes…` | Pasted key is wrong length/format (truncated, quoted, or spaces). Regenerate and paste exactly 64 bare hex chars. |
| Stored credential suddenly unreadable after restart | `CF_BROKER_DEV_KEY` changed since the key was vaulted. Restore the original key, or delete + re-store the credential (or reset: `docker compose down -v`). |
| Agent tasks / suggestions / playground 503 `llm_not_configured` | Expected without the `CF_LLM_*` vars. Get a key at [dev.meta.ai/api-keys](https://dev.meta.ai/api-keys) (full steps in Step 2 "Getting `CF_LLM_API_KEY`"), set all four vars, restart. If the model call returns 401, the key is wrong/truncated — re-create it on that page. If eval evidence names Nova, Bedrock vars leaked into `.env` — remove them; the demo is Muse-only. |
| Console shows a sign-in button / login redirect | A `VITE_COGNITO_*` value is set in `web/.env*` — clear them locally; login is skipped by design here. |
| Port 4000/5174/5432 already in use | Stop the other process (`lsof -i :4000`) or change `PORT` / Vite port consistently. |
| Dashboard counts look inflated (e.g. "100 of 1242 tools") or the same review warning appears twice, on a database created before the dedupe indexes | Re-imports used to append duplicates. Collapse them once: `psql "$DATABASE_URL" -f projects/connector-foundry/scripts/dedupe-duplicate-tools.sql` (back up first if the data matters). New imports/compiles dedupe themselves, so this is a one-time step. Or reset fully: `docker compose down -v` and re-import. |

## Gate to AWS

Do not apply Terraform until: health OK, smoke passes on the Twelve Data
spec, and the console demo beats (import → vault → curate → eval → release
→ playground) all work locally. Then follow
`infrastructure/terraform/apps/connector-foundry/apply-runbook.md` — the
only differences on the hosted stack are Cognito login on (this runbook's
`CF_DEV_AUTH` off), KMS instead of the dev vault key, and AWS-generated
URLs instead of localhost.
