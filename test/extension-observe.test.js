// Observation additions from extension/page.js for the oversight pass, run in headless Chromium: consent dialogs
// (classified buttons, risk overrides, accept refused), warnings (password_field, login_wall, controls_capped),
// select blocks, open shadow roots, control ordering under the 100 cap (viewport, instruction terms, off-screen
// links), the Navigation API outcome of a click, and observe cost on a Wikipedia-sized page.
// CHROMIUM_PATH overrides the browser binary.
import test from 'node:test';
import { headlessEnv } from '../scripts/headless-env.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const PAGE_SCRIPT = new URL('../extension/page.js', import.meta.url).pathname;
const fixture = name => readFile(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');
const BLOCKS_FIXTURE = await fixture('blocks.html');
const CONTROLS_FIXTURE = await fixture('controls.html');

let browser;
test.before(async () => {
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    headless: true, env: headlessEnv(),
    args: ['--no-sandbox'],
  });
});
test.after(() => browser?.close());

// Serves `html` for every https://example.com/ URL (GET and POST), so navigations land on a page too.
async function load(t, html, { path = '/', viewport = { width: 1280, height: 800 } } = {}) {
  const page = await browser.newPage({ viewport });
  t.after(() => page.close());
  await page.route('https://example.com/**', async route => {
    // Form posts answer late, so a page call that submits returns before its document goes away.
    if (route.request().method() === 'POST') await new Promise(resolve => setTimeout(resolve, 1000));
    await route.fulfill({ contentType: 'text/html', body: html }).catch(() => {});
  });
  await page.goto('https://example.com' + path);
  await page.addScriptTag({ path: PAGE_SCRIPT });
  return page;
}

const observe = (page, options) => page.evaluate(o => __faiPage.observe(o), options);
const execute = (page, action, revision, terms) => page.evaluate(
  ([a, r, tm]) => __faiPage.execute(a, r, { quietMs: 0, capMs: 100 }, tm).then(
    value => ({ value }),
    error => ({ error: { code: error.code, message: error.message } }),
  ),
  [action, revision, terms],
);
const doc = (body, title = 'T') =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
const byLabel = (observation, label) => observation.controls.find(c => c.label === label);

// --- consent ----------------------------------------------------------------------------------------------------

test('a cookie dialog is reported with classified buttons that are also offered controls', async t => {
  const page = await load(t, BLOCKS_FIXTURE);
  const observation = await observe(page);
  const reject = byLabel(observation, 'Reject all');
  const accept = byLabel(observation, 'Accept all');
  const settings = byLabel(observation, 'Manage settings');
  assert.deepEqual(observation.consent, {
    text: 'We use cookies to improve the handbook. Reject all Accept all Manage settings',
    buttons: [
      { id: reject.id, label: 'Reject all', kind: 'reject' },
      { id: accept.id, label: 'Accept all', kind: 'accept' },
      { id: settings.id, label: 'Manage settings', kind: 'settings' },
    ],
  });
  // A form submit inside the dialog is allowed when it rejects; accepting needs consent_accept (full and above).
  assert.equal(reject.type, 'submit');
  assert.equal(reject.risk, 'reversible');
  assert.equal(reject.consent, true);
  assert.equal(accept.risk, 'consent_accept');
  assert.equal(accept.consent, true);
  assert.equal(settings.risk, 'reversible');
  assert.equal(byLabel(observation, 'Show plan').consent, undefined, 'controls outside the dialog are unmarked');

  const refused = await execute(page, { type: 'click', target: accept.id }, observation.revision);
  assert.equal(refused.error?.code, 'blocked_risky');
  const rejected = await execute(page, { type: 'click', target: reject.id }, observation.revision);
  assert.equal(rejected.error, undefined, JSON.stringify(rejected.error));
  assert.equal(rejected.value.expectNavigation, true, 'the reject form submit navigates');
});

