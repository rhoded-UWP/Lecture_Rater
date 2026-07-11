# Lecture Rater

A web app that listens to you teach — live in the classroom or in rehearsal — and coaches your lecture delivery. It transcribes as you speak, tracks pace, filler words, stutters, and vocal energy, graphs continuous lecture time between nonlecture activities, and fact-checks what you told them afterward.

**Status:** Built — Phase 1 complete; Phase 2/3 server routes implemented (activate by setting API keys)
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
| `OPENAI_API_KEY` | Whisper precision transcript, stutter/restart detection |
| `ANTHROPIC_API_KEY` | Claude fact-check + deep analysis |
| `ASSEMBLYAI_API_KEY` | AssemblyAI as an alternative transcription provider |
| `DEEPSEEK_API_KEY` | DeepSeek as an alternative (budget) analysis provider |
| `MOONSHOT_API_KEY` | Kimi K2 as an alternative analysis provider |

A missing key just greys that provider out in the dev panel — nothing breaks.

### Swappable AI providers

Every AI endpoint is swappable at runtime from **⚙ Developer Tools** (bottom-left) — no restart:

- **Transcription — precision pass:** OpenAI Whisper or AssemblyAI
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
| Precision transcription | **OpenAI Whisper API** (post-session) | Word-level timestamps for stutter/tic analysis (~$0.36/hr of audio) |
| Fact-checking | **Claude API** (post-session batch) | Reviews transcript against the active mode's content file |
| Vocal tone analysis | Web Audio API (in browser, free) | Pitch variance + volume dynamics, computed locally in real time |
| Storage | Browser `localStorage` + JSON file export | Nothing persisted server-side (Render disk is ephemeral anyway) |

### Why the hybrid transcription?

- **Web Speech API** is free and real-time, but it auto-cleans speech — it tends to silently drop "um"s and repeated words, which is exactly what we want to count.
- **Whisper** gives an accurate transcript with word-level timestamps, ideal for detecting stutters, restarts, and hesitations — but it's batch, not live.
- So: Web Speech powers the **live dashboard**; the browser also records audio locally during the session, and when you hit *End Session*, uploads it once for the Whisper precision pass. The final report is built from the Whisper transcript.

### Audio handling rule (non-negotiable)

Audio is recorded **in the browser only**, uploaded **once** to the Express server, forwarded to Whisper, and **deleted immediately** after transcription returns. No recording is ever stored on the server or in the saved session data. The saved artifact is transcript + metrics only.

---

## Core Concepts

### Sessions

A session starts when you arm the mic and ends when you stop it. At session start you choose:

1. **Mode** — the subject being taught (v1 ships with *Intro to Python* only).
2. **Session type** — `Rehearsal` or `Live Classroom`.

Rehearsal is you practicing alone. Live is a real class with real students — which changes the privacy rules (see below).

### Modes

A mode is a content/context file, one per subject, stored in the repo at `modes/*.json`. It tells the fact-checker what's being taught and how strict to be.

```json
{
  "id": "intro-python",
  "title": "Intro to Python",
  "subject": "Python programming for first-time programmers",
  "level": "intro",
  "strictness": "Flag statements that are wrong, and oversimplifications likely to cause misconceptions later. Do not flag reasonable pedagogical simplification.",
  "topics": ["variables", "types", "strings", "input/print", "conditionals", "loops", "functions", "lists"],
  "misconceptionTraps": [
    "Confusing = (assignment) with == (comparison)",
    "Saying variables 'store' values vs. referencing objects — fine at intro level, don't flag",
    "input() returns a string — forgetting to mention casting"
  ]
}
```

Adding a future mode = adding a file. The mode selector reads whatever files exist. No code changes.

### Learning objectives & outcomes

The Session Setup console accepts two optional lists, typed in or uploaded as `.txt`/`.md` (one per line) or `.json` (array of strings):

1. **Lecture objectives** — what this session is supposed to teach. Drafted per session.
2. **Student learning outcomes (SLOs)** — for the entire course. Saved per mode and reloaded whenever that mode is selected.

Both lists are stored locally and attached to every saved session (`learningObjectives`, `courseOutcomes`), so the data is already in place for the planned AI coverage analysis (see Build Phases): using the transcript to determine **how much time was spent on each learning objective** and to summarize **how much related content was relayed, and how accurately** — both for a single lecture and cumulatively across the course's sessions.

### Nonlecture activity tracking

Speaker diarization from one mic isn't feasible in the browser, so class-time structure is marked **manually**: a big on-screen button plus a hotkey (**spacebar**) that **toggles Nonlecture Activity** (lab work, a video, group exercise). In rehearsal, you toggle it where the activity *would* happen.

While a nonlecture block is open, the app is **not recording**: speech recognition, the audio recording, and the energy analysis all pause, and a **red frame surrounds the UI** so the state is unmistakable. Three timers run on the live dashboard — **lecture**, **nonlecture activity**, and **total** — and the lecture-vs-nonlecture split is saved as a session data point. Each block becomes a timestamped `nonlecture` interval — the raw material for the monologue-length graph (continuous lecture stretches between activities).

---

## Metrics (what gets measured)

