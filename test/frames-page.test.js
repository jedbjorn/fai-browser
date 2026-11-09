// extension/page.js and approved cross-origin frames (headless Chromium): the top document lists each cross-origin
// frame as a slot (its path in window.frames, its box, the origin its element names) and never reads it; inside an
// approved frame the same page.js runs with the frame context the worker sends (useContext), and every protection holds
// there exactly as in a top document: the frame's own origin check, secret redaction and the vault, password and
// sign-in detection, consent dialogs, the level guardrails and the request's forbid list, the purchase gate (with the
// tab's purchase page carried in by the context), and links that may not leave the approved origins.
// CHROMIUM_PATH overrides the browser binary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { headlessEnv } from '../scripts/headless-env.mjs';
import { loadFakes } from './helpers/secret-fakes.js';

const PAGE_SCRIPT = new URL('../extension/page.js', import.meta.url).pathname;
const SETTLE = { quietMs: 40, capMs: 600 };
const TOP = 'https://example.com';
const FRAME = 'https://other.test';
// A built fake GitHub token (test/helpers/secret-fakes.js), never a literal.
const TOKEN = loadFakes().github;
// The worker's frame context for a frame of TOP approved by the request [TOP, FRAME].
const CONTEXT = { frame: true, topOrigin: TOP, origins: [TOP, FRAME] };
const USE = ['navigate', 'controls'];
const FULL = ['navigate', 'controls', 'submit_safe', 'submit', 'delete', 'consent_accept'];

let browser;
test.before(async () => {
  try {
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, env: headlessEnv(), args: ['--no-sandbox'],
    });
  } catch {
    browser = null;
  }
});
test.after(() => browser?.close());

const doc = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

/** Serves `frameBody` at https://other.test/frame inside https://example.com/; page.js in both. Returns { page, frame }. */
async function open(t, frameBody, { frameTitle = 'Blade', top = null } = {}) {
  if (!browser) {
    t.skip('no Chromium');
    return null;
  }
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  t.after(() => page.close());
  const routes = {
    [`${TOP}/`]: top ?? doc('Portal', '<h1>Portal</h1><iframe src="https://other.test/frame" width="700" height="500" style="border:0"></iframe>'),
    [`${FRAME}/frame`]: doc(frameTitle, frameBody),
    [`${FRAME}/inner`]: doc('Inner', '<p>Inner text</p>'),
  };
  const serve = route => {
    const url = new URL(route.request().url());
    const body = routes[url.origin + url.pathname];
    return route.fulfill({ status: body ? 200 : 404, contentType: 'text/html', body: body ?? doc('Missing', 'missing') });
  };
  await page.route(`${TOP}/**`, serve);
  await page.route(`${FRAME}/**`, serve);
  await page.goto(`${TOP}/`);
  await page.addScriptTag({ path: PAGE_SCRIPT });
  const frame = page.frames().find(item => item.url().startsWith(FRAME));
  await frame.waitForLoadState('load');
  await frame.addScriptTag({ path: PAGE_SCRIPT });
  return { page, frame };
}

// page.js calls inside the frame, with the context first (as the worker's pageCall does).
const inFrame = (frame, method, args = [], context = CONTEXT) => frame.evaluate(async ([m, a, c]) => {
  __faiPage.useContext(c);
  try {
    return { value: await __faiPage[m](...a) };
  } catch (error) {
    return { error: { code: error.code, message: error.message } };
  }
}, [method, args, context]);

test('the top document lists a cross-origin frame as a slot (path, box, declared origin) and reads nothing of it', async t => {
  const opened = await open(t, '<p>Frame secret text</p><button>Frame button</button>');
  if (!opened) return;
  const observation = await opened.page.evaluate(() => __faiPage.observe());
  assert.ok(observation.warnings.includes('cross_origin_frame'));
  assert.equal(observation.frameSlots.length, 1);
  const [slot] = observation.frameSlots;
  assert.deepEqual(slot.path, [0]);
  assert.equal(slot.declared, FRAME);
  assert.equal(slot.box.width, 700);
  assert.equal(slot.box.height, 500);
  assert.ok(slot.box.y > 20, 'below the heading');
  assert.deepEqual(Object.keys(observation.pageFacts).sort(), ['purchase', 'secretPage', 'sensitive']);
  assert.doesNotMatch(JSON.stringify(observation), /Frame secret text|Frame button/);
  // The frame identifies itself by the same path (the worker's probe uses the same walk).
  assert.deepEqual(await opened.frame.evaluate(() => {
    const path = [];
    let view = window;
    while (view !== view.top) {
      const parent = view.parent;
      for (let i = 0; i < parent.length; i++) if (parent[i] === view) path.unshift(i);
      view = parent;
    }
    return path;
  }), [0]);
  // A top page without cross-origin frames reports neither field (nothing changes for it).
  const plain = await browser.newPage();
  t.after(() => plain.close());
  await plain.route(`${TOP}/**`, route => route.fulfill({ contentType: 'text/html', body: doc('Plain', '<p>Plain</p>') }));
  await plain.goto(`${TOP}/plain`);
  await plain.addScriptTag({ path: PAGE_SCRIPT });
  const bare = await plain.evaluate(() => __faiPage.observe());
  assert.equal(bare.frameSlots, undefined);
  assert.equal(bare.pageFacts, undefined);
});

