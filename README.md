# connector-foundry

**App ID:** `connector-foundry` | **Database:** `vir_connector_foundry` (planned)

Turns API owners' REST APIs into tested, reliable agent connectors. The customer brings what they have — OpenAPI 3.x (preferred), Swagger 2.0, Postman Collections, or a documentation URL with sandbox access — the service normalizes it, proposes agent-ready tools, proves them with an evaluation harness, and publishes a versioned connector. **v1 output: Muse connector only**, built on a platform-neutral canonical core so other agent platforms can be added later as adapters.

**Product principle:** the service proposes, the customer reviews and approves — nothing ships without sign-off.

---

## Directory Structure

```
connector-foundry/
├── web/                  # Customer console — React 19 + TypeScript + Vite + Tailwind
│   └── src/
│       ├── app/          # Router, shell layout, navigation
│       ├── data/         # Types + API client
│       ├── features/     # One folder per console screen
│       └── shared/       # Design-system atoms, utils
├── backend/              # Working prototype server (Express + PostgreSQL) + future Lambda groups
│   ├── server/           # Real API server — local dev guide in backend/README.md
│   ├── functions/        # Future Lambda function groups (importer, compiler, eval, …)
│   └── api/              # API Gateway route definitions and OpenAPI spec
└── docs/                 # Product + design notes (see docs/README.md)
```

---

## Architecture

Top-level split (full detail in [`docs/system-architecture.md`](docs/system-architecture.md)):

| Plane | Pace | Owns |
|---|---|---|
| **Control plane** | Human-paced | Ingest & normalize → tool compiler → eval orchestrator → approval gate → release manager → Muse adapter → signed release |
| **Data plane** | Per-request | Runtime ingress → release registry (cached) → policy engine → credential broker → customer REST API → redaction → audit |

**Governing boundary:** design and release happen in the control plane. Agent traffic runs from an immutable, signed release inside the data plane — the control plane is never on the hot path.

| Layer | Technology |
|---|---|
| Console | React 19, TypeScript, Vite 6, TailwindCSS 3, Zustand 5, Recharts, TanStack React Query 5 |
| Backend | Express + TypeScript (`backend/server`), one long-lived process with an in-process job queue (eval, compile, drift) |
| Database | PostgreSQL 16 — in Docker on the `dev` host (D-86); Aurora in the `prod` design |
| Auth | Amazon Cognito — Connector Foundry's own pool (ADR 0005), branded managed login at `login.connectorfoundry.com`; credential broker for upstream API keys |
| Agents / LLM | Provider seam (D-88): Bedrock Nova 2 Lite today, Meta Muse Spark (OpenAI-compatible) by config — agent task suite, fix suggestions, playground |
| Outputs | Hosted MCP server (Claude, Meta Muse), OpenAI function-calling + GPT Actions |
| Storage | S3 — console build, eval reports |
| Telemetry | Data-plane calls in Postgres with attribution (channel, client, trigger, opt-in redacted prompts — D-89) |
| Secrets | SSM SecureString + KMS envelope via the credential broker — secrets never enter release artifacts |

**Console:** `https://console.connectorfoundry.com` · **API + MCP:** `https://api.connectorfoundry.com` (hosting: `docs/design/IN-10-lite-demo-stack.md`)
**Region:** `us-east-1`.

---

## Console screens

| Screen | Route | What it does |
|---|---|---|
| Dashboard | `/dashboard` | Project status, release pipeline, next blocking step |
| Import | `/import` | Submit OpenAPI / Swagger / Postman / docs URL + sandbox access |
| Tools | `/tools` | Tool curation — review, edit, approve proposed tools |
| Review | `/review` | Decision queue — ambiguities with evidence, impact, recommendation |
| Evaluate | `/evaluate` | Eval harness — scenario suites, gates, traces, rerun |
| Publish | `/publish` | Release diff, approvals, Muse adapter packaging |
| Operate | `/operate` | Data-plane telemetry (calls, success rate, latency, per-tool calls), gateway keys, drift |
| Projects | `/projects` | Project registry, switcher, new-project wizard (`/projects/new`) |

> **Status:** the console runs against the real control/data-plane server in `backend/server` only — there is no mock or demo mode (D-87).

---

## Run locally

**Prerequisites:** Node.js 20 LTS or newer, npm 9+.

```bash
cd projects/connector-foundry/web
npm install
npm run dev        # local dev server
npm run typecheck  # tsc --noEmit
npm run build      # typecheck + production build
```

The console needs the backend running (`backend/README.md`). The API base is `VITE_API_BASE_URL` (default `http://localhost:4000`); Cognito settings are in `web/.env.example`.

---

## Backend (planned)

Control-plane function groups, mirroring `docs/system-architecture.md` components 01–13:

| Function | Handles |
|---|---|
| `importer` | Source registry + importer worker — parse OpenAPI / Swagger / Postman / docs |
| `normalizer` | Resolve refs, schemas, params, auth hints → canonical tool IR |
| `compiler` | Propose tool names, inputs, descriptions, transforms (draft only) |
| `evaluator` | Eval orchestrator — contract, behavior, auth, resilience suites |
| `approvals` | Approval gate records — tools, evidence, risk sign-off |
| `releaser` | Release manager — freeze versions, sign immutable bundle |
| `publisher` | Publisher worker + Muse adapter — render approved release, package artifact |

Data-plane (components 14–24): runtime ingress, release registry cache, policy engine, credential broker, request translator, response normalizer, redaction, audit events — planned after the control plane.

---

## Database (planned)

- **Schema:** `backend/server/schema/schema.sql` — one final-state SQL file (no migrations; nothing has been deployed yet), applied on boot or by `npm run db:init`. The early design-time schema is archived at `archive/database/schemas/connector-foundry/schema.sql`.
- **Telemetry:** flows through the shared Kinesis → S3 → Athena pipeline, not Postgres. Retention tiers (3 / 6 / 12 months per packaging) are S3 lifecycle policies on the telemetry bucket.

---

## Infrastructure

- **Terraform modules:** [`../../infrastructure/terraform/modules/`](../../infrastructure/terraform/modules/)
- **Environment configs:** [`../../infrastructure/terraform/apps/connector-foundry/`](../../infrastructure/terraform/apps/connector-foundry/) — `us-east-1`, `dev` + `prod`

`dev` (lite, D-86): EC2 t4g.small running `backend/deploy/compose.host.yml`, two CloudFront distributions (console, API), S3 console + reports buckets, Cognito pool + custom login domain, KMS, SSM parameters, Bedrock access via the instance role. `prod`: the ECS/ALB/Aurora design, not applied.

---

## Design documents

| Document | Description |
|---|---|
| [Product Requirements Document](docs/product-requirements-document.md) | PRD v0.1 — source of truth for product decisions |
| [System Architecture](docs/system-architecture.md) | Control/data plane, 24 component contracts, boundaries |
| [Packaging](docs/packaging.md) | Customer packaging draft — tiers, telemetry retention, project limits |
| [docs/README.md](docs/README.md) | Full doc index, incl. reference-only older designs |

---

## Environments

| Environment | Purpose |
|---|---|
| `dev` | Development and local testing |
| `prod` | Production |

Resources are namespaced as `vir-{env}-connector-foundry-*`.
