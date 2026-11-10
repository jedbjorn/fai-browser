// Headless end-to-end check of the extension and companion over the v3 WebSocket transport, with per-stage timings.
// Run: node scripts/browser-smoke.mjs   (PLAYWRIGHT_MODULE and CHROMIUM_PATH override the defaults)
//
// Headless action.openPopup does not grant activeTab, so a temporary test-only manifest grants <all_urls> to
// exercise capture; the shipped manifest remains activeTab plus the companion origin. A second, short browser
// run loads the shipped manifest unchanged to prove the WebSocket needs no extra host permission.
// Sections: the harness companion (bench/companion.js; the session starts with the worker's start message, as the
// removed Phase 1 button did), then a daemon-mode hub with a pending tab request approved by clicking the popup card.
import assert from 'node:assert/strict';
import { headlessEnv } from './headless-env.mjs';
import http from 'node:http';
import { mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createHub } from '../src/bridge.js';
import { createCompanion } from '../bench/companion.js';
import { BrowserRuntime } from '../src/runtime.js';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const root = resolve(import.meta.dirname, '..');
const scratch = await mkdtemp(join(tmpdir(), 'fai-smoke-'));
const extension = join(scratch, 'extension');
await cp(join(root, 'extension'), extension, { recursive: true });
const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['<all_urls>'];
await writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest));

