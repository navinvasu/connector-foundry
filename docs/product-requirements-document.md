# Agent Connector Builder — Product Requirements Document

**Draft v0.1 · 24 September 2026**

> Turn existing REST APIs into reviewed, tested, agent-ready connectors.
> For API owners who want their products usable through AI agents without building agent expertise in-house.

| Initial release | Design principle |
|---|---|
| OpenAPI-preferred inputs | Platform-neutral core |
| MCP + OpenAI + Meta Muse connector outputs | Customer approval before release |

Engineering design deferred.

**Meta Muse adapter (current version):** the Muse connector ships in the current version alongside the MCP server bundle and OpenAI function-calling / GPT Actions artifacts — all three render the same reviewed manifest. Directory listing remains a manual form + weeks-long review (RL-02), not an API.

**Reading convention:** "Must" = required for v1 acceptance. "Should" = important but deferrable. "Could" = explicitly later. "TBD" = needs pilot evidence or a verified external contract.

---

## 01 · Product foundation

A neutral product core keeps any single platform from becoming the product. Adapters at both edges, a canonical action model in the center. Customers review the meaning of an action once; platform adapters render it per agent ecosystem.

| Input adapters | Canonical core | Output adapters |
|---|---|---|
| OpenAPI 3.x | Actions, parameters, effects, safety, auth, recovery, evaluations, approvals, lineage | V1: MCP (Claude) + OpenAI function-calling |
| Swagger 2.0 | | V2: Meta Muse connector adapter |
| Postman Collections | | |
| Docs-led discovery | | |

### Locked product principles

- **Propose, then approve.** The service may infer and recommend. The owner decides. Nothing is published automatically.
- **Make uncertainty visible.** Low-confidence interpretations enter a review queue with evidence and impact.
- **Test the behavior, not only the schema.** Scenarios must show useful and safe outcomes.
- **Preserve provenance.** Every generated field traces back to source material, an observed call, a rule, or a customer decision.
- **Prefer automation before interruption.** Recover silently when safe; ask the end user only when their action or consent is required.
- **Manage change explicitly.** API updates create a reviewable diff and a new release candidate, never a silent production mutation.

**Product thesis:** the valuable product is not a schema converter. It is the combination of discovery, judgment capture, safe transformation, evidence, approval, and lifecycle management.

---

## 02 · Customer and problem

**Primary customer:** a platform, developer-experience, or product leader at a company with an existing REST API. Job to be done: *"Help us make our API reliably usable by an AI agent without requiring us to become experts in agent protocols, prompts, recovery behavior, or evaluation."*

**Contributing roles:** API expert (resolves behavior/error ambiguities), security reviewer (approves scopes, secrets, delegated access), product owner (selects actions and guardrails), release owner (approves and publishes).

**The gap is semantic and operational, not just syntactic:**

| Human-oriented docs | Inconsistent behavior | No proof loop |
|---|---|---|
| Developers infer intent, preconditions, and side effects from context. Agents need these made explicit. | Errors, pagination, rate limits, auth expiry, idempotency vary across APIs. | A generated connector can look correct while failing realistic user tasks or unsafe edge cases. |

**First value moment:** before generating anything, the service shows an agent-readiness inventory and gap report.

### Goals and non-goals

**V1 goals:** accept a REST API via a supported input path; produce an inventory and agent-readiness gap report; turn selected endpoints into editable canonical actions; capture customer decisions and approvals; validate behavior in a customer sandbox; produce a versioned release candidate with MCP + OpenAI artifacts; detect later API changes and focus review on deltas.

**V1 non-goals:** rebuild or host the customer's API; act as a general API gateway or integration platform; redesign business semantics without owner approval; support GraphQL, gRPC, event streams, or non-REST protocols; publish to multiple agent platforms; guarantee external marketplace acceptance; replace the customer's security/compliance review.

**Outcomes customers receive:** Clarity (inventory and gap report), Control (editable actions and approvals), Confidence (scenario report and traces), Distribution (shippable MCP + OpenAI artifacts), Maintainability (version diff and drift alerts).

---

## 03 · Customer journey

Seven stages turn source material into an approved connector release:

