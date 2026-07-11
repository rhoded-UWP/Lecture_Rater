// Developer Tools control panel.
//
// Gate: the developer password is never stored anywhere in this codebase —
// only its SHA-256 digest lives below; the input is hashed with Web Crypto
// and compared. (This is an obfuscation gate for a single-user tool, not
// real security: the actual secrets — API keys — live only in Render
// environment variables and never reach the browser.)
//
// Panel: registry of the AI endpoints behind each pipeline role (editable,
// persisted locally — a skeleton for the future provider-swap feature) plus
// a token/usage ledger fed by app.js after each processing pass.

const PASS_SHA256 = 'c89460af16840ba1f4c48913140ff70cd8ca805e6b4707b807c5261d0f595e29';
const UNLOCKED_KEY = 'lc.devUnlocked'; // sessionStorage — relocks on tab close
const ENDPOINTS_KEY = 'lc.devEndpoints';
const USAGE_KEY = 'lc.usage';

// Pipeline roles and their current (assumed) providers. `rate` is an
// editable $-per-unit estimate; blank = no cost estimate shown.
const DEFAULT_ENDPOINTS = [
  {
    id: 'transcription',
    role: 'Transcription — live captions',
    provider: 'Google Web Speech API',
    model: 'chrome built-in',
    route: 'browser · real-time',
    unit: 'min',
    rate: '0',
  },
  {
    id: 'tone-timing',
    role: 'Tone & timing — precision pass',
    provider: 'OpenAI Whisper',
    model: 'whisper-1',
    route: 'POST /api/transcribe',
    unit: 'min',
    rate: '0.006',
  },
  {
    id: 'content',
    role: 'Content analysis — goals, accuracy & summary',
    provider: 'Anthropic Claude',
    model: 'claude-opus-4-8',
    route: 'POST /api/factcheck',
    unit: 'tokens',
    rate: '',
  },
];

const $ = (id) => document.getElementById(id);

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ------------------------------------------------------------ persistence

function loadEndpoints() {
  try {
    const saved = JSON.parse(localStorage.getItem(ENDPOINTS_KEY) || '[]');
    return DEFAULT_ENDPOINTS.map((d) => ({ ...d, ...(saved.find((s) => s.id === d.id) || {}) }));
  } catch {
    return structuredClone(DEFAULT_ENDPOINTS);
  }
}

function saveEndpoints(endpoints) {
  localStorage.setItem(ENDPOINTS_KEY, JSON.stringify(endpoints));
}

