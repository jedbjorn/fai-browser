// page.js consent cases from the real-site probe (headless Chromium, the repository's page harness):
// consent.google.com's "Before you continue" wall with Reject all / Accept all form buttons below the fold, a
// consent.* host without the wording, and a banner fading out after its reject click.
import test from 'node:test';
import { headlessEnv } from '../scripts/headless-env.mjs';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

let browser;
test.before(async () => {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    headless: true, env: headlessEnv(), args: ['--no-sandbox'] });
});
test.after(() => browser?.close());

async function observe(t, url, html, { height = 900 } = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height } });
  t.after(() => page.close());
  await page.route(`${new URL(url).origin}/**`, route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(url);
  await page.addScriptTag({ path: new URL('../extension/page.js', import.meta.url).pathname });
  return { page, observation: await page.evaluate(() => __faiPage.observe()) };
}

const filler = Array.from({ length: 30 }, (_, i) => `<li>Purpose ${i}: deliver and maintain services</li>`).join('');
const GOOGLE = `<!doctype html><title>Before you continue</title><div><button>Language: English</button>
<a href="https://accounts.google.com/ServiceLogin">Sign in</a></div><h1>Before you continue to Google</h1>
<p>We use <a href="https://policies.google.com/technologies/cookies" target="_blank">cookies</a> and data to</p><ul>${filler}</ul>
<p>If you choose to "Reject all," we will not use cookies for these additional purposes.</p>
<form action="https://consent.google.com/save" method="POST"><button type="submit">Reject all</button></form>
<form action="https://consent.google.com/save" method="POST"><button type="submit">Accept all</button></form>
<a href="https://consent.google.com/d?continue=x">More options for personalization settings and cookies</a>`;

test('consent.google.com: the whole page is a consent dialog with Reject all offered even below the fold', async t => {
  const { observation } = await observe(t, 'https://consent.google.com/m?continue=https://www.google.com/travel/flights', GOOGLE, { height: 400 });
  assert.ok(observation.consent, 'consent detected');
  const reject = observation.consent.buttons.find(b => b.label === 'Reject all');
  const accept = observation.consent.buttons.find(b => b.label === 'Accept all');
  assert.equal(reject.kind, 'reject');
  assert.equal(accept.kind, 'accept');
  const rejectControl = observation.controls.find(c => c.id === reject.id);
  assert.equal(rejectControl.offscreen, true);
  // Reject all is a form submit, allowed inside a consent dialog; Accept all is a consent accept (full and above).
  assert.equal(rejectControl.risk, 'reversible');
  assert.equal(observation.controls.find(c => c.id === accept.id).risk, 'consent_accept');
});

test('consent.youtube.com-style host qualifies without the wording; an ordinary host needs the title', async t => {
  const plain = GOOGLE.replace('<title>Before you continue</title>', '<title>YouTube</title>').replace('Before you continue to Google', 'YouTube');
  assert.ok((await observe(t, 'https://consent.youtube.com/m?continue=https://www.youtube.com/', plain)).observation.consent);
  assert.equal((await observe(t, 'https://www.youtube.com/', plain)).observation.consent, null);
});

test('the "Before you continue" wall on an ordinary host still needs consent wording and an accept button', async t => {
  const noAccept = GOOGLE.replace('<button type="submit">Accept all</button>', '');
  assert.equal((await observe(t, 'https://consent.example.com/', noAccept)).observation.consent, null);
});

test('a cookie banner fading out (opacity 0) after its reject click is no longer a consent dialog', async t => {
  const banner = `<!doctype html><title>Stays</title><h1>Find your next stay</h1>
<div id="onetrust-banner-sdk" style="position:fixed;bottom:0;left:0;right:0;background:#fff">
<p>Manage cookie settings. We use cookies.</p><button>Decline</button><button>Accept</button></div>`;
  const { page, observation } = await observe(t, 'https://www.booking.test/', banner);
  assert.ok(observation.consent);
  await page.evaluate(() => { document.querySelector('#onetrust-banner-sdk').style.opacity = '0'; });
  assert.equal((await page.evaluate(() => __faiPage.observe())).consent, null);
});

test('consent: accept is the consent_accept class (dispatched only with it); reject is dispatched at every level', async t => {
  const banner = `<!doctype html><title>Stays</title><h1>Find your next stay</h1><button type="button">Show map</button>
<div id="onetrust-banner-sdk" style="position:fixed;bottom:0;left:0;right:0;background:#fff">
<p>Manage cookie settings. We use cookies.</p><button>Decline</button><button>Accept</button></div>`;
  const { page, observation } = await observe(t, 'https://www.booking.test/', banner);
  const accept = observation.controls.find(c => c.label === 'Accept');
  assert.equal(accept.risk, 'consent_accept');
  const run = (allow, label) => page.evaluate(async ([allow, label]) => {
    const current = __faiPage.observe({ allow });
    const control = current.controls.find(c => c.label === label);
    if (!control) return 'missing';
    try {
      await __faiPage.execute({ type: 'click', target: control.id }, current.revision, { quietMs: 10, capMs: 200 }, [], undefined, allow);
      return 'ran';
    } catch (error) {
      return error.code;
    }
  }, [allow, label]);
  const readOnly = ['navigate'];
  const full = ['navigate', 'controls', 'submit_safe', 'submit', 'delete', 'consent_accept'];
  assert.equal(await run(readOnly, 'Show map'), 'blocked_risky', 'read-only refuses an ordinary button');
  assert.equal(await run(readOnly, 'Accept'), 'blocked_risky');
  assert.equal(await run(['navigate', 'controls'], 'Accept'), 'blocked_risky');
  assert.equal(await run(full, 'Accept'), 'ran');
  // The mechanical reject (rung 0) is dispatched even at read-only.
  const { page: fresh } = await observe(t, 'https://www.booking.test/', banner);
  const rejected = await fresh.evaluate(async () => {
    const current = __faiPage.observe({ allow: ['navigate'] });
    const control = current.controls.find(c => c.label === 'Decline');
    await __faiPage.execute({ type: 'click', target: control.id }, current.revision, { quietMs: 10, capMs: 200 }, [], undefined, ['navigate']);
    return control.risk;
  });
  assert.equal(rejected, 'reversible');
});

test('consent: an accept-style button inside a same-origin frame is consent_accept too', async t => {
  const html = '<!doctype html><title>Shop</title><h1>Shop</h1><iframe id="f" src="/frame" width="600" height="200"></iframe>';
  const frame = '<!doctype html><body><p>Hello</p><button type="button">Accept all</button></body>';
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  t.after(() => page.close());
  await page.route('https://shop.test/**', route => route.fulfill({
    contentType: 'text/html', body: new URL(route.request().url()).pathname === '/frame' ? frame : html,
  }));
  await page.goto('https://shop.test/');
  await page.frameLocator('#f').locator('button').waitFor();
  await page.addScriptTag({ path: new URL('../extension/page.js', import.meta.url).pathname });
  const observation = await page.evaluate(() => __faiPage.observe());
  const accept = observation.controls.find(c => c.label === 'Accept all');
  assert.deepEqual([accept.risk, accept.frame], ['consent_accept', 1]);
});
