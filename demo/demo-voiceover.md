# Demo voiceover — AI narration + edit workflow

Companion to the recording script in
[demo-submission.md](demo-submission.md). Same 12 beats, same words —
this page is the speakable text formatted for text-to-speech, and the
workflow for laying it over the silent screen recording. Works for both
the hackathon submission and the company-website cut.

## Title slides (welcome 0:00–0:05, before/built 0:05–0:16 — PNGs in this folder)

**Connector Foundry**
*From your API to a tested agent connector in under 5 minutes.*
Welcome → starting line → live flow.

## TTS text per beat (copy-paste, numbers spelled out)

Timings below follow the recorded timeline (2:39 of product) plus the
two title cards — total 2:55, inside the 3:00 cap with ~5s of margin.
Narration runs short of each window on purpose; the leftover is screen
dwell, never dead air.

**Beat 1 — Welcome (0:00–0:05)**
> Connector Foundry — from your API to a tested agent connector.

**Beat 2 — Before / built (0:05–0:16)**
> Before this week: screens, no engine. This week: the working
> pipeline — Meta's Muse Spark generates the tasks and judges the runs,
> tested end to end on localhost.

**Beat 3 — Import (0:16–0:22)**
> Paste an OpenAPI, Swagger, docs, or Postman link — and the API is in.

**Beat 4 — Dashboard (0:22–0:26)**
> The dashboard tracks every stage of the pipeline.

**Beat 5 — Imported (0:26–0:30)**
> Seventy-three operations imported and mapped, ready to compile.

*(Beat 6 starts at 0:31 to let beat 5 land; beats 2–3 are lightly
time-compressed in the mix to hold their windows.)*

**Beat 6 — Approve tools (0:30–0:38)**
> I approve eight read-only tools as connector candidates; the rest
> stay out until reviewed.

**Beat 7 — Review findings (0:38–0:52)**
> Muse Spark works through the documentation and raises each finding —
> I acknowledge or resolve them all before anything moves forward.
> Nothing unreviewed ships.

**Beat 8 — Agent tasks + evaluation (0:52–1:26)**
> Meta's Muse Spark drafts the agent tasks — realistic user requests
> per toolset — plus the evaluation scenarios. I pick the ones to run.
> Every approved tool is exercised live against the real API and judged
> by Muse Spark — and a fully green run certifies these tools ready
> to publish.

**Beat 9 — Release to staging (1:26–1:41)**
> Release one freezes these tools in staging. The Claude MCP server,
> OpenAI functions, and the Muse connector are generated — ready to
> download, with the Muse kit ready to submit.

**Beat 10 — Claude Code test (1:41–2:07)**
> Same release, now running inside Claude Code over MCP. Real prompt,
> live answers from the API — and the same test path works for OpenAI
> and Meta Muse with their connectors.

**Beat 11 — Operate + telemetry (2:07–2:36)**
> And every call lands in Operate — which client, which channel, which
> release, live as users invoke the connector. Latency, errors, and
> usage per tool — the production footprint in one place.

**Beat 12 — Promote to prod + close (2:36–2:55)**
> Promote to prod — certification-gated, so only the green run ships.
> Spec to tools to review to evaluation to release to live telemetry:
> the complete pipeline, running.

## Generate the voice (AI voice, per-beat MP3s)

`edge-tts` (free, Microsoft neural voices, no key) — one file per beat
so the edit stays aligned even when a take changes:

```bash
pip install edge-tts
VOICE=en-US-AriaNeural   # alternatives: en-US-GuyNeural, en-GB-SoniaNeural
edge-tts --voice $VOICE --text "Connector Foundry ..." --write-media beat1.mp3
# ... repeat per beat, or save each block above as beatN.txt and loop:
for n in $(seq 1 12); do
  edge-tts --voice $VOICE --file beat$n.txt --write-media beat$n.mp3
done
```

Timing fit (re-checked 2026-11-01 against the recorded timeline): 268
words total ≈ 115s of speech at ~140 wpm across a 175s cut (2:55),
leaving ~60s for screen dwell and transitions — per-beat words are
11/27/14/8/7/14/23/51/23/31/32/27, each inside its window with margin.
Re-check with the timing loop below after any wording change. Meta Muse
Spark is named on beats 2 (generation + judging), 7 (documentation
findings), 8 (task drafting, eval scenarios, the judge, certification),
9 (Muse connector + review-gate kit), and 10 (Meta Muse test path);
beats 3, 4, 5, 6, 11, 12 are deterministic or non-Meta surfaces and stay
unnamed — Claude Code in beat 10 is the Anthropic client over our MCP
server, not a Meta model.

Timing check (all twelve must land inside their windows, total ≤ 180s):

```bash
for n in $(seq 1 12); do
  python3 -c "import mutagen.mp3,sys; print(sys.argv[1], round(mutagen.mp3.MP3(sys.argv[1]).info.length,1))" beat$n.mp3
done
```

Fallback with zero installs (macOS system voice — fine for timing
rehearsal, not for the final cut):

```bash
say -v Samantha -o beat1.aiff "Every API you own ..."
afinfo beat1.aiff | grep duration
```

## Edit workflow (overlay)

1. Record the screen **silent** (no mic): welcome 5s, before/built
   11s, then the product flow (recorded 2:39) with its natural timing.
2. Import `beat1…beat12.mp3`. Drop each file at its beat start
   (0:00 / 0:05 / 0:16 / 0:22 / 0:26 / 0:30 / 0:38 / 0:52 / 1:26 / 1:41 / 2:07 / 2:36). If a
   narration overruns its window, trim the screen dwell first, then
   re-generate that beat at `--rate=+5%` — never squeeze past +10%.
3. Duck 6 dB under narration if you add music; keep the Claude-answer
   moment and the 8/8 reveal unducked for punch.
4. Export 1080p. Same timeline serves the hackathon submission and the
   website — only the title slide differs (add the company URL for the
   website cut).
