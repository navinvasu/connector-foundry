# Connector Foundry — Manual Test Guide

Covers everything built through Sep 29, 2026 (Sep 27–29 sprint): onboarding/customers/roles,
job queue, billing plumbing, live console screens, backend hardening (validation, errors, logging,
pagination), release rollback, and telemetry retention. Unit tests are mocked-DB — this guide is
the **live pass** those tests couldn't do.

**Prereq legend:** `[docker]` needs Docker running (local Postgres). `[keys]` needs Stripe keys.
`[cognito]` needs the Cognito pool — not yet available; covered by dev-auth bypass instead.

---

## 0. One-time setup (~5 min) `[docker]`

```bash
cd ~/workspace/vir-clan-mono-repo
git checkout feat/connector-foundry && git pull --ff-only

# 1. Start Postgres (postgres:16, db connector_foundry, localhost:5432)
cd projects/connector-foundry/backend && docker compose up -d

# 2. Terminal A — install deps, then start the API server
#    (schema auto-applies on boot; dev-auth bypass is on by default)
cd backend/server && npm install    # once per machine, and after pulls that change package.json
./dev.sh                            # API on http://localhost:4000

# 3. Terminal B — console
cd ../../web && npm install         # same one-time install for the console
npm run dev                         # console on http://localhost:5174

# 4. Terminal C — sanity check
curl -s localhost:4000/health
# → {"ok":true,"service":"connector-foundry-server","version":"0.1.0"}
curl -si localhost:4000/health | head -3   # response carries X-Request-Id (BE-06)
```

Dev-auth notes: `CF_DEV_AUTH=true` (default) signs every request in as the seeded platform-admin
dev user (`dev@connectorfoundry.local`). No `Authorization` header needed in any check below.
You are a **platform admin**, so membership/role gates are bypassed — role-specific checks live
in the automated permission-matrix tests until Cognito logins exist (FE-01).

### Acting as someone else — dev personas (IN-09)

The header's persona switcher (dev builds only) changes who you are; the app reloads as them.

- **Foundry staff, no tenant access** — persona *Operator · staff only*: lands on
  Admin → Customers; Projects/Build/Release/Run disappear. Use this to verify the operator plane.
- **Customer user** — persona *Customer · dev workspace*: a non-admin owner of the Dev
  Workspace — tenant plane only, no Admin tab. For role checks, invite an email to a workspace
  as staff (Admin → Customers → Team, or §3.9), then redeem the invite token as that address:
  `curl -X POST localhost:4000/v1/invites/<token>/redeem -H 'x-dev-as: <email>'` (SE-10 —
  sign-in alone no longer activates a hashed invite). Invite as editor/viewer to check roles.
- **Brand-new user** — *Act as email…* with any fresh address: you land on Create Organization;
  creating it (trial plan, no sample project) drops you into the tenant plane as its owner.
- **Dev admin · both planes** — the default identity (no persona headers): platform admin +
  Dev Workspace owner. It's the bootstrap identity `npm run smoke` and the curl checks use —
  not a real-world role.

The persona switcher only changes what the browser sends; the **server** must be running
current code to honor it. `dev.sh` watches `src/` and restarts on change, but after a
`git pull` restart it once (Ctrl-C, `./dev.sh`). Proof the server is current:
`curl -s localhost:4000/v1/me -H 'x-dev-as: check@test.local'` — the response email must be
`check@test.local`, not `dev@connectorfoundry.local`.

API equivalent (Terminal C): add `-H 'x-dev-as: person@acme.test'` to any curl below
(`-H 'x-dev-as-admin: 1'` as well for an operator persona). The server honors these headers
only under `CF_DEV_AUTH` — production Cognito auth never reads them.

---

## 1. Automated tests (~3 min)

```bash
cd backend/server && npm run typecheck && npm test   # expect: 674 passed, 32 skipped (integration tests need Postgres — §1b)
cd ../../web      && npm run typecheck && npm test   # expect: 45/45 green
```

Mocked-DB unit + supertest route tests — fast regression guard, not a substitute for §3.

### 1b. Integration tests (BE-02) — full HTTP stack against scratch Postgres

```bash
cd backend/server
# needs a reachable Postgres; the suite drops + recreates this DB on every run
CF_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/connector_foundry_test npm test
# expect: 654/654 green (623 unit + 31 integration)
```

What it does: boots the real Express app (`src/app.ts`) against a scratch database
(drop → create → real schema apply), seeds the dev-auth identity, and drives the AC
flow over HTTP — create project → import a 2-op fixture spec → compile via the
queue → approve → release blocked pre-eval → eval against a localhost stub
upstream → tools promoted to tested → release → approve → manifest → invoke both
tools (real upstream HTTP) → telemetry → rollback → deprecated-release refusal —
plus a route matrix (404 sweep, 400s, honest 503s without Stripe/S3 keys). No
external network touched. **Without a reachable Postgres the 33 integration tests
skip and the suite still exits 0** (the unit tests are the always-on guard).

