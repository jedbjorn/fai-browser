// extension/trusted-input.js (opt-in trusted input through chrome.debugger) in a VM with a fake chrome: off unless the
// build has chrome.debugger and the user turned it on; only the leased tab's top-frame content script is served; only
// the closed step set, inside the viewport, goes out; it attaches for the action and detaches when idle. And the
// trusted-input build adds `debugger` to a copy of the manifest, never to extension/manifest.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { trustedManifest } from '../scripts/build-trusted.mjs';

const SOURCE = await readFile(new URL('../extension/trusted-input.js', import.meta.url), 'utf8');
const EXTENSION_ID = 'fai-extension';

function load({ debuggerApi = true, setting = true } = {}) {
  const commands = [];
  const attaches = [];
  const detaches = [];
  let listener = null;
  let storageListener = null;
  const chrome = {
    runtime: { id: EXTENSION_ID, onMessage: { addListener: fn => { listener = fn; } } },
    storage: {
      local: { get: async () => ({ trustedInput: setting }) },
      onChanged: { addListener: fn => { storageListener = fn; } },
    },
  };
  if (debuggerApi) {
    chrome.debugger = {
      attach: async target => { attaches.push(target.tabId); },
      detach: async target => { detaches.push(target.tabId); },
      sendCommand: async (target, method, params) => { commands.push({ tabId: target.tabId, method, params }); },
      onDetach: { addListener: () => {} },
    };
  }
  const context = vm.createContext({ chrome, setTimeout, clearTimeout, console, session: { tabId: 7 } });
  vm.runInContext(SOURCE, context);
  const send = (message, sender = { id: EXTENSION_ID, tab: { id: 7 }, frameId: 0 }) => new Promise(resolve => {
    const async = listener(message, sender, value => resolve(value === undefined ? value : JSON.parse(JSON.stringify(value))));
    if (!async) setTimeout(() => resolve(undefined), 0);
  });
  return { context, commands, attaches, detaches, send, setSetting: value => storageListener({ trustedInput: { newValue: value } }, 'local') };
}

const VIEWPORT = { width: 1200, height: 800 };
const CLICK = [
  { m: 'mouse', type: 'mouseMoved', x: 100, y: 120 }, { wait: 10 },
  { m: 'mouse', type: 'mouseMoved', x: 140, y: 130 },
  { m: 'mouse', type: 'mousePressed', x: 140, y: 130 }, { wait: 30 },
  { m: 'mouse', type: 'mouseReleased', x: 140, y: 130 },
];

test('replays the closed step set in the leased tab, attached for the action and detached when idle', async () => {
  const h = load();
  await new Promise(resolve => setTimeout(resolve, 5));
  const reply = await h.send({ kind: 'fai-trusted-input', steps: [...CLICK,
    { m: 'key', type: 'keyDown', key: 'a', code: 'KeyA', keyCode: 65, text: 'a' }, { m: 'key', type: 'keyUp', key: 'a', code: 'KeyA', keyCode: 65 },
    { m: 'text', text: 'rest of it' }, { m: 'mouse', type: 'mouseWheel', x: 500, y: 400, deltaY: 100 }], viewport: VIEWPORT });
  assert.deepEqual(reply, { ok: true, dispatched: 8 });
  assert.deepEqual(h.attaches, [7]);
  assert.deepEqual(h.commands.map(c => `${c.method}:${c.params.type ?? c.params.text}`), [
    'Input.dispatchMouseEvent:mouseMoved', 'Input.dispatchMouseEvent:mouseMoved', 'Input.dispatchMouseEvent:mousePressed',
    'Input.dispatchMouseEvent:mouseReleased', 'Input.dispatchKeyEvent:keyDown', 'Input.dispatchKeyEvent:keyUp',
    'Input.insertText:rest of it', 'Input.dispatchMouseEvent:mouseWheel',
  ]);
  const pressed = h.commands[2].params;
  assert.equal(pressed.button, 'left');
  assert.equal(pressed.buttons, 1);
  assert.equal(pressed.clickCount, 1);
  assert.equal(h.commands[4].params.text, 'a');
  // A second action within the idle window reuses the attachment; then it detaches.
  await h.send({ kind: 'fai-trusted-input', steps: CLICK, viewport: VIEWPORT });
  assert.deepEqual(h.attaches, [7]);
  await new Promise(resolve => setTimeout(resolve, 700));
  assert.deepEqual(h.detaches, [7]);
});

