// The Firefox build: its manifest (scripts/build-firefox.mjs), the compat layer it loads first (extension/compat.js:
// the offscreen frame and the exact-origin keeper), the popup's exact-origin request (extension/ui.js), the hub's
// moz-extension origins (src/bridge.js) and Firefox detection for native pairing (src/native.js). The real browser
// check is npm run smoke:firefox (scripts/firefox-smoke.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FIREFOX_BACKGROUND_SCRIPTS, FIREFOX_EXCLUDED_FILES, FIREFOX_MIN_VERSION, FIREFOX_OPTIONAL_HOSTS, buildFirefox, firefoxManifest } from '../scripts/build-firefox.mjs';
import { GECKO_DEV_ID, GECKO_ID, GECKO_IDS, planNativeInstall } from '../src/native.js';
import { callerAllowed } from '../src/native-host.js';
import { FIREFOX_EXTENSION_ORIGIN } from '../src/bridge.js';
import { createCompanion } from '../bench/companion.js';
import { connectRaw } from './helpers/fake-extension.js';
import { allSitesPermission, exactOriginPatterns } from '../extension/ui.js';

const ROOT = resolve(import.meta.dirname, '..');
const chromeManifest = JSON.parse(await readFile(join(ROOT, 'extension', 'manifest.json'), 'utf8'));
const compatSource = await readFile(join(ROOT, 'extension', 'compat.js'), 'utf8');

test('the Firefox manifest: event page with compat.js first, gecko id, no Chrome-only keys, no upgrade-insecure-requests', () => {
  const manifest = firefoxManifest(chromeManifest);
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.background, { scripts: ['compat.js', 'psl-data.js', 'background.js'] });
  assert.deepEqual(FIREFOX_BACKGROUND_SCRIPTS, manifest.background.scripts);
  for (const script of manifest.background.scripts) assert.ok(existsSync(join(ROOT, 'extension', script)), script);
  assert.equal(manifest.browser_specific_settings.gecko.id, GECKO_ID);
  assert.equal(manifest.browser_specific_settings.gecko.strict_min_version, FIREFOX_MIN_VERSION);
  assert.ok(Number(FIREFOX_MIN_VERSION.split('.')[0]) >= 139, 'tabGroups and data_collection_permissions exist there');
  assert.equal('key' in manifest, false);
  assert.equal('minimum_chrome_version' in manifest, false);
  assert.equal(manifest.permissions.includes('offscreen'), false);
  // Ports: Firefox match patterns with a port match nothing, and a portless loopback grant would cover every local page.
  assert.equal('host_permissions' in manifest, false);
  assert.ok(manifest.optional_host_permissions.includes('https://*/*'));
  assert.ok(manifest.optional_host_permissions.includes('http://*/*'));
  const csp = manifest.content_security_policy.extension_pages;
  assert.match(csp, /script-src 'self'/);
  assert.doesNotMatch(csp, /upgrade-insecure-requests|unsafe/);
  // Everything else is the Chromium manifest's.
  for (const key of ['name', 'version', 'description', 'icons', 'commands']) {
    assert.deepEqual(manifest[key], chromeManifest[key], key);
  }
  // The button starts on the toolbar (approving is a click on it), not in the extensions menu.
  assert.deepEqual(manifest.action, { ...chromeManifest.action, default_area: 'navbar' });
  // The signed ID by default; the old dev ID on request.
  assert.equal(GECKO_ID, 'fai-browser@jedbjorn.github.io');
  assert.equal(firefoxManifest(chromeManifest, { geckoId: GECKO_DEV_ID }).browser_specific_settings.gecko.id, 'fai-browser@local');
  assert.deepEqual(manifest.permissions, chromeManifest.permissions.filter(item => item !== 'offscreen'));
  // The input is left alone.
  assert.ok(chromeManifest.key && chromeManifest.background.service_worker === 'background.js');
});