1. **Create and connect** — describe the product, choose an API version, submit source material, configure sandbox access.
2. **Inspect findings** — review endpoint inventory, candidate action groups, quality gaps, risk flags, confidence.
3. **Select exposure** — include, exclude, or defer endpoints; define organization-level safety rules.
4. **Resolve and edit** — answer plain-language questions; edit names, descriptions, parameters, effects, recovery, guardrails.
5. **Test in sandbox** — run normal, edge, auth, retry, safety scenarios; inspect failures; rerun affected tests.
6. **Approve and package** — review the release diff, obtain approvals, generate the v1 artifacts (MCP server bundle + OpenAI function-calling artifacts).
7. **Operate and evolve** — track releases and failures, import new API versions, review drift, retire old actions.

**Journey rule:** don't turn setup into a questionnaire. Extract first, explain what was inferred, and ask only questions whose answers change behavior, safety, or release eligibility.

| Stage | Completion condition | Customer action |
|---|---|---|
| Connected | Source parsed; sandbox checked | Confirm project scope |
| Inventoried | All operations classified | Select exposure |
| Resolved | No blocking ambiguity remains | Approve decisions |
| Evaluated | Release gates pass | Accept evidence |
| Packaged | MCP + OpenAI artifacts generated | Approve release |

---

## 04 · Inputs — "bring what you have"

Support promise with clear confidence levels:

| Input path | V1 treatment | Customer effort | Confidence |
|---|---|---|---|
| OpenAPI 3.x | Native ingest and validation | Low | Highest |
| Swagger 2.0 | Normalize, then show conversion issues | Low | High |
| Postman Collection | Infer operations from requests, examples, variables | Medium | Variable |
| Docs URL + sandbox | Guided discovery and observed behavior | Higher | Evidence-dependent |

**Always required:** product and API name, responsible project owner, selected API version or base path, at least one supported source path. **Required before evaluation:** sandbox environment, approved test data, authentication configuration, rate-limit and safety constraints.

**Import behavior:** validate file syntax with actionable errors; detect version, operations, schemas, auth definitions, examples, documented errors; preserve the original source and record a normalized snapshot; show what was ignored, unsupported, or inferred; never treat an inferred field as customer-confirmed; allow replacing/supplementing sources without losing approved decisions; show the support level before import.

### Discovery

The first output is an inventory covering: **Surface** (operations found, read vs. write, public vs. admin, deprecated items, resource groupings), **Quality** (missing descriptions, weak parameter semantics, undocumented responses, missing examples, schema inconsistencies), **Agent risk** (irreversible effects, unsafe retries, broad permissions, ambiguous errors, unbounded pagination).

Customer actions: include (creates candidate action), exclude (records reason, hides from release), defer (keeps unresolved, out of release), group (proposes one action workflow — requires explicit approval), apply policy (bulk decision with audit trail).

Readiness is not a single opaque score. If a summary score is shown, it must decompose into completeness, behavioral evidence, safety, authentication, and evaluation readiness.

### Canonical action model

Captures what an agent must understand and how it should behave:

- **Identity and intent:** stable internal id, customer/agent-facing names, purpose, eligible use and non-use, source operations and API version.
- **Inputs and outputs:** required/optional parameters, formats, constraints, defaults, examples; response fields relevant to the task; pagination and result limits.
- **Effects and safety:** read-only / mutating / destructive / financial / privacy-sensitive; preconditions and confirmation rule; idempotency and retry policy; audit and consent expectations.
- **Authentication:** required identity context and scopes; credential mode and token lifecycle; reconnect behavior.
- **Recovery behavior:** normalized condition, detection rule, automatic recovery / changed retry / user escalation / terminal failure; max attempts and backoff constraints.
- **Evidence and governance:** source citations and observed examples; confidence and unresolved questions; decision and approval history; evaluation scenarios and results.

**Action states:** Candidate → Needs decision → Approved → Tested → Released.

**Design rule:** the canonical action contains no platform-only field. Platform-specific metadata is added by the output adapter and stays traceable to the approved action version.

---

## 05 · Decisions, edits, approvals, governance

Ambiguities become focused choices with evidence, impact, and a recommendation. Example: an expired sandbox token returned `400 {"error":"bad_request"}` → recommended mapping: ACCESS_TOKEN_EXPIRED → refresh once, retry once; if recovery fails, mark connection invalid and ask the end user to reconnect (never ask them to paste a token).

**Every decision card must show:** the exact ambiguity in plain language; behavioral and safety impact; the endpoint and API version affected; alternative choices; source evidence and observed responses; whether the choice applies in bulk; the proposed answer and confidence; who can decide and who must approve.

**Customer edit controls:** action identity (name, description, examples), exposure (include/exclude/deprecate), behavior (parameters, outputs, error mapping), safety (confirmation, limits, retry rules), auth (scopes, connection UX, escalation) — each with validation.

