// Estimated Attention model — implements attention-timeline-feature-spec.md §5.
//
// P(t) = sigmoid( baselineLogit(effectiveMinutes) + Σ eventBoost_j(t) )
// AttentionScore = clamp(100·P, 5, 95)
//
// The live dashboard has one generic event type — the nonlecture activity
// toggle — which maps to the spec's "other nonlecture interaction"
// (modeWeight 0.30, gamma 0.35, half-life 3 min). Resets are partial and
// temporary; the model never returns to 100% (spec §4.2).
//
// This is a research-informed estimate, not a measurement of individual
// students (spec §2). Isolated module: remove this file plus its call sites
// to roll the feature back.

export const ATTENTION = {
  lectureWeight: 1.0,        // spec §5.2 — lecture / passive presentation
  interactionWeight: 0.3,    // spec §5.2 — other nonlecture interaction
  interactionGamma: 0.35,    // spec §5.4 — boost while the activity runs
  interactionHalfLifeMin: 3, // spec §5.4 — post-event decay half-life
  clampLo: 5,                // spec §5.6 — never imply certainty at 0/100
  clampHi: 95,
};

const sigmoid = (x) => 1 / (1 + Math.exp(-x));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Spec §5.3 — piecewise logistic baseline for uninterrupted presentation.
export function baselineLogit(effectiveMinutes) {
  const m = Math.max(0, effectiveMinutes);
  return 1.236 - 0.052 * Math.min(m, 30) - 0.015 * Math.max(0, m - 30);
}

// Spec §5.8 — band widens as the model extrapolates past 30 effective min.
export function uncertaintyWidth(effectiveMinutes) {
  return Math.min(20, 8 + Math.max(0, effectiveMinutes - 30) * 0.35);
}

/**
 * Estimate attention at minute `tMin`, given nonlecture blocks in minutes:
 * [{ start, end|null }] (null = still running). Time outside blocks is
 * uninterrupted lecture — so calling this with future times and the current
 * block list doubles as the "if you just keep lecturing" projection.
 */
export function estimateAttention(tMin, blocks) {
  let nonlectureMin = 0;
  let boost = 0;
  for (const b of blocks) {
    const start = b.start;
    const end = b.end ?? tMin;
    if (tMin <= start) continue;
    nonlectureMin += Math.max(0, Math.min(tMin, end) - start);
    if (tMin <= end) {
      boost += ATTENTION.interactionGamma; // active event
    } else {
      boost += ATTENTION.interactionGamma * Math.pow(2, -(tMin - end) / ATTENTION.interactionHalfLifeMin);
    }
  }

  const effMin =
    (tMin - nonlectureMin) * ATTENTION.lectureWeight +
    nonlectureMin * ATTENTION.interactionWeight;

  const score = clamp(100 * sigmoid(baselineLogit(effMin) + boost), ATTENTION.clampLo, ATTENTION.clampHi);
  const width = uncertaintyWidth(effMin);
  return {
    score,
    lower: clamp(score - width, 0, 100),
    upper: clamp(score + width, 0, 100),
    effMin,
    confidence: effMin <= 30 ? 'moderate' : 'low',
  };
}

/** Convert session-second nonlecture intervals ({start,end}|[s,e]) to minutes. */
export function blocksToMinutes(nonlecture) {
  return (nonlecture || []).map((b) => {
    const start = (b.start ?? b[0]) / 60;
    const endRaw = b.end !== undefined ? b.end : b[1];
    return { start, end: endRaw == null ? null : endRaw / 60 };
  });
}
