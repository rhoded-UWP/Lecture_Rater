// Session metrics engine. Consumes Web Speech results, interaction taps and
// energy samples; maintains the live gauges' numbers and the timeline arrays
// that end up in the saved-session JSON.

export class SessionMetrics {
  constructor(settings, fillerList) {
    this.settings = settings;
    this.fillerList = fillerList; // lowercase, deduped
    this.fillerMatchers = buildFillerMatchers(fillerList);

    this.startedAt = performance.now();
    this.words = [];        // { t } per spoken word (for rolling WPM)
    this.fillers = [];      // { t, word }
    this.nonlecture = [];   // { start, end|null } — lab activity / video blocks
    this.transcript = [];   // { t, end, text } — live (Web Speech) segments
    this.timeline = { wpm: [], energy: [], attention: [] };
    this._lastSampleT = 0;
    this._lastAttnSampleT = 0;
  }

  now() {
    return (performance.now() - this.startedAt) / 1000;
  }

  /** A finalized Web Speech chunk. */
  addFinal(text, tSec) {
    const tokens = tokenize(text);
    if (!tokens.length) return [];
    // Spread word timestamps evenly across the ~3s the chunk covers so the
    // rolling WPM window doesn't see them as one burst.
    const span = Math.min(tokens.length * 0.4, 4);
    tokens.forEach((_, i) => {
      this.words.push({ t: tSec - span + (span * (i + 1)) / tokens.length });
    });
    this.transcript.push({ t: Math.max(0, tSec - span), end: tSec, text });

    const hits = findFillers(tokens, this.fillerMatchers);
    for (const word of hits) this.fillers.push({ t: tSec, word });
    return hits; // so the UI can highlight in the live captions
  }

  /** Toggle nonlecture activity (lab / video). Returns true if now IN nonlecture. */
  toggleNonlecture() {
    const t = this.now();
    if (this.inNonlecture) {
      this.nonlecture[this.nonlecture.length - 1].end = t;
      return false;
    }
    this.nonlecture.push({ start: t, end: null });
    return true;
  }

  get inNonlecture() {
    const last = this.nonlecture[this.nonlecture.length - 1];
    return !!last && last.end === null;
  }

  /** Total seconds spent in nonlecture activity (open block counts up to now). */
  nonlectureSec(at = this.now()) {
    return this.nonlecture.reduce((sum, b) => sum + Math.max(0, (b.end ?? at) - b.start), 0);
  }

  lectureSec(at = this.now()) {
    return Math.max(0, at - this.nonlectureSec(at));
  }

  /** Seconds of uninterrupted lecture since the last nonlecture block (0 while in one). */
  continuousLectureSec() {
    if (this.inNonlecture) return 0;
    const lastEnd = this.nonlecture.length ? this.nonlecture[this.nonlecture.length - 1].end : 0;
    return this.now() - (lastEnd ?? 0);
  }

  /** Rolling words-per-minute over the configured window. */
  currentWpm() {
    const t = this.now();
    const windowSec = Math.max(15, Math.min(this.settings.wpmWindowSec, t));
    if (t < 5) return 0;
    const cutoff = t - windowSec;
    let n = 0;
    for (let i = this.words.length - 1; i >= 0 && this.words[i].t >= cutoff; i--) n++;
    return Math.round((n * 60) / windowSec);
  }

  /** Fillers per minute over the last 3 minutes (or session so far). */
  currentFillerRate() {
    const t = this.now();
    const windowSec = Math.max(30, Math.min(180, t));
    const cutoff = t - windowSec;
    const n = this.fillers.filter((f) => f.t >= cutoff).length;
    return (n * 60) / windowSec;
  }

  /** Called on the live loop; records a timeline point every sample interval. */
  sample(energy) {
    const t = this.now();
    if (t - this._lastSampleT < this.settings.timelineSampleSec) return;
    this._lastSampleT = t;
    this.timeline.wpm.push([Math.round(t), this.currentWpm()]);
    this.timeline.energy.push([Math.round(t), round2(energy)]);
  }

  /** Attention samples continue through nonlecture blocks (the estimate stays
   * visible during a generic interaction, per the attention spec). */
  sampleAttention(score) {
    const t = this.now();
    if (t - this._lastAttnSampleT < this.settings.timelineSampleSec) return;
    this._lastAttnSampleT = t;
    this.timeline.attention.push([Math.round(t), Math.round(score)]);
  }
}