test('consent detection: class names, accept-only dialogs, consent pages, and what is not consent', async t => {
  const cases = [
    {
      name: 'a class-named banner without a role',
      html: doc(`<div class="cc-cookie-banner"><span>Cookies help us.</span>
        <button>Accept necessary only</button><button>Allow all, including non-essential</button>
        <button>Customize</button></div>`),
      expect: [['Accept necessary only', 'reject'], ['Allow all, including non-essential', 'accept'], ['Customize', 'settings']],
    },
    {
      name: 'an accept-only dialog',
      html: doc(`<div role="dialog" aria-modal="true"><p>This site uses cookies and similar tracking.</p>
        <button>Got it</button></div>`),
      expect: [['Got it', 'accept']],
    },
    {
      name: 'a dialog inside an open shadow root (usercentrics-style)',
      html: doc(`<div id="host"></div><script>document.querySelector('#host').attachShadow({ mode: 'open' }).innerHTML =
        '<div role="dialog"><p>We value your privacy and consent.</p><button>Deny</button><button>Ablehnen</button><button>OK</button></div>';</script>`),
      expect: [['Deny', 'other'], ['Ablehnen', 'reject'], ['OK', 'accept']],
    },
    {
      name: 'a whole-page consent wall',
      html: doc(`<h1>Before you continue to Example</h1><p>We use cookies and data to deliver services.</p>
        <form method="post"><button>Reject all</button><button>Accept all</button></form>`, 'Before you continue'),
      expect: [['Reject all', 'reject'], ['Accept all', 'accept']],
    },
    { name: 'a newsletter dialog', html: doc('<div role="dialog"><p>Join our newsletter</p><button>OK</button></div>'), expect: null },
    { name: 'a body class', html: doc('<p>Recipe</p><button>OK</button>').replace('<body>', '<body class="cookie-open">'), expect: null },
    {
      name: 'a hidden banner',
      html: doc('<div id="cookie-notice" style="display:none"><button>Accept</button><button>Reject</button></div>'),
      expect: null,
    },
    {
      name: 'a newsletter dialog that mentions privacy and partners',
      html: doc(`<div role="dialog" aria-modal="true"><p>Join our newsletter for offers from our partners. Read our
        privacy policy.</p><button>OK</button><button>No thanks</button></div>`),
      expect: null,
    },
    {
      name: 'a recipe page titled after cookies, with an OK button',
      html: doc('<h1>Cookie recipes</h1><p>Chocolate chip cookies.</p><button>OK</button><button>Settings</button>',
        'Best cookie recipes'),
      expect: null,
    },
    {
      name: 'a consent-requests admin page with Approve/Reject form submits (no accept button)',
      html: doc(`<h1>Consent requests</h1><div id="consent-requests"><p>Cookie consent request from Alex</p>
        <form method="post"><button>Approve</button><button>Reject</button></form></div>`, 'Consent requests'),
      expect: null,
    },
    {
      name: 'a review dialog with Reject and no accept button',
      html: doc(`<div role="dialog"><p>Reject this consent form submission?</p><button>Reject</button>
        <button>Cancel</button></div>`),
      expect: null,
    },
    {
      name: 'a cookie recipe section',
      html: doc('<section class="cookie-recipes"><h2>Cookies</h2><button>Add to basket</button></section>'),
      expect: null,
    },
  ];
  for (const { name, html, expect } of cases) {
    const page = await load(t, html);
    const observation = await observe(page);
    if (expect === null) {
      assert.equal(observation.consent, null, name);
      continue;
    }
    assert.ok(observation.consent, name);
    assert.deepEqual(observation.consent.buttons.map(b => [b.label, b.kind]), expect, name);
    for (const button of observation.consent.buttons) {
      const control = observation.controls.find(c => c.id === button.id);
      assert.equal(control?.label, button.label, `${name}: button ${button.id} is an offered control`);
      assert.equal(control.consent, true, name);
      if (button.kind === 'accept') assert.equal(control.risk, 'consent_accept', name);
      if (button.kind === 'reject') assert.equal(control.risk, 'reversible', name);
    }
    assert.ok(observation.consent.text.length > 0 && observation.consent.text.length <= 200, name);
  }
});

