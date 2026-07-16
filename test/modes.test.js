// Mode-file integrity: Articulation Practice exists as a selectable mode with
// fact-checking disabled, and other modes are unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const MODES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'modes');
const readMode = async (f) => JSON.parse(await readFile(path.join(MODES_DIR, f), 'utf8'));

test('articulation mode file exists and is a valid selectable mode', async () => {
  const m = await readMode('articulation.json');   // scenario 1
  assert.equal(m.id, 'articulation');
  assert.equal(m.kind, 'articulation');
  assert.equal(m.factcheck, false);                // scenario 15/16 at the data layer
  assert.ok(m.title && m.subject && m.level);
});

test('every mode file parses and other modes keep fact-checking on', async () => {
  const files = (await readdir(MODES_DIR)).filter((f) => f.endsWith('.json'));
  assert.ok(files.includes('articulation.json'));
  for (const f of files) {
    const m = await readMode(f);
    assert.ok(m.id, `${f} needs an id`);
    if (m.id !== 'articulation') {
      assert.notEqual(m.factcheck, false, `${f} should not have fact-check disabled`); // scenario 20
    }
  }
});
