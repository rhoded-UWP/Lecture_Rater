# Lecture Rater

A web app that listens to you teach — live in the classroom or in rehearsal — and coaches your lecture delivery. It transcribes as you speak, tracks pace, filler words, stutters, and vocal energy, graphs continuous lecture time between nonlecture activities, and fact-checks what you told them afterward.

**Status:** Built through Phase 5 — live dashboard, precision transcription (verbatim disfluencies), fact-check, scoring, swappable AI providers (dev panel), and on-demand deep analysis with learning-outcome alignment
**User:** Single user (Dan), no accounts, no auth, mic only — no video, no stored recordings.

### Running locally

```bash
npm install
npm start          # http://localhost:3000 — open in Chrome
```

Without API keys the app is fully usable (Phase 1: live dashboard, live-data report, history).
To enable the AI passes, copy `.env.example` to `.env` and paste in whichever keys you have
(`npm start` loads `.env` automatically; on Render, set the same names as environment variables):

| Variable | Enables |
|---|---|
| `ASSEMBLYAI_API_KEY` | AssemblyAI precision transcript — the default; verbatim fillers/stutters |
| `OPENAI_API_KEY` | Whisper as the alternative transcription provider |
| `ANTHROPIC_API_KEY` | Claude fact-check + deep analysis |
| `DEEPSEEK_API_KEY` | DeepSeek as an alternative (budget) analysis provider |
| `MOONSHOT_API_KEY` | Kimi K2 as an alternative analysis provider |

A missing key just greys that provider out in the dev panel — nothing breaks.

### Swappable AI providers

Every AI endpoint is swappable at runtime from **⚙ Developer Tools** (bottom-left) — no restart:

- **Transcription — precision pass:** AssemblyAI with `disfluencies: true` (default — transcribes um/uh, repetitions, and part-word stutters verbatim so they can be counted) or OpenAI Whisper (primed with a verbatim prompt; partial filler capture only). Live captions always stay on the free Chrome Web Speech API regardless.
- **Quick fact-check** (runs automatically each session): any model in the catalog — default Claude Haiku 4.5 (cheap)
- **Deep analysis** (manual button, paid): any model in the catalog — default Claude Opus 4.8 (best)

The catalog lives in `providers/catalog.js` — add a provider/model there (plus its key) and it
appears in the dev panel. Choices persist server-side in `dev-settings.json` (gitignored).
DeepSeek and Kimi share one OpenAI-compatible adapter, so most new chat APIs are a catalog entry away.

---

## Tech Stack

| Layer | Choice | Notes |
|---|---|---|
| Front end | HTML, CSS, vanilla JavaScript | No framework; matches existing projects |
| Back end | Node.js + Express | Serves static front end + API routes |
| Hosting | Render (single web service) | API keys in Render environment variables |
| Live transcription | **Web Speech API** (browser, free) | Drives all live/real-time features; Chrome required |
| Precision transcription | **AssemblyAI** (default, `disfluencies: true`) or **Whisper** — swappable in the dev panel | Word-level timestamps; AssemblyAI transcribes fillers/repetitions/part-word stutters verbatim (~$0.35–0.37/hr either way) |
| Fact-checking | Swappable analysis model — default **Claude Haiku 4.5** | Reviews transcript against the active mode's content file after every session |
| Deep analysis | Swappable analysis model — default **Claude Opus 4.8** | Manual, button-triggered: thorough content review + learning-outcome alignment |
| Vocal tone analysis | Web Audio API (in browser, free) | Pitch variance + volume dynamics, computed locally in real time |
| Storage | Browser `localStorage` + JSON file export | Nothing persisted server-side (Render disk is ephemeral anyway) |

### Why the hybrid transcription?

- **Web Speech API** is free and real-time, but it auto-cleans speech — it tends to silently drop "um"s and repeated words, which is exactly what we want to count. Live counts are therefore a floor, not a total.
- The **precision pass** (AssemblyAI by default, with its disfluency model on) gives an accurate word-timestamped transcript *including* fillers, repetitions, and part-word stutters — but it's batch, not live. (Whisper is the selectable alternative; it's primed with a verbatim prompt but still cleans away many disfluencies.)
- So: Web Speech powers the **live dashboard**; the browser also records audio locally during the session, and when you hit *End Session*, uploads it once for the precision pass. The final report is built from the precision transcript.

