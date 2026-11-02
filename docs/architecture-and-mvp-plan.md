# Connector Foundry

## Architecture and 12-week MVP plan

Turn an existing REST API into a small, safe, measurable tool surface that AI agents can use reliably, with Muse as the first distribution target.

- **Input:** OpenAPI, authentication configuration, and a test tenant.
- **Output:** Agent-ready API, MCP endpoint, and evaluation evidence.
- **Buyer:** API-first SaaS teams.
- **Version:** 0.1
- **Date:** 24 September 2026

---

## Executive decision

### Build the reliability layer, not a format converter

> The winning product is a compiler plus an optional runtime gateway: ingest a REST API, expose only the actions an agent should use, and prove those actions work safely through repeatable evaluations.

### Recommended wedge: API-to-agent readiness

Convert a customer's OpenAPI description into a curated tool surface with precise semantics, structured errors, idempotent writes, approval metadata, and an executable test suite.

### Commercial outcome: paid readiness pilot

Sell an auditable before-and-after improvement: fewer wrong tool calls, fewer invalid arguments, and zero duplicate or unapproved side effects in the test set.

### The product has three layers

1. **Compile:** Parse, score, prune, and normalize operations.
2. **Serve:** Generate files or route through a managed gateway.
3. **Prove:** Run intent, execution, recovery, and safety evaluations.

**Key decision:** Keep the compiler platform-neutral. Muse is the first adapter, not the internal data model. Also emit an OpenAPI 3.1 facade and a hosted Model Context Protocol (MCP) endpoint so the same work can reach other agents.

### Initial targets

- **One real API** working end to end before building a dashboard.
- **Three design partners** before self-serve expansion.
- **Twelve weeks** to a paid, measurable pilot.

### Not the MVP

- A universal importer for every API style, protocol, and authentication scheme.
- A marketplace or guaranteed Muse listing. Public connector submission details may change and must be verified at implementation time.
- An autonomous system that publishes or mutates customer APIs without explicit review.

---

## Product contract

### Constrain the input so the output can be trusted

#### Ideal first customer

- B2B or prosumer SaaS with a documented JSON REST API.
- 10-100 candidate operations, one test tenant, and stable staging.
- Wants agent distribution but has no dedicated agent-platform team.
- Can name 5-10 user jobs that matter commercially.

#### Required inputs

- OpenAPI 3.0 or 3.1 file; no production crawling.
- Authentication configuration and least-privilege test access.
- Use-case brief, risk rules, and prohibited actions.
- Expected examples, rate limits, and support contact.

### Customer workflow

1. **Import:** Upload the specification, resolve references, and validate it.
2. **Curate:** Approve operations, names, and action classes.
3. **Configure:** Map authentication, pagination, errors, and idempotency.
4. **Evaluate:** Run scenarios and inspect failures.
5. **Publish:** Export or deploy a versioned endpoint.

### MVP outputs

| Output | Customer receives | Purpose |
|---|---|---|
| Agent facade | OpenAPI 3.1 spec | Portable HTTP contract |
| MCP endpoint | Hosted HTTP tools | Cross-agent delivery |
| Muse package | Metadata and evidence | Submission-ready bundle* |
| Evaluation report | Scores and traces | Proof and release gate |
| Runbook | Auth and rollback guide | Operational ownership |

\* Implement exact Muse packaging and review fields behind a versioned adapter after confirming current developer requirements. The stable core is the normalized tool model and evidence.

**Definition of done:** A customer can import one supported API, approve a curated tool set, run the supplied scenarios, and connect a staging endpoint without your team editing generated code by hand.

---

## System architecture

### Separate the control plane from the request path

The control plane produces a versioned connector release. The data plane is optional: customers can download generated artifacts or route calls through the managed gateway for normalization, policy enforcement, and observability.

### Control plane: compilation and evidence

```text
Console / API
  -> Ingestion worker
  -> Tool compiler
  -> Evaluation runner
  -> Publishers
```

- **Console/API:** Projects, imports, and review.
- **Ingestion worker:** Parse, dereference, and lint.
- **Tool compiler:** Canonical intermediate representation (IR), policies, and mappings.
- **Evaluation runner:** Scenarios, graders, and traces.
- **Publishers:** REST, MCP, and Muse adapters.

### Data plane: optional managed execution

```text
Agent client
  -> Edge gateway
  -> Policy runtime
  -> Adapter
  -> Customer API
```

