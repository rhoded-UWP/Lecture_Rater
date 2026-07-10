// Session persistence: localStorage + JSON file export/import.
// Nothing ever goes server-side — this module is the whole "database".

const SESSIONS_KEY = 'lc.sessions';

export function listSessions() {
  try {
    const arr = JSON.parse(localStorage.getItem(SESSIONS_KEY) || '[]');
    return Array.isArray(arr) ? arr.sort((a, b) => a.sessionId.localeCompare(b.sessionId)) : [];
  } catch {
    return [];
  }
}

export function saveSession(session) {
  const sessions = listSessions().filter((s) => s.sessionId !== session.sessionId);
  sessions.push(session);
  try {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `localStorage full or unavailable: ${err.message}` };
  }
}

export function deleteSession(sessionId) {
  const sessions = listSessions().filter((s) => s.sessionId !== sessionId);
  localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
}

export function exportSession(session) {
  const blob = new Blob([JSON.stringify(session, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `lecture-${session.sessionId}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

/** @returns {Promise<object>} the imported session, validated */
export function importSessionFile(file) {
  return file.text().then((text) => {
    const session = JSON.parse(text);
    if (!session.sessionId || !session.scores || !session.timeline) {
      throw new Error('Not a Lecture Coach session file.');
    }
    return session;
  });
}

/** Personal records across all saved sessions. */
export function personalRecords(sessions) {
  if (!sessions.length) return [];
  const scored = sessions.filter((s) => s.scores);
  const best = (key, label, fmt = (v) => v) => {
    let top = null;
    for (const s of scored) {
      const v = s.scores[key];
      if (v != null && (top === null || v > top.value)) top = { value: v, session: s };
    }
    return top && { label, value: fmt(top.value), sessionId: top.session.sessionId };
  };

  const records = [
    best('overall', 'Best overall score'),
    best('engagement', 'Best engagement'),
    best('clarity', 'Best clarity'),
  ].filter(Boolean);

  let lowestFpm = null;
  for (const s of scored) {
    const min = s.durationSec / 60;
    if (min < 5) continue; // don't count tiny test sessions
    const fpm = (s.timeline?.fillers?.length ?? 0) / min;
    if (lowestFpm === null || fpm < lowestFpm.value) lowestFpm = { value: fpm, session: s };
  }
  if (lowestFpm) {
    records.push({
      label: 'Cleanest session (fillers/min)',
      value: lowestFpm.value.toFixed(1),
      sessionId: lowestFpm.session.sessionId,
    });
  }

  const longest = scored.reduce((a, b) => (b.durationSec > (a?.durationSec ?? 0) ? b : a), null);
  if (longest) {
    records.push({
      label: 'Longest session',
      value: `${Math.round(longest.durationSec / 60)} min`,
      sessionId: longest.sessionId,
    });
  }
  return records;
}
