# Hackathon demo submission — ConnectorFoundry

Submit here: [Cerebral Valley — Meta AI Developer Hackathon](https://cerebralvalley.ai/e/meta-ai-developer-hackathon/hackathon/submit)

> Status: draft. Items marked **TODO** need the submitter's input — nothing
> below is guessed; placeholders are explicit so no wrong fact ships.

## How this is judged — map every beat to it

Submission due **Nov 4, 9:00 PM EST** (late = out). One submission per
team, one named Representative. Checklist before hitting submit: repo
public, video link accessible, everyone who worked on it listed. The
**3-minute video** is a primary judging artifact alongside code and the
live product — it must highlight the specific features, code, and
functionality built during the hackathon (Oct 26–Nov 4).

**Stage 1 (pass/fail):** fits the theme (we claim **Push the Frontier**,
see below) AND reasonably uses the Meta Model API / Meta open weights.
The video must name Muse Spark and show model evidence on screen.

**Stage 2 (scored 0–10 per criterion):** reported weights are impact
30%, creative use of Meta's AI tools 25%, demo incl. video 25%,
technical depth and execution 20% (per secondary coverage of the
official rules — **TODO**: paste the official rubric table rows here and
tighten the beat mapping). Top 5 per track go to **Stage 3**, where
judges watch the videos live under the same rubric.

**Indie-track lens** (our track): creativity, technical ambition, and
*whether it works*. So the video's spine is: a surprising, ambitious
idea → visibly working live → no faked passes. The script table marks
each beat with the criterion it serves: [Impact], [Meta-use],
[Demo], [Tech], [Works].

## Prizes — where Connector Foundry places

Ladders per secondary coverage of the official rules (**TODO**: verify
against the official prize tables — they didn't render outside the
portal):

- **Indie ($400k, our track):** 1st $150k · 2nd $100k · 3rd $75k ·
  4th $50k · 5th $25k.
- **Startups ($550k, not ours):** $250k / $150k / $75k / $50k / $25k.
- **Bonus $50k:** standout projects + community achievements (e.g.
  public vote, most viral — announced ~Nov 10).

Stage 3 takes the top 5 per track and there are 5 prizes per track, so
**making the finals is the ballgame**. Positioning:

- **Indie fit is direct:** solo-founder, no company or funding (see
  track pick below); technically ambitious (a full eval + release
  pipeline, not a demo wrapper); and the video proves it working live.
- **Theme fit:** Push the Frontier — we advance what agents can safely
  do with the whole existing REST ecosystem, not one personal workflow.
- **Most Viral (bonus):** the form already has the X-post field — enter
  both tracks of competition. Needs a posting plan: clip the green
  10/10 + promote beats (~30s), post from the founder account during
  judging week (Nov 4–8), pin it. **TODO** — X post URL + posting date.
- **Hackathon-window code:** §7 requires the video to feature features,
  code, and functionality built during the event (Oct 26–Nov 4). In
  window per git log: dedupe imports/compiles, approved-only eval,
  Tools bulk approve, Evaluate sections + polish, release error
  surfacing — plus this week's fixes (Tools auto-refresh, failed-scenario
  evidence, MCP/Claude connection path, connectors doc). **TODO** —
  founder to confirm the window list; the code-glimpse beat (2:35) must
  show items from it.

## Team Name

Connector Foundry

## Which track are you submitting to?

**Indie Developer Track** (recommended over Startups). This is a
solo-founder build with no company, funding, or team behind it — exactly
the indie profile — and ConnectorFoundry itself is a builder's tool: it
turns any REST API into agent-ready connectors. Flip to Startups only if
you are entering as a registered startup entity.

## Which problem statement did you build towards?\*

**Push the frontier** (recommended over Build for your world).
ConnectorFoundry doesn't solve one personal workflow — it advances what
agents can safely do with the entire existing REST ecosystem: measured
before/after agent behavior, write-safety verification, and
certification-gated prod promotion. "Build for your world" fits a tool
built for one community's problem; this one pushes the agent-tooling
frontier itself.

## If you're competing for the Most Viral Track, please submit your X post link here to be considered.

**TODO** — X post URL (omit this section if not competing).

## Project Description

