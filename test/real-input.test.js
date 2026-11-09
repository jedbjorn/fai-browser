// Realistic input (extension/input.js) in headless Chromium, run the way the extension runs it: input.js and page.js
// evaluated in an isolated world (CDP Page.createIsolatedWorld), actions through __faiPage.execute. Checked against
// fixtures/detection/detector.html, a stand-in for a bot-detection script's client half: the realistic path trips
// none of its heuristics (only isTrusted, which no content script can set), the plain path trips the usual ones;
// every click, submit and change happens exactly once; nothing shows in the page's own world (globals, DOM,
// console); a controlled input and a key-swallowing field still end up filled; the added latency stays modest.
// CHROMIUM_PATH overrides the browser binary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { chromium } from 'playwright-core';
import { headlessEnv } from '../scripts/headless-env.mjs';

const ROOT = new URL('..', import.meta.url);
const INPUT_SOURCE = await readFile(new URL('extension/input.js', ROOT), 'utf8');
const PAGE_SOURCE = await readFile(new URL('extension/page.js', ROOT), 'utf8');
const DETECTOR = await readFile(new URL('fixtures/detection/detector.html', ROOT), 'utf8');
const ORIGIN = 'https://detector.test';
const ALLOW = ['navigate', 'controls', 'submit_safe'];

let browser;
test.before(async () => {
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    headless: true, env: headlessEnv(), args: ['--no-sandbox'],
  });
});
test.after(() => browser?.close());

async function open(t, body, { realistic = true, path = '/', origin = ORIGIN } = {}) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  t.after(() => context.close());
  const page = await context.newPage();
  const requests = [];
  await page.route(`${origin}/**`, route => {
    requests.push(new URL(route.request().url()).pathname);
    const url = new URL(route.request().url());
    route.fulfill({ contentType: 'text/html', body: url.pathname === '/next' ? '<!doctype html><title>Next</title><h1>Next</h1>' : body });
  });
  await page.goto(origin + path);
  const consoleMessages = [];
  page.on('console', message => consoleMessages.push(message.text()));
  const cdp = await context.newCDPSession(page);
  const { frameTree } = await cdp.send('Page.getFrameTree');
  const { executionContextId } = await cdp.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'fai-test' });
  const run = async expression => {
    const reply = await cdp.send('Runtime.evaluate', { contextId: executionContextId, expression, awaitPromise: true, returnByValue: true });
    if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text);
    return reply.result.value;
  };
  if (realistic) await run(INPUT_SOURCE);
  await run(PAGE_SOURCE);
  return { page, run, requests, consoleMessages, cdp, contextId: executionContextId };
}

// One action on the control whose label contains `label` (or a targetless one), through observe + execute.
function act(run, label, action) {
  return run(`(async () => {
    const allow = ${JSON.stringify(ALLOW)};
    const o = __faiPage.observe({ allow, blocks: false });
    const label = ${JSON.stringify(label)};
    const control = label === null ? null : o.controls.find(c => c.label.includes(label));
    if (label !== null && !control) return { error: 'no control ' + label + ' in ' + o.controls.map(c => c.label).join('|') };
    const action = { ...${JSON.stringify(action)}, ...(control ? { target: control.id } : {}) };
    try {
      const r = await __faiPage.execute(action, o.revision, { quietMs: 30, capMs: 400 }, [], [], allow);
      return { inputMs: r.inputMs ?? null, fill: r.fill ?? null, expectNavigation: r.expectNavigation };
    } catch (e) { return { error: e.code + ': ' + e.message }; }
  })()`);
}

const detector = page => page.evaluate(() => window.__detector.report());

const SEQUENCE = [
  ['Show details', { type: 'click' }],
  ['Full name', { type: 'fill_supplied_text', text: 'Ada Lovelace-Byron' }],
  ['Notes', { type: 'fill_supplied_text', text: 'Window seat, please; arriving late (after 22:00) with two bags & a stroller.' }],
  ['Search', { type: 'fill_supplied_text', text: 'Flights to Oslo' }, 'q'],
  ['Search', { type: 'submit_field' }, 'q'],
  ['Sort by', { type: 'select', value: 'price' }],
  [null, { type: 'scroll', direction: 'down' }],
  ['Load more results', { type: 'click' }],
  ['Jump to results', { type: 'click' }],
];

async function runSequence(run, gapMs = 0) {
  const results = [];
  for (const [label, action] of SEQUENCE) {
    // The plain path is quick enough that one action's keydown would excuse the next one's pointerless click.
    if (gapMs) await new Promise(resolve => setTimeout(resolve, gapMs));
    // The search field and its button share the word: the field is the textbox.
    const pick = label === 'Search' ? 'Search' : label;
    const result = action.type === 'fill_supplied_text' || action.type === 'submit_field'
      ? await actOnField(run, pick, action)
      : await act(run, pick, action);
    assert.equal(result.error, undefined, `${label} ${action.type}: ${result.error}`);
    results.push({ type: action.type, ...result });
  }
  return results;
}

function actOnField(run, label, action) {
  return run(`(async () => {
    const allow = ${JSON.stringify(ALLOW)};
    const o = __faiPage.observe({ allow, blocks: false });
    const control = o.controls.find(c => c.label.includes(${JSON.stringify(label)}) && ['textbox', 'searchbox', 'combobox'].includes(c.role));
    if (!control) return { error: 'no field ' + o.controls.map(c => c.role + ':' + c.label).join('|') };
    try {
      const r = await __faiPage.execute({ ...${JSON.stringify(action)}, target: control.id }, o.revision, { quietMs: 30, capMs: 400 }, [], [], allow);
      return { inputMs: r.inputMs ?? null, fill: r.fill ?? null };
    } catch (e) { return { error: e.code + ': ' + e.message }; }
  })()`);
}

const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null;
};

