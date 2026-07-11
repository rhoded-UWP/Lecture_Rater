// Lecture Coach — Express server.
// Serves the static front end plus three API routes. All session state lives
// in the browser; this server holds nothing. Audio is received in memory,
// forwarded to Whisper, and released — it is never written to disk.

import express from 'express';
import multer from 'multer';
import { readdir, readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODES_DIR = path.join(__dirname, 'modes');
const PORT = process.env.PORT || 3000;

const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const FACTCHECK_MODEL = process.env.FACTCHECK_MODEL || 'claude-haiku-4-5-20251001';

// Audio stays in memory only (the non-negotiable rule). 120 MB ceiling covers
// a 50-minute lecture even in an uncompressed-ish format.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 120 * 1024 * 1024 },
});

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '10mb' }));

// --------------------------------------------------------------- /api/status
// Configuration state for the developer panel. Never returns key material —
// only whether each pass is configured and which model the server will use.
app.get('/api/status', (_req, res) => {
  res.json({
    whisperConfigured: !!OPENAI_KEY,
    claudeConfigured: !!ANTHROPIC_KEY,
    factcheckModel: FACTCHECK_MODEL,
    uptimeSec: Math.round(process.uptime()),
  });
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

// ----------------------------------------------------------- /api/transcribe
// Browser uploads the session audio once → Whisper (word timestamps) → the
// buffer is dropped. Nothing persisted.
app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
  if (!OPENAI_KEY) {
    return res.status(503).json({ error: 'Precision transcription is not configured (OPENAI_API_KEY missing).' });
  }
  if (!req.file || !req.file.buffer?.length) {
    return res.status(400).json({ error: 'No audio file received.' });
  }
  try {
    const form = new FormData();
    form.append(
      'file',
      new Blob([req.file.buffer], { type: req.file.mimetype || 'audio/webm' }),
      req.file.originalname || 'session.webm'
    );
    form.append('model', 'whisper-1');
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'word');
    form.append('timestamp_granularities[]', 'segment');

    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_KEY}` },
      body: form,
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      return res.status(502).json({ error: `Whisper request failed (${r.status})`, detail: detail.slice(0, 500) });
    }
    const data = await r.json();
    res.json({
      text: data.text || '',
      words: data.words || [],
      segments: (data.segments || []).map((s) => ({ t: s.start, end: s.end, text: s.text.trim() })),
      durationSec: data.duration ?? null,
    });
  } catch (err) {
    res.status(500).json({ error: `Transcription failed: ${err.message}` });
  } finally {
    // Audio-deletion guarantee: memory storage means nothing ever hit disk;
    // drop the reference so the buffer is collectable immediately.
    if (req.file) req.file.buffer = null;
  }
});

// ------------------------------------------------------------ /api/factcheck
// Transcript + mode id → Claude reviews against the mode file → accuracy flags.
app.post('/api/factcheck', async (req, res) => {
  if (!ANTHROPIC_KEY) {
    return res.status(503).json({ error: 'Fact-checking is not configured (ANTHROPIC_API_KEY missing).' });
  }
  const { transcript, modeId } = req.body || {};
  if (!Array.isArray(transcript) || !transcript.length || !modeId) {
    return res.status(400).json({ error: 'Expected { transcript: [{t, text}], modeId }.' });
  }

  let mode;
  try {
    const safeId = String(modeId).replace(/[^a-z0-9-_]/gi, '');
    mode = JSON.parse(await readFile(path.join(MODES_DIR, `${safeId}.json`), 'utf8'));
  } catch {
    return res.status(404).json({ error: `Unknown mode: ${modeId}` });
  }
  if (mode.factcheck === false) {
    return res.status(400).json({ error: `Mode "${mode.title}" has fact-checking disabled.` });
  }

  const stamp = (t) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
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
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: FACTCHECK_MODEL,
        max_tokens: 4000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      return res.status(502).json({ error: `Claude request failed (${r.status})`, detail: detail.slice(0, 500) });
    }
    const data = await r.json();
    const text = (data.content || []).map((b) => b.text || '').join('');
    const match = text.match(/\[[\s\S]*\]/); // tolerate stray prose around the array
    let flags = [];
    if (match) {
      try {
        flags = JSON.parse(match[0]).filter(
          (f) => f && typeof f.quote === 'string' && ['low', 'medium', 'high'].includes(f.severity)
        );
      } catch {
        return res.status(502).json({ error: 'Fact-check response was not valid JSON.', raw: text.slice(0, 500) });
      }
    }
    res.json({
      flags,
      model: data.model || FACTCHECK_MODEL,
      usage: data.usage
        ? { inputTokens: data.usage.input_tokens ?? 0, outputTokens: data.usage.output_tokens ?? 0 }
        : null,
    });
  } catch (err) {
    res.status(500).json({ error: `Fact-check failed: ${err.message}` });
  }
});

app.listen(PORT, () => {
  console.log(`Lecture Coach on http://localhost:${PORT}`);
  console.log(`  Whisper pass:    ${OPENAI_KEY ? 'configured' : 'NOT configured (set OPENAI_API_KEY)'}`);
  console.log(`  Fact-check pass: ${ANTHROPIC_KEY ? `configured (${FACTCHECK_MODEL})` : 'NOT configured (set ANTHROPIC_API_KEY)'}`);
});