| Metric | Source | Live? |
|---|---|---|
| **Speaking pace (WPM)** | Web Speech word count over a rolling 30 s window, classified into research-based bands (see *Pacing scale* below) | ✅ live gauge |
| **Filler words & verbal tics** | Auto-detected against a built-in filler list (`um, uh, like, you know, so, right?, okay?`; extensible in `config.js`) | ✅ live counter (Web Speech catches some), final counts from Whisper |
| **Stutters & restarts** | Whisper word timestamps: repeated words ("the the"), abandoned sentence restarts, long mid-sentence hesitations | ❌ post-session only |
| **Vocal energy / tone** | Web Audio API: pitch variance (monotone detection) + volume dynamics, computed locally | ✅ live meter |
| **Lecture vs nonlecture time** | Nonlecture toggle events — lecture/activity/total timers, longest continuous lecture stretch, stretch trend across the class | ✅ live timeline + timers |
| **Accuracy** | Claude reviews the Whisper transcript against the mode file; each flagged claim gets a quote, an explanation, and a severity | ❌ post-session only |

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

Headline score = weighted average (weights configurable in a settings panel; defaults TBD during build). Scores are stored per session so you can **beat your last lecture** — trend lines across sessions are a v1 feature of the history page.

> Exact scoring formulas are a build-time decision — expect to tune them after a few real sessions. First implementation should make every constant (target WPM band, points per filler, monologue threshold) a named config value, not a magic number.

---

## Screens

### 1. Session Setup
Mode selector, Rehearsal/Live toggle, pacing profile, mic check (input level meter), **learning objectives / course outcomes upload**, big **GO LIVE** button. Filler words are auto-detected — no configuration needed.

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
Appears after the Whisper + Claude passes finish (with progress states, since this takes ~30–90 s):

- Headline score + five subscores, compared against your previous sessions.
- **Monologue graph** — talk-duration bars between interactions across the lecture.
- WPM-over-time line with target band; energy-over-time line.
- Filler/tic breakdown table (which words, how often, when).
- Stutter/restart list with transcript context.
- **Accuracy report** — each flagged statement quoted, with Claude's explanation and severity.
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
  "courseOutcomes": ["Design, implement, and debug small Python programs"]
}
```

## API Surface (Express)

| Route | Purpose |
|---|---|
| `GET /api/modes` | List available mode files |
| `GET /api/status` | Key/ffmpeg configuration state (never returns secrets) |
| `POST /api/transcribe` | Receives session audio → Whisper → returns word-timestamped transcript → **deletes audio** |
| `POST /api/transcribe-video` | Testing pipeline: MP4 upload → ffmpeg strips a small mono audio track (**video deleted immediately**, audio deleted after read) → Whisper → word-timestamped transcript |
| `POST /api/factcheck` | Receives transcript + mode id → active fact-check model → returns accuracy flags |
| `GET/POST /api/settings` | Dev panel provider switching: active providers + catalog with pricing (never returns secrets) |
| `POST /api/deep-analysis` | **Manual, paid pass** — transcript + mode + objectives/outcomes → active deep-analysis model → content review, per-outcome alignment (covered/partial/missed with timestamps + minutes), coaching suggestions |

Everything else — live transcription, tone analysis, metrics, scoring, storage — happens in the browser. API keys live in server environment variables (or `.env` locally) and never reach the client.

**Estimated running cost:** a 50-minute lecture ≈ $0.30 (Whisper) + a few cents (Claude, using a small model like Haiku for the fact-check pass). Well under $1/lecture.

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

Next to GO LIVE, an **Upload MP4** button (visible only when the server has ffmpeg and `OPENAI_API_KEY`) runs a recorded lecture through the *exact same* analysis code as a live session — the point is predictable, repeatable testing of every feature:

- Server extracts a mono 16 kHz Opus track with ffmpeg (~12 MB for 50 min); the **video is deleted the moment extraction finishes** and the audio right after transcription. Local-machine testing feature — the button hides itself if ffmpeg is absent (e.g., on Render).
- Whisper word timestamps drive the same filler/stutter/WPM/attention/fact-check/scoring paths as live sessions.
- **Silence inference**: word gaps ≥ 2 min (configurable: "Upload: silence = activity") become inferred nonlecture blocks, so Engagement and the Attention resets behave realistically.
- Vocal energy is not computed for uploads (v1); its weight is renormalized out, like an unavailable accuracy pass.
- Upload sessions are tagged (`type: "upload"`, filename shown), appear in History with an ⬆ badge, and are **excluded from personal records and trend lines** so test runs never pollute real coaching data.

### Phase 4 — Polish & future ideas (not committed)
More modes; planned-topic coverage checks ("you never got to Z today"); transcript redaction around nonlecture boundaries; per-lecture written coaching summary from Claude; comparing rehearsal vs. live runs of the same lecture.

**AI objective-coverage analysis** (objectives/outcomes capture already ships in Phase 1):
- Map transcript segments to the session's learning objectives and report **time spent on each objective** (including "never covered").
- Combine with the fact-check pass to summarize **how much related content was relayed for each objective, and how accurately**.
- Roll the same analysis up to the course level: cumulative coverage of the **student learning outcomes** across all saved sessions of a mode, showing which SLOs are on track and which are starving.

---

## Known Constraints & Open Questions

- **Chrome only** (Web Speech API). Acceptable for a single-user tool; note it on the setup screen.
- Web Speech API in Chrome **routes audio through Google's servers** for recognition — worth knowing even though we store nothing. If this ever becomes unacceptable for Live mode, the fallback is local-only Web Audio metrics live + Whisper after.
- Long sessions: a 50-min class produces a ~30–70 MB audio file (format-dependent). Compress to a low-bitrate format (e.g., 32 kbps Opus) before upload; Whisper handles it fine and the upload stays small.
- Render free tier spins down on idle — the first `/api/transcribe` after class may hit a cold start. Post-session processing already has a progress state, so this is cosmetic.
- Scoring weights and thresholds need real-world tuning; ship them as visible settings.
- Mic quality matters for pitch detection — test with the actual classroom mic early in Phase 1.
