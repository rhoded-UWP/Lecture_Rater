// Lecture Coach — application orchestrator.
// Views: setup → live → processing → report, plus history.

import { loadSettings, saveSettings, activeFillerList, DEFAULTS, PACE_PROFILES, PACE_ZONES, classifyWpm } from './config.js';
import { speechSupported, LiveSpeech } from './speech.js';
import { EnergyAnalyzer } from './audio-energy.js';
import { SessionRecorder } from './recorder.js';
import { SessionMetrics, countFillersFromWords, detectStutters, lectureStretches } from './metrics.js';
import { computeScores } from './scoring.js';
import * as store from './storage.js';
import { drawLineChart, drawMonologueBars, drawTimelineStrip, drawSparkline, drawAttentionChart, dialAngle, INK } from './charts.js';
import { initDevPanel, logUsage } from './dev-panel.js';
import { estimateAttention, blocksToMinutes } from './attention.js';

const $ = (id) => document.getElementById(id);

const WPM_SCALE_MIN = 60;
const WPM_SCALE_MAX = 220;

let settings = loadSettings();
let modes = [];
let selectedModeId = null;
// Session type is no longer user-selectable (the console toggle was removed);
// all sessions record as 'rehearsal'. The 'live' privacy code paths remain in
// endSession/factcheckTranscript should classroom mode ever return.
let sessionType = 'rehearsal';

let micChecker = null;      // EnergyAnalyzer during mic check
let micCheckRaf = 0;

let live = null;            // { metrics, speech, energy, recorder, stream, timer, interimEl }
let currentSession = null;  // report currently displayed
let currentSessionSaved = false;

// ============================================================ AI settings
// Server-side provider configuration (/api/settings): which transcription
// provider and analysis models are active, plus pricing for cost estimates.
// Cached; the dev panel writes changes server-side, so refresh before use
// where the price matters.

let aiSettings = null;

async function fetchAiSettings(force = false) {
  if (aiSettings && !force) return aiSettings;
  try {
    aiSettings = await (await fetch('/api/settings')).json();
  } catch {
    /* server offline — estimates just won't show */
  }
  return aiSettings;
}

/** Ledger entry for a completed precision-transcription pass. The server
 * reports which provider actually ran (data.provider/model). */
async function logTranscriptionUsage(data, minutes, note) {
  const cfg = await fetchAiSettings();
  const p = cfg?.transcriptionProviders?.find((x) => x.label === data.provider);
  logUsage({
    role: 'tone-timing',
    provider: data.provider || 'transcription',
    model: data.model || '',
    minutes,
    costUSD: p ? Math.round(minutes * p.costPerMin * 10000) / 10000 : null,
    ...(note ? { note } : {}),
  });
}

// ============================================================ view routing

function showView(name) {
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  $(`view-${name}`).classList.add('active');
  document.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.view === name);
  });
}

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    if (live) return; // no navigation while mic is hot
    if (tab.dataset.view === 'history') renderHistory();
    showView(tab.dataset.view);
  });
});

// ============================================================ setup screen

async function initSetup() {
  if (!speechSupported()) $('chrome-warning').classList.remove('hidden');

  try {
    const r = await fetch('/api/modes');
    modes = await r.json();
  } catch {
    modes = [];
  }
  const list = $('mode-list');
  list.innerHTML = '';
  if (!modes.length) {
    list.innerHTML = '<div class="dim-note">No mode files found in <code>modes/</code>.</div>';
  }
  for (const mode of modes) {
    const card = document.createElement('button');
    card.className = 'mode-card';
    card.innerHTML = `<div class="mode-title">${esc(mode.title)}</div><div class="mode-sub">${esc(mode.subject)} · ${esc(mode.level)}</div>`;
    card.addEventListener('click', () => {
      selectedModeId = mode.id;
      list.querySelectorAll('.mode-card').forEach((c) => c.classList.remove('selected'));
      card.classList.add('selected');
      loadOutcomesForMode(mode.id);
      updateGoLive();
    });
    list.appendChild(card);
  }
  // Pre-select the "Default — Any Subject" mode so the console is armed on load;
  // fall back to the first mode if it's ever removed.
  const defaultIdx = Math.max(0, modes.findIndex((m) => m.id === 'default'));
  if (modes.length) list.querySelectorAll('.mode-card')[defaultIdx]?.click();

  renderSettingsPanel();
  initObjectives();
  updateGoLive();

  // The MP4 testing pipeline needs ffmpeg + a Whisper key on the server.
  // The button stays visible regardless (per Dan) — clicking without the
  // prerequisites surfaces the server's error message.
  $('upload-video-btn').classList.remove('hidden');
}

function updateGoLive() {
  const ready = !!selectedModeId && speechSupported();
  $('golive-btn').disabled = !ready;
  $('golive-hint').textContent = !speechSupported()
    ? 'Chrome required for live transcription'
    : !selectedModeId
      ? 'select a mode to arm the console'
      : `armed · ${modes.find((m) => m.id === selectedModeId)?.title} · ${settings.lectureLengthMin} min`;
}

// pacing profile toggle (research-based WPM bands)
function syncPaceToggle() {
  document.querySelectorAll('#pace-toggle .type-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.profile === settings.paceProfile)
  );
}
document.querySelectorAll('#pace-toggle .type-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    settings.paceProfile = btn.dataset.profile;
    saveSettings(settings);
    syncPaceToggle();
  });
});
syncPaceToggle();

// lecture length selector (50 / 75 / custom minutes)
function syncLengthButtons() {
  const min = settings.lectureLengthMin;
  const isPreset = min === 50 || min === 75;
  document.querySelectorAll('.len-btn').forEach((b) => {
    b.classList.toggle(
      'active',
      b.dataset.min === 'custom' ? !isPreset : Number(b.dataset.min) === min
    );
  });
  $('custom-length').classList.toggle('hidden', isPreset);
  $('custom-length-unit').classList.toggle('hidden', isPreset);
  if (!isPreset) $('custom-length').value = min;
}
document.querySelectorAll('.len-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.dataset.min === 'custom') {
      if (settings.lectureLengthMin === 50 || settings.lectureLengthMin === 75) {
        settings.lectureLengthMin = 60; // starting point for custom entry
      }
    } else {
      settings.lectureLengthMin = Number(btn.dataset.min);
    }
    saveSettings(settings);
    syncLengthButtons();
    updateGoLive();
    if (btn.dataset.min === 'custom') $('custom-length').focus();
  });
});
$('custom-length').addEventListener('change', () => {
  const v = Math.round(parseFloat($('custom-length').value));
  if (v >= 5 && v <= 240) {
    settings.lectureLengthMin = v;
    saveSettings(settings);
    updateGoLive();
  }
  syncLengthButtons();
});
syncLengthButtons();

// settings panel
const SETTING_FIELDS = [
  ['wpmWindowSec', 'WPM rolling window (s)'],
  ['sustainedFastSec', 'Sustained-fast alert (s)'],
  ['paceSustainedPenalty', 'Pace pts / sustained-fast stretch'],
  ['monologueWarnSec', 'Monologue warn (s)'],
  ['monologueAlertSec', 'Monologue alert (s)'],
  ['targetInteractionGapSec', 'Target lecture stretch (s)'],
  ['pointsPerFillerPerMin', 'Clarity pts / filler-per-min'],
  ['pointsPerStutterPerMin', 'Clarity pts / stutter-per-min'],
  ['interactionExclusionSec', 'Live exclusion window (s)'],
  ['uploadSilenceNonlectureSec', 'Upload: silence = activity (s)'],
];
const WEIGHT_KEYS = ['pace', 'clarity', 'engagement', 'vocalEnergy', 'accuracy'];

