// Real Chromium and the real extension worker, through the harness companion: approved cross-origin frames
// (extension/frames.js, docs/REFERENCE.md "Frames"). The top page and its frames come from separate loopback origins
// (127.0.0.1 on different ports), and the extension holds access to every site (as "Allow on all sites" gives it), so
// it could reach every one of them: only the request's origins decide which frame is read.
//
// One browser run (never two Chromiums at once), several scenarios on the leased tab:
// - an approved frame is read (text, controls f1.<id>, a redacted secret) and a click on its control runs in it;
// - a frame on an origin the request does not list is never read, and the observation names its origin;
// - a frame that navigated to such an origin between observe and act refuses the act (cross_origin);
// - nested approved frames are read with their offsets summed;
// - a sign-in form inside an approved frame raises password_field/login_wall, and its password field is boxed on the
//   screenshot.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { headlessEnv } from '../scripts/headless-env.mjs';
import { createCompanion } from '../bench/companion.js';

const ROOT = resolve(import.meta.dirname, '..');
const SECRET = 'disposable-frames-pairing-token-1234567890';
const TOKEN = 'ghp_16C7e42F292c6912E7710c838347Ae178B4a';
const sleep = ms => new Promise(done => setTimeout(done, ms));

function serve(pages) {
  const server = http.createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    const page = pages(path);
    if (page === null) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>Missing</title>missing');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><head><meta charset="utf-8">${page}</html>`);
  });
  return new Promise(done => server.listen(0, '127.0.0.1', () => done(server)));
}