---

## 2. Fast path: full pipeline in one command (~2 min)

With the API running (§0, Terminal A), in Terminal C:

```bash
cd backend/server && npm run smoke -- --spec-url <public OpenAPI URL> [--api-key <key>]
```

Drives the real flow over HTTP against that API: create project → import → compile → approve →
eval → create release → approve → invoke a read-only tool → telemetry → delete the project.
**Pass = `✅ Smoke run passed.` (a real upstream answer through the data plane).** Run it against
the API you will show, the day before (HK-01 §3).

### 2b. Agent features (needs `CF_LLM_PROVIDER`/`CF_LLM_MODEL`, D-88)

1. Evaluate → **Propose tasks** → approve two → **Run evaluation** → *Agent behavior* shows task success and transcripts.
2. **Suggest fixes** → accept one → Tools: approve the edited tool → **Re-run evaluation** → *Agent behavior* shows before vs after.
3. Publish → cut the next release → **What changed** lists the edit; **Try it with an agent** answers a prompt.
4. Operate → turn on **Capture prompts** → ask again in the playground → *Who calls, and why* shows a user-prompt playground call and the prompt.

The BE-02 integration suite covers this journey with a scripted model (no LLM, no network).

---

## 3. Manual API checks (Terminal C, ~20 min)

### 3.1 Identity & workspaces — BE-11 / BE-12

```bash
curl -s localhost:4000/v1/me
# → dev user + memberships; Dev Workspace role "owner", writable: true
```

### 3.2 Projects + pagination — BE-08

```bash
curl -s -X POST localhost:4000/v1/projects -H 'content-type: application/json' \
  -d '{"name":"My Test API","connector_targets":["mcp","openai"]}'
PID=<project id from the response>

curl -s "localhost:4000/v1/projects?limit=1"
# → array + pagination: {limit: 1, has_more: true, next_cursor: "..."}
curl -s "localhost:4000/v1/projects?limit=1&cursor=<next_cursor>"   # page 2
curl -s "localhost:4000/v1/projects?limit=abc"       # → 400 {code: "invalid_pagination"}
curl -s "localhost:4000/v1/projects?limit=500"      # → limit clamped to 100
```

### 3.3 Validation & error shape — BE-04 (zod) + BE-05 (error middleware)

```bash
curl -s -X POST localhost:4000/v1/projects -H 'content-type: application/json' -d '{}'
# → 400 {"error":"invalid_request","code":"invalid_request",
#        "fields":{"name":"name is required"},"request_id":"..."}

curl -s -X POST localhost:4000/v1/projects -d 'not-json'
# → 400 invalid_request (malformed JSON surfaces through the same envelope)

curl -s localhost:4000/v1/does-not-exist
# → 404 {"error":"Not found","code":"not_found","request_id":"..."} — no stack traces anywhere

# Project scoping runs before body validation (D-7: unknown projects never leak):
curl -s -X POST localhost:4000/v1/runtime/invoke -H 'content-type: application/json' -d '{}'
# → 404 Project not found (missing project_id resolves no project; not a 400)
```

### 3.4 Import → compile → approve — IA-00 / BE-15 / BE-00

```bash
# Import an OpenAPI spec (URL mode; file/JSON paste also supported)
curl -s -X POST localhost:4000/v1/projects/$PID/sources -H 'content-type: application/json' \
  -d '{"type":"openapi_url","payload":"https://raw.githubusercontent.com/OAI/OpenAPI-Specification/main/examples/v3.0/petstore.yaml"}'

curl -s localhost:4000/v1/projects/$PID/operations     # parsed operations + findings
curl -s localhost:4000/v1/projects/$PID/review         # open review items (e.g. defaulted 200s)

# Compile enqueues a job (202) instead of blocking
curl -s -X POST localhost:4000/v1/projects/$PID/compile
curl -s localhost:4000/v1/projects/$PID/jobs           # poll until compile job = succeeded
curl -s localhost:4000/v1/projects/$PID/tools

# Approve a tool — version bumps AND recovery rules carry to the new version (BE-00 regression)
curl -s -X PATCH localhost:4000/v1/projects/tools/<toolId> \
  -H 'content-type: application/json' -d '{"status":"approved"}'
# → tool.version incremented; GET tools again — recovery rules still present on the new version

# Resolve a review item
curl -s -X PATCH localhost:4000/v1/projects/review/<itemId> \
  -H 'content-type: application/json' -d '{"status":"resolved"}'
```