/**
 * Continuous-lecture stretches between nonlecture blocks (the monologue graph
 * input). Accepts the saved-session timeline; falls back to legacy point
 * `interactions` marks from pre-revision sessions.
 */
export function lectureStretches(timeline, durationSec) {
  const stretches = [];
  const push = (start, end) => {
    if (end - start > 1) stretches.push({ start, len: end - start });
  };
  if (timeline.nonlecture?.length) {
    let prev = 0;
    for (const [s, e] of timeline.nonlecture) {
      push(prev, s);
      prev = e ?? durationSec;
    }
    push(prev, durationSec);
  } else {
    const marks = [0, ...(timeline.interactions || []), durationSec];
    for (let i = 1; i < marks.length; i++) push(marks[i - 1], marks[i]);
  }
  return stretches;
}

// ---------------------------------------------------------------- fillers

/**
 * Filler entries may be single words ("um"), phrases ("you know"), or carry a
 * trailing "?" ("right?") meaning: count it only when it ends an utterance —
 * the tic form — since Web Speech rarely emits punctuation.
 */
function buildFillerMatchers(list) {
  return list.map((entry) => {
    const utteranceFinal = entry.endsWith('?');
    const tokens = tokenize(entry.replace(/\?+$/, ''));
    return { label: entry, tokens, utteranceFinal };
  });
}

function findFillers(tokens, matchers) {
  const hits = [];
  for (const m of matchers) {
    if (!m.tokens.length) continue;
    if (m.utteranceFinal) {
      // match only at the very end of this finalized chunk
      const tail = tokens.slice(-m.tokens.length);
      if (tail.length === m.tokens.length && tail.every((t, i) => t === m.tokens[i])) {
        hits.push(m.label);
      }
    } else {
      for (let i = 0; i + m.tokens.length <= tokens.length; i++) {
        if (m.tokens.every((t, j) => tokens[i + j] === t)) hits.push(m.label);
      }
    }
  }
  return hits;
}

/** Recount fillers against a Whisper word-timestamped transcript (Phase 2). */
export function countFillersFromWords(words, fillerList) {
  const matchers = buildFillerMatchers(fillerList);
  const tokens = words.map((w) => normalizeToken(w.word));
  const fillers = [];
  for (const m of matchers) {
    if (!m.tokens.length) continue;
    for (let i = 0; i + m.tokens.length <= tokens.length; i++) {
      if (!m.tokens.every((t, j) => tokens[i + j] === t)) continue;
      if (m.utteranceFinal) {
        // require a real pause after it — the "right?" tic, not mid-sentence use
        const next = words[i + m.tokens.length];
        const end = words[i + m.tokens.length - 1].end;
        if (next && next.start - end < 0.5) continue;
      }
      fillers.push({ t: round2(words[i].start), word: m.label });
    }
  }
  return fillers.sort((a, b) => a.t - b.t);
}

/** Stutter/restart detection from Whisper word timestamps (Phase 2). */
export function detectStutters(words, stutterGapSec) {
  const stutters = [];
  for (let i = 1; i < words.length; i++) {
    const prev = normalizeToken(words[i - 1].word);
    const cur = normalizeToken(words[i].word);
    const gap = words[i].start - words[i - 1].end;

    if (cur && cur === prev && gap < 1.0) {
      stutters.push({ t: round2(words[i - 1].start), kind: 'repeat', text: `${words[i - 1].word} ${words[i].word}` });
    } else if (gap >= stutterGapSec && i < words.length - 1) {
      stutters.push({ t: round2(words[i - 1].end), kind: 'hesitation', text: `${round2(gap)}s pause after “${words[i - 1].word}”` });
    }
    // Abandoned restart: a repeated two-word run ("so we can- so we should")
    if (i >= 3) {
      const a = [normalizeToken(words[i - 3].word), normalizeToken(words[i - 2].word)];
      const b = [prev, cur];
      if (a[0] && a[0] === b[0] && a[1] && a[1] === b[1] && a[0] !== a[1]) {
        stutters.push({
          t: round2(words[i - 3].start),
          kind: 'restart',
          text: `${words[i - 3].word} ${words[i - 2].word} / ${words[i - 1].word} ${words[i].word}`,
        });
      }
    }
  }
  return stutters;
}

export function tokenize(text) {
  return text
    .toLowerCase()
    .split(/\s+/)
    .map(normalizeToken)
    .filter(Boolean);
}

function normalizeToken(w) {
  return w.toLowerCase().replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, '');
}

const round2 = (v) => Math.round(v * 100) / 100;