**Guardrail:** edits must never silently change a released connector. They create a draft action version and identify which evaluations must be rerun.

**Approvals:** granular, attributable, bound to an exact release candidate. Levels: decision (accept one proposed interpretation), policy (approve an org rule applied across actions), release (approve the complete candidate for publishing). Roles: editor drafts and resolves; reviewer approves actions and test evidence; security reviewer approves auth and sensitive scopes; release approver authorizes packaging. Each approval records actor, timestamp, object version, decision. Material edits invalidate only affected approvals. Release approval is blocked by unresolved required decisions or failed gates.

**Example standing policies:** all delete actions require confirmation; writes retry only with idempotency; admin endpoints stay excluded.

---

## 06 · Versioning and connector lifecycle

API versions and connector releases are linked but not the same thing. A customer chooses an API source version; the service creates one or more connector releases from it, each preserving exact source, action, policy, approval, adapter, and evaluation lineage.

**When a new API version or spec arrives:**
1. Import a new immutable source snapshot.
2. Compare endpoints, schemas, auth, errors, descriptions, examples.
3. Classify each change: unchanged, additive, modified, removed, uncertain.
4. Approved decisions carry forward only where underlying evidence and behavior remain valid.
5. Affected actions return to draft or decision-needed state.
6. Only impacted scenarios rerun initially; the complete suite runs before packaging.
7. The owner approves a new connector release or keeps the current one.

**Lifecycle requirements:** support multiple API versions per organization; keep prior release artifacts and evidence; allow rollback to a previously approved candidate where the platform permits; show supported/deprecated/retired status; never overwrite historical approval records; prevent removal of an in-use action without impact warning.

**Open:** default support window and automatic deprecation policy belong to commercial packaging, not this draft.

---

## 07 · Evaluation, authentication, v1 release

### Evaluation

Answers: "What did the connector do under realistic conditions, and why should we trust this release?"

**Scenario families:** happy-path task completion; required and invalid parameters; authentication expiry and revocation; rate limiting and transient failure; pagination and empty results; timeout, retry, idempotency; destructive/high-impact confirmation; permission and data boundaries.

**Customer-visible evidence per scenario:** purpose and expected outcome; inputs and sandbox prerequisites; action trace and API response summary; pass/fail/blocked result; failure classification and suggested fix; action, policy, and source versions tested; rerun history and release-gate status.

**Release gates:** Contract (requests/responses conform — blocks affected action), Task (expected user outcome achieved — blocks release), Recovery (known failures produce approved behavior — blocks affected path), Safety (consent and limits enforced — blocks release), Auth (scopes and token lifecycle behave correctly — blocks release).

No false precision: distinguish "not tested" from "passed."

### Authentication — the auth bridge

Translates the customer's API authentication into a connector-compatible account connection flow without exposing raw credentials to agents or asking end users to manage tokens.

**Customer setup:** describe current auth (API key, OAuth, token exchange, scopes, test tenant, revocation); configure the connection (branding, permissions, callback, consent text, support path); verify behavior (sandbox account, expiry, refresh, revocation, insufficient scope); approve for release (security reviewer accepts the exact configuration and its test evidence).

**Required recovery semantics:**

| Condition | Preferred behavior | User experience |
|---|---|---|
| Access token expired | Refresh and retry within policy | No interruption |
| Refresh rejected | Invalidate connection | Ask user to reconnect |
| Scope missing | Do not retry blindly | Explain required permission |
| Credential revoked | Stop further calls | Reconnect or cancel |
| Unknown auth failure | Fail closed; record evidence | Clear non-secret error |

**Security boundary:** secret storage, token handling, callback ownership, identity binding, and platform approval claims require dedicated threat modeling before implementation.

### v1 output: MCP + OpenAI artifacts

MCP (for Claude) and OpenAI function-calling / GPT Actions are the v1 rendering targets, not the product's internal language. The Meta Muse connector adapter follows in v2.

**Release candidate must contain or reference:** approved action definitions and descriptions; input/output schemas; side effects, confirmation, guardrails; error-to-recovery behavior; authentication and permission configuration; connector identity and listing metadata; source and canonical model versions; evaluation evidence and release status; change notes and known limitations; artifact integrity information.

