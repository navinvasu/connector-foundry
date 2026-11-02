# Auth Bridge Design

**Project:** Connector Foundry  
**Document type:** Security architecture and implementation design  
**Version:** 1.0  
**Date:** 25 September 2026  
**Prepared for:** Naveen Vasu

> **Core rule:** Agents request capabilities; they never receive reusable credentials.

**Runtime sequence:** Policy first → narrow lease second → credential injection last.

**MVP authentication:** OAuth 2.0 Authorization Code with PKCE and static API keys.

---

## Document map

- [Broker authority; do not become the authority](#broker-authority-do-not-become-the-authority)
- [Five controls combine into one effective permission](#five-controls-combine-into-one-effective-permission)
- [Put each secret-handling step behind a narrower boundary](#put-each-secret-handling-step-behind-a-narrower-boundary)
- [Keep browser orchestration, custody, and runtime injection independent](#keep-browser-orchestration-custody-and-runtime-injection-independent)
- [Use explicit contracts before multiplying deployments](#use-explicit-contracts-before-multiplying-deployments)
- [Model authority independently from any provider or agent platform](#model-authority-independently-from-any-provider-or-agent-platform)
- [Support the common paths; reject ambiguous ones](#support-the-common-paths-reject-ambiguous-ones)
- [Default to customer-owned OAuth apps per environment](#default-to-customer-owned-oauth-apps-per-environment)
- [Turn provider setup into a reproducible security review](#turn-provider-setup-into-a-reproducible-security-review)
- [Bind every browser handoff to one single-use transaction](#bind-every-browser-handoff-to-one-single-use-transaction)
- [Commit credentials and metadata as one recoverable operation](#commit-credentials-and-metadata-as-one-recoverable-operation)
- [Policy must pass before a credential can leave the vault boundary](#policy-must-pass-before-a-credential-can-leave-the-vault-boundary)
- [Prevent a valid token from serving the wrong person](#prevent-a-valid-token-from-serving-the-wrong-person)
- [Translate OAuth scopes into tool-level least privilege](#translate-oauth-scopes-into-tool-level-least-privilege)
- [Use a vault as a security boundary, not encrypted columns as a feature](#use-a-vault-as-a-security-boundary-not-encrypted-columns-as-a-feature)
- [Serialize refresh and make every transition explicit](#serialize-refresh-and-make-every-transition-explicit)
- [Give agents safe recovery instructions, not raw OAuth errors](#give-agents-safe-recovery-instructions-not-raw-oauth-errors)
- [Attach credentials only to a reconstructed, approved destination](#attach-credentials-only-to-a-reconstructed-approved-destination)
- [Design against protocol attacks and agent-era confused deputies](#design-against-protocol-attacks-and-agent-era-confused-deputies)
- [Add stronger mechanisms only where the provider supports them end to end](#add-stronger-mechanisms-only-where-the-provider-supports-them-end-to-end)
- [Block locally first, then revoke upstream and erase safely](#block-locally-first-then-revoke-upstream-and-erase-safely)
- [Make authentication configuration reviewable without exposing secrets](#make-authentication-configuration-reviewable-without-exposing-secrets)
- [Explain the account and capability before redirecting](#explain-the-account-and-capability-before-redirecting)
- [Store lifecycle state, not secret material](#store-lifecycle-state-not-secret-material)
- [Use idempotent commands and opaque handles](#use-idempotent-commands-and-opaque-handles)
- [Make revocation fast and lifecycle processing replayable](#make-revocation-fast-and-lifecycle-processing-replayable)
- [Diagnose connections by state and reason, never by token value](#diagnose-connections-by-state-and-reason-never-by-token-value)
- [Every auth profile ships with executable evidence](#every-auth-profile-ships-with-executable-evidence)
- [Protect the broker latency path and the provider rate budget](#protect-the-broker-latency-path-and-the-provider-rate-budget)
- [Prove one delegated provider end to end before generalizing](#prove-one-delegated-provider-end-to-end-before-generalizing)
- [Own the policy model; buy undifferentiated custody primitives](#own-the-policy-model-buy-undifferentiated-custody-primitives)
- [Do not accept production credentials until these controls are proven](#do-not-accept-production-credentials-until-these-controls-are-proven)
- [Ship with explicit defaults and revisit triggers](#ship-with-explicit-defaults-and-revisit-triggers)
- [Keep four platform facts outside the auth core until verified](#keep-four-platform-facts-outside-the-auth-core-until-verified)
- [A two-tool pilot is enough to prove the auth architecture](#a-two-tool-pilot-is-enough-to-prove-the-auth-architecture)
- [Standards anchor the protocol; product choices remain explicit](#standards-anchor-the-protocol-product-choices-remain-explicit)

---

## Broker authority; do not become the authority

Connector Foundry should hold the minimum delegated credential needed to call a customer API, under a named user or service identity, and should never mint broader rights than the upstream authorization server granted.

**Auth bridge owns**

### Protocol and custody

- Provider configuration and discovery evidence.
- Authorization sessions, client registrations, token refresh, revocation, and health.
- Opaque credential handles, encrypted values, and runtime injection.
- Binding between tenant, connector, platform principal, issuer, subject, scopes, audience, and environment.

**Auth bridge does not own**

### Business authorization

- The customer's users, roles, entitlements, or source records.
- Muse's decision to ask the user for action approval.
- Tool-selection logic or application-level access checks.
- A universal token that can be replayed across customer APIs.

### The decisive architecture

Muse / caller Authenticated invocation + user context → Gateway policy Tool, effect, approval, tenant → Credential broker Resolve one connection + lease → Egress injector Attach credential to approved origin → Customer API Enforces final authorization

> **Product boundary:** OAuth is a capability ceiling, not an approval system. A token can permit a write while the current Muse task still requires explicit approval; both checks must pass.

---

## Five controls combine into one effective permission

### Effective permission

platform identity ∩ upstream grant ∩ connector release ∩ runtime policy ∩ current approval

### Non-negotiable invariants

1. A credential belongs to exactly one tenant, environment, provider profile, upstream subject, and platform-principal binding.
2. No token or key is rendered in the console, model context, trace, error, queue payload, URL, object name, or analytics event.
3. Every runtime request selects its credential by server-side identity; callers cannot submit a vault path or raw secret.
4. Issuer, audience/resource, host, scheme, and redirect URI are exact, approved values.
5. A revoked or scope-deficient connection cannot produce a lease.
6. Every write is governed by effect policy and approval independently of OAuth.

### Separation of concerns

- **Authentication:**
  - **Question answered:** Who is calling?
- **OAuth grant:**
  - **Question answered:** What may this client do upstream?
- **Connector policy:**
  - **Question answered:** Which tools may be exposed?
- **Approval:**
  - **Question answered:** May this action run now?
- **Upstream ACL:**
  - **Question answered:** May this subject touch this object?

> **Fail closed:** missing identity, ambiguous account binding, unknown issuer, extra scope, stale consent, unavailable vault, or unverified destination stops the call. The agent receives a stable recovery reason, not protocol internals.

---

## Put each secret-handling step behind a narrower boundary

### Actors and trust zones

**External**

### Muse and browsers

Present signed caller context and complete redirects. They never choose credential storage locations or upstream token endpoints.

**Customer**

### Authorization + API

Issue grants, authenticate users, enforce source permissions, and expose revocation or discovery where supported.

**Foundry**

### Control + runtime

Curate tools, broker grants, enforce local policy, inject credentials, and retain redacted evidence.

### Four trust boundaries

- **Public edge → control:**
  - **Allowed crossing:** Signed session, auth transaction ID
  - **Prohibited crossing:** Raw provider secrets in UI payloads
- **Control → vault:**
  - **Allowed crossing:** Secret write/read by opaque handle
  - **Prohibited crossing:** Search, list-all, or plaintext export
- **Gateway → broker:**
  - **Allowed crossing:** Tenant-bound lease request
  - **Prohibited crossing:** Caller-selected vault reference
- **Injector → upstream:**
  - **Allowed crossing:** Credential on approved HTTPS origin
  - **Prohibited crossing:** Forward across unapproved redirect

> **Preferred steady state:** the gateway receives only a lease handle; an isolated egress injector reads the secret, applies the approved authentication scheme, sends the request, and returns a scrubbed response. The MVP may expose the secret to gateway process memory, but never beyond that process or request lifetime.

### Data classes

**Restricted:** access tokens, refresh tokens, API keys, client secrets, private keys. **Confidential:** upstream subject, scope set, issuer, connection state. **Operational:** opaque IDs, timestamps, error classes, latency. Different retention and access policies apply.

---

## Keep browser orchestration, custody, and runtime injection independent

### Public edge

Console session
OAuth start
Exact callback
Platform webhook

### Auth control service

Profiles
Transactions
Connections
Scope policy

### Lifecycle workers

Refresh
Revocation
Discovery validation
Health checks

---

### Runtime trust domain

Gateway
Credential broker
Egress injector
Policy cache

### Protected state

PostgreSQL metadata
Vault / KMS
Redis locks
Audit ledger

### Customer systems

Authorization server
Resource server
Revocation
Introspection

### Deployment recommendation

### MVP shape

A modular auth-control application handles profiles, setup, redirects, and connection metadata. A separate broker is the only component with vault-read permission. Refresh workers use a distinct workload role. Gateway and broker run in private subnets across two zones.

### Extraction triggers

Separate provider adapters when release cadence diverges; isolate refresh workers when volume creates lock contention; introduce a dedicated egress injector when secret exposure inside the gateway becomes the dominant threat or compliance blocker.

### Connectivity rules

- Browser callbacks reach only the auth-control edge; token exchange occurs server to server.
- Discovery and token endpoints are fetched through a constrained outbound proxy with DNS and redirect revalidation.
- Vault and KMS have no public route. Console and general workers have write-only capture or metadata access.
- Runtime and control-plane workload identities are separate; production credentials cannot be used from evaluation workers.

---

## Use explicit contracts before multiplying deployments

- **Auth Profile Manager:**
  - **Responsibility:** Versioned provider configuration, discovery snapshot, scope catalog
  - **Privileged access:** Metadata only
- **OAuth Flow Orchestrator:**
  - **Responsibility:** Start/callback, PKCE, state, code exchange, account confirmation
  - **Privileged access:** Vault write; no later reads
- **Connection Service:**
  - **Responsibility:** Bindings, states, scope snapshots, reauth and disconnect
  - **Privileged access:** Credential handles only
- **Token Lifecycle Worker:**
  - **Responsibility:** Refresh, rotation detection, proactive expiry handling, revoke
  - **Privileged access:** Scoped vault read/write
- **Runtime Credential Broker:**
  - **Responsibility:** Authorize lease request and resolve current credential version
  - **Privileged access:** Scoped vault read
- **Egress Injector:**
  - **Responsibility:** Apply header/query/signature and call approved upstream
  - **Privileged access:** Secret in memory only
- **Provider Adapter:**
  - **Responsibility:** Normalize provider quirks behind tested interface
  - **Privileged access:** No generic listing
- **Audit Sink:**
  - **Responsibility:** Append redacted security and lifecycle events
  - **Privileged access:** No secret payload

### Control API owns transactions

Any operation that changes profile, grant, secret, or connection state commits metadata and an outbox event atomically. Workers consume at least once and deduplicate by event ID.

### Broker owns the fast path

Its request is small: caller identity, tenant, environment, tool, audience, minimum scopes, and deadline. It never accepts arbitrary endpoint or secret-reference fields.

> **Monolith boundary:** Profile Manager, Flow Orchestrator, and Connection Service may ship as modules in one process. The broker and vault-facing lifecycle workers remain separate workloads from day one.

---

## Model authority independently from any provider or agent platform

```
AuthProfileVersion {
  tenant_id, project_id, environment_id,
  issuer, endpoints_snapshot_hash,
  client_registration_ref, grant_type,
  token_endpoint_auth_method,
  requested_scopes[], resources[],
  subject_binding_strategy,
  credential_injection,
  redirect_policy, refresh_policy,
  status, created_by, approved_by
}
```

### Stable identifiers

- **profile_version_id:** immutable configuration used to create a grant.
- **connection_id:** logical end-user or service connection.
- **grant_id:** one authorization grant lineage.
- **credential_handle:** opaque vault locator, never caller-provided.
- **token_version:** monotonic counter for compare-and-swap refresh.
- **principal_binding_id:** links platform and upstream subjects.

### Immutable grant snapshot

- Issuer and client ID fingerprint.
- Granted scopes and resource/audience.
- Upstream subject hash and optional display label.
- Grant time, expiry metadata, and consent version.
- Sender-constrained key reference if used.
- Profile version and connector release that initiated the flow.

> **Migration rule:** a profile edit never mutates existing grants silently. Classify the change as metadata-only, compatible, scope-expanding, issuer/client-changing, or credential-format-changing. The last three require explicit reauthorization or a controlled migration.

---

## Support the common paths; reject ambiguous ones

- **OAuth Authorization Code + PKCE:**
  - **Identity represented:** End user
  - **MVP:** YES
  - **Policy:** Default delegated flow
- **Static API key:**
  - **Identity represented:** Tenant/service
  - **MVP:** YES
  - **Policy:** Explicit non-user label
- **OAuth client credentials:**
  - **Identity represented:** Service client
  - **MVP:** LIMITED
  - **Policy:** No user impersonation
- **private_key_jwt:**
  - **Identity represented:** OAuth client
  - **MVP:** NEXT
  - **Policy:** Prefer over shared secret when available
- **Token exchange:**
  - **Identity represented:** Subject + actor
  - **MVP:** LATER
  - **Policy:** Only if upstream AS supports it
- **DPoP / mTLS:**
  - **Identity represented:** Sender-bound token
  - **MVP:** LATER
  - **Policy:** High-assurance profile
- **Cookie/session scraping:**
  - **Identity represented:** Browser session
  - **MVP:** NO
  - **Policy:** Outside connector auth
- **Password grant / implicit:**
  - **Identity represented:** Legacy
  - **MVP:** NO
  - **Policy:** Deprecated/insecure pattern

### Adapter interface

```
discover(profile) -> validated_metadata
buildAuthorizationRequest(txn) -> redirect
exchangeCode(txn, callback) -> credential_material
refresh(connection, token_version) -> rotated_material
revoke(connection) -> provider_result
normalizeError(response) -> stable_auth_reason
```

The interface normalizes quirks without weakening protocol checks. A provider override may alter parameter names, authentication method, or error parsing; it may not disable issuer binding, state validation, exact redirect matching, PKCE, host controls, or secret redaction.

> **Rule:** if a provider cannot meet the baseline safely, mark the profile unsupported. Do not bury an insecure fallback behind a configuration switch.

---

## Default to customer-owned OAuth apps per environment

**Recommended**

### Dedicated app

Customer registers one OAuth client for staging and one for production. Consent branding, provider quotas, domain verification, revocation, and incident blast radius stay customer-specific.

**Selective**

### Shared platform app

Useful for common SaaS providers when the provider permits it. Faster onboarding, but Foundry owns consent branding, provider review, quotas, and a larger blast radius.

**Optional**

### Dynamic registration

Use only with an explicitly trusted registration endpoint and onboarding policy. Dynamic capability is not automatic trust.

### Registration record

- **client_id:**
  - **Storage:** Metadata database
  - **Validation:** Bound to issuer + environment
- **client_secret / private key:**
  - **Storage:** Vault only
  - **Validation:** Capture confirmation; never display
- **redirect URIs:**
  - **Storage:** Immutable profile version
  - **Validation:** Exact HTTPS values
- **auth method:**
  - **Storage:** Profile version
  - **Validation:** Must match server metadata
- **owner + contacts:**
  - **Storage:** Metadata database
  - **Validation:** Required for production
- **rotation deadline:**
  - **Storage:** Metadata database
  - **Validation:** Alert and block expired material

> **Environment isolation:** staging and production never share client secrets, redirect URIs, token stores, DPoP keys, service identities, or connection records. Promotion copies reviewed configuration only.

---

## Turn provider setup into a reproducible security review

**Step 1 — Select identity mode:** Choose end-user delegated OAuth or tenant service identity; state which tools use it.

**Step 2 — Bind issuer and resources:** Enter an issuer or approved metadata URL, plus exact resource-server origins.

**Step 3 — Inspect discovery:** Fetch through constrained egress; verify HTTPS, issuer equality, endpoints, PKCE, auth methods, and algorithms.

**Step 4 — Register the client:** Show exact redirect URIs; capture secret or private-key reference directly into the vault.

**Step 5 — Map scopes to tools:** Prove every requested scope is required; flag scope expansion as a review event.

**Step 6 — Test with a sandbox account:** Run connect, refresh, denied consent, expired grant, revoke, and one authorized API call.

**Step 7 — Security approval:** Approve hosts, scopes, auth method, secret owner, retention, and production environment.

**Step 8 — Freeze a profile version:** Publish an immutable auth snapshot with the connector release.

> **Evidence retained:** metadata hash, TLS hostname, discovery time, issuer comparison, endpoints selected, supported methods, requested scopes, test outcomes, reviewers, and profile version. Do not retain fetched credentials or authorization responses.

---

## Bind every browser handoff to one single-use transaction

Muse / user: 1. Request connection for connector + account → 4. Authenticate and consent at provider → 9. Confirm connected account

Foundry edge: 2. Authenticate platform principal → 3. Create transaction; redirect → 5. Receive exact callback

Auth control: 6. Verify state, issuer, code, TTL, one-time use → 8. Bind subject + grant snapshot

Provider: Authorization endpoint → 7. Code exchange with PKCE → Optional userinfo / probe

Vault: Store token set under new opaque handle → Return status only

### Authorization transaction contents

```
{ transaction_id, tenant_id, platform_principal_id,
  profile_version_id, connector_release_id,
  redirect_uri_id, state_hash, pkce_verifier_handle,
  nonce_hash?, requested_scopes_hash, resource_hash,
  expected_issuer, expires_at, consumed_at? }
```

- Generate high-entropy state and a fresh PKCE verifier for every attempt; persist only protected values with a short time to live.
- Require S256. Reject unknown or repeated state, mismatched issuer, unexpected redirect, duplicate callback, missing code, or callback after expiry.
- Exchange the code on the server. The browser never receives access or refresh tokens.

---

## Commit credentials and metadata as one recoverable operation

### Callback algorithm

```
1  Resolve transaction by state hash; lock row
2  Verify unexpired, unconsumed, tenant-bound, issuer-bound
3  Mark callback received; reject any replay
4  Redeem code with exact redirect URI + PKCE verifier
5  Validate token response type, issuer/audience where applicable
6  Derive upstream subject from verified ID token/userinfo/probe
7  Write credential material to a new vault version
8  Commit connection + grant snapshot + vault handle + outbox event
9  Mark transaction consumed; return opaque connection status
```

### If vault write succeeds but DB commit fails

Record the provisional handle under transaction ownership and enqueue garbage collection after the transaction TTL. It is unreachable from runtime until metadata commits.

### If DB commit succeeds but response fails

The client repeats the status lookup by transaction ID. Callback replay remains rejected; no second grant is created.

### If subject cannot be established

Do not activate. Hold the credential in a short-lived quarantined handle, show account-verification failure, then revoke and delete.

### If scopes are narrower

Create a restricted connection only when all enabled tools remain valid; otherwise require consent again with a clear missing-scope list.

> **Idempotency:** the callback's idempotency key is the authorization transaction ID, not the code. A successful transaction returns the same connection status on safe status retries but never redeems twice.

---

## Policy must pass before a credential can leave the vault boundary

Gateway: 1. Validate platform assertion → 2. Resolve release + tool → 3. Ask policy → 8. Send via injector

Policy: Tenant + principal → Effect + approval → Scope + destination

Broker: 4. Select connection server-side → 5. Check state/expiry/scopes/audience → 6. Refresh if needed

Vault: 7. Read current version into protected memory → Audit access by workload + purpose

Upstream: 9. Receive credential only on approved origin → 10. Enforce subject authorization

### Lease request

```
POST /internal/credential-leases
{ tenant_id, platform_principal_id, connection_id,
  release_id, tool_id, audience, minimum_scopes[],
  approval_receipt_id?, request_digest, deadline }
```

The response is preferably an opaque lease handle usable once by the egress injector. If the MVP returns material to the gateway, return it only over mutual TLS, bind it to the caller workload and request digest, cap its lifetime below the request deadline, and keep it out of heap dumps and diagnostics.

---

## Prevent a valid token from serving the wrong person

### Binding key

tenant + connector + environment + platform issuer + platform subject + upstream issuer + upstream subject

### Binding rules

- Use stable, signed platform subject claims when available; do not bind by email alone.
- Namespace upstream subjects by issuer. The same **sub** from two issuers is not the same account.
- If upstream identity uses organization context, bind organization ID and verify it on every probe or token claim.
- Hash stable subject identifiers for routine lookup; encrypt display labels separately.
- Require an explicit replacement flow to connect a different upstream account.

- **Same user, same account:**
  - **Action:** Reuse active connection
- **Same user, new scopes:**
  - **Action:** New grant snapshot
- **Same user, other account:**
  - **Action:** Confirm replacement/addition
- **Changed platform subject:**
  - **Action:** No automatic transfer
- **Upstream subject changed:**
  - **Action:** Quarantine + reauthorize
- **Tenant membership removed:**
  - **Action:** Block leases immediately

> **Confused-deputy defense:** never infer a connection from a customer-supplied email, a tool argument, conversation text, or provider display name. Connection selection comes from authenticated platform context and server-side bindings.

### When Muse identity claims are insufficient

Use a one-time connection link tied to the authenticated Foundry account, then require the user to confirm the upstream account label after OAuth. Keep the Muse adapter behind an interface until Meta documents stable caller identity, callback routing, disconnect events, and connection ownership.

---

## Translate OAuth scopes into tool-level least privilege

User jobs What outcomes are needed? → Tools Which actions implement them? → Operations Which upstream routes? → Scopes Minimum provider grants

- **Read:**
  - **Example capability:** Search tickets
  - **Auth policy:** Read scope only
  - **Runtime approval:** Per Muse setting
- **Write, reversible:**
  - **Example capability:** Add draft note
  - **Auth policy:** Narrow write scope
  - **Runtime approval:** Usually required
- **External communication:**
  - **Example capability:** Send reply
  - **Auth policy:** Send scope
  - **Runtime approval:** Explicit approval
- **Financial / destructive:**
  - **Example capability:** Refund or delete
  - **Auth policy:** Dedicated scope if available
  - **Runtime approval:** Strongest gate

### Compile-time checks

- Every enabled tool declares required scopes, resource/audience, effect class, and whether user identity is required.
- The compiler calculates the union for connection consent, but the runtime checks the minimum set for the selected tool.
- A release that adds scopes is a breaking auth change: existing connections become **limited** until users grant the delta.
- Where the provider supports Rich Authorization Requests, encode resource/action details; otherwise keep local constraints and request the narrowest scopes available.[8]

> **No privilege synthesis:** local policy can narrow an upstream grant but cannot make it broader. Token exchange is used only when the customer's authorization server explicitly supports the desired delegation semantics.[7]

---

## Use a vault as a security boundary, not encrypted columns as a feature

**Database**

### References only

Credential handle, version, type, expiry, scope hash, issuer, subject hash, state, and audit pointers.

**Vault**

### Secret values

Access/refresh tokens, API keys, client secrets, private keys, PKCE verifier while active, and sender-constraining keys.

**KMS / HSM**

### Key protection

Root key material, envelope operations, signing keys, rotation policy, and workload authorization.

### Vault path semantics

```
opaque_handle -> {
  tenant_partition, environment, connection_id,
  credential_type, secret_version, created_at,
  expires_at?, previous_version_grace?, material...
}
```

### Access policy

- Write-once capture capability for the OAuth orchestrator.
- Read/update for lifecycle workers, scoped to assigned tenant shards.
- Read-only single-object access for the runtime broker.
- No UI, support, analytics, importer, compiler, or evaluator access to production secrets.

### Operational controls

- Envelope encryption with tenant/environment context as authenticated data.
- Automatic key-version rotation and rewrap without decrypting to application storage.
- Secret-access audit with workload, purpose, connection, and request correlation.
- Break-glass disabled by default; dual approval and time-limited when enabled.

> **Backups:** encrypted backup is still credential-bearing data. Test restore into an isolated environment with separate keys and prove that restored production handles cannot be used from staging.

---

## Serialize refresh and make every transition explicit

ACTIVE Usable grant → REFRESHING One lease owner → ACTIVE New version committed

ACTIVE → DEGRADED Transient provider failure → REAUTH_REQUIRED invalid_grant / revoked → REVOKED User/admin disconnect

### Refresh algorithm

1. Read metadata. If access token remains valid beyond request deadline plus safety skew, continue.
2. Acquire a short per-connection distributed lock or database advisory lock; re-read token version.
3. If another worker already refreshed, use the newer version. Otherwise call the token endpoint once.
4. Write the complete returned token set as a new vault version. If refresh-token rotation omits a new refresh token, retain the existing one according to provider semantics.
5. Compare-and-swap metadata from old token version to new; retire old material after a bounded grace window.
6. On **invalid_grant**, mark reauthorization required. On transient failure, back off with jitter without extending the caller deadline.

> **Concurrency rule:** only one refresh may consume a rotating refresh token. Any competing request waits briefly, then uses the committed version or returns a stable temporary-auth error.

RFC 9700 recommends sender-constrained refresh tokens or refresh-token rotation for public clients and least-privilege, audience-restricted access tokens.[3]

---

## Give agents safe recovery instructions, not raw OAuth errors

- **AUTH_CONNECTION_MISSING:**
  - **Typical cause:** No bound connection
  - **Runtime behavior:** Ask user to connect
- **AUTH_REAUTH_REQUIRED:**
  - **Typical cause:** Revoked/expired refresh grant
  - **Runtime behavior:** Stop; present reauth action
- **AUTH_SCOPE_INSUFFICIENT:**
  - **Typical cause:** Release requires new scope
  - **Runtime behavior:** Stop; name capability, not secret
- **AUTH_TEMPORARILY_UNAVAILABLE:**
  - **Typical cause:** Vault/token endpoint transient
  - **Runtime behavior:** Retry only within safe budget
- **AUTH_POLICY_DENIED:**
  - **Typical cause:** Principal/effect/approval failed
  - **Runtime behavior:** Do not retry automatically
- **AUTH_CONFIGURATION_ERROR:**
  - **Typical cause:** Issuer/client/redirect mismatch
  - **Runtime behavior:** Disable profile; alert admin
- **AUTH_ACCOUNT_MISMATCH:**
  - **Typical cause:** Unexpected upstream subject/org
  - **Runtime behavior:** Quarantine and confirm account
- **AUTH_OUTCOME_UNKNOWN:**
  - **Typical cause:** 401 after possible write
  - **Runtime behavior:** Do not replay; reconcile first

### 401/403 decision tree

### 401 from upstream

For a read or idempotent write, perform at most one refresh and one retry if policy and deadline allow. For a non-idempotent write, do not replay unless the upstream supports an idempotency key and status reconciliation.

### 403 from upstream

Do not refresh blindly. Classify missing scope, upstream role/ACL denial, wrong tenant/account, resource restriction, or policy. Preserve the upstream as the final authority.

> **Error hygiene:** sanitize provider descriptions; never return tokens, codes, client identifiers that are treated as confidential, raw response bodies, vault paths, or internal hostnames. Correlation ID plus stable reason is enough for the agent.

---

## Attach credentials only to a reconstructed, approved destination

### Secure request construction

Tool mapping Method + path template → Environment Immutable base URL → Validator Host, scheme, port, resolved IP → Injector Header/query/signature → Transport TLS + redirect policy

### Before injection

- Construct the URL from release configuration, never from a model-provided absolute URL.
- Allow HTTPS only; pin approved host, port, and optional path prefix.
- Resolve DNS and reject loopback, link-local, metadata, private, and disallowed ranges unless explicitly private-networked.
- Validate audience/resource and minimum scopes against the grant snapshot.
- Strip caller-supplied authorization, cookie, proxy, forwarding, and host headers.

### During and after send

- Attach credentials at the final possible hop.
- Disable redirects by default; if enabled, revalidate every target and never forward authorization cross-origin.
- Bound body size, decompression ratio, timeout, and response headers.
- Scrub secrets and configured sensitive fields before trace capture.
- Record destination policy ID and credential version, not material.

> **Injection modes:** bearer header, API-key header, fixed query parameter only when unavoidable, HTTP Basic from vaulted parts, mTLS certificate reference, or provider-specific signature plug-in. Each is declared in the immutable profile.

---

## Design against protocol attacks and agent-era confused deputies

- **Authorization-server mix-up:**
  - **Prevent:** Issuer-bound transaction; exact metadata and callback validation
  - **Detect:** Issuer mismatch events
- **Code interception/injection:**
  - **Prevent:** PKCE S256; one-time state; server-side exchange
  - **Detect:** Replay and verifier failures
- **Redirect hijack:**
  - **Prevent:** Exact pre-registered HTTPS redirect
  - **Detect:** Unexpected callback URI
- **CSRF/login swapping:**
  - **Prevent:** State bound to user session and transaction
  - **Detect:** Principal/session mismatch
- **Cross-tenant credential use:**
  - **Prevent:** Tenant-context vault policy; server-side handle selection
  - **Detect:** Isolation canaries and denied reads
- **SSRF / token forwarding:**
  - **Prevent:** Approved origins; DNS checks; no cross-origin auth redirect
  - **Detect:** Egress denials by policy ID
- **Refresh-token replay:**
  - **Prevent:** Single-flight rotation; version CAS; sender constraint when available
  - **Detect:** invalid_grant burst / reuse signal
- **Scope drift:**
  - **Prevent:** Immutable grant snapshot; release delta gate
  - **Detect:** Granted/requested mismatch
- **Prompt-driven account swap:**
  - **Prevent:** Arguments cannot select connections
  - **Detect:** Binding mismatch
- **Secret leakage:**
  - **Prevent:** Vault isolation; redaction; no body capture
  - **Detect:** Canary secrets + scanner

> **Trust no fetched configuration:** provider metadata is untrusted input. Apply size/time limits, validate endpoint origins and issuer equality, cache a reviewed snapshot, and require approval for security-relevant changes.

RFC 9700 requires exact redirect matching, defenses against mix-up and CSRF, and recommends sender-constrained tokens where feasible.[3] DPoP and mutual TLS are standardized options for sender constraint.[5][6]

---

## Add stronger mechanisms only where the provider supports them end to end

### DPoP

Generate a per-connection asymmetric key in KMS/HSM-backed storage; include a signed proof for token and resource requests; validate provider nonce behavior; rotate keys through reauthorization if binding cannot migrate. This limits replay of a stolen token but does not replace endpoint validation.[5]

### Mutual TLS

Use a certificate-bound client identity or access token when the authorization and resource servers support it. Keep certificates per customer/environment, automate renewal, and route through an egress tier that can present the correct certificate.[6]

### Pushed Authorization Requests

Where supported, push authorization parameters directly to the server and send only a request URI through the browser. This reduces front-channel exposure and tampering.[9]

### Token exchange

Use an upstream security token service to obtain audience- and actor-specific tokens. Preserve subject and actor semantics; do not simulate exchange by copying claims into a self-issued token.[7]

### Adoption gate

- **DPoP:**
  - **Require before enabling:** Metadata support, replay cache, nonce tests, key recovery plan
- **mTLS:**
  - **Require before enabling:** Certificate lifecycle, SNI routing, provider conformance tests
- **PAR:**
  - **Require before enabling:** Discovered endpoint, client auth, request URI expiry handling
- **Token exchange:**
  - **Require before enabling:** Documented issuer policy, audience, actor semantics, least privilege

> **MVP posture:** design interfaces for these modes but do not claim support until one provider passes protocol, failure, rotation, and interoperability tests.

---

## Block locally first, then revoke upstream and erase safely

### Disconnect sequence

1. Authorize User/admin owns connection → 2. Tombstone State = revoking → 3. Purge cache No new leases → 4. Revoke Refresh then access token → 5. Destroy Vault versions deleted

### Synchronous guarantees

- Connection state changes transactionally.
- Lease issuance is denied immediately.
- Runtime caches receive a high-priority invalidation event.
- New work fails with **AUTH_REAUTH_REQUIRED** or **AUTH_POLICY_DENIED**.

### Asynchronous guarantees

- Attempt provider revocation when supported.
- Retry bounded transient failures; never reactivate locally.
- Delete token material after provider attempt or policy timeout.
- Keep only redacted tombstone and audit evidence.

### Incident controls

- **One connection:**
  - **Kill switch:** Revoke + cache purge
  - **Recovery:** User reauthorizes
- **One provider profile:**
  - **Kill switch:** Disable new leases
  - **Recovery:** Reapprove profile version
- **One tenant:**
  - **Kill switch:** Suspend auth partition
  - **Recovery:** Security-admin release
- **One runtime cell:**
  - **Kill switch:** Drain + revoke workload identity
  - **Recovery:** Redeploy from clean image
- **Potential key compromise:**
  - **Kill switch:** Rotate KMS/client key; revoke grants
  - **Recovery:** Controlled reconnect campaign

> **Upstream uncertainty:** a successful local disconnect does not prove immediate upstream revocation. Show both statuses and never continue using the credential.

---

## Make authentication configuration reviewable without exposing secrets

Support Connector / AuthenticationStaging · Profile v4

Overview

API source

Tools

Authentication

Policies

Evaluate

Publish

**Provider**

### OAuth 2.0

Issuer verified

**Client**

### Configured

Secret in vault

**Test**

### 7 / 8

Revocation failed

### Release blockers

**BLOCKER** Production redirect URI not registered

**REVIEW** Scope **tickets.write** added since v3

### Endpoints

Issuer, authorization, token, revocation
Discovery snapshot: reviewed 18 min ago

**HOSTS APPROVED**

### Client credential

Version 3 · rotated 42 days ago
Value cannot be displayed

**Replace secret**

### Scopes mapped to 8 tools

tickets.read · tickets.write · users.read

**Run auth test suite**

> **UX rule:** display fingerprints, versions, ownership, age, test evidence, and next actions. Never offer “reveal secret.” Replacement writes a new version and verifies it before retirement of the old one.

---

## Explain the account and capability before redirecting

### Connect screen

**Connect Acme Support**

### What this enables

- Search tickets and read ticket details.
- Create internal notes after approval.
- Send customer replies only with explicit approval.

You will sign in at Acme. Connector Foundry stores the delegated credential securely; Muse does not receive it.

**Continue to Acme**

### After callback

### Connected as J. Smith

Organization: Acme North America
Capabilities: 3 granted · 0 missing

**READY**

### Recovery states

### Permission update needed

This connector added the ability to create internal notes. Existing read access still works. Reconnect to enable the new action.

**Review new access**

### Connection expired

Acme no longer accepts this grant. Sign in again; no action was attempted.

**Reconnect**

### Wrong account?

Replace the current account only after confirming the displayed organization and account label. Existing access stays active until the replacement succeeds.

> **Muse alignment:** public Meta guidance says users choose connectors, can disconnect them, and can configure approval behavior for connector actions.[1][2] Foundry should expose capability and connection state clearly, while treating exact platform callback and identity contracts as integration-specific.

---

## Store lifecycle state, not secret material

- **auth_profile_version:**
  - **Key fields:** tenant, env, issuer, config hash
  - **Notes:** Immutable after approval
- **client_registration:**
  - **Key fields:** profile, client ID, vault handle
  - **Notes:** Secret value absent
- **auth_transaction:**
  - **Key fields:** principal, state hash, PKCE handle, TTL
  - **Notes:** Single-use; short retention
- **principal_binding:**
  - **Key fields:** platform issuer/subject, upstream issuer/subject
  - **Notes:** Tenant-scoped identity link
- **connection:**
  - **Key fields:** principal binding, state, current grant
  - **Notes:** Logical relationship
- **grant_snapshot:**
  - **Key fields:** issuer, subject hash, scopes, resource
  - **Notes:** Immutable evidence
- **credential_version:**
  - **Key fields:** handle, version, expiry, status
  - **Notes:** No token bytes
- **scope_mapping:**
  - **Key fields:** release, tool, required scopes
  - **Notes:** Compile-time policy
- **revocation_job:**
  - **Key fields:** connection, reason, attempts
  - **Notes:** Never reactivates
- **auth_audit_event:**
  - **Key fields:** actor, action, reason, correlation
  - **Notes:** Append-only, redacted

### Database constraints that matter

- Unique active connection for the configured binding cardinality; allow multiple accounts only when the product explicitly supports account selection.
- Foreign keys include tenant ID or are enforced through composite keys and row-level policy.
- Credential version increments monotonically; compare-and-swap prevents stale refresh commits.
- Profile approval and production activation require different principals when separation of duties is enabled.
- Tombstoned connections cannot transition back to active; reconnect creates a new grant lineage.

> **Retention default:** delete auth transactions quickly after completion; keep grant metadata and security audit according to tenant policy; destroy credential material on disconnect. Production response bodies are not part of this model.

---

## Use idempotent commands and opaque handles

### Customer-facing control API

```
POST /v1/auth-profiles
POST /v1/auth-profiles/{id}/validate
POST /v1/auth-profiles/{id}/approve
POST /v1/connections/start
GET  /v1/auth-transactions/{id}
POST /v1/connections/{id}/disconnect
GET  /v1/connections/{id}/health
```

### Privileged internal API

```
POST /internal/credential-leases
POST /internal/leases/{id}/send
POST /internal/connections/{id}/refresh
POST /internal/connections/{id}/revoke
POST /internal/runtime/invalidations
```

### Command requirements

- **Identity:**
  - **Contract:** Workload identity + signed tenant/principal context
- **Idempotency:**
  - **Contract:** Required on create/start/disconnect/refresh commands
- **Concurrency:**
  - **Contract:** ETag or expected_version on mutable resources
- **Secrets:**
  - **Contract:** Dedicated capture channel; never normal JSON response
- **Errors:**
  - **Contract:** Stable reason, retryability, user action, correlation ID
- **Deadlines:**
  - **Contract:** Caller deadline propagated; no hidden extension

> **Internal is not trusted by location:** broker endpoints require mTLS workload identity, explicit audience, authorization policy, and tenant-bound claims. Network placement is defense in depth, not authentication.

---

## Make revocation fast and lifecycle processing replayable

- **auth.profile.published:**
  - **Consumers:** Release gate, cache builder
  - **Guarantee:** Transactional outbox
- **auth.connection.created:**
  - **Consumers:** UI, gateway cache, audit
  - **Guarantee:** Ordered per connection
- **auth.connection.reauth_required:**
  - **Consumers:** UI, release readiness
  - **Guarantee:** Replayable
- **auth.connection.revoking:**
  - **Consumers:** Runtime cache
  - **Guarantee:** High priority
- **auth.connection.revoked:**
  - **Consumers:** UI, deletion worker
  - **Guarantee:** Terminal
- **auth.credential.rotated:**
  - **Consumers:** Health, audit, old-version GC
  - **Guarantee:** Versioned
- **auth.lease.denied:**
  - **Consumers:** Security analytics, audit
  - **Guarantee:** Reason-coded

### Consistency choices

- Connection activation requires both vault write and durable metadata reference.
- Local revoke wins over stale caches; broker checks a short-lived revocation epoch.
- Profile changes propagate by version, never in-place cache mutation.
- Audit delivery may lag, but inability to enqueue security-critical audit blocks the action.

### Event hygiene

- Carry opaque IDs, states, timestamps, reason codes, and hashes.
- Never carry token endpoint payloads, codes, PKCE verifiers, tokens, keys, or authorization headers.
- Partition by tenant and connection for ordering.
- Dead-letter queues retain sanitized payloads only.

> **Revocation epoch:** increment a tenant or connection epoch on suspension. A cached lease or policy result with an older epoch is rejected, providing a fast local kill switch even before every cache invalidation arrives.

---

## Diagnose connections by state and reason, never by token value

Availability — Lease success — By tenant, provider, profile, cell

Lifecycle — Refresh health — Success, latency, invalid_grant

Security — Denied access — Policy, scope, issuer, destination

### Metrics

- Authorization starts, callbacks, completions, denials, expirations.
- Active, limited, degraded, reauth-required, and revoked connections.
- Credential-lease p50/p95/p99 and vault dependency latency.
- Refresh attempts, single-flight wait, rotation, and failures.

- Scope mismatch and account-binding failures.
- Revocation propagation and upstream completion latency.
- Provider 401/403/429 rates and auth configuration errors.
- Secret-scanner findings, canary access, and redaction drops.

### Redacted trace

```
correlation_id: req_...
tenant_id: t_...       connection_id: c_...
profile_version: apv_4  credential_version: 17
tool_id: create_note    effect: reversible_write
policy: allow           approval_receipt: present
lease: issued           refresh: not_needed
upstream_origin_id: origin_2
result: 201             auth_reason: none
```

> **Never label raw HTTP capture as “debug only.”** Authorization headers, cookies, query credentials, codes, token responses, userinfo, and arbitrary upstream bodies must be structurally excluded or redacted before serialization.

---

## Every auth profile ships with executable evidence

### Test layers

- **Static validation:**
  - **Examples:** HTTPS endpoints, exact issuer, redirect set, supported methods
  - **Release gate:** Hard
- **Protocol fixture:**
  - **Examples:** PKCE, state, denied consent, callback replay, token rotation
  - **Release gate:** Hard
- **Provider sandbox:**
  - **Examples:** Real connect, refresh, revoke, account probe
  - **Release gate:** Hard for profile
- **Isolation:**
  - **Examples:** Cross-tenant handle, wrong principal, wrong environment
  - **Release gate:** Hard
- **Egress adversarial:**
  - **Examples:** SSRF, DNS rebinding, redirect, header injection
  - **Release gate:** Hard
- **Runtime scenario:**
  - **Examples:** Read, approved write, denied write, expired token
  - **Release gate:** Hard
- **Resilience:**
  - **Examples:** Vault outage, token timeout, concurrent refresh, queue replay
  - **Release gate:** Threshold

### Deterministic assertions

No credential in traces; exact state and issuer checks; one code redemption; correct scope set; one refresh winner; no replay of ambiguous writes; revoked connections issue zero leases.

### Harness integration

The existing evaluation coordinator requests named fixture identities and connection states. It receives opaque handles and redacted events, then grades tool selection, approval behavior, execution, and recovery without learning credential values.

> **Promotion rule:** a connector release cannot activate against an auth profile version unless the profile's conformance suite and the release's auth-dependent scenarios passed against the same immutable configuration.

---

## Protect the broker latency path and the provider rate budget

### Proposed service objectives

- **Broker availability:**
  - **Initial target:** 99.95% monthly
- **Lease decision p95:**
  - **Initial target:** <150 ms*
- **Revocation block:**
  - **Initial target:** <5 sec p95
- **Cache invalidation:**
  - **Initial target:** <30 sec p95
- **Refresh success:**
  - **Initial target:** >99.5%*
- **RPO / RTO metadata:**
  - **Initial target:** 15 min / 2 hr

\* Excludes upstream authorization-server latency and provider-caused failures. Validate with design partners before contractualizing.

### Capacity model

- Lease requests scale with connector calls; partition by tenant and runtime cell.
- Refresh load depends on active connections divided by access-token lifetime, not request rate alone.
- Use proactive refresh jitter to avoid expiry cliffs, but refresh only active connections with recent use.
- Cache non-secret profile metadata and connection state briefly; do not cache refresh tokens outside the vault.
- Apply per-provider and per-tenant concurrency limits before upstream rate limits.

### Overload behavior

### Vault slow

Fail closed; do not substitute stale or alternate credentials. Shed low-priority reads before writes.

### Provider slow

Honor deadline, circuit-break refresh endpoint, preserve active unexpired access tokens.

### Refresh storm

Single-flight by connection, jitter proactive work, queue quotas by provider and tenant.

> **Load test shape:** include hot connections, many cold connections expiring together, one noisy tenant, provider 429s, vault p99 spikes, and revocation during in-flight lease acquisition.

---

## Prove one delegated provider end to end before generalizing

### Weeks 1-2 · Security skeleton

- Threat model, trust zones, workload identities, vault/KMS integration.
- Auth profile schema, environment separation, audit envelope.
- Fixture authorization and resource servers with failure injection.

### Weeks 3-4 · Authorization flow

- Authorization Code + PKCE orchestration, exact callback validation.
- Client secret capture, grant snapshot, subject binding.
- Connection UI and connect/deny/replay tests.

### Weeks 5-6 · Runtime

- Broker API, policy integration, vault lease, egress injection.
- Audience/scope checks, origin policy, stable auth errors.
- One read and one idempotent write through staging.

### Weeks 7-8 · Lifecycle

- Single-flight refresh, token rotation, reauthorization state.
- Disconnect, revocation, cache invalidation, secret destruction.
- Operations dashboard and alerting.

### Weeks 9-10 · Evidence

- Protocol fixture suite, tenant-isolation and adversarial egress tests.
- Provider sandbox suite wired into the evaluation harness.
- Rotation and incident drills; restore test.

### Weeks 11-12 · Pilot

- Second design partner using the same core without runtime code changes.
- Security review and penetration test.
- Production readiness review and scoped paid pilot.

> **Milestone that proves productization:** a second customer configures its own issuer, client, scopes, and account flow through the UI; all differences are profile data or a bounded provider adapter, not edits to the broker core.

---

## Own the policy model; buy undifferentiated custody primitives

- **KMS / HSM:**
  - **Recommendation:** Managed service
  - **Reason:** Key protection and audited operations
- **Secret vault:**
  - **Recommendation:** Managed or proven vault
  - **Reason:** Versioning, policy, rotation hooks
- **OAuth protocol library:**
  - **Recommendation:** Vetted standards library
  - **Reason:** Do not hand-roll parsing and validation
- **Provider adapter layer:**
  - **Recommendation:** Build
  - **Reason:** Core product compatibility boundary
- **Scope-to-tool compiler:**
  - **Recommendation:** Build
  - **Reason:** Differentiated agent-safety logic
- **Connection lifecycle:**
  - **Recommendation:** Build
  - **Reason:** Integrates release, policy, UX, audit
- **Egress enforcement:**
  - **Recommendation:** Build on cloud controls
  - **Reason:** Release-aware destination and injection policy
- **Identity provider for console:**
  - **Recommendation:** Buy
  - **Reason:** Enterprise SSO and MFA commodity

### Provider portability rules

- Abstract vault operations as put-version, read-version-for-purpose, retire-version, and destroy; never expose provider-specific paths to callers.
- Represent KMS keys by logical aliases and immutable key-version metadata.
- Keep OAuth protocol state in Foundry's canonical model; provider adapters translate only known deviations.
- Export customer configuration and audit evidence without exporting secret material.
- Test restore and regional failover with a second key boundary before claiming portability.

> **Avoid false leverage:** an OAuth-as-a-service vendor can accelerate onboarding, but the product still owns tenant binding, tool scopes, approval correlation, connection state, egress control, and evaluation evidence. Outsourcing tokens does not outsource authorization correctness.

---

## Do not accept production credentials until these controls are proven

**Security**

- Threat model reviewed; penetration test complete.
- Tenant-isolation suite and SSRF suite pass.
- Secret canaries, redaction, and log scans pass.
- Vault, KMS, workload, and break-glass policies reviewed.
- Client-secret and signing-key rotation rehearsed.

**Protocol**

- PKCE S256, exact redirect, state, issuer, and replay tests pass.
- Provider discovery snapshot approved.
- Scope delta and subject mismatch tested.
- Refresh rotation and invalid_grant recovery tested.
- Revocation semantics documented for provider.

**Operations**

- Multi-zone broker and vault dependency tested.
- Kill switches work at connection, profile, tenant, and cell scope.
- Alert routing and incident runbooks exercised.
- Backup restore occurs in an isolated key domain.
- Retention and deletion verification complete.

**Product**

- Connection and reauth UX tested with real users.
- Wrong-account recovery is explicit.
- Every enabled tool maps to minimum scopes.
- Muse approval semantics are not duplicated or bypassed.
- Support can diagnose without secret access.

> **Launch posture:** begin with one design partner, one production provider profile, one region, explicit quotas, and a small set of tools. Expand only after refresh, revocation, and incident data are boring.

---

## Ship with explicit defaults and revisit triggers

- **AUTH-001:**
  - **Decision:** Auth bridge brokers; upstream remains authority
  - **Status / revisit trigger:** Accepted
- **AUTH-002:**
  - **Decision:** Customer-owned OAuth app per environment
  - **Status / revisit trigger:** Default; revisit for major SaaS providers
- **AUTH-003:**
  - **Decision:** Authorization Code + PKCE is delegated MVP flow
  - **Status / revisit trigger:** Accepted
- **AUTH-004:**
  - **Decision:** Secrets live only in vault trust domain
  - **Status / revisit trigger:** Accepted
- **AUTH-005:**
  - **Decision:** Opaque one-use injector lease is target design
  - **Status / revisit trigger:** MVP may use memory-only gateway lease
- **AUTH-006:**
  - **Decision:** Profile versions immutable after approval
  - **Status / revisit trigger:** Accepted
- **AUTH-007:**
  - **Decision:** Scope expansion requires user reauthorization
  - **Status / revisit trigger:** Accepted
- **AUTH-008:**
  - **Decision:** Disconnect blocks locally before upstream revoke
  - **Status / revisit trigger:** Accepted
- **AUTH-009:**
  - **Decision:** DPoP, mTLS, PAR, exchange are post-MVP
  - **Status / revisit trigger:** Revisit per design partner
- **AUTH-010:**
  - **Decision:** Muse adapter owns platform-specific identity
  - **Status / revisit trigger:** Pending contract verification

### Decisions that need design-partner evidence

- Whether multiple upstream accounts per Muse user are common enough to justify an account-selection surface in v1.
- Which client authentication methods appear in the first three APIs.
- Whether providers return stable subjects and organization context without extra broad scopes.
- How frequently customer security teams require customer-managed keys, regional residency, or self-hosted runtime.
- Whether a shared Foundry OAuth app materially improves conversion enough to justify provider review and shared blast radius.

> **Implementation principle:** optimize for one safe, understandable path. A configuration system that can express every legacy OAuth variant is not the same as a bridge that can operate them reliably.

---

## Keep four platform facts outside the auth core until verified

### Must verify with Meta

- How a connector proves a Muse caller and whether a stable user/tenant subject is supplied.
- Who owns the authorization redirect and callback URL, and what redirect URIs are permitted.
- Whether Muse stores connector credentials itself, delegates storage to providers, or expects a token exchange.
- How connect, disconnect, reauthorization, scope change, and revocation events are delivered.
- How tool effect metadata and approval receipts are represented at runtime.
- Required security review, retention, incident, and deletion evidence.

### Safe adapter contract meanwhile

- **authenticateCaller** → platform principal + verified claims.
- **startConnection** → one-time URL or platform flow handle.
- **validateApproval** → action-bound approval evidence.
- **notifyConnectionState** → active, limited, reauth, revoked.
- **handleDisconnect** → tenant/principal/connector binding.
- **publishAuthMetadata** → required scopes and redirect facts.

### What public material does establish

Meta's Help Center describes connectors as user-chosen connections to third-party services, says Muse exchanges information relevant to tasks, allows users to disconnect, and describes permission settings and approvals for connector actions.[1][2] Those behaviors support the design's separation of grant, runtime policy, and action approval.

> **Do not infer the developer contract:** this design deliberately does not assume a connector package schema, OAuth callback ownership, credential handoff, signing format, or marketplace review API. The OpenAPI facade and managed gateway remain useful even if the Muse adapter changes.

---

## A two-tool pilot is enough to prove the auth architecture

The first proof is not “support OAuth.” It is: connect one real user, run one read and one approved idempotent write, refresh safely under concurrency, disconnect instantly, and explain every outcome without exposing a credential.

### Reference connector

- One customer staging authorization server.
- Authorization Code + PKCE, confidential client.
- Scopes: one read and one narrow write.
- Stable upstream subject and organization binding.
- One search tool and one reversible write tool.
- Provider revocation endpoint if available.

### Demo script

1. Admin configures and validates profile.
2. User connects and confirms account.
3. Read call succeeds through broker.
4. Write pauses for approval, then succeeds once.
5. Concurrent calls trigger exactly one refresh.
6. Scope-expanded candidate marks connection limited.
7. Disconnect blocks a new lease immediately.

### Acceptance evidence

- **No secret exposure:**
  - **Proof:** Trace/log scan
- **Correct identity:**
  - **Proof:** Subject binding assertion
- **Least privilege:**
  - **Proof:** Tool-to-scope report
- **No duplicate write:**
  - **Proof:** Idempotency record
- **Safe refresh:**
  - **Proof:** Concurrency fixture
- **Fast revoke:**
  - **Proof:** Lease-denial timestamp
- **Recoverable UX:**
  - **Proof:** Reauth scenario

### Exit criterion

A second customer completes the same journey using only profile configuration, scope mapping, and a bounded provider adapter.

> **Next engineering artifact:** convert this design into an Auth Profile JSON Schema, broker API definition, database migrations, and a fixture authorization server test plan.

---

## Standards anchor the protocol; product choices remain explicit

**[1]** Meta Help Center, “How Muse works with Connectors.”
<https://www.meta.com/help/1687253048996149>

**[2]** Meta Help Center, “How Muse works with your guidance and approval.”
<https://www.meta.com/help/1385290430137537>

**[3]** IETF, RFC 9700, “Best Current Practice for OAuth 2.0 Security.”
<https://datatracker.ietf.org/doc/html/rfc9700>

**[4]** IETF, RFC 8414, “OAuth 2.0 Authorization Server Metadata.”
<https://datatracker.ietf.org/doc/html/rfc8414>

**[5]** IETF, RFC 9449, “OAuth 2.0 Demonstrating Proof of Possession.”
<http://datatracker.ietf.org/doc/html/rfc9449>

**[6]** IETF, RFC 8705, “OAuth 2.0 Mutual-TLS Client Authentication and Certificate-Bound Access Tokens.”
<https://datatracker.ietf.org/doc/html/rfc8705>

**[7]** IETF, RFC 8693, “OAuth 2.0 Token Exchange.”
<https://Datatracker.ietf.org/doc/html/rfc8693>

**[8]** IETF, RFC 9396, “OAuth 2.0 Rich Authorization Requests.”
<https://datatracker.ietf.org/doc/html/rfc9396>

**[9]** IETF, RFC 9126, “OAuth 2.0 Pushed Authorization Requests.”
<https://datatracker.ietf.org/doc/html/rfc9126>

> **Interpretation:** the RFC citations support protocol properties and security recommendations. Service boundaries, data models, user experience, service objectives, and rollout sequencing are design recommendations for Connector Foundry, not requirements imposed by those standards.

---