test('consent buttons stay offered on a page whose controls exceed the cap', async t => {
  const links = Array.from({ length: 150 }, (_, i) => `<a href="/l/${i}">L${i}</a>`).join(' ');
  const page = await load(t, doc(`<p>${links}</p><div id="cookie-bar"><button>Reject</button><button>Accept</button></div>`));
  const observation = await observe(page);
  assert.equal(observation.controls.length, 100);
  assert.deepEqual(observation.consent.buttons.map(b => b.kind), ['reject', 'accept']);
  for (const button of observation.consent.buttons) assert.ok(observation.controls.some(c => c.id === button.id));
  assert.ok(observation.warnings.includes('controls_capped'));
});

// --- warnings ---------------------------------------------------------------------------------------------------

test('warnings: a password field alone, a login wall by title or first heading, and none', async t => {
  const form = '<form><input name="user"><input type="password" name="pw"><button>Continue</button></form>';
  const cases = [
    ['plain page', doc('<h1>Docs</h1><p>Text</p>'), []],
    ['password field under another heading', doc(`<h1>Account settings</h1>${form}`), ['password_field']],
    ['sign-in title', doc(`<h1>Welcome</h1>${form}`, 'Sign in to Example'), ['password_field', 'login_wall']],
    ['log-in first heading', doc(`<h2>Log in</h2>${form}`), ['password_field', 'login_wall']],
    ['hidden password field', doc('<h1>Login</h1><input type="password" style="display:none">'), []],
  ];
  for (const [name, html, expected] of cases) {
    const page = await load(t, html);
    const observation = await observe(page);
    assert.deepEqual(observation.warnings, expected, name);
    assert.ok(!observation.controls.some(c => c.type === 'password'), `${name}: password fields are never controls`);
  }
  // The blocks fixture has a password form under a "Sign in" heading that is not the page's first heading.
  const page = await load(t, BLOCKS_FIXTURE);
  assert.deepEqual((await observe(page)).warnings, ['password_field']);
});

// --- select blocks ----------------------------------------------------------------------------------------------

test('a select becomes one block with its label and up to 20 options, capped at 200 characters', async t => {
  const many = Array.from({ length: 30 }, (_, i) => `<option>O${i + 1}</option>`).join('');
  const long = Array.from({ length: 20 }, (_, i) => `<option>A rather long destination name ${i}</option>`).join('');
  const page = await load(t, doc(`
    <label for="size">Size</label><select id="size"><option value="s">Small</option><option value="l" label="Large"></option></select>
    <select name="count">${many}</select>
    <select aria-label="Destination">${long}</select>
    <select aria-label="Hidden" style="display:none"><option>Never</option></select>
    <div style="height:2000px"></div>
    <select aria-label="Far"><option>Down here</option></select>`));
  const observation = await observe(page);
  const selects = observation.blocks.filter(b => b.t === 'select');
  assert.equal(selects[0].text, 'Size: Small | Large');
  assert.equal(selects[0].ref, byLabel(observation, 'Size').id);
  assert.equal(selects[1].text, `count: ${Array.from({ length: 20 }, (_, i) => `O${i + 1}`).join(' | ')}`);
  assert.equal(selects[2].text.length, 200);
  assert.ok(selects[2].text.startsWith('Destination: A rather long destination name 0 | '));
  assert.deepEqual(selects[3], { t: 'select', text: 'Far: Down here', ref: byLabel(observation, 'Far').id, offscreen: true });
  assert.equal(selects.length, 4, 'a hidden select has no block');
});

// --- shadow DOM ---------------------------------------------------------------------------------------------------

