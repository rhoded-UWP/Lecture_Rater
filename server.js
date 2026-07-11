// Lecture Rater — Express server.
// Serves the static front end plus the API routes. All session state lives
// in the browser; this server holds nothing except dev-settings.json (which
// provider/model each pipeline role uses). Audio is received in memory,
// forwarded to the active transcription provider, and released — it is never
// written to disk.
//
// Provider swapping: providers/catalog.js declares every available endpoint;
// settings-store.js remembers the active choice; the dev panel switches it
// at runtime via /api/settings.

import express from 'express';
import multer from 'multer';
import { readdir, readFile, unlink } from 'fs/promises';
import { readFileSync } from 'fs';
import { spawn } from 'child_process';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

// Load .env if present (local development). Built-in so it works on any Node
// version and any host — no flags, no dependency. Real env vars (e.g. from
// the Render dashboard) always win; .env only fills in what's unset.
{
  const dir = path.dirname(fileURLToPath(import.meta.url));
  try {
    for (const line of readFileSync(path.join(dir, '.env'), 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m || line.trim().startsWith('#')) continue;
      const val = m[2].replace(/^["']|["']$/g, '');
      if (val && !(m[1] in process.env)) process.env[m[1]] = val;
    }
  } catch {
    /* no .env — env vars come from the host (Render) */
  }
}

import {
  TRANSCRIPTION_PROVIDERS,
  ANALYSIS_MODELS,
  findAnalysisModel,
  isConfigured,
} from './providers/catalog.js';
import { transcribeAudio } from './providers/transcription.js';
import { runAnalysis, extractJson } from './providers/analysis.js';
import { getSettings, updateSettings } from './settings-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODES_DIR = path.join(__dirname, 'modes');
const PORT = process.env.PORT || 3000;

// Audio stays in memory only (the non-negotiable rule). 120 MB ceiling covers
// a 50-minute lecture even in an uncompressed-ish format.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 120 * 1024 * 1024 },
});

// Video uploads (the MP4 testing pipeline) are too large for memory — they
// hit a temp file, ffmpeg strips the audio, and BOTH files are deleted
// immediately. Nothing persists.
const uploadVideo = multer({
  dest: tmpdir(),
  limits: { fileSize: 3 * 1024 * 1024 * 1024 },
});

// ffmpeg powers /api/transcribe-video; probe once at startup so /api/status
// can tell the client whether to show the Upload MP4 button.
let ffmpegOk = false;
{
  const probe = spawn('ffmpeg', ['-version']);
  probe.on('error', () => { ffmpegOk = false; });
  probe.on('close', (code) => { ffmpegOk = code === 0; });
}

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '10mb' }));

// --------------------------------------------------------------- /api/status
// Lightweight health/config summary. Never returns key material.
app.get('/api/status', (_req, res) => {
  const s = getSettings();
  res.json({
    whisperConfigured: !!process.env.OPENAI_API_KEY,
    claudeConfigured: !!process.env.ANTHROPIC_API_KEY,
    factcheckModel: s.factcheckModelId,
    transcriptionProvider: s.transcriptionProvider,
    deepAnalysisModel: s.deepAnalysisModelId,
    ffmpeg: ffmpegOk,
    uptimeSec: Math.round(process.uptime()),
  });
});

// ------------------------------------------------------------- /api/settings
// The dev panel's provider-swap surface. GET returns the active settings plus
// the full catalog (with configured flags + pricing for cost estimates);
// POST applies a partial update and returns the same payload.

function settingsPayload() {
  const s = getSettings();
  return {
    settings: s,
    transcriptionProviders: TRANSCRIPTION_PROVIDERS.map((p) => ({
      id: p.id,
      label: p.label,
      model: p.model,
      envKey: p.envKey,
      configured: isConfigured(p),
      costPerMin: p.costPerMin,
      approxPricing: p.approxPricing,
    })),
    analysisModels: ANALYSIS_MODELS.map((m) => ({
      id: m.id,
      label: m.label,
      provider: m.providerLabel,
      envKey: m.envKey,
      configured: isConfigured(m),
      pricing: m.pricing,
      approxPricing: m.approxPricing,
    })),
  };
}

app.get('/api/settings', (_req, res) => res.json(settingsPayload()));

