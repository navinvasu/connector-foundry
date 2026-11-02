# Connector Foundry

**Detailed system design - Version 0.2**

A customer-facing platform that converts existing REST APIs into curated, secure, testable interfaces for Muse and other AI agents.

**Design target**

One API to a releasable connector without hand-coded glue

**Architecture**

Versioned control plane plus isolated runtime gateway

**User surface**

Guided import, curation, evals, publishing, and operations

Prepared for Naveen Vasu
24 September 2026 · Technical design for MVP through production

---

## Architecture decisions

### Build a platform-neutral core with a Muse adapter

The product is not “OpenAPI in, manifest out.” It is a controlled release system that narrows an API into safe agent tools, proves behavior, and optionally runs those tools through a governed gateway.

**Control plane**

#### Design, test, and release

Imports API contracts, builds a canonical tool model, manages human review, runs evaluations, and publishes immutable releases.

**Data plane**

#### Execute with policy

Authenticates the caller, resolves end-user credentials, enforces approval and rate policies, translates requests, and records redacted evidence.

#### Decisions that shape the system

| Decision | Choice | Why |
| --- | --- | --- |
| Internal contract | Canonical Tool IR | Avoid lock-in to one agent platform |
| Deployment | Modular monolith + workers first | Fewer operational seams during discovery |
| Runtime | Separate gateway service | Protect latency and tenant isolation |
| Automation | Suggest, then approve | Effects and permissions need human ownership |
| Artifacts | Immutable releases | Reproducibility, diff, and rollback |
| Muse support | Versioned publisher adapter | Platform contract may evolve |

> **Scope boundary:** the customer API remains the system of record. Connector Foundry stores configuration, encrypted credential references, release artifacts, evaluation evidence, and minimal redacted runtime telemetry.

#### Initial supported envelope

OpenAPI 3.0/3.1 JSON REST APIs; JSON request/response bodies; API key and OAuth authorization-code authentication; 5-100 selected operations; staging environment required; generated OpenAPI facade, hosted MCP endpoint, and a provisional Muse publishing bundle.

---

## Users and product surface

### The console serves four roles with one shared release model

**API engineer**

#### Owns the upstream contract

Imports the specification, fixes unsupported schemas, maps errors and pagination, and validates calls against staging.

**AI / product engineer**

#### Owns tool behavior

Chooses user jobs, writes tool intent, sets effect classes, curates scenarios, and inspects agent traces.

**Security administrator**

#### Owns delegated access

Approves hosts, OAuth scopes, secret providers, retention, approval rules, and production promotion.

**Operator**

#### Owns reliability

Monitors traffic, failures, upstream limits, connector versions, incidents, and rollback.

#### Information architecture

#### Workspace

Members
Roles
Billing
Audit export

#### Project

Overview
API sources
Environments
Connections

#### Build

Operations
Tool editor
Policies
Evaluations

#### Release

Publish targets
Versions
Traffic
Incidents

#### Primary navigation

**Overview:** readiness + blockers --> **API source:** spec + environment --> **Tools:** intent + policy --> **Evaluate:** scenarios + traces --> **Publish:** targets + rollout --> **Operate:** health + audit

> **UX principle:** every page answers one of three questions: “What is blocking release?”, “What will the agent be able to do?”, or “What happened during this call?” Avoid presenting raw API detail without a decision attached to it.

#### Access model

| Role | May edit | May approve |
| --- | --- | --- |
| Viewer | None | None |
| Builder | Sources, tools, tests | Draft checks |
| Security admin | Auth, policy, retention | Security gate |
| Release admin | Targets, rollout | Production release |

---

## Customer journey and states

### A connector advances through explicit, reviewable gates

**1. Create:** project + use cases --> **2. Import:** validate source --> **3. Curate:** select tools --> **4. Secure:** auth + policy --> **5. Prove:** eval + review --> **6. Release:** publish + monitor

#### Happy path

#### Describe the user jobs

Enter five to ten plain-language outcomes, prohibited actions, and the target environment.

#### Upload or link OpenAPI

The importer resolves references in a sandbox, lints schemas, inventories operations, and reports blockers.

#### Review generated tools

The customer confirms names, descriptions, input bounds, effects, approvals, and upstream mappings.

#### Connect staging credentials

Secrets go directly to the vault; the UI receives only connection status and metadata.

#### Run scenario suite

Release gates require schema, routing, safety, execution, and recovery checks to pass.

#### Publish an immutable version

A release exposes target-specific artifacts or a managed endpoint and can be rolled back.

#### Project state machine

**DRAFT** source and tool edits allowed

**BLOCKED** unresolved import, auth, or policy issue

**READY_FOR_EVAL** configuration complete

**EVALUATING** immutable candidate under test

**APPROVED** required gates passed and signed

**RELEASED** target version available

**SUSPENDED** traffic denied; config retained

**ARCHIVED** no new releases or traffic

#### Release invariants

- A released artifact references exactly one source hash, compiler version, override set, policy set, and eval run.
- Editing creates a new draft; it never mutates the live release.
- Promotion requires role-based approval and an audit event.
- Rollback changes routing to an older immutable release; it does not rebuild.

---

## System context

### Connector Foundry is an agent-facing facade, not a new system of record