ConnectorFoundry is a demo-day-ready pipeline that converts a REST API's
OpenAPI spec into tested, approved, release-grade AI agent tools. Import a
spec (httpbin's 73-operation keyless API in the demo), and it compiles one
tool draft per operation, routes spec and contract risks through a review
queue with concrete suggested fixes, evaluates every approved tool live
against the real upstream (contract, behavior, auth, recovery, and
write-safety suites), promotes passing tools to tested, and freezes
immutable versioned releases for MCP, OpenAI function-calling, and Meta
Muse targets. Prod promotion is certification-gated: the latest eval run
must be fully green. Unapproved drafts can never run, never ship, and
never look "tested".

## Public GitHub Repository

**TODO** — public repo URL (the monorepo is private; push the
`connector-foundry` slice or a public mirror and paste the link).

## 3-Minute Demo Video

**TODO** — video URL.

### Recording script (httpbin, green 8 — small set, failure → fix → pass → prod → Claude → Operate)

Setup off-camera (do not record): fresh `connector_foundry` DB, import
the httpbin spec (`https://httpbin.org/spec.json`, 73 ops — fast),
approve exactly the green 8 GET tools (../docs/test-data-sources.md — no key,
no quota). Propose agent tasks with Muse Spark and rehearse until one
agent-task failure is captured on a recorded run — the fix→pass beat
needs a real failing run, not a staged one. Cut nothing yet; the
recording creates the release. Record the two title cards in this
folder first (welcome 5s, before/built 11s), then from the Tools screen on.

| Time | On screen | Narration (spoken, ~130 wpm) | Serves |
|---|---|---|---|
| 0:00–0:05 | Welcome slide (`welcome-slide.png`) | "Connector Foundry — from your API to a tested agent connector." | [Demo] open |
| 0:05–0:16 | Before/built slide (`before-built-slide.png`) | "Before this week: screens, no engine. This week: the working pipeline — Meta's Muse Spark generates the tasks and judges the runs, tested end to end on localhost." | [Meta-use] named up front; §7 in-window proof |
| 0:16–0:22 | Import via OpenAPI link (Swagger, docs URL, Postman collection supported) | "Paste an OpenAPI, Swagger, docs, or Postman link — and the API is in." | [Demo] entry point |
| 0:22–0:26 | Dashboard | "The dashboard tracks every stage of the pipeline." | [Demo] orientation |
| 0:26–0:30 | API imported — operations inventory | "Seventy-three operations imported and mapped, ready to compile." | [Tech] import depth |
| 0:30–0:38 | Approving tools as connector candidates | "I approve eight read-only tools as connector candidates; the rest stay out until reviewed." | [Tech] gates; [Works] |
| 0:38–0:52 | Review: documentation findings, acknowledge or resolve | "Muse Spark works through the documentation and raises each finding — I acknowledge or resolve them all before anything moves forward. Nothing unreviewed ships." | [Meta-use] findings; [Works] honest gate |
| 0:52–1:26 | Agent tasks generated by the Muse model, selected for evaluation; eval scenarios run, tools certified ready | "Meta's Muse Spark drafts the agent tasks — realistic user requests per toolset — plus the evaluation scenarios. I pick the ones to run. Every approved tool is exercised live against the real API and judged by Muse Spark — and a fully green run certifies these tools ready to publish." | [Meta-use] generation + judging + certification on screen (Stage 1 gate); [Works] |
| 1:26–1:41 | Create release in staging; Claude MCP server, OpenAI functions, Muse connector artifacts | "Release one freezes these tools in staging. The Claude MCP server, OpenAI functions, and the Muse connector are generated — ready to download, with the Muse kit ready to submit." | [Tech] depth; [Meta-use] Muse target |
| 1:41–2:07 | Testing the MCP server with Claude Code (same path works for OpenAI, Meta Muse) | "Same release, now running inside Claude Code over MCP. Real prompt, live answers from the API — and the same test path works for OpenAI and Meta Muse with their connectors." | [Works]; [Demo] live agent payoff (Claude Code is the Anthropic client, not a Meta model) |
| 2:07–2:36 | Operate: live-user telemetry per client, channel, release | "And every call lands in Operate — which client, which channel, which release, live as users invoke the connector. Latency, errors, and usage per tool — the production footprint in one place." | [Tech]; [Impact] observed in prod |
| 2:36–2:55 | Promote to prod; full pipeline recap (onboard → review → eval → publish → telemetry) | "Promote to prod — certification-gated, so only the green run ships. Spec to tools to review to evaluation to release to live telemetry: the complete pipeline, running." | [Impact] close; §7 full in-window flow |

Takes and honesty: the accept click is live; the green re-run is a real
recorded run spliced in (EDIT) — every run shown happened, never fake a
pass. Fallbacks (rehearse, don't improvise): if the rehearsed
agent-task failure won't reproduce, use the deterministic custom-scenario
loop instead — add a scenario on `GET /json` expecting a wrong body key,
record its failure, delete and re-add it corrected, re-run green. Same
arc, zero LLM dependence. If httpbin burst-throttles (429), wait a
minute and re-run the 8-tool set — never widen the set to dodge it.

## Describe your use of Meta products to build the submitted project

Meta's **Muse Spark** (`muse-spark-1.3`, via `https://api.meta.ai/v1` with an
OpenAI-compatible client) is the intelligence inside four product beats:
(1) it proposes natural-language **agent tasks** from the compiled tools, so
every evaluation measures before/after agent behavior on requests users
actually make; (2) it **judges the answer rubric** on every agent run —
the `answer_rubric` check is a Spark verdict call against the transcript,
fail-closed when the judge is unreachable; (3) it proposes **fix
suggestions** — concrete edits to tool descriptions and parameter docs
grounded in review findings and failed scenarios, which a human accepts
or rejects; (4) it powers the **agent behavior comparison** (success
rate, tool-call quality, cost, per-task before/after transcripts with
flips). The pipeline degrades honestly without a key: those beats answer
`503 llm_not_configured` instead of faking output, and non-LLM suites
(contract, behavior, recovery, safety) run regardless. No other Meta
products are used; the Muse connector target emits artifacts shaped for
`muse.ai` intake.

## Why are Meta's models important to your solution?

Everything deterministic in the pipeline (spec parsing, contract probes,
recovery checks, safety gates) tells you *what* broke; only a strong
general model tells you *what it means for an agent* and *how to fix the
words the agent reads*. Muse Spark's instruction-following and JSON
discipline make both halves reliable: agent tasks come back as structured
prompts with expected/forbidden tools, and fix suggestions come back as
surgical before/after text edits tied to evidence — both machine-checkable,
both gated by human approval. A weaker model would turn the review queue
into noise; Spark keeps the signal high enough that "accept" is the common
case.

## Provide feedback from your experience using Meta products

- The OpenAI-compatible endpoint made integration a one-file client with no
  SDK lock-in; structured-output discipline was good enough to skip a
  repair loop in practice.
- Ask: published rate limits and a usage dashboard for `dev.meta.ai` keys
  would help demo-day capacity planning (we budget tokens per run
  client-side instead).
- Ask: a model version alias (e.g. `muse-spark-latest`) distinct from the
  pinned `muse-spark-1.3`, so demos pin reproducibility while dev tracks
  improvements.

## Provide feedback from your experience using partner technologies

- **httpbin.org (demo API):** zero-key, 73 ops, instant responses — the
  submission path. Its echo behavior correctly fails write-safety
  (wrong-type payloads get 200-accepted), which scoped the green set to
  GETs; burst-throttling (429) stays away at 8-tool scope. No asks — the
  ideal harness target as-is.
- **Twelve Data (auth-failure reference):** generous free tier and a real
  187-operation OpenAPI spec; the key-plan-gated endpoints (401/403 on
  free keys) demo failure categorization perfectly. Ask: per-key quota
  headers would let us show retry guidance with exact reset times
  instead of window estimates.
- **GitHub REST (scale test):** the 1,242-operation spec proved dedupe and
  paging, but anonymous 60 req/hour quotas wall off big evals — fine for
  the approved-only story, worth knowing before recording.
- **AWS serverless (infra):** API Gateway + Lambda + DynamoDB on-demand
  kept the demo backend at ~zero idle cost; Cognito per-app pools matched
  the "users belong to the app" model with no custom auth code.