app.post('/api/settings', (req, res) => {
  updateSettings(req.body || {});
  res.json(settingsPayload());
});

// ---------------------------------------------------------------- /api/modes
app.get('/api/modes', async (_req, res) => {
  try {
    const files = (await readdir(MODES_DIR)).filter((f) => f.endsWith('.json'));
    const modes = [];
    for (const f of files) {
      try {
        modes.push(JSON.parse(await readFile(path.join(MODES_DIR, f), 'utf8')));
      } catch {
        console.warn(`Skipping unparseable mode file: ${f}`);
      }
    }
    res.json(modes);
  } catch (err) {
    res.status(500).json({ error: `Could not read modes directory: ${err.message}` });
  }
});

async function loadMode(modeId) {
  const safeId = String(modeId).replace(/[^a-z0-9-_]/gi, '');
  return JSON.parse(await readFile(path.join(MODES_DIR, `${safeId}.json`), 'utf8'));
}

// ----------------------------------------------------------- /api/transcribe
// Browser uploads the session audio once → active transcription provider
// (word timestamps) → the buffer is dropped. Nothing persisted.
app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
  if (!req.file || !req.file.buffer?.length) {
    return res.status(400).json({ error: 'No audio file received.' });
  }
  try {
    const result = await transcribeAudio(
      getSettings().transcriptionProvider,
      req.file.buffer,
      req.file.mimetype || 'audio/webm',
      req.file.originalname || 'session.webm'
    );
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, detail: err.detail || undefined });
  } finally {
    // Audio-deletion guarantee: memory storage means nothing ever hit disk;
    // drop the reference so the buffer is collectable immediately.
    if (req.file) req.file.buffer = null;
  }
});

