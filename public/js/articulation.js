// Articulation Practice mode.
//
// This module owns everything mode-specific about Articulation Practice so the
// rest of the app stays generic:
//   · the speaking prompts and duration options (single source of truth),
//   · the per-mode analysis plan (which passes run) — a feature-flag object
//     rather than scattered `if (mode === 'articulation')` checks,
//   · pure validation + session-shaping helpers (DOM-free, so Node tests and
//     the server-side prompt builder can share them),
//   · the pre-session setup modal controller (the only part that touches the
//     DOM, and only when invoked at runtime).
//
// Keep the top level DOM-free: `test/*.test.js` imports this file under Node.

export const ARTICULATION_MODE_ID = 'articulation';

/** Speaking prompts shown in the setup modal. `blurb` is UI copy; the AI
 *  coaching *intent* for each prompt lives server-side (providers/
 *  articulation-analysis.js) so prompt engineering never ships to the client. */
export const ARTICULATION_TOPICS = [
  {
    id: 'introduce-self',
    label: 'Introduce Yourself to Your Students',
    blurb: 'Rehearse the personal introduction you would give students at the beginning of a course.',
  },
  {
    id: 'introduce-course',
    label: 'Introduce a Course',
    blurb: 'Explain the major topics a course covers, what students will learn, and why the content matters.',
  },
  {
    id: 'topic-story',
    label: 'Tell a Topic-Related Story',
    blurb: 'Share a story, example, or interesting fact that helps a class understand or care about a topic.',
  },
  {
    id: 'other',
    label: 'Other Topic',
    blurb: 'Enter a custom speaking topic or practice prompt.',
  },
];

export const DURATION_PRESETS_MIN = [2, 3, 4, 5];
export const CUSTOM_DURATION_MIN = 2;
export const CUSTOM_DURATION_MAX = 75;

// Timing feedback: how far actual duration may drift from target before it is
// called "significantly" off. A few seconds should never count, so the band is
// the larger of a fixed floor and a fraction of the target.
export const TIMING_TOLERANCE_FRAC = 0.15;
export const TIMING_TOLERANCE_FLOOR_SEC = 20;

export function isArticulationMode(mode) {
  return mode?.kind === 'articulation' || mode?.id === ARTICULATION_MODE_ID;
}

/** The single place that decides which analysis passes a mode uses. Prefer
 *  reading a flag off this object over re-testing the mode id downstream. */
export function analysisPlanForMode(mode) {
  if (isArticulationMode(mode)) {
    return {
      preSessionModal: true,
      factcheck: false,
      outcomeAlignment: false,
      topicAlignment: true,
      engagement: true,
      rhetorical: true,
      targetDuration: true,
      liveLabels: 'presentation',
    };
  }
  return {
    preSessionModal: false,
    factcheck: mode?.factcheck !== false,
    outcomeAlignment: true,
    topicAlignment: false,
    engagement: false,
    rhetorical: false,
    targetDuration: false,
    liveLabels: 'lecture',
  };
}

/** @returns {{ok:true,value:string}|{ok:false,error:string}} */
export function validateCustomTopic(text) {
  const value = String(text ?? '').trim();
  if (!value) return { ok: false, error: 'Enter a speaking topic to practice.' };
  return { ok: true, value };
}

/** Custom target duration, in whole minutes, within [MIN, MAX].
 *  @returns {{ok:true,value:number}|{ok:false,error:string}} */
export function validateTargetDuration(raw) {
  const str = typeof raw === 'number' ? String(raw) : String(raw ?? '').trim();
  if (!str) return { ok: false, error: 'Enter a duration in minutes.' };
  const n = Number(str);
  if (!Number.isFinite(n)) return { ok: false, error: 'Enter a number of minutes.' };
  if (n < CUSTOM_DURATION_MIN) return { ok: false, error: `Minimum is ${CUSTOM_DURATION_MIN} minutes.` };
  if (n > CUSTOM_DURATION_MAX) return { ok: false, error: `Maximum is ${CUSTOM_DURATION_MAX} minutes.` };
  return { ok: true, value: Math.round(n) };
}

/** Validate a raw setup selection into the object saved on the session.
 *  @returns {{ok:true,value:object}|{ok:false,error:string}} */
export function resolveArticulationSetup({ topicId, customTopic, targetMin } = {}) {
  const topic = ARTICULATION_TOPICS.find((t) => t.id === topicId);
  if (!topic) return { ok: false, error: 'Choose a speaking prompt.' };

  let topicLabel = topic.label;
  let custom = '';
  if (topic.id === 'other') {
    const v = validateCustomTopic(customTopic);
    if (!v.ok) return v;
    custom = v.value;
  }
  const d = validateTargetDuration(targetMin);
  if (!d.ok) return d;

  return {
    ok: true,
    value: { topicId: topic.id, topicLabel, customTopic: custom, targetMin: d.value },
  };
}

/** The prompt text shown to the user (custom text when "Other"). */
export function articulationPromptText(articulation) {
  if (!articulation) return '';
  return articulation.topicId === 'other' && articulation.customTopic
    ? articulation.customTopic
    : articulation.topicLabel;
}

/** Deterministic timing feedback — computed without the AI so it survives an
 *  analysis failure. `code` ∈ short | close | long | unknown. */
export function timingAssessment(actualSec, targetSec) {
  if (!targetSec) return { code: 'unknown', label: 'no target set' };
  const tol = Math.max(TIMING_TOLERANCE_FLOOR_SEC, targetSec * TIMING_TOLERANCE_FRAC);
  const diff = actualSec - targetSec;
  if (Math.abs(diff) <= tol) return { code: 'close', label: 'close to the target' };
  if (diff < 0) return { code: 'short', label: 'significantly shorter than the target' };
  return { code: 'long', label: 'significantly longer than the target' };
}

