// Delivery-fluency metric + Clarity-scoring feed.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dysfluencyPer100Words, totalWordCount } from '../public/js/metrics.js';
import { classifyDysfluency, classifyFillerRate, DEFAULTS } from '../public/js/config.js';
import { computeScores } from '../public/js/scoring.js';

// A precision session: 20 spoken words, 2 fillers + 1 stutter = 3 dysfluencies.
function precisionSession(overrides = {}) {
  return {
    precision: true,
    durationSec: 120,
    lectureSec: 120,
    nonlectureSec: 0,
    paceProfile: 'standard',
    accuracyFlags: null,
    transcript: [
      { t: 0, end: 6, text: 'okay so today we are going to talk about loops and lists' }, // 12 words
      { t: 6, end: 12, text: 'um they are basically a way to repeat' },                   // 8 words
    ],
    timeline: {
      wpm: [[30, 130], [60, 128]],
      energy: [[30, 0.4], [60, 0.42]],
      nonlecture: [],
      fillers: [{ t: 6, word: 'um' }, { t: 1, word: 'so' }],
      stutters: [{ t: 8, kind: 'repeat', text: 'a a' }],
    },
    ...overrides,
  };
}

test('totalWordCount tokenizes the whole transcript', () => {
  assert.equal(totalWordCount(precisionSession()), 20);
});

test('dysfluencyPer100Words = (fillers + stutters) / words * 100', () => {
  // 3 dysfluencies / 20 words * 100 = 15
  assert.equal(dysfluencyPer100Words(precisionSession()), 15);
});

test('dysfluencyPer100Words is null without a precision transcript or words', () => {
  assert.equal(dysfluencyPer100Words(precisionSession({ precision: false })), null);
  assert.equal(dysfluencyPer100Words(precisionSession({ transcript: [] })), null);
  assert.equal(dysfluencyPer100Words({ precision: true }), null);
});

test('dysfluency band: <=6 conversational, >6 higher than conversational', () => {
  assert.equal(classifyDysfluency(6).key, 'conversational');
  assert.equal(classifyDysfluency(5.9).key, 'conversational');
  assert.equal(classifyDysfluency(6.1).key, 'elevated');
  assert.equal(classifyDysfluency(20).key, 'elevated');
});

test('filler-rate bands: pristine / optimum / elevated / high / hurts', () => {
  assert.equal(classifyFillerRate(0.5).key, 'pristine');
  assert.equal(classifyFillerRate(1).key, 'optimum');
  assert.equal(classifyFillerRate(2.9).key, 'optimum');
  assert.equal(classifyFillerRate(3).key, 'elevated');
  assert.equal(classifyFillerRate(4.9).key, 'elevated');
  assert.equal(classifyFillerRate(5).key, 'high');
  assert.equal(classifyFillerRate(9.9).key, 'high');
  assert.equal(classifyFillerRate(10).key, 'hurts');
  assert.equal(classifyFillerRate(25).key, 'hurts');
});

test('Clarity subscore drops when dysfluencies exceed conversational (precision only)', () => {
  const s = { ...DEFAULTS };
  const high = computeScores(precisionSession(), s).clarity; // 15/100w, well over 6

  // Same filler/stutter counts but spread over many more words → under conversational.
  const manyWords = precisionSession({
    transcript: Array.from({ length: 20 }, (_, i) => ({
      t: i, end: i + 1, text: 'one two three four five six seven eight nine ten',
    })), // 200 words → 3 dysfluencies = 1.5 / 100w
  });
  const low = computeScores(manyWords, s).clarity;
  assert.ok(low > high, `denser dysfluency should score lower clarity (low=${low}, high=${high})`);
});

test('the new threshold does not affect non-precision sessions', () => {
  const s = { ...DEFAULTS };
  const base = precisionSession({ precision: false });
  // Recompute clarity with and without the (inapplicable) per-100 term: identical,
  // since dysfluencyPer100Words returns null for non-precision.
  const clarity = computeScores(base, s).clarity;
  const fpm = base.timeline.fillers.length / (base.lectureSec / 60);
  const spm = base.timeline.stutters.length / (base.lectureSec / 60);
  const expected = Math.max(0, Math.min(100, Math.round(100 - fpm * s.pointsPerFillerPerMin - spm * s.pointsPerStutterPerMin)));
  assert.equal(clarity, expected);
});
