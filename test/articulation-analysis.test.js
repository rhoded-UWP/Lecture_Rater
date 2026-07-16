// Tests for the server-side articulation prompt builder + response validator.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildArticulationPrompt,
  validateArticulationAnalysis,
  intentForTopic,
  ARTICULATION_TOPIC_INTENTS,
} from '../providers/articulation-analysis.js';

const baseCtx = {
  topicId: 'introduce-course',
  topicLabel: 'Introduce a Course',
  customTopic: '',
  targetMin: 3,
  actualMin: 3.4,
  metrics: { avgWpm: 132, fillersPerMin: 2.1, fillerCount: 7, stutterCount: 1, longestStretchSec: 180, meanEnergy: 0.41 },
  transcriptText: '[00:00] Welcome to the course. [00:20] We will cover loops and functions.',
};

test('prompt includes topic label, target, actual duration, metrics, and transcript', () => {
  const p = buildArticulationPrompt(baseCtx);
  assert.match(p, /Introduce a Course/);
  assert.match(p, /Target duration: 3 minute/);
  assert.match(p, /Actual spoken duration: 3\.4 minute/);
  assert.match(p, /132 words\/min/);
  assert.match(p, /Welcome to the course/);
});

test('prompt asks for topic alignment, engagement opinion, and rhetorical highlights', () => {
  const p = buildArticulationPrompt(baseCtx);
  assert.match(p, /TOPIC ALIGNMENT/);
  assert.match(p, /ENGAGEMENT & ENTERTAINMENT/);
  assert.match(p, /LANGUAGE & RHETORICAL/);
  assert.match(p, /not a measured audience reaction|not fact-checking|NOT fact-checking/i);
});

test('prompt spells "wit", never "whit"', () => {
  const p = buildArticulationPrompt(baseCtx);
  assert.match(p, /\bwit\b/);
  assert.ok(!/\bwhit\b/.test(p), 'must not contain the misspelling "whit"');
});

test('custom topic is passed through verbatim', () => {
  const p = buildArticulationPrompt({ ...baseCtx, topicId: 'other', topicLabel: 'Other Topic', customTopic: 'Why pointers matter' });
  assert.match(p, /Why pointers matter/);
});

test('intentForTopic returns the built-in intent for defaults and the custom prompt for "other"', () => {
  assert.equal(intentForTopic({ topicId: 'introduce-self' }).length > 0, true);
  assert.ok(ARTICULATION_TOPIC_INTENTS['introduce-course']);
  assert.match(intentForTopic({ topicId: 'other', customTopic: 'X-ray tech' }), /X-ray tech/);
});

test('validator fills safe defaults for a completely empty response', () => {
  const a = validateArticulationAnalysis(null);
  assert.equal(a.summary, '');
  assert.equal(a.topicAlignment.rating, 'adequate');
  assert.deepEqual(a.engagement.memorable, []);
  assert.deepEqual(a.rhetorical.examples, []);
  assert.deepEqual(a.recommendations, []);
});

test('validator coerces malformed / partial fields without throwing', () => {
  const a = validateArticulationAnalysis({
    summary: 'Solid intro.',
    topicAlignment: { rating: 'excellent', onTopic: 'stayed focused' }, // bad rating → adequate
    engagement: { rating: 'strong', memorable: ['great hook', 42, null], suggestions: 'nope' }, // mixed array, wrong type
    rhetorical: { examples: [{ quote: 'a rising tide', technique: 'metaphor' }, { technique: 'no quote' }] },
    recommendations: ['tighten the open', 7],
  });
  assert.equal(a.topicAlignment.rating, 'adequate');
  assert.equal(a.topicAlignment.onTopic, 'stayed focused');
  assert.equal(a.engagement.rating, 'strong');
  assert.deepEqual(a.engagement.memorable, ['great hook']); // non-strings dropped
  assert.deepEqual(a.engagement.suggestions, []);           // wrong type → []
  assert.equal(a.rhetorical.examples.length, 1);            // example without a quote dropped
  assert.equal(a.rhetorical.examples[0].quote, 'a rising tide');
  assert.deepEqual(a.recommendations, ['tighten the open']);
});
