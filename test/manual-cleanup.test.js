// npm run manual-smoke against a real daemon (temporary FAI_HOME) with the fake extension standing in for the user:
// it approves the smoke's tab request and serves the page from memory. The script must pass, release its request and
// exit on its own; a request nobody approves fails within the approval window.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDaemon } from '../src/daemon.js';
import { EXTENSION_ID, FakeExtension, SECRET } from './helpers/fake-extension.js';
import { FakeBridge, link } from './runtime-fixtures.js';

const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

async function setup(t) {
  const home = await mkdtemp(join(tmpdir(), 'fai-manual-smoke-'));
  const daemon = createDaemon({ home, env: { FAI_BRIDGE_SECRET: SECRET, FAI_EXTENSION_ID: EXTENSION_ID }, port: 0,
    sweepIntervalMs: 60_000, providerFactory: () => { throw new Error('the smoke never needs a provider'); } });
  await daemon.listen();
  const ext = await FakeExtension.connect({ port: daemon.port });
  assert.equal((await ext.hello()).ok, true);
  t.after(async () => {
    ext.close();
    await daemon.close();
    await rm(home, { recursive: true, force: true });
  });
  return { home, daemon, ext };
}

function start(ctx, extraEnv = {}) {
  const child = spawn(process.execPath, ['scripts/manual-browser-smoke.mjs'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: ctx.home, FAI_HOME: ctx.home, FAI_DAEMON_PORT: String(ctx.daemon.port), ...extraEnv },
  });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const exited = new Promise(resolve => child.once('exit', code => resolve(code)));
  return { child, exited, output: () => output };
}

test('manual smoke: approve, observe, act through the FAI service; PASS releases the request and exits', async t => {
  const ctx = await setup(t);
  const smoke = start(ctx);
  // The fixture origin is the script's own random port: read it from the request it makes.
  const pushed = await ctx.ext.client.message(message => message.type === 'requests'
    && message.requests.some(request => request.state === 'pending'), 20_000);
  const origin = pushed.requests.find(item => item.state === 'pending').origins[0];
  assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  const bridge = new FakeBridge({ pages: {
    '/': { url: `${origin}/`, title: 'FAI fixture', text: 'Project overview', controls: [link('1', 'About project', `${origin}/about.html`)] },
    '/about.html': { url: `${origin}/about.html`, title: 'About project', text: 'Members: Ada, Grace, Linus.', controls: [] },
  } });
  const reply = await ctx.ext.lease({ requestId: pushed.requests.find(item => item.state === 'pending').requestId, tabId: 1, origin });
  assert.equal(reply.ok, true, JSON.stringify(reply));
  const stop = { done: false };
  t.after(() => { stop.done = true; smoke.child.kill(); });
  (async () => {
    while (!stop.done && !ctx.ext.client.closed) {
      let command;
      try {
        command = await ctx.ext.command(1000);
      } catch {
        continue;
      }
      const { id, method, args } = command;
      try {
        if (method === 'observe') ctx.ext.result(id, await bridge.observe());
        else if (method === 'capture') ctx.ext.result(id, { screenshot: { dataUrl: JPEG, revision: bridge.observation.revision, format: 'jpeg' } });
        else if (method === 'execute') {
          const executed = await bridge.execute(args.action, args.expectedRevision, { capture: args.capture });
          ctx.ext.result(id, { observation: executed.observation, settle: executed.settle });
          if (args.capture) ctx.ext.send('screenshot', { id, screenshot: { ...(await executed.screenshot), dataUrl: JPEG } });
        } else ctx.ext.error(id, 'unsupported');
      } catch (error) {
        ctx.ext.error(id, error.code ?? 'unsupported', error.message);
      }
    }
  })().catch(() => {});
  const code = await smoke.exited;
  stop.done = true;
  assert.equal(code, 0, smoke.output());
  assert.match(smoke.output(), /PASS:/);
  assert.match(smoke.output(), /Transport: websocket/);
});

test('manual smoke: nobody approves within the window, FAIL and exit 1', async t => {
  const ctx = await setup(t);
  const smoke = start(ctx, { FAI_MANUAL_SMOKE_APPROVAL_MS: '1500' });
  t.after(() => smoke.child.kill());
  const code = await smoke.exited;
  assert.equal(code, 1, smoke.output());
  assert.match(smoke.output(), /FAIL: The request was not approved/);
});