test('realistic input trips none of the detector heuristics, once per action, with nothing in the page world', async t => {
  const { page, run, consoleMessages } = await open(t, DETECTOR);
  const webdriverBefore = await page.evaluate(() => navigator.webdriver);
  await page.evaluate(() => {
    window.__mutations = [];
    new MutationObserver(records => {
      for (const r of records) {
        if (r.target.closest?.('#status') || r.target.parentElement?.closest?.('#status')) continue;
        window.__mutations.push(`${r.type}:${r.attributeName ?? ''}:${r.target.id || r.target.nodeName}`);
      }
    }).observe(document, { subtree: true, attributes: true, childList: true, characterData: true });
  });
  const results = await runSequence(run);
  await new Promise(resolve => setTimeout(resolve, 150));
  const report = await detector(page);
  assert.deepEqual(report.flags, {}, report.details.join('\n'));
  assert.ok(report.untrusted > 0, 'isTrusted stays false: the one signal a content script cannot change');
  // Exactly once: each control's click, the one submit, one change per typed field.
  assert.deepEqual(report.counts.click, { show: 1, name: 1, notes: 1, q: 1, go: 1, sort: 1, far: 1, section: 1 });
  assert.equal(report.counts.submit, 1);
  assert.deepEqual(report.counts.change, { name: 1, notes: 1, q: 1, sort: 1 });
  const values = await page.evaluate(() => ({
    name: document.getElementById('name').value, notes: document.getElementById('notes').value,
    q: document.getElementById('q').value, sort: document.getElementById('sort').value,
    status: document.getElementById('status').textContent, hash: location.hash,
  }));
  assert.deepEqual(values, {
    name: 'Ada Lovelace-Byron', notes: SEQUENCE[2][1].text, q: 'Flights to Oslo', sort: 'price',
    status: 'More results loaded.', hash: '#results',
  });
  for (const fill of results.filter(r => r.type === 'fill_supplied_text')) assert.equal(fill.fill.kept, true);
  // Nothing page-visible: no globals in the page's world, no DOM changes of ours, no console output, webdriver as is.
  assert.deepEqual(await page.evaluate(() => Object.keys(window).filter(key => /fai/i.test(key))), []);
  assert.deepEqual(await page.evaluate(() => window.__mutations), []);
  assert.deepEqual(consoleMessages, []);
  assert.equal(await page.evaluate(() => navigator.webdriver), webdriverBefore);
  for (const source of [INPUT_SOURCE, PAGE_SOURCE]) assert.doesNotMatch(source, /webdriver|console\.(?:log|info|warn|error|debug)/);

  const byType = type => results.filter(r => r.type === type).map(r => r.inputMs);
  t.diagnostic(`added ms: click ${byType('click').join(',')} fill ${byType('fill_supplied_text').join(',')} `
    + `enter ${byType('submit_field').join(',')} select ${byType('select').join(',')} scroll ${byType('scroll').join(',')}`);
});

test('the plain path (no input.js) trips the heuristics the realistic one avoids', async t => {
  const { page, run } = await open(t, DETECTOR, { realistic: false });
  await runSequence(run, 500);
  const report = await detector(page);
  t.diagnostic(`plain path flags: ${Object.keys(report.flags).join(', ')}`);
  for (const name of ['click_without_pointerdown', 'click_without_mousedown_up', 'click_without_pointer', 'click_without_movement',
    'zero_coordinates', 'value_without_keys', 'input_not_inputevent', 'change_without_commit', 'scroll_without_wheel']) {
    assert.ok(report.flags[name] > 0, `${name} expected in ${JSON.stringify(report.flags)}`);
  }
});

test('click latency: p50 under 250 ms over repeated clicks; typing is capped', async t => {
  const body = `<!doctype html><title>Many</title>${Array.from({ length: 12 }, (_, i) => `<button style="margin:${20 + (i * 37) % 200}px ${(i * 91) % 600}px">Item ${i + 1}</button>`).join('')}
    <input aria-label="Long field">`;
  const { run } = await open(t, body);
  const clicks = [];
  for (let i = 1; i <= 12; i++) {
    const result = await act(run, `Item ${i}`, { type: 'click' });
    assert.equal(result.error, undefined, result.error);
    clicks.push(result.inputMs);
  }
  const p50 = median(clicks);
  t.diagnostic(`click p50 ${p50} ms (max ${Math.max(...clicks)})`);
  assert.ok(p50 < 250, `click p50 ${p50}`);
  const long = await actOnField(run, 'Long field', { type: 'fill_supplied_text', text: 'x'.repeat(400) });
  assert.equal(long.fill.kept, true);
  t.diagnostic(`400-character fill ${long.inputMs} ms`);
  assert.ok(long.inputMs < 2500, `long fill ${long.inputMs}`);
});

