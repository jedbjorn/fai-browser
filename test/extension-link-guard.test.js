// A link is judged on every name a person could read as its name (extension/page.js linkGuardClass), in headless
// Chromium and Firefox (playwright-core's Firefox when installed), through BrowserRuntime over the page bridge. Each
// way of shaping a link's label (invisible padding before the action words, an aria-label naming something else,
// generated content, reordered or bidi-overridden text) is refused at read-only by offer and by point exactly as the
// plainly labelled link is, and its button twin stays refused; honest links stay offered; a destination that names
// signing out or a delete makes a link an action whatever its label. CHROMIUM_PATH overrides the Chromium binary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium, firefox } from 'playwright-core';
import { headlessEnv } from '../scripts/headless-env.mjs';
import { BrowserRuntime } from '../src/runtime.js';
import { PageBridge } from './helpers/page-bridge.js';

const ORIGIN = 'https://example.com';
const RLO = '‮';
const PDF = '‬';
const pad = style => `<span style="${style}">${'Your profile and settings menu entry. '.repeat(6)}</span>`;
const reversed = text => Array.from(text).reverse().join('');
// [name, inner html for a two-word action [first, second], extra attributes]: each becomes links (neutral
// destinations) for "Sign out" and "Delete account", and a button with the "Delete account" content (a button's rule).
const TRICKS = [
  ['opacity', ([a, b]) => `${pad('opacity:0')}${a} ${b}`],
  ['font-size', ([a, b]) => `${pad('font-size:0')}${a} ${b}`],
  ['clip', ([a, b]) => `${pad('position:absolute;clip:rect(0 0 0 0);width:1px;height:1px;overflow:hidden')}${a} ${b}`],
  ['off-screen', ([a, b]) => `${pad('position:absolute;left:-9999px')}${a} ${b}`],
  ['background-colour', ([a, b]) => `${pad('color:white')}${a} ${b}`],
  ['aria-label', ([a, b]) => `${a} ${b}`, 'aria-label="Profile"'],
  ['generated', ([a, b]) => `<span class="gen" data-text="${a} ${b}"></span>`],
  ['flex-order', ([a, b]) => `<span style="display:inline-flex"><span style="order:2">${b}</span><span style="order:1">${a}&nbsp;</span></span>`],
  ['bidi-control', ([a, b]) => `${RLO}${reversed(`${a} ${b}`)}${PDF}`],
  ['bidi-css', ([a, b]) => `<span style="direction:rtl;unicode-bidi:bidi-override">${reversed(`${a} ${b}`)}</span>`],
];
const PHRASES = { signout: ['Sign', 'out'], delete: ['Delete', 'account'] };
const HONEST = [
  ['/join', 'Sign up'],
  ['/docs/delete-branch', 'How to delete a branch'],
  ['/jane', 'Jane Doe', 'aria-label="Jane Doe"'],
  ['/orders', 'Order history'],
  ['/docs', '<span class="arrow"></span>Docs'],
  ['/settings', '<span style="display:inline-flex"><span>⚙</span><span>Settings</span></span>'],
  ['/blog/logout-tips', 'Why a logout matters'],
  ['/login/forum.html', 'Threads'],
];
const DESTINATIONS = [
  ['/logout', 'Profile'],
  ['/account/sign-out', 'My account'],
  ['/items/5?action=delete', 'Open'],
];
const attrs = extra => (extra ? ` ${extra}` : '');
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Guard</title>
<style>body { margin: 0; font: 12px sans-serif; background: white; } .r { height: 22px; overflow: hidden; white-space: nowrap; margin: 2px; }
.gen::before { content: attr(data-text); } .arrow::before { content: "\\2192 "; } a, button { display: inline-block; }</style></head><body>
${TRICKS.map(([name, inner, extra], i) => [
    ...Object.entries(PHRASES).map(([phrase, words]) => `<div class="r"><a id="l-${phrase}-${name}" href="/account/${phrase}-${i}"${attrs(extra)}>${inner(words)}</a></div>`),
    `<div class="r"><button id="b-${name}"${attrs(extra)}>${inner(PHRASES.delete)}</button></div>`,
  ].join('\n')).join('\n')}