- **Agent client:** Muse or another agent host.
- **Edge gateway:** Tenant resolution, rate limits, and authentication.
- **Policy runtime:** Action class and approval enforcement.
- **Adapter:** Shape translation, retries, and pagination.
- **Customer API:** System of record.

### Control-plane stores

- **PostgreSQL:** Tenants, projects, releases, and policies.
- **Object storage:** Specifications and generated bundles.
- **Queue and evaluation store:** Background work plus immutable, release-keyed evaluation results.

### Data-plane stores

- **Dedicated vault:** The database stores encrypted references only.
- **Short-lived state:** Replay protection and transient execution state.
- **Observability:** Redacted traces and audit events; no body retention by default.

### Recommended implementation

Use **TypeScript** for schema transformation and MCP compatibility, **PostgreSQL** for versioned state, **Redis** for queues, limits, and idempotency, managed key management plus a vault for credentials, and OpenTelemetry for traces. Deploy the gateway separately so private or self-hosted options remain possible.

**Architectural rule:** Generated connectors never depend on the UI. Every release is reproducible from an immutable source specification, policy file, compiler version, and mapping overrides.

---

## Transformation pipeline

### The moat is semantic transformation

A direct OpenAPI-to-tool conversion preserves every ambiguity and unsafe edge. The pipeline should be deterministic by default, with model-assisted suggestions that remain reviewable and diffable.

1. **Parse and normalize.** Resolve local and remote references safely; detect the OpenAPI version; normalize parameters, media types, and schemas; reject recursive or unsupported shapes with exact diagnostics.
2. **Inventory and classify.** Score each operation for user value, documentation quality, and risk. Label effects as `read`, `reversible_write`, `financial`, `communication`, or `destructive`. Exclude admin and bulk endpoints by default.
3. **Design the agent surface.** Generate concise verb-first tool names; rewrite descriptions around when to use the tool; flatten irrelevant transport details; replace ambiguous free text with enums and bounded fields; add examples only from verified customer inputs.
4. **Add operational contracts.** Map pagination to a stable cursor, errors to a common envelope, and writes to idempotency keys. Mark actions that require user confirmation and define retry safety, timeouts, and rate-limit behavior.
5. **Compile targets.** Emit a clean OpenAPI facade, MCP tools over Streamable HTTP, and a versioned Muse adapter. All targets consume the same canonical IR.
6. **Evaluate and gate.** Generate candidate scenarios, let the customer approve expected behavior, run against staging, and block release on regressions or unsafe side effects.

### What stays human-approved

- **Never auto-publish:** Operation inclusion, destructive capability, and permission scopes.
- **Model-assisted suggestions:** Tool names, descriptions, examples, and scenario drafts.
- **Deterministic output:** Schema conversion, versioning, diffing, and release hashes.

---

## Canonical tool model

### Use one intermediate representation for every target

The canonical model is the durable product asset. It captures intent and safety semantics that raw OpenAPI usually does not, then compilers map it to platform-specific formats.

### Minimum entities

| Entity | Essential fields |
|---|---|
| Project | Tenant, API origin, environment |
| Release | Source hash, compiler, status |
| Tool | Name, intent, input/output schema |
| Effect | Class, approval, reversibility |
| Binding | Method, route, parameter map |
| Auth policy | Scheme, scopes, secret ref |
| Runtime policy | Timeout, retry, idempotency |
| Scenario | Utterance, fixture, assertions |

### Example tool contract

```yaml
name: cancel_subscription
intent: Cancel one active subscription
when_to_use:
  - User names or confirms subscription
inputs:
  subscription_id:
    required: true
    type: string
    description: Opaque subscription ID
  reason:
    required: false
    type: enum
effect:
  class: destructive
  confirmation: always
runtime:
  idempotency: required
  retry: never_after_unknown
success:
  status: cancelled
  effective_at: ISO-8601
errors:
  - NOT_FOUND
  - ALREADY_CANCELLED
  - POLICY_BLOCKED
```

**Tool-description rule:** Describe the decision boundary, not the HTTP implementation. "Cancel one active subscription after the user confirms the exact subscription" is useful; "POST to /v1/subscriptions/{id}/cancel" is not.

### Compiler guarantees

- **Stable names:** Renames are explicit breaking changes. Aliases can preserve compatibility for one deprecation window.
- **Bounded schemas:** Do not use unbounded object blobs when known fields, enums, or one-purpose tools can express the task.
- **Structured outcomes:** Results carry machine-readable status and identifiers; human text is secondary.
- **Fail closed:** An unresolved schema, missing auth scope, or unknown side effect blocks publication.

