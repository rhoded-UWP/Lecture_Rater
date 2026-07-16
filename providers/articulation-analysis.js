// Articulation Practice — the specialized post-session analysis.
//
// Server-side prompt construction + response validation for the
// /api/deep-analysis route when analysisKind === 'articulation'. This replaces
// the lecture route's content-review + outcome-alignment with:
//   · Topic Alignment   — did the talk fulfil the chosen prompt, with a clear
//                          beginning / middle / end and supporting detail?
//   · Engagement        — an explicit AI opinion on how interesting the talk is.
//   · Rhetorical         — notable language techniques, quoted from the speaker.
// Delivery/timing feedback is computed client-side from real metrics, so it
// survives even if this AI pass fails.
//
// The coaching *intent* for each default prompt lives here (not in the client)
// so prompt engineering stays server-side.

const RATINGS = ['strong', 'adequate', 'weak'];

export const ARTICULATION_TOPIC_INTENTS = {
  'introduce-self':
    'A self-introduction should help students understand who the instructor is, their role, their background, and what kind of classroom experience students can expect.',
  'introduce-course':
    'A course introduction should explain the subject, the major course topics, what students will learn, and why the material is useful or important.',
  'topic-story':
    'A topic-related story should connect the story or interesting information clearly to an instructional topic, sparking interest or understanding.',
};

/** Human-readable intent for the chosen prompt (falls back to the custom text). */
export function intentForTopic({ topicId, topicLabel, customTopic } = {}) {
  if (topicId === 'other') {
    return `The speaker chose a custom prompt: "${customTopic || topicLabel || ''}". Evaluate the talk against that exact prompt.`;
  }
  return ARTICULATION_TOPIC_INTENTS[topicId] || `Evaluate the talk against the prompt "${topicLabel || topicId}".`;
}

/** Build the single-prompt analysis text sent to the model. */
export function buildArticulationPrompt({
  topicId,
  topicLabel,
  customTopic,
  targetMin,
  actualMin,
  metrics = {},
  transcriptText,
}) {
  const promptLine =
    topicId === 'other' && customTopic
      ? `Chosen speaking prompt: "${customTopic}" (custom topic)`
      : `Chosen speaking prompt: "${topicLabel || topicId}"`;

  const metricLines = [
    metrics.avgWpm != null ? `- Average speaking pace: ${Math.round(metrics.avgWpm)} words/min` : '',
    metrics.fillersPerMin != null ? `- Filler words: ${metrics.fillersPerMin.toFixed(1)} per minute (${metrics.fillerCount ?? 0} total)` : '',
    metrics.stutterCount != null ? `- Stutters/restarts detected: ${metrics.stutterCount}` : '',
    metrics.longestStretchSec != null ? `- Longest continuous speaking stretch: ${Math.round(metrics.longestStretchSec)} s` : '',
    metrics.meanEnergy != null ? `- Mean vocal energy (0–1): ${metrics.meanEnergy.toFixed(2)}` : '',
  ].filter(Boolean).join('\n');

  return `You are an experienced public-speaking and presentation coach. An instructor recorded a short spoken presentation to rehearse their delivery, and wants candid, specific feedback. This is NOT fact-checking — do not judge factual accuracy.

${promptLine}
Intent of this prompt: ${intentForTopic({ topicId, topicLabel, customTopic })}
Target duration: ${targetMin} minute(s). Actual spoken duration: ${actualMin.toFixed(1)} minute(s).

Delivery metrics already measured by the app (use these; do not recompute):
${metricLines || '- (none available)'}

Analyze the transcript below and produce THREE things:

1. TOPIC ALIGNMENT — how well the presentation addressed the chosen prompt: whether the speaker stayed focused on the topic, whether the prompt's main purpose was fulfilled, whether there was a recognizable beginning, middle, and conclusion, whether ideas were logically organized, whether examples and details supported the topic, whether the speaker wandered into unrelated material, and whether the level of detail suited the target duration.

2. ENGAGEMENT & ENTERTAINMENT — YOUR OPINION (state it as an assessment, not a measured audience reaction) on how interesting, engaging, and entertaining this is likely to be for an audience: strength of the opening, whether it creates curiosity, use of examples/stories/imagery/surprise/contrast/humor, whether it is likely to hold attention, the most memorable moments, and any sections that feel repetitive, flat, overly abstract, or hard to follow. Avoid generic praise; reference specific portions of the transcript. Give concrete ways to make it more engaging.

3. LANGUAGE & RHETORICAL HIGHLIGHTS — identify effective uses of rhythm, repetition, alliteration, parallel structure, wordplay, wit, humor, vivid language, memorable phrasing, rhetorical questions, contrast, or storytelling (including wit and clever humor). Quote only brief portions of the speaker's own words, and explain why each example is effective. If there are no meaningful examples, say so constructively and suggest one or two places where stronger rhetorical language would help.

Respond with ONLY a JSON object (no prose, no code fence) in exactly this shape:
{
  "summary": "<2-3 sentence overall take on the presentation>",
  "topicAlignment": {
    "rating": "strong"|"adequate"|"weak",
    "onTopic": "<did they stay on the prompt / wander?>",
    "structure": "<beginning, middle, conclusion; logical organization>",
    "support": "<examples and details that supported the topic>",
    "detailForDuration": "<was the depth right for the target length?>",
    "comment": "<1-2 sentence overall judgment on fulfilling the prompt>"
  },
  "engagement": {
    "rating": "strong"|"adequate"|"weak",
    "opening": "<how strong is the opening?>",
    "curiosity": "<does it create curiosity / hold attention?>",
    "memorable": ["<a specific memorable moment>", "..."],
    "flatSpots": ["<a specific flat / repetitive / abstract section>", "..."],
    "suggestions": ["<a concrete way to make it more engaging>", "..."]
  },
  "rhetorical": {
    "examples": [{"quote": "<brief quote from the speaker>", "technique": "<e.g. alliteration, wit, parallel structure>", "why": "<why it works>"}],
    "note": "<if few/no examples, a constructive note>",
    "suggestions": ["<where to add stronger rhetorical language>", "..."]
  },
  "recommendations": ["<the most actionable next-rehearsal improvement>", "..."]
}

TRANSCRIPT:
${transcriptText}`;
}

