# Demo — Twelve Data on Connector Foundry, powered by Muse Spark

> Submission cut uses **httpbin** — see the recording script in
> [demo-submission.md](demo-submission.md). This doc stays as the Twelve
> Data long-cut reference (5 min, dev lite stack).

**Status:** hackathon demo script (dev lite stack only) · **Model:** Meta Muse Spark
`muse-spark-1.3` only — Amazon Nova 2 Lite is not run for this demo ·
**Demo API:** Twelve Data financial data API · **Recording target:** ~5 minutes
**Infra register:** `infrastructure/terraform/apps/connector-foundry/HACKATHON-CHANGES.md`
(H-01…H-07; revert from there after the demo)

Demo API facts (verified 2026-10-26): OpenAPI 3.1 spec at
`https://api.twelvedata.com/doc/swagger/openapi.json` (~3.4 MB, 187 paths,
server `https://api.twelvedata.com/`), API-key auth as `apikey` query
parameter or `Authorization` header. The full spec is imported; the demo
curates ~8 read tools (see Beat 3) — importing all 187 as live tools would
bury the story.

---

## 1. Before Connector Foundry — the pain (say this, ~45 seconds)

REST API owners who want AI agents to use their API today hit the same wall:

- **A spec is not a connector.** An OpenAPI file describes endpoints; agents
  need curated tools — names, when-to-use guidance, safe argument handling.
  Hand-writing MCP/OpenAI tool definitions per platform is weeks of glue.
- **No proof it works.** Owners demo with `curl` and hope. There is no eval
  harness: wrong tool choice, invented arguments and silent upstream 500s
  are discovered by end users, not before release.
- **Secrets leak into artifacts.** Keys end up in tool definitions, prompts
  and logs because there is no broker that injects credentials at call time.
- **No human gate.** Generated tools ship without review; a bad description
  or a destructive write goes live with no sign-off, staging or rollback.
- **Three platforms, three rewrites.** Claude (MCP), ChatGPT (function
  calling / GPT Actions) and Meta Muse each want different packaging and
  review evidence — including Muse's Read / Write / Sensitive-write
  classification and test-account review.
- **Blind after launch.** No per-call telemetry: who called what, from which
  agent, on which release, and whether the upstream drifted — unanswerable.

Twelve Data is the stand-in customer: a real, key-protected financial API
with a large published spec — exactly the "bring what you have" input.

## 2. After Connector Foundry — the result (the promise the demo proves)

- Import the spec you already publish → proposed agent-ready tools, curated
  and approved by a human. Nothing ships by suggestion alone.
- Every tool is **proven before release**: contract / behavior / auth /
  recovery / safety suites plus Muse Spark agent tasks (a real agent trying
  real user requests through the data plane), with fix suggestions tied to
  the failing evidence.
- Credentials live in a **KMS-envelope vault** and are injected per call —
  never in releases, manifests or logs (redaction on every choke point).
- **One neutral release, three platforms:** hosted MCP for Claude and Muse,
  OpenAI artifacts for ChatGPT, and a Muse submission kit gated on Meta's
  rules (money-movement and unconfirmed sensitive writes blocked).
- **Operate with evidence:** per-call attribution (channel, client, trigger,
  release version), drift alerts when the upstream contract breaks, and
  rollback by deprecating a release.

Expected demo outcome (the "results" frame for the close): a raw 187-path
financial spec becomes a certified, versioned connector (v1 → improved v2)
that a Muse Spark agent uses live to answer market questions — with the
before/after agent success shown side by side, and every call visible in
Operate.

## 3. Pre-demo setup (day before — not on camera)