// Launches Chromium with a copy of the extension whose manifest has `hostPermissions`, pairs it with a companion whose
// request lists `allowedOrigins`, opens `startUrl` and leases that tab at Use (reversible). Null when there is no Chromium.
async function launchLeased(t, { hostPermissions, allowedOrigins, startUrl }) {
  const scratch = await mkdtemp(join(tmpdir(), 'fai-frames-'));
  const cleanup = [];
  t.after(async () => {
    for (const step of cleanup.reverse()) await step().catch(() => {});
    await rm(scratch, { recursive: true, force: true });
  });
  const extension = join(scratch, 'extension');
  await cp(join(ROOT, 'extension'), extension, { recursive: true });
  const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
  manifest.host_permissions = hostPermissions;
  await writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest));
  let context;
  try {
    context = await chromium.launchPersistentContext(join(scratch, 'profile'), {
      executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
      headless: true, env: headlessEnv(), viewport: { width: 1000, height: 800 },
      args: ['--no-sandbox', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
  } catch (error) {
    t.skip(`no Chromium: ${String(error?.message ?? error).slice(0, 120)}`);
    return null;
  }
  cleanup.push(() => context.close());
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = await worker.evaluate(() => chrome.runtime.id);
  const companion = createCompanion({ port: 0, extensionId, secret: SECRET, allowedOrigins });
  const { port } = await companion.listen();
  cleanup.push(() => companion.close());
  const page = context.pages()[0];
  await page.goto(startUrl);
  await page.waitForLoadState('load');
  const leased = companion.waitForLease({ timeoutMs: 10_000 });
  const started = await worker.evaluate(async ({ endpoint, secret }) => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    try {
      await startSession({ endpoint, secret, level: 'reversible' }, tab);
      return 'ok';
    } catch (error) {
      return String(error?.message || error);
    }
  }, { endpoint: `http://127.0.0.1:${port}`, secret: SECRET });
  assert.equal(started, 'ok');
  assert.equal((await leased).status, 'active');
  return { page, companion, worker };
}

const codeOf = promise => promise.then(() => 'ok', error => String(error?.code ?? error?.message));

test('approved cross-origin frames in real Chromium: read, act, refuse, nest, protect', async t => {
  const origins = {};
  const servers = [];
  // B: the approved content frame; D: an approved frame nested in B; C: an origin the request does not list.
  const blade = await serve(path => {
    if (path === '/blade') {
      return '<title>Blade</title><body><h2>Tenant overview</h2><p>Tenant ID: 7f3a-1122</p>'
        + `<p>Deploy token: ${TOKEN}</p>`
        + '<button type="button" onclick="document.getElementById(\'s\').textContent=\'Review state: reviewed\'">Mark reviewed</button>'
        + '<p id="s">Review state: pending</p></body>';
    }
    if (path === '/plain') return '<title>Plain</title><body style="margin:0"><p>Plain approved frame</p></body>';
    if (path === '/settings') {
      return '<title>Settings</title><body style="margin:0"><p>Settings</p><input id="pw" type="password" value="hunter2-hunter2" '
        + 'style="position:absolute;left:10px;top:40px;width:200px;height:20px;border:0;padding:0"></body>';
    }
    if (path === '/outer') {
      return `<title>Outer</title><body><h2>Outer blade</h2><iframe src="${origins.nested}/inner" width="360" height="160" `
        + 'style="border:0;margin:12px"></iframe></body>';
    }
    if (path === '/signin') {
      return '<title>Sign in</title><body><h1>Sign in to the portal</h1><form><label>Email <input name="email"></label>'
        + '<label>Password <input type="password" name="pw" value="hunter2-hunter2"></label><button>Sign in</button></form></body>';
    }
    return null;
  });
  const nested = await serve(path => (path === '/inner'
    ? '<title>Inner</title><body><p>Custom domains: contoso.example</p><button type="button">Add domain</button></body>' : null));
  const other = await serve(path => (path === '/ad' || path === '/landing'
    ? '<title>Ad</title><body><p>Partner offer text</p><button type="button">Partner button</button></body>' : null));
  const top = await serve(path => {
    if (path === '/') {
      return '<title>Portal</title><body style="margin:0"><h1>Portal</h1><a href="/">Home</a>'
        + `<iframe id="blade" src="${origins.blade}/blade" width="600" height="320" style="border:0;display:block"></iframe>`
        + `<iframe id="ad" src="${origins.other}/ad" width="300" height="120" style="border:0;display:block"></iframe></body>`;
    }
    if (path === '/rotating') {
      // An ad first, two approved frames, an unread tail: removing the ad shifts every later frame's window index down.
      return '<title>Rotating</title><body style="margin:0">'
        + `<iframe id="ad" src="${origins.other}/ad" width="600" height="50" style="border:0;display:block"></iframe>`
        + '<h1 style="margin:0;height:40px">Portal</h1>'
        + `<iframe id="plain" src="${origins.blade}/plain" width="600" height="120" style="border:0;display:block"></iframe>`
        + `<iframe id="blade" src="${origins.blade}/settings" width="600" height="200" style="border:0;display:block"></iframe>`
        + `<iframe id="tail" src="${origins.other}/ad" width="600" height="200" style="border:0;display:block"></iframe></body>`;
    }
    if (path === '/shifting') {
      return '<title>Shifting</title><body style="margin:0"><div id="pad"></div><h1 style="margin:0;height:40px">Portal</h1>'
        + `<iframe id="blade" src="${origins.blade}/settings" width="600" height="200" style="border:0;display:block"></iframe>`
        + `<iframe id="ad" src="${origins.other}/ad" width="300" height="100" style="border:0;display:block"></iframe></body>`;
    }
    if (path === '/nested') {
      return `<title>Nested</title><body style="margin:0"><h1>Nested</h1><iframe src="${origins.blade}/outer" width="600" height="320" `
        + 'style="border:0;display:block;margin-left:20px"></iframe></body>';
    }
    if (path === '/signin') {
      return `<title>Portal sign-in</title><body style="margin:0"><h1>Portal</h1><iframe src="${origins.blade}/signin" width="600" `
        + 'height="320" style="border:0;display:block"></iframe></body>';
    }
    return null;
  });
  servers.push(blade, nested, other, top);
  t.after(() => Promise.all(servers.map(server => new Promise(done => { server.closeAllConnections?.(); server.close(done); }))));
  const at = server => `http://127.0.0.1:${server.address().port}`;
  Object.assign(origins, { top: at(top), blade: at(blade), nested: at(nested), other: at(other) });

  // The request lists the portal, the blade and the nested blade; never the partner origin.
  const launched = await launchLeased(t, { hostPermissions: ['<all_urls>'], startUrl: `${origins.top}/`,
    allowedOrigins: [origins.top, origins.blade, origins.nested] });
  if (!launched) return;
  const { page, companion, worker } = launched;
  const { bridge } = companion;

  await t.test('an approved frame is read: its text, its controls (f1.<id>), its secret redacted; the other one is named only', async () => {
    const observation = await bridge.observe();
    assert.match(observation.text, /Tenant ID: 7f3a-1122/);
    assert.ok(!observation.text.includes(TOKEN), 'the frame page script redacted the token');
    assert.match(observation.text, /\[secret:\d+/);
    const button = observation.controls.find(control => control.label === 'Mark reviewed');
    assert.ok(button, JSON.stringify(observation.controls.map(control => control.label)));
    assert.equal(button.id, 'f1.1');
    assert.equal(button.frame, 'f1');
    assert.equal(button.frameOrigin, origins.blade);
    assert.ok(button.bounds.y > 40, `bounds moved into the top viewport (${button.bounds.y})`);
    // The partner frame: not read, named by its origin.
    assert.doesNotMatch(observation.text, /Partner offer/);
    assert.ok(!observation.controls.some(control => control.label === 'Partner button'));
    assert.ok(observation.warnings.includes('cross_origin_frame'));
    assert.deepEqual(observation.frames, [{ id: 'f1', origin: origins.blade, read: true },
      { origin: origins.other, read: false, reason: 'not_approved' }]);
    assert.equal(observation.frameSlots, undefined);
  });

  await t.test('a click on the frame control runs in the frame; the result shows the frame changed', async () => {
    const observation = await bridge.observe();
    const button = observation.controls.find(control => control.label === 'Mark reviewed');
    const outcome = await bridge.execute({ type: 'click', target: button.id }, observation.revision, { capture: false });
    assert.match(outcome.observation.text, /Review state: reviewed/);
    assert.notEqual(outcome.observation.revision, observation.revision);
    // The frame really changed (read from Playwright's own view of the frame, as text).
    const frame = page.frames().find(item => item.url().startsWith(origins.blade));
    assert.equal(await frame.evaluate(() => document.getElementById('s').textContent), 'Review state: reviewed');
  });

  await t.test('review #4: the frame document vanishing between the probe and the act is cross_origin, never a success', async () => {
    await page.goto(`${origins.top}/`);
    await page.waitForLoadState('load');
    await sleep(300);
    const observation = await bridge.observe();
    const button = observation.controls.find(control => control.label === 'Mark reviewed');
    assert.ok(button);
    // Right after the worker's re-probe of that frame, the frame navigates to an origin the request does not list:
    // the act's injection then finds no document.
    assert.equal(await worker.evaluate(target => {
      const original = chrome.scripting.executeScript.bind(chrome.scripting);
      globalThis.__restoreScript = () => { chrome.scripting.executeScript = original; };
      chrome.scripting.executeScript = async options => {
        const results = await original(options);
        if (options.func?.name === 'frameProbe' && options.target.frameIds) {
          chrome.scripting.executeScript = original;
          await original({ target: { tabId: options.target.tabId, frameIds: options.target.frameIds }, func: url => { location.href = url; },
            args: [target] });
          await new Promise(done => setTimeout(done, 800));
        }
        return results;
      };
      return 'hooked';
    }, `${origins.other}/landing`), 'hooked');
    try {
      const code = await codeOf(bridge.execute({ type: 'click', target: button.id }, observation.revision, { capture: false }));
      assert.equal(code, 'cross_origin');
      // Nothing was clicked anywhere: the partner page's button is untouched and the blade is gone from the frame.
      const partner = page.frames().find(item => item.url().startsWith(origins.other) && item.url().includes('/landing'));
      assert.equal(await partner.evaluate(() => document.title), 'Ad');
    } finally {
      await worker.evaluate(() => globalThis.__restoreScript?.());
    }
  });

  await t.test('review #1 and #5: screenshot boxes follow a frame the page moved after the observation; unread frames are boxed', async () => {
    await page.goto(`${origins.top}/shifting`);
    await page.waitForLoadState('load');
    await sleep(300);
    const result = await worker.evaluate(async () => {
      const tabId = session.tabId;
      await faiFrames.observeTab(tabId);
      // The page shifts its frames down by 150px after the observation (a banner, an ad, a lazy image).
      await chrome.scripting.executeScript({ target: { tabId }, func: () => { document.getElementById('pad').style.height = '150px'; } });
      await new Promise(done => setTimeout(done, 100));
      const before = await redactionQuery(tabId, true).then(value => faiFrames.redaction(tabId, value, true));
      const after = await redactionQuery(tabId, false).then(value => faiFrames.redaction(tabId, value, false));
      return { before: before.rects, after: after.rects, dirty: after.dirty ?? null };
    });
    const real = await page.evaluate(() => {
      const blade = document.getElementById('blade').getBoundingClientRect();
      const ad = document.getElementById('ad').getBoundingClientRect();
      return { field: { x: blade.x + 10, y: blade.y + 40 }, ad: { x: ad.x, y: ad.y, width: ad.width, height: ad.height } };
    });
    // The approved frame's password field is boxed where it is now (4px padding around it).
    const near = (rect, x, y) => Math.abs(rect.x - (x - 4)) <= 2 && Math.abs(rect.y - (y - 4)) <= 2;
    for (const rects of [result.before, result.after]) {
      assert.ok(rects.some(rect => near(rect, real.field.x, real.field.y) && rect.width >= 200), JSON.stringify({ rects, real }));
      assert.ok(!rects.some(rect => near(rect, real.field.x, real.field.y - 150) && rect.width < 300), 'never at the old place');
      // The partner frame, not read, is boxed whole.
      assert.ok(rects.some(rect => Math.abs(rect.x - real.ad.x) <= 1 && Math.abs(rect.y - real.ad.y) <= 1
        && rect.width >= real.ad.width - 1 && rect.height >= real.ad.height - 1), JSON.stringify({ rects, ad: real.ad }));
    }
    assert.equal(result.dirty, false, 'nothing moved between the two queries');
  });

  await t.test('review: removing an earlier frame (ad rotation) never moves a read frame\'s boxes onto another frame', async () => {
    await page.goto(`${origins.top}/rotating`);
    await page.waitForLoadState('load');
    await sleep(300);
    const result = await worker.evaluate(async () => {
      const tabId = session.tabId;
      await faiFrames.observeTab(tabId);
      await chrome.scripting.executeScript({ target: { tabId }, func: () => { document.getElementById('ad').remove(); } });
      await new Promise(done => setTimeout(done, 100));
      const before = await redactionQuery(tabId, true).then(value => faiFrames.redaction(tabId, value, true));
      const after = await redactionQuery(tabId, false).then(value => faiFrames.redaction(tabId, value, false));
      return { before: before.rects, after: after.rects, dirty: after.dirty ?? null };
    });
    const real = await page.evaluate(() => {
      const blade = document.getElementById('blade').getBoundingClientRect();
      const tail = document.getElementById('tail').getBoundingClientRect();
      return { field: { x: blade.x + 10, y: blade.y + 40 }, tail: { x: tail.x, y: tail.y, width: tail.width, height: tail.height } };
    });
    const covers = (rect, x, y, width, height) => rect.x <= x && rect.y <= y && rect.x + rect.width >= x + width
      && rect.y + rect.height >= y + height;
    for (const rects of [result.before, result.after]) {
      // The password field of the approved frame is covered where it is now: by its own box, or by the whole frame.
      assert.ok(rects.some(rect => covers(rect, real.field.x, real.field.y, 200, 20)), JSON.stringify({ rects, real }));
      // The unread tail frame is boxed whole.
      assert.ok(rects.some(rect => covers(rect, real.tail.x, real.tail.y, real.tail.width, real.tail.height)), JSON.stringify(rects));
    }
  });

  await t.test('a frame that moved to an unapproved origin after the observation refuses the act', async () => {
    await page.goto(`${origins.top}/`);
    await page.waitForLoadState('load');
    await sleep(300);
    const observation = await bridge.observe();
    const button = observation.controls.find(control => control.label === 'Mark reviewed');
    const frame = page.frames().find(item => item.url().startsWith(origins.blade));
    await frame.evaluate(target => { location.href = target; }, `${origins.other}/landing`);
    await page.waitForFunction(target => document.getElementById('blade').contentWindow.length === 0, null, { timeout: 5000 }).catch(() => {});
    await sleep(300);
    const code = await codeOf(bridge.execute({ type: 'click', target: button.id }, observation.revision, { capture: false }));
    assert.equal(code, 'cross_origin');
    assert.equal(companion.status().status, 'active', 'the tab itself is still approved');
    const after = await bridge.observe();
    assert.doesNotMatch(after.text, /Partner offer/);
    assert.ok(after.frames.some(entry => entry.origin === origins.other && entry.read === false));
  });

  await t.test('nested approved frames are read, the inner one at its summed offset', async () => {
    await page.goto(`${origins.top}/nested`);
    await page.waitForLoadState('load');
    await sleep(300);
    const observation = await bridge.observe();
    assert.match(observation.text, /Outer blade/);
    assert.match(observation.text, /Custom domains: contoso\.example/);
    const add = observation.controls.find(control => control.label === 'Add domain');
    assert.ok(add, JSON.stringify(observation.controls.map(control => [control.id, control.label])));
    assert.equal(add.frameOrigin, origins.nested);
    assert.ok(add.bounds.x >= 32, `20px margin + 12px margin (${add.bounds.x})`);
  });

  await t.test('a sign-in form inside an approved frame: password_field and login_wall, the field boxed on the screenshot', async () => {
    await page.goto(`${origins.top}/signin`);
    await page.waitForLoadState('load');
    await sleep(300);
    const observation = await bridge.observe();
    assert.ok(observation.warnings.includes('password_field'), JSON.stringify(observation.warnings));
    assert.ok(observation.warnings.includes('login_wall'), JSON.stringify(observation.warnings));
    const password = observation.controls.find(control => control.type === 'password');
    assert.ok(password, 'the password field is reported as one');
    assert.ok(!JSON.stringify(observation).includes('hunter2-hunter2'));
    // Below Test site the sign-in button is refused in the frame's own page script.
    const signIn = observation.controls.find(control => control.label === 'Sign in' && control.role === 'button');
    assert.ok(signIn);
    assert.equal(await codeOf(bridge.execute({ type: 'click', target: signIn.id }, observation.revision, { capture: false })), 'blocked_risky');
    const shot = await bridge.capture({ action: null, target: null });
    assert.ok(shot?.dataUrl?.startsWith('data:image/'), JSON.stringify(shot).slice(0, 200));
    assert.ok(shot.redactions >= 1, `the frame's password field is boxed (${shot.redactions})`);
    assert.equal(shot.revision, (await bridge.observe()).revision, 'the capture names the merged revision');
  });
});

test('exact-host access only: an approved frame on a host the browser gives no access to is named no_access, never read', async t => {
  // The top page on 127.0.0.1, its approved frame on localhost: the extension holds http://127.0.0.1/* only (what the
  // request modal grants for the tab's host when the request names no other origin).
  // A second approved frame on 127.0.0.1 (another port) is reachable: the probe skips the frame it cannot reach and
  // still reads this one.
  const frameServer = await serve(path => (path === '/widget' ? '<title>Widget</title><body><p>Widget text</p></body>' : null));
  const frameOrigin = `http://localhost:${frameServer.address().port}`;
  const nearServer = await serve(path => (path === '/near' ? '<title>Near</title><body><p>Near frame text</p></body>' : null));
  const nearOrigin = `http://127.0.0.1:${nearServer.address().port}`;
  const topServer = await serve(path => (path === '/' ? `<title>Host</title><body><h1>Host page</h1><iframe src="${frameOrigin}/widget" `
    + `width="400" height="200"></iframe><iframe src="${nearOrigin}/near" width="400" height="200"></iframe></body>` : null));
  t.after(() => Promise.all([frameServer, nearServer, topServer].map(server => new Promise(done => { server.closeAllConnections?.(); server.close(done); }))));
  const topOrigin = `http://127.0.0.1:${topServer.address().port}`;
  const launched = await launchLeased(t, { hostPermissions: ['http://127.0.0.1/*'], startUrl: `${topOrigin}/`,
    allowedOrigins: [topOrigin, frameOrigin, nearOrigin] });
  if (!launched) return;
  await sleep(200);
  const observation = await launched.companion.bridge.observe();
  assert.match(observation.text, /Host page/, 'the top page is read as before');
  assert.doesNotMatch(observation.text, /Widget text/);
  assert.match(observation.text, /Near frame text/, 'the reachable approved frame is read');
  assert.deepEqual(observation.frames, [{ id: 'f1', origin: nearOrigin, read: true },
    { origin: frameOrigin, read: false, reason: 'no_access', declared: true }]);
  assert.ok(observation.warnings.includes('cross_origin_frame'));
});