test('links navigate once, submit buttons submit once, and page-cancelled presses behave as for a mouse', async t => {
  const body = `<!doctype html><title>Once</title>
    <a id="next" href="/next">Next page</a>
    <form id="f" action="/next"><input name="q" aria-label="Query"><button id="send">Search</button></form>
    <button id="pd">Pointer cancelled</button><button id="md">Mouse cancelled</button>
    <ul role="listbox" id="list"><li role="option" id="opt" tabindex="-1">Oslo</li></ul>
    <p id="out"></p>
    <script>
      window.seen = [];
      for (const t of ['pointerdown', 'mousedown', 'mouseup', 'click', 'submit', 'focus']) addEventListener(t, e => seen.push(t + ':' + (e.target.id || e.target.tagName)), true);
      document.getElementById('pd').addEventListener('pointerdown', e => e.preventDefault());
      document.getElementById('md').addEventListener('mousedown', e => e.preventDefault());
      // A dropdown that selects on mousedown and removes the option, as many do.
      document.getElementById('opt').addEventListener('mousedown', e => { document.getElementById('out').textContent = 'picked ' + e.target.textContent; e.target.remove(); });
      document.getElementById('f').addEventListener('submit', e => { e.preventDefault(); document.getElementById('out').textContent = 'submitted'; });
    </script>`;
  const { page, run, requests } = await open(t, body);
  const seen = () => page.evaluate(() => window.seen.splice(0));

  assert.equal((await act(run, 'Pointer cancelled', { type: 'click' })).error, undefined);
  assert.deepEqual(await seen(), ['pointerdown:pd', 'focus:pd', 'click:pd']);
  // A mouse press focuses without a focus ring, as a real one does.
  assert.equal(await page.evaluate(() => document.activeElement.id), 'pd');
  assert.equal(await page.evaluate(() => document.activeElement.matches(':focus-visible')), false);
  assert.equal((await act(run, 'Mouse cancelled', { type: 'click' })).error, undefined);
  assert.deepEqual(await seen(), ['pointerdown:md', 'mousedown:md', 'mouseup:md', 'click:md']);
  assert.equal((await act(run, 'Oslo', { type: 'click' })).error, undefined);
  assert.equal(await page.textContent('#out'), 'picked Oslo');
  assert.deepEqual((await seen()).filter(e => e.startsWith('click')), []);
  assert.equal((await act(run, 'Search', { type: 'click' })).error, undefined);
  assert.equal(await page.textContent('#out'), 'submitted');
  assert.deepEqual((await seen()).filter(e => /^(?:click|submit)/.test(e)), ['click:send', 'submit:f']);

  const result = await act(run, 'Next page', { type: 'click' });
  assert.equal(result.error, undefined);
  assert.equal(result.expectNavigation, true);
  await page.waitForURL(`${ORIGIN}/next`);
  assert.deepEqual(requests.filter(path => path === '/next'), ['/next']);
});

test('controlled and key-swallowing fields still end up filled; Enter in a form without a button submits once', async t => {
  const body = `<!doctype html><title>Fields</title>
    <input id="upper" aria-label="City">
    <input id="digits" aria-label="Phone">
    <form id="f"><input id="solo" aria-label="Lookup" name="lookup"></form><p id="out"></p>
    <script>
      // A controlled input: every input event re-renders the value from state (upper case), as React does.
      let state = '';
      const upper = document.getElementById('upper');
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      upper.addEventListener('input', () => { state = upper.value.toUpperCase(); queueMicrotask(() => set.call(upper, state)); });
      // A field that takes digits only and swallows every other key, including the ones it handles itself.
      document.getElementById('digits').addEventListener('keydown', e => { if (e.key.length === 1) e.preventDefault(); });
      window.submits = 0;
      document.getElementById('f').addEventListener('submit', e => { e.preventDefault(); window.submits++; });
    </script>`;
  const { page, run } = await open(t, body);
  const city = await actOnField(run, 'City', { type: 'fill_supplied_text', text: 'oslo gardermoen' });
  assert.equal(city.fill.kept, true);
  assert.equal(await page.inputValue('#upper'), 'OSLO GARDERMOEN');
  const phone = await actOnField(run, 'Phone', { type: 'fill_supplied_text', text: '5551234' });
  assert.equal(phone.fill.kept, true, 'the plain set fills a field that swallowed the keys');
  assert.equal(await page.inputValue('#digits'), '5551234');
  assert.equal((await actOnField(run, 'Lookup', { type: 'fill_supplied_text', text: 'abc' })).error, undefined);
  // Replace, not append: a second fill of a field selects what it holds first.
  assert.equal((await actOnField(run, 'Lookup', { type: 'fill_supplied_text', text: 'search term' })).error, undefined);
  assert.equal(await page.inputValue('#solo'), 'search term');
  const enter = await run(`(async () => {
    const allow = ['navigate', 'controls', 'submit_safe', 'submit'];
    const o = __faiPage.observe({ allow, blocks: false });
    const c = o.controls.find(c => c.label === 'Lookup');
    try { await __faiPage.execute({ type: 'submit_field', target: c.id }, o.revision, { quietMs: 30, capMs: 300 }, [], [], allow); return 'ok'; }
    catch (e) { return e.code + ': ' + e.message; }
  })()`);
  assert.equal(enter, 'ok');
  assert.equal(await page.evaluate(() => window.submits), 1);
});

test('trusted input: the sequences go to the worker as debugger steps, and nothing synthetic follows once they went out', async t => {
  const body = `<!doctype html><title>Trusted</title>
    <button id="b" style="margin:200px 300px">Press here</button><input id="f" aria-label="Field">
    <form id="s"><input id="l" aria-label="Lookup" name="lookup"></form>
    <script>
      window.seen = [];
      for (const type of ['pointerdown', 'mousedown', 'click', 'keydown', 'submit']) addEventListener(type, e => { seen.push(type); if (type === 'submit') e.preventDefault(); }, true);
    </script>`;
  const { page, run } = await open(t, body);
  // A stand-in for the worker's chrome.debugger replay, in the isolated world: it records the steps and reports them
  // dispatched (they never reach the page, so the page sees no events at all).
  await run(`globalThis.chrome = { runtime: { sendMessage: async message => {
    (globalThis.__steps ||= []).push(message.steps);
    return { ok: true, dispatched: message.steps.filter(step => step.wait === undefined).length };
  } } }; __faiInput.configure({ trusted: true, slipRate: 0 }); true`);
  const steps = () => run('(globalThis.__steps || []).splice(0)');

  assert.equal((await act(run, 'Press here', { type: 'click' })).error, undefined);
  const [moves, press] = await steps();
  assert.ok(moves.filter(step => step.type === 'mouseMoved').length >= 3);
  assert.deepEqual(press.map(step => step.type ?? 'wait'), ['mousePressed', 'wait', 'mouseReleased']);
  const box = await page.evaluate(() => JSON.parse(JSON.stringify(document.getElementById('b').getBoundingClientRect())));
  const at = press[0];
  assert.ok(at.x >= box.left && at.x < box.right && at.y >= box.top && at.y < box.bottom, JSON.stringify({ at, box }));
  assert.deepEqual([moves.at(-1).x, moves.at(-1).y], [at.x, at.y]);

  const fill = await actOnField(run, 'Field', { type: 'fill_supplied_text', text: 'Hi there' });
  // The stand-in inserted nothing, so the plain set filled it: the fallback a refused attach also takes.
  assert.equal(fill.fill.kept, true);
  const typing = (await steps()).flat();
  assert.deepEqual(typing.filter(step => step.type === 'keyDown').map(step => step.text), ['H', 'i', ' ', 't', 'h', 'e', 'r', 'e']);
  assert.ok(typing.some(step => step.key === 'Shift' && step.type === 'rawKeyDown'));
  assert.equal(typing.find(step => step.text === 'H').modifiers, 8);

  const enter = await run(`(async () => {
    const allow = ['navigate', 'controls', 'submit_safe', 'submit'];
    const o = __faiPage.observe({ allow, blocks: false });
    const c = o.controls.find(c => c.label === 'Lookup');
    await __faiPage.execute({ type: 'submit_field', target: c.id }, o.revision, { quietMs: 30, capMs: 300 }, [], [], allow);
    return 'ok';
  })()`);
  assert.equal(enter, 'ok');
  const enterSteps = (await steps()).flat().filter(step => step.wait === undefined);
  assert.deepEqual(enterSteps.map(step => `${step.type}:${step.key}`), ['keyDown:Enter', 'keyUp:Enter']);
  // The browser's own Enter submits by itself: no synthetic press, key, click or submit reached the page.
  assert.deepEqual(await page.evaluate(() => window.seen), []);
});