test('buildFirefox copies every extension file but the Chromium-only ones and leaves extension/ untouched', async t => {
  const out = await mkdtemp(join(tmpdir(), 'fai-ff-build-'));
  t.after(() => rm(out, { recursive: true, force: true }));
  const before = await readFile(join(ROOT, 'extension', 'manifest.json'), 'utf8');
  await buildFirefox({ root: ROOT, out });
  const source = (await readdir(join(ROOT, 'extension'), { recursive: true }))
    .filter(name => !FIREFOX_EXCLUDED_FILES.includes(name)).sort();
  const built = (await readdir(out, { recursive: true })).sort();
  assert.deepEqual(built, source);
  // Realistic input ships to Firefox; the chrome.debugger replay does not.
  assert.ok(built.includes('input.js'));
  assert.ok(!built.includes('trusted-input.js'));
  // The Test-site dev hook (page world) and its collector ship too; Firefox 128+ registers MAIN-world content scripts.
  assert.ok(built.includes('devhook.js') && built.includes('devlog.js'));
  for (const name of source.filter(item => /\.(js|html|css)$/.test(item))) {
    assert.equal(await readFile(join(out, name), 'utf8'), await readFile(join(ROOT, 'extension', name), 'utf8'), name);
  }
  assert.deepEqual(JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8')), firefoxManifest(chromeManifest));
  assert.equal(await readFile(join(ROOT, 'extension', 'manifest.json'), 'utf8'), before);
});

// A fake extension API and DOM for compat.js. `gecko` adds browser_specific_settings to the manifest.
function compatContext({ gecko = true, offscreen = false } = {}) {
  const listeners = { clicked: [], added: [], changed: [] };
  const local = {};
  const session = {};
  const requested = [];
  const removed = [];
  const appended = [];
  const permissions = new Set();
  const element = tag => {
    const handlers = {};
    return { tag, dataset: {}, isConnected: false, addEventListener: (type, fn) => { handlers[type] = fn; }, fire: type => handlers[type]?.() };
  };
  const document = {
    body: { appendChild(node) { node.isConnected = true; appended.push(node); } },
    createElement: element,
    getElementById: id => appended.find(node => node.id === id) ?? null,
  };
  const chrome = {
    runtime: {
      getURL: path => `moz-extension://uuid/${path}`,
      getManifest: () => (gecko ? { browser_specific_settings: { gecko: { id: GECKO_ID } } } : {}),
    },
    action: { onClicked: { addListener: fn => listeners.clicked.push(fn) } },
    permissions: {
      request: ({ origins }) => {
        requested.push([...origins]);
        const fresh = origins.filter(pattern => !permissions.has(pattern));
        for (const pattern of origins) permissions.add(pattern);
        if (fresh.length) for (const fn of listeners.added) fn({ origins: fresh });
        return Promise.resolve(true);
      },
      remove: ({ origins }) => {
        removed.push([...origins]);
        for (const pattern of origins) permissions.delete(pattern);
        return Promise.resolve(true);
      },
      onAdded: { addListener: fn => listeners.added.push(fn) },
    },
    storage: {
      local: {
        get: async keys => Object.fromEntries(keys.filter(key => key in local).map(key => [key, structuredClone(local[key])])),
        set: async values => Object.assign(local, structuredClone(values)),
      },
      session: {
        get: async keys => Object.fromEntries([].concat(keys).filter(key => key in session).map(key => [key, structuredClone(session[key])])),
        set: async values => {
          const changes = {};
          for (const [key, value] of Object.entries(values)) changes[key] = { newValue: structuredClone(value) };
          Object.assign(session, structuredClone(values));
          for (const fn of listeners.changed) fn(changes, 'session');
        },
      },
      onChanged: { addListener: fn => listeners.changed.push(fn) },
    },
    tabs: {},
  };
  if (offscreen) chrome.offscreen = { native: true, hasDocument: async () => false, createDocument: async () => {} };
  const context = { chrome, document, URL, Date, structuredClone, setTimeout, Promise };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(compatSource, context);
  const settle = () => new Promise(done => setTimeout(done, 20));
  return { context, chrome, listeners, local, session, requested, removed, appended, permissions, settle };
}

test('compat: a browser with chrome.offscreen keeps it; without, the offscreen page runs in a background-page frame', async () => {
  const chromeLike = compatContext({ offscreen: true });
  assert.equal(chromeLike.chrome.offscreen.native, true);
  assert.equal(chromeLike.context.faiCompat.features().offscreen, true);

  const firefox = compatContext();
  const { offscreen } = firefox.chrome;
  assert.equal(offscreen.polyfill, true);
  assert.equal(await offscreen.hasDocument(), false);
  const creating = offscreen.createDocument({ url: 'offscreen.html', reasons: ['BLOBS'], justification: 'test' });
  assert.equal(firefox.appended.length, 1);
  const [frame] = firefox.appended;
  assert.equal(frame.tag, 'iframe');
  assert.equal(frame.src, 'moz-extension://uuid/offscreen.html');
  assert.equal(frame.hidden, true);
  assert.equal(await offscreen.hasDocument(), false, 'not before it loaded');
  frame.fire('load');
  await creating;
  assert.equal(await offscreen.hasDocument(), true);
  await assert.rejects(offscreen.createDocument({ url: 'offscreen.html' }), /single offscreen document/);
  assert.equal(firefox.appended.length, 1);
  assert.deepEqual(firefox.context.faiCompat.features().offscreenFrame, true);
});

test('compat: the Chromium build gets no exact-origin keeper', () => {
  const chromium = compatContext({ gecko: false });
  assert.equal(chromium.listeners.clicked.length, 0);
  assert.equal(chromium.listeners.added.length, 0);
});

test('compat keeper: the approval click asks for the request\'s exact origins, and only what it added goes when the request ends', async () => {
  const ff = compatContext();
  const { chrome, session, local, requested, removed, permissions, settle } = ff;
  const request = { requestId: 'r1', state: 'pending',
    origins: ['https://docs.example.com', 'http://127.0.0.1:8080', 'https://*.example.org'] };
  // The user already allowed docs.example.com by hand: never tracked, never removed.
  permissions.add('https://docs.example.com/*');
  await chrome.storage.session.set({ requests: [request], armedTabs: [{ tabId: 7, requestId: 'r1', level: 'read-only' }] });
  await settle();
  assert.equal(ff.listeners.clicked.length, 1);
  ff.listeners.clicked[0]({ id: 7, url: 'https://docs.example.com/start' });
  assert.deepEqual(requested, [['https://docs.example.com/*', 'http://127.0.0.1/*']], 'portless, no domain root, synchronously');
  await settle();
  assert.deepEqual(local.compatGrantedOrigins, ['http://127.0.0.1/*']);
  assert.ok(session.compatExpectedOrigins['http://127.0.0.1/*']);

  // Active, then paused: kept.
  await chrome.storage.session.set({ requests: [{ ...request, state: 'active' }] });
  await chrome.storage.session.set({ requests: [{ ...request, state: 'paused' }] });
  await settle();
  assert.deepEqual(removed, []);
  // Released: the keeper removes what it added, not the user's own grant.
  await chrome.storage.session.set({ requests: [{ ...request, state: 'released' }] });
  await settle();
  assert.deepEqual(removed, [['http://127.0.0.1/*']]);
  assert.ok(permissions.has('https://docs.example.com/*'));
  assert.deepEqual(local.compatGrantedOrigins, []);

  // A permission added without an approval click (the extensions panel) is not tracked.
  for (const fn of ff.listeners.added) fn({ origins: ['https://other.example/*'] });
  await settle();
  assert.deepEqual(local.compatGrantedOrigins, []);
});

test('compat keeper: a click on an unarmed tab before anything loaded asks for that page\'s own origin only', async () => {
  const ff = compatContext();
  ff.listeners.clicked[0]({ id: 3, url: 'https://shop.example:8443/cart' });
  assert.deepEqual(ff.requested, [['https://shop.example/*']]);
  ff.listeners.clicked[0]({ id: 4, url: 'about:blank' });
  assert.equal(ff.requested.length, 1);
});

test('ui.js exactOriginPatterns matches compat.js and is empty in the Chromium build', () => {
  const { context } = compatContext();
  const origins = ['https://a.example', 'http://127.0.0.1:4318', 'https://*.example.org', 'https://b.example:8443',
    'ftp://x.example', 'not a url', 'https://a.example/path'];
  assert.deepEqual(exactOriginPatterns(origins, { gecko: true }),
    [...context.faiCompat.requestPatterns({ origins })]);
  assert.deepEqual(exactOriginPatterns(origins, { gecko: true }), ['https://a.example/*', 'http://127.0.0.1/*', 'https://b.example/*']);
  assert.deepEqual(exactOriginPatterns(origins), [], 'no chrome global here: Chromium behaviour');
});

test('the hub accepts a Firefox moz-extension origin with the secret, and nothing else new', async t => {
  const extensionId = 'a'.repeat(32);
  const secret = 'secret-pairing-token-123456789';
  const companion = createCompanion({ port: 0, extensionId, secret, allowedOrigins: ['https://example.com'] });
  const { port } = await companion.listen();
  t.after(() => companion.close());
  const firefox = 'moz-extension://0b5c1f9e-3d2a-4c6b-9e8f-1a2b3c4d5e6f';
  assert.match(firefox, FIREFOX_EXTENSION_ORIGIN);
  for (const bad of ['moz-extension://not-a-uuid', 'moz-extension://0B5C1F9E-3D2A-4C6B-9E8F-1A2B3C4D5E6F',
    `${firefox}.evil.test`, 'https://example.com', 'null']) {
    assert.doesNotMatch(bad, FIREFOX_EXTENSION_ORIGIN, bad);
  }
  const post = origin => fetch(`http://127.0.0.1:${port}/hello`, { method: 'POST',
    headers: { Origin: origin, Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ v: 3, ext: { version: 'test', protocol: 3 }, session: null }) });
  const ok = await post(firefox);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('access-control-allow-origin'), firefox);
  assert.equal((await post('moz-extension://not-a-uuid')).status, 403);
  assert.equal((await post('https://evil.test')).status, 403);
  const wrongSecret = await fetch(`http://127.0.0.1:${port}/hello`, { method: 'POST',
    headers: { Origin: firefox, Authorization: `Bearer ${'x'.repeat(secret.length)}` }, body: '{}' });
  assert.equal(wrongSecret.status, 403);

  const socket = await connectRaw({ port, origin: firefox, protocols: ['fai-browser.v3', `fai-auth.${secret}`] });
  assert.notEqual(socket.upgraded, false, `upgrade refused: ${socket.status} ${socket.body}`);
  socket.destroy();
  const refused = await connectRaw({ port, origin: firefox, protocols: ['fai-browser.v3', 'fai-auth.wrong-secret-0123456789abcdef'] });
  assert.equal(refused.upgraded, false);
  assert.equal(refused.status, 403);
});

