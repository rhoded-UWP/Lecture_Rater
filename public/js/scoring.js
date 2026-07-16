// The five 0–100 subscores and the weighted headline score.
// Every constant comes from settings (config.js) — tune there, not here.

import { lectureStretches, dysfluencyPer100Words } from './metrics.js';
import { classifyWpm, PACE_ZONES } from './config.js';

// Scoring-model shape constants. These define HOW penalties scale — the
// user-tunable thresholds they interact with (targets, alert lengths,
// floors, weights) stay in settings per the rule above.
const MIN_SCOREABLE_SEC = 30;          // shorter sessions score 0 engagement — too little signal
const AVG_STRETCH_PENALTY_SCALE = 50;  // points lost when avg stretch reaches 2× the target gap
const MARATHON_POINTS_PER_MIN = 8;     // per minute the longest stretch runs past the alert length
const UNBROKEN_LECTURE_CAP = 25;       // score ceiling when an alert-length class had zero breaks
const ENERGY_FULL_MARKS_SCALE = 120;   // mean energy × 120 → 0.83+ (≈5/6 dynamic) earns 100
const MONOTONE_PENALTY_STEP_SEC = 30;  // penalty accrues per this much time below the energy floor…
const MONOTONE_POINTS_PER_STEP = 5;    // …costing this many points per step

export function computeScores(session, settings) {
  // Per-minute rates use lecture time only — nonlecture activity doesn't count.
  const durationMin = Math.max((session.lectureSec ?? session.durationSec) / 60, 0.5);

  const pace = paceScore(session.timeline.wpm, session.paceProfile || settings.paceProfile, settings);
  const clarity = clarityScore(session, durationMin, settings);
  const engagement = engagementScore(session, settings);
  // Uploaded videos carry no vocal-energy analysis (v1) — renormalize it out
  // instead of scoring a fake zero, same as an unavailable accuracy pass.
  const vocalEnergy =
    session.type === 'upload' && !session.timeline.energy?.length
      ? null
      : energyScore(session.timeline.energy, settings);
  const accuracy = session.accuracyFlags ? accuracyScore(session.accuracyFlags, settings) : null;

  const parts = { pace, clarity, engagement, vocalEnergy, accuracy };
  let totalWeight = 0;
  let sum = 0;
  for (const [key, score] of Object.entries(parts)) {
    if (score === null) continue; // accuracy unavailable → renormalize
    const w = settings.weights[key] ?? 0;
    totalWeight += w;
    sum += w * score;
  }
  const overall = totalWeight > 0 ? Math.round(sum / totalWeight) : 0;
  return { overall, ...parts };
}

// Pace: each timeline sample earns the research-band credit for its zone
// (sweet spot = full credit; slow zones keep most credit; fast zones little).
// Sustained fast stretches — the clearest research concern — cost extra.
function paceScore(wpmTimeline, profileKey, s) {
  const samples = wpmTimeline.filter(([, wpm]) => wpm > 0);
  if (!samples.length) return 0;

  let credit = 0;
  for (const [, wpm] of samples) credit += PACE_ZONES[classifyWpm(wpm, profileKey)].credit;
  let score = (credit / samples.length) * 100;

  // sustained fast/too-fast stretches
  let stretch = 0;
  let penalty = 0;
  for (let i = 0; i < samples.length; i++) {
    const zone = classifyWpm(samples[i][1], profileKey);
    const dt = i > 0 ? samples[i][0] - samples[i - 1][0] : s.timelineSampleSec;
    if (zone === 'fast' || zone === 'toofast') {
      stretch += dt;
      if (stretch >= s.sustainedFastSec) {
        penalty += s.paceSustainedPenalty;
        stretch = 0; // count each sustained block once, then keep watching
      }
    } else {
      stretch = 0;
    }
  }
  score -= Math.min(penalty, s.paceSustainedPenaltyCap);
  return clamp100(score);
}

// Clarity: fillers/min and stutters/min each cost configured points. When a
// precision transcript gives a reliable word count, dysfluencies beyond the
// conversational level (~6 per 100 words) cost extra — normalizing for pace,
// since a fast talker racks up fillers/min without being less fluent per word.
function clarityScore(session, durationMin, s) {
  const fpm = session.timeline.fillers.length / durationMin;
  const spm = (session.timeline.stutters?.length ?? 0) / durationMin;
  let score = 100 - fpm * s.pointsPerFillerPerMin - spm * s.pointsPerStutterPerMin;

  const per100 = dysfluencyPer100Words(session);
  if (per100 != null && per100 > s.conversationalDysfluencyPer100) {
    score -= (per100 - s.conversationalDysfluencyPer100) * s.pointsPerDysfluencyOver6;
  }
  return clamp100(score);
}

// Engagement: uninterrupted lecture stretches between nonlecture activity
// (labs / videos). Average stretch near target is good; marathon monologues
// cost extra.
function engagementScore(session, s) {
  const dur = session.durationSec;
  if (dur < MIN_SCOREABLE_SEC) return 0;
  const stretches = lectureStretches(session.timeline, dur).map((g) => g.len);
  if (!stretches.length) return 0;

  const avgStretch = stretches.reduce((a, b) => a + b, 0) / stretches.length;
  const longest = Math.max(...stretches);
  const breaks = (session.timeline.nonlecture?.length ?? session.timeline.interactions?.length ?? 0);

  let score = 100;
  if (avgStretch > s.targetInteractionGapSec) {
    score -= ((avgStretch - s.targetInteractionGapSec) / s.targetInteractionGapSec) * AVG_STRETCH_PENALTY_SCALE;
  }
  if (longest > s.monologueAlertSec) {
    score -= ((longest - s.monologueAlertSec) / 60) * MARATHON_POINTS_PER_MIN;
  }
  if (breaks === 0 && dur > s.monologueAlertSec) {
    score = Math.min(score, UNBROKEN_LECTURE_CAP); // a whole class of unbroken lecture
  }
  return clamp100(score);
}

// Vocal energy: mean level, with a penalty for sustained monotone stretches.
function energyScore(energyTimeline, s) {
  if (!energyTimeline.length) return 0;
  const values = energyTimeline.map(([, e]) => e);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  let score = Math.round(mean * ENERGY_FULL_MARKS_SCALE);

  let stretch = 0;
  let worst = 0;
  for (let i = 1; i < energyTimeline.length; i++) {
    const [t, e] = energyTimeline[i];
    const dt = t - energyTimeline[i - 1][0];
    stretch = e < s.energyFloor ? stretch + dt : 0;
    worst = Math.max(worst, stretch);
  }
  if (worst > s.monotoneStretchSec) {
    score -= Math.round((worst - s.monotoneStretchSec) / MONOTONE_PENALTY_STEP_SEC) * MONOTONE_POINTS_PER_STEP;
  }
  return clamp100(score);
}

function accuracyScore(flags, s) {
  const penalty = flags.reduce((sum, f) => sum + (s.severityPoints[f.severity] ?? s.severityPoints.medium), 0);
  return clamp100(100 - penalty);
}

const clamp100 = (v) => Math.max(0, Math.min(100, Math.round(v)));