**Customer team:** configures and approves --> **Web console + API:** control-plane entry --> **Compiler + evals:** release factory --> **Publishers:** Muse / MCP / OpenAPI

↓
**Muse / agent:** discovers + calls tool --> **Runtime gateway:** policy + translation --> **Customer API:** authoritative data/actions --> **Webhook source:** optional events

#### System owns

- Normalized tool definitions and mappings.
- Release versions and publisher artifacts.
- Workspace identity, roles, and approvals.
- Evaluation scenarios, expected outcomes, and traces.
- Credential references and connection status.
- Redacted invocation metadata and audit events.

#### System does not own

- Customer business records returned by the upstream API.
- Muse user memories or conversation history.
- The customer's identity store or authorization policy.
- Marketplace discovery, ranking, or billing inside Muse.
- Long-term copies of arbitrary request or response bodies by default.

#### Trust boundaries

| Boundary | Trust decision | Enforcement |
| --- | --- | --- |
| Browser → control API | Workspace member + role | OIDC session, CSRF, RBAC |
| Agent → gateway | Valid audience + release | Token validation, tenant binding |
| Gateway → upstream | Approved host + user grant | Egress allowlist, vault lease |
| Worker → artifacts | Authorized job + version | Workload identity, signed digest |
| Webhook → ingest | Known provider + fresh event | Signature, replay window |

> **Muse fit:** public Meta guidance describes user-authorized connectors, task-relevant data exchange, disconnection, proactive updates for some connectors, and approval controls. The design therefore treats connection, least privilege, approval metadata, and revocation as first-class concepts.[1][2]

---

## Logical architecture

### Three execution modes prevent one workload from taking down another

**Synchronous control**

#### Human interactions

Projects, edits, diffs, approvals, status, release history. Low volume; strong consistency for configuration.

**Asynchronous work**

#### Compilation and evals

CPU/network-heavy jobs with retries, timeouts, per-tenant quotas, and persisted checkpoints.

**Runtime traffic**

#### Agent calls

Independent low-latency path with bounded dependencies, no calls to the compiler, and fail-closed policy.

#### Logical component map

#### Experience

Web console
Public control API
CLI / CI integration

#### Control core

Workspace & project
Source registry
Tool catalog
Release manager

#### Async engines

Importer
Compiler
Eval orchestrator
Publisher workers

---

#### Runtime core

Ingress gateway
Policy engine
Credential broker
Protocol adapter

#### Platform data

PostgreSQL
Object storage
Queue / event bus
Redis

#### Cross-cutting

Identity
KMS / vault
Audit ledger
Telemetry

#### Deployment recommendation

#### MVP

One control-plane application containing workspace, project, source, tool, and release modules; three worker types; one separately deployed gateway. PostgreSQL, object storage, Redis/queue, managed key management, and a secret vault.

#### Scale-out trigger

Extract a module only when it needs a different scaling model, isolation boundary, ownership team, or release cadence. Likely first extractions: eval workers, OAuth broker, and publisher adapters.

> **Dependency rule:** the gateway reads a signed, cached release snapshot. It does not join control-plane tables on each request. Control-plane impairment must not interrupt already-deployed connector traffic.

#### Availability domains

Run the gateway and credential broker across at least two zones. Keep workers horizontally scalable and disposable. Use one primary database with point-in-time recovery for the control plane; add read replicas only when measured load requires them.

---

## Control-plane services

### Control services turn editable intent into an immutable release

| Service / module | Responsibility | State and interface |
| --- | --- | --- |
| Identity & workspace | Users, SSO/OIDC, roles, invitations, tenant boundary | PostgreSQL; REST; audit events |
| Project service | Projects, environments, readiness, feature flags | PostgreSQL; REST |
| Source registry | Spec uploads, hashes, versions, validation reports | Object store + metadata DB |
| Import orchestrator | Sandbox parsing, reference resolution, lint pipeline | Queue jobs; signed result bundle |
| Tool catalog | Canonical tools, bindings, effects, policies, overrides | PostgreSQL JSONB + revision rows |
| Compiler | Deterministic IR build and target-independent checks | Worker; artifact output |
| Evaluation service | Suites, fixtures, runs, graders, regressions, traces | Queue + object store + DB summary |
| Release manager | Candidate freeze, approvals, signatures, promotion | Strongly consistent DB transaction |
| Publisher adapters | OpenAPI, MCP, Muse-specific output packages | Versioned worker plug-ins |
| Notification service | Build complete, gate failed, incident, key expiry | Event subscriber; email/webhook* |
| Audit service | Append-only administrative and security event ledger | Durable log + export API |

* Outbound notifications are optional in the MVP; the event contract should exist before delivery channels do.

#### What stays synchronous

- Read and update project configuration.
- Acquire an edit revision and save an override.
- Approve a release candidate.
- Read status and prior results.

#### What becomes a job

- Dereference and lint large specifications.
- Compile targets and build bundles.
- Execute evaluations and collect traces.
- Publish or revoke an external target.

#### Job contract

```text
job_id, tenant_id, project_id, type
input_digest, requested_by, requested_at
attempt, max_attempts, lease_expires_at
status: queued | running | succeeded | failed | cancelled
result_uri, error_code, correlation_id
```

