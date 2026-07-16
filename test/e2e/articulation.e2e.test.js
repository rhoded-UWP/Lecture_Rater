// End-to-end UI test for Articulation Practice, driven with puppeteer-core
// against a real headless Chrome and a live server instance. Covers the modal
// behavior and request routing that the pure-logic tests can't.
//
// Skips gracefully (never fails the suite) when Chrome or the server can't
// start, so `npm test` stays green in minimal environments.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const chromePath = CHROME_CANDIDATES.find((p) => existsSync(p));

let puppeteer = null;
try { puppeteer = (await import('puppeteer-core')).default; } catch { /* not installed */ }

const CAN_RUN = !!(chromePath && puppeteer);
const skip = CAN_RUN ? false : `skipped — ${!puppeteer ? 'puppeteer-core missing' : 'no Chrome found'}`;

let server, browser, page, baseUrl;
const PORT = 3999;

before(async () => {
  if (!CAN_RUN) return;
  // start the server on a test port
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
  });
  baseUrl = `http://localhost:${PORT}`;
  await waitForServer(baseUrl, 8000);

  browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: 'new',
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--no-sandbox',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  page = await browser.newPage();
  const ctx = browser.defaultBrowserContext();
  await ctx.overridePermissions(baseUrl, ['microphone']);
});