test('open shadow roots: controls in document order at their host, blocks, nesting, and actions resolve', async t => {
  const page = await load(t, doc(`
    <a href="/before">Before</a>
    <div id="outer"></div>
    <a href="/after">After</a>
    <div id="closed"></div>
    <script>
      const outer = document.querySelector('#outer').attachShadow({ mode: 'open' });
      outer.innerHTML = '<nav><a href="/inside">Inside link</a></nav><div id="inner"></div><button>Shadow button</button>';
      outer.querySelector('#inner').attachShadow({ mode: 'open' }).innerHTML = '<p>Nested <a href="/nested">Nested link</a> text</p>';
      outer.querySelector('button').addEventListener('click', () => { document.title = 'Clicked in shadow'; });
      document.querySelector('#closed').attachShadow({ mode: 'closed' }).innerHTML = '<a href="/secret">Closed link</a>';
    </script>`));
  const observation = await observe(page);
  assert.deepEqual(observation.controls.map(c => c.label),
    ['Before', 'Inside link', 'Nested link', 'Shadow button', 'After']);
  assert.ok(!observation.controls.some(c => c.label === 'Closed link'), 'closed roots are not read');
  const texts = observation.blocks.map(b => [b.t, b.text]);
  assert.deepEqual(texts.filter(([, text]) => /Inside|Nested|Shadow/.test(text)),
    [['a', 'Inside link'], ['button', 'Shadow button'], ['p', 'Nested Nested link text']],
    'new shadow blocks follow the light-DOM blocks, one root after another');
  assert.equal(observation.blocks.find(b => b.text === 'Inside link').ref, byLabel(observation, 'Inside link').id);
  assert.match(observation.text, /Nested Nested link text|Nested link/);

  const clicked = await execute(page, { type: 'click', target: byLabel(observation, 'Shadow button').id }, observation.revision);
  assert.equal(clicked.error, undefined, JSON.stringify(clicked.error));
  assert.equal(clicked.value.observation.title, 'Clicked in shadow');
  const next = clicked.value.observation;
  const followed = await execute(page, { type: 'click', target: byLabel(next, 'Nested link').id }, next.revision);
  assert.equal(followed.error, undefined, JSON.stringify(followed.error));
  assert.equal(followed.value.expectNavigation, true, 'a link inside a nested shadow root navigates');
});

test('open shadow roots: several hosts between the same light-DOM controls keep document order', async t => {
  const page = await load(t, doc(`
    <a href="/a">A</a><div id="h1"></div><div id="h2"></div><button>Middle button</button><a href="/b">B</a>
    <div id="h3"></div>
    <script>
      const r1 = document.querySelector('#h1').attachShadow({ mode: 'open' });
      r1.innerHTML = '<a href="/s1">S1</a><div id="n"></div><a href="/s1b">S1b</a>';
      r1.querySelector('#n').attachShadow({ mode: 'open' }).innerHTML = '<a href="/n1">N1</a>';
      document.querySelector('#h2').attachShadow({ mode: 'open' }).innerHTML = '<a href="/s2">S2</a>';
      document.querySelector('#h3').attachShadow({ mode: 'open' }).innerHTML = '<a href="/s3">S3</a>';
    </script>`));
  const observation = await observe(page);
  assert.deepEqual(observation.controls.map(c => c.label),
    ['A', 'S1', 'N1', 'S1b', 'S2', 'Middle button', 'B', 'S3']);
});

test('the shadow-root scan is bounded: many hosts stay cheap and capped', async t => {
  const page = await load(t, doc(`<div id="hosts"></div><script>
    const hosts = document.querySelector('#hosts');
    for (let i = 0; i < 300; i++) {
      const host = document.createElement('x-card');
      hosts.appendChild(host);
      host.attachShadow({ mode: 'open' }).innerHTML = '<a href="/c/' + i + '">Card ' + i + '</a>';
    }
  </script>`));
  const observation = await observe(page);
  const cards = observation.controls.filter(c => c.label.startsWith('Card '));
  assert.equal(cards.length, 64, 'at most 64 shadow roots are read');
  assert.equal(cards[0].label, 'Card 0');
});

// --- control ordering under the cap -------------------------------------------------------------------------------

test('controls under the cap: viewport first, then DOM order, off-screen links flagged, controls_capped', async t => {
  const page = await load(t, CONTROLS_FIXTURE);
  const observation = await observe(page);
  assert.equal(observation.controls.length, 100);
  assert.ok(observation.warnings.includes('controls_capped'));
  const labels = observation.controls.map(c => c.label);
  assert.deepEqual(labels.slice(0, 40), Array.from({ length: 40 }, (_, i) => `Top link ${i + 1}`));
  assert.deepEqual(labels.slice(40), Array.from({ length: 60 }, (_, i) => `Lower link ${i + 1}`));
  assert.ok(observation.controls.slice(0, 40).every(c => c.offscreen === undefined && c.visible === true));
  assert.ok(observation.controls.slice(40).every(c => c.offscreen === true && c.visible === true));
  assert.deepEqual(observation.controls.map(c => c.id), Array.from({ length: 100 }, (_, i) => String(i + 1)));
});

