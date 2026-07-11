// Developer Tools control panel.
//
// Gate: the developer password is never stored anywhere in this codebase —
// only its SHA-256 digest lives below; the input is hashed with Web Crypto
// and compared. (This is an obfuscation gate for a single-user tool, not
// real security: the actual secrets — API keys — live only in server
// environment variables and never reach the browser.)
//
// Panel: LIVE provider switching. The dropdowns read and write the server's
// /api/settings — the choice is persisted server-side (dev-settings.json)
// and takes effect on the next pipeline run, no restart needed. Plus a
// token/usage ledger fed by app.js after each processing pass.

const PASS_SHA256 = 'c89460af16840ba1f4c48913140ff70cd8ca805e6b4707b807c5261d0f595e29';
const UNLOCKED_KEY = 'lc.devUnlocked'; // sessionStorage — relocks on tab close
const USAGE_KEY = 'lc.usage';

const $ = (id) => document.getElementById(id);

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ------------------------------------------------------------ usage ledger

function loadUsage() {
  try {
    const arr = JSON.parse(localStorage.getItem(USAGE_KEY) || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/** Called from app.js after each processing pass.
 * entry: { role, provider, model, minutes?, inputTokens?, outputTokens?, costUSD? } */
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

  let cfg = null;
  try {
    cfg = await (await fetch('/api/settings')).json();
  } catch {
    /* server unreachable */
  }

  const usage = loadUsage();
  const totals = usageTotals(usage);

  if (!cfg) {
    panel.innerHTML = `<p class="dim-note">Server unreachable — provider switching needs the Node server running.</p>`;
    return;
  }

  const led = (ok) =>
    `<span class="led ${ok ? 'lit-green' : ''}" title="${ok ? 'API key configured' : 'no API key — set its env var'}"></span>`;

  const tOpts = (selected) =>
    cfg.transcriptionProviders
      .map((p) => `<option value="${p.id}" ${p.id === selected ? 'selected' : ''}>${esc(p.label)}${p.configured ? '' : ' — no key'}</option>`)
      .join('');
  const mOpts = (selected) =>
    cfg.analysisModels
      .map((m) => `<option value="${m.id}" ${m.id === selected ? 'selected' : ''}>${esc(m.label)} · $${m.pricing.inPerM}/$${m.pricing.outPerM} per M${m.approxPricing ? '≈' : ''}${m.configured ? '' : ' — no key'}</option>`)
      .join('');

  const tSel = cfg.transcriptionProviders.find((p) => p.id === cfg.settings.transcriptionProvider);
  const fSel = cfg.analysisModels.find((m) => m.id === cfg.settings.factcheckModelId);
  const dSel = cfg.analysisModels.find((m) => m.id === cfg.settings.deepAnalysisModelId);

  panel.innerHTML = `
    <p class="dim-note">API keys live only in server environment variables
    (<code>OPENAI_API_KEY</code>, <code>ASSEMBLYAI_API_KEY</code>, <code>ANTHROPIC_API_KEY</code>,
    <code>DEEPSEEK_API_KEY</code>, <code>MOONSHOT_API_KEY</code>) and never reach this browser.
    Selections below are saved on the server and apply to the next run — no restart needed.</p>

    <div class="dev-endpoints">
      <div class="dev-endpoint">
        <div class="dev-ep-head">${led(true)}<strong>Transcription — live captions</strong>
          <span class="dev-route mono">browser · real-time · free</span></div>
        <div class="dev-ep-fields"><span class="dim-note">Google Web Speech (Chrome built-in) — not swappable; it feeds the live dashboard only.</span></div>
      </div>

      <div class="dev-endpoint">
        <div class="dev-ep-head">${led(!!tSel?.configured)}<strong>Transcription — precision pass</strong>
          <span class="dev-route mono">POST /api/transcribe</span></div>
        <div class="dev-ep-fields">
          <label>provider
            <select data-key="transcriptionProvider">${tOpts(cfg.settings.transcriptionProvider)}</select>
          </label>
          <span class="dim-note">~$${((tSel?.costPerMin ?? 0) * 60).toFixed(2)}/hr${tSel?.approxPricing ? ' (approx.)' : ''}</span>
        </div>
      </div>

      <div class="dev-endpoint">
        <div class="dev-ep-head">${led(!!fSel?.configured)}<strong>Quick fact-check — runs every session</strong>
          <span class="dev-route mono">POST /api/factcheck</span></div>
        <div class="dev-ep-fields">
          <label>model
            <select data-key="factcheckModelId">${mOpts(cfg.settings.factcheckModelId)}</select>
          </label>
        </div>
      </div>

      <div class="dev-endpoint">
        <div class="dev-ep-head">${led(!!dSel?.configured)}<strong>Deep analysis — manual, button-triggered only</strong>
          <span class="dev-route mono">POST /api/deep-analysis</span></div>
        <div class="dev-ep-fields">
          <label>model
            <select data-key="deepAnalysisModelId">${mOpts(cfg.settings.deepAnalysisModelId)}</select>
          </label>
        </div>
      </div>
    </div>
    <p class="dim-note">Prices marked ≈ are editable estimates in <code>providers/catalog.js</code> —
    check the provider's pricing page. To add a provider or model, add a catalog entry and its key.</p>

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
            <td class="num">${fmtCost(estCost(u))}</td>
          </tr>`).join('') || '<tr><td colspan="7" class="empty-state">No AI calls logged yet.</td></tr>'}
      </table>
    </div>`;

  panel.querySelectorAll('select[data-key]').forEach((sel) => {
    sel.addEventListener('change', async () => {
      try {
        await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ [sel.dataset.key]: sel.value }),
        });
      } catch {
        /* leave the UI as-is; re-render below shows server truth */
      }
      renderPanel();
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

// Legacy per-role rates for ledger entries logged before costUSD existed.
const LEGACY_RATES = { 'tone-timing': 0.006 }; // $/audio-min

function estCost(u) {
  if (u.costUSD != null) return u.costUSD;
  const rate = LEGACY_RATES[u.role];
  if (rate != null && u.minutes != null) return u.minutes * rate;
  return null;
}

function usageTotals(usage) {
  let inTok = 0, outTok = 0, minutes = 0, cost = 0, costKnown = false;
  for (const u of usage) {
    inTok += u.inputTokens ?? 0;
    outTok += u.outputTokens ?? 0;
    minutes += u.minutes ?? 0;
    const c = estCost(u);
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