> **Do not split too early:** implement these as explicit modules and queues in one repository. Preserve ownership and API boundaries, but avoid distributed transactions and duplicated operational tooling until load or team structure demands separation.

---

## Data-plane services

### The gateway executes a signed release with no design-time ambiguity

| Runtime component | Hot-path duty | Fail behavior |
| --- | --- | --- |
| Edge ingress | TLS, token validation, quotas, request ID | Reject invalid or overloaded traffic |
| Release resolver | Map endpoint to immutable release snapshot | Use cached last-known-good; never draft |
| Policy engine | Scope, effect, confirmation, field and tenant rules | Deny on missing or unknown policy input |
| Schema validator | Coerce safe primitives; enforce bounds and enums | Return structured validation error |
| Credential broker | Lease secret/token for the specific upstream audience | No lease, no call; UI never sees value |
| Request translator | Bind path/query/body; headers; pagination; timeout | Stop on unmapped parameter |
| Execution client | DNS pinning, egress allowlist, connection pools | Bounded retry only when safe |
| Response normalizer | Map status/body to stable success or error envelope | Return UPSTREAM_CONTRACT_ERROR |
| Idempotency service | Deduplicate writes; remember in-flight/terminal result | Reject collision or uncertain replay |
| Audit emitter | Redacted outcome, latency, policy, release, actor | Buffer locally; page on durable sink loss |

#### Runtime call contract

```text
POST /v1/runtime/{connector_id}/tools/{tool_name}
Headers: Authorization, Idempotency-Key, X-Approval-Token,
         Traceparent, X-Connector-Version (optional pin)
Body:    { "arguments": { ... }, "context": { "locale": "en-US" } }
Result:  { "status": "ok", "data": {...}, "request_id": "..." }
Error:   { "status": "error", "code": "POLICY_BLOCKED",
           "retryable": false, "safe_message": "..." }
```

#### Reads

Retry transient connect failures when no response bytes were received and within the time budget.

#### Idempotent writes

Retry only with a durable idempotency record and identical argument digest.

#### Unknown writes

Never retry. Return an “outcome unknown” code and a verification hint.

> **Isolation rule:** place runtime traffic in cells. A cell contains gateway instances, cache, idempotency partition, and tenant assignments. A failed or overloaded tenant can then be isolated without a global outage.

---

## Connection map

### Every connection has a narrow purpose and identity

| Caller → callee | Protocol | Identity | Data class |
| --- | --- | --- | --- |
| Browser → control API | HTTPS / JSON | OIDC session + CSRF | Configuration |
| CLI / CI → control API | HTTPS / JSON | Scoped service token | Specs, release commands |
| Control API → PostgreSQL | TLS database | Workload identity | Tenant metadata |
| Control API → object store | Signed object API | Workload identity | Specs, artifacts, traces |
| Control API → queue | Managed queue | Workload identity | Job pointer only |
| Worker → sandbox | Local process / container | Ephemeral job identity | Untrusted API document |
| Agent → runtime gateway | HTTPS; MCP or tool HTTP | Audience-bound access token | Tool arguments/results |
| Gateway → release cache | TLS key-value | Workload identity | Signed release snapshot |
| Gateway → credential broker | mTLS / internal RPC | Workload + tenant context | Secret lease request |
| Broker → vault | Vault API | Dedicated workload role | Encrypted credential |
| Gateway → customer API | HTTPS | Delegated user token/key | Business request/response |
| Webhook source → ingest | HTTPS | Provider signature | Event payload |
| Services → telemetry | OTLP / event stream | Workload identity | Redacted metadata |

#### Network policy

- Private networking for databases, cache, queue, vault, and telemetry.
- Gateway egress limited to release-approved hosts and ports.
- DNS resolution validated against private/link-local ranges before connect and after redirect.
- Import workers have no credential access and use a controlled fetch proxy.

#### Service authentication

- Short-lived workload identities instead of static service keys.
- Tenant and project context signed at entry, then verified at each privileged hop.
- Separate runtime and control-plane trust domains.
- No user bearer token copied into logs, jobs, or object names.

> **Data minimization:** object storage holds full eval traces only when the customer enables capture for that environment. Production defaults to metadata, field names, sizes, hashes, policy decisions, and status codes - not raw bodies.

#### Timeout budgets

Allocate one total request deadline at ingress. Suggested starting split: 100 ms for identity and policy, 150 ms for credential lease and request build, customer-configured upstream budget, then 100 ms for normalization and audit enqueue. Never let internal retries extend the caller's deadline.

---

## Import and compilation sequence

### Compilation is asynchronous, deterministic, and reproducible

**Sequence A - source import to release candidate — Control plane**

- **Customer:** 1. Upload spec + use cases --> 7. Review suggested tools --> 11. Request eval

- **Control API:** 2. Authorize + create source version --> 8. Save override revision --> 12. Freeze candidate

- **Object store:** 3. Persist bytes under content hash --> 10. Store IR + reports

- **Queue:** 4. Enqueue IMPORT --> 9. Enqueue COMPILE --> 13. Enqueue EVAL

- **Worker:** 5. Sandbox parse + lint --> 6. Inventory + draft IR --> 14. Run suites + graders

- **Release mgr:** 15. Check gates + approvals --> 16. Sign candidate digest

#### Deterministic input tuple