test('an instruction term pulls an off-screen match under the cap, right after the viewport controls', async t => {
  const page = await load(t, CONTROLS_FIXTURE);
  const observation = await observe(page, { terms: ['quarterly', 'report'] });
  const labels = observation.controls.map(c => c.label);
  assert.equal(observation.controls.length, 100);
  assert.equal(labels[40], 'Quarterly report archive');
  assert.equal(observation.controls[40].offscreen, true);
  assert.deepEqual(labels.slice(41, 44), ['Lower link 1', 'Lower link 2', 'Lower link 3']);

  // The terms are remembered: the pre-dispatch check orders the same way, so the decision is not stale, and the
  // off-screen target is scrolled into view and followed.
  const result = await execute(page, { type: 'click', target: observation.controls[40].id }, observation.revision);
  assert.equal(result.error, undefined, JSON.stringify(result.error));
  assert.equal(result.value.expectNavigation, true);
  assert.equal(result.value.target.label, 'Quarterly report archive');
});

test('with more than 100 controls on screen, on-screen term matches are kept and off-screen ones get a reserve', async t => {
  const onScreen = Array.from({ length: 150 }, (_, i) => `<a href="/s/${i}">${i === 140 ? 'Pricing plans' : `S${i}`}</a>`).join(' ');
  const offScreen = Array.from({ length: 30 }, (_, i) => `<a href="/o/${i}">${i % 2 ? `O${i}` : `Pricing ${i}`}</a>`).join(' ');
  const page = await load(t, doc(`<p>${onScreen}</p><div style="height:3000px"></div><p>${offScreen}</p>`));
  const plain = await observe(page, { terms: [] });
  assert.ok(!plain.controls.some(c => c.label === 'Pricing plans'), 'without terms, DOM order decides');
  const observation = await observe(page, { terms: ['pricing'] });
  assert.equal(observation.controls.length, 100);
  assert.ok(observation.controls.some(c => c.label === 'Pricing plans' && !c.offscreen));
  const reserved = observation.controls.filter(c => c.offscreen);
  assert.equal(reserved.length, 15);
  assert.ok(reserved.every(c => c.label.startsWith('Pricing ')));
  assert.ok(observation.warnings.includes('controls_capped'));
});

test('a scrolled page lists the controls now in the viewport first', async t => {
  const page = await load(t, CONTROLS_FIXTURE);
  await page.evaluate(() => document.querySelector('#lower').scrollIntoView());
  const observation = await observe(page, { terms: [] });
  assert.equal(observation.controls[0].label, 'Lower link 1');
  assert.equal(observation.controls[0].offscreen, undefined);
  assert.ok(observation.controls.some(c => c.label === 'Top link 1' && c.offscreen === true));
});

// --- clicks and the Navigation API ----------------------------------------------------------------------------------

test('click outcome: cancelled links and SPA routes settle in place; a handler that assigns location navigates', async t => {
  const page = await load(t, doc(`
    <a href="/cancelled" id="cancel">Cancelled link</a>
    <a href="/route" id="route">Routed link</a>
    <button type="button" id="go">Go button</button>
    <p id="out">Idle</p>
    <script>
      document.querySelector('#cancel').addEventListener('click', e => { e.preventDefault(); document.querySelector('#out').textContent = 'Opened inline'; });
      document.querySelector('#route').addEventListener('click', e => { e.preventDefault(); history.pushState({}, '', '/route'); document.querySelector('#out').textContent = 'Route view'; });
      document.querySelector('#go').addEventListener('click', () => { location.assign('/elsewhere'); });
    </script>`));
  let observation = await observe(page);
  let result = await execute(page, { type: 'click', target: byLabel(observation, 'Cancelled link').id }, observation.revision);
  assert.equal(result.value.expectNavigation, false);
  assert.match(result.value.observation.text, /Opened inline/);

  observation = result.value.observation;
  result = await execute(page, { type: 'click', target: byLabel(observation, 'Routed link').id }, observation.revision);
  assert.equal(result.value.expectNavigation, false);
  assert.equal(result.value.observation.url, 'https://example.com/route');
  assert.match(result.value.observation.text, /Route view/);

  observation = result.value.observation;
  result = await execute(page, { type: 'click', target: byLabel(observation, 'Go button').id }, observation.revision);
  assert.equal(result.value.expectNavigation, true, 'a button whose handler navigates is a navigation');
  assert.equal(result.value.observation, undefined);
});