**Adapter boundary:** the core owns meaning (intent, semantics, safety, recovery, provenance, approval, tests). Each output adapter owns representation (mapping the approved release into the target platform's schemas, packaging, validation, publication). An adapter must report loss — if a target platform cannot represent a canonical behavior, the system shows the gap and blocks or requests approval for a safe fallback.

**Publishing modes:** download package (must, customer approves exact artifacts); guided submission checklist (must, customer completes portal steps); direct submission integration (conditional, separate explicit authorization); status synchronization (conditional, depends on verified platform capability).

**Do not overpromise:** v1 guarantees generation and internal validation of the MCP + OpenAI artifacts — not listing approval by any platform. The Meta Muse adapter's contract verification is a v2 gate.

---

## 08 · Product surface and functional requirements

**Seven workspaces:** Projects (APIs and releases owned), Sources (files, URLs, snapshots, parse issues), Inventory (endpoints, groups, gaps, risk, exposure), Actions (canonical action editor and provenance), Decisions (questions, evidence, impact, assignees), Evaluations (suites, runs, traces, gates), Releases (diff, approvals, package, lifecycle).

**Navigation principles:** one project-level status showing the next blocking step; work queues by role; trace everywhere (generated text → source evidence); diff before change; every update previews impact on actions, tests, and prior decisions.

**Key system states:** Draft input → Needs test → Ready to approve → Released.

| ID | Requirement | Priority |
|---|---|---|
| ING-01 | Import and validate all declared v1 source paths | Must |
| ANA-01 | Create operation inventory, gaps, risk, and confidence | Must |
| ACT-01 | Create editable, versioned canonical actions with provenance | Must |
| DEC-01 | Route blocking ambiguities into assignable decision cards | Must |
| GOV-01 | Record action, security, and release approvals | Must |
| EVA-01 | Generate, run, and report release-gating scenarios | Must |
| AUT-01 | Configure and test delegated auth and recovery behavior | Must |
| OUT-01 | Render an approved release through the v1 adapters (MCP server bundle, OpenAI function-calling artifacts) | Must |
| VER-01 | Diff new API snapshots and selectively invalidate work | Must |
| OPS-01 | Show release history, failures, and drift status | Must |
| POL-01 | Apply reusable organizational guardrails with preview | Should |
| COL-01 | Comments, assignments, and notifications | Should |
| EXT-01 | Add another output platform without changing the core model | Architecture test |

**Cross-cutting:** every artifact, mapping, decision, test, and release must be attributable to its source version and customer-approved state. The interface must support keyboard navigation, readable errors, non-color-only status, and plain-language explanations.

---

## 09 · Success, launch, risks, acceptance

**Success measures** (pilot targets set after observing real APIs): decision efficiency (blocking decisions per action, time to resolve, proposal acceptance rate), activation (project-to-import rate, time to first inventory, auto-classification share), reliability (gate pass rate by family, escaped failures after release, recovery correctness, broken actions caught pre-release), maintainability (time from source change to new candidate, approvals safely carried forward).

**Launch sequence:** Phase 0 — v1 adapter fixtures (MCP server bundle + OpenAI artifacts generated from a sample API; compatibility checks). Phase 1 — design-partner workflow (small set of varied REST APIs through import → inventory → review → sandbox eval → downloadable v1 artifacts). Phase 2 — controlled v1 (roles, repeatable approvals, version diffs, operational visibility, support boundaries). Phase 3 — Muse adapter spike and contract verification (v2).

**Top risks:** weak source material creating excessive review; unsafe inference on side effects/recovery; sandbox mismatch vs. production; credential burden expanding security scope; platform-neutral drift (hidden platform concepts leaking into the core); Muse adapter contract uncertainty (v2).

**V1 acceptance checklist:** customer can import each source path and see limitations; complete inventory and traceable gap report; customer can select, edit, approve canonical actions; unresolved blocking ambiguity prevents release; sandbox scenarios cover behavior, auth, recovery, safety; a passed release generates versioned MCP + OpenAI artifacts; the customer explicitly approves the exact artifacts; a changed API source produces a classified diff and focused re-review; historical evidence and approvals remain inspectable; a second adapter demonstrates the core does not depend on platform-specific fields.

**Open product decisions:** docs-led discovery GA vs. beta scope; which action categories require mandatory confirmation; default roles and approval policies; evidence sufficient to carry a decision forward; post-release monitoring data availability; whether v1 automates submission or only packages and guides; support and retention policies for old releases.

**Next product step:** review this PRD one section at a time, resolve the open product decisions, then derive user stories, wireframes, service boundaries, data models, and engineering milestones.
