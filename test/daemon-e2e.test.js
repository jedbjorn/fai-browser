// End-to-end: the real daemon (createDaemon) with the real hub (src/bridge.js createHub), the fake extension speaking
// protocol v3 over a real WebSocket, and the in-memory page fixture behind it. Then the same flow through the real
// MCP server (src/mcp-main.js) over stdio against that daemon.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDaemon, clampWait, MAX_WAIT_MS } from '../src/daemon.js';
import { FaiBrowserClient } from '../src/client.js';
import { LEASE_MESSAGES, bridgeError } from '../src/result.js';
import { EXTENSION_ID, FakeExtension, SECRET } from './helpers/fake-extension.js';
import { call } from './helpers/fake-hub.js';
import { spawnMcp } from './helpers/mcp-harness.js';
import { mcpData } from './helpers/mcp-result.js';
import { FakeBridge, ORIGIN, clickProvider } from './runtime-fixtures.js';

const KEY = 'jev-e2e-key-never-logged-5521';
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('driver switching persists through the authenticated extension WebSocket and HTTP fallback only', async t => {
  const ctx = await setup(t, { config: { budget: { maxCalls: 9 } } });
  const switched = await ctx.ext.request('driver', { driver: 'agent' });
  assert.equal(switched.ok, true);
  assert.deepEqual(switched.data.control, { driver: 'agent', jevAvailable: true });
  assert.deepEqual(JSON.parse(await readFile(join(ctx.home, 'config.json'), 'utf8')),
    { budget: { maxCalls: 9 }, driver: 'agent' });
  const invalid = await ctx.ext.request('driver', { driver: 'testing' });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, 'invalid_driver');
  const endpoint = `http://127.0.0.1:${ctx.daemon.port}/driver`;
  const unauthenticated = await fetch(endpoint, { method: 'POST', body: JSON.stringify({ driver: 'jev' }) });
  assert.equal(unauthenticated.status, 403);
  const back = await fetch(endpoint, { method: 'POST', headers: {
    Origin: `chrome-extension://${EXTENSION_ID}`, Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json',
  }, body: JSON.stringify({ driver: 'jev' }) });
  assert.equal(back.status, 200);
  assert.equal((await back.json()).control.driver, 'jev');
  const read = await ctx.ext.request('driver');
  assert.equal(read.data.control.driver, 'jev');
  const fakeClientRoute = await call(ctx.daemon.port, 'POST', '/v1/driver', { driver: 'agent' }, { token: ctx.daemon.token });
  assert.equal(fakeClientRoute.status, 404, 'the agent API has no driver-switch endpoint');
});