test('in an approved frame: nothing is read or run once the frame is not on an approved origin', async t => {
  const opened = await open(t, '<p>Frame text</p><button>Go</button>');
  if (!opened) return;
  const refused = await inFrame(opened.frame, 'observe', [{ allow: USE }], { ...CONTEXT, origins: [TOP] });
  assert.equal(refused.error?.code, 'cross_origin');
  assert.doesNotMatch(JSON.stringify(refused), /Frame text/);
  const read = await inFrame(opened.frame, 'observe', [{ allow: USE }]);
  assert.match(read.value.text, /Frame text/);
  // Approved when observed, no longer when acting: the dispatch is refused before anything runs.
  const go = read.value.controls.find(control => control.label === 'Go');
  const acted = await inFrame(opened.frame, 'execute', [{ type: 'click', target: go.id }, read.value.revision, SETTLE, [], [], USE, []],
    { ...CONTEXT, origins: [TOP] });
  assert.equal(acted.error?.code, 'cross_origin');
});

test('in an approved frame: secrets are redacted, values go to the vault only when asked, a secret fill needs approval', async t => {
  const opened = await open(t, `<h2>Tokens</h2><p>Deploy token: ${TOKEN}</p><label>API key <input name="api_key" autocomplete="off"></label>`);
  if (!opened) return;
  const salted = await opened.frame.evaluate(() => {
    __faiPage.useSecrets({ mode: 'standard', relaxed: [], salt: 'salt-1', vault: true });
    return true;
  });
  assert.ok(salted);
  const { value } = await inFrame(opened.frame, 'observe', [{ allow: USE }]);
  assert.ok(!JSON.stringify({ ...value, __faiVault: undefined }).includes(TOKEN), 'the token is not in the observation');
  assert.match(value.text, /\[secret:~[0-9a-z]+/);
  assert.equal(value.__faiVault?.[0]?.value, TOKEN, 'the value goes to the worker vault, nothing else');
  const field = value.controls.find(control => control.name === 'api_key');
  const fill = await inFrame(opened.frame, 'execute', [{ type: 'fill_secret', target: field.id, text: 'xyz-secret-value' }, value.revision,
    SETTLE, [], [], FULL, []]);
  assert.equal(fill.error?.code, 'blocked_risky', 'no approval, no secret fill');
});

test('in an approved frame: a sign-in form raises password_field and login_wall; its submit needs Test site', async t => {
  const opened = await open(t, '<h1>Sign in</h1><form><input name="user"><input type="password" name="pw"><button>Sign in</button></form>',
    { frameTitle: 'Sign in to your account' });
  if (!opened) return;
  const { value } = await inFrame(opened.frame, 'observe', [{ allow: FULL }]);
  assert.ok(value.warnings.includes('password_field'));
  assert.ok(value.warnings.includes('login_wall'));
  assert.equal(value.pageFacts.sensitive, true, 'the frame tells the worker it holds a password field');
  const submit = value.controls.find(control => control.label === 'Sign in');
  assert.equal(submit.risk, 'sign_in');
  const clicked = await inFrame(opened.frame, 'execute', [{ type: 'click', target: submit.id }, value.revision, SETTLE, [], [], FULL, []]);
  assert.equal(clicked.error?.code, 'blocked_risky');
});

test('in an approved frame: a cookie dialog is detected, its accept is consent_accept (Act only), reject runs at Use', async t => {
  const opened = await open(t, '<h1>Blade</h1><div id="onetrust-banner-sdk" style="position:fixed;bottom:0;left:0;right:0;background:#fff">'
    + '<p>Manage cookie settings. We use cookies.</p><button>Decline</button><button>Accept</button></div>');
  if (!opened) return;
  const { value } = await inFrame(opened.frame, 'observe', [{ allow: USE }]);
  assert.ok(value.consent, 'consent detected inside the frame');
  const accept = value.controls.find(control => control.label === 'Accept');
  assert.equal(accept.risk, 'consent_accept');
  const refused = await inFrame(opened.frame, 'execute', [{ type: 'click', target: accept.id }, value.revision, SETTLE, [], [], USE, []]);
  assert.equal(refused.error?.code, 'blocked_risky');
  const decline = value.controls.find(control => control.label === 'Decline');
  const declined = await inFrame(opened.frame, 'execute', [{ type: 'click', target: decline.id }, value.revision, SETTLE, [], [], USE, []]);
  assert.equal(declined.error, undefined, JSON.stringify(declined.error));
});

test('in an approved frame: level guardrails, the request\'s forbid list and the purchase gate (with the tab context)', async t => {
  const opened = await open(t, '<h1>Plan</h1><form onsubmit="return false"><input name="seats"><button>Save changes</button></form>'
    + '<button type="button">Delete project</button><button type="button">Upgrade</button><button type="button">Continue</button>');
  if (!opened) return;
  let { value } = await inFrame(opened.frame, 'observe', [{ allow: USE }]);
  const id = label => value.controls.find(control => control.label === label).id;
  const run = async (label, allow, forbid = []) => (await inFrame(opened.frame, 'execute',
    [{ type: 'click', target: id(label) }, value.revision, SETTLE, [], forbid, allow, []])).error?.code;
  assert.equal(await run('Save changes', USE), 'blocked_risky', 'a submit needs Act');
  assert.equal(await run('Delete project', USE), 'blocked_risky', 'a delete needs Act');
  ({ value } = await inFrame(opened.frame, 'observe', [{ allow: FULL, forbid: ['Upgrade'] }]));
  assert.equal(await run('Upgrade', FULL, ['Upgrade']), 'blocked_risky', 'the request forbids it at every level');
  // Continue on its own is a plain button; on a purchase page (here: the top document is one, the context says so) it is
  // a purchase control behind the Approve gate.
  assert.notEqual(value.controls.find(control => control.label === 'Continue').risk, 'purchase');
  ({ value } = await inFrame(opened.frame, 'observe', [{ allow: FULL }], { ...CONTEXT, purchase: true }));
  const cont = value.controls.find(control => control.label === 'Continue');
  assert.equal(cont.gate, 'purchase', JSON.stringify(cont));
  const paid = await inFrame(opened.frame, 'execute', [{ type: 'click', target: cont.id }, value.revision, SETTLE, [], [], FULL, []],
    { ...CONTEXT, purchase: true });
  assert.equal(paid.error?.code, 'blocked_risky', 'a purchase runs only with the user\'s Approve once');
  // The frame's own facts stay its own (the worker unions them): no purchase here.
  assert.equal(value.pageFacts.purchase, false);
});

test('in an approved frame: links may not leave the approved origins; a _top link may only stay on the tab\'s site', async t => {
  const opened = await open(t, '<a href="https://evil.test/x">Elsewhere</a><a href="https://other.test/inner">Inner page</a>'
    + '<a href="https://other.test/inner" target="_top">Frame site in the tab</a><a href="https://example.com/next" target="_top">Portal next</a>');
  if (!opened) return;
  const { value } = await inFrame(opened.frame, 'observe', [{ allow: USE }]);
  const click = async label => inFrame(opened.frame, 'execute', [{ type: 'click', target: value.controls.find(control => control.label === label).id },
    value.revision, SETTLE, [], [], USE, []]);
  assert.equal((await click('Elsewhere')).error?.code, 'cross_origin');
  assert.equal((await click('Frame site in the tab')).error?.code, 'cross_origin', 'the tab would leave its approved site');
  // The tab's own site through _top is allowed (the worker waits for the tab's navigation; the frame goes with it).
  const navigated = opened.page.waitForURL(`${TOP}/next`);
  const portal = await click('Portal next').catch(() => null);
  if (portal) assert.equal(portal.error, undefined, JSON.stringify(portal.error));
  await navigated;
});

test('review #8: a frame under an opaque (null) ancestor refuses every call, even on approved origins', async t => {
  if (!browser) {
    t.skip('no Chromium');
    return;
  }
  const page = await browser.newPage();
  t.after(() => page.close());
  const routes = {
    [`${TOP}/`]: doc('Portal', '<iframe sandbox="allow-scripts" src="https://other.test/sandboxed" width="600" height="300"></iframe>'),
    [`${FRAME}/sandboxed`]: doc('Sandboxed', '<iframe src="https://other.test/inner" width="500" height="200"></iframe>'),
    [`${FRAME}/inner`]: doc('Inner', '<p>Inner text</p><button>Inner button</button>'),
  };
  const serve = route => {
    const url = new URL(route.request().url());
    return route.fulfill({ contentType: 'text/html', body: routes[url.origin + url.pathname] ?? doc('Missing', 'missing') });
  };
  await page.route(`${TOP}/**`, serve);
  await page.route(`${FRAME}/**`, serve);
  await page.goto(`${TOP}/`);
  let inner = null;
  for (let i = 0; i < 50 && !inner; i++) {
    inner = page.frames().find(item => item.url() === `${FRAME}/inner`) ?? null;
    if (!inner) await new Promise(done => setTimeout(done, 50));
  }
  assert.ok(inner, 'the inner frame loaded');
  await inner.waitForLoadState('load');
  await inner.addScriptTag({ path: PAGE_SCRIPT });
  const ancestors = await inner.evaluate(() => Array.from(location.ancestorOrigins ?? []));
  if (!ancestors.includes('null')) {
    t.skip(`this browser names no opaque ancestor (${JSON.stringify(ancestors)})`);
    return;
  }
  const refused = await inFrame(inner, 'observe', [{ allow: USE }]);
  assert.equal(refused.error?.code, 'cross_origin', JSON.stringify(refused));
  assert.doesNotMatch(JSON.stringify(refused), /Inner text/);
});