1. Apply the dev lite stack per `infrastructure/terraform/apps/connector-foundry/apply-runbook.md`
   (one apply, **AWS-generated URLs only** — no Hostinger DNS, no certificate;
   branded domains are production-only, see `path-to-prod.md`). First plan
   must read additions-only (~65 + H-01's SSM params); stop on any destroy.
   Demo URLs are the `console_url` / `api_url` / `login_url` outputs.
2. In `terraform.tfvars` (never committed): `llm_api_key = "<Meta key>"`
   (H-01 seeds `CF_LLM_PROVIDER=openai_compatible`, `CF_LLM_MODEL=muse-spark-1.3`,
   `CF_LLM_BASE_URL=https://api.meta.ai/v1`). Push the arm64 image, deploy via
   SSM `deploy.sh`, sync the console build. Verify:
   `curl -s "$(terraform output -raw api_url)/health"` → `{"ok":true,...}`.
3. Sign up via `login_url` (Cognito's AWS domain), create the demo organisation,
   and run one throwaway smoke pass so the on-camera run is the second run:
   `CF_TOKEN=<token> CF_BASE=<api_url output> npm run smoke -- --spec-url https://api.twelvedata.com/doc/swagger/openapi.json --api-key <Twelve Data key> --keep`
   from `projects/connector-foundry/backend/server`.
4. Curate the project (Beat 3 list), vault the Twelve Data key, run the
   baseline evaluation once, accept one fix suggestion, and cut **v1** so
   the recording can show the v1 → v2 improvement without waiting on eval
   latency. Keep the browser on the Evaluate page's before/after panel.
   **Passed-only is the demo's spine:** a full-spec run honestly reports
   "187 operations found, N passed, the rest failed" with each failure
   grouped by cause (key rejected 401, plan not allowed 403, 404, 4xx,
   5xx, timeout, contract mismatch) and a suggested fix per group. The
   **Continue with the passed operations only** action (Evaluate →
   Operations outcome) sets the failures aside and the release proceeds
   with only what passed — that triage *is* the usefulness story.
5. Rehearse twice end to end (HK-10). `pg_dump` backup before each run
   (apply-runbook). Check the Muse token budget (`CF_LLM_MAX_TOKENS_PER_RUN`,
   default 60k/run) covers the task suite on hackathon credits.

**Curated demo tools (all Read class):** `quote`, `price`, `time_series`,
`symbol_search`, `profile`, `earnings`, `statistics`, `exchange_schedule`
(exact tool names as compiled). Everything else stays unapproved/excluded.

**Demo tasks (Muse Spark agent tasks, approved before recording):**

1. "What is Apple's (AAPL) latest price, and how much did it move today?"
2. "Compare today's quotes for Microsoft (MSFT) and NVIDIA (NVDA) — which moved more?"
3. "Show Apple's daily closes for the last 5 sessions — up or down trend?"
4. "Find the listed symbol for Tesla and confirm its exchange."
5. "Give me Apple's company profile and its next earnings date."
6. "Is the NASDAQ market open right now, and when does it close?"

## 4. Recording script — beat by beat (~5 min)

| # | Time | On screen (do) | Say (script) | Proof on screen |
|---|---|---|---|---|
| 0 | 0:00 | Title / connectorfoundry.com | "API owners can't ship agent connectors from a spec alone — no curation, no proof, no vault, no gate. Watch a live financial API become a tested Muse connector in five minutes." | Pain frame (§1, one line each) |
| 1 | 0:30 | Open the console (CloudFront URL) → sign-up via the Cognito AWS login URL (email code) → create organisation → new project "Twelve Data" | "Real product, real sign-up. No demo mode — everything you see reads the live API." (D-87/D-90) | Console with the real (empty) workspace |
| 2 | 1:00 | Import: paste `https://api.twelvedata.com/doc/swagger/openapi.json` → inventory + findings → store the Twelve Data key in the vault | "187 operations from the published spec. The API key goes into a KMS-envelope vault — it will never appear in a release, a manifest or a log." | Operation count; credential stored (metadata only) |
| 3 | 1:40 | Tools: compiled tools with Read/Write/Sensitive classes; keep the 8 curated tools, exclude the rest; show an MCP annotation | "The compiler proposes; the owner decides. Every tool is classified for Muse review and annotated for MCP before anyone approves it." | Access classes + `readOnlyHint` on a tool |
| 4 | 2:20 | Evaluate: **Propose tasks** (Muse Spark writes the 6 tasks) → approve → **Run evaluation** | "Muse Spark proposes real user requests; the harness plus a live agent prove each tool — contract, behaviour, auth, recovery, safety." | Suites passing; agent-task transcripts; evidence names `muse-spark-1.3` |
| 5 | 3:00 | **Suggest fixes** on a failed/weak task → before/after wording → accept → approve → **Re-run** | "A weak description made the agent pick the wrong tool. The fix is proposed from the failing evidence — I accept it, the tool goes back for approval, and we re-prove it." | *Agent behavior* before vs after: success up, invalid args down |
| 6 | 3:40 | Publish: cut **v2**, approve, promote staging → prod; open **What changed v1 → v2**; download the Muse submission kit | "One signed, immutable release. The changelog shows exactly what improved — and the Muse kit is gated: no money movement, no unconfirmed sensitive writes." | Release diff + agent success per release; kit + gate result |
| 7 | 4:15 | Use it: console playground prompt ("Compare MSFT and NVDA today") → then Claude/agent on `<api_url>/v1/mcp/<project>` with a gateway key → one `curl` with the key | "The same release serves the playground, an MCP agent, and automation — one artifact, every channel." | Live Twelve Data answers from the released tools |
| 8 | 4:45 | Operate: attribution splits (user prompt vs agent follow-up vs automated; by client, channel, release v1 vs v2) | "And we can prove all of it afterwards: who called what, from which agent, on which release." Close: "From a raw spec to a certified Muse connector — tested before it ships, observable after." | Operate charts + recent invocations |

**Fallbacks (rehearse, don't improvise):** Muse Spark unavailable → the
script still runs on the hosted stack with the playground/MCP beats; state
plainly that the model is swapped by config (provider seam, D-88) — do not
claim Muse evidence you didn't produce. Twelve Data rate-limited → the
pre-recorded baseline project (§3 step 4) carries beats 4–8. Upstream slow →
stay on Evaluate's recorded run and narrate the transcript.

## 5. Complete demo plan (checklist)

**Infra (dev only):** apply lite stack on AWS URLs (no DNS — H-05 deferred to prod) → image + console deploy →
Muse Spark SSM config live (H-01/H-02) → health + smoke green. No `prod`,
no shared-stack change (H-06: none), no other app (H-07: none).

**Product:** HK-08 Muse kit + gate visible on Publish (build if missing
before rehearsal) → HK-06 agent script as the off-console caller if ready
(else Claude/MCP client + `curl`, same beats) → HK-11 README/secret-scan
housekeeping after recording.

**Data:** demo org/project + vaulted key + v1 baseline (§3) → recording run
creates v2 → after recording, revert per `HACKATHON-CHANGES.md` (H-04 data,
H-01/H-02 model config) and stop the instance.

**Done means:** two clean rehearsals, the 5-minute recording, eval evidence
naming `muse-spark-1.3`, and the revert register current.
