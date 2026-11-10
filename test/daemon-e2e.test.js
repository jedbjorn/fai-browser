// End-to-end: the real daemon (createDaemon) with the real hub (src/bridge.js createHub), the fake extension speaking
// protocol v3 over a real WebSocket, and the in-memory page fixture behind it. Then the same flow through the real
// MCP server (src/mcp-main.js) over stdio against that daemon.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDaemon } from '../src/daemon.js';
import { FaiBrowserClient } from '../src/client.js';
import { EXTENSION_ID, FakeExtension, SECRET } from './helpers/fake-extension.js';
import { FakeBridge, ORIGIN } from './runtime-fixtures.js';

const KEY = 'jev-e2e-key-never-logged-5521';
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

// Answers hub commands from the in-memory page, the way extension/background.js does: execute replies with the
// observation, then sends the screenshot as its own message; capture replies with {screenshot}.
function serveCommands(ext, bridge) {
  const captures = [];
  const handle = async command => {
    const { id, method, args } = command;
    try {
      if (method === 'observe') {
        ext.result(id, await bridge.observe());
      } else if (method === 'capture') {
        captures.push(args);
        ext.result(id, { screenshot: { dataUrl: JPEG, revision: bridge.observation.revision, format: 'jpeg' } });
      } else if (method === 'execute') {
        const executed = await bridge.execute(args.action, args.expectedRevision, { capture: args.capture });
        ext.result(id, { observation: executed.observation, settle: executed.settle });
        if (args.capture) {
          const shot = await executed.screenshot;
          ext.send('screenshot', { id, screenshot: { ...shot, dataUrl: JPEG } });
        }
      } else {
        ext.error(id, 'unsupported');
      }
    } catch (error) {
      ext.error(id, error.code ?? 'unsupported', error.message);
    }
  };
  (async () => {
    while (!ext.client.closed) {
      let command;
      try {
        command = await ext.command(10_000);
      } catch {
        continue;
      }
      handle(command);
    }
  })();
  return { captures };
}

async function setup(t, { provider, maxWaitMs, config, pages } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'fai-daemon-e2e-'));
  // The Jev driver, saved as a user would (the MCP server reads it before the daemon answers).
  await writeFile(join(home, 'config.json'), JSON.stringify({ ...config }));
  const env = { TYPESAFE_API_KEY: KEY, FAI_BRIDGE_SECRET: SECRET, FAI_EXTENSION_ID: EXTENSION_ID };
  const providers = [];
  const daemon = createDaemon({
    home,
    env,
    port: 0,
    maxWaitMs,
    sweepIntervalMs: 60_000,
  });
  await daemon.listen();
  const ext = await FakeExtension.connect({ port: daemon.port });
  const hello = await ext.hello();
  assert.equal(hello.ok, true);
  assert.equal(hello.data.mode, 'daemon');
  const bridge = new FakeBridge(pages ? { pages } : {});
  const served = serveCommands(ext, bridge);
  const client = new FaiBrowserClient({ port: daemon.port, token: daemon.token, clientName: 'e2e' });
  t.after(async () => {
    ext.close();
    await daemon.close();
    await rm(home, { recursive: true, force: true });
  });
  return { home, env, daemon, ext, bridge, client, providers, captures: served.captures };
}

// request_tab, the pushed snapshot reaching the extension, then the user's click (a lease message).
async function approvedRequest(ctx, body = {}) {
  const created = await ctx.client.requestTab({ origins: [ORIGIN], reason: 'Check the members list', ...body });
  assert.equal(created.state, 'pending');
  assert.equal(created.extensionConnected, true);
  const pushed = await ctx.ext.client.message(message => message.type === 'requests'
    && message.requests.some(request => request.requestId === created.requestId && request.state === 'pending'));
  assert.equal(pushed.requests.find(request => request.requestId === created.requestId).reason,
    'Check the members list');
  const reply = await ctx.ext.lease({ requestId: created.requestId, tabId: 1, origin: ORIGIN });
  assert.equal(reply.ok, true, JSON.stringify(reply));
  assert.match(reply.data.leaseId, /^[0-9a-f]{32}$/);
  return { requestId: created.requestId, leaseId: reply.data.leaseId };
}

test('e2e: observe/act go through the hub, with evidence, and a lease_update reaches the extension', async t => {
  const ctx = await setup(t);
  const { requestId, leaseId } = await approvedRequest(ctx);

  const home = await ctx.client.observe({ requestId });
  const about = home.actions.find(action => action.label === 'About');
  const first = await ctx.client.act({ requestId, actionId: about.id, revision: home.revision, capture: 'last',
    expectation: { urlIncludes: '/about' } });
  assert.equal(first.result.status, 'completed');
  assert.equal(first.result.verification.passed, true);
  const trace = JSON.parse(await readFile(first.result.trace, 'utf8'));
  assert.equal(trace.options.requestId, requestId);
  assert.ok(!JSON.stringify(trace).includes(KEY));
  const shot = await ctx.client.evidence(first.result.runId, { inline: true });
  assert.equal(shot.mimeType, 'image/jpeg');
  const runs = await ctx.client.runs({ requestId });
  assert.equal(runs.runs[0].runId, first.result.runId);

  const observed = await ctx.client.observe({ requestId, capture: true });
  assert.equal(observed.state, 'ok');
  assert.equal(observed.page.url, `${ORIGIN}/about`);
  const members = observed.actions.find(action => action.label === 'Members');
  assert.ok(members, JSON.stringify(observed.actions));
  assert.ok((await stat(observed.screenshot)).size > 0);
  assert.equal(ctx.captures.at(-1).action, null, 'observe captures with action:null ("Observation")');

  const acted = await ctx.client.act({ requestId, actionId: members.id, revision: observed.revision,
    expectation: { textIncludes: 'Grace' } });
  assert.equal(acted.result.status, 'completed');
  assert.equal(JSON.parse(await readFile(acted.result.trace, 'utf8')).steps[0].decision.by, 'host');
  // The revision is spent: the same action cannot run twice.
  await assert.rejects(ctx.client.act({ requestId, actionId: members.id, revision: observed.revision }),
    { status: 400, code: 'invalid_options' });

  // Releasing pushes lease_update to the extension and closes the request.
  const updated = ctx.ext.client.message(message => message.type === 'lease_update' && message.leaseId === leaseId);
  const released = await ctx.client.release(requestId);
  assert.equal(released.state, 'released');
  const update = await updated;
  assert.deepEqual([update.requestId, update.state, update.reason], [requestId, 'released', 'released']);
  const after = await ctx.client.act({ requestId, actionId: 'a0' });
  assert.equal(after.result.code, 'request_closed');
  assert.equal(after.result.trace, null);
});