// --- cost ----------------------------------------------------------------------------------------------------------

test('observe stays fast on a Wikipedia-sized page (3,500 links, 40k elements)', async t => {
  const paragraph = i => `<p>Paragraph ${i} about the river basin ${Array.from({ length: 10 }, (_, j) =>
    `<a href="/wiki/T${i}_${j}">Term ${i}.${j}</a> with <b>bold</b> and <i>italic</i> words`).join(', ')}.</p>`;
  const table = Array.from({ length: 40 }, (_, i) => `<tr><td>Row ${i}</td><td><a href="/r/${i}">Ref ${i}</a></td><td>${i * 7}</td></tr>`).join('');
  const navbox = Array.from({ length: 60 }, (_, i) => `<li><a href="/nav/${i}">Nav ${i}</a></li>`).join('');
  const body = `<nav><ul>${navbox}</ul></nav><h1>Tagus</h1>${Array.from({ length: 340 }, (_, i) =>
    (i % 20 === 0 ? `<h2>Section ${i}</h2>` : '') + paragraph(i)).join('')}<table>${table}</table>
    <div id="hosts"></div><script>for (let i = 0; i < 20; i++) {
      const h = document.createElement('x-ref'); document.querySelector('#hosts').appendChild(h);
      h.attachShadow({ mode: 'open' }).innerHTML = '<a href="/s/' + i + '">Shadow ' + i + '</a>'; }</script>`;
  const page = await load(t, doc(body));
  const stats = await page.evaluate(() => {
    const measure = options => {
      const times = [];
      for (let i = 0; i < 9; i++) {
        const started = performance.now();
        globalThis.__faiPage.observe(options);
        times.push(performance.now() - started);
      }
      times.sort((a, b) => a - b);
      return { p50: +times[4].toFixed(1), max: +times[8].toFixed(1) };
    };
    return {
      elements: document.getElementsByTagName('*').length,
      links: document.links.length,
      plain: measure({ terms: [] }),
      withTerms: measure({ terms: ['basin', 'tagus', 'section'] }),
      withoutBlocks: measure({ blocks: false }),
    };
  });
  t.diagnostic(JSON.stringify(stats));
  assert.ok(stats.links >= 3500, `${stats.links} links`);
  assert.ok(stats.plain.p50 < 200, `observe p50 ${stats.plain.p50} ms`);
  assert.ok(stats.withTerms.p50 < 200, `observe with terms p50 ${stats.withTerms.p50} ms`);
  const observation = await observe(page);
  assert.equal(observation.controls.length, 100);
  assert.ok(observation.warnings.includes('controls_capped'));
});

// --- expectation text past the viewport ---------------------------------------------------------------------------

const SCROLLED_RESULTS = doc(`<h1>Flights</h1><p>Top flights, departing <b>2026-10-12</b></p>
  <div style="height:3000px">results</div><button>View more flights</button>
  <p style="display:none">hidden one</p><p style="visibility:hidden">hidden two</p>
  <p aria-hidden="true">hidden three</p>
  <span style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0px,0px,0px,0px)">hidden four</span>
  <div style="height:0;overflow:hidden">hidden five</div>
  <p style="clip-path:inset(50%);position:absolute">hidden six</p>`);

