// Session persistence: Articulation sessions round-trip, and older/other-mode
// sessions stay compatible. storage.js talks to localStorage, so we shim it.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// Minimal localStorage shim installed before importing storage.js.
class MemStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}
globalThis.localStorage = new MemStorage();

let store;
before(async () => { store = await import('../public/js/storage.js'); });

const articulationSession = {
  version: 1,
  sessionId: '2026-07-15T10-00-00',
  mode: 'articulation',
  type: 'rehearsal',
  durationSec: 190,
  lectureSec: 190,
  nonlectureSec: 0,
  scores: { overall: 80, pace: 82, clarity: 78, engagement: 100, vocalEnergy: 70, accuracy: null },
  timeline: { wpm: [[30, 130]], energy: [[30, 0.4]], attention: [], nonlecture: [], fillers: [], stutters: [] },
  accuracyFlags: null,
  transcript: [{ t: 0, end: 4, text: 'Hello students, welcome.' }],
  customFillerList: ['um', 'uh'],
  articulation: { topicId: 'other', topicLabel: 'Other Topic', customTopic: 'Why recursion matters', targetMin: 3 },
  targetDurationSec: 180,
  articulationAnalysis: { summary: 'Nice intro', topicAlignment: { rating: 'strong' } },
};

const legacyLectureSession = {
  version: 1,
  sessionId: '2026-07-01T09-00-00',
  mode: 'intro-python',
  type: 'rehearsal',
  durationSec: 3000,
  lectureSec: 2800,
  nonlectureSec: 200,
  scores: { overall: 74, pace: 80, clarity: 70, engagement: 72, vocalEnergy: 68, accuracy: 88 },
  timeline: { wpm: [[30, 140]], energy: [[30, 0.5]], nonlecture: [[300, 500]], fillers: [], stutters: [] },
  accuracyFlags: [],
  transcript: [{ t: 0, end: 4, text: 'Today we cover loops.' }],
  // note: no `articulation`, no `targetDurationSec` — an older/other-mode session
};

test('articulation session saves and reopens with topic, duration, and analysis intact', () => {
  assert.equal(store.saveSession(articulationSession).ok, true);
  const reopened = store.listSessions().find((s) => s.sessionId === articulationSession.sessionId);
  assert.ok(reopened, 'session should be retrievable');       // scenario 21
  assert.equal(reopened.articulation.topicId, 'other');       // scenario 14
  assert.equal(reopened.articulation.customTopic, 'Why recursion matters');
  assert.equal(reopened.articulation.targetMin, 3);
  assert.equal(reopened.targetDurationSec, 180);
  assert.equal(reopened.articulationAnalysis.topicAlignment.rating, 'strong');
});

test('an older/other-mode session without articulation fields stays compatible', () => {
  assert.equal(store.saveSession(legacyLectureSession).ok, true); // scenario 22
  const all = store.listSessions();
  const legacy = all.find((s) => s.sessionId === legacyLectureSession.sessionId);
  assert.ok(legacy);
  assert.equal(legacy.articulation, undefined, 'no articulation field is fine');
  assert.equal(legacy.mode, 'intro-python');
  // both sessions coexist and stay sorted by id
  assert.equal(all.length, 2);
  assert.ok(all[0].sessionId < all[1].sessionId);
});