test('trusted input end to end: the steps, mapped by trusted-input.js and sent over CDP, give trusted events once each', async t => {
  const body = `<!doctype html><title>Trusted CDP</title>
    <button id="b" style="margin:40px">Count me</button>
    <form id="s"><input id="q" aria-label="Lookup" name="lookup" value="old text"><button id="go">Search</button></form>
    <div style="height:3000px"></div>
    <script>
      window.log = { clicks: 0, trustedClicks: 0, submits: 0, trustedInputs: 0, untrustedInputs: 0, activation: false };
      document.getElementById('b').addEventListener('click', e => { log.clicks++; if (e.isTrusted) log.trustedClicks++; log.activation = navigator.userActivation.isActive; });
      document.getElementById('q').addEventListener('input', e => { if (e.isTrusted) log.trustedInputs++; else log.untrustedInputs++; });
      document.getElementById('s').addEventListener('submit', e => { e.preventDefault(); if (e.isTrusted) log.submits++; });
    </script>`;
  const { page, run, cdp, contextId } = await open(t, body);
  // trusted-input.js's own step mapping (cleanTrustedStep), loaded without a worker around it.
  const worker = vm.createContext({ chrome: {}, setTimeout, clearTimeout });
  vm.runInContext(await readFile(new URL('extension/trusted-input.js', ROOT), 'utf8'), worker);
  // The worker's replay, with Playwright's CDP session standing in for chrome.debugger.
  await cdp.send('Runtime.enable');
  await cdp.send('Runtime.addBinding', { name: '__faiTrusted', executionContextName: 'fai-test' });
  cdp.on('Runtime.bindingCalled', async ({ name, payload, executionContextId }) => {
    if (name !== '__faiTrusted') return;
    const { id, steps, viewport } = JSON.parse(payload);
    let dispatched = 0;
    for (const raw of steps) {
      const step = worker.cleanTrustedStep(raw, viewport);
      assert.ok(step, JSON.stringify(raw));
      if (step.wait !== undefined) await new Promise(resolve => setTimeout(resolve, step.wait));
      else {
        await cdp.send(step.method, JSON.parse(JSON.stringify(step.params)));
        dispatched++;
      }
    }
    await cdp.send('Runtime.evaluate', { contextId: executionContextId, expression: `globalThis.__answer(${id}, ${dispatched})` }).catch(() => {});
  });
  await run(`globalThis.__answers = new Map();
    globalThis.__answer = (id, dispatched) => { __answers.get(id)?.({ ok: true, dispatched }); __answers.delete(id); };
    globalThis.chrome = { runtime: { sendMessage: message => new Promise(resolve => {
      const id = __answers.size + Math.floor(Math.random() * 1e9);
      __answers.set(id, resolve);
      __faiTrusted(JSON.stringify({ id, steps: message.steps, viewport: message.viewport }));
    }) } };
    __faiInput.configure({ trusted: true }); true`);
  assert.ok(contextId);

  assert.equal((await act(run, 'Count me', { type: 'click' })).error, undefined);
  let log = await page.evaluate(() => window.log);
  assert.equal(log.clicks, 1);
  assert.equal(log.trustedClicks, 1);
  assert.equal(log.activation, true, 'a trusted press gives user activation');

  const fill = await actOnField(run, 'Lookup', { type: 'fill_supplied_text', text: 'Fjord Hotels' });
  assert.equal(fill.fill.kept, true);
  assert.equal(await page.inputValue('#q'), 'Fjord Hotels', 'select-all replaced the old text');
  log = await page.evaluate(() => window.log);
  assert.ok(log.trustedInputs >= 'Fjord Hotels'.length);
  assert.equal(log.untrustedInputs, 0);

  const enter = await run(`(async () => {
    const allow = ['navigate', 'controls', 'submit_safe'];
    const o = __faiPage.observe({ allow, blocks: false });
    const c = o.controls.find(c => c.label === 'Lookup');
    try { await __faiPage.execute({ type: 'submit_field', target: c.id }, o.revision, { quietMs: 30, capMs: 300 }, [], [], allow); return 'ok'; }
    catch (e) { return e.code + ': ' + e.message; }
  })()`);
  assert.equal(enter, 'ok');
  assert.equal((await page.evaluate(() => window.log)).submits, 1, 'the browser submitted once, nothing else did');

  const before = await page.evaluate(() => scrollY);
  assert.equal((await act(run, null, { type: 'scroll', direction: 'down' })).error, undefined);
  assert.ok(await page.evaluate(() => scrollY) > before + 300);
});