<div class="r"><a id="l-signout-plain" href="/account/signout-plain">Sign out</a></div>
<div class="r"><a id="l-delete-plain" href="/account/delete-plain">Delete account</a></div>
<div class="r"><button id="b-plain">Delete account</button></div>
${HONEST.map(([href, inner, extra], i) => `<div class="r"><a id="h-${i}" href="${href}"${attrs(extra)}>${inner}</a></div>`).join('\n')}
${DESTINATIONS.map(([href, inner], i) => `<div class="r"><a id="d-${i}" href="${href}">${inner}</a></div>`).join('\n')}
</body></html>`;

const ENGINES = [
  { name: 'chromium', launch: () => chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    headless: true, env: headlessEnv(), args: ['--no-sandbox'] }), available: () => true },
  { name: 'firefox', launch: () => firefox.launch({ headless: true, env: headlessEnv() }),
    available: () => { try { return existsSync(firefox.executablePath()); } catch { return false; } } },
];

for (const engine of ENGINES) {
  const skip = engine.available() ? false : 'playwright-core Firefox is not installed';
  let browser;
  test.before(async () => {
    if (!skip) browser = await engine.launch();
  });
  test.after(() => browser?.close());

  async function open(t, level = 'read-only') {
    const context = await browser.newContext({ viewport: { width: 1280, height: 1600 } });
    t.after(() => context.close());
    const tab = await context.newPage();
    await tab.route(`${ORIGIN}/**`, route => (new URL(route.request().url()).pathname === '/guard'
      ? route.fulfill({ contentType: 'text/html', body: PAGE }) : route.fulfill({ contentType: 'text/html', body: '<title>landed</title>' })));
    await tab.goto(`${ORIGIN}/guard`);
    const bridge = new PageBridge(tab, { level });
    const runtime = new BrowserRuntime({ bridge });
    return { tab, bridge, runtime, look: () => runtime.observe({ mode: level, allowedOrigins: [ORIGIN] }) };
  }
  const offeredPaths = observed => new Set(observed.actions.filter(action => action.href).map(action => {
    const url = new URL(action.href);
    return `${url.pathname}${url.search}`;
  }));

  test(`${engine.name}: a link whose label is shaped to look harmless is refused like the plainly labelled one`, { skip }, async t => {
    const { look } = await open(t);
    const offered = offeredPaths(await look());
    for (const phrase of Object.keys(PHRASES)) {
      assert.ok(!offered.has(`/account/${phrase}-plain`), `the plainly labelled ${phrase} link is an action`);
      TRICKS.forEach(([name], i) => assert.ok(!offered.has(`/account/${phrase}-${i}`), `${phrase} ${name}: offered`));
    }
    HONEST.forEach(([href, inner]) => assert.ok(offered.has(href), `honest link ${inner} (${href}) is offered`));
    DESTINATIONS.forEach(([href, inner]) => assert.ok(!offered.has(href), `${href} "${inner}": a sign-out or delete destination`));
  });

  test(`${engine.name}: a point on each shaped link gets the plain link's refusal; nothing runs`, { skip }, async t => {
    const attempt = async selector => {
      const opened = await open(t);
      const observed = await opened.look();
      const box = await opened.tab.locator(selector).boundingBox();
      const result = await opened.runtime.act({ point: { x: Math.round(box.x + Math.min(box.width / 2, 20)), y: Math.round(box.y + box.height / 2) } },
        { revision: observed.observation.revision });
      assert.equal(opened.bridge.executions.length, 0, `${selector} ran`);
      assert.equal(opened.tab.url(), `${ORIGIN}/guard`, `${selector} navigated`);
      return `${result.code}/${result.needs?.level ?? ''}`;
    };
    const plain = { signout: await attempt('#l-signout-plain'), delete: await attempt('#l-delete-plain') };
    assert.deepEqual(plain, { signout: 'refused_action/testing', delete: 'refused_action/full' });
    for (const [name] of TRICKS) {
      for (const phrase of Object.keys(PHRASES)) assert.equal(await attempt(`#l-${phrase}-${name}`), plain[phrase], `${phrase} ${name}`);
    }
    assert.equal(await attempt('#d-0'), plain.signout, 'a /logout link labelled "Profile"');
    assert.equal(await attempt('#d-2'), plain.delete, 'an ?action=delete link labelled "Open"');
  });

  test(`${engine.name}: the button twins stay refused, and the honest links stay clickable`, { skip }, async t => {
    const { look } = await open(t, 'reversible');
    const observed = await look();
    const buttons = new Set(observed.observation.controls.filter(control => control.role === 'button').map(control => String(control.id)));
    const offeredButtons = observed.actions.filter(action => buttons.has(String(action.target)));
    assert.deepEqual(offeredButtons.map(action => action.label), [], 'no shaped "Delete account" button is offered');
    const honest = await open(t);
    const seen = await honest.look();
    const docs = seen.actions.find(action => action.href === `${ORIGIN}/docs/delete-branch`);
    const result = await honest.runtime.act(docs.id, { revision: seen.observation.revision });
    assert.equal(result.status, 'checkpoint', `${result.code}: ${result.reason}`);
    assert.equal(honest.tab.url(), `${ORIGIN}/docs/delete-branch`);
  });
}
