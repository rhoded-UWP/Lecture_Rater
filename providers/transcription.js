// Transcription adapters. Every adapter takes an in-memory audio buffer and
// returns the same shape the rest of the app expects:
//   { text, words: [{word, start, end}], segments: [{t, end, text}], durationSec }
// Times are SECONDS everywhere (AssemblyAI's milliseconds are converted here).
//
// The audio-privacy rule holds: buffers are received, forwarded, and dropped —
// nothing is written to disk in this module.

import { findTranscriptionProvider } from './catalog.js';

class TranscriptionError extends Error {
  constructor(message, { status = 500, detail = '' } = {}) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

// ------------------------------------------------------------ OpenAI Whisper

// The "prompt trick": Whisper is trained to clean disfluencies out of its
// transcripts, which hides exactly what this app counts. Priming it with
// filler-laden text biases it toward verbatim output. Partial fix only —
// AssemblyAI with disfluencies:true is the reliable option.
const WHISPER_VERBATIM_PROMPT =
  "Umm, let me think like, hmm... Okay, so um, here's what I'm, like, thinking. " +
  'So uh, it, it, you know, it\'s it\'s kind of, er, ah, right? I mean, yeah so.';

async function whisperTranscribe(buffer, mimetype, filename) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimetype }), filename);
  form.append('model', 'whisper-1');
  form.append('response_format', 'verbose_json');
  form.append('prompt', WHISPER_VERBATIM_PROMPT);
  form.append('timestamp_granularities[]', 'word');
  form.append('timestamp_granularities[]', 'segment');
  const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    throw new TranscriptionError(`Whisper request failed (${r.status})`, {
      status: 502,
      detail: detail.slice(0, 500),
    });
  }
  const data = await r.json();
  return {
    text: data.text || '',
    words: data.words || [],
    segments: (data.segments || []).map((s) => ({ t: s.start, end: s.end, text: s.text.trim() })),
    durationSec: data.duration ?? null,
  };
}

// -------------------------------------------------------------- AssemblyAI
// Three-step flow: upload raw bytes → create a transcript job → poll until
// done. Sentence-level segments come from the /sentences endpoint so the UI
// gets the same segment granularity Whisper provides.

const AAI_BASE = 'https://api.assemblyai.com/v2';

async function aaiFetch(pathname, opts = {}) {
  const r = await fetch(`${AAI_BASE}${pathname}`, {
    ...opts,
    headers: {
      authorization: process.env.ASSEMBLYAI_API_KEY,
      ...(opts.headers || {}),
    },
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    throw new TranscriptionError(`AssemblyAI request failed (${r.status})`, {
      status: 502,
      detail: detail.slice(0, 500),
    });
  }
  return r.json();
}

async function assemblyaiTranscribe(buffer) {
  // 1 · upload the audio (AssemblyAI stores it transiently for processing)
  const { upload_url } = await aaiFetch('/upload', { method: 'POST', body: buffer });

  // 2 · create the transcription job
  const job = await aaiFetch('/transcript', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      audio_url: upload_url,
      speech_models: ['universal-2'], // their standard tier; see AssemblyAI model docs
      punctuate: true,
      format_text: true,
      // The reason AssemblyAI is the recommended precision provider: its
      // disfluency model transcribes fillers (um, uh, er, hmm...), word
      // repetitions, restarts, and part-word stutters verbatim — the raw
      // material for the filler and stutter counters.
      disfluencies: true,
    }),
  });

  // 3 · poll (3 s interval, 15 min ceiling — generous for a 75-min lecture)
  const deadline = Date.now() + 15 * 60 * 1000;
  let data;
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000));
    data = await aaiFetch(`/transcript/${job.id}`);
    if (data.status === 'completed') break;
    if (data.status === 'error') {
      throw new TranscriptionError(`AssemblyAI transcription failed: ${data.error}`, { status: 502 });
    }
    if (Date.now() > deadline) {
      throw new TranscriptionError('AssemblyAI transcription timed out after 15 minutes.', { status: 504 });
    }
  }

  // 4 · sentence segments (separate endpoint; ms → s conversion throughout)
  let segments = [];
  try {
    const sent = await aaiFetch(`/transcript/${job.id}/sentences`);
    segments = (sent.sentences || []).map((s) => ({
      t: s.start / 1000,
      end: s.end / 1000,
      text: s.text.trim(),
    }));
  } catch {
    // sentences endpoint is a nicety — fall back to one big segment
    if (data.text) segments = [{ t: 0, end: data.audio_duration ?? 0, text: data.text }];
  }

  return {
    text: data.text || '',
    words: (data.words || []).map((w) => ({ word: w.text, start: w.start / 1000, end: w.end / 1000 })),
    segments,
    durationSec: data.audio_duration ?? null,
  };
}

// ------------------------------------------------------------------ router

/** Transcribe with the given provider id ('whisper' | 'assemblyai').
 *  Throws TranscriptionError with .status/.detail for route handlers. */
export async function transcribeAudio(providerId, buffer, mimetype, filename) {
  const provider = findTranscriptionProvider(providerId);
  if (!provider) {
    throw new TranscriptionError(`Unknown transcription provider: ${providerId}`, { status: 400 });
  }
  if (!process.env[provider.envKey]) {
    throw new TranscriptionError(
      `${provider.label} is not configured (${provider.envKey} missing).`,
      { status: 503 }
    );
  }
  const result =
    providerId === 'assemblyai'
      ? await assemblyaiTranscribe(buffer)
      : await whisperTranscribe(buffer, mimetype, filename);
  return { ...result, provider: provider.label, model: provider.model };
}