test('a typed field gets its change once, when it loses focus, whoever moves the focus', async t => {
  const body = `<!doctype html><title>Blur</title><input id="a" aria-label="From"><input id="b" aria-label="To">
    <script>window.changes = 0; document.getElementById('a').addEventListener('change', () => { window.changes++; });</script>`;
  const { page, run } = await open(t, body);
  assert.equal((await actOnField(run, 'From', { type: 'fill_supplied_text', text: 'Oslo' })).fill.kept, true);
  assert.equal(await page.evaluate(() => window.changes), 0, 'no change while the field still has focus');
  await page.evaluate(() => document.getElementById('b').focus());
  assert.equal(await page.evaluate(() => window.changes), 1);
  assert.equal((await actOnField(run, 'To', { type: 'fill_supplied_text', text: 'Bergen' })).fill.kept, true);
  assert.equal(await page.evaluate(() => window.changes), 1);
});

test('a plain-http page (no secure context): realistic click, typing and Enter work', async t => {
  const body = `<!doctype html><title>Plain</title><button id="b">Go on</button><form id="f"><input aria-label="Name" name="n"></form>
    <script>window.log = []; document.getElementById('b').onclick = () => log.push('click');
      document.getElementById('f').onsubmit = e => { e.preventDefault(); log.push('submit'); };</script>`;
  const { page, run } = await open(t, body, { origin: 'http://plain.test' });
  assert.equal(await page.evaluate(() => window.isSecureContext), false);
  assert.equal((await act(run, 'Go on', { type: 'click' })).error, undefined);
  assert.equal((await actOnField(run, 'Name', { type: 'fill_supplied_text', text: 'Ada' })).fill.kept, true);
  const enter = await run(`(async () => {
    const allow = ['navigate', 'controls', 'submit_safe', 'submit'];
    const o = __faiPage.observe({ allow, blocks: false });
    const c = o.controls.find(c => c.label === 'Name');
    try { await __faiPage.execute({ type: 'submit_field', target: c.id }, o.revision, { quietMs: 30, capMs: 300 }, [], [], allow); return 'ok'; }
    catch (e) { return e.code + ': ' + e.message; }
  })()`);
  assert.equal(enter, 'ok');
  assert.deepEqual(await page.evaluate(() => window.log), ['click', 'submit']);
});

// Symbols, accents, other scripts, emoji (with a skin-tone modifier), a newline: typed key by key in full, typed in
// part with the rest inserted, and as a secret, the field ends up with exactly the text.
const TRICKY = 'Ünïcode — 日本 🎉👍🏽 "quotes" <tag> & {x}~ |\\ `tick` 50% off!\nLine 2: Aa1@#$^*()_+=[];\',./?';
const RHYTHM_PAGE = `<!doctype html><title>Rhythm</title>
  <textarea id="t" aria-label="Notes"></textarea><input id="i" aria-label="Name"><input id="p" type="password" aria-label="PIN">
  <form id="f"><input id="q" aria-label="Query" name="q"><button>Go</button></form>
  <input id="m" maxlength="5" aria-label="Code"><input id="slow" aria-label="Slow"><input id="ph" aria-label="Phone">
  <input id="eat" aria-label="Eats Backspace"><input id="pre" aria-label="Prefixed"><input id="dbl" aria-label="Doubled">
  <script>
    window.log = [];
    window.submits = 0;
    for (const type of ['keydown', 'keyup']) addEventListener(type, e => log.push([type, e.key, e.code, performance.now(), e.isTrusted, e.shiftKey]), true);
    for (const type of ['beforeinput', 'input']) addEventListener(type, e => log.push([type, e.inputType, e.target.id, performance.now(), e.isTrusted]), true);
    document.getElementById('f').addEventListener('submit', e => { e.preventDefault(); submits++; });
    // Key handlers that take 140 ms each.
    document.getElementById('slow').addEventListener('keydown', () => { const s = performance.now(); while (performance.now() - s < 140); });
    // A formatter: digits in groups of three.
    document.getElementById('ph').addEventListener('input', e => { const d = e.target.value.replace(/\\D/g, ''); e.target.value = d.replace(/(\\d{3})(?=\\d)/g, '$1 '); });
    document.getElementById('eat').addEventListener('keydown', e => { if (e.key === 'Backspace') e.preventDefault(); });
    // A broken field that always shows the text twice.
    document.getElementById('dbl').addEventListener('input', e => { e.target.value = 'abc abc'; });
    // A field that always starts with '#'.
    document.getElementById('pre').addEventListener('input', e => { if (!e.target.value.startsWith('#')) e.target.value = '#' + e.target.value; });
  </script>`;

// Formatting and completing fields (the review's exp3): an inline-completing combobox that blocks Ctrl+A, a currency
// formatter, a country-code phone, upper case, an IBAN without spaces, and a field with old text that blocks Ctrl+A.
const FORMAT_PAGE = `<!doctype html><title>Formats</title>
  <input id="cb" role="combobox" aria-label="From" aria-autocomplete="list">
  <input id="cur" aria-label="Amount" inputmode="decimal">
  <input id="cc" aria-label="Country phone" type="tel">
  <input id="up" aria-label="Code">
  <input id="iban" aria-label="IBAN">
  <input id="noa" aria-label="NoSelectAll" value="old">
  <script>
    const field = id => document.getElementById(id);
    field('cb').addEventListener('input', e => { if (/^oslo$/i.test(e.target.value)) e.target.value = 'Oslo (OSL)'; });
    for (const id of ['cb', 'noa']) field(id).addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'a') e.preventDefault(); });
    field('cur').addEventListener('input', e => { const d = e.target.value.replace(/[^\\d]/g, ''); e.target.value = d ? '$' + Number(d).toLocaleString('en-US') + '.00' : ''; });
    field('cc').addEventListener('input', e => { const d = e.target.value.replace(/\\D/g, '').replace(/^1/, ''); e.target.value = '+1 ' + d; });
    field('up').addEventListener('input', e => { e.target.value = e.target.value.toUpperCase(); });
    field('iban').addEventListener('input', e => { e.target.value = e.target.value.replace(/\\s/g, '').toUpperCase(); });
  </script>`;