```text
candidate_digest = SHA256(
  source_bytes + source_resolution_manifest + compiler_version +
  canonical_schema_version + sorted_overrides + policy_revision +
  publisher_versions + fixture_versions
)
```

#### Safe retries

- Create resources with client idempotency keys.
- Workers claim leases and write results by digest.
- Duplicate compile produces the same artifact or reuses it.
- Publishing is compare-and-swap on target version.

#### Hard failures

- Reference cycle beyond configured depth.
- Remote reference outside approved hosts.
- Unsupported schema with no override.
- Missing effect classification or auth scope.

> **Model assistance:** generated names, descriptions, and candidate scenarios may use a language model, but suggestions are stored as proposals. The release digest contains the accepted text, not a nondeterministic prompt call.

---

## Runtime execution sequence

### Policy is resolved before the upstream request exists

**Sequence B - agent tool invocation — Data plane**

- **Agent host:** 1. Tool call + arguments + approval proof --> 12. Stable result or structured error

- **Ingress:** 2. Validate token, audience, tenant, quota --> 3. Attach request + trace IDs

- **Resolver:** 4. Load signed release snapshot

- **Policy:** 5. Check tool, scope, effect, approval, field rules

- **Idempotency:** 6. Reserve key + argument digest for writes --> 11. Commit terminal outcome

- **Credential:** 7. Lease token for tenant/user/audience

- **Translator:** 8. Validate + bind HTTP request --> 10. Normalize response

- **Customer API:** 9. Execute one bounded request

#### Decision table for retries

| Observed outcome | Read | Idempotent write | Unsafe write |
| --- | --- | --- | --- |
| Connect failed, no bytes | Retry within budget | Retry with same key | Do not retry |
| HTTP 429 + Retry-After | Return retryable | Return retryable | Return retryable; no auto-retry |
| 5xx before result | Bounded retry | Verify idempotency then retry | Outcome unknown |
| Malformed success body | Contract error | Verify using read tool | Outcome unknown |
| Client deadline elapsed | Cancel if possible | Persist in-flight result | Outcome unknown |

> **Warning:** **Critical rule:** “outcome unknown” is a distinct terminal result. The agent must be told to verify state with a read tool or ask the user; silently repeating the write is prohibited.

---

## Customer OAuth sequence

### Broker delegated access without exposing tokens to the application

**Sequence C - end-user connection — Authorization code + PKCE**

- **Muse / agent:** 1. Start connection --> 9. Receive connection status

- **Auth broker:** 2. Create state, nonce, PKCE challenge --> 6. Validate state + issuer + code binding --> 8. Return opaque connection ID

- **Customer IdP:** 3. Authenticate user --> 4. Show exact scopes + consent --> 5. Redirect with code

- **Token endpoint:** 7. Exchange code using verifier; validate audience

- **Vault:** 7a. Encrypt tokens under tenant key --> 10. Rotate / revoke / expire

#### Connection record

```text
connection_id
workspace_id, connector_id
external_subject_hash
issuer, audience, granted_scopes
vault_secret_ref
status, expires_at, last_refresh_at
created_at, revoked_at
```

#### Security controls

- Exact redirect URI matching and PKCE S256.
- Issuer binding and CSRF state validation.
- Least-privilege scopes per tool set.
- Refresh-token rotation where supported.
- Connection revocation propagates to runtime cache.
- No tokens in browser storage or general logs.

#### Other supported auth modes

| Mode | Use | MVP treatment |
| --- | --- | --- |
| Static API key | One customer service identity | Vault capture; server-side only |
| OAuth client credentials | Machine-to-machine | Tenant-scoped, no end-user identity |
| Custom signed request | Legacy or proprietary APIs | Post-MVP plug-in, security review |
| Session/cookie login | Browser-oriented APIs | Not supported |

RFC 9700 is the security baseline for OAuth deployments, including PKCE, exact redirect handling, and avoiding obsolete implicit and password flows.[4]

---

## Transformation engine

### The differentiator is semantic curation, not schema conversion

#### Normalize the source

Parse OpenAPI, resolve approved references, canonicalize media types, expand parameters, and fingerprint every operation.

#### Inventory and score

Measure documentation quality, schema complexity, user relevance, side effects, auth scopes, and operational hazards.

#### Select and decompose

Exclude admin/bulk endpoints; split overloaded operations; merge transport-only variations behind one user intent.

#### Generate the Tool IR

Create verb-first names, decision-boundary descriptions, bounded inputs, stable outputs, effect class, and upstream bindings.

#### Add runtime contracts

Normalize errors and pagination; define timeout, retry, idempotency, confirmation, redaction, and rate-limit behavior.

#### Apply reviewable overrides

Customer edits live in an overlay keyed by source operation fingerprint, preserving generated/base separation.

#### Compile publishers

Emit OpenAPI facade, MCP tools, and Muse adapter from the same IR; validate target-specific limits.

#### Build candidate evidence

Generate scenario templates, run selected fixtures, and produce a signed readiness report.

#### Operation score

```text
score = 0.30 user_job_match + 0.20 schema_quality
      + 0.15 description_quality + 0.15 testability
      + 0.10 auth_clarity + 0.10 operational_safety

hard_block if: unknown_effect | unconstrained_url | unsupported_auth |
               unresolved_schema | no_success_contract
```