test('an until step makes a call last a fixed time; past the deadline only the held keys are released, and the reply says late', async () => {
  const h = load();
  await new Promise(resolve => setTimeout(resolve, 5));
  const key = (type, k) => ({ m: 'key', type, key: k, code: `Key${k.toUpperCase()}`, keyCode: k.toUpperCase().charCodeAt(0), ...(type === 'keyDown' ? { text: k } : {}) });
  // A fixed length: the same whatever the steps before it.
  for (const steps of [[key('keyDown', 'a'), key('keyUp', 'a')], [key('keyDown', 'a'), key('keyUp', 'a'), key('keyDown', 'b'), key('keyUp', 'b')]]) {
    const started = Date.now();
    const reply = await h.send({ kind: 'fai-trusted-input', steps: [...steps, { until: 150 }], viewport: VIEWPORT });
    assert.equal(reply.ok, true);
    const took = Date.now() - started;
    assert.ok(took >= 145 && took < 260, `took ${took}`);
  }
  assert.equal((await h.send({ kind: 'fai-trusted-input', steps: [{ until: 20_000 }], viewport: VIEWPORT })).reason, 'invalid');
  // A deadline: keys after it are not pressed and no text goes in; what is held comes up.
  h.commands.length = 0;
  const reply = await h.send({ kind: 'fai-trusted-input', deadline: 40, viewport: VIEWPORT, steps: [
    key('keyDown', 'a'), { wait: 20 }, key('keyDown', 'b'), key('keyUp', 'a'), { wait: 60 },
    key('keyUp', 'b'), key('keyDown', 'c'), key('keyUp', 'c'), { m: 'text', text: 'rest' },
  ] });
  assert.deepEqual(reply, { ok: true, dispatched: 4, late: true });
  assert.deepEqual(h.commands.map(c => `${c.params.type ?? 'text'}:${c.params.key ?? c.params.text}`), ['keyDown:a', 'keyDown:b', 'keyUp:a', 'keyUp:b']);
});

test('refuses other tabs, frames and senders, anything outside the step set, and does nothing while off', async () => {
  const h = load();
  await new Promise(resolve => setTimeout(resolve, 5));
  const message = { kind: 'fai-trusted-input', steps: CLICK, viewport: VIEWPORT };
  assert.equal((await h.send(message, { id: EXTENSION_ID, tab: { id: 8 }, frameId: 0 })).reason, 'not_leased');
  assert.equal((await h.send(message, { id: EXTENSION_ID, tab: { id: 7 }, frameId: 3 })).reason, 'not_leased');
  assert.equal((await h.send(message, { id: 'other', tab: { id: 7 }, frameId: 0 })).reason, 'not_leased');
  for (const steps of [
    [{ m: 'mouse', type: 'mouseMoved', x: 5000, y: 10 }],
    [{ m: 'mouse', type: 'mouseDragged', x: 5, y: 10 }],
    [{ m: 'eval', expression: 'alert(1)' }],
    [{ wait: 60_000 }],
    [{ m: 'text', text: 'x'.repeat(5000) }],
    [{ m: 'key', type: 'char', key: 'a' }],
    Array.from({ length: 401 }, () => ({ wait: 0 })),
  ]) {
    assert.deepEqual(await h.send({ kind: 'fai-trusted-input', steps, viewport: VIEWPORT }), { ok: false, dispatched: 0, reason: 'invalid' });
  }
  h.setSetting(false);
  assert.deepEqual(await h.send(message), { ok: false, dispatched: 0, reason: 'off' });
  assert.deepEqual(h.commands, []);
  assert.deepEqual(h.attaches, []);
});

test('without chrome.debugger (the regular build, Firefox) it is always off', async () => {
  const h = load({ debuggerApi: false });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(h.context.trustedInputOn(), false);
  assert.deepEqual(await h.send({ kind: 'fai-trusted-input', steps: CLICK, viewport: VIEWPORT }), { ok: false, dispatched: 0, reason: 'off' });
});

test('the debugger permission lives only in the trusted-input build', async () => {
  const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  assert.ok(!manifest.permissions.includes('debugger'));
  assert.ok(!(manifest.optional_permissions ?? []).includes('debugger'));
  const trusted = trustedManifest(manifest);
  assert.ok(trusted.permissions.includes('debugger'));
  assert.equal(trusted.key, manifest.key);
  assert.ok(!manifest.permissions.includes('debugger'), 'the source manifest is not changed');
});