function renderSettingsPanel() {
  const grid = $('settings-grid');
  grid.innerHTML = '';
  for (const [key, label] of SETTING_FIELDS) {
    grid.appendChild(settingField(label, settings[key], (v) => { settings[key] = v; }));
  }
  for (const key of WEIGHT_KEYS) {
    grid.appendChild(settingField(`weight · ${key}`, settings.weights[key], (v) => { settings.weights[key] = v; }, 0.05));
  }
}

function settingField(label, value, apply, step = 1) {
  const div = document.createElement('div');
  div.className = 'setting-field';
  const input = document.createElement('input');
  input.type = 'number';
  input.step = String(step);
  input.value = value;
  input.addEventListener('change', () => {
    const v = parseFloat(input.value);
    if (!Number.isNaN(v)) {
      apply(v);
      saveSettings(settings);
    }
  });
  const lab = document.createElement('label');
  lab.textContent = label;
  div.append(lab, input);
  return div;
}

// ---------------------------------------- learning objectives & outcomes

const OBJECTIVES_DRAFT_KEY = 'lc.draftObjectives';
const outcomesKey = (modeId) => `lc.outcomes.${modeId}`;

/** One objective per line; a .json upload may be an array of strings. */
function parseObjectives(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed).map(String).map((s) => s.trim()).filter(Boolean);
    } catch { /* fall through to line parsing */ }
  }
  return trimmed.split('\n').map((l) => l.replace(/^[-*\d.)\s]+/, '').trim()).filter(Boolean);
}

function initObjectives() {
  const lecEl = $('lecture-objectives');
  lecEl.value = localStorage.getItem(OBJECTIVES_DRAFT_KEY) || '';
  lecEl.addEventListener('input', () => localStorage.setItem(OBJECTIVES_DRAFT_KEY, lecEl.value));

  $('course-outcomes').addEventListener('input', () => {
    if (selectedModeId) localStorage.setItem(outcomesKey(selectedModeId), $('course-outcomes').value);
  });

  wireObjectivesUpload($('objectives-file'), lecEl, () =>
    localStorage.setItem(OBJECTIVES_DRAFT_KEY, lecEl.value)
  );
  wireObjectivesUpload($('outcomes-file'), $('course-outcomes'), () => {
    if (selectedModeId) localStorage.setItem(outcomesKey(selectedModeId), $('course-outcomes').value);
  });
}

function wireObjectivesUpload(input, textarea, persist) {
  input.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const lines = parseObjectives(await file.text());
      if (!lines.length) throw new Error('no objectives found in file');
      textarea.value = lines.join('\n');
      persist();
    } catch (err) {
      alert(`Could not read ${file.name}: ${err.message}`);
    }
    e.target.value = '';
  });
}

/** Course outcomes are stored per mode; swap them in when the mode changes.
 * If the instructor hasn't saved custom outcomes for this mode, the box
 * pre-fills from the mode file's learningOutcomes (so CS1010/CS1430 show
 * their official course outcomes on selection). Edits stick per browser;
 * clearing the box restores the mode-file defaults on next selection. */
function loadOutcomesForMode(modeId) {
  const mode = modes.find((m) => m.id === modeId);
  const saved = localStorage.getItem(outcomesKey(modeId));
  $('course-outcomes').value = saved || (mode?.learningOutcomes || []).join('\n');
  $('slo-mode-tag').textContent = `· ${mode?.title || modeId}`;
}

$('settings-reset').addEventListener('click', () => {
  const customs = settings.customFillerWords;
  settings = { ...structuredClone(DEFAULTS), customFillerWords: customs };
  saveSettings(settings);
  renderSettingsPanel();
  syncPaceToggle();
});

// mic check
$('mic-check-btn').addEventListener('click', async () => {
  if (micChecker) return stopMicCheck();
  try {
    micChecker = new EnergyAnalyzer();
    await micChecker.start();
    $('mic-check-btn').textContent = 'Close Mic';
    const loop = () => {
      if (!micChecker) return;
      setVu($('mic-vu-fill'), micChecker.level);
      micCheckRaf = requestAnimationFrame(loop);
    };
    loop();
  } catch (err) {
    micChecker = null;
    alert(`Could not open microphone: ${err.message}`);
  }
});

function stopMicCheck() {
  cancelAnimationFrame(micCheckRaf);
  micChecker?.stop();
  micChecker = null;
  setVu($('mic-vu-fill'), 0);
  $('mic-check-btn').textContent = 'Open Mic';
}

function setVu(fillEl, frac) {
  fillEl.style.clipPath = `inset(0 ${Math.round((1 - Math.min(1, frac)) * 100)}% 0 0)`;
}

// ============================================================ WPM dial

const ZONE_INK = { green: INK.green, amber: INK.amber, orange: INK.orange, red: INK.red };

function buildDial() {
  const cx = 100, cy = 110, r = 78;
  $('dial-arc-bg').setAttribute('d', arcPath(cx, cy, r, -120, 120));

  // research-band zone arcs for the active pacing profile
  const p = PACE_PROFILES[settings.paceProfile] || PACE_PROFILES.standard;
  const zones = [
    [p.deliberate[0], p.deliberate[1] + 1, INK.amber],
    [p.sweet[0], p.sweet[1] + 1, INK.green],
    [p.brisk[0], p.brisk[1] + 1, INK.amber],
    [p.fast[0], p.fast[1] + 1, INK.orange],
    [p.fast[1] + 1, WPM_SCALE_MAX, INK.red],
  ];
  const zonesEl = $('dial-zones');
  zonesEl.innerHTML = '';
  for (const [from, to, color] of zones) {
    const a1 = dialAngle(from, WPM_SCALE_MIN, WPM_SCALE_MAX);
    const a2 = dialAngle(to, WPM_SCALE_MIN, WPM_SCALE_MAX);
    if (a2 - a1 < 0.5) continue;
    const arc = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    arc.setAttribute('d', arcPath(cx, cy, r, a1, a2));
    arc.setAttribute('stroke', color);
    arc.setAttribute('stroke-opacity', color === INK.green ? '0.85' : '0.45');
    zonesEl.appendChild(arc);
  }

  const ticks = $('dial-ticks');
  ticks.innerHTML = '';
  for (let wpm = WPM_SCALE_MIN; wpm <= WPM_SCALE_MAX; wpm += 40) {
    const a = dialAngle(wpm, WPM_SCALE_MIN, WPM_SCALE_MAX);
    const [x, y] = polar(cx, cy, r - 20, a); // labels sit inside the arc
    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', x);
    label.setAttribute('y', y + 3);
    label.setAttribute('text-anchor', 'middle');
    label.textContent = wpm;
    ticks.appendChild(label);
  }
}

function polar(cx, cy, r, angleDeg) {
  const rad = (angleDeg * Math.PI) / 180;
  return [cx + r * Math.sin(rad), cy - r * Math.cos(rad)];
}