function loadUsage() {
  try {
    const arr = JSON.parse(localStorage.getItem(USAGE_KEY) || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/** Called from app.js after each processing pass.
 * entry: { role, provider, model, minutes?, inputTokens?, outputTokens?, note? } */
export function logUsage(entry) {
  const usage = loadUsage();
  usage.push({ ts: new Date().toISOString().slice(0, 16), ...entry });
  localStorage.setItem(USAGE_KEY, JSON.stringify(usage.slice(-500))); // keep last 500
}

// ------------------------------------------------------------ panel

export function initDevPanel() {
  $('devtools-btn').addEventListener('click', open);
  $('dev-close').addEventListener('click', close);
  $('dev-overlay').addEventListener('click', (e) => {
    if (e.target === $('dev-overlay')) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('dev-overlay').classList.contains('hidden')) close();
  });

  $('dev-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const hash = await sha256Hex($('dev-pass').value);
    if (hash === PASS_SHA256) {
      sessionStorage.setItem(UNLOCKED_KEY, '1');
      $('dev-pass').value = '';
      $('dev-error').classList.add('hidden');
      showPanel();
    } else {
      $('dev-error').classList.remove('hidden');
      $('dev-pass').select();
    }
  });
}

function open() {
  $('dev-overlay').classList.remove('hidden');
  if (sessionStorage.getItem(UNLOCKED_KEY) === '1') showPanel();
  else {
    $('dev-lock').classList.remove('hidden');
    $('dev-panel').classList.add('hidden');
    $('dev-pass').focus();
  }
}

function close() {
  $('dev-overlay').classList.add('hidden');
}

async function showPanel() {
  $('dev-lock').classList.add('hidden');
  $('dev-panel').classList.remove('hidden');
  await renderPanel();
}

async function renderPanel() {
  const panel = $('dev-panel');

  let status = null;
  try {
    status = await (await fetch('/api/status')).json();
  } catch {
    /* server unreachable */
  }

  const endpoints = loadEndpoints();
  const usage = loadUsage();
  const totals = usageTotals(usage, endpoints);

  const statusLed = (ok) =>
    `<span class="led ${ok ? 'lit-green' : ''}" title="${ok ? 'configured' : 'not configured'}"></span>`;
  const keyState = (id) =>
    id === 'transcription' ? true
    : id === 'tone-timing' ? !!status?.whisperConfigured
    : !!status?.claudeConfigured;

  panel.innerHTML = `
    <p class="dim-note">API keys live only in Render environment variables (<code>OPENAI_API_KEY</code>,
    <code>ANTHROPIC_API_KEY</code>) and never reach this browser. Server fact-check model:
    <code>${esc(status?.factcheckModel || 'server offline')}</code></p>

    <div class="dev-endpoints">
      ${endpoints.map((ep) => `
        <div class="dev-endpoint" data-id="${ep.id}">
          <div class="dev-ep-head">${statusLed(keyState(ep.id))}<strong>${esc(ep.role)}</strong>
            <span class="dev-route mono">${esc(ep.route)}</span></div>
          <div class="dev-ep-fields">
            <label>provider<input data-field="provider" value="${esc(ep.provider)}"></label>
            <label>model<input data-field="model" value="${esc(ep.model)}"></label>
            <label>$ / ${ep.unit === 'min' ? 'audio min' : '1K tokens'}<input data-field="rate" value="${esc(ep.rate)}" placeholder="—"></label>
          </div>
        </div>`).join('')}
    </div>
    <p class="dim-note">Provider/model fields are a skeleton for the future endpoint-swap feature —
    edits persist locally but the server routes are governed by its environment variables today.</p>

    <div class="dev-deploy-note">
      <strong>Before publishing / going wider:</strong>
      Two suggestions when you deploy: (1) consider Render's "secret files" if you ever need more
      than two keys, and (2) if the app ever gets a public URL, add a shared secret header check on
      /api/transcribe//api/factcheck so strangers can't run up your bill — the dev panel would be
      the natural place to enter it. The ledger is also localStorage-per-browser; if you want usage
      tracked across machines, that needs a tiny server-side counter later.
    </div>

    <div class="dev-usage-head">
      <strong>Usage ledger</strong>
      <span class="mono dim">${totals.summary}</span>
      <button class="btn subtle" id="dev-usage-reset">Reset</button>
    </div>
    <div class="dev-usage-scroll">
      <table class="data-table" id="dev-usage-table">
        <tr><th>when</th><th>role</th><th>model</th><th>in&nbsp;tok</th><th>out&nbsp;tok</th><th>min</th><th>est&nbsp;$</th></tr>
        ${usage.slice(-40).reverse().map((u) => `
          <tr>
            <td>${esc(u.ts)}</td><td>${esc(u.role)}</td><td>${esc(u.model || '')}</td>
            <td class="num">${u.inputTokens ?? ''}</td><td class="num">${u.outputTokens ?? ''}</td>
            <td class="num">${u.minutes != null ? u.minutes.toFixed(1) : ''}</td>
            <td class="num">${fmtCost(estCost(u, endpoints))}</td>
          </tr>`).join('') || '<tr><td colspan="7" class="empty-state">No AI calls logged yet.</td></tr>'}
      </table>
    </div>`;

  panel.querySelectorAll('.dev-endpoint input').forEach((input) => {
    input.addEventListener('change', () => {
      const eps = loadEndpoints();
      const ep = eps.find((x) => x.id === input.closest('.dev-endpoint').dataset.id);
      ep[input.dataset.field] = input.value.trim();
      saveEndpoints(eps);
      renderPanel(); // refresh totals with new rates
    });
  });

  panel.querySelector('#dev-usage-reset').addEventListener('click', () => {
    if (confirm('Clear the entire usage ledger?')) {
      localStorage.removeItem(USAGE_KEY);
      renderPanel();
    }
  });
}

// ------------------------------------------------------------ usage math

function estCost(u, endpoints) {
  const ep = endpoints.find((e) => e.role === u.role || e.id === u.role);
  const rate = parseFloat(ep?.rate);
  if (!ep || Number.isNaN(rate)) return null;
  if (ep.unit === 'min') return u.minutes != null ? u.minutes * rate : null;
  const tokens = (u.inputTokens ?? 0) + (u.outputTokens ?? 0);
  return tokens ? (tokens / 1000) * rate : null;
}

function usageTotals(usage, endpoints) {
  let inTok = 0, outTok = 0, minutes = 0, cost = 0, costKnown = false;
  for (const u of usage) {
    inTok += u.inputTokens ?? 0;
    outTok += u.outputTokens ?? 0;
    minutes += u.minutes ?? 0;
    const c = estCost(u, endpoints);
    if (c != null) { cost += c; costKnown = true; }
  }
  return {
    summary: `${usage.length} calls · ${inTok + outTok} tokens (${inTok} in / ${outTok} out) · ${minutes.toFixed(0)} audio min · est ${costKnown ? '$' + cost.toFixed(2) : '—'}`,
  };
}

const fmtCost = (c) => (c == null ? '' : c < 0.01 && c > 0 ? '<0.01' : c.toFixed(2));

function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
