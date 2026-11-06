import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8');

function worker() {
  const event = () => ({ addListener() {}, removeListener() {} });
  const context = vm.createContext({
    URL, AbortSignal, AbortController, setTimeout, clearTimeout, setInterval() {},
    chrome: {
      storage: { local: { get: async () => ({}), set: async () => {} }, session: { set: async () => {} }, onChanged: event() },
      runtime: { onMessage: event(), onStartup: event(), onInstalled: event() },
      action: { setBadgeText: async () => {}, setTitle: async () => {} },
      tabs: { onCreated: event(), onActivated: event(), onRemoved: event(), onUpdated: event() },
    },
  });
  vm.runInContext(source, context);
  vm.runInContext(`
    session = { leaseId: 'lease', tabId: 7, origin: 'https://example.com', status: 'active' };
    globalThis.executions = 0;
    send = async () => ({ valid: true });
    assertTab = async () => ({ id: 7, url: 'https://example.com/' });
    callPage = async () => {
      executions++;
      return { observation: { url: 'https://example.com/' }, settle: { reason: 'quiet' } };
    };
    globalThis.releaseGate = null;
    captureGate = new Promise(resolve => { releaseGate = resolve; });
    globalThis.command = {
      version: 3, id: 'queued', deadline: Date.now() + 30000, method: 'execute',
      lease: { id: 'lease', tabId: 7 }, allowedOrigins: ['https://example.com'],
      args: { action: { type: 'click', target: '1' }, expectedRevision: 'r', capture: false },
    };
  `, context);
  return context;
}

for (const [name, mutate, code] of [
  ['cancel', "cancelled.add('queued')", 'timeout'],
  ['expiry', 'command.deadline = Date.now() - 1', 'timeout'],
  ['supersede', "session = { ...session, leaseId: 'replacement', tabId: 8 }", 'session_inactive'],
]) {
  test(`codex: worker rechecks ${name} after the capture gate before clicking`, async () => {
    const context = worker();
    const execution = vm.runInContext('executeCommand(command)', context);
    // Let validate() resolve and the command begin waiting behind capture.
    await new Promise(resolve => setImmediate(resolve));
    vm.runInContext(`${mutate}; releaseGate();`, context);
    await assert.rejects(execution, error => error.code === code);
    assert.equal(context.executions, 0, 'a revoked command reached the page');
  });
}
