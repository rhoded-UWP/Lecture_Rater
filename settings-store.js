// Server-side developer settings: which provider/model each pipeline role
// uses. Persisted to dev-settings.json (gitignored) so dev-panel choices
// survive restarts. API keys are NOT stored here — they stay in env vars.

import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { findTranscriptionProvider, findAnalysisModel } from './providers/catalog.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, 'dev-settings.json');

const DEFAULTS = {
  // AssemblyAI (disfluencies:true) is the default precision pass: unlike
  // Whisper it transcribes fillers and stutters verbatim, so they can be
  // counted. Whisper remains selectable in the dev panel.
  transcriptionProvider: 'assemblyai',
  factcheckModelId: 'claude-haiku-4-5', // quick pass — cheap model
  deepAnalysisModelId: 'claude-opus-4-8', // deep pass — best model
};

let settings = load();

function load() {
  try {
    const saved = JSON.parse(readFileSync(FILE, 'utf8'));
    return { ...DEFAULTS, ...validate(saved) };
  } catch {
    return { ...DEFAULTS };
  }
}

/** Keep only known keys whose values exist in the catalog. */
function validate(patch) {
  const clean = {};
  if (patch.transcriptionProvider && findTranscriptionProvider(patch.transcriptionProvider)) {
    clean.transcriptionProvider = patch.transcriptionProvider;
  }
  if (patch.factcheckModelId && findAnalysisModel(patch.factcheckModelId)) {
    clean.factcheckModelId = patch.factcheckModelId;
  }
  if (patch.deepAnalysisModelId && findAnalysisModel(patch.deepAnalysisModelId)) {
    clean.deepAnalysisModelId = patch.deepAnalysisModelId;
  }
  return clean;
}

export function getSettings() {
  return { ...settings };
}

/** Apply a partial update; unknown keys/values are ignored. Returns the
 *  full settings afterward. */
export function updateSettings(patch) {
  settings = { ...settings, ...validate(patch || {}) };
  try {
    writeFileSync(FILE, JSON.stringify(settings, null, 2));
  } catch (err) {
    console.warn(`Could not persist dev-settings.json: ${err.message}`);
  }
  return getSettings();
}
