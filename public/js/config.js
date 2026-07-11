// All tunable constants live here — no magic numbers elsewhere.
// Everything in DEFAULTS is user-editable in the Setup screen's settings
// panel and persisted to localStorage.

// Research-based pacing bands (see Words_Per_Minute_Research.md).
// "standard" follows the suggested live-lecture gauge: green 116–150,
// yellow 100–115 / 151–165, orange 166–179, red 180+.
// "dense" shifts everything down for note-heavy material, where note-taking
// is only workable up to ~135 WPM.
export const PACE_PROFILES = {
  standard: {
    label: 'Standard lecture',
    verySlowBelow: 100,
    deliberate: [100, 115],
    sweet: [116, 150],
    brisk: [151, 165],
    fast: [166, 179], // 180+ = too fast
  },
  dense: {
    label: 'Dense · note-heavy',
    verySlowBelow: 95,
    deliberate: [95, 109],
    sweet: [110, 135],
    brisk: [136, 150],
    fast: [151, 165], // 166+ = too fast
  },
};

// Zone display language + scoring credit per timeline sample.
// Slow zones keep most of their credit — the research treats slowing down
// as potentially useful; sustained speed is the clearest concern.
export const PACE_ZONES = {
  veryslow: { label: 'VERY SLOW', color: 'amber', credit: 0.5 },
  deliberate: { label: 'DELIBERATE', color: 'amber', credit: 0.75 },
  sweet: { label: 'SWEET SPOT', color: 'green', credit: 1 },
  brisk: { label: 'BRISK', color: 'amber', credit: 0.75 },
  fast: { label: 'FAST FOR NOTES', color: 'orange', credit: 0.4 },
  toofast: { label: 'TOO FAST', color: 'red', credit: 0 },
};

export function classifyWpm(wpm, profileKey) {
  const p = PACE_PROFILES[profileKey] || PACE_PROFILES.standard;
  if (wpm < p.verySlowBelow) return 'veryslow';
  if (wpm <= p.deliberate[1]) return 'deliberate';
  if (wpm <= p.sweet[1]) return 'sweet';
  if (wpm <= p.brisk[1]) return 'brisk';
  if (wpm <= p.fast[1]) return 'fast';
  return 'toofast';
}

export const DEFAULTS = {
  // --- Session ---
  lectureLengthMin: 50,       // planned class length: 50, 75, or custom minutes
  lectureEndWarnMin: 5,       // TOT timer turns amber this many minutes before the end

  // --- Pace ---
  paceProfile: 'standard',    // which PACE_PROFILES gauge is active
  wpmWindowSec: 30,           // rolling window for the live WPM gauge (research: 20–30s)
  sustainedFastSec: 45,       // fast/too-fast held this long → escalate (research: 30–60s)
  paceSustainedPenalty: 10,   // pace points lost per sustained-fast stretch
  paceSustainedPenaltyCap: 30,

  // --- Clarity ---
  fillerWords: ['um', 'uh', 'like', 'you know', 'so', 'right?', 'okay?'],
  customFillerWords: [],      // personal tics, edited on the Setup screen
  pointsPerFillerPerMin: 12,  // clarity points lost per (filler/min)
  pointsPerStutterPerMin: 15, // clarity points lost per (stutter/min)

  // --- Engagement ---
  monologueWarnSec: 180,      // stopwatch turns amber here
  monologueAlertSec: 300,     // stopwatch turns red; engagement penalties scale past this
  targetInteractionGapSec: 240, // ideal average gap between interactions

  // --- Vocal energy ---
  energyFloor: 0.15,          // below this the meter reads "monotone"
  monotoneStretchSec: 120,    // sustained low-energy stretch that costs points

  // --- Accuracy ---
  severityPoints: { low: 3, medium: 8, high: 15 },

  // --- Headline score weights (renormalized if accuracy unavailable) ---
  weights: { pace: 0.2, clarity: 0.25, engagement: 0.25, vocalEnergy: 0.15, accuracy: 0.15 },

  // --- Privacy (Live Classroom) ---
  // Transcript inside this window after each nonlecture block ends may contain
  // student speech: it is excluded from fact-checking and scoring in Live mode.
  interactionExclusionSec: 10,

  // --- Uploaded-video testing pipeline ---
  // A word gap at least this long in an uploaded lecture is treated as
  // inferred nonlecture activity (lab/video/break) for attention/engagement.
  uploadSilenceNonlectureSec: 120,

  // --- Sampling / detection ---
  timelineSampleSec: 5,       // resolution of the wpm/energy timelines
  stutterGapSec: 1.5,         // mid-sentence pause counted as a hesitation
  audioBitsPerSecond: 32000,  // Opus bitrate for the upload (~12 MB / 50 min)
};

const SETTINGS_KEY = 'lc.settings';

export function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    return { ...DEFAULTS, ...saved, weights: { ...DEFAULTS.weights, ...(saved.weights || {}) } };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings) {
  const diff = {};
  for (const k of Object.keys(settings)) {
    if (JSON.stringify(settings[k]) !== JSON.stringify(DEFAULTS[k])) diff[k] = settings[k];
  }
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(diff));
}

export function activeFillerList(settings) {
  const seen = new Set();
  return [...settings.fillerWords, ...settings.customFillerWords]
    .map((w) => w.trim().toLowerCase())
    .filter((w) => w && !seen.has(w) && seen.add(w));
}