#### Deterministic

Parsing, fingerprinting, schema mapping, linting, target generation, hashing.

#### Model-assisted

Intent suggestions, description rewrites, ambiguity discovery, test variations.

#### Human-approved

Inclusion, effect, scopes, confirmation, examples, production release.

> **Override survival:** when a new source version arrives, replay overrides only if the operation fingerprint and referenced schemas remain compatible. Otherwise mark the override “needs review”; never apply it silently.

---

## Canonical data model

### Version configuration; reference large evidence by content hash

**Workspace:** 1..n Projects --> **Project:** 1..n Sources --> **Tool draft:** n Bindings + Policies --> **Candidate:** 1 Eval run --> **Release:** n Targets

| Entity | Key fields | Storage rule |
| --- | --- | --- |
| workspace | id, name, plan, region | Tenant root; immutable region |
| membership | workspace, subject, role | Unique per user/workspace |
| project | id, workspace, state, settings | Soft-delete; tenant-filtered |
| environment | project, kind, base_url, host policy | No credentials in row |
| source_version | digest, object_uri, parsed version | Immutable bytes |
| operation | fingerprint, method, path, risk hints | Derived from source |
| tool_revision | name, intent, schemas, effect | Append-only revision |
| binding_revision | operation, parameter map, transforms | Append-only revision |
| policy_revision | scopes, approval, retry, redaction | Append-only revision |
| scenario | utterance, fixture, expected assertions | Version with suite |
| eval_run | candidate, status, scores, trace_uri | Summary DB; detail object store |
| release | digest, signature, approvals, status | Immutable after creation |
| connection | subject hash, scope, vault ref, status | Revoke, never expose secret |
| invocation | request id, release, tool, outcome, timing | Partitioned; redacted |
| audit_event | actor, action, resource, before/after digest | Append-only, retention policy |

#### Relational database

Authoritative metadata, revisions, approvals, state transitions, connection status, and summarized metrics. Every tenant-owned table carries `workspace_id`; row-level enforcement is defense in depth.

#### Object storage

Raw source bytes, normalized sources, compiled artifacts, full eval traces, fixture bundles, and signed release snapshots. Keys use opaque IDs and content digests, never customer names or tokens.

> **Deletion:** workspace deletion tombstones metadata, revokes runtime routes and vault entries, then asynchronously erases objects according to the retention contract. Audit evidence retains only the minimum legally and contractually required fields.

---

## UI - project dashboard

### The landing page is a release-readiness checklist

**Acme Support Connector / Overview — Staging - Draft v7**

**Navigation:** Overview | API source | Tools | Authentication | Policies | Evaluate | Publish | Operations | Audit

#### Release readiness

3 blockers - last compiled 14 min ago

**Action:** Build candidate

**Source**

#### 92%

1 unsupported schema

**Tools**

#### 8 selected

2 need effect review

**Evaluation**

#### 86%

3 of 22 failed

#### Blocking work

**BLOCKER** Confirm **refund_payment** as a financial action

**BLOCKER** Map error response for HTTP 409

**REVIEW** OAuth scope **tickets.write** added by source v4

#### Recent activity

#### Active release

**v6** - 8 tools - healthy

OpenAPI + MCP deployed
Muse package generated

**NO INCIDENTS** 
#### Key interactions

- Clicking a blocker deep-links to the exact field or failed trace.
- “Build candidate” freezes a revision and starts compilation; it does not release.
- Readiness percentages explain their denominator and never hide hard blockers.

#### Empty state

- Lead with “Import an OpenAPI file” and show supported versions.
- Provide a sample project only if clearly labeled as sample.
- Ask for user jobs before showing operation inventory.

---

## UI - import and mapping

### Import makes unsupported behavior visible before tools are generated

**API source / Import v4 — Validated with 2 blockers**

**Navigation:** 1 - Source | 2 - Findings | 3 - Environments | 4 - Operations

#### Source summary

**OpenAPI 3.1.0**
84 operations

**126 schemas**
4 recursive

**2 security schemes**
OAuth + API key

#### Blockers

**SCHEMA** **Ticket.parent** exceeds recursion limit

**HOST** Remote reference points outside approved domain

#### Warnings

**EFFECT** 7 POST operations lack idempotency documentation

**ERROR** 13 operations use undocumented default responses

#### Environment

Staging base URL

**HOST VERIFIED**

#### Resolution mode

Remote references

**ALLOWLIST ONLY**

Maximum 25 files - 10 MB total

**Action:** Resolve blockers and revalidate

#### Server behavior

- Upload streams directly to object storage through a short-lived signed request.
- Control API verifies digest and enqueues import.
- Sandbox has strict CPU, memory, file, recursion, and network limits.
- Findings use stable codes so CI can enforce them.

#### Operation inventory filters

- Tag, method, path, auth scheme, and deprecation state.
- Likely read/write/destructive effect.
- Schema complexity and documentation score.
- “Matches user job” and “recommended for exclusion.”

> **No production crawling:** the MVP accepts a provided contract and optional allowlisted references. It does not discover undocumented endpoints by probing a customer's production service.

---

## UI - tool editor

### One screen ties user intent to runtime policy and HTTP binding

**Tools / cancel_subscription — Unsaved revision**