// ----------------------------------------------------- /api/transcribe-video
// The MP4 testing pipeline: an uploaded lecture video hits a temp file,
// ffmpeg strips a small mono 16 kHz Opus track (watch-skill recipe — a
// 75-minute lecture stays well under Whisper's 25 MB cap), the VIDEO is
// deleted the moment extraction finishes, the audio is deleted right after
// it's read into memory, and the transcript comes back word-timestamped.
app.post('/api/transcribe-video', uploadVideo.single('video'), async (req, res) => {
  const rmQuiet = (p) => unlink(p).catch(() => {});
  if (!req.file) {
    return res.status(400).json({ error: 'No video file received.' });
  }
  const videoPath = req.file.path;
  const audioPath = `${videoPath}.ogg`;
  if (!ffmpegOk) {
    await rmQuiet(videoPath);
    return res.status(503).json({ error: 'ffmpeg is not available on this server — the MP4 pipeline is a local testing feature.' });
  }
  try {
    await new Promise((resolve, reject) => {
      const ff = spawn('ffmpeg', [
        '-y', '-i', videoPath,
        '-vn', '-ac', '1', '-ar', '16000',
        '-c:a', 'libopus', '-b:a', '32k',
        audioPath,
      ]);
      let errTail = '';
      ff.stderr.on('data', (d) => { errTail = (errTail + d).slice(-400); });
      ff.on('error', reject);
      ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${errTail}`))));
    });
    await rmQuiet(videoPath); // deletion guarantee: video gone before transcription

    const audio = await readFile(audioPath);
    await rmQuiet(audioPath); // audio now exists only in memory

    const result = await transcribeAudio(
      getSettings().transcriptionProvider,
      audio,
      'audio/ogg',
      'lecture.ogg'
    );
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, detail: err.detail || undefined });
  } finally {
    await rmQuiet(videoPath);
    await rmQuiet(audioPath);
  }
});

// ------------------------------------------------------------ /api/factcheck
// Quick pass: transcript + mode id → active fact-check model reviews against
// the mode file → accuracy flags. Runs automatically after every session.
app.post('/api/factcheck', async (req, res) => {
  const { transcript, modeId } = req.body || {};
  if (!Array.isArray(transcript) || !transcript.length || !modeId) {
    return res.status(400).json({ error: 'Expected { transcript: [{t, text}], modeId }.' });
  }

  let mode;
  try {
    mode = await loadMode(modeId);
  } catch {
    return res.status(404).json({ error: `Unknown mode: ${modeId}` });
  }
  if (mode.factcheck === false) {
    return res.status(400).json({ error: `Mode "${mode.title}" has fact-checking disabled.` });
  }

  const transcriptText = transcript.map((s) => `[${stamp(s.t)}] ${s.text}`).join('\n');
  const topicsLine = mode.topics?.length ? `\nTopics: ${mode.topics.join(', ')}` : '';
  const trapsBlock = mode.misconceptionTraps?.length
    ? `\nKnown misconception traps to watch for:\n${mode.misconceptionTraps.map((m) => `- ${m}`).join('\n')}`
    : '';
  const prompt = `You are fact-checking a recorded lecture for the instructor's own coaching. Course context:

Subject: ${mode.subject}
Level: ${mode.level}${topicsLine}
Strictness policy: ${mode.strictness}${trapsBlock}

Review the lecture transcript below. Flag only factual errors and oversimplifications likely to cause misconceptions later, per the strictness policy. Reasonable pedagogical simplification is fine. The transcript is machine-generated, so ignore transcription artifacts and garbled words.

Respond with ONLY a JSON array (no prose, no code fence). Each element:
{"t": <seconds into lecture, from the [mm:ss] stamps>, "quote": "<the problematic statement, quoted or closely paraphrased from the transcript>", "severity": "low"|"medium"|"high", "explanation": "<why it's wrong and what's correct, 1-3 sentences>"}

If nothing warrants a flag, respond with [].

TRANSCRIPT:
${transcriptText}`;

  try {
    const result = await runAnalysis(getSettings().factcheckModelId, prompt, { maxTokens: 4000 });
    const parsed = extractJson(result.text, 'array');
    if (parsed === null && /\[/.test(result.text)) {
      return res.status(502).json({ error: 'Fact-check response was not valid JSON.', raw: result.text.slice(0, 500) });
    }
    const flags = (parsed || [])
      .filter((f) => f && typeof f.quote === 'string' && ['low', 'medium', 'high'].includes(f.severity))
      .map((f) => ({ ...f, t: toSeconds(f.t) }));
    res.json({
      flags,
      model: result.model,
      provider: result.provider,
      usage: result.usage,
      costUSD: result.costUSD,
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: `Fact-check failed: ${err.message}`, detail: err.detail || undefined });
  }
});

// -------------------------------------------------------- /api/deep-analysis
// The paid, on-demand pass — NEVER runs automatically. Does a thorough
// content review plus learning-outcome alignment: for each lecture objective
// and course outcome, was it covered, how much time did it get, and was the
// related content accurate?
app.post('/api/deep-analysis', async (req, res) => {
  const { transcript, modeId, lectureObjectives = [], courseOutcomes = [] } = req.body || {};
  if (!Array.isArray(transcript) || !transcript.length) {
    return res.status(400).json({ error: 'Expected { transcript: [{t, text}], modeId, lectureObjectives?, courseOutcomes? }.' });
  }

  let mode = null;
  try {
    if (modeId) mode = await loadMode(modeId);
  } catch {
    /* unknown mode — proceed with generic context */
  }

  // Outcomes come from two places (the "Both" design): the mode file's
  // course-level learningOutcomes, plus whatever the instructor typed for
  // this session. Dedupe by exact text.
  const courseLevel = [...new Set([...(mode?.learningOutcomes || []), ...courseOutcomes])];
  const lectureLevel = [...new Set(lectureObjectives)];

  const transcriptText = transcript.map((s) => `[${stamp(s.t)}] ${s.text}`).join('\n');
  const contextBlock = mode
    ? `Subject: ${mode.subject}\nLevel: ${mode.level}${mode.topics?.length ? `\nTopics: ${mode.topics.join(', ')}` : ''}\nStrictness policy: ${mode.strictness}`
    : 'Subject: infer the discipline and audience level from the transcript itself.';
  const objBlock = lectureLevel.length
    ? `\nLECTURE OBJECTIVES (this session):\n${lectureLevel.map((o) => `- ${o}`).join('\n')}`
    : '';
  const outBlock = courseLevel.length
    ? `\nCOURSE LEARNING OUTCOMES:\n${courseLevel.map((o) => `- ${o}`).join('\n')}`
    : '';

  const prompt = `You are performing a deep instructional analysis of a recorded lecture for the instructor's own coaching. Course context:

${contextBlock}
${objBlock}${outBlock}

Do THREE things with the transcript below:

1. CONTENT REVIEW (thorough): identify factual errors, misleading oversimplifications, imprecise definitions, and important caveats that were skipped. Reasonable pedagogical simplification for the level is fine and should NOT be flagged. The transcript is machine-generated — ignore transcription artifacts and garbled words.

2. OUTCOME ALIGNMENT: for EACH lecture objective and course outcome listed above, judge whether this lecture covered it. Use the [mm:ss] stamps to cite where, and estimate roughly how many minutes were spent on it. If no objectives/outcomes were provided, infer 3-6 apparent objectives from the lecture itself and assess those (mark them scope "inferred").

3. COACHING: a short overall summary and 2-4 concrete, actionable suggestions.

Respond with ONLY a JSON object (no prose, no code fence) in exactly this shape:
{
  "summary": "<2-4 sentence overview of the lecture's content quality and coverage>",
  "contentFindings": [{"t": <seconds>, "quote": "<statement>", "severity": "low"|"medium"|"high", "explanation": "<why + correction, 1-3 sentences>"}],
  "objectives": [{"text": "<the objective/outcome verbatim>", "scope": "lecture"|"course"|"inferred", "status": "covered"|"partial"|"missed", "minutes": <estimated minutes spent, number>, "evidence": [{"t": <seconds>, "note": "<what happened here>"}], "comment": "<1-2 sentence judgment, incl. accuracy of the related content>"}],
  "suggestions": ["<concrete suggestion>", "..."]
}

TRANSCRIPT:
${transcriptText}`;

  try {
    const result = await runAnalysis(getSettings().deepAnalysisModelId, prompt, { maxTokens: 8000 });
    const parsed = extractJson(result.text, 'object');
    if (!parsed || typeof parsed !== 'object') {
      return res.status(502).json({ error: 'Deep-analysis response was not valid JSON.', raw: result.text.slice(0, 500) });
    }
    res.json({
      analysis: {
        summary: typeof parsed.summary === 'string' ? parsed.summary : '',
        contentFindings: Array.isArray(parsed.contentFindings)
          ? parsed.contentFindings
              .filter((f) => f && typeof f.quote === 'string')
              .map((f) => ({ ...f, t: toSeconds(f.t) }))
          : [],
        objectives: Array.isArray(parsed.objectives)
          ? parsed.objectives
              .filter((o) => o && typeof o.text === 'string')
              .map((o) => ({
                ...o,
                evidence: Array.isArray(o.evidence)
                  ? o.evidence.map((e) => ({ ...e, t: toSeconds(e?.t) }))
                  : [],
              }))
          : [],
        suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.filter((s) => typeof s === 'string') : [],
      },
      model: result.model,
      provider: result.provider,
      usage: result.usage,
      costUSD: result.costUSD,
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: `Deep analysis failed: ${err.message}`, detail: err.detail || undefined });
  }
});

const stamp = (t) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

// Models sometimes return timestamps as "mm:ss" strings despite being asked
// for seconds — normalize either form to a number so the UI clock renders.
function toSeconds(t) {
  if (typeof t === 'number' && Number.isFinite(t)) return t;
  if (typeof t === 'string') {
    const m = t.match(/^(\d+):(\d{1,2})$/);
    if (m) return Number(m[1]) * 60 + Number(m[2]);
    const n = Number(t);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

app.listen(PORT, () => {
  const s = getSettings();
  const flag = (envKey) => (process.env[envKey] ? 'key set' : `NOT configured (set ${envKey})`);
  console.log(`Lecture Rater on http://localhost:${PORT}`);
  console.log(`  Transcription:  ${s.transcriptionProvider} — OpenAI ${flag('OPENAI_API_KEY')} · AssemblyAI ${flag('ASSEMBLYAI_API_KEY')}`);
  console.log(`  Fact-check:     ${s.factcheckModelId} — Anthropic ${flag('ANTHROPIC_API_KEY')}`);
  console.log(`  Deep analysis:  ${s.deepAnalysisModelId} — DeepSeek ${flag('DEEPSEEK_API_KEY')} · Moonshot ${flag('MOONSHOT_API_KEY')}`);
});