// input.js's type() on a field, straight from the isolated world (no fallback: what the keys produced is what shows).
function typeInto(run, selector, text, options = {}) {
  return run(`(async () => {
    const el = document.querySelector(${JSON.stringify(selector)});
    el.focus();
    const r = await __faiInput.type(el, ${JSON.stringify(text)}, ${JSON.stringify(options)});
    return { typed: r.typed, chunked: r.chunked, fallback: r.fallback, trusted: r.trusted ?? false, corrected: r.corrected, slips: r.slips, ms: r.ms, value: el.value };
  })()`);
}

const pageLog = page => page.evaluate(() => window.log.splice(0));

// The page's key log since the last call: rollovers (a key down while another non-modifier key is down), the least
// time from a keydown to the next keyup, the keydown intervals, and the letters that came with the wrong Shift.
async function keyRhythm(page) {
  const entries = (await pageLog(page)).filter(([type]) => type === 'keydown' || type === 'keyup');
  const held = new Map();
  let rollovers = 0;
  let lastDown = null;
  let quickestUp = Infinity;
  let downs = 0;
  const wrongShift = [];
  const intervals = [];
  for (const [type, key, code, at, , shiftKey] of entries) {
    if (key === 'Shift' || key === 'Control' || key === 'Meta') continue;
    const id = code || key;
    if (type === 'keydown') {
      downs++;
      if (held.size) rollovers++;
      if (lastDown !== null) intervals.push(at - lastDown);
      lastDown = at;
      held.set(id, at);
      if (/^[a-z]$/i.test(key) && shiftKey !== (key !== key.toLowerCase())) wrongShift.push(key);
    } else {
      if (lastDown !== null) quickestUp = Math.min(quickestUp, at - lastDown);
      held.delete(id);
    }
  }
  const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
  const sd = Math.sqrt(intervals.reduce((a, b) => a + (b - mean) ** 2, 0) / intervals.length);
  return { entries, downs, rollovers, quickestUp, cv: sd / mean, mean, wrongShift };
}

// The worker's trusted replay, with Playwright's CDP session standing in for chrome.debugger and trusted-input.js's
// own step mapping and deadline (runTrustedSteps over a fake chrome.debugger that forwards to CDP).
async function wireTrusted(run, cdp) {
  const worker = vm.createContext({
    setTimeout, clearTimeout, Date, session: { tabId: 1 },
    chrome: { debugger: { attach: async () => {}, detach: async () => {}, sendCommand: (target, method, params) => cdp.send(method, JSON.parse(JSON.stringify(params))) } },
  });
  vm.runInContext(await readFile(new URL('extension/trusted-input.js', ROOT), 'utf8'), worker);
  vm.runInContext('trustedInputSetting = true;', worker);
  await cdp.send('Runtime.enable');
  await cdp.send('Runtime.addBinding', { name: '__faiTrusted', executionContextName: 'fai-test' });
  cdp.on('Runtime.bindingCalled', async ({ name, payload, executionContextId }) => {
    if (name !== '__faiTrusted') return;
    const { id, steps, viewport, deadline } = JSON.parse(payload);
    const reply = await worker.runTrustedSteps(1, steps, viewport, { deadline });
    await cdp.send('Runtime.evaluate', { contextId: executionContextId, expression: `globalThis.__answer(${id}, ${JSON.stringify(JSON.stringify(reply))})` }).catch(() => {});
  });
  await run(`globalThis.__answers = new Map();
    globalThis.__answer = (id, reply) => { __answers.get(id)?.(JSON.parse(reply)); __answers.delete(id); };
    globalThis.chrome = { runtime: { sendMessage: message => new Promise(resolve => {
      const id = Math.floor(Math.random() * 1e9);
      __answers.set(id, resolve);
      __faiTrusted(JSON.stringify({ id, steps: message.steps, viewport: message.viewport, deadline: message.deadline }));
    }) } };
    __faiInput.configure({ trusted: true }); true`);
}

const PATHS = ['synthetic', 'trusted'];
async function openRhythm(t, path) {
  const opened = await open(t, RHYTHM_PAGE);
  if (path === 'trusted') await wireTrusted(opened.run, opened.cdp);
  return opened;
}