**Navigation:** search_subscriptions | get_subscription | cancel_subscription | pause_subscription | update_payment_method

**Summary:** 8 included; 14 excluded; 2 need review

#### Agent contract

Tool name

When to use

Input schema - 3 fields

#### Safety policy

Effect **DESTRUCTIVE**

Confirmation **ALWAYS**

Idempotency **REQUIRED**

Retry **NEVER AFTER UNKNOWN**

Scopes **subscriptions.write**

#### Upstream binding

**POST** /v1/subscriptions/{subscription_id}/cancel

**subscription_id**
path ← arguments.id

**reason**
body ← arguments.reason

**Idempotency-Key**
header ← invocation.key

#### Diff from released v6

**BREAKING** Input **reason** changed from optional free text to required enum.

**Action:** Test tool

**Action:** Save revision

#### Inline validation

Names, descriptions, schema bounds, output contract, policy, and mapping must all be complete.

#### Preview

Show the final tool as each publisher will expose it, including target-specific truncation or rejection.

#### Bulk actions

Allowed only for exclusion, read-only classification, or shared tags; never bulk-mark destructive tools safe.

> **Four-pane mental model:** what the user asks, what arguments the agent sends, what authority the action needs, and what HTTP request executes. A tool is not ready until these agree.

---

## UI - evaluations and traces

### Evaluation turns a failed score into one inspectable decision chain

**Evaluate / Candidate c_01H… — 19 passed - 3 failed**

**Selection**

#### 95%

1 wrong tool

**Arguments**

#### 91%

2 invalid fields

**Safety**

#### 100%

0 forbidden effects

#### Scenario matrix

| Scenario | Expected | Actual | Result |
| --- | --- | --- | --- |
| Cancel named plan | cancel_subscription | cancel_subscription | **PASS** |
| “Cancel it” ambiguous | clarify | cancel_subscription | **FAIL** |
| Find active plans | search_subscriptions | search_subscriptions | **PASS** |
| Repeat confirmed cancel | deduplicated | deduplicated | **PASS** |

#### Selected trace

**T+0 ms** intent classifier: cancel

**T+34 ms** tool selected without ID

**T+39 ms** policy required confirmation

**T+42 ms** call blocked before network

#### Diagnosis

**DESCRIPTION**

Tool text does not say to identify one subscription before calling.

**Action:** Create suggested fix

#### Release gates

| Gate | Default threshold | Blocking rule |
| --- | --- | --- |
| Schema contract | 100% | Any invalid generated request blocks |
| Safety scenarios | 100% | Any forbidden or unapproved effect blocks |
| Intent selection | ≥95% | Configurable; no critical miss |
| Argument accuracy | ≥95% | Required fields and enums exact |
| Execution success | ≥99% fixtures | No duplicate writes |
| Regression | No critical decline | Compare with active release |

> **Fixture safety:** destructive scenarios run only against a customer-designated test tenant with cleanup or deterministic reset. Production traffic is never an evaluation target.

---

## UI - publish and operations

### Publishing is a promotion workflow, not a download button

**Publish / Candidate v7 — Security approval pending**

#### Candidate identity

**Digest**
sha256:92ad…

**Tools**
8 - 1 breaking change

**Evidence**
22 scenarios - 100% safety

#### OpenAPI facade

**READY**

Download artifact or serve managed endpoint.

#### MCP endpoint

**STAGING**

Streamable HTTP - authenticated.

#### Muse adapter

**VERIFY**

Generated bundle; portal contract review required.

#### Promotion checklist

**PASS** Compiler and target validation

**PASS** Required evaluations

**PASS** Builder approval

**WAIT** Security administrator approval

**Action:** Promote to production

#### Operations view

- Calls, success rate, p50/p95/p99 latency, and upstream 4xx/5xx.
- Policy denials, approval failures, auth expiry, rate limits, and outcome-unknown writes.
- Breakdown by release, tool, environment, and tenant-safe time range.
- Trace lookup by request ID, with body capture status visible.

#### Incident actions

- Disable one tool without disabling the connector.
- Suspend one tenant, environment, or runtime cell.
- Rollback target routing to the last-known-good release.
- Revoke a connection and invalidate credential cache.
- Export an audit slice for investigation.

> **Safe rollout:** production promotion starts at 0% until routing is explicitly changed. Support internal smoke traffic, then a small canary, then full promotion. Any critical safety or contract regression automatically halts the rollout.

---

## External API and event contracts

### Resources are idempotent; long-running work is observable

#### Customer control API

```text
POST   /v1/projects
POST   /v1/projects/{id}/sources
GET    /v1/import-jobs/{job_id}
GET    /v1/projects/{id}/operations
PUT    /v1/projects/{id}/tools/{name}
PUT    /v1/projects/{id}/policies/{tool}
POST   /v1/projects/{id}/candidates
POST   /v1/candidates/{id}/eval-runs
POST   /v1/candidates/{id}/approvals
POST   /v1/releases/{id}/promotions
POST   /v1/releases/{id}/rollbacks
GET    /v1/invocations/{request_id}
```

#### Contract rules

- All create or action requests accept an idempotency key.
- ETag / `If-Match` protects editable revisions from lost updates.
- Long operations return `202 Accepted` with job location.
- Cursor pagination is stable within a declared consistency window.
- Errors use stable codes, safe messages, field paths, and retryability.
- Tenant context comes from identity, never a caller-controlled body field.