function slowProvider(ms, labels = ['About', 'Members']) {
  const inner = clickProvider(labels);
  return {
    model: 'slow',
    async decide(...args) {
      await delay(ms);
      return inner.decide(...args);
    },
  };
}

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
  await writeFile(join(home, 'config.json'), JSON.stringify({ driver: 'jev', ...config }));
  const env = { TYPESAFE_API_KEY: KEY, FAI_BRIDGE_SECRET: SECRET, FAI_EXTENSION_ID: EXTENSION_ID };
  const providers = [];
  const daemon = createDaemon({
    driver: 'jev',
    home,
    env,
    port: 0,
    maxWaitMs,
    sweepIntervalMs: 60_000,
    providerFactory: () => {
      const made = provider ? provider() : clickProvider(['About', 'Members']);
      providers.push(made);
      return made;
    },
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

test('e2e: request_tab -> approve over WebSocket -> run with an expectation -> completed, with evidence', async t => {
  const ctx = await setup(t);
  const status = await ctx.client.status();
  assert.equal(status.extension.connected, true);
  assert.equal(status.extension.transport, 'websocket');
  assert.equal(status.extension.version, '0.3.0');

  const created = await ctx.client.requestTab({ origins: [ORIGIN], reason: 'Check members' });
  // A lease for an origin the request did not name is refused with the request's origins.
  const wrong = await ctx.ext.lease({ requestId: created.requestId, tabId: 1, origin: 'https://evil.example' });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.error.code, 'origin_not_requested');
  assert.deepEqual(wrong.error.origins, [ORIGIN]);
  // wait on the request wakes as soon as the user approves.
  const waiting = ctx.client.wait({ requestId: created.requestId, maxMs: 10_000 });
  await delay(50);
  const reply = await ctx.ext.lease({ requestId: created.requestId, tabId: 1, origin: ORIGIN });
  assert.equal(reply.ok, true);
  const woke = await waiting;
  assert.equal(woke.state, 'active');
  assert.ok(woke.waitedMs < 5000);
  assert.equal(woke.request.lease.leaseId, reply.data.leaseId);
  assert.equal(woke.request.client, 'e2e');

  const done = await ctx.client.run({
    requestId: created.requestId,
    instruction: 'Open Members',
    expectation: { urlIncludes: '/members' },
    maxActions: 4,
    capture: 'each',
  });
  assert.equal(done.state, 'done');
  const { result } = done;
  assert.equal(result.status, 'completed');
  assert.equal(result.code, 'expectation_passed');
  assert.equal(result.verification.passed, true);
  assert.equal(result.steps.length, 2);
  assert.deepEqual(result.steps.map(step => step.action.label), ['About', 'Members']);
  assert.equal(result.page.url, `${ORIGIN}/members`);
  assert.deepEqual(result.lease, { requestId: created.requestId, state: 'active' });
  assert.equal(result.cost.decisions, 2);
  // Every action went through the real hub to the fake extension, with per-action capture.
  assert.equal(ctx.bridge.executions.length, 2);
  assert.ok(ctx.bridge.executions.every(execution => execution.capture === true));

  const trace = JSON.parse(await readFile(result.trace, 'utf8'));
  assert.equal(trace.operation, 'run');
  assert.equal(trace.options.requestId, created.requestId);
  assert.ok(!JSON.stringify(trace).includes(KEY));
  assert.deepEqual(trace.steps.map(step => step.action.ref), ['1', '1']);
  for (const step of trace.steps) assert.ok((await stat(step.screenshot.path)).size > 0);

  const shot = await ctx.client.evidence(result.runId, { inline: true });
  assert.equal(shot.step, 2);
  assert.equal(shot.mimeType, 'image/jpeg');
  assert.equal(`data:image/jpeg;base64,${shot.data}`, JPEG);
  const first = await ctx.client.evidence(result.runId, { step: 1 });
  assert.equal(first.step, 1);
  assert.equal(first.data, undefined);
  const traceEvidence = await ctx.client.evidence(result.runId, { kind: 'trace' });
  assert.equal(traceEvidence.trace.runId, result.runId);
  await assert.rejects(ctx.client.evidence(result.runId, { step: 9 }), { status: 404, code: 'no_evidence' });

  const runs = await ctx.client.runs({ requestId: created.requestId });
  assert.equal(runs.runs[0].runId, result.runId);
  assert.equal(runs.runs[0].status, 'completed');
});

test('e2e: by default actions run without capture and only the final step is captured, served by evidence', async t => {
  const ctx = await setup(t);
  const { requestId } = await approvedRequest(ctx);
  const { result } = await ctx.client.run({ requestId, instruction: 'Open Members', expectation: { urlIncludes: '/members' },
    maxActions: 4 });
  assert.equal(result.status, 'completed');
  assert.equal(result.steps.length, 2);
  assert.ok(ctx.bridge.executions.every(execution => execution.capture === false), 'no action waits on capture');
  assert.equal(ctx.captures.length, 1, 'one capture command for the final step');
  const trace = JSON.parse(await readFile(result.trace, 'utf8'));
  assert.equal(trace.options.capture, 'last');
  assert.equal(trace.steps[0].screenshot, null);
  assert.ok((await stat(trace.steps[1].screenshot.path)).size > 0);

  const shot = await ctx.client.evidence(result.runId, { inline: true });
  assert.equal(shot.step, 2, 'the default evidence is the final step');
  assert.equal(`data:image/jpeg;base64,${shot.data}`, JPEG);
  await assert.rejects(ctx.client.evidence(result.runId, { step: 1 }), { status: 404, code: 'no_evidence' });
});

test('e2e: a stale page is retried, observe/act go through the hub, and a lease_update reaches the extension', async t => {
  const ctx = await setup(t);
  const { requestId, leaseId } = await approvedRequest(ctx);

  // The extension rejects the first action as stale; the runtime re-observes and the provider chooses again.
  ctx.bridge.failNext.push(bridgeError('stale', 'Stale observation'));
  const observesBefore = ctx.bridge.observes;
  const { result } = await ctx.client.run({ requestId, instruction: 'Open About', expectation: { urlIncludes: '/about' } });
  assert.equal(result.status, 'completed');
  assert.equal(result.steps.length, 1, 'the stale attempt is not recorded as a step');
  assert.equal(ctx.bridge.executions.length, 2);
  assert.equal(ctx.bridge.observes - observesBefore, 2, 'one initial observe plus one re-observe after stale');
  assert.equal(result.cost.decisions, 2);

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
  const after = await ctx.client.run({ requestId, instruction: 'Open Home' });
  assert.equal(after.result.code, 'request_closed');
  assert.equal(after.result.trace, null);
});

test('e2e: user Pause ends the run as needs_user/paused; Resume grants a new lease and a new run works', async t => {
  const ctx = await setup(t, { provider: () => slowProvider(300) });
  const { requestId, leaseId } = await approvedRequest(ctx);

  const running = await ctx.client.startRun({ requestId, operation: 'run', instruction: 'Open Members', waitMs: 0,
    expectation: { urlIncludes: '/members' } });
  assert.equal(running.state, 'running');
  ctx.ext.send('status', { leaseId, status: 'paused', reason: 'paused' });
  const paused = await ctx.client.waitForRun(running);
  assert.equal(paused.result.status, 'needs_user');
  assert.equal(paused.result.code, 'paused');
  assert.equal(paused.result.needs.message, LEASE_MESSAGES.paused);
  assert.deepEqual(paused.result.lease, { requestId, state: 'paused' });

  const still = await ctx.client.wait({ requestId, maxMs: 100 });
  assert.equal(still.state, 'paused');
  assert.equal(still.request.stateReason, 'paused');
  const blocked = await ctx.client.run({ requestId, instruction: 'Open Members' });
  assert.equal(blocked.result.code, 'paused');
  assert.equal(blocked.result.trace, null);

  // Resume in the popup is a new lease message for the same request.
  const waiting = ctx.client.waitForTab(requestId, { timeoutMs: 5000 });
  const resumed = await ctx.ext.lease({ requestId, tabId: 1, origin: ORIGIN });
  assert.equal(resumed.ok, true);
  assert.notEqual(resumed.data.leaseId, leaseId, 'resume grants a new leaseId');
  assert.equal((await waiting).state, 'active');

  const done = await ctx.client.run({ requestId, instruction: 'Open Members', expectation: { urlIncludes: '/members' } });
  assert.equal(done.result.status, 'completed');
});

test('e2e: POST stop cancels a run and keeps the lease; user Stop releases the lease', async t => {
  const ctx = await setup(t, { provider: () => slowProvider(300) });
  const { requestId, leaseId } = await approvedRequest(ctx);

  const first = await ctx.client.startRun({ requestId, operation: 'run', instruction: 'Open Members', waitMs: 0 });
  await assert.rejects(ctx.client.startRun({ requestId, operation: 'run', instruction: 'Again', waitMs: 0 }),
    { status: 409, code: 'run_active' });
  const stopped = await ctx.client.stop(first.runId);
  assert.equal(stopped.state, 'done');
  assert.equal(stopped.result.status, 'stopped');
  assert.equal(stopped.result.code, 'cancelled');
  assert.equal((await ctx.client.getRequest(requestId)).state, 'active');

  const second = await ctx.client.startRun({ requestId, operation: 'run', instruction: 'Open Members', waitMs: 0 });
  ctx.ext.send('status', { leaseId, status: 'stopped', reason: 'stopped' });
  const userStopped = await ctx.client.waitForRun(second);
  assert.equal(userStopped.result.status, 'stopped');
  assert.equal(userStopped.result.code, 'stopped');
  assert.equal(userStopped.result.needs.message, LEASE_MESSAGES.stopped);
  const view = await ctx.client.getRequest(requestId);
  assert.deepEqual([view.state, view.stateReason], ['released', 'stopped']);
  const after = await ctx.client.run({ requestId, instruction: 'Open Members' });
  assert.equal(after.result.code, 'stopped');
});

test('e2e: blocking calls are clamped (45 s by default) and return the current snapshot, not an error', async t => {
  assert.equal(MAX_WAIT_MS, 45_000);
  assert.equal(clampWait(120_000, 30_000), 45_000);
  assert.equal(clampWait(undefined, 40_000), 40_000);

  // The default daemon accepts maxMs above 45000 (clamped, not rejected) and still wakes early.
  const ctx = await setup(t);
  const created = await ctx.client.requestTab({ origins: [ORIGIN], reason: 'Clamp check' });
  const raw = call(ctx.daemon.port, 'POST', '/v1/wait', { requestId: created.requestId, maxMs: 120_000 },
    { token: ctx.daemon.token });
  await delay(50);
  await ctx.ext.lease({ requestId: created.requestId, tabId: 1, origin: ORIGIN });
  const woke = await raw;
  assert.equal(woke.status, 200);
  assert.equal(woke.body.state, 'active');

  // With a lowered ceiling the clamp itself is observable without waiting 45 s.
  const quick = await setup(t, { maxWaitMs: 300, provider: () => slowProvider(250) });
  const pending = await quick.client.requestTab({ origins: [ORIGIN], reason: 'Clamp check' });
  let started = Date.now();
  const timedOut = await call(quick.daemon.port, 'POST', '/v1/wait', { requestId: pending.requestId, maxMs: 45_000 },
    { token: quick.daemon.token });
  assert.equal(timedOut.status, 200);
  assert.equal(timedOut.body.state, 'pending');
  assert.ok(Date.now() - started < 2000, `wait returned after ${Date.now() - started} ms`);
  await quick.ext.lease({ requestId: pending.requestId, tabId: 1, origin: ORIGIN });
  started = Date.now();
  const running = await quick.client.startRun({ requestId: pending.requestId, operation: 'run',
    instruction: 'Open Members', expectation: { urlIncludes: '/members' }, waitMs: 45_000 });
  assert.equal(running.state, 'running');
  assert.ok(Date.now() - started < 2000);
  assert.ok(running.progress.maxActions >= 1);
  const done = await quick.client.waitForRun(running);
  assert.equal(done.result.status, 'completed');
});

test('e2e MCP: the stdio server drives the same flow against the real daemon and hub', async t => {
  const ctx = await setup(t);
  const mcp = spawnMcp({ PATH: process.env.PATH, HOME: ctx.home, FAI_HOME: ctx.home,
    FAI_DAEMON_PORT: String(ctx.daemon.port), FAI_MCP_MAX_CALL_MS: '4000', FAI_MCP_APPROVAL_WAIT_MS: '2000' });
  t.after(() => mcp.child.kill('SIGKILL'));
  await mcp.initialize();

  const status = await mcp.callTool('fai_browser_status');
  assert.equal(status.isError, undefined, status.content[0].text);
  const statusData = mcpData(status);
  assert.equal(statusData.daemon.port, ctx.daemon.port);
  assert.equal(statusData.extension.transport, 'websocket');

  // One call requests the tab and waits; nobody approves within the 4 s budget, so it reports select_tab.
  const requested = mcpData(await mcp.callTool('fai_browser_run', { origins: [ORIGIN], reason: 'Check members',
    instruction: 'Open Members' }));
  const { requestId } = requested;
  assert.match(requestId, /^req_/);
  assert.equal(requested.code, 'select_tab');
  assert.match(requested.next.text, /fai_browser_run again with requestId/);
  const pushed = await ctx.ext.client.message(message => message.type === 'requests'
    && message.requests.some(request => request.requestId === requestId));
  const preview = pushed.requests.find(request => request.requestId === requestId);
  assert.equal(preview.client, 'test-host');
  assert.equal(preview.instruction, 'Open Members');

  const reply = await ctx.ext.lease({ requestId, tabId: 1, origin: ORIGIN });
  assert.equal(reply.ok, true);
  const active = await mcp.callTool('fai_browser_wait', { maxMs: 2000 });
  assert.equal(mcpData(active).state, 'active');

  const run = await mcp.callTool('fai_browser_run', { origins: [ORIGIN], instruction: 'Open Members',
    expectation: { urlIncludes: '/members' }, maxActions: 4, returnImages: 'final' });
  assert.equal(run.isError, undefined, run.content[0].text);
  assert.equal(run.structuredContent, undefined);
  const result = mcpData(run);
  assert.match(run.content[0].text, /^verdict: verified \(oversight none\); status completed \(expectation_passed\), verified: true$/m);
  assert.equal(result.state, 'done');
  assert.equal(result.status, 'completed');
  assert.equal(result.verification.passed, true);
  assert.equal(result.requestId, requestId, 'the approved request is reused');
  assert.equal(result.next.kind, 'answer', 'no answerQuestion: a verified outcome is simply reported');
  assert.equal(result.verdict.budget.callsUsed, 1);
  assert.equal(run.content[1].type, 'image');
  assert.equal(`data:image/jpeg;base64,${run.content[1].data}`, JPEG);

  const observedResult = await mcp.callTool('fai_browser_observe', { returnImages: 'final' });
  const observed = mcpData(observedResult);
  assert.equal(observed.state, 'ok');
  assert.equal(observedResult.content[1].type, 'image');
  const home = observed.actions.find(action => action.description === 'click "Home"');
  assert.match(observed.text, new RegExp(`^${home.id}  click "Home"$`, 'm'));
  const acted = await mcp.callTool('fai_browser_act', { actionId: home.id,
    revision: observed.revision, expectation: { titleEquals: 'Home' } });
  assert.equal(mcpData(acted).status, 'completed');

  // capture defaults to last: the final step's screenshot is the evidence; earlier steps have none.
  const evidence = await mcp.callTool('fai_browser_evidence', { runId: result.runId });
  assert.equal(mcpData(evidence).step, 2);
  assert.equal(evidence.content[1].type, 'image');
  const earlier = await mcp.callTool('fai_browser_evidence', { runId: result.runId, step: 1 });
  assert.equal(earlier.isError, true);
  assert.match(earlier.content[0].text, /no screenshot/i);
  const trace = await mcp.callTool('fai_browser_evidence', { runId: result.runId, kind: 'trace' });
  assert.equal(JSON.parse(trace.content[1].text).runId, result.runId);

  const idle = await mcp.callTool('fai_browser_stop', {});
  assert.equal(mcpData(idle).stopped, false);

  const updated = ctx.ext.client.message(message => message.type === 'lease_update'
    && message.leaseId === reply.data.leaseId);
  const released = await mcp.callTool('fai_browser_stop', { requestId });
  assert.equal(mcpData(released).state, 'released');
  assert.equal((await updated).state, 'released');
  const closed = await mcp.callTool('fai_browser_run', { requestId, instruction: 'Open Home' });
  assert.equal(closed.isError, undefined);
  assert.equal(mcpData(closed).code, 'request_closed');
  assert.equal(await mcp.close(), 0);
});

test('e2e MCP: a link floor from config.json hands a doubtful choice back as a choose receipt for fai_browser_act',
  async t => {
  const unsure = () => ({
    model: 'unsure',
    async decide(observation, actions) {
      const members = actions.find(action => action.label === 'Members') ?? actions[0];
      const home = actions.find(action => action.label === 'Home') ?? actions[1];
      return { actionId: home.id, confidence: 0.35, probabilities: { [home.id]: 0.35, [members.id]: 0.3, done: 0.2 } };
    },
  });
  // Links are not gated by default (linkFloor 0); config.json raises the floor for every run of this daemon.
  const ctx = await setup(t, { provider: unsure, config: { thresholds: { linkFloor: 0.8 } } });
  ctx.bridge.path = '/about';
  const { requestId } = await approvedRequest(ctx);
  await assert.rejects(ctx.client.run({ requestId, instruction: 'Open Members', minConfidence: 2 }),
    { status: 400, code: 'invalid_options' });

  const mcp = spawnMcp({ PATH: process.env.PATH, HOME: ctx.home, FAI_HOME: ctx.home,
    FAI_DAEMON_PORT: String(ctx.daemon.port) });
  t.after(() => mcp.child.kill('SIGKILL'));
  await mcp.initialize();
  const invalid = await mcp.callTool('fai_browser_run', { requestId, instruction: 'Open Members', minConfidence: 1.5 });
  assert.equal(invalid.isError, true);
  assert.match(invalid.content[0].text, /minConfidence must be at most 1/);

  const low = await mcp.callTool('fai_browser_run', { requestId, instruction: 'Open Members', minConfidence: 0.8,
    expectation: { urlIncludes: '/members' } });
  assert.equal(low.isError, undefined, low.content[0].text);
  const content = mcpData(low);
  assert.equal(content.status, 'needs_host');
  assert.equal(content.code, 'low_confidence');
  assert.equal(ctx.bridge.executions.length, 0, 'nothing ran');
  assert.equal(content.needs.revision, '/about#1');
  assert.deepEqual(content.verdict.decide.options.map(option => option.label),
    ['Click link 2: Home', 'Click link 1: Members']);
  assert.equal(content.next.kind, 'choose');
  assert.equal(content.verdict.oversight, 'choose');
  assert.match(content.next.text, /fai_browser_act/);
  assert.ok(content.next.text.includes(content.needs.revision));
  const trace = JSON.parse(await readFile(content.trace, 'utf8'));
  assert.equal(trace.options.minConfidence, 0.8);
  assert.deepEqual(trace.options.thresholds, { linkFloor: 0.8 });
  assert.equal(trace.needs.alternatives.length, 2);

  const members = content.verdict.decide.options.find(option => option.label.endsWith('Members'));
  const acted = await mcp.callTool('fai_browser_act', { requestId, actionId: members.id,
    revision: content.needs.revision, expectation: { urlIncludes: '/members' } });
  assert.equal(mcpData(acted).status, 'completed', acted.content[0].text);
  assert.equal(ctx.bridge.executions.length, 1);
  assert.equal(await mcp.close(), 0);
});

// A chain of 15 pages, each with one "Next" link, for a 15-step list of fast hops.
const CHAIN = Object.fromEntries([['/', 1], ...Array.from({ length: 15 }, (_, i) => [`/p${i + 1}`, i + 2])]
  .map(([path, next]) => [path, { title: `Chain ${next - 1}`, text: `Chain page ${next - 1} of 15`,
    controls: next <= 15 ? [{ id: '1', role: 'link', label: 'Next', href: `${ORIGIN}/p${next}`, enabled: true,
      risk: 'navigation' }] : [] }]));

/** A done-aware provider with the slim guards request (like Jev): clicks Next, done stays low, every decide takes `ms`. */
function chainProvider(ms) {
  const counts = { decide: 0, confirm: 0 };
  return {
    model: 'chain',
    counts,
    async decide(observation, actions) {
      counts.decide++;
      await delay(ms);
      const next = actions.find(action => action.label === 'Next');
      return { actionId: next?.id ?? 'handoff', confidence: 0.9, done: { probability: 0.3 } };
    },
    async confirm() {
      counts.confirm++;
      return { done: { probability: 0.3 }, guards: { blocked: 0.01, injection: 0.01 } };
    },
  };
}

test('e2e MCP: a 15-step list of fast hops outlasts the call window and finishes through fai_browser_wait', async t => {
  const ctx = await setup(t, { pages: CHAIN, provider: () => chainProvider(150) });
  // A 3 s call window leaves about 1 s per call after the 2 s daemon margin: the list (15 x ~150 ms) outlasts it.
  const mcp = spawnMcp({ PATH: process.env.PATH, HOME: ctx.home, FAI_HOME: ctx.home,
    FAI_DAEMON_PORT: String(ctx.daemon.port), FAI_MCP_MAX_CALL_MS: '3000', FAI_MCP_APPROVAL_WAIT_MS: '1000' });
  t.after(() => mcp.child.kill('SIGKILL'));
  await mcp.initialize();
  const { requestId } = await approvedRequest(ctx);
  // The start page is "Chain page 0 of 15"; step i (1-15) clicks Next once and lands on /p(i), "Chain page i of 15".
  const steps = Array.from({ length: 14 }, (_, i) => ({ instruction: 'Click Next.',
    expectation: { textIncludes: `Chain page ${i + 1} of 15` }, maxActions: 3 }));
  steps.push({ instruction: 'Click Next.', expectation: { urlIncludes: '/p15' }, maxActions: 3 });
  const started = Date.now();
  const first = await mcp.callTool('fai_browser_run', { requestId, steps }, { meta: { progressToken: 'chain' } });
  assert.equal(first.isError, undefined, first.content[0].text);
  const firstData = mcpData(first);
  assert.equal(firstData.state, 'running', 'the list is still running when the call window closes');
  assert.equal(firstData.next.kind, 'wait');
  const { runId } = firstData;
  assert.match(firstData.next.text, new RegExp(`fai_browser_wait with runId ${runId}`));
  let done = null;
  let waits = 0;
  while (!done && waits < 10) {
    waits++;
    const waited = await mcp.callTool('fai_browser_wait', { runId, maxMs: 45_000 }, { meta: { progressToken: `w${waits}` } });
    assert.equal(waited.isError, undefined, waited.content[0].text);
    const data = mcpData(waited);
    if (data.state === 'done') done = data;
    else assert.equal(data.next.kind, 'wait');
  }
  assert.ok(done, 'the list finished within the waits');
  assert.equal(done.status, 'completed', JSON.stringify(done.verdict));
  assert.equal(done.verification.passed, true);
  assert.equal(done.stepResults.length, 15, 'the receipt carries every step');
  assert.ok(done.stepResults.every(step => step.passed && step.code === 'expectation_passed'));
  assert.equal(done.steps.length, 15, 'one click per step: no step overshot its page');
  assert.ok(done.verdict.why.includes('steps:15/15'));
  assert.equal(ctx.bridge.path, '/p15');
  // Each step ended on its own expectation: 15 decides and 15 end-of-step guards requests, no terminal decides.
  const counts = { decide: 0, confirm: 0 };
  for (const made of ctx.providers) for (const key of Object.keys(counts)) counts[key] += made.counts[key];
  assert.deepEqual(counts, { decide: 15, confirm: 15 });
  // Progress notifications came from the run call and from the waits.
  const progress = mcp.messages.filter(message => message.method === 'notifications/progress');
  assert.ok(progress.some(note => note.params.progressToken === 'chain'));
  assert.ok(progress.some(note => note.params.progressToken !== 'chain'), 'the wait calls report progress too');
  assert.ok(progress.filter(note => note.params.progressToken === 'chain').every(note => note.params.total === 45),
    'the run call reports the list budget: 15 x 3 actions');
  assert.ok(Date.now() - started >= 2000, 'the run took longer than one call window');
  assert.equal(await mcp.close(), 0);
});

test('e2e MCP: a 15-step list that cannot finish inside the request maxMs ends budget_exhausted with its stepResults', async t => {
  const ctx = await setup(t, { pages: CHAIN, provider: () => chainProvider(700) });
  const mcp = spawnMcp({ PATH: process.env.PATH, HOME: ctx.home, FAI_HOME: ctx.home,
    FAI_DAEMON_PORT: String(ctx.daemon.port), FAI_MCP_MAX_CALL_MS: '3000', FAI_MCP_APPROVAL_WAIT_MS: '1000' });
  t.after(() => mcp.child.kill('SIGKILL'));
  await mcp.initialize();
  const { requestId } = await approvedRequest(ctx);
  const steps = Array.from({ length: 15 }, (_, i) => ({ instruction: 'Click Next.',
    expectation: { urlIncludes: `/p${i + 1}` }, maxActions: 3 }));
  const started = Date.now();
  // 15 x 700 ms decides is over 10 s; the request's time budget is 6 s, so the list is clamped to what is left.
  let result = mcpData(await mcp.callTool('fai_browser_run', { requestId, steps, maxMs: 6000 }));
  let waits = 0;
  while (result.state === 'running' && waits < 10) {
    waits++;
    result = mcpData(await mcp.callTool('fai_browser_wait', { runId: result.runId, maxMs: 45_000 }));
  }
  assert.equal(result.state, 'done');
  assert.equal(result.status, 'budget_exhausted', JSON.stringify(result.verdict));
  assert.ok(Array.isArray(result.stepResults) && result.stepResults.length === 15, 'every step is listed');
  const passed = result.stepResults.filter(step => step.passed).length;
  assert.ok(passed >= 3 && passed < 15, `some steps ran, not all (${passed})`);
  assert.ok(Date.now() - started < 10_000, 'the request budget, not the 90 s list default, bounded the run');
  assert.equal(await mcp.close(), 0);
});