### 3.5 Eval queue — BE-15

```bash
curl -s -X POST localhost:4000/v1/projects/$PID/eval     # 202 + job id
curl -s localhost:4000/v1/jobs/<jobId>                    # progress.per_tool fills in live
curl -s localhost:4000/v1/projects/$PID/eval/runs         # run history (newest first)
# Re-post /eval while one is running → dedup returns the in-flight job (no double run)
```

### 3.6 Release → approve → manifest — RL-00

```bash
curl -s -X POST localhost:4000/v1/projects/$PID/releases \
  -H 'content-type: application/json' -d '{"version":"1.0.0"}'
RID=<release id>

curl -s -X POST localhost:4000/v1/releases/$RID/approve \
  -H 'content-type: application/json' -d '{"approver":"Naveen"}'
# Release gates: all tools approved + eval passing — otherwise a clear 4xx reason

curl -s localhost:4000/v1/releases/$RID/manifest | head -c 300
# → signed manifest; target is mcp+openai (NOT muse — v1 pivot); signature verifies

# Promotion readiness (RL-08): what's missing before prod, with fixes
curl -s localhost:4000/v1/releases/$RID/promotion-readiness
# → checks[] — release_approved + EV-05 criteria over the latest completed run,
#   each failing item carries an "action". ready=false blocks promotion:

curl -s -X POST localhost:4000/v1/releases/$RID/promote \
  -H 'content-type: application/json' -d '{"channel":"prod"}'
# → staged promotion OK; → 422 promotion_blocked (naming the missing items)
#   until the latest completed eval run is certified. Write tools cannot
#   certify yet (EV-06) — read-only connectors promote today.
```

### 3.7 Invoke + telemetry retention — DP-00 / TE-02

```bash
# Tool name from GET /:id/tools; args per that tool's schema
curl -s -X POST localhost:4000/v1/runtime/invoke -H 'content-type: application/json' \
  -d '{"project_id":"'$PID'","version":"1.0.0","tool_name":"<tool>","args":{ ... }}'
# → real upstream (Open-Meteo) payload; a telemetry row is recorded

curl -s "localhost:4000/v1/projects/$PID/telemetry?days=14"
curl -s "localhost:4000/v1/projects/$PID/telemetry?days=400"
# → 200 with retention: { locked: true, retention_days: 30 } — over-plan windows never error
#   (trial 30d / Starter 90d / Growth 180d / Scale 365d; unknown days values → 400)
```

### 3.8 Rollback — RL-06

```bash
curl -s -X POST localhost:4000/v1/releases/$RID/rollback \
  -H 'content-type: application/json' -d '{}'
# → release status = deprecated, deprecated_at/by/reason populated, audit_events row written

curl -s -X POST localhost:4000/v1/runtime/invoke -H 'content-type: application/json' \
  -d '{"project_id":"'$PID'","version":"1.0.0","tool_name":"<tool>","args":{}}'
# → error RELEASE_DEPRECATED naming the previous approved release as fallback

# Second rollback on the same release → 409 (already deprecated)
```

### 3.9 Team & billing — BE-11 / BE-14 / BL-01–03 `[keys for checkout only]`

```bash
CID=<customer id — from §3.10 or GET /v1/me>

curl -s localhost:4000/v1/customers/$CID/users          # roster: roles + invited/active status
curl -s localhost:4000/v1/customers/$CID/usage          # seat meter "N of M" + project count vs caps

curl -s -X POST localhost:4000/v1/customers/$CID/users/invite \
  -H 'content-type: application/json' -d '{"email":"teammate@example.com","role":"editor"}'
# → pending membership + invite token (7-day expiry; only its SHA-256 hash is stored — SE-10).
# Invite EMAIL is not sent — SES pending (BE-14). Redeem: POST /v1/invites/<token>/redeem
# signed in as the invited email; sign-in alone no longer accepts a hashed invite.
# Invite past the seat cap → 409 with an upgrade nudge

curl -s localhost:4000/v1/billing/plans                 # trial/starter/growth/scale with caps
curl -s -X POST localhost:4000/v1/customers/$CID/billing/checkout \
  -H 'content-type: application/json' -d '{"plan_id":"starter"}'
# → 503 billing_not_configured (expected until Stripe keys exist) [keys]
```

### 3.10 Admin (platform) — BE-11