#### Event envelope

```text
{
  "id": "evt_...", "type": "eval.run.completed.v1",
  "occurred_at": "2026-09-24T23:00:00Z",
  "workspace_id": "ws_...", "project_id": "prj_...",
  "resource": {"type":"eval_run","id":"evr_..."},
  "correlation_id": "req_...", "actor": {"type":"worker"},
  "data": {"status":"failed","gate_summary":{"blocked":true}}
}
```

| Event family | Consumers | Delivery semantics |
| --- | --- | --- |
| source.import.* | UI status, notification | At least once; dedupe by ID |
| candidate.compiled | Eval scheduler, artifact index | Transactional outbox |
| eval.run.* | Release gate, UI, notification | Ordered per candidate |
| release.promoted | Runtime cache, audit, notification | Outbox + replay |
| connection.revoked | Credential cache, runtime | High priority, replayable |
| runtime.policy_denied | Telemetry, alerting | Sampled detail; exact counters |

> **Consistency model:** configuration writes and approval transitions are strongly consistent in PostgreSQL. Search indexes, dashboards, notifications, and artifact indexes are eventually consistent. The active release pointer changes atomically.

#### Webhook ingestion

Where a customer API emits events, receive them on a dedicated endpoint, verify provider signatures before parsing, enforce timestamp and replay windows, map them to canonical event types, and only then forward a minimal proactive signal to a supported agent-platform adapter.

---

## Security and privacy

### Design for delegated authority and hostile inputs

| Threat | Primary controls | Verification |
| --- | --- | --- |
| Cross-tenant access | Tenant-bound identity, repository filters, row-level policy | Negative isolation suite |
| Credential disclosure | Vault, envelope encryption, redaction, short leases | Secret scanning; log canaries |
| SSRF through spec or tool | Reference fetch proxy, egress allowlist, DNS/IP checks | Redirect and rebinding tests |
| Prompt / metadata injection | Treat imported text as data; bounded fields; no directives | Adversarial descriptions suite |
| Unapproved side effect | Effect class, scope, approval proof, policy-before-network | Forbidden-action scenarios |
| Duplicate write | Idempotency reservation + argument digest | Concurrency and replay tests |
| OAuth mix-up or replay | PKCE, state, exact redirect, issuer/audience checks | Protocol conformance tests |
| Compromised artifact | Content hash, signature, immutable storage, provenance | Signature check at load |
| Unsafe dependency | Pinned builds, SBOM, scanning, minimal images | CI gate and patch SLA |
| Excessive retention | Body capture off, field redaction, TTL, deletion workflow | Retention sweeps + audit |

#### Authorization dimensions

- Workspace member role.
- Agent/client audience.
- Connector release and environment.
- End-user connection and scopes.
- Tool effect and required approval.
- Field-level restrictions and tenant policy.

#### Data handling defaults

- Encrypt in transit and at rest.
- Redact authorization, cookies, and configured fields.
- Hash external subject IDs in telemetry.
- Disable production body capture.
- Separate security audit from debug traces.
- Support region-pinned workspaces later.

#### MCP endpoint requirements

For hosted Model Context Protocol (MCP), expose one authenticated endpoint, validate `Origin` when present, enforce protocol/version negotiation, cap sessions and stream duration, and do not trust client-provided tool names outside the signed release. The current MCP Streamable HTTP specification explicitly requires Origin validation and recommends authentication.[5]

> **Warning:** **Launch gate:** complete a threat model, external penetration test, incident runbook, backup restore test, tenant-isolation test, key rotation drill, and data-deletion verification before production credentials are accepted.

---

## Reliability, scaling, and deployment

### Scale the gateway by cells; scale compilation by queue depth

#### Proposed service objectives

| Surface | Initial SLO |
| --- | --- |
| Control API availability | 99.9% monthly |
| Gateway availability | 99.95% monthly* |
| Internal gateway p95 | <250 ms* |
| Release propagation | <60 sec p95 |
| Revocation propagation | <30 sec p95 |
| Queued compile start | <2 min p95 |
| RPO / RTO control data | 15 min / 2 hr |

* Excludes customer upstream processing time and upstream-caused failures. Final values need load testing and customer commitments.

#### Scaling signals

| Component | Scale on |
| --- | --- |
| Control API | CPU, request concurrency |
| Import workers | Queue age, job CPU |
| Eval workers | Queue age, tenant quota |
| Gateway cells | RPS, p95, open sockets |
| Credential broker | Lease rate, vault latency |
| Telemetry | Ingest lag, dropped spans |

#### Production topology

#### Public edge

WAF / DDoS
Control load balancer
Runtime load balancer

#### Private compute

Control app across zones
Worker pools
Gateway cells
Credential broker

#### Managed state

PostgreSQL HA
Object storage
Queue + Redis
KMS / vault

#### Overload

Per-tenant token buckets, concurrency caps, queue admission, 429 with retry hints, and load shedding before dependency saturation.

#### Dependency failure

Circuit-break upstream hosts, cache signed releases, buffer audit metadata, and fail closed when identity, policy, or credentials are unavailable.

#### Recovery

Point-in-time database restore, versioned objects, infrastructure as code, quarterly restore drills, and one-action release rollback.