OpenAPI is a strong ingestion and output boundary because it is a language-agnostic description of HTTP APIs usable by both humans and tooling.[2] Do not make it the internal source of truth for agent-specific intent and policy.

---

## Runtime and security

### Treat every tool call as delegated authority

Meta's public help material says connectors exchange task-relevant data, may be configured read-only, and commonly require approval for important actions.[1] The gateway must preserve, not weaken, those boundaries.

### Identity boundary: per tenant, per user, per service

- Never share credentials across tenants or users.
- Store only vault references in application tables.
- Bind access tokens to issuer, audience, and scopes.
- Use the authorization-code flow with PKCE; avoid implicit grants.

### Execution boundary: policy before network

- Resolve the tool version and action class first.
- Reject missing approval or insufficient scope.
- Attach an idempotency key before any write.
- Apply host allowlists and block arbitrary URLs.

### Request path

```text
Authenticate identity and tenant
  -> Authorize scope and tool policy
  -> Validate schema and bounds
  -> Execute with timeout and retry rules
  -> Record redacted audit event
```

### MVP security controls

| Control | Requirement | Failure behavior |
|---|---|---|
| Idempotency | Every write | Reject if unsupported |
| Approval class | Every tool | Default to strongest |
| SSRF defense | Fixed upstream hosts | Block unknown host |
| Logs | Redacted headers/body | Keep metadata only |
| Retries | Reads by default | Unknown write: stop |
| Deletion | Tenant retention policy | Cryptographic erasure |

**Security baseline:** Follow RFC 9700 for OAuth deployments: exact redirect matching, CSRF protection, PKCE, least privilege, audience restriction, and refresh-token rotation or sender constraint.[3]

Before launch, complete a threat model, dependency and container scanning, encrypted backups, incident playbook, tenant-isolation tests, audit-log integrity controls, privacy policy, and data-processing terms. Do not claim compliance certification before completing the relevant audit.

---

## Evaluation harness

### Sell evidence that the connector behaves correctly

The evaluation harness is both the release gate and the product moat. It should replay a fixed scenario suite against each connector version and make failures diagnosable from a single trace.

### Five evaluation layers

1. **Contract:** Schema validity, reference resolution, authentication completeness, and tool-name stability.
2. **Selection:** Given a user request, did the model choose the correct tool or correctly choose no tool?
3. **Arguments:** Are arguments grounded, complete, schema-valid, and free of invented identifiers?
4. **Execution:** Does the adapter translate, paginate, time out, and recover as specified?
5. **Safety:** Are risky actions blocked without confirmation? Are retries and scope boundaries respected?

### Trace envelope

```yaml
scenario_id: string
connector_release: string
model: string
prompt_version: string
user_utterance: string
selected_tool: string | null
arguments_redacted: object
approval_state: string
upstream_request_hash: string
normalized_result: object
assertions: array
latency_ms: number
cost_estimate: number
```

Never retain raw credentials. Default to hashing identifiers and dropping response bodies after grading.

### Pilot release gates

| Metric | Initial gate | Purpose |
|---|---:|---|
| Correct tool at rank 1 | >= 95% | Discovery reliability |
| Schema-valid arguments | >= 99% | Execution readiness |
| Task completion | >= 90% | End-user value |
| Unsafe side effects | 0 | Safety boundary |
| Duplicate writes | 0 | Idempotency proof |
| Regression tolerance | No critical drop | Safe versioning |

These are proposed product gates, not industry benchmarks. Start with at least 50 customer-approved scenarios covering happy paths, ambiguous requests, missing identifiers, permission failures, rate limits, partial outages, prompt-injection text in upstream data, and duplicate delivery.

---

## MVP scope

### Support the common 80%; reject the dangerous 20%

#### P0: compiler

- OpenAPI 3.0/3.1 JSON and YAML import.
- Local and allowlisted remote references.
- Operation inventory, inclusion workflow, and diffs.
- Tool naming and description suggestions.
- JSON request/response plus path, query, and header parameters.
- Common cursor and page-number pagination.
- Error normalization and read/write action classes.

#### P0: delivery and proof

- Versioned OpenAPI 3.1 facade.
- Hosted MCP Streamable HTTP endpoint.
- Muse adapter isolated behind a versioned interface.
- API key, static bearer token, and one configured OAuth provider.
- Scenario editor, deterministic fixtures, and CI-friendly runner.
- Redacted traces, scorecard, and release comparison.