const FIXTURES = ['index.html', 'about.html', 'child.html', 'blocks.html'];
// About 3000 elements (headings, paragraphs with links, lists, table rows) for the observe cost check.
const LARGE_PAGE = (() => {
  let body = '<nav><a href="/index.html">Home</a><a href="/about.html">About</a></nav>';
  for (let i = 0; i < 230; i++) {
    body += `<section><h2>Section ${i}</h2><p>Paragraph ${i} with <a href="/about.html">a link</a> and <b>bold</b>.</p>`
      + `<ul><li>First ${i}</li><li>Second ${i}</li></ul><table><tr><td>c${i}</td><td>d${i}</td></tr></table>`
      + `<div><span>span ${i}</span></div></section>`;
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>Large</title></head><body>${body}</body></html>`;
})();
const site = http.createServer(async (req, res) => {
  try {
    const name = req.url === '/' ? 'index.html' : req.url.slice(1);
    if (name === 'large.html') {
      res.setHeader('Content-Type', 'text/html');
      return res.end(LARGE_PAGE);
    }
    if (!FIXTURES.includes(name)) {
      res.writeHead(404);
      return res.end();
    }
    res.setHeader('Content-Type', 'text/html');
    res.end(await readFile(join(root, 'fixtures', name)));
  } catch {
    res.writeHead(500);
    res.end();
  }
});
await new Promise(done => site.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${site.address().port}`;

const sleep = ms => new Promise(done => setTimeout(done, ms));
const checks = [];
const timings = { observeMs: [], largeObserveMs: [], daemonObserveMs: [], executeToObservationMs: {}, screenshotAfterObservationMs: [], settle: [], screenshot: [] };
let context;
let companion;
let hubServer;
let shippedContext;
let shippedCompanion;

// Expects a BridgeError with the given code.
async function rejectsWithCode(promise, code) {
  await assert.rejects(promise, error => {
    assert.equal(error.name, 'BridgeError', error.stack);
    assert.equal(error.code, code, error.message);
    return true;
  });
}

try {
  context = await chromium.launchPersistentContext(join(scratch, 'profile'), {
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    headless: true, env: headlessEnv(),
    args: ['--no-sandbox', '--ozone-platform=x11', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  let worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');

  const extensionId = await worker.evaluate(() => chrome.runtime.id);
  const secret = 'disposable-fixture-pairing-token-123456789';
  companion = createCompanion({ port: 0, extensionId, secret, allowedOrigins: [origin] });
  const address = await companion.listen();
  const endpoint = `http://127.0.0.1:${address.port}`;
  const page = context.pages()[0];
  await page.goto(origin);
  await page.bringToFront();
  const cdp = await context.browser().newBrowserCDPSession();
  let commandId = 0;

  // Timed wrappers around the bridge.
  async function observe() {
    const started = performance.now();
    const observation = await companion.bridge.observe();
    timings.observeMs.push(performance.now() - started);
    return observation;
  }
  async function execute(action, revision, options) {
    const started = performance.now();
    const result = await companion.bridge.execute(action, revision, options);
    const observed = performance.now();
    (timings.executeToObservationMs[action.type] ??= []).push(observed - started);
    timings.settle.push(`${action.type}:${result.settle.reason}:${result.settle.ms}ms`);
    result.screenshot = result.screenshot.then(shot => {
      if (shot && !shot.error) {
        timings.screenshotAfterObservationMs.push(performance.now() - observed);
        timings.screenshot.push({ ms: shot.ms, ...shot.timings, width: shot.width, height: shot.height });
      }
      return shot;
    });
    return result;
  }

  const popupTargets = async () => (await cdp.send('Target.getTargets')).targetInfos
    .filter(target => target.url === `chrome-extension://${extensionId}/popup.html`);
  async function waitPopupClosed() {
    const deadline = Date.now() + 3000;
    while ((await popupTargets()).length) {
      if (Date.now() > deadline) throw new Error('Previous popup did not finish closing');
      await sleep(50);
    }
  }
  async function openPopup() {
    // Native popup teardown is asynchronous even after window.close() returns.
    await waitPopupClosed();
    const deadline = Date.now() + 3000;
    let target;
    let lastOpenError;
    while (!target && Date.now() < deadline) {
      try {
        await worker.evaluate(async () => {
          const [tab] = (await chrome.tabs.query({ active: true, lastFocusedWindow: true, windowType: "normal" })).concat(await chrome.tabs.query({ active: true, windowType: "normal" }));
          if (!tab) throw new Error('No active browser tab');
          await chrome.action.openPopup({ windowId: tab.windowId });
        });
      } catch (error) {
        if (!error.message.includes('Failed to open popup')) throw error;
        lastOpenError = error;
      }
      target = (await popupTargets())[0];
      if (!target) await sleep(100);
    }
    assert.ok(target, `Popup did not open within three seconds${lastOpenError ? ': ' + lastOpenError.message : ''}`);
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: false });
    async function evaluate(expression) {
      const id = ++commandId;
      let timer;
      let listener;
      const result = new Promise((done, fail) => {
        timer = setTimeout(() => {
          cdp.off('Target.receivedMessageFromTarget', listener);
          fail(new Error('Popup CDP timeout'));
        }, 5000);
        listener = event => {
          if (event.sessionId !== sessionId) return;
          const message = JSON.parse(event.message);
          if (message.id !== id) return;
          clearTimeout(timer);
          cdp.off('Target.receivedMessageFromTarget', listener);
          const exception = message.result?.exceptionDetails;
          if (message.error) fail(new Error(message.error.message));
          else if (exception) fail(new Error(exception.exception?.description || exception.text));
          else done(message.result.result);
        };
        cdp.on('Target.receivedMessageFromTarget', listener);
      });
      try {
        const params = { expression, awaitPromise: true, returnByValue: true };
        await cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method: 'Runtime.evaluate', params }) });
      } catch (error) {
        clearTimeout(timer);
        cdp.off('Target.receivedMessageFromTarget', listener);
        throw error;
      }
      return result;
    }
    await evaluate(`(async () => {
      for (let i = 0; i < 100 && !document.body.dataset.ready; i++) await new Promise(r => setTimeout(r, 20));
      if (!document.body.dataset.ready) throw new Error('Popup did not initialize');
    })()`);
    return evaluate;
  }
  // The popup's showState() labels. Opening the popup sends its own `connect` message, and that reply
  // (up to ~1 s later when the worker is disconnected) rewrites #status with one of these idle labels. It can
  // land after the script clears #status and clicks, so these are transient, never the clicked action's result.
  const POPUP_STATE_TEXT = [
    "The agent is using its tab. Close that tab's window or press Stop to end it.",
    'Paused. The agent asks again when it needs the tab.',
    'Stopped',
    'Waiting for an agent request. Its page opens in a new window.',
    'Reconnect required',
    'Not connected to the FAI service. Retrying.',
  ];
  // Clears #status, runs `trigger` and waits for the status the triggered action produced. A label that only
  // the stale connect reply could have written is skipped; any other unexpected text fails immediately.
  async function popupAction(evaluate, trigger, { action, accept, ms = 6000 }) {
    await evaluate(`document.querySelector('#status').textContent = ''; ${trigger}`);
    const deadline = Date.now() + ms;
    let status;
    while (Date.now() < deadline) {
      status = (await evaluate("document.querySelector('#status').textContent")).value;
      if (accept(status)) return status;
      if (status && !POPUP_STATE_TEXT.includes(status)) throw new Error(`Popup ${action} failed: ${status}`);
      await sleep(30);
    }
    throw new Error(`Popup ${action} did not reach its expected status within ${ms} ms (last status: ${JSON.stringify(status)})`);
  }
  // Starts (worker start message with the pairing, the harness companion has no requests) or pauses/stops (the
  // popup's own buttons) the session.
  async function popup(action = 'start', level = 'reversible') {
    const evaluate = await openPopup();
    const expected = {
      start: "The agent is using its tab. Close that tab's window or press Stop to end it.",
      pause: 'Paused. The agent asks again when it needs the tab.',
      stop: 'Stopped',
    }[action];
    const trigger = action === 'start'
      ? `chrome.runtime.sendMessage({ type: 'start', level: ${JSON.stringify(level)}, endpoint: ${JSON.stringify(endpoint)},
          secret: ${JSON.stringify(secret)} }).then(reply => {
          document.querySelector('#status').textContent = reply?.error ?? ${JSON.stringify(expected)};
        })`
      : `document.querySelector('#${action}').click()`;
    await popupAction(evaluate, trigger, { action, accept: status => status === expected });
    await evaluate('window.close()');
    await waitPopupClosed();
  }

  // --- pairing fields --------------------------------------------------------------------------------------
  // The address persists as typed; a typed secret is saved on change and never shown back.
  const draftEndpoint = 'http://127.0.0.1:1';
  const draftSecret = 'draft-pairing-value-123456789';
  let popupEvaluate = await openPopup();
  await popupEvaluate(`document.querySelector('#endpoint').value = ${JSON.stringify(draftEndpoint)};
    document.querySelector('#endpoint').dispatchEvent(new Event('input', {bubbles: true}));
    document.querySelector('#secret').value = ${JSON.stringify(draftSecret)};
    document.querySelector('#secret').dispatchEvent(new Event('change', {bubbles: true}));`);
  await until(async () => (await worker.evaluate(() => chrome.storage.local.get('secret'))).secret === draftSecret,
    'the typed pairing secret was not saved');
  await popupEvaluate('window.close()');
  await waitPopupClosed();
  popupEvaluate = await openPopup();
  const restored = await popupEvaluate("({endpoint: document.querySelector('#endpoint').value, "
    + "secret: document.querySelector('#secret').value, secretType: document.querySelector('#secret').type})");
  assert.deepEqual(restored.value, { endpoint: draftEndpoint, secret: '', secretType: 'password' });
  await popupEvaluate('window.close()');
  await waitPopupClosed();
  checks.push('pairing address persists; a typed secret is saved, masked and never shown back');

  // --- lease and long-poll ---------------------------------------------------------------------------------
  const leaseSeen = companion.waitForLease({ timeoutMs: 10_000 });
  await popup('start', 'reversible');
  assert.equal((await leaseSeen).status, 'active');
  assert.equal(companion.status().status, 'active');
  assert.equal(companion.status().level, 'reversible', 'the start message grants its level');
  popupEvaluate = await openPopup();
  const controls = await popupEvaluate(`({start: document.querySelector('#start'),
    pause: document.querySelector('#pause').hidden, stop: document.querySelector('#stop').hidden,
    settings: document.querySelector('#advanced').open})`);
  assert.deepEqual(controls.value, { start: null, pause: false, stop: false, settings: false });
  await popupEvaluate('window.close()');
  await waitPopupClosed();
  for (let i = 0; i < 40 && companion.status().transport !== 'websocket'; i++) await sleep(25);
  assert.equal(companion.status().transport, 'websocket', 'extension should be connected over the WebSocket');
  assert.equal(companion.status().polling, true);
  checks.push('selected-tab lease, waitForLease, Pause/Stop controls, no Phase 1 start button, authenticated WebSocket push');

  // --- actions ---------------------------------------------------------------------------------------------
  let observation = await observe();
  assert.equal(observation.url, origin + '/');
  assert.equal(typeof observation.textTruncated, 'boolean');
  assert.doesNotMatch(observation.text, /FAI fixture/, 'title must not be part of page text');
  const find = label => observation.controls.find(control => control.label === label);

  const plan = find('Plan');
  let result = await execute({ type: 'select', target: plan.id, value: 'pro' }, observation.revision);
  assert.equal(result.observation.controls.find(c => c.id === plan.id).selectedValue, 'pro');
  assert.ok(['quiet', 'cap'].includes(result.settle.reason));
  const shot = await result.screenshot;
  assert.equal(shot.revision, result.observation.revision, JSON.stringify(shot.error));
  assert.equal(shot.format, 'jpeg');
  assert.ok(shot.dataUrl.startsWith('data:image/jpeg;base64,'));
  assert.ok(shot.width <= 1280);
  await writeFile(join(scratch, 'annotated.jpg'), Buffer.from(shot.dataUrl.split(',')[1], 'base64'));
  checks.push('select + async annotated JPEG screenshot with matched revision');

  observation = result.observation;
  result = await execute({ type: 'click', target: find('Show plan').id }, observation.revision);
  assert.match(result.observation.text, /Selected plan: pro/);
  await result.screenshot;
  checks.push('reversible form button outcome');

  // Role mapping, risk classes and semantic revision, on controls added to the fixture page.
  await page.evaluate(() => {
    document.body.insertAdjacentHTML('afterbegin', `
      <div id="extra">
        <label><input type="checkbox" id="agree"> Agree</label>
        <input type="button" value="Toggle panel">
        <a href="/about.html">Savings and Payments</a>
        <button type="button">Delete account</button>
        <span id="spinner" class="a">*</span>
        <span aria-live="polite" id="live">tick 0</span>
      </div>`);
  });
  observation = await observe();
  const checkbox = find('Agree');
  assert.equal(checkbox.role, 'checkbox');
  assert.equal(checkbox.checked, false);
  assert.equal(find('Toggle panel').role, 'button');
  assert.equal(find('Savings and Payments').risk, 'navigation');
  assert.equal(find('Delete account').risk, 'delete'); // the risk class (delete needs Full)
  await page.evaluate(() => {
    document.querySelector('#spinner').className = 'b';
    document.querySelector('#live').textContent = 'tick 1';
  });
  assert.equal((await observe()).revision, observation.revision, 'attribute and live-region churn keep the revision');
  result = await execute({ type: 'click', target: checkbox.id }, observation.revision, { capture: false });
  assert.equal(result.observation.controls.find(c => c.label === 'Agree').checked, true);
  assert.equal(await result.screenshot, null);
  observation = result.observation;
  await rejectsWithCode(execute({ type: 'click', target: find('Delete account').id }, observation.revision), 'blocked_risky');
  result = await execute({ type: 'scroll', direction: 'down' }, observation.revision, { capture: false });
  assert.ok(['quiet', 'cap'].includes(result.settle.reason));
  result = await execute({ type: 'wait' }, result.observation.revision, { capture: false });
  assert.equal(result.settle.reason, 'none');
  await page.evaluate(() => {
    document.querySelector('#extra').remove();
    scrollTo(0, 0);
  });
  checks.push('checkbox/input-button roles, anchored destructive class, semantic revision, scroll/wait settle');

  observation = await observe();
  const staleTarget = find('Dynamic target');
  await page.evaluate(() => document.querySelector('#target').replaceWith(document.querySelector('#target').cloneNode(true)));
  await rejectsWithCode(execute({ type: 'click', target: staleTarget.id }, observation.revision), 'stale');
  assert.equal(companion.status().status, 'active', 'a stale revision must not pause the lease');
  checks.push('identical replacement target rejected as recoverable stale; lease stays active');

  observation = await observe();
  result = await execute({ type: 'click', target: find('About project').id }, observation.revision);
  assert.equal(result.observation.url, origin + '/about.html');
  assert.equal(result.settle.reason, 'load_complete');
  assert.match(result.observation.text, /Ada, Grace, Linus/);
  assert.equal((await result.screenshot).revision, result.observation.revision);
  checks.push('same-origin navigation settles on load_complete + post-navigation evidence');

  observation = result.observation;
  result = await execute({ type: 'navigate_allowed_url', url: origin + '/' }, observation.revision, { capture: false });
  assert.equal(result.observation.url, origin + '/');
  assert.equal(result.settle.reason, 'load_complete');
  checks.push('navigate_allowed_url');

  // --- structured page content (blocks) ---------------------------------------------------------------------
  await page.goto(origin + '/blocks.html');
  observation = await observe();
  const { blocks } = observation;
  assert.ok(Array.isArray(blocks) && blocks.length > 0, 'observation carries blocks');
  assert.equal(observation.blocksTruncated, false);
  const block = (t, text) => blocks.find(b => b.t === t && b.text === text);
  assert.equal(block('a', 'Home')?.ref, find('Home').id, 'navigation links are their own blocks with a ref');
  assert.ok(block('h1', 'Team handbook'));
  assert.equal(block('p', 'Read the member list before the meeting.')?.ref, find('member list').id);
  assert.ok(block('alert', 'Two seats left'));
  assert.ok(block('li', 'Install node 22'));
  assert.ok(block('tr', 'Ada | Engineer'));
  assert.ok(block('dt', 'Room'));
  assert.equal(block('label', 'Plan')?.ref, find('Plan').id, 'a for= label refers to its control');
  assert.equal(block('button', 'Show plan')?.ref, find('Show plan').id);
  assert.ok(!blocks.some(b => /Hidden|Undisplayed|Decorative/.test(b.text)), 'hidden blocks are skipped');
  assert.equal(block('p', 'Below the fold')?.offscreen, true);
  assert.ok(blocks.findIndex(b => b.offscreen) > blocks.findLastIndex(b => !b.offscreen), 'visible blocks first');
  checks.push('blocks: headings, paragraph, alert, list, table rows, term, labels with refs, hidden skipped, offscreen last');

  // Observe cost on a ~3000-element page: round trip through the extension (with blocks), plus the in-page
  // observe with and without blocks, measured by a main-world copy of page.js on the same page.
  await page.goto(origin + '/large.html');
  for (let i = 0; i < 15; i++) observation = await (async () => {
    const started = performance.now();
    const seen = await companion.bridge.observe();
    timings.largeObserveMs.push(performance.now() - started);
    return seen;
  })();
  assert.equal(observation.blocks.length, 200);
  assert.equal(observation.blocksTruncated, true);
  await page.addScriptTag({ path: join(root, 'extension', 'page.js') });
  timings.largeInPage = await page.evaluate(() => {
    const measure = options => {
      const times = [];
      for (let i = 0; i < 30; i++) {
        const started = performance.now();
        globalThis.__faiPage.observe(options);
        times.push(performance.now() - started);
      }
      times.sort((a, b) => a - b);
      return { p50: +times[15].toFixed(1), max: +times[29].toFixed(1) };
    };
    return {
      elements: document.getElementsByTagName('*').length,
      withoutBlocksMs: measure({ blocks: false }),
      withBlocksMs: measure({}),
    };
  });
  checks.push(`blocks on a ${timings.largeInPage.elements}-element page: 200 blocks, blocksTruncated`);

  await page.goto(origin);
  const runtime = new BrowserRuntime({ bridge: companion.bridge });
  // The host-driven loop: observe, then act on the offered "About project" link with an expectation to verify.
  const aboutOn = offered => offered.actions.find(action => action.type === 'click' && JSON.stringify(action).includes('About project'));
  let offered = await runtime.observe({ allowedOrigins: [origin] });
  const run = await runtime.act(aboutOn(offered).id, { expectation: { textIncludes: 'Ada, Grace, Linus' } });
  assert.equal(run.status, 'completed', run.reason);
  assert.equal(run.verification.passed, true);
  assert.equal(run.steps.length, 1);
  checks.push('agent-facing runtime observe + act + independent outcome verification');

  await page.goto(origin);
  offered = await runtime.observe({ allowedOrigins: [origin] });
  const lastOnly = await runtime.act(aboutOn(offered).id, { expectation: { textIncludes: 'Ada, Grace, Linus' }, capture: 'last' });
  assert.equal(lastOnly.status, 'completed', lastOnly.reason);
  const finalStep = lastOnly.steps.at(-1);
  assert.equal(finalStep.screenshot?.revision, finalStep.observation.revision, JSON.stringify(finalStep.captureError));
  assert.ok(finalStep.screenshot.dataUrl.startsWith('data:image/jpeg;base64,'));
  checks.push('capture last: the act captured on demand with matching revision');

  await page.goto(origin);
  observation = await observe();
  await rejectsWithCode(execute({ type: 'click', target: find('External site').id }, observation.revision), 'cross_origin');
  assert.equal(page.url(), origin + '/');
  assert.equal(companion.status().status, 'active');
  checks.push('cross-origin destination rejected before action; lease stays active');

  const pagesBefore = context.pages().length;
  await rejectsWithCode(execute({ type: 'click', target: find('Documentation child tab').id }, observation.revision), 'child_tab');
  await sleep(200);
  assert.equal(context.pages().length, pagesBefore, 'blocked child-tab link must not open a tab');
  assert.equal(companion.status().status, 'active');
  checks.push('same-origin target=_blank link blocked as child_tab without opening a tab');

  // A child tab opened outside the bridge (here a trusted user click) still ends the session.
  await page.click('text=Documentation child tab');
  for (let i = 0; i < 40 && companion.status().status === 'active'; i++) await sleep(50);
  assert.equal(companion.status().status, 'paused');
  await rejectsWithCode(observe(), 'child_tab');
  let child;
  for (let i = 0; i < 30 && !child; i++) {
    child = context.pages().find(p => p.url() === origin + '/child.html');
    if (!child) await sleep(50);
  }
  assert.ok(child);
  await child.close();
  await page.bringToFront();
  checks.push('page-opened child tab pauses the lease with child_tab');

  await popup();
  await popup('pause');
  assert.equal(companion.status().status, 'paused');
  await rejectsWithCode(observe(), 'paused');
  await popup();
  await popup('stop');
  assert.equal(companion.status().status, 'stopped');
  await rejectsWithCode(observe(), 'stopped');
  checks.push('visible pause and stop map to paused/stopped codes');

  // Encoder comparison in the offscreen document (convertToBlob vs DOM canvas toDataURL).
  const encoders = await worker.evaluate(async () => {
    if (!await chrome.offscreen.hasDocument()) {
      await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['BLOBS'], justification: 'smoke' });
    }
    const canvas = new OffscreenCanvas(1280, 800);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#3a6';
    ctx.fillRect(0, 0, 1280, 800);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 });
    const dataUrl = await new Promise(done => {
      const reader = new FileReader();
      reader.onload = () => done(reader.result);
      reader.readAsDataURL(blob);
    });
    const observation = { revision: 'x:1', url: 'http://x/', viewport: { width: 1280, height: 800 }, controls: [] };
    const out = {};
    for (const encoder of ['offscreen', 'dom', 'offscreen', 'dom', 'offscreen', 'dom']) {
      const reply = await chrome.runtime.sendMessage({ type: 'annotate', dataUrl, observation, action: { type: 'wait' }, encoder });
      (out[encoder] ??= []).push(reply.timings.encodeMs);
    }
    return out;
  });
  checks.push('offscreen encoder comparison recorded');

  // --- daemon mode: pending tab request approved in the popup ----------------------------------------------
  // A minimal stand-in for the daemon's request manager drives a real hub in daemon mode.
  const hub = createHub({ secret, extensionId, mode: 'daemon' });
  hubServer = http.createServer((req, res) => {
    if (hub.handleHttp(req, res)) return;
    res.writeHead(404);
    res.end();
  });
  hubServer.on('upgrade', (req, socket, head) => {
    if (!hub.handleUpgrade(req, socket, head)) socket.destroy();
  });
  await new Promise(done => hubServer.listen(0, '127.0.0.1', done));
  const hubEndpoint = `http://127.0.0.1:${hubServer.address().port}`;
  const tabRequests = new Map();
  const publish = () => hub.publishRequests([...tabRequests.values()]
    .filter(request => ['pending', 'active', 'paused'].includes(request.state))
    .map(({ lease, ...view }) => view));
  const addRequest = (requestId, origins, reason) => {
    tabRequests.set(requestId, {
      requestId, state: 'pending', origins, mode: 'full', reason, instruction: 'Open About project',
      client: 'browser-smoke', createdAt: new Date().toISOString(), lease: null,
    });
    publish();
  };
  hub.onEvent(event => {
    if (event.type === 'hello') {
      const known = [...tabRequests.values()].some(request => request.lease === event.session?.leaseId);
      event.reply({ mode: 'daemon', daemonVersion: 'smoke', endSession: Boolean(event.session) && !known });
    } else if (event.type === 'lease') {
      const request = tabRequests.get(event.requestId);
      if (!request) return event.reply({ error: { code: 'no_request', message: 'Unknown request' } });
      if (!['pending', 'paused'].includes(request.state)) {
        return event.reply({ error: { code: 'request_not_pending', message: 'Request is not pending' } });
      }
      if (!request.origins.includes(event.origin)) {
        return event.reply({ error: { code: 'origin_not_requested', message: 'Origin not requested', origins: request.origins } });
      }
      const leaseId = randomBytes(8).toString('hex');
      hub.bindLease({ leaseId, requestId: request.requestId, tabId: event.tabId, origin: event.origin, allowedOrigins: request.origins, level: event.level ?? undefined });
      Object.assign(request, { state: 'active', lease: leaseId, granted: event.level });
      publish();
      event.reply({ leaseId, requestId: request.requestId });
    } else if (event.type === 'deny') {
      const request = tabRequests.get(event.requestId);
      if (request) request.state = 'denied';
      publish();
      event.reply({ ok: true });
    } else if (event.type === 'status') {
      const request = tabRequests.get(event.requestId);
      if (request) request.state = event.status === 'stopped' ? 'released' : 'paused';
      publish();
    }
  });
  const badge = () => worker.evaluate(() => chrome.action.getBadgeText({}));
  async function until(predicate, message, ms = 5000) {
    const deadline = Date.now() + ms;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error(message);
      await sleep(25);
    }
  }

  await page.goto(origin);
  await page.bringToFront();
  popupEvaluate = await openPopup();
  await popupEvaluate(`for (const [id, value] of [['endpoint', ${JSON.stringify(hubEndpoint)}], ['secret', ${JSON.stringify(secret)}]]) {
      const field = document.getElementById(id);
      field.value = value;
      field.dispatchEvent(new Event('input', {bubbles: true}));
      field.dispatchEvent(new Event('change', {bubbles: true}));
    }`);
  await popupEvaluate('window.close()');
  await waitPopupClosed();
  await until(() => hub.extension().transport === 'websocket', 'worker did not reconnect to the daemon hub after a pairing change');
  checks.push('pairing change reconnects the worker; it stays connected over the WebSocket with no session');

  addRequest('req_smoke_1', [origin], 'Check the About page for the smoke test');
  addRequest('req_smoke_other', ['https://elsewhere.example'], 'A request for a different site');
  await until(async () => (await badge()) === '?', 'badge did not show ? for a pending request');
  popupEvaluate = await openPopup();
  await popupEvaluate(`(async () => {
    for (let i = 0; i < 100 && !document.querySelector('#approve'); i++) await new Promise(r => setTimeout(r, 20));
  })()`);
  const cards = (await popupEvaluate(`[...document.querySelectorAll('.request-card')].map(card => ({
      id: card.dataset.requestId, text: card.textContent,
      disabled: card.querySelector('.approve-request')?.disabled,
      level: card.querySelector('.level-select')?.value,
      levels: [...(card.querySelector('.level-select')?.options ?? [])].map(option => option.value) }))`)).value;
  const mine = cards.find(card => card.id === 'req_smoke_1');
  const other = cards.find(card => card.id === 'req_smoke_other');
  assert.ok(mine && other, JSON.stringify(cards));
  assert.match(mine.text, /Agent says: Check the About page for the smoke test/);
  assert.match(mine.text, /Approve this tab/);
  assert.match(mine.text, /asks for Act/);
  // Preset to what the agent asked for (full, Act); no Test site for an unlisted origin.
  assert.equal(mine.level, 'full');
  assert.deepEqual(mine.levels, ['read-only', 'interactive', 'full']);
  assert.equal(mine.disabled, false);
  assert.equal(other.disabled, undefined, 'a request for another origin cannot be approved on this tab');
  assert.match(other.text, /the agent asked for: https:\/\/elsewhere\.example/);
  assert.match(other.text, /Open elsewhere\.example/, 'it offers to open its own page instead');
  await popupEvaluate(`(() => {
    const select = document.querySelector('[data-request-id="req_smoke_1"] .level-select');
    select.value = 'interactive';
    select.dispatchEvent(new Event('change', {bubbles: true}));
    document.querySelector('#status').textContent = '';
    document.querySelector('#approve').click();
  })()`);
  await until(() => tabRequests.get('req_smoke_1').state === 'active', 'popup approve did not reach the hub');
  await popupEvaluate('window.close()');
  await waitPopupClosed();
  const approved = tabRequests.get('req_smoke_1');
  assert.equal(approved.state, 'active');
  assert.equal(approved.granted, 'interactive', 'Approve sends the level chosen on the card');
  assert.equal(hub.lease(approved.lease).tabId > 0, true);
  assert.equal(hub.lease(approved.lease).level, 'interactive');
  assert.ok(['ON', '?'].includes(await badge()), 'ON, or ? while another request still waits');
  checks.push('pending request card (Agent says, asked level, levels up to the asked one preset to it, origin mismatch disabled), badge ?, popup click binds the active tab at the chosen level');

  const leased = hub.bridgeFor(approved.lease);
  for (let i = 0; i < 6; i++) {
    const started = performance.now();
    const seen = await leased.observe();
    timings.daemonObserveMs.push(performance.now() - started);
    assert.equal(seen.url, origin + '/');
  }
  const observationShot = await leased.capture({ action: null });
  assert.ok(observationShot.dataUrl?.startsWith('data:image/jpeg;base64,'), JSON.stringify(observationShot.error));
  checks.push('daemon-mode observe over the WebSocket and capture with action:null (Observation footer)');

  hub.updateLease(approved.lease, 'released', 'superseded');
  await until(async () => (await badge()) !== 'ON', 'lease_update released did not end the extension session');
  await rejectsWithCode(leased.observe(), 'stopped');
  tabRequests.get('req_smoke_1').state = 'released';
  publish();
  checks.push('lease_update released ends the extension session; later commands fail as stopped');

  // Testing mode: only for an origin listed under Testing environments, picked on the card, shown on the tab card.
  popupEvaluate = await openPopup();
  await popupEvaluate(`(() => {
    document.querySelector('#testing-origin').value = ${JSON.stringify(origin + '/path')};
    document.querySelector('#testing-add').click();
  })()`);
  assert.match((await popupEvaluate("document.querySelector('#testing-error').textContent")).value, /exact origin/,
    'a URL with a path is refused as a testing environment');
  await popupEvaluate(`(() => {
    document.querySelector('#testing-origin').value = ${JSON.stringify(origin)};
    document.querySelector('#testing-add').click();
  })()`);
  await until(async () => (await worker.evaluate(() => chrome.storage.local.get('permissions'))).permissions?.testingOrigins?.includes(origin),
    'the testing environment was not saved');
  await popupEvaluate('window.close()');
  await waitPopupClosed();
  addRequest('req_smoke_test', [origin], 'Drive the test app end to end');
  tabRequests.get('req_smoke_test').mode = 'testing';
  publish();
  popupEvaluate = await openPopup();
  await popupEvaluate(`(async () => {
    for (let i = 0; i < 100 && !document.querySelector('[data-request-id="req_smoke_test"] .level-select'); i++) await new Promise(r => setTimeout(r, 20));
  })()`);
  const testCard = (await popupEvaluate(`(() => {
    const card = document.querySelector('[data-request-id="req_smoke_test"]');
    const select = card.querySelector('.level-select');
    const levels = [...select.options].map(option => option.value);
    const preset = select.value;
    select.value = 'testing';
    select.dispatchEvent(new Event('change', {bubbles: true}));
    return { levels, preset, warning: !card.querySelector('.level-warning').hidden };
  })()`)).value;
  assert.deepEqual(testCard.levels, ['read-only', 'interactive', 'full', 'testing']);
  assert.equal(testCard.preset, 'full', 'testing is never the preset');
  assert.equal(testCard.warning, true);
  await popupEvaluate("document.querySelector('#status').textContent = ''; document.querySelector('[data-request-id=\"req_smoke_test\"] .approve-request').click()");
  await until(() => tabRequests.get('req_smoke_test').state === 'active', 'testing approval did not reach the hub');
  assert.equal(tabRequests.get('req_smoke_test').granted, 'testing');
  await until(async () => (await popupEvaluate("document.querySelector('#state-label').textContent")).value === 'TEST SITE, no guardrails',
    'the tab card does not show the testing state');
  await popupEvaluate('window.close()');
  await waitPopupClosed();
  hub.updateLease(tabRequests.get('req_smoke_test').lease, 'released', 'superseded');
  await until(async () => (await badge()) !== 'ON', 'releasing the testing lease did not end the session');
  tabRequests.get('req_smoke_test').state = 'released';
  publish();
  checks.push('testing environments: exact origin only, Testing offered only for a listed origin, approval at testing, TESTING state label');

  popupEvaluate = await openPopup();
  await popupEvaluate(`(async () => {
    for (let i = 0; i < 100 && !document.querySelector('[data-request-id="req_smoke_other"] .deny-request'); i++) {
      await new Promise(r => setTimeout(r, 20));
    }
    document.querySelector('[data-request-id="req_smoke_other"] .deny-request').click();
  })()`);
  await until(() => tabRequests.get('req_smoke_other').state === 'denied', 'deny did not reach the hub');
  await popupEvaluate('window.close()');
  await waitPopupClosed();
  await until(async () => (await badge()) === '', 'badge did not clear after the last request ended');
  checks.push('deny link reaches the hub; badge clears when no request is pending');

  // Back to the harness companion (the start message re-pairs), then restart the extension.
  await popup('start', 'reversible');
  await worker.evaluate(() => chrome.runtime.reload()).catch(() => {});
  for (let i = 0; i < 80 && companion.status().status === 'active'; i++) await sleep(100);
  assert.equal(companion.status().status, 'paused');
  // A restarted worker reports session_inactive; if Chrome does not restart it, the dropped long-poll does.
  const restartError = await observe().catch(error => error);
  assert.ok(['session_inactive', 'disconnected'].includes(restartError.code), restartError.message);
  checks.push('extension restart revokes lease and requires reconnect');

  // --- shipped manifest: the WebSocket needs no extra host permission --------------------------------------
  // The companion listens on a random port the shipped host_permissions (127.0.0.1:4318 only) do not cover.
  const shipped = join(scratch, 'extension-shipped');
  await cp(join(root, 'extension'), shipped, { recursive: true });
  shippedContext = await chromium.launchPersistentContext(join(scratch, 'profile-shipped'), {
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    headless: true, env: headlessEnv(),
    args: ['--no-sandbox', '--ozone-platform=x11', `--disable-extensions-except=${shipped}`, `--load-extension=${shipped}`],
  });
  const shippedWorker = shippedContext.serviceWorkers()[0] || await shippedContext.waitForEvent('serviceworker');
  const shippedId = await shippedWorker.evaluate(() => chrome.runtime.id);
  shippedCompanion = createCompanion({ port: 0, extensionId: shippedId, secret, allowedOrigins: [origin] });
  const shippedEndpoint = `http://127.0.0.1:${(await shippedCompanion.listen()).port}`;
  await shippedWorker.evaluate(pairing => chrome.storage.local.set(pairing), { endpoint: shippedEndpoint, secret });
  await until(() => shippedCompanion.status().transport === 'websocket',
    'shipped manifest: worker did not connect over the WebSocket');
  checks.push('shipped manifest connects over the WebSocket to a port outside host_permissions (no ws:// permission needed)');


  const summarize = values => {
    const sorted = [...values].sort((a, b) => a - b);
    const pick = q => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]);
    return sorted.length ? { n: sorted.length, p50: pick(0.5), max: pick(1) } : null;
  };
  const timingReport = {
    observeRoundTripMs: summarize(timings.observeMs),
    largePageObserve: {
      elements: timings.largeInPage?.elements,
      roundTripWithBlocksMs: summarize(timings.largeObserveMs),
      inPageWithoutBlocksMs: timings.largeInPage?.withoutBlocksMs,
      inPageWithBlocksMs: timings.largeInPage?.withBlocksMs,
    },
    daemonObserveRoundTripMs: summarize(timings.daemonObserveMs),
    executeUntilObservationMs: Object.fromEntries(
      Object.entries(timings.executeToObservationMs).map(([type, values]) => [type, summarize(values)]),
    ),
    screenshotArrivalAfterObservationMs: summarize(timings.screenshotAfterObservationMs),
    settle: timings.settle,
    screenshotBreakdown: timings.screenshot,
    encoderEncodeMs: encoders,
  };
  console.log(JSON.stringify({
    status: 'passed',
    checks,
    timings: timingReport,
    screenshot: process.env.FAI_SMOKE_KEEP_ARTIFACTS
      ? join(scratch, 'annotated.jpg')
      : 'annotated JPEG verified; disposable profile and screenshot removed',
    limitation: 'Headless test-only <all_urls> capture permission; toolbar activeTab grant requires manual browser check',
  }, null, 2));
} finally {
  await context?.close();
  await shippedContext?.close();
  await companion?.close();
  await shippedCompanion?.close();
  if (hubServer) {
    hubServer.closeAllConnections();
    await new Promise(done => hubServer.close(done));
  }
  await new Promise(done => site.close(done));
  if (!process.env.FAI_SMOKE_KEEP_ARTIFACTS) await rm(scratch, { recursive: true, force: true });
}