#### Observability

Use one correlation ID across ingress, policy, credential lease, upstream request, normalization, and audit. Metrics: request count, outcome, latency, saturation, policy denials, retries, idempotency conflicts, auth refresh failures, upstream 429s, and outcome-unknown writes. Traces sample reads; retain all failed, denied, and write traces with redaction.

> **Cost control:** compile once per content digest, batch eval variants, cap trace retention, and charge managed runtime by successful or attempted tool calls. Keep customer-specific model usage visible because it can dominate evaluation cost.

---

## Implementation plan

### Prove the vertical slice before decomposing the platform

#### Weeks 1-3 - Foundation

- Repository, CI, local stack, identity, workspace, project, and audit skeleton.
- OpenAPI upload, content hashing, sandbox parser, source findings.
- Canonical Tool IR v1, override format, CLI compiler.
- One fixture API with read and idempotent write.

#### Weeks 4-6 - Guided product

- Project dashboard, import findings, operation inventory, tool editor.
- Policy model, effect classes, schema validation, stable errors.
- Generated OpenAPI facade and hosted MCP endpoint.
- First design partner imported end to end.

#### Weeks 7-9 - Proof and auth

- Scenario editor, runner, deterministic fixtures, trace viewer, gates.
- Vault integration; API key and one OAuth provider profile.
- Gateway with release cache, policy, translation, and idempotency.
- Threat model and tenant-isolation suite.

#### Weeks 10-12 - Release pilot

- Immutable candidates, approvals, signed snapshots, rollout, rollback.
- Operations dashboard, request lookup, alerts, audit export.
- Muse adapter implemented only after current developer contract is confirmed.
- Load test, backup restore, security review, paid-pilot handoff.

#### Suggested repository

```text
apps/console
apps/control-api
services/worker-import
services/worker-eval
services/runtime-gateway
services/credential-broker
packages/tool-ir
packages/compiler
packages/policy
packages/publishers/{openapi,mcp,muse}
packages/contracts
fixtures/reference-api
infra/
```

#### Architecture decision record

| ID | Decision | Status / revisit trigger |
| --- | --- | --- |
| ADR-001 | Canonical IR is platform-neutral | Accepted |
| ADR-002 | Control plane starts modular monolith | Revisit at team/load boundary |
| ADR-003 | Gateway is a separate deployment | Accepted |
| ADR-004 | Writes require explicit effect + idempotency | Accepted |
| ADR-005 | Production body capture defaults off | Accepted |
| ADR-006 | Muse contract isolated in publisher | Pending portal verification |

> **First demonstrable milestone:** import one real staging API, curate 5-10 tools in the UI, execute one read and one safe write through the gateway, run 10 scenarios, inspect one failed trace, and roll back a release.

---

## Assumptions and sources

### The core design is stable; platform-specific publishing stays replaceable

#### Assumptions to validate with Meta

- Current connector submission schema and review sequence.
- Supported auth patterns, callback URLs, scopes, and approval metadata.
- Tool count, description, schema, payload, timeout, and rate limits.
- Whether proactive events are supported and how they are delivered.
- Required privacy, retention, security, reliability, and test evidence.
- Discovery, ranking, analytics, billing, fees, and revenue-share rules.

#### Designs that do not depend on Meta

- OpenAPI ingestion and canonical Tool IR.
- Human curation and policy model.
- Evaluation scenarios, release gates, and trace evidence.
- Managed gateway, credential isolation, idempotency, and audit.
- Immutable releases and rollback.
- OpenAPI facade and MCP publishing.

#### Recommended implementation defaults

| Concern | Default | Reason |
| --- | --- | --- |
| Language | TypeScript | Strong schema tooling; shared web/server types |
| Web UI | React / Next.js | Fast product iteration and server rendering |
| Database | PostgreSQL | Transactions, revisions, JSONB, row policies |
| Async | Managed queue + workers | Leases, retries, dead-letter handling |
| Cache / idempotency | Redis-compatible store | Low-latency TTL state |
| Artifacts | Versioned object storage | Large immutable blobs and lifecycle rules |
| Secrets | Managed vault + KMS | Lease and rotation boundary |
| Telemetry | OpenTelemetry | Portable traces, metrics, and correlation |

#### Sources

**[1]** Meta Help Center, “How Muse works with Connectors.” [https://www.meta.com/help/1687253048996149](https://www.meta.com/help/1687253048996149)

**[2]** Meta Help Center, “How Muse works with your guidance and approval.” [https://www.meta.com/help/1385290430137537](https://www.meta.com/help/1385290430137537)

**[3]** OpenAPI Initiative, “OpenAPI Specification v3.2.1.” [https://spec.openapis.org/oas/latest.html](https://spec.openapis.org/oas/latest.html)

**[4]** OAuth.net, “OAuth 2.0 Security Best Current Practice - RFC 9700.” [https://oauth.NET/2/oauth-best-practice/](https://oauth.NET/2/oauth-best-practice/)

**[5]** Model Context Protocol, “Streamable HTTP.” [https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)

> **Working posture:** treat the Muse adapter as provisional until the live developer contract is reviewed. The remaining architecture is the product: it can serve customers through a portable OpenAPI facade, MCP, or later agent-platform adapters.
