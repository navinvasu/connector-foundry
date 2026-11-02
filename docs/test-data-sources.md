# Test data sources — public APIs with OpenAPI URLs

One project per API: create a project, paste the OpenAPI URL on the Import
screen (or upload the file), and walk the full loop
(import → vault → curate → eval → release). Sizes and op counts below were
checked 2026-10-27 — re-check if an import misbehaves, specs change upstream.
httpbin + Petstore re-checked live 2026-10-30 (see notes below).

## The list

| API | OpenAPI URL | Ops | Spec size | Auth | Good for |
|---|---|---|---|---|---|
| Swagger Petstore v3 | `https://petstore3.swagger.io/api/v3/openapi.json` | 19 | 17 KB | none | Smallest loop; OpenAPI 3.x path; write ops for confirmation prompts. Caution 2026-10-30: live sandbox returned 500 on `/store/inventory` — expect red evals when it flakes; prefer httpbin for live demos |
| Swagger Petstore v2 | `https://petstore.swagger.io/v2/swagger.json` | 20 | 14 KB | none | Swagger 2.0 import path (same shop, older format) |
| httpbin | `https://httpbin.org/spec.json` | 73 | 41 KB | none | Read + write mix (48 GET, 7 POST, 6 PUT, 6 PATCH, 6 DELETE) with zero signup — effect classes and confirmation UX. Recommended zero-key demo (2026-10-30: spec + all 5 methods live 200). Swagger 2.0 with `host: httpbin.org`, so no HOST blocker. Skip the auth-gated ops (`/basic-auth/*`, `/bearer`, `/hidden-basic-auth/*`, `/digest-auth/*`, `/deny`) — use the green 8 below |
| Twelve Data | `https://api.twelvedata.com/doc/swagger/openapi.json` | ~187 | ~3.4 MB | API key (free tier) | The demo API; key-plan failures for the failures-by-category UX (see `../demo/demo-twelve-data-muse.md`) |
| Stripe | `https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json` | 612 | 8.3 MB | basic / bearer (test key) | Large real API; `basicAuth` + `bearerAuth` schemes for credential-mode mapping |
| GitHub REST | `https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json` | 1242 | 13.5 MB | optional token (60 req/h without, 5000 with) | Scale test; works keyless at low rates, token goes in the vault. See the green 10-tool set below for a clean pass |

## The green 10 — GitHub tools that pass eval cleanly

Frozen in release `0.1.0` (GitHub REST project). All are read-only GETs on
public endpoints, so safety passes trivially and no credential is needed.
Approve exactly these, run evaluation, cut the release, promote.

| Tool | Method + path | Notes |
|---|---|---|
| `emojisGet` | `GET /emojis` | Simplest possible pass |
| `gistsList` | `GET /gists` | |
| `gistsListPublic` | `GET /gists/public` | |
| `licensesGetAllCommonlyUsed` | `GET /licenses` | |
| `metaGetAllVersions` | `GET /versions` | |
| `metaRoot` | `GET /` | API root, always 200 when quota remains |
| `rateLimitGet` | `GET /rate_limit` | Does not count against quota — good canary |
| `reposListPublic` | `GET /repositories` | |
| `searchCommits` | `GET /search/commits` | Search endpoints have their own stricter per-minute limit — if anything stays red, it is these two |
| `searchIssuesAndPullRequests` | `GET /search/issues` | Same as above |

Rules for a clean pass tomorrow (verified 2026-10-27/28 against the live API):

1. **Check the anonymous quota first**: `curl -s https://api.github.com/rate_limit` — `core.remaining` should be near 60. A full eval of these 10 costs ~32 requests; the two earlier 1,200-tool evals burned whole hours.
2. **Run nothing else GitHub-touching in between** — one eval, then promote.
3. The tools compile with `credential_mode: none` (GitHub's spec declares no auth), so a vault token is **not** attached to these requests — quota timing is the only lever.
4. If the two `search*` tools fail on the per-minute search limit, exclude them and re-run with the other 8 (eat the extra quota cost once, or wait a minute and retry just as the window is fresh).

## The green 8 — httpbin tools that pass eval cleanly

The zero-key demo set (verified live 2026-10-30 — every one returns 200
with a JSON object body and no credential). GET-only and parameter-free,
so no probe-input guessing and no safety-suite exposure. Approve exactly
these, run evaluation, cut the release, promote.

| Tool (method + path) | Notes |
|---|---|
| `GET /get` | Simplest possible pass |
| `GET /ip` | |
| `GET /json` | |
| `GET /headers` | |
| `GET /user-agent` | |
| `GET /uuid` | |
| `GET /anything` | Echo as GET — read-only, stays green |
| `GET /cookies` | |

Why no writes: httpbin is an echo service — a wrong-type payload gets
200-accepted instead of 4xx-rejected, so `POST /post` etc. fail the
write-safety scenario (`accepted_2xx`, surfaced as "Response did not match
the contract"). That is the harness working as designed, not a product
bug — but it keeps writes out of the green set. Approve one write
alongside if you want the failure-categorization and keep-passed beats in
the same demo.

Deliberately excluded: `/basic-auth/*`, `/bearer`, `/hidden-basic-auth/*`,
`/digest-auth/*` (401 without credentials — by design), `/deny` (403 by
design), `/status/{codes}` and `/redirect*` (non-2xx by design),
`/delay/*` and `/drip` (slow — they stretch eval), text/binary endpoints
(`/html`, `/xml`, `/image/*`, `/bytes`, `/stream*`, `/robots.txt`,
`/encoding/utf8` — the happy-path probe requires a JSON object body).

### Beating the 429s

httpbin.org burst-throttles (Cloudflare): a full-toolset eval fires dozens
of probes in seconds and some come back 429 ("Rate limited"). This is
transient upstream throttling — the run's own suggestion says re-run.
Practical rules:

1. Evaluate the green 8 only — never all 73 ops at once.
2. Keep agent tasks unapproved until the baseline is green (each approved
   task adds LLM-driven upstream calls on top of the probes).
3. If 429s persist, scope the run via the API a few tools at a time
   (the console Run button always evaluates the whole approved set):
   `POST /v1/projects/:id/eval` with `{"tool_ids": [...]}`.
4. A partial pass still demos the core loop: the outcome panel's
   "Continue with the passed operations only" shelves failures and the
   release proceeds on green tools.

## Before you import the big ones

The server caps upstream response bodies at **5 MiB** by default
(`CF_EGRESS_MAX_RESPONSE_BYTES`). Twelve Data fits; Stripe (8.3 MB) and
GitHub (13.5 MB) do not — the import fails with `Egress blocked: upstream
response exceeded the 5242880-byte limit`. Raise it and restart the backend:

```bash
# backend/server/.env
CF_EGRESS_MAX_RESPONSE_BYTES=16777216
```

`./dev.sh` again after the edit. Alternatively download the JSON and import
via file upload — same cap applies to URL fetches only when the server
fetches; uploads ride the request body instead.

## Keys

API keys never go in the spec or the chat — store them on the Tools screen
vault card (metadata only is shown back). Without a key, Twelve Data and
Stripe evals fail at the auth suite, which is itself a useful demo of the
failure categorization.

## More APIs

[APIs.guru](https://apis.guru/) hosts thousands of OpenAPI specs with a
browsable list — pick a medium one (50–300 ops) in a domain you know, and
check its size with `curl -sIL <url> | grep -i content-length` before
importing. Prefer specs with `securitySchemes` declared (tests credential
mapping) and at least one POST/PUT/DELETE (tests write-effect UX).
