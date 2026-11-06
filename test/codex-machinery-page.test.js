import test from 'node:test';
import { headlessEnv } from '../scripts/headless-env.mjs';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { legalActions } from '../src/runtime.js';
const script = new URL('../extension/page.js', import.meta.url).pathname;
let browser;
test.before(async () => { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, env: headlessEnv(), args: ['--no-sandbox'] }); });
test.after(() => browser?.close());
const doc = body => `<!doctype html><title>Fixture</title><body>${body}</body>`;
async function open(t, routes) {
  const page = await browser.newPage(); t.after(() => page.close());
  await page.route('https://example.com*/**', route => {
    const u = new URL(route.request().url());
    const body = routes[u.origin + u.pathname] ?? routes[u.pathname] ?? '';
    return route.fulfill({ contentType: 'text/html', body: doc(body) });
  });
  await page.goto('https://example.com/'); await page.addScriptTag({ path: script }); return page;
}
const observe = p => p.evaluate(() => __faiPage.observe());
test('rendered label split across block spans still blocks Place order', async t => {
  const p = await open(t, { '/': '<a href="/buy"><span style="display:block">Place</span><span style="display:block">order</span></a>' });
  const o = await observe(p);
  assert.ok(!legalActions(o, { mode: 'reversible' }).some(a => a.role === 'link'), o.controls[0].label);
});
test('options in a rendered but explicitly closed popup are withheld until expanded', async t => {
  const p = await open(t, { '/': '<button aria-expanded="false" aria-controls="sizes">Sizes</button><div id="sizes" role="listbox"><div role="option">Large</div></div><div role="listbox" hidden><div role="option">Hidden</div></div>' });
  let o = await observe(p);
  assert.ok(!o.controls.some(c => c.role === 'option' || c.role === 'listbox'));
  await p.locator('button').evaluate(e => e.setAttribute('aria-expanded', 'true'));
  o = await observe(p); assert.deepEqual(o.controls.filter(c => c.role === 'option').map(c => c.label), ['Large']);
});
test('commit options and drifted submission verbs are refused by dispatch', async t => {
  const p = await open(t, { '/': '<div role="listbox"><div role="option">Buy</div><div role="option">Delete</div></div><button type="button">Publish</button><button type="button">Invite</button><button type="button">Sign in</button>' });
  const o = await observe(p);
  for (const c of o.controls) {
    assert.ok(['purchase', 'submit', 'delete', 'sign_in', 'destructive'].includes(c.risk), `${c.label}: ${c.risk}`);
    const code = await p.evaluate(async ([id, revision]) => { try { await __faiPage.execute({ type: 'click', target: id }, revision, { quietMs: 1, capMs: 20 }); return 'clicked'; } catch (e) { return e.code; } }, [c.id, o.revision]);
    assert.equal(code, 'blocked_risky', c.label);
  }
});
test('same-host different-port and nested frames are never read; frame acceptance stays destructive', async t => {
  const p = await open(t, { '/': '<iframe src="https://example.com:444/foreign"></iframe><iframe src="/frame"></iframe>', '/foreign': '<p>Foreign secret</p><button>Foreign</button>', '/frame': '<button type="button">Accept all</button><iframe src="/nested"></iframe>', '/nested': '<p>Nested secret</p><button>Nested</button>' });
  const o = await observe(p);
  assert.ok(o.warnings.includes('cross_origin_frame')); assert.doesNotMatch(o.text, /Foreign secret|Nested secret/);
  assert.deepEqual(o.controls.map(c => [c.label, c.risk, c.frame]), [['Accept all', 'consent_accept', 1]]);
  const prior = o.revision;
  await p.locator('iframe').nth(1).evaluate(e => { e.src = 'https://example.com:444/foreign'; });
  await p.waitForFunction(() => [...document.querySelectorAll('iframe')].every(e => !e.contentDocument));
  const code = await p.evaluate(async r => { try { await __faiPage.execute({ type: 'click', target: '1' }, r); return 'clicked'; } catch (e) { return e.code; } }, prior);
  assert.ok(['stale', 'cross_origin', 'target_unavailable'].includes(code));
});
test('100-control cap keeps unique ids across page shadow and frame', async t => {
  const buttons = prefix => Array.from({ length: 45 }, (_, i) => `<button type="button">${prefix}${i}</button>`).join('');
  const p = await open(t, { '/': '<div id="host"></div><iframe src="/frame" height="400"></iframe>' + buttons('Top'), '/frame': buttons('Frame') });
  await p.locator('#host').evaluate((e, html) => { e.attachShadow({ mode: 'open' }).innerHTML = html; }, buttons('Shadow'));
  const o = await observe(p); assert.equal(o.controls.length, 100);
  assert.equal(new Set(o.controls.map(c => c.id)).size, 100);
  for (const prefix of ['Top', 'Frame', 'Shadow']) assert.ok(o.controls.some(c => c.label.startsWith(prefix)), prefix);
});
test('frame link without target waits for frame load and run continues', async t => {
  const p = await open(t, { '/': '<iframe src="/frame"></iframe>', '/frame': '<a href="/next">Details</a>', '/next': '<p>Loaded frame destination</p><button type="button">Continue</button>' });
  const o = await observe(p);
  const result = await p.evaluate(async r => __faiPage.execute({ type: 'click', target: '1' }, r, { quietMs: 10, capMs: 100 }), o.revision);
  assert.equal(result.expectNavigation, false); assert.match(result.observation.text, /Loaded frame destination/);
});
test('closed dropdown in an open shadow root withholds options until its own trigger expands', async t => {
  const p = await open(t, { '/': '<div id="host"></div>' });
  await p.locator('#host').evaluate(e => { e.attachShadow({ mode: 'open' }).innerHTML = '<button aria-expanded="false" aria-controls="sizes">Sizes</button><div id="sizes" role="listbox"><div role="option">Large</div></div>'; });
  assert.ok(!(await observe(p)).controls.some(c => c.role === 'option'));
  await p.locator('#host').evaluate(e => e.shadowRoot.querySelector('button').setAttribute('aria-expanded', 'true'));
  assert.ok((await observe(p)).controls.some(c => c.role === 'option' && c.label === 'Large'));
});