### Audio handling rule (non-negotiable)

Audio is recorded **in the browser only**, uploaded **once** to the Express server, forwarded to the active transcription provider, and **deleted immediately** after transcription returns. No recording is ever stored on the server or in the saved session data. The saved artifact is transcript + metrics only.

---

## Core Concepts

### Sessions

A session starts when you arm the mic and ends when you stop it. At session start you choose a **Mode** — the course being taught. Three ship today: *Default — Any Subject*, *CS1010 - Intro to Computer Science*, and *CS1430 - Intro to Programming*.

(The Rehearsal / Live Classroom toggle was removed — all sessions currently record as rehearsal. The stricter Live-mode privacy code paths remain in the codebase should classroom mode return; see Privacy below.)

### Modes

A mode is a content/context file, one per subject, stored in the repo at `modes/*.json`. It tells the fact-checker what's being taught and how strict to be.

```json
{
  "id": "intro-python",
  "title": "CS1430 - Intro to Programming",
  "subject": "Python programming for first-time programmers",
  "level": "intro",
  "strictness": "Flag statements that are wrong, and oversimplifications likely to cause misconceptions later. Do not flag reasonable pedagogical simplification.",
  "topics": ["variables", "types", "strings", "input/print", "conditionals", "loops", "functions", "lists"],
  "learningOutcomes": [
    "Develop algorithms to solve \"computer-solvable\" problems",
    "Translate algorithms to computer programs",
    "…the course's official SLOs, one per line…"
  ],
  "misconceptionTraps": [
    "Confusing = (assignment) with == (comparison)",
    "input() returns a string — forgetting to mention casting"
  ]
}
```

Adding a future mode = adding a file. The mode selector reads whatever files exist. No code changes. `learningOutcomes` holds the course's official SLOs — they pre-fill the setup screen's outcomes box on mode selection and feed the deep-analysis alignment.

### Learning objectives & outcomes

The Session Setup console accepts two optional lists, typed in or uploaded as `.txt`/`.md` (one per line) or `.json` (array of strings):

1. **Lecture objectives** — what this session is supposed to teach. Drafted per session.
2. **Student learning outcomes (SLOs)** — for the entire course. Pre-filled from the mode file's `learningOutcomes` on selection; local edits are saved per mode and win over the defaults (clear the box to restore them).

Both lists attach to every saved session (`learningObjectives`, `courseOutcomes`) and feed the report's **Deep Analysis** pass, which judges each objective/outcome covered / partial / missed with timestamped evidence, estimated minutes spent, and an accuracy comment. Cumulative rollup across a course's sessions is still future work.

### Nonlecture activity tracking

Speaker diarization from one mic isn't feasible in the browser, so class-time structure is marked **manually**: a big on-screen button plus a hotkey (**spacebar**) that **toggles Nonlecture Activity** (lab work, a video, group exercise). In rehearsal, you toggle it where the activity *would* happen.

While a nonlecture block is open, the app is **not recording**: speech recognition, the audio recording, and the energy analysis all pause, and a **red frame surrounds the UI** so the state is unmistakable. Three timers run on the live dashboard — **lecture**, **nonlecture activity**, and **total** — and the lecture-vs-nonlecture split is saved as a session data point. Each block becomes a timestamped `nonlecture` interval — the raw material for the monologue-length graph (continuous lecture stretches between activities).

---

## Metrics (what gets measured)