// ============================================================ setup modal
// The only DOM-touching code in this file. Markup lives in index.html
// (#artic-overlay); this wires it and returns a promise.

const $ = (id) => document.getElementById(id);

let modalState = null; // { resolve, previousFocus, keydown }

/** Show the Articulation Practice setup modal.
 *  @returns {Promise<object|null>} resolved setup value, or null if cancelled. */
export function openArticulationSetup() {
  return new Promise((resolve) => {
    const overlay = $('artic-overlay');
    const form = $('artic-form');
    if (!overlay || !form) {
      resolve(null);
      return;
    }

    renderTopics();
    renderDurations();
    resetModalInputs();

    const previousFocus = document.activeElement;
    overlay.classList.remove('hidden');

    const keydown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        finish(null);
      } else if (e.key === 'Tab') {
        trapTab(e, overlay);
      }
    };
    document.addEventListener('keydown', keydown, true);

    modalState = { resolve, previousFocus, keydown };

    // focus the first control for keyboard users
    setTimeout(() => overlay.querySelector('input, button')?.focus(), 0);

    // one-time wiring per open (removed on finish via cloneless handlers below)
    overlay.onclick = (e) => { if (e.target === overlay) finish(null); };
    $('artic-cancel').onclick = () => finish(null);
    $('artic-cancel-x').onclick = () => finish(null);
    form.onsubmit = (e) => {
      e.preventDefault();
      submitModal();
    };
  });
}

function finish(value) {
  const state = modalState;
  if (!state) return;
  modalState = null;
  document.removeEventListener('keydown', state.keydown, true);
  $('artic-overlay').classList.add('hidden');
  clearErrors();
  if (state.previousFocus?.focus) state.previousFocus.focus();
  state.resolve(value);
}

function submitModal() {
  clearErrors();
  const topicId = selectedRadio('artic-topic');
  const customTopic = $('artic-custom')?.value ?? '';
  const durSel = selectedRadio('artic-duration');
  const targetMin = durSel === 'other' ? ($('artic-dur')?.value ?? '') : durSel;

  if (!topicId) {
    showError('artic-custom-error', 'Choose a speaking prompt.');
    return;
  }
  if (topicId === 'other') {
    const v = validateCustomTopic(customTopic);
    if (!v.ok) { showError('artic-custom-error', v.error); $('artic-custom').focus(); return; }
  }
  if (!durSel) {
    showError('artic-dur-error', 'Choose a target duration.');
    return;
  }
  const setup = resolveArticulationSetup({ topicId, customTopic, targetMin });
  if (!setup.ok) {
    // route the error to the field it belongs to
    const durType = durSel === 'other';
    showError(durType ? 'artic-dur-error' : 'artic-custom-error', setup.error);
    if (durType) $('artic-dur').focus();
    return;
  }

  // guard against a double submit while we hand off to Go Live
  $('artic-begin').disabled = true;
  finish(setup.value);
}

// ------------------------------------------------------------ modal DOM helpers

function renderTopics() {
  const box = $('artic-topics');
  if (box.dataset.rendered) return;
  box.innerHTML = ARTICULATION_TOPICS.map((t, i) => `
    <label class="artic-choice">
      <input type="radio" name="artic-topic" value="${t.id}" ${i === 0 ? '' : ''}>
      <span class="artic-choice-body">
        <span class="artic-choice-title">${escHtml(t.label)}</span>
        <span class="artic-choice-sub">${escHtml(t.blurb)}</span>
      </span>
    </label>`).join('');
  box.addEventListener('change', () => {
    const other = selectedRadio('artic-topic') === 'other';
    $('artic-custom-wrap').classList.toggle('hidden', !other);
    if (other) $('artic-custom').focus();
    clearError('artic-custom-error');
  });
  box.dataset.rendered = '1';
}

function renderDurations() {
  const box = $('artic-durations');
  if (box.dataset.rendered) return;
  const chips = DURATION_PRESETS_MIN.map((m) => `
    <label class="artic-chip">
      <input type="radio" name="artic-duration" value="${m}">
      <span>${m} min</span>
    </label>`).join('');
  box.innerHTML = chips + `
    <label class="artic-chip">
      <input type="radio" name="artic-duration" value="other">
      <span>Other</span>
    </label>`;
  box.addEventListener('change', () => {
    const other = selectedRadio('artic-duration') === 'other';
    $('artic-dur-wrap').classList.toggle('hidden', !other);
    if (other) $('artic-dur').focus();
    clearError('artic-dur-error');
  });
  box.dataset.rendered = '1';
}

function resetModalInputs() {
  document.querySelectorAll('input[name="artic-topic"], input[name="artic-duration"]').forEach((r) => (r.checked = false));
  $('artic-custom').value = '';
  $('artic-dur').value = '';
  $('artic-custom-wrap').classList.add('hidden');
  $('artic-dur-wrap').classList.add('hidden');
  $('artic-begin').disabled = false;
  clearErrors();
}

function selectedRadio(name) {
  return document.querySelector(`input[name="${name}"]:checked`)?.value ?? null;
}

function showError(id, msg) {
  const el = $(id);
  if (el) { el.textContent = msg; el.classList.add('show'); }
}
function clearError(id) {
  const el = $(id);
  if (el) { el.textContent = ''; el.classList.remove('show'); }
}
function clearErrors() {
  clearError('artic-custom-error');
  clearError('artic-dur-error');
}

/** Keep Tab focus inside the modal (simple focus trap). */
function trapTab(e, overlay) {
  const focusable = [...overlay.querySelectorAll('input, button, [tabindex]:not([tabindex="-1"])')]
    .filter((el) => !el.disabled && el.offsetParent !== null);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

function escHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