#### P1: after pilots

- Generic OAuth provider templates and refresh lifecycle.
- Webhooks and long-running job orchestration.
- Customer-managed gateway deployment.
- Multiple model graders and cost optimization.
- Automated documentation and change alerts.

#### Explicitly unsupported in the MVP

- SOAP, GraphQL, gRPC, and browser scraping.
- Multipart uploads, streaming bodies, and binary transforms.
- Arbitrary customer code inside the shared control plane.
- Production writes during onboarding.
- Automatic publication without customer approval.

### MVP acceptance test

For a documented staging API with at most 50 selected operations, a customer can create a project, import and review the specification, deploy a five-to-fifteen-tool connector, run 50 approved scenarios, inspect every failure, and roll back to the previous release. A second import produces a semantic diff and re-runs only affected scenarios plus the safety suite.

**Scope guard:** If an API requires custom authentication code, unusual payload transformation, or undocumented business rules, sell a separately scoped implementation service or defer it. Do not silently absorb it into the base product.

---

## 12-week delivery plan

### Validate demand before building generic infrastructure

| Weeks | Build | Exit evidence |
|---:|---|---|
| 1-2 | CLI, IR, 5 transforms | One API works end to end |
| 3-4 | Review UI and diffs | Approval without code edits |
| 5-6 | Gateway and isolation | No duplicate writes |
| 7-8 | MCP and 50 scenarios | Repeatable release report |
| 9-10 | OAuth, vault, consent | Second partner connects |
| 11-12 | Muse adapter, billing | First paid deployment |

Detailed work by phase:

- **Weeks 1-2:** Build a CLI importer, canonical IR, five manual transforms, one local adapter, and 20 scenarios.
- **Weeks 3-4:** Add the review UI, semantic diff, action classes, error envelope, and release bundle.
- **Weeks 5-6:** Add the managed gateway, tenant isolation, API-key and bearer authentication, and idempotency.
- **Weeks 7-8:** Add MCP output, a 50-scenario harness, traces, and a scorecard.
- **Weeks 9-10:** Add one OAuth integration, a vault, consent and scope mapping, and incident controls.
- **Weeks 11-12:** Add the Muse adapter, documentation, billing pilot, and onboarding hardening.

### Team shape

- **Founder/backend:** Compiler, gateway, data model, and customer discovery.
- **Part-time product/design:** Operation-review and evaluation-report experience.
- **Security reviewer:** Threat model before hosted credential handling.

### Weekly operating rhythm

- **Monday:** Customer scenario and failure review.
- **Tuesday-Thursday:** Ship one narrow capability.
- **Friday:** Regression run, release notes, and demo.
- **Every week:** Record manual minutes per connector.

### Milestones that matter

- **Under four hours:** Hands-on setup for a supported API by week 8.
- **Under 30 minutes:** Human review for a routine specification change.
- **One paid design partner:** Required before self-serve billing work.

**Kill criterion:** Pause the platform build if three qualified teams will not share a staging specification or pay for a reliability pilot. That signals the pain is weak or the buyer is wrong; more automation will not fix it.

---

## Commercial model

### Start as productized software with a paid pilot

Do not lead with "we convert OpenAPI." Lead with the business outcome: **launch an agent integration with measurable reliability and a smaller security-review burden.**

### Pricing hypotheses

- **Paid pilot: $5,000-$15,000.** One API, up to 15 tools, staging deployment, 50 scenarios, and a scored readiness report. Credit part of the fee toward year one.
- **Team plan: $500-$2,000 per month.** Versioning, hosted gateway, scheduled regressions, traces, alerts, and standard support. Price partly by active connector and call volume.
- **Enterprise: annual contract.** Private networking, regional deployment, single sign-on, custom retention, audit export, and support commitments.

Pricing is a discovery hypothesis, not a market quote. Ask buyers what a delayed partner launch, failed security review, or agent-caused support incident costs before fixing list prices.

### Best initial buyer

- Head of Platform or VP Engineering at an API-first SaaS company.
- Product leader responsible for ecosystem integrations.
- Developer-relations team under pressure to support agents.

### Message

> Give us your OpenAPI specification and five user jobs. We return a deployable agent interface plus a regression suite that shows exactly when it is safe to release.

### Discovery questions