test('native pairing finds an XDG-layout Firefox and still writes ~/.mozilla/native-messaging-hosts', async t => {
  const home = await mkdtemp(join(tmpdir(), 'fai-ff-native-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { HOME: home, FAI_HOME: join(home, 'fai') };
  const none = planNativeInstall({ env, platform: 'linux', home, execPath: '/n' });
  assert.equal(none.browsers.some(item => item.id === 'firefox'), false);
  await mkdir(join(home, '.config', 'mozilla', 'firefox'), { recursive: true });
  const xdg = planNativeInstall({ env, platform: 'linux', home, execPath: '/n' });
  const firefox = xdg.browsers.find(item => item.id === 'firefox');
  assert.ok(firefox, 'detected by $XDG_CONFIG_HOME/mozilla/firefox');
  assert.equal(firefox.path, join(home, '.mozilla', 'native-messaging-hosts', 'fai_browser.json'));
  assert.deepEqual(JSON.parse(firefox.content).allowed_extensions, [...GECKO_IDS]);
  // A custom XDG_CONFIG_HOME is honoured.
  const custom = join(home, 'cfg');
  await rm(join(home, '.config'), { recursive: true });
  await mkdir(join(custom, 'mozilla', 'firefox'), { recursive: true });
  const moved = planNativeInstall({ env: { ...env, XDG_CONFIG_HOME: custom }, platform: 'linux', home, execPath: '/n' });
  assert.ok(moved.browsers.some(item => item.id === 'firefox'));
  // Firefox starts the host with [manifest path, add-on ID].
  assert.equal(callerAllowed([firefox.path, GECKO_ID]), true);
  assert.equal(callerAllowed([firefox.path, GECKO_DEV_ID]), true, 'dev builds with the old ID still pair');
  assert.equal(callerAllowed([firefox.path, 'other@addon']), false);
});

test('the Firefox smoke launches Firefox headless, off the desktop session and off the user\'s profile', async () => {
  const source = await readFile(join(ROOT, 'scripts', 'firefox-smoke.mjs'), 'utf8');
  const launch = /spawn\(firefoxPath, \[([^\]]*)\]/.exec(source);
  assert.ok(launch, 'one Firefox spawn');
  assert.match(launch[1], /'-headless'/);
  assert.match(launch[1], /'-profile', profile/);
  assert.match(launch[1], /'-no-remote'/);
  assert.match(source, /const env = \{ \.\.\.headlessEnv\(\), HOME: home,/);
  assert.match(source, /XDG_CONFIG_HOME: join\(home, '\.config'\)/);
  assert.match(source, /\{ env, stdio:/);
});

test('copy_secret on Firefox: the background page writes navigator.clipboard (clipboardWrite), never the offscreen frame stand-in', async () => {
  const worker = await readFile(join(ROOT, 'extension', 'background.js'), 'utf8');
  const body = worker.match(/\nasync function writeClipboard\(text\) \{[\s\S]*?\n\}\n/)?.[0];
  assert.ok(body, 'background.js defines writeClipboard');
  const run = async ({ offscreen, clipboard, document }) => {
    const written = [];
    const messages = [];
    const context = vm.createContext({
      chrome: { offscreen, runtime: { sendMessage: async message => { messages.push(message.type); return { ok: true }; } } },
      navigator: clipboard ? { clipboard: { writeText: async text => { written.push(text); } } } : {},
      ...(document ? { document: {} } : {}),
      ensureOffscreen: async () => {},
      ExtensionError: class extends Error { constructor(code, message) { super(message); this.code = code; } },
    });
    context.globalThis = context;
    vm.runInContext(`${body}\nglobalThis.writeClipboard = writeClipboard;`, context);
    await context.writeClipboard('FAKE-secret-value-123');
    return { written, messages };
  };
  const polyfill = { polyfill: true, createDocument: async () => {}, hasDocument: async () => true };
  assert.deepEqual(await run({ offscreen: polyfill, clipboard: true, document: true }), { written: ['FAKE-secret-value-123'], messages: [] });
  // Chromium: the real offscreen document.
  const native = { createDocument: async () => {}, hasDocument: async () => true };
  assert.deepEqual(await run({ offscreen: native, clipboard: true, document: false }), { written: [], messages: ['clipboard_write'] });
  // A Firefox without navigator.clipboard: the frame stand-in runs offscreen.js there.
  assert.deepEqual(await run({ offscreen: polyfill, clipboard: false, document: true }), { written: [], messages: ['clipboard_write'] });
  const manifest = firefoxManifest(JSON.parse(await readFile(join(ROOT, 'extension', 'manifest.json'), 'utf8')));
  assert.ok(manifest.permissions.includes('clipboardWrite'), 'Firefox keeps clipboardWrite');
});

test('"Allow on all sites" asks only for what each manifest declares: <all_urls> in Firefox (screenshots after navigation), http(s) in Chromium', () => {
  const firefox = allSitesPermission({ gecko: true });
  assert.deepEqual(firefox.origins, ['<all_urls>']);
  for (const origin of firefox.origins) assert.ok(FIREFOX_OPTIONAL_HOSTS.includes(origin), origin);
  const chromium = allSitesPermission({ gecko: false });
  assert.deepEqual(chromium.origins, ['https://*/*', 'http://*/*']);
  for (const origin of chromium.origins) assert.ok(chromeManifest.optional_host_permissions.includes(origin), origin);
  assert.equal(chromeManifest.optional_host_permissions.includes('<all_urls>'), false, 'Chromium never lists <all_urls>');
});