// ------------------------------------------------------------ validation

const str = (v, fallback = '') => (typeof v === 'string' ? v : fallback);
const strArr = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s.trim()) : []);
const rating = (v) => (RATINGS.includes(v) ? v : 'adequate');

/** Coerce a parsed model response into a safe, fully-populated shape. Missing
 *  or malformed fields degrade to empty defaults rather than throwing, so the
 *  UI can always render whatever the model did return. */
export function validateArticulationAnalysis(parsed) {
  const p = parsed && typeof parsed === 'object' ? parsed : {};
  const ta = p.topicAlignment && typeof p.topicAlignment === 'object' ? p.topicAlignment : {};
  const en = p.engagement && typeof p.engagement === 'object' ? p.engagement : {};
  const rh = p.rhetorical && typeof p.rhetorical === 'object' ? p.rhetorical : {};

  return {
    summary: str(p.summary),
    topicAlignment: {
      rating: rating(ta.rating),
      onTopic: str(ta.onTopic),
      structure: str(ta.structure),
      support: str(ta.support),
      detailForDuration: str(ta.detailForDuration),
      comment: str(ta.comment),
    },
    engagement: {
      rating: rating(en.rating),
      opening: str(en.opening),
      curiosity: str(en.curiosity),
      memorable: strArr(en.memorable),
      flatSpots: strArr(en.flatSpots),
      suggestions: strArr(en.suggestions),
    },
    rhetorical: {
      examples: Array.isArray(rh.examples)
        ? rh.examples
            .filter((e) => e && typeof e === 'object' && typeof e.quote === 'string')
            .map((e) => ({ quote: str(e.quote), technique: str(e.technique), why: str(e.why) }))
        : [],
      note: str(rh.note),
      suggestions: strArr(rh.suggestions),
    },
    recommendations: strArr(p.recommendations),
  };
}
