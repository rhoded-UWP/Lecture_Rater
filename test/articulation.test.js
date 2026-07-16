// Pure-logic tests for Articulation Practice (no DOM). Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ARTICULATION_TOPICS,
  DURATION_PRESETS_MIN,
  analysisPlanForMode,
  isArticulationMode,
  validateCustomTopic,
  validateTargetDuration,
  resolveArticulationSetup,
  articulationPromptText,
  timingAssessment,
} from '../public/js/articulation.js';

const ARTIC_MODE = { id: 'articulation', kind: 'articulation', factcheck: false };
const LECTURE_MODE = { id: 'intro-python', title: 'Intro' };

test('default speaking prompts include the four required options', () => {
  const ids = ARTICULATION_TOPICS.map((t) => t.id);
  assert.deepEqual(ids, ['introduce-self', 'introduce-course', 'topic-story', 'other']);
  for (const t of ARTICULATION_TOPICS) {
    assert.ok(t.label && t.blurb, `topic ${t.id} needs label + blurb`);
  }
});

test('duration presets are 2/3/4/5 minutes', () => {
  assert.deepEqual(DURATION_PRESETS_MIN, [2, 3, 4, 5]);
});

test('isArticulationMode detects by kind or id', () => {
  assert.equal(isArticulationMode(ARTIC_MODE), true);
  assert.equal(isArticulationMode({ id: 'articulation' }), true);
  assert.equal(isArticulationMode(LECTURE_MODE), false);
  assert.equal(isArticulationMode(undefined), false);
});

test('analysis plan: articulation skips fact-check + outcome alignment, adds topic/engagement/rhetoric', () => {
  const p = analysisPlanForMode(ARTIC_MODE);
  assert.equal(p.preSessionModal, true);
  assert.equal(p.factcheck, false);            // scenario 15
  assert.equal(p.outcomeAlignment, false);     // scenario 16
  assert.equal(p.topicAlignment, true);        // scenario 17
  assert.equal(p.engagement, true);            // scenario 18
  assert.equal(p.rhetorical, true);            // scenario 19
  assert.equal(p.targetDuration, true);
  assert.equal(p.liveLabels, 'presentation');
});

test('analysis plan: other modes keep fact-check + outcome alignment, no modal', () => {
  const p = analysisPlanForMode(LECTURE_MODE);
  assert.equal(p.preSessionModal, false);      // scenario 3
  assert.equal(p.factcheck, true);             // scenario 20
  assert.equal(p.outcomeAlignment, true);
  assert.equal(p.topicAlignment, false);
  assert.equal(p.liveLabels, 'lecture');
});

test('analysis plan honors an explicit factcheck:false lecture mode', () => {
  assert.equal(analysisPlanForMode({ id: 'x', factcheck: false }).factcheck, false);
});

test('custom topic must not be blank or whitespace', () => {
  assert.equal(validateCustomTopic('').ok, false);        // scenario 6
  assert.equal(validateCustomTopic('   ').ok, false);
  assert.equal(validateCustomTopic('\t\n ').ok, false);
  const ok = validateCustomTopic('  Why recursion rocks  ');
  assert.equal(ok.ok, true);
  assert.equal(ok.value, 'Why recursion rocks');          // trimmed
});

test('target duration accepts 2 through 75', () => {
  for (const v of [2, 3, 37, 75]) {
    const r = validateTargetDuration(v);                  // scenario 8
    assert.equal(r.ok, true, `${v} should be valid`);
    assert.equal(r.value, v);
  }
});

test('target duration rejects below 2', () => {
  for (const v of [1, 0, -5, 1.9]) {                      // scenario 9
    assert.equal(validateTargetDuration(v).ok, false, `${v} should be rejected`);
  }
});

test('target duration rejects above 75', () => {
  for (const v of [76, 100, 1000]) {                      // scenario 10
    assert.equal(validateTargetDuration(v).ok, false, `${v} should be rejected`);
  }
});

test('target duration rejects blank / nonnumeric', () => {
  for (const v of ['', '   ', 'abc', '5 minutes', null, undefined, NaN]) { // scenario 11
    assert.equal(validateTargetDuration(v).ok, false, `${JSON.stringify(v)} should be rejected`);
  }
});

test('each default topic resolves; "other" requires custom text', () => {
  for (const id of ['introduce-self', 'introduce-course', 'topic-story']) { // scenario 5
    const r = resolveArticulationSetup({ topicId: id, targetMin: 3 });
    assert.equal(r.ok, true, `${id} should resolve`);
    assert.equal(r.value.customTopic, '');
    assert.equal(r.value.targetMin, 3);
  }
  assert.equal(resolveArticulationSetup({ topicId: 'other', customTopic: '', targetMin: 3 }).ok, false);
  const custom = resolveArticulationSetup({ topicId: 'other', customTopic: 'Recursion', targetMin: 4 });
  assert.equal(custom.ok, true);
  assert.equal(custom.value.customTopic, 'Recursion');
});

test('resolveArticulationSetup rejects an unknown topic id and out-of-range duration', () => {
  assert.equal(resolveArticulationSetup({ topicId: 'nope', targetMin: 3 }).ok, false);
  assert.equal(resolveArticulationSetup({ topicId: 'topic-story', targetMin: 99 }).ok, false);
});

test('articulationPromptText prefers custom text for "other"', () => {
  assert.equal(articulationPromptText({ topicId: 'other', topicLabel: 'Other Topic', customTopic: 'Big O' }), 'Big O');
  assert.equal(articulationPromptText({ topicId: 'introduce-self', topicLabel: 'Introduce Yourself to Your Students' }), 'Introduce Yourself to Your Students');
});

test('timing assessment tolerates small differences, flags large ones', () => {
  const target = 180; // 3 min
  assert.equal(timingAssessment(180, target).code, 'close');
  assert.equal(timingAssessment(185, target).code, 'close');   // few seconds → close
  assert.equal(timingAssessment(160, target).code, 'close');   // within 15%
  assert.equal(timingAssessment(90, target).code, 'short');    // significantly shorter
  assert.equal(timingAssessment(300, target).code, 'long');    // significantly longer
  assert.equal(timingAssessment(120, 0).code, 'unknown');
});