```bash
curl -s localhost:4000/v1/admin/plans
curl -s localhost:4000/v1/admin/customers
curl -s -X POST localhost:4000/v1/admin/customers -H 'content-type: application/json' \
  -d '{"name":"Acme Workspace","owner_email":"owner@acme.test","owner_name":"Acme Owner"}'
# → new trial workspace (14 days / 3 seats / 2 projects) + owner membership, owner invited
#   (no sample project — D-87)
curl -s -X POST localhost:4000/v1/admin/customers/<CID>/suspend     # → workspace writes blocked
curl -s -X POST localhost:4000/v1/admin/customers/<CID>/reactivate  # → writes restored
```

### 3.11 Role gating — BE-13 (partial; full live check needs Cognito `[cognito]`)

As the dev platform-admin you bypass role gates, so these are covered by the automated
permission matrix (`npm test` — owner/editor/viewer × read/mutate → 403/404 expectations,
outsiders get 404, members lacking permission get 403, viewers read-only). The live
three-user check lands with FE-01. What you *can* verify by hand:

```bash
curl -s -X POST localhost:4000/v1/projects/<nonexistent>/compile
# → 404 Project not found (unknown ids never leak existence, even to you)
```

---

### 3.12 Staff seat override — BL-05

```bash
# the dev identity is the platform admin; pick any customer id from /v1/admin/customers
curl -s -X PATCH localhost:4000/v1/admin/customers/<customerId>/seats \
  -H 'Content-Type: application/json' -d '{"seats": 15, "reason": "manual check"}'
# → 200 with customer.seat_override = 15 (seat_cap now reports 15 everywhere)
curl -s -X PATCH localhost:4000/v1/admin/customers/<customerId>/seats \
  -H 'Content-Type: application/json' -d '{"seats": null}'
# → seat_override null again (plan default restored)
```

Console equivalent: Admin → Customers → **Adjust seats**. Setting an override below
current usage removes nobody — invites just block until the team is under the cap.

---

## 4. Console checks — http://localhost:5174 (~10 min)

1. **Projects** — real list from the API; cards show op/tool counts, open findings, latest source.
2. **New Project wizard** — paste a public OpenAPI URL or upload a spec file → project card shows real counts.
3. **Import** — Compile → live job-progress panel streams → tools appear.
4. **Tools & Review** — approve a tool (version bump, rules intact); resolve a review item → dashboard open-findings count drops.
5. **Evaluate** — Run eval → per-tool progress → results; run history lists previous runs.
6. **Publish** — releases list; create v1.0 → approve → download manifest. (No rollback button yet — API only.)
7. **Operate** — after a few invokes: call stats, per-tool calls and recent invocations render; gateway keys and drift below.
8. **Admin → Customers** (`/admin/customers`) — list, create, suspend/reactivate a workspace.
9. **Team page** (`/customers/:id/users`) — roster, invite form, seat meter "N of M".
10. **Billing page** (`/customers/:id/billing`) — plan cards, trial banner; upgrade shows the 503 "not configured" state until Stripe keys exist.
11. **Console planes** (FE-13) — the dev identity holds both planes, so the sidebar shows everything locally. The separation is verifiable today only in the unit tests (`shellFor` matrix in `web/src/data/api.test.ts`); a live check needs distinct logins — a platform-admin-only account must land on `/admin/customers` with no Projects/Build/Release/Run in the sidebar, and a tenant user must not see Admin. Lands with FE-01 (Cognito).

---

## 5. Not testable yet — don't waste time looking

| Area | Why | Blocked on |
|---|---|---|
| Real signup / login / logout | Cognito pool doesn't exist; dev-auth bypass covers testing | FE-01 + IN-01 (AWS) |
| Editor/Viewer gating as real users | Membership-role gating is testable via dev personas (IN-09, §0); real credential logins still pending | Cognito users (FE-01) |
| Stripe checkout end-to-end `[keys]` | No test products/prices, no keys, no webhook secret | Stripe test setup + `stripe listen` |
| Invitation emails | Token flow works; delivery unwired | SES (BE-14) |
| Muse publishing | Current version; directory listing is a manual form + review, not an API | RL-02 research spike |
| Live-Postgres acceptance for BE-03/04/05/06/08, RL-06, TE-02 | Unit tests are mocked | This guide, §3 |
| Eval PDF reports (EV-03), drift alerts (TE-03), secrets manager (SE-01) | Not built | Roadmap |

---

## 6. Suggested order if time is short

1. §0 setup → §2 seed (whole pipeline, live DB, real upstream) — *the* acceptance check.
2. §3.7 invoke + telemetry retention and §3.8 rollback — newest code paths, least covered by earlier live runs.
3. §4 quick console sweep (screens 1–7).
4. Everything else as time allows.

**If something fails:** note the exact command, the response body (it will include a `request_id` —
grep Terminal A's structured JSON log for that id; one line per request with method/path/status/duration).