test('expectText: a rendered sentence scrolled above the viewport is found; the viewport text lacks it', async t => {
  const page = await load(t, SCROLLED_RESULTS);
  await page.evaluate(() => scrollTo(0, document.body.scrollHeight));
  const observation = await observe(page, { expectText: ['departing 2026-10-12', 'no such text'] });
  assert.ok(!observation.text.toLowerCase().includes('departing 2026-10-12'), 'scrolled past in the viewport text');
  assert.deepEqual(observation.textFound, ['departing 2026-10-12']);
  // Without expectText nothing extra is read or reported.
  assert.equal((await observe(page)).textFound, undefined);
});

test('expectText: hidden text (display, visibility, aria-hidden, clip, 1px, zero height) is never found', async t => {
  const page = await load(t, SCROLLED_RESULTS);
  const hidden = ['hidden one', 'hidden two', 'hidden three', 'hidden four', 'hidden five', 'hidden six'];
  // At most four texts per observe.
  for (const texts of [hidden.slice(0, 3), [...hidden.slice(3), 'view more flights']]) {
    assert.deepEqual((await observe(page, { expectText: texts })).textFound, texts.slice(3), texts.join(', '));
  }
  // settleAndObserve (and execute) take the texts too: the worker's navigation and act paths.
  const { observation: settled } = await page.evaluate(
    () => __faiPage.settleAndObserve({ quietMs: 0, capMs: 100 }, null, [], undefined, [], ['flights']));
  assert.deepEqual(settled.textFound, ['flights']);
});

test('expectText: text nobody can see or scroll to (off-screen, transparent, collapsed, option, hidden frame) is never found', async t => {
  const page = await load(t, doc(`<h1>Order</h1><div style="height:3000px">filler</div>
    <p style="position:absolute;left:-9999px">offscreen one</p>
    <p style="position:absolute;top:-9999px">offscreen two</p>
    <p style="opacity:0">transparent one</p>
    <div style="opacity:0"><p>transparent two</p></div>
    <details><summary>More</summary><p>collapsed one</p></details>
    <select><option>first option</option><option>option two</option></select>
    <iframe style="display:none" srcdoc="<p>framed one</p>"></iframe>
    <p>shown at the end</p>`));
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 200)));
  const texts = ['offscreen one', 'offscreen two', 'transparent one', 'transparent two'];
  assert.deepEqual((await observe(page, { expectText: texts })).textFound, []);
  assert.deepEqual((await observe(page, { expectText: ['collapsed one', 'option two', 'framed one', 'shown at the end'] })).textFound,
    ['shown at the end']);
});

test('expectText stays cheap on a Wikipedia-sized page whose expected text is only in hidden markup', async t => {
  const paragraph = i => `<p>Paragraph ${i} about the river basin ${Array.from({ length: 10 }, (_, j) =>
    `<a href="/wiki/T${i}_${j}">Term ${i}.${j}</a> with <b>bold</b> and <i>italic</i> words`).join(', ')}.</p>`;
  const body = `<h1>Tagus</h1>${Array.from({ length: 340 }, (_, i) => paragraph(i)).join('')}
    <p style="display:none">booking confirmed</p><p style="display:none">payment received</p>`;
  const page = await load(t, doc(body));
  const stats = await page.evaluate(() => {
    const measure = options => {
      const times = [];
      for (let i = 0; i < 7; i++) {
        const started = performance.now();
        globalThis.__faiPage.observe(options);
        times.push(performance.now() - started);
      }
      return +times.sort((a, b) => a - b)[3].toFixed(1);
    };
    // Each text is in the raw text content but nowhere rendered: the walk reads the whole page.
    return { plain: measure({}), expected: measure({ expectText: ['booking confirmed', 'payment received'] }) };
  });
  t.diagnostic(JSON.stringify(stats));
  // The bound scales with the machine: a loaded CI runner slows the plain observe too (145 ms seen on Node 24), and a
  // fixed 100 ms then flakes. A real regression (findTexts several times the cost of a whole observe) still fails.
  const bound = Math.max(100, stats.plain);
  assert.ok(stats.expected - stats.plain < bound, `findTexts adds ${(stats.expected - stats.plain).toFixed(1)} ms (bound ${bound.toFixed(1)} ms)`);
  assert.deepEqual((await observe(page, { expectText: ['booking confirmed'] })).textFound, []);
});