1. Which agent surfaces are customers already asking for?
2. Who currently rewrites API descriptions, authentication, and error handling for each platform?
3. What would block security from approving a hosted gateway?
4. Which three actions would be costly if invoked incorrectly or twice?
5. What evidence would make the release owner sign off?

**Defensibility:** Accumulate proprietary, permissioned mappings between raw API patterns, agent-safe tool designs, and observed evaluation failures. The moat is the feedback loop and trust record, not generated boilerplate.

---

## Risks and decisions

### Hedge platform risk without diluting the wedge

| Risk | Early signal | Mitigation |
|---|---|---|
| Muse format changes | Frequent schema changes | Versioned publisher and stable IR |
| Basic conversion ships | One-click spec import | Compete on evals and security |
| Proxy is rejected | Traffic-routing refusal | Offer self-hosted runtime |
| Heavy custom work | Setup stays above one day | Narrow profile; charge services |
| Tools mislead agents | Selection failures cluster | Human review and hard gates |
| Credential incident | Secrets appear in traces | Vault, redaction, retention |
| Weak economics | No attribution path | Bill customers directly |

### Decisions to lock now

- **Hybrid, not proxy-only:** Portable generated artifacts earn trust; the managed gateway adds recurring value but remains optional.
- **Read-first onboarding:** Prove selection and data retrieval before enabling writes. Add actions one by one with explicit classes.
- **Rules plus assisted authoring:** Use deterministic compilation for contracts; use models only for suggestions and evaluation variations.
- **No marketplace dependency:** Customer value must exist even if discoverability, listing rules, or revenue sharing remain unclear.

### Unknowns to validate with Meta

- Current connector submission schema, review stages, and service-level expectations.
- Supported authentication patterns, approval metadata, and proactive event interfaces.
- Required policies, test evidence, data-retention disclosures, and observability hooks.
- Discovery and ranking rules, analytics, billing integration, fees, and revenue share.

Public Meta guidance confirms user-controlled connectors, custom connector creation, read/write controls, approvals, and data-minimizing behavior, but it does not publish all developer submission details on the cited help page.[1] Treat secondary reporting about the developer opening as directional until verified in the live portal.[4]

---

## Start here

### The first sprint ends with a working connector

#### Days 1-3: choose the proving API

1. Pick a small public or owned REST API with staging access and 5-10 meaningful operations.
2. Write ten user requests: five positive, three ambiguous, and two that must be refused.
3. Record the expected tool, arguments, result, and approval behavior.

#### Days 4-7: build the thin compiler

1. Parse OpenAPI and resolve references.
2. Create canonical `Tool`, `Effect`, `Binding`, and `Policy` types.
3. Support explicit inclusion and manual overrides in YAML.
4. Emit one OpenAPI facade and one MCP endpoint.

#### Days 8-10: prove and demo

1. Run the ten scenarios against deterministic fixtures.
2. Add one read call and one idempotent write against staging.
3. Capture a trace and explain every failure.
4. Record a five-minute demo: import, review, run, inspect, and release.

### Deliverable at day 10

A narrow vertical slice: a CLI or minimal web UI, one IR file, two output adapters, a 10-scenario report, and a rollbackable release. Do not build billing, generic OAuth, or a polished dashboard yet.

### Technical repository shape

```text
apps/console             # Project and review UI
services/compiler        # OpenAPI -> canonical IR
services/gateway         # Policy, auth, translation
services/evals           # Scenarios, runners, graders
packages/connector-ir    # Versioned schemas and migrations
packages/publishers      # OpenAPI, MCP, Muse adapters
fixtures/reference-api   # Deterministic test upstream
infra/                   # Local stack and deploy templates
```

**First user-interview ask:** "Send me one staging OpenAPI file and the five jobs you want an agent to complete. I will return a tool design and reliability report." This tests demand for the real outcome, not enthusiasm for the concept.

---

## Sources

1. Meta Help Center, “How Muse works with Connectors.” https://www.meta.com/help/1687253048996149
2. OpenAPI Initiative, “OpenAPI Specification v3.2.1.” https://spec.openapis.org/oas/latest.html
3. IETF, RFC 9700, “Best Current Practice for OAuth 2.0 Security.” https://datatracker.ietf.org/doc/html/rfc9700
4. Runtime Wire, “Meta opens Muse connectors so developers can plug services into its agent,” 18 September 2026. https://runtimewire.com/article/meta-opens-muse-connectors-developers