function arcPath(cx, cy, r, a1, a2) {
  const [x1, y1] = polar(cx, cy, r, a1);
  const [x2, y2] = polar(cx, cy, r, a2);
  const large = a2 - a1 > 180 ? 1 : 0;
  return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`;
}

// ============================================================ live session

$('golive-btn').addEventListener('click', startSession);
$('end-btn').addEventListener('click', () => {
  if (confirm('End this session and run the post-session analysis?')) endSession();
});
$('interaction-btn').addEventListener('click', toggleNonlecture);

document.addEventListener('keydown', (e) => {
  if (!live || e.code !== 'Space') return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')) return;
  e.preventDefault();
  toggleNonlecture();
});

$('transcript-toggle').addEventListener('change', (e) => {
  $('transcript-module').classList.toggle('captions-off', !e.target.checked);
});

async function startSession() {
  if (live) return;
  stopMicCheck();

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    alert(`Microphone unavailable: ${err.message}`);
    return;
  }

  const metrics = new SessionMetrics(settings, activeFillerList(settings));
  const energy = new EnergyAnalyzer();
  await energy.start(stream);
  const recorder = new SessionRecorder(settings.audioBitsPerSecond);
  const recording = recorder.start(stream);

  const transcriptEl = $('live-transcript');
  transcriptEl.innerHTML = '';
  const interimEl = document.createElement('span');
  interimEl.className = 'interim';
  transcriptEl.appendChild(interimEl);

  const speech = new LiveSpeech({
    onFinal: (text, t) => {
      const hits = metrics.addFinal(text, t);
      const span = document.createElement('span');
      span.className = 'final';
      span.innerHTML = highlightFillers(text, metrics.fillerList) + ' ';
      transcriptEl.insertBefore(span, interimEl);
      autoscroll(transcriptEl);
      if (hits.length) flashFillers(hits);
    },
    onInterim: (text) => {
      interimEl.textContent = text;
      autoscroll(transcriptEl);
    },
    onStatus: (msg) => { $('footer-status').textContent = msg.toUpperCase(); },
  });
  try {
    speech.start();
  } catch (err) {
    alert(err.message);
  }

  live = { metrics, energy, recorder, speech, stream, recording, timer: 0, interimEl, fastSince: null, attn: [], lastAttnT: -10 };

  buildDial();
  $('wpm-readout').textContent = '—';
  $('fpm-readout').textContent = '0.0';
  $('filler-total').textContent = '0';
  $('nl-count').textContent = '0';
  $('recent-fillers').innerHTML = '';
  $('gap-stopwatch').textContent = '0:00';
  $('attn-readout').textContent = '—';
  $('attn-conf').textContent = '';
  $('pace-word').textContent = ' ';
  $('pace-word').className = 'pace-word mono';
  $('timer-lecture').textContent = '0:00';
  $('timer-nonlecture').textContent = '0:00';
  $('timer-total').textContent = '0:00';
  $('nl-btn-text').textContent = 'NONLECTURE ACTIVITY · LAB / VIDEO';
  $('interaction-btn').classList.remove('nl-active');
  document.body.classList.remove('nonlecture');
  $('onair-lamp').classList.add('live');
  $('footer-status').textContent = recording ? 'REC · MIC HOT' : 'MIC HOT · NO PRECISION RECORDING';
  document.querySelectorAll('.tab').forEach((t) => (t.disabled = true));
  showView('live');

  live.timer = setInterval(liveTick, 200);
}

function liveTick() {
  if (!live) return;
  const m = live.metrics;
  const t = m.now();
  const inNL = m.inNonlecture;

  $('timer-lecture').textContent = fmtClock(m.lectureSec());
  $('timer-nonlecture').textContent = fmtClock(m.nonlectureSec());
  $('timer-total').textContent = fmtClock(t);

  // warn as the planned lecture length approaches, alert when over
  const plannedSec = settings.lectureLengthMin * 60;
  const totalRow = $('timer-total').closest('.timer-row');
  totalRow.classList.toggle('over', t >= plannedSec);
  totalRow.classList.toggle('near', t < plannedSec && t >= plannedSec - settings.lectureEndWarnMin * 60);

  const gap = m.continuousLectureSec();
  const sw = $('gap-stopwatch');
  sw.textContent = inNL ? '—' : fmtClock(gap);
  sw.classList.toggle('ok', !inNL && gap < settings.monologueWarnSec);
  sw.classList.toggle('warn', !inNL && gap >= settings.monologueWarnSec && gap < settings.monologueAlertSec);
  sw.classList.toggle('alert', !inNL && gap >= settings.monologueAlertSec);

  if (!inNL) {
    const wpm = m.currentWpm();
    $('wpm-readout').textContent = t < 10 ? '—' : String(wpm);
    $('dial-needle').setAttribute(
      'transform',
      `rotate(${dialAngle(wpm || WPM_SCALE_MIN, WPM_SCALE_MIN, WPM_SCALE_MAX)}, 100, 110)`
    );

    // research-band pace language + sustained-fast escalation
    const paceEl = $('pace-word');
    if (t < 10 || wpm === 0) {
      paceEl.textContent = ' ';
      paceEl.className = 'pace-word mono';
      live.fastSince = null;
    } else {
      const zone = classifyWpm(wpm, settings.paceProfile);
      const info = PACE_ZONES[zone];
      if (zone === 'fast' || zone === 'toofast') {
        live.fastSince ??= t;
      } else {
        live.fastSince = null;
      }
      const sustained = live.fastSince !== null && t - live.fastSince >= settings.sustainedFastSec;
      paceEl.textContent = sustained ? 'SUSTAINED FAST — SLOW FOR NOTES' : info.label;
      paceEl.className = `pace-word mono pz-${sustained ? 'red' : info.color}${sustained ? ' sustained' : ''}`;
    }

    $('fpm-readout').textContent = m.currentFillerRate().toFixed(1);
    $('filler-total').textContent = String(m.fillers.length);

    const e = live.energy.energy;
    setVu($('energy-vu-fill'), e);
    $('energy-word').textContent =
      t < 15 ? 'listening…' : e > 0.55 ? 'DYNAMIC' : e > 0.3 ? 'STEADY' : e > settings.energyFloor ? 'FLATTENING' : 'MONOTONE';

    m.sample(e);
  } else {
    $('energy-word').textContent = 'PAUSED — NONLECTURE';
  }

  drawTimelineStrip($('timeline-strip'), t, m.nonlecture, {
    minHorizonSec: settings.lectureLengthMin * 60,
  });

  updateAttention(m, t);
}

/** Estimated Attention (attention-timeline-feature-spec.md): compute the
 * current estimate, keep a fine-grained curve for the live chart, and draw
 * the band + curve + dotted uninterrupted-lecture projection. */
function updateAttention(m, t) {
  const blocksMin = blocksToMinutes(m.nonlecture);
  const att = estimateAttention(t / 60, blocksMin);

  $('attn-readout').textContent = `${Math.round(att.score)}%`;
  $('attn-conf').textContent = `ESTIMATE · CONFIDENCE ${att.confidence.toUpperCase()}`;

  if (t - (live.lastAttnT ?? -10) >= 1) {
    live.lastAttnT = t;
    live.attn.push({ t, score: att.score, lower: att.lower, upper: att.upper });
  }
  m.sampleAttention(att.score);

  const horizonSec = Math.max(settings.lectureLengthMin * 60, t * 1.15);
  const projection = [{ t, score: att.score }];
  for (let pt = t + 60; pt <= horizonSec; pt += 60) {
    projection.push({ t: pt, score: estimateAttention(pt / 60, blocksMin).score });
  }
  drawAttentionChart($('attention-chart'), live.attn, {
    durationSec: horizonSec,
    blocks: m.nonlecture,
    projection,
  });
}

/** Spacebar / big button: toggle nonlecture activity (lab or video).
 * While in nonlecture, nothing is captured — speech recognition, the audio
 * recording, and the energy analysis all pause, and the UI wears a red frame. */
function toggleNonlecture() {
  if (!live) return;
  const inNL = live.metrics.toggleNonlecture();
  $('nl-count').textContent = String(live.metrics.nonlecture.length);

  if (inNL) {
    live.speech.stop();
    live.recorder.pause();
    live.energy.pause();
    live.interimEl.textContent = '';
    $('nl-btn-text').textContent = 'RESUME LECTURE';
    $('footer-status').textContent = 'NONLECTURE ACTIVITY · NOT RECORDING';
  } else {
    live.speech.resume();
    live.recorder.resume();
    live.energy.resume();
    $('nl-btn-text').textContent = 'NONLECTURE ACTIVITY · LAB / VIDEO';
    $('footer-status').textContent = live.recording ? 'REC · MIC HOT' : 'MIC HOT · NO PRECISION RECORDING';
  }
  document.body.classList.toggle('nonlecture', inNL);
  $('onair-lamp').classList.toggle('live', !inNL);
  $('interaction-btn').classList.toggle('nl-active', inNL);

  const btn = $('interaction-btn');
  btn.classList.add('flash');
  setTimeout(() => btn.classList.remove('flash'), 180);
}

function flashFillers(hits) {
  const el = $('recent-fillers');
  for (const word of hits) {
    const span = document.createElement('span');
    span.className = 'pop';
    span.textContent = word;
    el.appendChild(span);
    while (el.children.length > 6) el.removeChild(el.firstChild);
  }
}

function autoscroll(el) {
  if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) el.scrollTop = el.scrollHeight;
}

// ============================================================ end + process

async function endSession() {
  if (!live) return;
  const { metrics, energy, recorder, speech, stream } = live;
  clearInterval(live.timer);
  live = null;

  if (metrics.inNonlecture) metrics.toggleNonlecture(); // close an open block
  document.body.classList.remove('nonlecture');

  speech.stop();
  const durationSec = Math.round(metrics.now());
  const audioBlob = await recorder.stop();
  energy.stop();
  stream.getTracks().forEach((tr) => tr.stop());

  $('onair-lamp').classList.remove('live');
  $('footer-status').textContent = 'PROCESSING';
  document.querySelectorAll('.tab').forEach((t) => (t.disabled = false));
  showView('processing');
  $('proc-extract').classList.add('hidden'); // live sessions skip the video step
  setProc('proc-transcribe', 'queued');
  setProc('proc-factcheck', 'queued');
  setProc('proc-scoring', 'queued');

  const session = {
    version: 1,
    sessionId: new Date().toISOString().slice(0, 19).replace(/:/g, '-'),
    mode: selectedModeId,
    type: sessionType,
    paceProfile: settings.paceProfile,
    plannedMin: settings.lectureLengthMin,
    durationSec,
    lectureSec: Math.round(metrics.lectureSec(durationSec)),
    nonlectureSec: Math.round(metrics.nonlectureSec(durationSec)),
    scores: null,
    timeline: {
      wpm: metrics.timeline.wpm,
      energy: metrics.timeline.energy,
      attention: metrics.timeline.attention,
      nonlecture: metrics.nonlecture.map((b) => [Math.round(b.start), Math.round(b.end ?? durationSec)]),
      fillers: metrics.fillers.map((f) => ({ t: Math.round(f.t), word: f.word })),
      stutters: [],
    },
    accuracyFlags: null,
    transcript: metrics.transcript.map((s) => ({ t: r1(s.t), end: r1(s.end), text: s.text })),
    customFillerList: activeFillerList(settings),
    // captured for the future AI coverage pass (time per objective, accuracy
    // of related content — per lecture and across the course)
    learningObjectives: parseObjectives($('lecture-objectives').value),
    courseOutcomes: parseObjectives($('course-outcomes').value),
    precision: false,
  };

  // live captions ran the whole lecture (free, but tracked for completeness)
  if (session.lectureSec > 30) {
    logUsage({
      role: 'transcription',
      provider: 'Google Web Speech',
      model: 'chrome built-in',
      minutes: Math.round((session.lectureSec / 60) * 10) / 10,
    });
  }

  // --- 1 · Whisper precision pass -----------------------------------------
  setProc('proc-transcribe', 'active', 'uploading…');
  if (audioBlob && durationSec > 5) {
    try {
      const form = new FormData();
      form.append('audio', audioBlob, `session.${audioBlob.type.includes('ogg') ? 'ogg' : 'webm'}`);
      const r = await fetch('/api/transcribe', { method: 'POST', body: form });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);

      // Recording pauses during nonlecture blocks, so Whisper's clock lags the
      // session clock. Detect on the raw (continuous) recorded time — otherwise
      // every nonlecture block would read as a giant hesitation — then remap
      // the resulting timestamps back to session time.
      const fillerList = activeFillerList(settings);
      const toSession = makeRecordedToSession(session.timeline.nonlecture);
      session.transcript = data.segments.length
        ? data.segments.map((s) => ({ t: r1(toSession(s.t)), end: r1(toSession(s.end)), text: s.text }))
        : session.transcript;
      if (data.words.length) {
        session.timeline.fillers = countFillersFromWords(data.words, fillerList)
          .map((f) => ({ ...f, t: r1(toSession(f.t)) }));
        session.timeline.stutters = detectStutters(data.words, settings.stutterGapSec)
          .map((s) => ({ ...s, t: r1(toSession(s.t)) }));
        session.timeline.wpm = rebuildWpmTimeline(data.words, durationSec - session.nonlectureSec)
          .map(([t, v]) => [Math.round(toSession(t)), v]);
        if (sessionType === 'live') applyPrivacyExclusion(session);
      }
      session.precision = true;
      await logTranscriptionUsage(data, Math.round(((data.durationSec ?? session.lectureSec) / 60) * 10) / 10);
      setProc('proc-transcribe', 'done', 'word-level transcript ready');
    } catch (err) {
      setProc('proc-transcribe', 'skipped', `skipped — ${err.message}`);
    }
  } else {
    setProc('proc-transcribe', 'skipped', audioBlob ? 'session too short' : 'recording unavailable');
  }

  await factcheckAndScore(session);
}

/** Shared tail of the pipeline: Claude fact-check, scoring, then the report.
 * Used by both live sessions (endSession) and uploaded videos. */
async function factcheckAndScore(session) {
  const sessionMode = modes.find((m) => m.id === session.mode);
  if (sessionMode?.factcheck === false) {
    session.accuracyFlags = null;
    setProc('proc-factcheck', 'skipped', 'mode has no content check');
  } else {
    setProc('proc-factcheck', 'active', 'reviewing…');
    try {
      const payload = factcheckTranscript(session);
      if (!payload.length) throw new Error('no transcript to review');
      const r = await fetch('/api/factcheck', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript: payload, modeId: session.mode }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      session.accuracyFlags = data.flags;
      if (data.usage) {
        logUsage({
          role: 'content',
          provider: data.provider || 'analysis',
          model: data.model,
          inputTokens: data.usage.inputTokens,
          outputTokens: data.usage.outputTokens,
          costUSD: data.costUSD ?? null,
        });
      }
      setProc('proc-factcheck', 'done', `${data.flags.length} flag${data.flags.length === 1 ? '' : 's'}`);
    } catch (err) {
      session.accuracyFlags = null;
      setProc('proc-factcheck', 'skipped', `skipped — ${err.message}`);
    }
  }

  setProc('proc-scoring', 'active', 'computing…');
  session.scores = computeScores(session, settings);
  setProc('proc-scoring', 'done', `overall ${session.scores.overall}`);

  $('footer-status').textContent = 'STANDBY';
  setTimeout(() => {
    currentSession = session;
    currentSessionSaved = false;
    renderReport(session);
  }, 600);
}

// ============================================================ MP4 upload
// Testing pipeline: run a recorded lecture through the exact same analysis
// as a live session. The video goes to the local server, ffmpeg strips the
// audio, Whisper transcribes it, and everything downstream (fillers,
// stutters, WPM, attention, fact-check, scoring) reuses the live code paths.

$('upload-video-btn').addEventListener('click', () => $('video-input').click());
$('video-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (file && !live) runUploadSession(file);
});

async function runUploadSession(file) {
  showView('processing');
  $('proc-extract').classList.remove('hidden');
  setProc('proc-extract', 'active', `uploading ${Math.round(file.size / 1048576)} MB + extracting audio…`);
  setProc('proc-transcribe', 'queued');
  setProc('proc-factcheck', 'queued');
  setProc('proc-scoring', 'queued');
  $('footer-status').textContent = 'PROCESSING UPLOAD';

  let data;
  try {
    const form = new FormData();
    form.append('video', file, file.name);
    const r = await fetch('/api/transcribe-video', { method: 'POST', body: form });
    data = await r.json();
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    if (!data.words.length) throw new Error('no speech found in the video');
    setProc('proc-extract', 'done', 'audio extracted · video deleted');
    setProc('proc-transcribe', 'done', 'word-level transcript ready');
  } catch (err) {
    setProc('proc-extract', 'skipped', `failed — ${err.message}`);
    $('footer-status').textContent = 'STANDBY';
    alert(`Upload processing failed: ${err.message}`);
    showView('setup');
    return;
  }

  const durationSec = Math.round(data.durationSec ?? data.words[data.words.length - 1].end);
  const fillerList = activeFillerList(settings);
  const nonlecture = inferNonlectureFromSilence(data.words, durationSec);
  const nonlectureSec = nonlecture.reduce((s, [a, b]) => s + (b - a), 0);

  const session = {
    version: 1,
    sessionId: new Date().toISOString().slice(0, 19).replace(/:/g, '-'),
    mode: selectedModeId,
    type: 'upload',
    sourceFile: file.name,
    paceProfile: settings.paceProfile,
    plannedMin: settings.lectureLengthMin,
    durationSec,
    lectureSec: durationSec - nonlectureSec,
    nonlectureSec,
    scores: null,
    timeline: {
      wpm: rebuildUploadWpm(data.words, nonlecture, durationSec - nonlectureSec),
      energy: [], // vocal energy is not computed for uploads (v1) — renormalized out
      attention: [],
      nonlecture,
      fillers: countFillersFromWords(data.words, fillerList),
      stutters: detectStutters(data.words, settings.stutterGapSec),
    },
    accuracyFlags: null,
    transcript: data.segments.map((s) => ({ t: r1(s.t), end: r1(s.end), text: s.text })),
    customFillerList: fillerList,
    learningObjectives: parseObjectives($('lecture-objectives').value),
    courseOutcomes: parseObjectives($('course-outcomes').value),
    precision: true,
  };

  // an inferred silence block is activity, not a giant hesitation
  session.timeline.stutters = session.timeline.stutters.filter(
    (st) => !nonlecture.some(([a, b]) => st.t >= a - 2 && st.t <= b + 2)
  );

  // attention samples for the saved timeline (report redraws at full fidelity)
  const blocksMin = blocksToMinutes(nonlecture);
  for (let t = 0; t <= durationSec; t += settings.timelineSampleSec) {
    session.timeline.attention.push([t, Math.round(estimateAttention(t / 60, blocksMin).score)]);
  }

  await logTranscriptionUsage(data, Math.round((durationSec / 60) * 10) / 10, `upload: ${file.name}`);

  await factcheckAndScore(session);
}

/** Long word gaps in an uploaded lecture become inferred nonlecture blocks
 * (threshold: settings.uploadSilenceNonlectureSec). */
function inferNonlectureFromSilence(words, durationSec) {
  const threshold = settings.uploadSilenceNonlectureSec;
  const blocks = [];
  for (let i = 1; i < words.length; i++) {
    const gap = words[i].start - words[i - 1].end;
    if (gap >= threshold) {
      blocks.push([
        Math.max(0, Math.round(words[i - 1].end + 2)),
        Math.min(durationSec, Math.round(words[i].start - 2)),
      ]);
    }
  }
  return blocks;
}

function setProc(id, state, text) {
  const li = $(id);
  li.className = state === 'queued' ? '' : state;
  li.querySelector('.proc-status').textContent = text || state;
}

/** Recompute the WPM timeline from Whisper word timestamps. */
function rebuildWpmTimeline(words, durationSec) {
  const timeline = [];
  const step = settings.timelineSampleSec;
  for (let t = step; t <= durationSec; t += step) {
    const win = Math.min(settings.wpmWindowSec, t);
    const n = words.filter((w) => w.start >= t - win && w.start < t).length;
    timeline.push([t, Math.round((n * 60) / win)]);
  }
  return timeline;
}

/** Upload path: WPM windows must not span inferred nonlecture (silence)
 * blocks, or samples near a block read artificially low. Rebuild on the
 * lecture clock (silences removed), then stamp the samples back in session
 * time for the charts. */
function rebuildUploadWpm(words, nonlecture, lectureDurationSec) {
  const toLecture = (s) => {
    let off = 0;
    for (const [a, b] of nonlecture) {
      if (s >= b) off += b - a;
      else if (s > a) off += s - a; // inside a block — clamp to its start
    }
    return s - off;
  };
  const lectureWords = words.map((w) => ({ start: toLecture(w.start) }));
  const toSession = makeRecordedToSession(nonlecture);
  return rebuildWpmTimeline(lectureWords, lectureDurationSec).map(([t, v]) => [Math.round(toSession(t)), v]);
}

/** Recording pauses during nonlecture blocks, so a recorded timestamp lags
 * session time by the total duration of blocks completed before it. */
function makeRecordedToSession(nonlecture) {
  const pauses = [];
  let offset = 0;
  for (const [start, end] of nonlecture) {
    pauses.push({ recAt: start - offset, dur: end - start });
    offset += end - start;
  }
  return (r) => pauses.reduce((t, p) => (r >= p.recAt ? t + p.dur : t), r);
}

/** Marks where student speech may bleed into the mic: just after each
 * nonlecture block ends (legacy sessions: interaction taps). */
function privacyMarks(session) {
  if (session.timeline.nonlecture?.length) return session.timeline.nonlecture.map(([, end]) => end);
  return session.timeline.interactions || [];
}

/** Live mode: drop fillers/stutters inside the post-activity window —
 * they may belong to students, and student speech is never scored. */
function applyPrivacyExclusion(session) {
  const excl = settings.interactionExclusionSec;
  const marks = privacyMarks(session);
  const inWindow = (t) => marks.some((m) => t >= m && t <= m + excl);
  session.timeline.fillers = session.timeline.fillers.filter((f) => !inWindow(f.t));
  session.timeline.stutters = session.timeline.stutters.filter((s) => !inWindow(s.t));
}

/** Transcript sent to the fact-checker; Live mode excludes segments near
 * activity boundaries (potential student speech is never fact-checked). */
function factcheckTranscript(session) {
  const excl = settings.interactionExclusionSec;
  const marks = privacyMarks(session);
  return session.transcript.filter((seg) => {
    if (session.type !== 'live') return true;
    return !marks.some((m) => seg.t >= m - 2 && seg.t <= m + excl);
  }).map((seg) => ({ t: seg.t, text: seg.text }));
}

// ============================================================ report

const SUBSCORES = [
  ['pace', 'Pace'],
  ['clarity', 'Clarity'],
  ['engagement', 'Engagement'],
  ['vocalEnergy', 'Vocal Energy'],
  ['accuracy', 'Accuracy'],
];

function scoreColor(v) {
  return v >= 75 ? INK.green : v >= 50 ? INK.amber : INK.red;
}

function renderReport(session) {
  showView('report');
  const mode = modes.find((m) => m.id === session.mode);

  const lecSec = session.lectureSec ?? session.durationSec;
  const actSec = session.nonlectureSec ?? 0;
  const blocks = session.timeline.nonlecture?.length ?? session.timeline.interactions?.length ?? 0;
  $('report-meta').innerHTML = [
    `${fmtDate(session.sessionId)}`,
    `${esc(mode?.title || session.mode)}${session.type === 'live' ? ' · LIVE CLASSROOM' : ''}${session.type === 'upload' ? ` · UPLOADED VIDEO · ${esc(session.sourceFile || '')}` : ''}`,
    `LECTURE ${fmtClock(lecSec)} · ACTIVITY ${fmtClock(actSec)} (${session.durationSec ? Math.round((actSec / session.durationSec) * 100) : 0}%) · TOTAL ${fmtClock(session.durationSec)}${session.plannedMin ? ` of ${session.plannedMin} min planned` : ''}`,
    `${blocks} nonlecture block${blocks === 1 ? '' : 's'} · ${session.precision ? 'precision transcript' : 'live transcript only'}`,
  ].join('<br>');

  $('overall-score').textContent = session.scores.overall;
  $('overall-score').style.color = scoreColor(session.scores.overall);

  // delta vs the previous saved session
  const prior = store.listSessions().filter((s) => s.sessionId < session.sessionId).pop();
  const deltaEl = $('overall-delta');
  if (prior?.scores) {
    const d = session.scores.overall - prior.scores.overall;
    deltaEl.textContent = d === 0 ? '· even with last' : `${d > 0 ? '▲' : '▼'} ${Math.abs(d)} vs last`;
    deltaEl.className = `delta ${d > 0 ? 'up' : d < 0 ? 'down' : ''}`;
  } else {
    deltaEl.textContent = '· first scored session';
    deltaEl.className = 'delta';
  }

  // subscores
  $('subscore-row').innerHTML = SUBSCORES.map(([key, name]) => {
    const v = session.scores[key];
    const priorV = prior?.scores?.[key];
    const delta =
      v != null && priorV != null
        ? `<span class="delta ${v - priorV > 0 ? 'up' : v - priorV < 0 ? 'down' : ''}">${v - priorV === 0 ? '=' : (v - priorV > 0 ? '▲' : '▼') + Math.abs(v - priorV)}</span>`
        : '';
    return `<div class="subscore">
      <div class="sub-name">${name}</div>
      <div class="sub-value" style="color:${v == null ? 'var(--faint)' : scoreColor(v)}">${v == null ? '—' : v} ${delta}</div>
      <div class="sub-bar"><div class="sub-bar-fill" style="width:${v ?? 0}%;background:${v == null ? 'transparent' : scoreColor(v)}"></div></div>
    </div>`;
  }).join('');

  // charts (after layout settles)
  requestAnimationFrame(() => drawReportCharts(session));

  // filler breakdown
  const byWord = {};
  for (const f of session.timeline.fillers) (byWord[f.word] ??= []).push(f.t);
  const rows = Object.entries(byWord).sort((a, b) => b[1].length - a[1].length);
  const durMin = Math.max((session.lectureSec ?? session.durationSec) / 60, 0.5);
  $('filler-table').innerHTML = rows.length
    ? `<tr><th>word</th><th>count</th><th>/min</th><th>heard at</th></tr>` +
      rows
        .map(
          ([word, ts]) =>
            `<tr><td>${esc(word)}</td><td class="num">${ts.length}</td><td class="num">${(ts.length / durMin).toFixed(1)}</td>
             <td>${ts.slice(0, 6).map(fmtClock).join(', ')}${ts.length > 6 ? '…' : ''}</td></tr>`
        )
        .join('')
    : `<tr><td class="empty-state">No fillers detected. Immaculate.</td></tr>`;

  // stutters
  const st = session.timeline.stutters || [];
  $('stutter-list').innerHTML = st.length
    ? st
        .slice(0, 60)
        .map(
          (s) =>
            `<li><span class="t">${fmtClock(s.t)}</span><span class="kind">${esc(s.kind)}</span>${esc(s.text)}</li>`
        )
        .join('')
    : `<li class="empty-state">${session.precision ? 'No stutters or restarts detected.' : 'Requires the Whisper precision pass.'}</li>`;

  // accuracy
  const acc = $('accuracy-report');
  if (session.accuracyFlags === null) {
    acc.innerHTML = mode?.factcheck === false
      ? `<p class="dim-note">This mode has no content check — delivery metrics only.</p>`
      : `<p class="dim-note">Fact-check pass did not run. Configure ANTHROPIC_API_KEY on the server to enable it.</p>`;
  } else if (!session.accuracyFlags.length) {
    acc.innerHTML = `<p class="dim-note" style="color:var(--green)">No factual issues flagged against the ${esc(mode?.title || session.mode)} mode file.</p>`;
  } else {
    acc.innerHTML = session.accuracyFlags
      .map(
        (f) => `<div class="acc-flag ${esc(f.severity)}">
          <blockquote>“${esc(f.quote)}”</blockquote>
          <div class="acc-exp"><span class="sev">${esc(f.severity)}</span><span class="t mono">${fmtClock(f.t || 0)}</span> ${esc(f.explanation)}</div>
        </div>`
      )
      .join('');
  }

  // time-in-zone breakdown for the pace chart (research bands)
  const zoneOrder = ['veryslow', 'deliberate', 'sweet', 'brisk', 'fast', 'toofast'];
  const zoneCounts = Object.fromEntries(zoneOrder.map((z) => [z, 0]));
  const spoken = session.timeline.wpm.filter(([, w]) => w > 0);
  for (const [, w] of spoken) zoneCounts[classifyWpm(w, session.paceProfile || settings.paceProfile)]++;
  $('pace-zones').innerHTML = spoken.length
    ? zoneOrder
        .filter((z) => zoneCounts[z] > 0)
        .map((z) => {
          const info = PACE_ZONES[z];
          return `<span class="pz-chip"><span class="pz-dot" style="background:${ZONE_INK[info.color]}"></span>${info.label} ${Math.round((zoneCounts[z] / spoken.length) * 100)}%</span>`;
        })
        .join('')
    : '';

  // learning objectives & outcomes (shown when the session carries any)
  const objectives = session.learningObjectives || [];
  const outcomes = session.courseOutcomes || [];
  $('objectives-module').classList.toggle('hidden', !objectives.length && !outcomes.length);
  $('objectives-report').innerHTML =
    (objectives.length
      ? `<div class="obj-group-title">Lecture objectives — this session</div>
         <ul class="obj-list">${objectives.map((o) => `<li>${esc(o)}</li>`).join('')}</ul>`
      : '') +
    (outcomes.length
      ? `<div class="obj-group-title">Student learning outcomes — course</div>
         <ul class="obj-list">${outcomes.map((o) => `<li>${esc(o)}</li>`).join('')}</ul>`
      : '');

  renderDeepAnalysis(session);
  renderAnnotatedTranscript(session);
  $('save-session-btn').textContent = currentSessionSaved ? 'Saved ✓' : 'Save Session';
  $('save-session-btn').disabled = currentSessionSaved;
}

// ============================================================ deep analysis
// The paid, on-demand pass: thorough content review + learning-outcome
// alignment. NEVER automatic — the instructor clicks the button, sees an
// estimated cost first, and the result is stored on the session (so it
// persists with Save Session and re-renders from History).

async function renderDeepAnalysis(session) {
  const body = $('deep-analysis-body');

  if (session.deepAnalysis) {
    body.innerHTML = deepAnalysisHtml(session.deepAnalysis) +
      `<div class="da-actions"><button class="btn subtle" id="deep-run-btn">Re-run deep analysis</button>
       <span class="dim-note" id="deep-run-note"></span></div>`;
    hookDeepRun(session);
    return;
  }

  if (!session.transcript?.length) {
    body.innerHTML = `<p class="dim-note">Deep analysis needs a transcript — none was captured for this session.</p>`;
    return;
  }

  body.innerHTML = `
    <p class="dim-note">Runs a thorough content review plus alignment against your lecture objectives and
    course learning outcomes. Uses paid API credits — nothing runs until you click.</p>
    <div class="da-actions">
      <button class="btn primary" id="deep-run-btn">Run Deep Analysis</button>
      <span class="dim-note" id="deep-run-note">estimating cost…</span>
    </div>`;
  hookDeepRun(session);

  // fill in the estimate asynchronously (server may be offline — fail soft)
  const est = await deepCostEstimate(session);
  const note = $('deep-run-note');
  if (note) note.textContent = est ? `~$${est.cost.toFixed(2)} estimated · ${est.modelLabel}` : 'cost estimate unavailable (server offline?)';
}

function hookDeepRun(session) {
  $('deep-run-btn')?.addEventListener('click', () => runDeepAnalysis(session));
}

/** Rough pre-run estimate: chars/4 ≈ tokens, plus prompt overhead and a
 * typical response size, priced from the active deep-analysis model. */
async function deepCostEstimate(session) {
  const cfg = await fetchAiSettings(true); // refresh — dev panel may have switched models
  const m = cfg?.analysisModels?.find((x) => x.id === cfg.settings.deepAnalysisModelId);
  if (!m) return null;
  const chars = session.transcript.reduce((s, seg) => s + seg.text.length + 10, 0);
  const inTok = Math.round(chars / 4) + 1500;
  const outTok = 2500;
  const cost = (inTok / 1e6) * m.pricing.inPerM + (outTok / 1e6) * m.pricing.outPerM;
  return { cost: Math.max(cost, 0.01), modelLabel: m.label + (m.approxPricing ? ' (approx. pricing)' : '') };
}

async function runDeepAnalysis(session) {
  const btn = $('deep-run-btn');
  const note = $('deep-run-note');
  btn.disabled = true;
  note.textContent = 'analyzing… this can take 30–120 s';

  try {
    const payload = factcheckTranscript(session); // same privacy filtering as the quick pass
    if (!payload.length) throw new Error('no transcript to analyze');
    const r = await fetch('/api/deep-analysis', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transcript: payload,
        modeId: session.mode,
        lectureObjectives: session.learningObjectives || [],
        courseOutcomes: session.courseOutcomes || [],
      }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);

    session.deepAnalysis = {
      ...data.analysis,
      model: data.model,
      provider: data.provider,
      usage: data.usage,
      costUSD: data.costUSD,
      ranAt: new Date().toISOString().slice(0, 16),
    };
    logUsage({
      role: 'deep-analysis',
      provider: data.provider,
      model: data.model,
      inputTokens: data.usage?.inputTokens,
      outputTokens: data.usage?.outputTokens,
      costUSD: data.costUSD ?? null,
    });

    // the session changed — let the instructor re-save it with the analysis
    if (session === currentSession) {
      currentSessionSaved = false;
      $('save-session-btn').textContent = 'Save Session';
      $('save-session-btn').disabled = false;
    }
    renderDeepAnalysis(session);
  } catch (err) {
    btn.disabled = false;
    note.textContent = `failed — ${err.message}`;
  }
}

function deepAnalysisHtml(da) {
  const statusChip = (s) => `<span class="da-chip ${esc(s)}">${esc(s)}</span>`;
  const scopeTag = (s) => `<span class="da-scope mono">${esc(s)}</span>`;

  const objectives = (da.objectives || []).map((o) => `
    <div class="da-obj ${esc(o.status)}">
      <div class="da-obj-head">${statusChip(o.status)} ${scopeTag(o.scope || '')}
        <strong>${esc(o.text)}</strong>
        ${o.minutes != null ? `<span class="da-min mono">~${Math.round(o.minutes)} min</span>` : ''}
      </div>
      ${(o.evidence || []).length
        ? `<div class="da-evidence">${o.evidence.map((e) => `<span class="mono">${fmtClock(e.t || 0)}</span> ${esc(e.note)}`).join(' · ')}</div>`
        : ''}
      ${o.comment ? `<div class="da-comment">${esc(o.comment)}</div>` : ''}
    </div>`).join('');

  const findings = (da.contentFindings || []).length
    ? da.contentFindings.map((f) => `
        <div class="acc-flag ${esc(f.severity)}">
          <blockquote>“${esc(f.quote)}”</blockquote>
          <div class="acc-exp"><span class="sev">${esc(f.severity)}</span><span class="t mono">${fmtClock(f.t || 0)}</span> ${esc(f.explanation)}</div>
        </div>`).join('')
    : `<p class="dim-note" style="color:var(--green)">No content issues found in the deep review.</p>`;

  return `
    <div class="da-meta mono dim">ran ${esc(da.ranAt || '')} · ${esc(da.provider || '')} ${esc(da.model || '')}
      ${da.costUSD != null ? `· actual cost $${da.costUSD.toFixed(da.costUSD < 0.1 ? 3 : 2)}` : ''}
      ${da.usage ? `· ${da.usage.inputTokens} in / ${da.usage.outputTokens} out tokens` : ''}</div>
    ${da.summary ? `<p class="da-summary">${esc(da.summary)}</p>` : ''}
    ${objectives ? `<div class="da-section-title">Objective &amp; outcome alignment</div>${objectives}` : ''}
    <div class="da-section-title">Deep content review</div>${findings}
    ${(da.suggestions || []).length
      ? `<div class="da-section-title">Coaching suggestions</div>
         <ul class="da-suggestions">${da.suggestions.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>`
      : ''}`;
}

function drawReportCharts(session) {
  drawReportAttention(session);
  drawMonologueBars($('monologue-chart'), lectureStretches(session.timeline, session.durationSec), {
    warnSec: settings.monologueWarnSec,
    alertSec: settings.monologueAlertSec,
  });
  const profile = PACE_PROFILES[session.paceProfile || settings.paceProfile] || PACE_PROFILES.standard;
  drawLineChart($('wpm-chart'), session.timeline.wpm, {
    min: 60,
    max: 220,
    band: profile.sweet,
    color: INK.amber,
    durationSec: session.durationSec,
    hlines: [
      { y: profile.fast[0], color: 'rgba(255,138,77,0.5)' },
      { y: profile.fast[1] + 1, color: 'rgba(255,59,65,0.55)' },
    ],
  });
  drawLineChart($('energy-chart'), session.timeline.energy, {
    min: 0,
    max: 1,
    band: null,
    color: INK.cyan,
    durationSec: session.durationSec,
    ticks: 2,
  });
}

/** Report: regenerate the attention curve at full fidelity from the saved
 * nonlecture blocks (sessions from before this feature hide the module). */
function drawReportAttention(session) {
  const module = $('attention-report-module');
  const hasData = !!session.timeline.attention?.length;
  module.classList.toggle('hidden', !hasData);
  if (!hasData) return;

  const blocksMin = blocksToMinutes(session.timeline.nonlecture);
  const samples = [];
  for (let t = 0; t <= session.durationSec; t += 15) {
    const a = estimateAttention(t / 60, blocksMin);
    samples.push({ t, score: a.score, lower: a.lower, upper: a.upper });
  }
  drawAttentionChart($('attention-report-chart'), samples, {
    durationSec: session.durationSec,
    blocks: session.timeline.nonlecture,
  });

  const scores = samples.map((s) => s.score);
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
  const lowIdx = scores.indexOf(Math.min(...scores));
  $('attn-report-stats').textContent =
    `instructional-time average ${Math.round(avg)}% · lowest ${Math.round(scores[lowIdx])}% at ${fmtClock(samples[lowIdx].t)}`;
}

function renderAnnotatedTranscript(session) {
  const el = $('report-transcript');
  // marks: nonlecture blocks (new sessions) or legacy interaction taps
  const marks = session.timeline.nonlecture?.length
    ? session.timeline.nonlecture.map(([s, e]) => ({ t: s, label: `⏸ nonlecture activity · ${fmtClock(s)}–${fmtClock(e)}` }))
    : (session.timeline.interactions || []).map((t) => ({ t, label: `⏸ interaction · ${fmtClock(t)}` }));
  const flags = session.accuracyFlags || [];
  let html = '';
  let intIdx = 0;

  for (const seg of session.transcript) {
    while (intIdx < marks.length && marks[intIdx].t <= seg.t) {
      html += `<span class="interaction-mark">${marks[intIdx].label}</span> `;
      intIdx++;
    }
    let text = highlightFillers(seg.text, session.customFillerList || []);
    for (const f of flags) {
      const needle = (f.quote || '').slice(0, 40).toLowerCase();
      if (needle.length > 8 && seg.text.toLowerCase().includes(needle)) {
        text = `<span class="acc-mark" title="${esc(f.explanation)}">${text}</span>`;
        break;
      }
    }
    html += `<p><span class="seg-t">${fmtClock(seg.t)}</span>${text}</p>`;
  }
  while (intIdx < marks.length) {
    html += `<span class="interaction-mark">${marks[intIdx++].label}</span> `;
  }
  el.innerHTML = html || '<p class="empty-state">No transcript captured.</p>';
}

/** Wrap filler-list hits in the text with highlight spans. */
function highlightFillers(text, fillerList) {
  let out = esc(text);
  const singles = fillerList.filter((f) => !f.includes(' ')).map((f) => f.replace(/\?$/, ''));
  const phrases = fillerList.filter((f) => f.includes(' '));
  for (const p of phrases) {
    out = out.replace(new RegExp(`\\b(${escapeRe(p)})\\b`, 'gi'), '<span class="filler-hit">$1</span>');
  }
  if (singles.length) {
    out = out.replace(
      new RegExp(`(?<![\\w>])(${singles.map(escapeRe).join('|')})(?![\\w<])`, 'gi'),
      '<span class="filler-hit">$1</span>'
    );
  }
  return out;
}

$('save-session-btn').addEventListener('click', () => {
  if (!currentSession) return;
  const res = store.saveSession(currentSession);
  if (res.ok) {
    currentSessionSaved = true;
    $('save-session-btn').textContent = 'Saved ✓';
    $('save-session-btn').disabled = true;
  } else {
    alert(res.error);
  }
});

$('export-session-btn').addEventListener('click', () => {
  if (currentSession) store.exportSession(currentSession);
});

$('new-session-btn').addEventListener('click', () => showView('setup'));

// ============================================================ history

function renderHistory() {
  const sessions = store.listSessions();

  const records = store.personalRecords(sessions);
  $('records-list').innerHTML = records.length
    ? records
        .map(
          (r) =>
            `<li><span>${esc(r.label)}</span><span><span class="rec-val">${esc(String(r.value))}</span> <span class="rec-date">${fmtDate(r.sessionId).slice(0, 10)}</span></span></li>`
        )
        .join('')
    : '<li class="empty-state">No saved sessions yet.</li>';

  const trendGrid = $('trend-grid');
  trendGrid.innerHTML = '';
  const keys = [['overall', 'Overall'], ...SUBSCORES];
  for (const [key, name] of keys) {
    const cell = document.createElement('div');
    cell.className = 'trend-cell';
    cell.innerHTML = `<div class="trend-name">${name}</div>`;
    const canvas = document.createElement('canvas');
    cell.appendChild(canvas);
    trendGrid.appendChild(cell);
    // trend lines track real teaching — uploaded test videos are excluded
    const values = sessions.filter((s) => s.type !== 'upload').map((s) => s.scores?.[key]).filter((v) => v != null);
    requestAnimationFrame(() => drawSparkline(canvas, values, key === 'overall' ? INK.amber : INK.cyan));
  }

  const list = $('session-list');
  list.innerHTML = '';
  if (!sessions.length) {
    list.innerHTML = '<div class="empty-state">Nothing on tape yet. Run a session and hit Save.</div>';
    return;
  }
  for (const s of [...sessions].reverse()) {
    const row = document.createElement('div');
    row.className = 'session-row';
    const subs = SUBSCORES.map(([k]) => `${k.slice(0, 3).toUpperCase()} ${s.scores?.[k] ?? '—'}`).join(' · ');
    row.innerHTML = `
      <div class="s-score" style="color:${scoreColor(s.scores?.overall ?? 0)}">${s.scores?.overall ?? '—'}</div>
      <div class="s-meta">
        <div class="s-title">${esc(modes.find((m) => m.id === s.mode)?.title || s.mode)} · ${s.type === 'upload' ? '⬆ upload' : s.type === 'live' ? 'live' : 'rehearsal'}</div>
        <div class="s-sub">${fmtDate(s.sessionId)} · ${fmtClock(s.durationSec)}${s.nonlectureSec ? ` · lec ${fmtClock(s.lectureSec)} / act ${fmtClock(s.nonlectureSec)}` : ''}</div>
      </div>
      <div class="s-subscores">${subs}</div>
      <div class="s-actions">
        <button class="btn" data-act="view">View</button>
        <button class="btn subtle" data-act="export">JSON</button>
        <button class="btn subtle" data-act="delete">✕</button>
      </div>`;
    row.querySelector('[data-act="view"]').addEventListener('click', () => {
      currentSession = s;
      currentSessionSaved = true;
      renderReport(s);
    });
    row.querySelector('[data-act="export"]').addEventListener('click', () => store.exportSession(s));
    row.querySelector('[data-act="delete"]').addEventListener('click', () => {
      if (confirm(`Delete session ${s.sessionId}? This cannot be undone.`)) {
        store.deleteSession(s.sessionId);
        renderHistory();
      }
    });
    list.appendChild(row);
  }
}

$('import-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const session = await store.importSessionFile(file);
    store.saveSession(session);
    renderHistory();
  } catch (err) {
    alert(`Import failed: ${err.message}`);
  }
  e.target.value = '';
});

// ============================================================ utilities

function fmtClock(sec) {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function fmtDate(sessionId) {
  // "2026-07-10T09-15-00" → "2026-07-10 09:15"
  const [date, time] = sessionId.split('T');
  return time ? `${date} ${time.slice(0, 5).replace('-', ':')}` : sessionId;
}

function esc(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function escapeRe(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// pointer-aware modules: feed the cursor position into the hovered module's
// CSS variables so its spotlight (see studio.css) tracks the mouse
if (window.matchMedia('(hover: hover)').matches) {
  document.addEventListener('pointermove', (e) => {
    const mod = e.target.closest?.('.module');
    if (!mod || mod.closest('.dev-overlay')) return; // dev panel opts out
    const r = mod.getBoundingClientRect();
    mod.style.setProperty('--mx', `${Math.round(e.clientX - r.left)}px`);
    mod.style.setProperty('--my', `${Math.round(e.clientY - r.top)}px`);
  });
}

// redraw charts on resize (canvas backing store depends on layout size)
let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (currentSession && $('view-report').classList.contains('active')) drawReportCharts(currentSession);
  }, 200);
});

// warn before closing the tab mid-session
window.addEventListener('beforeunload', (e) => {
  if (live) {
    e.preventDefault();
    e.returnValue = '';
  }
});

const r1 = (v) => Math.round(v * 10) / 10;

// boot
buildDial();
initDevPanel();
initSetup();