test('dialog: a control in an open dialog is marked; a page that marks its body or root a dialog marks nothing', async t => {
  const page = await load(t, doc('<div role="dialog" aria-label="Dates"><button>Done</button></div><button>Search</button>'));
  const marked = (await observe(page)).controls.filter(control => control.dialog).map(control => control.label);
  assert.deepEqual(marked, ['Done']);
  await page.evaluate(() => { document.body.setAttribute('role', 'dialog'); document.documentElement.setAttribute('aria-modal', 'true'); });
  const all = (await observe(page)).controls.filter(control => control.dialog).map(control => control.label);
  assert.deepEqual(all, ['Done']);
});

// --- fills ------------------------------------------------------------------------------------------------------

test('fill: execute reads the field back after settle and reports kept, reformatted dates and numbers, or not kept', async t => {
  // A picker's textbox that empties itself on input (a controlled input whose state never took the value), one that
  // formats the date, one that formats a number, one that trims and upper-cases, and a plain one.
  const page = await load(t, doc(`<form>
    <label>Departure <input id="dep" type="text" aria-haspopup="dialog"></label>
    <label>Return <input id="ret" type="text"></label>
    <label>Phone <input id="phone" type="text"></label>
    <label>Code <input id="code" type="text"></label>
    <label>Name <input id="name" type="text"></label>
    <label>Notes <textarea id="notes"></textarea></label>
    </form><script>
    const dep = document.getElementById('dep');
    dep.addEventListener('input', () => { setTimeout(() => { dep.value = ''; }, 0); });
    const ret = document.getElementById('ret');
    ret.addEventListener('input', () => { const [y, m, d] = ret.value.split('-'); ret.value = 'Tue, ' + ['Jan','Feb','Mar'][Number(m) - 1] + ' ' + Number(d); });
    const phone = document.getElementById('phone');
    phone.addEventListener('input', () => { const v = phone.value.replace(/\\D/g, ''); phone.value = '(' + v.slice(0, 3) + ') ' + v.slice(3, 6) + '-' + v.slice(6); });
    const code = document.getElementById('code');
    code.addEventListener('change', () => { code.value = code.value.trim().toUpperCase(); });
    const notes = document.getElementById('notes');
    notes.addEventListener('input', () => { notes.value = 'Other text entirely'; });
    </script>`));
  const fill = async (label, text) => {
    const observation = await observe(page, { allow: ['navigate', 'controls'] });
    const control = byLabel(observation, label);
    const out = await execute(page, { type: 'fill_supplied_text', target: control.id, text }, observation.revision);
    assert.equal(out.error, undefined, JSON.stringify(out.error));
    return out.value;
  };
  const departure = await fill('Departure', '2027-01-12');
  assert.deepEqual(departure.fill, { kept: false, empty: true });
  assert.equal(await page.evaluate(() => document.getElementById('dep').value), '', 'the field really is empty');
  assert.ok(!JSON.stringify(departure.fill).includes('2027'), 'the fill verdict carries no value');
  assert.deepEqual((await fill('Return', '2027-01-12')).fill, { kept: true, empty: false }, 'the same date in another form');
  assert.deepEqual((await fill('Phone', '555 123 4567')).fill, { kept: true, empty: false }, 'the same digits, formatted');
  assert.deepEqual((await fill('Code', '  ab12  ')).fill, { kept: true, empty: false }, 'trimmed and upper-cased');
  assert.deepEqual((await fill('Name', 'Alex Example')).fill, { kept: true, empty: false });
  assert.deepEqual((await fill('Notes', 'my note')).fill, { kept: false, empty: false }, 'replaced by other text: not kept, not empty');
  // The observation after a kept fill shows the field filled; after the reverted one, not.
  const after = await observe(page, { allow: ['navigate', 'controls'] });
  assert.equal(byLabel(after, 'Departure').filled, false);
  assert.equal(byLabel(after, 'Name').filled, true);
  // A click carries no fill verdict.
  const observation = await observe(page, { allow: ['navigate', 'controls'] });
  const clicked = await execute(page, { type: 'click', target: byLabel(observation, 'Name').id }, observation.revision);
  assert.equal(clicked.value.fill, undefined);
});
