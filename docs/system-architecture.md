# System Architecture — Connector Foundry

> From source material to a live agent call. A single architecture for importing an API, turning it into reviewed tools, proving those tools work, releasing a Muse connector, and executing every call without putting the control plane on the hot path.

**Governing boundary:** design and release happen in the control plane. Agent traffic runs from an immutable, signed release inside the data plane.

---

## Control plane (Plane 01)

Human-paced authoring: asynchronous compilation, evaluations, approval, and release.

### A · Ingest & normalize

| # | Component | Contract |
|---|---|---|
| 01 | Source registry | Versions raw inputs, records origin — sync write |
| 02 | Importer worker | Parses each supported source into one shape — queued job |
| 03 | Normalizer | Resolves refs, schemas, params, auth hints — deterministic |
| 04 | Canonical tool IR | Platform-neutral operations, schemas, policies — versioned core |

Writes to: **PostgreSQL** (tenants, projects, operations, releases, eval metadata) and **object storage** (raw specs, artifacts, reports, signed bundles).

### B · Design, prove & approve

| # | Component | Contract |
|---|---|---|
| 05 | Tool compiler | Proposes names, inputs, descriptions, transforms — draft only |
| 06 | Tool catalog | Customer edits exposure, wording, policy — reviewable |
| 07 | Eval orchestrator | Runs contract, behavior, auth, resilience suites — isolated runners |
| 08 | Approval gate | Human signs off on tools, evidence, risk — required |
| 09 | Release manager | Freezes versions, signs an immutable bundle — append only |

### C · Publish connector

| # | Component | Contract |
|---|---|---|
| 10 | Publisher worker | Consumes one approved release only — idempotent |
| 11 | Muse adapter | Maps neutral tools into the Muse contract — output adapter |
| 12 | Connector artifact | Manifest, tool schemas, auth config, runtime refs — signed output |
| 13 | Install / promote | Customer chooses environment, activates release — explicit action |

### One-way release boundary

Approved release snapshot → runtime distribution. No per-request dependency on the control plane. Carries **version + hash + signature**.

---

## Data plane (Plane 02)

Low-latency, tenant-isolated execution from cached approved releases. Fail closed.

### D · Agent invocation hot path

| # | Component | Contract |
|---|---|---|
| 14 | Muse agent | Selects a published tool, supplies arguments — tool call |
| 15 | Runtime ingress | Authenticates tenant, validates request envelope — rate limited |
| 16 | Release registry | Loads verified tool config from local cache — no control-plane call |
| 17 | Policy engine | Checks grants, scope, environment, constraints — deny default |
| 18 | Credential broker | Obtains scoped secret or user token at call time — secretless app |
| 19 | Request translator | Builds HTTP request; retries only when safe — idempotency |
| 20 | Customer REST API | Receives normal traffic with tenant credentials — external |

### E · Response & evidence

| # | Component | Contract |
|---|---|---|
| 21 | Response normalizer | Maps status, payload, errors into tool results — bounded output |
| 22 | Redaction layer | Removes secrets and configured sensitive fields — before logging |
| 23 | Audit event | Records who called what, release, outcome, latency — append only |
| 24 | Tool result | Returns structured success or actionable error to Muse — agent safe |

---

## Foundation — shared platform

Managed infrastructure with strict plane and tenant boundaries:

- **PostgreSQL** — metadata + configuration; row-level tenant isolation
- **Object storage** — versioned source, reports, release bundles
- **Queue / event bus** — durable jobs, retries, dead-letter handling
- **Redis / edge cache** — release cache, rate limits, short-lived state
- **Vault + KMS** — envelope encryption, token exchange, key rotation
- **Telemetry pipeline** — metrics, traces, redacted logs, alert routing

---

## Component contract example — Canonical tool IR

The stable, platform-neutral contract between every input adapter and output adapter.
**In:** normalized operation → **Out:** versioned tool definition.

- **Owns:** tool identity, input/output schema, API binding; auth requirements, safety hints, transformation rules; provenance back to the exact source version.
- **Failure boundary:** an invalid operation is quarantined with diagnostics; it never becomes a publishable tool.

## Boundaries this architecture protects

1. **Nothing ships by suggestion alone.** Generated tools stay drafts until evaluation evidence and a named human approval produce a release.
2. **Live traffic survives authoring outages.** The gateway executes from signed, cached snapshots; control-plane availability is not in the request path.
3. **Secrets do not enter artifacts.** Releases reference credential policies; the broker retrieves scoped credentials only for an authorized call.
4. **The neutral core outlives Muse v1.** Input formats and agent platforms are adapters around one canonical representation and proof model.