| Metric | Source | Live? |
|---|---|---|
| **Speaking pace (WPM)** | Word count over a rolling window measured in **lecture time only** (nonlecture blocks don't dilute the rate), classified into research-based bands (see *Pacing scale* below) | ✅ live gauge |
| **Filler words & verbal tics** | Auto-detected against a built-in filler list (`um, uh, like, you know, so, right?, okay?`; extensible in Scoring Settings) | ✅ live counter (a floor — Web Speech drops many), final counts from the verbatim precision transcript |
| **Stutters & restarts** | Precision-transcript word timestamps: repeated words ("the the"), part-word stutters ("th-that"), abandoned restarts, long mid-sentence hesitations | ❌ post-session only |
| **Vocal energy / tone** | Web Audio API: pitch variance (monotone detection) + volume dynamics, computed locally | ✅ live meter |
| **Lecture vs nonlecture time** | Nonlecture toggle events — lecture/activity/total timers, longest continuous lecture stretch, stretch trend across the class | ✅ live timeline + timers |
| **Accuracy** | The active fact-check model reviews the precision transcript against the mode file; each flagged claim gets a quote, an explanation, and a severity | ❌ post-session only |

---

### Pacing scale (research-based)

Bands come from `Words_Per_Minute_Research.md` — there is no single perfect WPM, so the app classifies the rolling rate into zones and uses coaching language rather than "good/bad". Two selectable **pacing profiles** shift the zones:

| Zone | Standard lecture | Dense · note-heavy | Live label | Gauge color |
|---|---|---|---|---|
| Very slow | < 100 | < 95 | VERY SLOW | yellow |
| Deliberate | 100–115 | 95–109 | DELIBERATE | yellow |
| Sweet spot | **116–150** | **110–135** | SWEET SPOT | green |
| Brisk | 151–165 | 136–150 | BRISK | yellow |
| Fast | 166–179 | 151–165 | FAST FOR NOTES | orange |
| Too fast | 180+ | 166+ | TOO FAST | red |

Slowing down is treated as potentially useful (slow zones keep most scoring credit); the clearest research concern is **sustained speed**, so holding a fast/too-fast zone for 45 s (configurable) escalates the live gauge to a blinking "SUSTAINED FAST — SLOW FOR NOTES" and costs extra pace points. The dial is painted with the active profile's zones, and the report shows time-in-zone percentages plus orange/red threshold lines on the pace chart.

## The Rating

Every session ends with **five 0–100 subscores and one headline score**:

| Subscore | Fed by |
|---|---|
| **Pace** | Research-band credit per timeline sample (sweet spot = full credit, slow zones keep most credit, fast zones little) minus penalties for **sustained fast stretches** |
| **Clarity** | Fillers per minute + stutters/restarts per minute |
| **Engagement** | Nonlecture-activity frequency and continuous-lecture stretch lengths (marathon monologues cost points) |
| **Vocal Energy** | Pitch/volume variance — monotone stretches cost points |
| **Accuracy** | Count and severity of fact-check flags |

Headline score = weighted average (weights and thresholds live in the **Scoring Settings** panel). Scores are stored per session so you can **beat your last lecture** — trend lines across sessions live on the history page.

> Tunables (target WPM bands, points per filler, monologue thresholds, weights) are user-facing settings; the fixed model-shape constants are named and documented in `scoring.js` / `attention.js` / `metrics.js`. Expect to tune after a few real sessions.

---

## Screens

### 1. Session Setup
Mode selector, lecture length, pacing profile, mic check (input level meter), **learning objectives / course outcomes** (typed or uploaded; outcomes pre-fill from the mode), big **GO LIVE** button plus **Upload MP4**. Filler words are auto-detected — no configuration needed.

### 2. Live Dashboard (the main event)
Everything glanceable from 10 feet away:

- **Big gauges** — WPM dial with target band, fillers-per-minute counter, and a stopwatch counting continuous lecture time since the last nonlecture block.
- **Vocal energy meter** — live bar from the pitch/volume analysis; dips toward "monotone" as delivery flattens.
- **Timeline strip** — a growing horizontal bar along the bottom: lecture time in one color, nonlecture blocks overlaid in red. The monologue graph, forming in real time.
- **Three timers** — lecture, nonlecture activity, and total, always visible.
- **Scrolling live transcript** — real-time captions with fillers highlighted as they happen. **Toggleable**, since it can be distracting mid-lecture.
- **The nonlecture toggle** — huge, unmissable, also bound to spacebar. Press when a lab/video starts, press again to resume lecture.
- **ON AIR indicator** — unambiguous mic-hot state. During nonlecture activity the lamp goes dark and a **red frame surrounds the whole UI** (not recording).

### 3. Post-Session Report
Appears after the transcription + fact-check passes finish (with progress states, since this takes ~30–90 s):

- Headline score + five subscores, compared against your previous sessions.
- **Monologue graph** — talk-duration bars between interactions across the lecture.
- WPM-over-time line with target band; energy-over-time line.
- Filler/tic breakdown table (which words, how often, when).
- Stutter/restart list with transcript context.
- **Accuracy report** — each flagged statement quoted, with the model's explanation and severity.
- **Deep Analysis** — a manual button (with a pre-run cost estimate) that runs the thorough content review + objective/outcome alignment; results save with the session.
- Full transcript, annotated (fillers highlighted, interactions marked, flags linked).
- **Save Session** (→ localStorage) and **Export JSON** (→ download) buttons.

### 4. History
List of saved sessions with headline scores, subscore trends across time, personal records (longest stretch under 2 fillers/min, best engagement score…). Import button to re-load an exported JSON.

---

## Privacy (Live Classroom mode)

A live classroom mic picks up student voices — minors — so Live mode applies stricter rules:

1. **Student speech is never fact-checked or scored.** Nonlecture activity isn't recorded at all, and the transcript just after each block ends is treated as potentially containing student speech.
2. **Transcripts from Live sessions never leave the browser except for the two processing calls** (Whisper, Claude), and the audio-deletion rule above applies doubly.
3. Saved Live-session data stays in localStorage / local JSON export only. Nothing is retained server-side.
4. Future consideration (not v1): auto-redact a window of transcript around each nonlecture boundary.

Rehearsal mode has no such concerns — it's just you.

---

## Data Model (saved session JSON)

```json
{
  "version": 1,
  "sessionId": "2026-07-10T09-15-00",
  "mode": "intro-python",
  "type": "live",
  "durationSec": 2940,
  "lectureSec": 2160,
  "nonlectureSec": 780,
  "scores": { "overall": 78, "pace": 85, "clarity": 62, "engagement": 74, "vocalEnergy": 81, "accuracy": 88 },
  "timeline": {
    "wpm": [[0, 142], [30, 156]],
    "energy": [[0, 0.7], [30, 0.55]],
    "nonlecture": [[312, 610], [1290, 1772]],
    "fillers": [{ "t": 45, "word": "um" }],
    "stutters": [{ "t": 122, "kind": "repeat", "text": "the the" }]
  },
  "accuracyFlags": [
    { "t": 610, "quote": "strings in Python are mutable", "severity": "high", "explanation": "Python strings are immutable…" }
  ],
  "transcript": [{ "t": 0, "end": 4.2, "text": "Alright, today we're talking about loops." }],
  "customFillerList": ["um", "uh", "right?"],
  "learningObjectives": ["Students can write a for loop over a list"],
  "courseOutcomes": ["Design, implement, and debug small Python programs"],
  "deepAnalysis": {
    "summary": "…", "contentFindings": [], "objectives": [
      { "text": "…", "scope": "lecture", "status": "covered", "minutes": 6, "evidence": [{ "t": 310, "note": "…" }], "comment": "…" }
    ],
    "suggestions": ["…"], "model": "claude-opus-4-8", "costUSD": 0.14, "ranAt": "2026-07-12T15:40"
  }
}
```

(`deepAnalysis` is present only if the instructor ran the manual deep-analysis pass for that session.)

## API Surface (Express)

| Route | Purpose |
|---|---|
| `GET /api/modes` | List available mode files |
| `GET /api/status` | Key/ffmpeg configuration state (never returns secrets) |
| `POST /api/transcribe` | Receives session audio → active transcription provider → returns word-timestamped transcript → **deletes audio** |
| `POST /api/transcribe-video` | Testing pipeline: MP4 upload → ffmpeg strips a small mono audio track (**video deleted immediately**, audio deleted after read) → active transcription provider → word-timestamped transcript |
| `POST /api/factcheck` | Receives transcript + mode id → active fact-check model → returns accuracy flags |
| `GET/POST /api/settings` | Dev panel provider switching: active providers + catalog with pricing (never returns secrets) |
| `POST /api/deep-analysis` | **Manual, paid pass** — transcript + mode + objectives/outcomes → active deep-analysis model → content review, per-outcome alignment (covered/partial/missed with timestamps + minutes), coaching suggestions |

Everything else — live transcription, tone analysis, metrics, scoring, storage — happens in the browser. API keys live in server environment variables (or `.env` locally) and never reach the client.

**Estimated running cost:** a 50-minute lecture ≈ $0.30 transcription (AssemblyAI or Whisper) + under a cent for the Haiku fact-check. The optional deep-analysis button adds roughly $0.10–0.25 on Opus 4.8 (estimate shown before you click; actual cost shown after). Well under $1/lecture either way.

---

## Design Direction: Broadcast Studio / ON AIR

Dark control-room aesthetic. The app should feel like a radio studio console:

- **Recording-red** accent reserved for mic-hot states; the ON AIR sign is the emotional center of the live screen.
- VU-meter-styled gauges and level meters; monospaced numeric readouts.
- High-contrast, glanceable typography on the live dashboard — designed to be read from across a classroom.
- Post-session report can relax into a denser editorial layout, but stays in the same dark studio family.
- Build with the `ui-ux-pro-max` and `frontend-design` skills; this app should look **incredible**, not like a bootstrapped dashboard.

---

## Build Phases

### Phase 1 — Live core (no external APIs)
Session setup, Web Speech live transcription, WPM gauge, live filler counting, interaction button + timeline strip, Web Audio energy meter, ON AIR state, session end → basic report from live data only, localStorage save + JSON export/import, history page.
**Fully usable and free at the end of this phase.**

### Phase 2 — Precision pass
In-browser audio recording (MediaRecorder), `/api/transcribe` with Whisper, stutter/restart detection, upgraded report built from the precise transcript, audio-deletion guarantee.

### Phase 3 — Fact-checking & scoring
Mode file format, `/api/factcheck` with Claude, accuracy report, full five-subscore rating system, score trends and personal records.

### Testing pipeline — Upload MP4

Next to GO LIVE, an **Upload MP4** button (always visible; the server reports a clear error if ffmpeg or the transcription key is missing) runs a recorded lecture through the *exact same* analysis code as a live session — the point is predictable, repeatable testing of every feature:

- Server extracts a mono 16 kHz Opus track with ffmpeg (~12 MB for 50 min); the **video is deleted the moment extraction finishes** and the audio right after transcription.
- Precision-transcript word timestamps drive the same filler/stutter/WPM/attention/fact-check/scoring paths as live sessions.
- **Silence inference**: word gaps ≥ 2 min (configurable: "Upload: silence = activity") become inferred nonlecture blocks, so Engagement and the Attention resets behave realistically.
- Vocal energy is not computed for uploads (v1); its weight is renormalized out, like an unavailable accuracy pass.
- Upload sessions are tagged (`type: "upload"`, filename shown), appear in History with an ⬆ badge, and are **excluded from personal records and trend lines** so test runs never pollute real coaching data.

### Phase 5 — Swappable providers & deep analysis ✅ (shipped)
Provider adapter layer (`providers/`) with a catalog of transcription + analysis endpoints; dev-panel switching persisted server-side; AssemblyAI verbatim disfluency transcription as the default precision pass; the **AI objective-coverage analysis** shipped as the manual Deep Analysis pass — per-objective covered/partial/missed with timestamped evidence, estimated minutes, accuracy commentary, and coaching suggestions, with a cost estimate before the run and actual cost after.

### Phase 6 — Future ideas (not committed)
More modes; planned-topic coverage checks ("you never got to Z today"); transcript redaction around nonlecture boundaries; comparing rehearsal vs. live runs of the same lecture; **course-level SLO rollup** — cumulative coverage of the student learning outcomes across all saved sessions of a mode, showing which SLOs are on track and which are starving; Deepgram as a third transcription provider; a live audio-based "hesitations" counter (long mid-sentence silences).

---

## Known Constraints & Open Questions

- **Chrome only** (Web Speech API). Acceptable for a single-user tool; note it on the setup screen.
- Web Speech API in Chrome **routes audio through Google's servers** for recognition — worth knowing even though we store nothing. If this ever becomes unacceptable for Live mode, the fallback is local-only Web Audio metrics live + Whisper after.
- Long sessions: a 50-min class produces a ~30–70 MB audio file (format-dependent). Compress to a low-bitrate format (e.g., 32 kbps Opus) before upload; Whisper handles it fine and the upload stays small.
- Render free tier spins down on idle — the first `/api/transcribe` after class may hit a cold start. Post-session processing already has a progress state, so this is cosmetic.
- Scoring weights and thresholds need real-world tuning; ship them as visible settings.
- Mic quality matters for pitch detection — test with the actual classroom mic early in Phase 1.