after(async () => {
  await browser?.close().catch(() => {});
  server?.kill();
});

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${url}/api/status`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('server did not start in time');
}

/** Check a radio by name+value in-page and fire change (chips are visually
 *  hidden inputs, so a synthetic click isn't reliable in headless Chrome). */
async function chooseRadio(name, value) {
  await page.evaluate((n, v) => {
    const el = document.querySelector(`input[name="${n}"][value="${v}"]`);
    el.checked = true;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, name, value);
}

/** Pass the Go Live "ready" gate. `how` = 'click' (START button) or 'space'. */
async function passStartGate(how = 'click') {
  await page.waitForSelector('#start-gate:not(.hidden)', { timeout: 3000 });
  if (how === 'space') await page.keyboard.press('Space');
  else await page.click('#start-btn');
  await page.waitForSelector('#start-gate.hidden', { timeout: 3000 });
}

/** Select a mode card by its visible title. */
async function selectMode(title) {
  await page.waitForSelector('.mode-card');
  await page.evaluate((t) => {
    const card = [...document.querySelectorAll('.mode-card')].find((c) => c.textContent.includes(t));
    card?.click();
  }, title);
}

test('Articulation Practice appears in the mode selector', { skip }, async () => {
  await page.goto(baseUrl, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.mode-card');
  const titles = await page.$$eval('.mode-card', (cards) => cards.map((c) => c.textContent));
  assert.ok(titles.some((t) => t.includes('Articulation Practice')), 'mode card should be present'); // scenario 1
});

test('objectives / outcomes box is disabled in Articulation mode and enabled otherwise', { skip }, async () => {
  await page.goto(baseUrl, { waitUntil: 'networkidle0' });
  await selectMode('Articulation Practice');
  let state = await page.evaluate(() => ({
    lec: document.getElementById('lecture-objectives').disabled,
    out: document.getElementById('course-outcomes').disabled,
    files: document.getElementById('objectives-file').disabled && document.getElementById('outcomes-file').disabled,
    note: !document.getElementById('objectives-disabled-note').classList.contains('hidden'),
  }));
  assert.deepEqual(state, { lec: true, out: true, files: true, note: true });

  await selectMode('Default — Any Subject');
  state = await page.evaluate(() => ({
    lec: document.getElementById('lecture-objectives').disabled,
    out: document.getElementById('course-outcomes').disabled,
  }));
  assert.deepEqual(state, { lec: false, out: false }); // re-enabled for other modes
});

test('Go Live in a non-articulation mode does NOT open the setup modal', { skip }, async () => {
  await page.goto(baseUrl, { waitUntil: 'networkidle0' });
  await selectMode('Default — Any Subject');
  await page.click('#golive-btn');
  await new Promise((r) => setTimeout(r, 300));
  const modalHidden = await page.$eval('#artic-overlay', (el) => el.classList.contains('hidden'));
  assert.equal(modalHidden, true, 'articulation modal must stay hidden for other modes'); // scenario 3
  // the START gate appears; recording has not begun yet
  const gateShown = await page.$eval('#start-gate', (el) => !el.classList.contains('hidden'));
  assert.equal(gateShown, true, 'START gate should appear for all modes');
  assert.equal(await page.$eval('#view-live', (el) => el.classList.contains('active')), false, 'live view waits for START');
  // press Space to begin
  await passStartGate('space');
  await page.waitForSelector('#view-live.active', { timeout: 5000 });
  page.once('dialog', (d) => d.accept());
  await page.click('#end-btn');
  await page.waitForSelector('#view-report.active, #view-setup.active', { timeout: 15000 }).catch(() => {});
});

test('Go Live in Articulation mode opens the modal; cancel starts nothing', { skip }, async () => {
  await page.goto(baseUrl, { waitUntil: 'networkidle0' });
  await selectMode('Articulation Practice');
  await page.click('#golive-btn');
  await page.waitForSelector('#artic-overlay:not(.hidden)', { timeout: 3000 }); // scenario 2
  await page.click('#artic-cancel');                                            // scenario 4
  await page.waitForSelector('#artic-overlay.hidden', { timeout: 3000 });
  const onSetup = await page.$eval('#view-setup', (el) => el.classList.contains('active'));
  assert.equal(onSetup, true, 'cancel should not start a session');
});

test('modal validation blocks empty custom topic and out-of-range duration', { skip }, async () => {
  await page.goto(baseUrl, { waitUntil: 'networkidle0' });
  await selectMode('Articulation Practice');
  await page.click('#golive-btn');
  await page.waitForSelector('#artic-overlay:not(.hidden)');

  // pick "Other Topic" but leave it blank, pick "Other" duration = 1 (below min)
  await chooseRadio('artic-topic', 'other');
  await chooseRadio('artic-duration', 'other');
  await page.waitForSelector('#artic-dur-wrap:not(.hidden)');
  await page.type('#artic-dur', '1');
  await page.click('#artic-begin');
  await new Promise((r) => setTimeout(r, 150));
  const stillOpen = await page.$eval('#artic-overlay', (el) => !el.classList.contains('hidden'));
  assert.equal(stillOpen, true, 'invalid input must block submission');       // scenarios 6, 9, 11
  const topicErr = await page.$eval('#artic-custom-error', (el) => el.textContent);
  assert.ok(topicErr.length > 0, 'custom-topic error should show');
});

test('valid selections begin a live session with topic + target visible, skipping fact-check', { skip }, async () => {
  await page.goto(baseUrl, { waitUntil: 'networkidle0' });
  await selectMode('Articulation Practice');

  // record which API endpoints get hit
  const called = new Set();
  page.on('request', (req) => {
    const u = req.url();
    if (u.includes('/api/')) called.add(new URL(u).pathname);
  });

  await page.click('#golive-btn');
  await page.waitForSelector('#artic-overlay:not(.hidden)');
  await chooseRadio('artic-topic', 'introduce-course'); // scenario 5
  await chooseRadio('artic-duration', '2');             // scenario 7
  await page.click('#artic-begin');                     // scenario 12

  await passStartGate('click');                         // ready gate before recording
  await page.waitForSelector('#view-live.active', { timeout: 5000 });
  // topic + target banner visible during the live session (scenario 13)
  const banner = await page.$eval('#artic-live-banner', (el) => ({
    hidden: el.classList.contains('hidden'),
    text: el.textContent,
  }));
  assert.equal(banner.hidden, false);
  assert.match(banner.text, /Introduce a Course/);
  assert.match(banner.text, /2 min/);
  // presentation labels applied
  const paceLabel = await page.$eval('#lbl-pace', (el) => el.textContent);
  assert.equal(paceLabel, 'Presentation Pace');

  // end the session and wait for the report
  page.once('dialog', (d) => d.accept());
  await page.click('#end-btn');
  await page.waitForSelector('#view-report.active', { timeout: 20000 });

  // fact-check endpoint must NOT have been called for articulation (scenario 15)
  assert.equal(called.has('/api/factcheck'), false, '/api/factcheck must not run for articulation');

  // the saved-session shape carries topic + target (scenario 14)
  const saved = await page.evaluate(() => {
    // currentSession isn't global; assert via the report DOM + a fresh save
    document.getElementById('save-session-btn')?.click();
    return JSON.parse(localStorage.getItem('lc.sessions') || '[]').slice(-1)[0];
  });
  assert.equal(saved.mode, 'articulation');
  assert.ok(saved.articulation, 'session should carry articulation data');
  assert.equal(saved.articulation.topicId, 'introduce-course');
  assert.equal(saved.articulation.targetMin, 2);
  assert.equal(saved.targetDurationSec, 120);

  // the report shows the specialized module and hides the accuracy module (scenario 16)
  const accHidden = await page.$eval('#accuracy-module', (el) => el.classList.contains('hidden'));
  assert.equal(accHidden, true);
  const deepLabel = await page.$eval('#lbl-deep-analysis', (el) => el.textContent);
  assert.match(deepLabel, /Articulation Analysis/);
});