for (const path of PATHS) {
  test(`typing rhythm (${path}): exact values for symbols, unicode, emoji and newlines, in full, in part and as a secret; keys roll over`, async t => {
    const { page, run } = await openRhythm(t, path);
    const trusted = path === 'trusted';
    // In full, every character a key (63 keys fit the worker's 400 steps), seeded so the counts below are fixed.
    const text = trusted ? Array.from(TRICKY).slice(0, 60).join('') : TRICKY;
    const chars = Array.from(text);
    await run('__faiInput.configure({ typeBudgetMs: 60000, maxTyped: 1000, keySeed: 11, slipRate: 0 }); true');
    await pageLog(page);
    const full = await typeInto(run, '#t', text);
    assert.deepEqual({ ...full, ms: 0, value: full.value === text },
      { typed: chars.length, chunked: false, fallback: false, trusted, corrected: false, slips: 0, ms: 0, value: true });
    const rhythm = await keyRhythm(page);
    t.diagnostic(`${path} full: ${rhythm.downs} keys, mean interval ${rhythm.mean.toFixed(0)} ms, CV ${rhythm.cv.toFixed(2)}, `
      + `${rhythm.rollovers} rollovers, quickest keyup ${rhythm.quickestUp.toFixed(1)} ms after a keydown`);
    assert.equal(rhythm.downs, chars.length);
    assert.deepEqual(rhythm.wrongShift, []);
    assert.ok(rhythm.rollovers > 0, 'some keys go down before the previous one is up');
    assert.ok(rhythm.quickestUp >= 5, `a keyup ${rhythm.quickestUp} ms after a keydown`);
    assert.ok(rhythm.cv > 0.25, `keydown intervals CV ${rhythm.cv}`);
    if (trusted) assert.ok(rhythm.entries.every(entry => entry[4]), 'every key event trusted');
    // In part: the default budget, the rest in one insertion; a second fill replaces (select-all) the first.
    await run('__faiInput.configure({ typeBudgetMs: 1000, maxTyped: 40 }); true');
    const part = await typeInto(run, '#t', TRICKY);
    assert.equal(part.chunked, true);
    assert.ok(part.typed >= 3 && part.typed < 40, `typed ${part.typed}`);
    assert.equal(part.value, TRICKY);
    const line = TRICKY.split('\n')[1];
    assert.equal((await typeInto(run, '#i', line)).value, line);
    for (const secret of ['Tr0ub4dor&3!', 'pässwörd 🎉 2', 'aB']) {
      const typed = await typeInto(run, '#p', secret, { secret: true });
      assert.equal(typed.value, secret);
      assert.equal(typed.fallback, false);
      assert.equal(typed.corrected, false);
    }
  });

  test(`value matrix (${path}): ZWJ sequences, flags, combining marks, ligatures, mixed case, one character, empty; over old values; as secrets`, async t => {
    const { page, run } = await openRhythm(t, path);
    const values = ['👨‍👩‍👧‍👦 fam', '🇳🇴🇸🇪 flags', 'é café ñ', 'é combining', 'Ǆ ÀÉÎ ﬁ ß ẞ', 'aAaA;:1!', 'x', ''];
    for (const secret of [false, true]) {
      for (const value of values) {
        for (const selector of ['#t', '#i']) {
          await page.evaluate(sel => { document.querySelector(sel).value = 'old value'; }, selector);
          const typed = await typeInto(run, selector, value, { secret });
          assert.equal(typed.value, value, `${selector} ${JSON.stringify(value)} secret ${secret}`);
          assert.equal(typed.fallback, false);
        }
      }
    }
  });

  test(`newlines (${path}): a single-line input never gets Enter from a fill; page.js refuses it, a textarea takes it`, async t => {
    const { page, run } = await openRhythm(t, path);
    await pageLog(page);
    const typed = await typeInto(run, '#q', 'abc\ndef\r\nghi');
    assert.equal(typed.value, 'abcdefghi');
    assert.equal(await page.evaluate(() => window.submits), 0);
    assert.ok(!(await pageLog(page)).some(([type, key]) => type === 'keydown' && key === 'Enter'), 'no Enter pressed');
    const refused = await actOnField(run, 'Query', { type: 'fill_supplied_text', text: 'search\n' });
    assert.match(refused.error, /^line_break_input: Newlines can't be typed into a single-line field; use submit_field to submit/);
    assert.equal(await page.evaluate(() => window.submits), 0);
    const notes = await actOnField(run, 'Notes', { type: 'fill_supplied_text', text: 'line one\r\nline two' });
    assert.equal(notes.error, undefined);
    assert.equal(await page.inputValue('#t'), 'line one\nline two');
  });

  test(`limits (${path}): maxlength cuts by code point; slow key handlers stop the keys and the rest goes in; a formatter's output stands`, async t => {
    const { page, run } = await openRhythm(t, path);
    // As a keyboard: the emoji does not fit the one unit left, the next letter does; never half an emoji.
    const cut = await typeInto(run, '#m', 'abcd🎉xy');
    assert.equal(cut.value, 'abcdx');
    assert.ok(!/[\uD800-\uDFFF]/.test(cut.value), 'no lone surrogate');
    const slow = await typeInto(run, '#slow', 'the quick brown fox');
    t.diagnostic(`${path} slow page: ${slow.ms} ms, ${slow.typed} keys planned`);
    assert.equal(slow.value, 'the quick brown fox');
    assert.ok(slow.ms < 2600, `slow fill took ${slow.ms} ms`);
    // A formatter's output holds the value: no select-all and whole-value paste after the keys.
    await pageLog(page);
    const phone = await typeInto(run, '#ph', '1234567890');
    assert.equal(phone.corrected, false);
    assert.equal(phone.value, '123 456 789 0');
    const after = await pageLog(page);
    assert.ok(!after.some(([type, key]) => type === 'keydown' && (key === 'Control' || key === 'Meta')), 'no Ctrl+A');
    assert.equal(after.filter(([type]) => type === 'keydown').length, 10, 'one key per digit and nothing else');
    // Through page.js the digits count as kept.
    const reported = await actOnField(run, 'Phone', { type: 'fill_supplied_text', text: '5551234567' });
    assert.deepEqual(reported.fill, { kept: true, empty: false });
  });

  test(`clearing and read-back (${path}): an empty value clears the field and is kept; a field that adds to the value is not`, async t => {
    const { page, run } = await openRhythm(t, path);
    await page.evaluate(() => { document.getElementById('i').value = 'old value'; });
    const cleared = await typeInto(run, '#i', '');
    assert.equal(cleared.value, '');
    assert.equal(cleared.corrected, false);
    await page.evaluate(() => { document.getElementById('i').value = 'old value'; });
    const reported = await actOnField(run, 'Name', { type: 'fill_supplied_text', text: '' });
    assert.equal(reported.error, undefined);
    assert.equal(await page.inputValue('#i'), '');
    assert.deepEqual(reported.fill, { kept: true, empty: true });
    // A field that adds a prefix keeps the value (a formatter); one that shows it twice does not.
    const prefixed = await actOnField(run, 'Prefixed', { type: 'fill_supplied_text', text: 'abc' });
    assert.equal(await page.inputValue('#pre'), '#abc');
    assert.deepEqual(prefixed.fill, { kept: true, empty: false });
    const doubled = await actOnField(run, 'Doubled', { type: 'fill_supplied_text', text: 'abc' });
    assert.equal(await page.inputValue('#dbl'), 'abc abc');
    assert.deepEqual(doubled.fill, { kept: false, empty: false, corrected: true }, 'the value twice: residue, corrected once, still not kept');
  });

  test(`formatted and completing fields (${path}): kept as the page shows them, a combobox never corrected, Ctrl+A blocked still replaces`, async t => {
    const { page, run, cdp } = await open(t, FORMAT_PAGE);
    if (path === 'trusted') await wireTrusted(run, cdp);
    // A combobox that completes "Oslo" inline and keeps Ctrl+A for itself: no correction, and a second and third fill
    // replace the value instead of adding to it.
    const first = await typeInto(run, '#cb', 'Oslo');
    assert.equal(first.value, 'Oslo (OSL)');
    assert.equal(first.corrected, false);
    for (let k = 0; k < 2; k++) {
      const again = await actOnField(run, 'From', { type: 'fill_supplied_text', text: 'Oslo' });
      assert.equal(await page.inputValue('#cb'), 'Oslo (OSL)');
      assert.deepEqual(again.fill, { kept: true, empty: false });
    }
    // Formatters: the page's output is kept; only the currency one, whose caret jumps scramble keyed digits, needs a
    // correction (residue), and ends as the page formats the value.
    for (const [label, selector, text, shown] of [
      ['Amount', '#cur', '1500', '$1,500.00'], ['Country phone', '#cc', '5551234567', '+1 5551234567'],
      ['Code', '#up', 'abc123', 'ABC123'],
    ]) {
      const filled = await actOnField(run, label, { type: 'fill_supplied_text', text });
      assert.equal(await page.inputValue(selector), shown, label);
      assert.equal(filled.fill.kept, true, `${label}: ${JSON.stringify(filled.fill)}`);
      if (label !== 'Amount') assert.equal(filled.fill.corrected, undefined, `${label} needed no correction`);
    }
    // An IBAN is a payment field page.js keeps fills out of; typed straight in, its formatted value needs no correction.
    const iban = await typeInto(run, '#iban', 'NO93 8601 1117 947');
    assert.equal(iban.value, 'NO9386011117947');
    assert.equal(iban.corrected, false);
    // Ctrl+A cancelled by the page, old text in the field: the value is selected directly and replaced.
    const replaced = await actOnField(run, 'NoSelectAll', { type: 'fill_supplied_text', text: 'new text' });
    assert.equal(await page.inputValue('#noa'), 'new text');
    assert.deepEqual(replaced.fill, { kept: true, empty: false });
  });

  test(`slips (${path}): a neighbouring key, Backspace and the right key as a keyboard sends them; exact afterwards; none in a secret`, async t => {
    const { page, run } = await openRhythm(t, path);
    await run('__faiInput.configure({ typeBudgetMs: 60000, maxTyped: 1000, keySeed: 5, slipRate: 1 }); true');
    await pageLog(page);
    const text = 'reservations for tonight';
    const typed = await typeInto(run, '#t', text);
    assert.equal(typed.value, text);
    assert.equal(typed.corrected, false);
    assert.ok(typed.slips >= 1, `slips ${typed.slips}`);
    const log = await pageLog(page);
    const backs = log.map((entry, k) => [entry, k]).filter(([[type, key]]) => type === 'keydown' && key === 'Backspace');
    assert.ok(backs.length >= typed.slips);
    for (const [, k] of backs) {
      // Backspace's keydown, then its beforeinput and input (deleteContentBackward), then its keyup before the next key.
      const after = log.slice(k + 1, k + 4).map(([type, what]) => `${type}:${what}`);
      assert.deepEqual(after.slice(0, 2), ['beforeinput:deleteContentBackward', 'input:deleteContentBackward']);
      const nextDown = log.findIndex((entry, j) => j > k && entry[0] === 'keydown');
      const up = log.findIndex((entry, j) => j > k && entry[0] === 'keyup' && entry[1] === 'Backspace');
      assert.ok(up > k && (nextDown === -1 || up < nextDown), 'Backspace is up before the next key goes down');
    }
    if (path === 'trusted') assert.ok(log.every(entry => entry[4]), 'every event trusted');
    // Random values, slips forced: always the exact value, never a correction needed.
    const random = (() => { let a = 99; return () => ((a = (a * 1103515245 + 12345) % 2147483648) / 2147483648); })();
    const letters = 'asdfghjkl qwertyuiop zxcvbnm ASDF, .;!?';
    for (let k = 0; k < 12; k++) {
      const value = Array.from({ length: 8 + Math.floor(random() * 20) }, () => letters[Math.floor(random() * letters.length)]).join('');
      const r = await typeInto(run, '#t', value);
      assert.equal(r.value, value, JSON.stringify(value));
      assert.equal(r.corrected, false);
    }
    // A secret: no slips, no Backspace.
    await pageLog(page);
    const secret = await typeInto(run, '#p', 'abcdefghijklmnop', { secret: true });
    assert.equal(secret.value, 'abcdefghijklmnop');
    assert.equal(secret.slips, 0);
    assert.ok(!(await pageLog(page)).some(([type, key]) => key === 'Backspace'));
    // A page that eats the Backspace: the wrong key stays, and the read-back corrects it to the exact value.
    const eaten = await typeInto(run, '#eat', 'reservations');
    assert.equal(eaten.value, 'reservations');
    assert.equal(eaten.corrected, true);
  });
}
