import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDaemon, clampWait, MAX_WAIT_MS } from '../src/daemon.js';
import { createLogger, homePaths } from '../src/home.js';
import { LEASE_MESSAGES } from '../src/result.js';
import { ORIGIN, clickProvider } from './runtime-fixtures.js';
import { call, createFakeHub } from './helpers/fake-hub.js';

const KEY = 'jev-test-key-must-not-be-logged-9137';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function slowProvider(ms, labels = ['About', 'Members'], fallback = 'done') {
  const inner = clickProvider(labels, { fallback });
  return {
    model: 'slow',
    async decide(...args) {
      await delay(ms);
      return inner.decide(...args);
    },
  };
}

async function setup(t, options = {}) {
  const home = await mkdtemp(join(tmpdir(), 'fai-daemon-api-'));
  if (options.config) await writeFile(join(home, 'config.json'), JSON.stringify(options.config));
  const hub = createFakeHub({ bridgeOptions: options.bridgeOptions });
  const env = { TYPESAFE_API_KEY: KEY, ...options.env };
  const log = createLogger(homePaths({ home, env }));
  let shutdowns = 0;
  const providerFactory = options.providerFactory
    ?? (() => (options.provider ? options.provider() : clickProvider(['About', 'Members'])));
  const daemon = createDaemon({
    driver: 'jev',
    home,
    env,
    port: 0,
    hub,
    log,
    now: options.now,
    maxWaitMs: options.maxWaitMs,
    sweepIntervalMs: 60_000,
    providerFactory,
    onShutdownRequest: () => {
      shutdowns++;
    },
  });
  await daemon.listen();
  t.after(async () => {
    await daemon.close();
    log.close();
    await rm(home, { recursive: true, force: true });
  });
  const api = (method, path, body, extra = {}) => call(daemon.port, method, path, body, { token: daemon.token, ...extra });
  return { home, hub, daemon, api, env, logFile: log.path, shutdowns: () => shutdowns };
}

async function requestTab(ctx, body = {}) {
  const response = await ctx.api('POST', '/v1/requests', { origins: [ORIGIN], reason: 'Check the page', ...body });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.requestId;
}

async function approved(ctx, body = {}) {
  const requestId = await requestTab(ctx, body);
  const reply = await ctx.hub.approve(requestId);
  assert.ok(reply.leaseId, JSON.stringify(reply));
  return requestId;
}

test('tab access comes only from extension approval, never host request or action fields', async t => {
  const ctx = await setup(t);
  const requestId = await requestTab(ctx, { mode: 'interactive' });
  const denied = await ctx.api('POST', '/v1/requests', { origins: [ORIGIN], reason: 'Tamper', tabMode: 'multiple' });
  assert.equal(denied.status, 400);
  const invalid = await ctx.hub.emit({ type: 'lease', requestId, tabId: 7, origin: ORIGIN, level: 'interactive', tabMode: 'unlimited' });
  assert.equal(invalid.error.code, 'bad_request');
  const grant = await ctx.hub.emit({ type: 'lease', requestId, tabId: 7, origin: ORIGIN, level: 'interactive', tabMode: 'multiple' });
  assert.equal(grant.grant.tabMode, 'multiple');
  assert.equal(ctx.hub.bound.at(-1).tabMode, 'multiple');
  const observed = await ctx.api('POST', '/v1/observe', { requestId, capture: false });
  assert.equal(observed.body.permissions.tabMode, 'multiple');
  const tamper = await ctx.api('POST', '/v1/act', { requestId, openTab: ORIGIN, tabMode: 'multiple' });
  assert.equal(tamper.status, 400);
  const foreign = await ctx.api('POST', '/v1/act', { requestId, openTab: 'https://foreign.example/', capture: 'none', waitMs: 5000 });
  assert.equal(foreign.body.result.code, 'cross_origin');
});

test('client API rejects Origin, foreign Host, missing or wrong token; health is open', async t => {
  const ctx = await setup(t);
  const health = await call(ctx.daemon.port, 'GET', '/v1/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.service, 'fai-browser');
  assert.equal(health.body.pid, process.pid);

  assert.equal((await call(ctx.daemon.port, 'GET', '/v1/status')).status, 401);
  const wrong = await call(ctx.daemon.port, 'GET', '/v1/status', undefined, { token: 'f'.repeat(64) });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.error.code, 'unauthorized');

  const origin = await ctx.api('GET', '/v1/status', undefined, { headers: { Origin: 'https://evil.example' } });
  assert.equal(origin.status, 403);
  assert.equal(origin.body.error.code, 'forbidden_origin');
  const extOrigin = await call(ctx.daemon.port, 'GET', '/v1/health', undefined,
    { headers: { Origin: 'chrome-extension://abc' } });
  assert.equal(extOrigin.body.error.code, 'forbidden_origin');

  const host = await ctx.api('GET', '/v1/status', undefined, { host: 'evil.example:80' });
  assert.equal(host.status, 403);
  assert.equal(host.body.error.code, 'bad_host');
  const localhost = await ctx.api('GET', '/v1/status', undefined, { host: `localhost:${ctx.daemon.port}` });
  assert.equal(localhost.status, 200);

  const status = await ctx.api('GET', '/v1/status');
  assert.equal(status.body.daemon.port, ctx.daemon.port);
  assert.equal(status.body.extension.transport, 'websocket');
  assert.equal(status.body.provider.keyConfigured, true);
  assert.deepEqual(status.body.requests, []);

  assert.equal((await ctx.api('GET', '/v1/nope')).body.error.code, 'not_found');
  const bad = await ctx.api('POST', '/v1/requests', undefined, { raw: '{oops' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'bad_request');
  const big = await ctx.api('POST', '/v1/requests', undefined, { raw: JSON.stringify({ reason: 'x'.repeat(1_100_000) }) });
  assert.equal(big.status, 413);
  assert.equal(big.body.error.code, 'too_large');
  // Extension routes are not served by the client API.
  assert.equal((await call(ctx.daemon.port, 'POST', '/commands')).status, 404);
});

test('request validation and the pending limit', async t => {
  const ctx = await setup(t);
  const cases = [
    { origins: ['https://example.com/path'], reason: 'r' },
    { origins: ['ftp://example.com'], reason: 'r' },
    { origins: [], reason: 'r' },
    { origins: [ORIGIN] },
    { origins: [ORIGIN], reason: 'x'.repeat(201) },
    { origins: [ORIGIN], reason: 'r', mode: 'admin' },
    { origins: [ORIGIN], reason: 'r', ttlMs: 10 },
    { origins: [ORIGIN], reason: 'r', extra: true },
  ];
  for (const body of cases) {
    const response = await ctx.api('POST', '/v1/requests', body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(response.body.error.code, 'invalid_options');
  }
  const created = await ctx.api('POST', '/v1/requests', {
    origins: [ORIGIN], reason: 'Check members', instruction: 'Open Members', mode: 'reversible',
  }, { headers: { 'X-Fai-Client': 'claude-code/1234' } });
  assert.equal(created.status, 201);
  assert.match(created.body.requestId, /^req_[A-Za-z0-9_-]{12}$/);
  assert.equal(created.body.state, 'pending');
  assert.equal(created.body.extensionConnected, true);
  assert.equal(created.body.request.client, 'claude-code');
  assert.equal(created.body.request.mode, 'reversible');
  assert.ok(Date.parse(created.body.expiresAt) > Date.now());
  assert.deepEqual(ctx.hub.published.at(-1).map(view => view.requestId), [created.body.requestId]);

  for (let i = 0; i < 4; i++) await requestTab(ctx, { reason: `Check the page ${i}` });
  const limited = await ctx.api('POST', '/v1/requests', { origins: [ORIGIN], reason: 'one too many' });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error.code, 'too_many_requests');
  assert.equal(limited.body.error.retryable, true);

  const view = await ctx.api('GET', `/v1/requests/${created.body.requestId}`);
  assert.equal(view.body.reason, 'Check members');
  assert.equal((await ctx.api('GET', '/v1/requests')).body.requests.length, 5);
  const unknown = await ctx.api('GET', '/v1/requests/req_missing');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error.code, 'unknown_request');
  assert.match(unknown.body.error.message, /Request a tab again/);
});

test('an identical repeat from the same client instance while the request waits returns it; any difference is a new request', async t => {
  let clock = Date.now();
  const ctx = await setup(t, { now: () => clock });
  const body = { origins: [ORIGIN, 'https://other.example'], reason: 'Check members', instruction: 'Open Members', mode: 'reversible' };
  const session = { headers: { 'X-Fai-Client': 'claude-code/0f6c1d2e-aaaa-4bbb-8ccc-123456789abc' } };
  const first = await ctx.api('POST', '/v1/requests', body, session);
  assert.equal(first.status, 201);
  const published = ctx.hub.published.length;
  // The same MCP server (one instance id) retries: the same pending request, nothing new reaches the extension.
  const again = await ctx.api('POST', '/v1/requests', { ...body, origins: [ORIGIN, 'https://other.example', ORIGIN] }, session);
  assert.equal(again.status, 200);
  assert.equal(again.body.requestId, first.body.requestId);
  assert.equal(again.body.repeated, true);
  assert.equal(again.body.state, 'pending');
  assert.equal(again.body.expiresAt, first.body.expiresAt, 'a repeat does not extend the wait');
  assert.equal(again.body.request.clientInstance, undefined, 'the instance id is never shown');
  assert.equal(ctx.hub.published.length, published, 'the extension sees no new request');
  assert.equal((await ctx.api('GET', '/v1/requests')).body.requests.length, 1);
  // Another session of the same agent (same name, another instance id), a client without an instance id, or any
  // other argument: a new request.
  const cases = [
    [{}, { headers: { 'X-Fai-Client': 'claude-code/11111111-2222-4333-8444-555555555555' } }],
    [{}, { headers: { 'X-Fai-Client': 'claude-code' } }],
    [{ mode: 'interactive' }], [{ reason: 'Check members again' }], [{ instruction: 'Open Settings' }], [{ origins: [ORIGIN] }],
  ];
  for (const [variant, headers] of cases) {
    const created = await ctx.api('POST', '/v1/requests', { ...body, ...variant }, headers ?? session);
    assert.equal(created.status, 201, JSON.stringify([variant, headers]));
    assert.notEqual(created.body.requestId, first.body.requestId);
    await ctx.api('DELETE', `/v1/requests/${created.body.requestId}`);
  }
  // Past its time (not yet swept), the request is not handed out again.
  clock += 10 * 60_000 + 1;
  const late = await ctx.api('POST', '/v1/requests', body, session);
  assert.equal(late.status, 201);
  assert.notEqual(late.body.requestId, first.body.requestId);
  // Once the request no longer waits (approved, denied, cancelled), the same call is a new request.
  await ctx.api('DELETE', `/v1/requests/${late.body.requestId}`);
  const after = await ctx.api('POST', '/v1/requests', body, session);
  assert.equal(after.status, 201);
  assert.notEqual(after.body.requestId, late.body.requestId);
});

test('request url: the start page on the origins, else a default; on the view and the pushed list', async t => {
  const ctx = await setup(t);
  for (const url of ['ftp://example.com/', 'not a url', `${ORIGIN}/${'x'.repeat(2100)}`, 42]) {
    const response = await ctx.api('POST', '/v1/requests', { origins: [ORIGIN], reason: 'r', url });
    assert.equal(response.status, 400, String(url).slice(0, 40));
    assert.equal(response.body.error.code, 'invalid_options');
  }
  const off = await ctx.api('POST', '/v1/requests', { origins: [ORIGIN], reason: 'r', url: 'https://elsewhere.example.org/x' });
  assert.equal(off.status, 422);
  assert.equal(off.body.error.code, 'origin_not_granted');

  const create = async body => {
    const response = await ctx.api('POST', '/v1/requests', { origins: [ORIGIN], reason: 'r', ...body });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body;
  };
  const given = await create({ url: `${ORIGIN}/members?tab=all` });
  assert.equal(given.request.url, `${ORIGIN}/members?tab=all`);
  assert.equal(ctx.hub.published.at(-1).find(view => view.requestId === given.requestId).url, `${ORIGIN}/members?tab=all`);
  assert.equal((await ctx.api('GET', `/v1/requests/${given.requestId}`)).body.url, `${ORIGIN}/members?tab=all`);

  const fallback = await create({ origins: ['https://*.example.com', ORIGIN] });
  assert.equal(fallback.request.url, `${ORIGIN}/`);
  const root = await create({ origins: ['https://*.example.com'] });
  assert.equal(root.request.url, 'https://example.com/');
  const sub = await create({ origins: ['https://*.example.com'], url: 'https://docs.example.com/a' });
  assert.equal(sub.request.url, 'https://docs.example.com/a');
});

test('request, approval wakes wait early, run completes with a trace, evidence and lease', async t => {
  const ctx = await setup(t);
  const requestId = await requestTab(ctx);
  const started = Date.now();
  const waiting = ctx.api('POST', '/v1/wait', { requestId, maxMs: 20_000 });
  await delay(50);
  const reply = await ctx.hub.approve(requestId);
  const waited = await waiting;
  assert.ok(Date.now() - started < 5000, 'wait woke on the state change');
  assert.equal(waited.body.state, 'active');
  assert.equal(waited.body.request.lease.leaseId, reply.leaseId);
  assert.equal(waited.body.request.lease.origin, ORIGIN);
  assert.deepEqual(ctx.hub.bound.at(-1).allowedOrigins, [ORIGIN]);

  const run = await ctx.api('POST', '/v1/runs', {
    requestId, operation: 'run', instruction: 'Open Members', expectation: { textIncludes: 'Ada' }, capture: 'each',
  });
  assert.equal(run.status, 200);
  assert.equal(run.body.state, 'done');
  const { result } = run.body;
  assert.equal(result.status, 'completed');
  assert.equal(result.runId, run.body.runId);
  assert.equal(result.verification.passed, true);
  assert.equal(result.cost.decisions, 2);
  assert.ok(result.cost.elapsedMs >= 0);
  assert.ok(result.page.digest.includes('Ada, Grace, Linus'));
  assert.equal(result.page.textExcerpt, undefined, 'the excerpt is only a fallback for an empty digest');
  assert.deepEqual(result.lease, { requestId, state: 'active' });
  assert.ok(result.trace.startsWith(ctx.home));
  const trace = JSON.parse(await readFile(result.trace, 'utf8'));
  assert.equal(trace.operation, 'run');
  assert.equal(trace.options.requestId, requestId);
  assert.equal(result.steps.length, 2);
  // Screenshots stay in the trace (and behind the evidence route); the lean result has no paths.
  assert.equal(result.steps[1].screenshot, undefined);
  assert.ok(trace.steps[1].screenshot.path.endsWith('2.jpg'));

  const snapshot = await ctx.api('GET', `/v1/runs/${run.body.runId}`);
  assert.equal(snapshot.body.state, 'done');
  assert.equal(snapshot.body.result.status, 'completed');

  const list = await ctx.api('GET', `/v1/runs?limit=5&requestId=${requestId}`);
  assert.deepEqual(list.body.runs.map(entry => entry.runId), [run.body.runId]);
  assert.equal(list.body.runs[0].status, 'completed');

  const evidence = await ctx.api('GET', `/v1/runs/${run.body.runId}/evidence`);
  assert.equal(evidence.body.step, 2);
  assert.equal(evidence.body.mimeType, 'image/jpeg');
  assert.equal(evidence.body.path, trace.steps[1].screenshot.path);
  assert.equal(evidence.body.bytes, 1);
  assert.equal(evidence.body.data, undefined);
  const inline = await ctx.api('GET', `/v1/runs/${run.body.runId}/evidence?step=1&inline=1`);
  assert.equal(inline.body.step, 1);
  assert.equal(inline.body.data, 'YQ==');
  const traceEvidence = await ctx.api('GET', `/v1/runs/${run.body.runId}/evidence?kind=trace`);
  assert.equal(traceEvidence.body.path, result.trace);
  assert.equal(traceEvidence.body.trace.runId, run.body.runId);
  const missing = await ctx.api('GET', `/v1/runs/${run.body.runId}/evidence?step=9`);
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'no_evidence');
  assert.equal((await ctx.api('GET', '/v1/runs/nope/evidence')).body.error.code, 'unknown_run');
  assert.equal((await ctx.api('GET', '/v1/runs/nope')).body.error.code, 'unknown_run');

  const status = await ctx.api('GET', '/v1/status');
  assert.equal(status.body.requests[0].state, 'active');
  assert.equal(status.body.runs.recent[0].runId, run.body.runId);
});

test('runs before approval and after the request ends return results, not HTTP errors', async t => {
  const ctx = await setup(t);
  const requestId = await requestTab(ctx);
  const pending = await ctx.api('POST', '/v1/runs', { requestId, instruction: 'Open', expectation: { urlIncludes: '/x' } });
  assert.equal(pending.status, 200);
  assert.equal(pending.body.state, 'done');
  assert.equal(pending.body.runId, null);
  assert.equal(pending.body.result.status, 'needs_user');
  assert.equal(pending.body.result.code, 'select_tab');
  assert.equal(pending.body.result.needs.message, LEASE_MESSAGES.select_tab);
  assert.equal(pending.body.result.trace, null);
  assert.deepEqual(pending.body.result.verification.expectation, { urlIncludes: '/x' });
  assert.deepEqual(pending.body.result.lease, { requestId, state: 'pending' });

  const cancelled = await ctx.api('DELETE', `/v1/requests/${requestId}`, { reason: 'done' });
  assert.deepEqual(cancelled.body, { requestId, state: 'cancelled' });
  const again = await ctx.api('DELETE', `/v1/requests/${requestId}`);
  assert.deepEqual(again.body, { requestId, state: 'cancelled' });
  const closed = await ctx.api('POST', '/v1/runs', { requestId, instruction: 'Open' });
  assert.equal(closed.body.result.status, 'needs_host');
  assert.equal(closed.body.result.code, 'request_closed');
  const waited = await ctx.api('POST', '/v1/wait', { requestId, maxMs: 1000 });
  assert.equal(waited.body.state, 'cancelled');
  const observed = await ctx.api('POST', '/v1/observe', { requestId });
  assert.equal(observed.body.state, 'done');
  assert.equal(observed.body.result.code, 'request_closed');
});

test('waitMs returns running with progress; wait afterStep reports steps, then done', async t => {
  const ctx = await setup(t, { provider: () => slowProvider(150) });
  const requestId = await approved(ctx);
  const first = await ctx.api('POST', '/v1/runs', {
    requestId, instruction: 'Find members', maxActions: 4, expectation: { textIncludes: 'Ada' }, waitMs: 50,
  });
  assert.equal(first.body.state, 'running');
  assert.equal(first.body.progress.maxActions, 4);
  assert.equal(first.body.progress.steps, 0);
  const { runId } = first.body;
  assert.equal((await ctx.api('GET', `/v1/requests/${requestId}`)).body.activeRunId, runId);

  const busy = await ctx.api('POST', '/v1/runs', { requestId, instruction: 'Again' });
  assert.equal(busy.status, 409);
  assert.equal(busy.body.error.code, 'run_active');
  assert.equal((await ctx.api('POST', '/v1/observe', { requestId })).body.error.code, 'run_active');
  const runningEvidence = await ctx.api('GET', `/v1/runs/${runId}/evidence`);
  assert.equal(runningEvidence.body.error.code, 'no_evidence');

  const progress = await ctx.api('POST', '/v1/wait', { runId, afterStep: 0, maxMs: 5000 });
  assert.ok(progress.body.state === 'done' || progress.body.progress.steps >= 1, JSON.stringify(progress.body));
  if (progress.body.state === 'running') {
    assert.deepEqual(progress.body.progress.lastStep.action, { type: 'click', ref: '1' });
    assert.equal(Object.keys(progress.body.progress.lastStep.action).includes('label'), false);
  }
  const done = await ctx.api('POST', '/v1/wait', { runId, maxMs: 10_000 });
  assert.equal(done.body.state, 'done');
  assert.equal(done.body.result.status, 'completed');
  assert.equal((await ctx.api('GET', `/v1/requests/${requestId}`)).body.activeRunId, null);
  assert.equal((await ctx.api('GET', `/v1/requests/${requestId}`)).body.lastRunId, runId);
});

test('every wait is bounded: maxMs is clamped to the daemon maximum, negative means now', async t => {
  assert.equal(MAX_WAIT_MS, 45_000);
  assert.equal(clampWait(100_000, 30_000), 45_000);
  assert.equal(clampWait(undefined, 30_000), 30_000);
  assert.equal(clampWait(undefined, 40_000), 40_000);
  assert.equal(clampWait(-5, 30_000), 0);
  assert.throws(() => clampWait('5', 30_000), /numbers/);

  const ctx = await setup(t, { maxWaitMs: 300, provider: () => slowProvider(2000) });
  const requestId = await requestTab(ctx);
  let started = Date.now();
  const bounded = await ctx.api('POST', '/v1/wait', { requestId, maxMs: 100_000 });
  let elapsed = Date.now() - started;
  assert.equal(bounded.status, 200, 'a wait timeout is not an error');
  assert.equal(bounded.body.state, 'pending');
  assert.ok(elapsed >= 250 && elapsed < 2000, `clamped wait took ${elapsed} ms`);
  assert.ok(bounded.body.waitedMs >= 250);

  started = Date.now();
  const immediate = await ctx.api('POST', '/v1/wait', { requestId, maxMs: -1 });
  assert.equal(immediate.body.state, 'pending');
  assert.ok(Date.now() - started < 200);

  await ctx.hub.approve(requestId);
  started = Date.now();
  const run = await ctx.api('POST', '/v1/runs', { requestId, instruction: 'Open About', waitMs: 100_000 });
  elapsed = Date.now() - started;
  assert.equal(run.body.state, 'running');
  assert.ok(elapsed < 1500, `run waitMs clamped, took ${elapsed} ms`);
  const stopped = await ctx.api('POST', `/v1/runs/${run.body.runId}/stop`);
  assert.equal(stopped.body.state, 'done');
});

test('pending requests expire after ttl, idle leases expire, paused leases expire, terminal records age out', async t => {
  let clock = Date.now();
  const ctx = await setup(t, { now: () => clock, config: { leaseIdleMs: 120_000 } });
  const pending = await requestTab(ctx, { ttlMs: 60_000 });
  const waiting = ctx.api('POST', '/v1/wait', { requestId: pending, maxMs: 5000 });
  await delay(30);
  clock += 60_001;
  ctx.daemon.sweep();
  const waited = await waiting;
  assert.equal(waited.body.state, 'expired');
  assert.equal(waited.body.request.stateReason, 'ttl');

  const idle = await approved(ctx);
  const idleLease = ctx.daemon.request(idle).lease.leaseId;
  clock += 119_000;
  ctx.daemon.sweep();
  assert.equal(ctx.daemon.request(idle).state, 'active');
  clock += 2000;
  ctx.daemon.sweep();
  assert.equal(ctx.daemon.request(idle).state, 'expired');
  assert.equal(ctx.daemon.request(idle).stateReason, 'idle');
  assert.deepEqual(ctx.hub.updates.at(-1), { leaseId: idleLease, state: 'expired', reason: 'idle' });

  const paused = await approved(ctx);
  await ctx.hub.emit({ type: 'status', leaseId: ctx.daemon.request(paused).lease.leaseId, status: 'paused', reason: 'paused' });
  assert.equal(ctx.daemon.request(paused).state, 'paused');
  clock += 30 * 60_000;
  ctx.daemon.sweep();
  assert.equal(ctx.daemon.request(paused).state, 'expired');
  assert.equal(ctx.daemon.request(paused).stateReason, 'paused_timeout');

  clock += 60 * 60_000;
  ctx.daemon.sweep();
  assert.equal(ctx.daemon.request(pending), null);
  assert.ok(ctx.hub.forgotten.includes(idleLease));
  assert.equal((await ctx.api('GET', `/v1/requests/${pending}`)).body.error.code, 'unknown_request');
});

test('release stops the active run first and pushes released to the hub', async t => {
  const ctx = await setup(t, { provider: () => slowProvider(300) });
  const requestId = await approved(ctx);
  const leaseId = ctx.daemon.request(requestId).lease.leaseId;
  const run = await ctx.api('POST', '/v1/runs', { requestId, instruction: 'Open About', waitMs: 20 });
  assert.equal(run.body.state, 'running');
  const released = await ctx.api('DELETE', `/v1/requests/${requestId}`);
  assert.deepEqual(released.body, { requestId, state: 'released' });
  const done = await ctx.api('GET', `/v1/runs/${run.body.runId}`);
  assert.equal(done.body.state, 'done');
  assert.equal(done.body.result.status, 'stopped');
  assert.equal(done.body.result.code, 'cancelled');
  assert.deepEqual(ctx.hub.updates.at(-1), { leaseId, state: 'released', reason: 'released' });
  const after = await ctx.api('POST', '/v1/runs', { requestId, instruction: 'Open About' });
  assert.equal(after.body.result.code, 'request_closed');
});

test('user pause ends the run as needs_user/paused; Resume for the request re-activates with a new lease', async t => {
  const ctx = await setup(t, { provider: () => slowProvider(300) });
  const requestId = await approved(ctx);
  const leaseId = ctx.daemon.request(requestId).lease.leaseId;
  const run = await ctx.api('POST', '/v1/runs', { requestId, instruction: 'Open About', waitMs: 20 });
  await ctx.hub.emit({ type: 'status', leaseId, status: 'paused', reason: 'paused' });
  const done = await ctx.api('POST', '/v1/wait', { runId: run.body.runId, maxMs: 5000 });
  assert.equal(done.body.result.status, 'needs_user');
  assert.equal(done.body.result.code, 'paused');
  assert.equal(done.body.result.needs.message, LEASE_MESSAGES.paused);
  assert.deepEqual(done.body.result.lease, { requestId, state: 'paused' });
  const view = (await ctx.api('GET', `/v1/requests/${requestId}`)).body;
  assert.equal(view.state, 'paused');
  assert.equal(view.stateReason, 'paused');

  const blocked = await ctx.api('POST', '/v1/runs', { requestId, instruction: 'Open About' });
  assert.equal(blocked.body.result.code, 'paused');

  const waiting = ctx.api('POST', '/v1/wait', { requestId, maxMs: 5000 });
  await delay(30);
  const resumed = await ctx.hub.approve(requestId);
  assert.notEqual(resumed.leaseId, leaseId);
  const waited = await waiting;
  assert.equal(waited.body.state, 'active');
  assert.equal(waited.body.request.lease.leaseId, resumed.leaseId);
});

test('tab events pause with their code and the lease message', async t => {
  const ctx = await setup(t, { provider: () => slowProvider(300) });
  const requestId = await approved(ctx);
  const leaseId = ctx.daemon.request(requestId).lease.leaseId;
  const run = await ctx.api('POST', '/v1/runs', { requestId, instruction: 'Open About', waitMs: 20 });
  await ctx.hub.emit({ type: 'status', leaseId, status: 'paused', reason: 'tab_changed' });
  const done = await ctx.api('POST', '/v1/wait', { runId: run.body.runId, maxMs: 5000 });
  assert.equal(done.body.result.code, 'tab_changed');
  assert.equal(done.body.result.needs.message, LEASE_MESSAGES.tab_changed);
  assert.equal(ctx.daemon.request(requestId).stateReason, 'tab_changed');
});

test('an origin_changed pause that names the origin: the request view and needs.message say where the tab went', async t => {
  const ctx = await setup(t);
  const requestId = await approved(ctx);
  const leaseId = ctx.daemon.request(requestId).lease.leaseId;
  await ctx.hub.emit({ type: 'status', leaseId, status: 'paused', reason: 'origin_changed', origin: 'https://login.example.org' });
  assert.equal(ctx.daemon.request(requestId).stateReason, 'origin_changed');
  assert.equal(ctx.daemon.request(requestId).leftOrigin, 'https://login.example.org');
  const blocked = await ctx.api('POST', '/v1/runs', { requestId, instruction: 'Open About' });
  assert.equal(blocked.body.result.code, 'origin_changed');
  assert.match(blocked.body.result.needs.message, /^The tab lease is paused\./);
  // The origin is page-chosen: in leftOrigin (untrusted), never in the trusted needs.message.
  assert.match(blocked.body.result.needs.message, /The tab went to an origin this request does not list \(leftOrigin/);
  assert.doesNotMatch(blocked.body.result.needs.message, /login\.example\.org/);
  assert.equal(blocked.body.result.leftOrigin, 'https://login.example.org');
});

test('disconnect pauses; hello with the same leaseId resumes it; unknown and empty sessions', async t => {
  const ctx = await setup(t);
  const requestId = await approved(ctx);
  const leaseId = ctx.daemon.request(requestId).lease.leaseId;
  await ctx.hub.emit({ type: 'disconnected', transport: 'websocket' });
  assert.equal(ctx.daemon.request(requestId).state, 'paused');
  assert.equal(ctx.daemon.request(requestId).stateReason, 'disconnected');
  const blocked = await ctx.api('POST', '/v1/runs', { requestId, instruction: 'Open About' });
  assert.equal(blocked.body.result.code, 'disconnected');

  const session = { requestId, leaseId, tabId: 1, origin: ORIGIN, status: 'active' };
  const hello = await ctx.hub.emit({ type: 'hello', session });
  assert.equal(hello.endSession, false);
  assert.equal(hello.mode, 'daemon');
  assert.equal(hello.requests[0].requestId, requestId);
  assert.equal(ctx.daemon.request(requestId).state, 'active');
  assert.equal(ctx.daemon.request(requestId).lease.leaseId, leaseId);
  const run = await ctx.api('POST', '/v1/runs', { requestId, instruction: 'Open About', expectation: { urlIncludes: '/about' } });
  assert.equal(run.body.result.status, 'completed');

  const unknown = await ctx.hub.emit({ type: 'hello', session: { ...session, leaseId: 'stale' } });
  assert.equal(unknown.endSession, true);

  const restarted = await ctx.hub.emit({ type: 'hello', session: null });
  assert.equal(restarted.endSession, false);
  assert.equal(ctx.daemon.request(requestId).state, 'paused');
  assert.equal(ctx.daemon.request(requestId).stateReason, 'session_inactive');
});

test('approving another request supersedes the active lease; lease replies refuse bad requests', async t => {
  const ctx = await setup(t);
  const first = await approved(ctx);
  const firstLease = ctx.daemon.request(first).lease.leaseId;
  const second = await requestTab(ctx, { origins: ['https://other.example'] });

  const wrongOrigin = await ctx.hub.approve(second, { origin: ORIGIN });
  assert.equal(wrongOrigin.error.code, 'origin_not_requested');
  assert.deepEqual(wrongOrigin.error.origins, ['https://other.example']);
  assert.equal((await ctx.hub.approve('req_nothing')).error.code, 'no_request');

  const reply = await ctx.hub.approve(second, { origin: 'https://other.example', tabId: 2 });
  assert.ok(reply.leaseId);
  assert.equal(ctx.daemon.request(first).state, 'released');
  assert.equal(ctx.daemon.request(first).stateReason, 'superseded');
  assert.deepEqual(ctx.hub.updates.at(-1), { leaseId: firstLease, state: 'released', reason: 'superseded' });
  assert.equal((await ctx.hub.approve(first)).error.code, 'request_not_pending');
  const closed = await ctx.api('POST', '/v1/runs', { requestId: first, instruction: 'Open' });
  assert.equal(closed.body.result.code, 'request_closed');

  // A v2 extension sends no requestId: the newest pending request for the origin is bound.
  const third = await requestTab(ctx);
  const legacy = await ctx.hub.emit({ type: 'lease', requestId: null, tabId: 3, origin: ORIGIN, title: '' });
  assert.equal(legacy.requestId, third);
  // The lease reply lists the request's origins, so the extension can follow a consent wall's redirect within them.
  assert.deepEqual(legacy.origins, [ORIGIN]);

  const denied = await requestTab(ctx);
  const deny = await ctx.hub.emit({ type: 'deny', requestId: denied });
  assert.deepEqual(deny, { requestId: denied, state: 'denied' });
  assert.equal((await ctx.api('POST', '/v1/wait', { requestId: denied, maxMs: 1000 })).body.state, 'denied');
  assert.equal((await ctx.hub.emit({ type: 'deny', requestId: denied })).error.code, 'request_not_pending');
});

test('user Stop releases the lease and the run ends stopped/stopped', async t => {
  const ctx = await setup(t, { provider: () => slowProvider(300) });
  const requestId = await approved(ctx);
  const leaseId = ctx.daemon.request(requestId).lease.leaseId;
  const run = await ctx.api('POST', '/v1/runs', { requestId, instruction: 'Open About', waitMs: 20 });
  await ctx.hub.emit({ type: 'status', leaseId, status: 'stopped', reason: 'stopped' });
  const done = await ctx.api('POST', '/v1/wait', { runId: run.body.runId, maxMs: 5000 });
  assert.equal(done.body.result.status, 'stopped');
  assert.equal(done.body.result.code, 'stopped');
  assert.equal(done.body.result.needs.message, LEASE_MESSAGES.stopped);
  assert.equal(ctx.daemon.request(requestId).state, 'released');
  const after = await ctx.api('POST', '/v1/runs', { requestId, instruction: 'Open About' });
  assert.equal(after.body.result.status, 'stopped');
  assert.equal(after.body.result.code, 'stopped');
});

test('POST stop cancels a running run and is idempotent', async t => {
  const ctx = await setup(t, { provider: () => slowProvider(400) });
  const requestId = await approved(ctx);
  const run = await ctx.api('POST', '/v1/runs', { requestId, instruction: 'Open About', waitMs: 20 });
  const stopped = await ctx.api('POST', `/v1/runs/${run.body.runId}/stop`);
  assert.equal(stopped.body.state, 'done');
  assert.equal(stopped.body.result.status, 'stopped');
  assert.equal(stopped.body.result.code, 'cancelled');
  assert.ok(stopped.body.result.trace);
  const again = await ctx.api('POST', `/v1/runs/${run.body.runId}/stop`);
  assert.equal(again.body.result.code, 'cancelled');
  assert.equal(ctx.daemon.request(requestId).state, 'active', 'the lease stays active');
  assert.equal((await ctx.api('POST', '/v1/runs/unknown/stop')).body.error.code, 'unknown_run');
});

test('authority checks: mode, provider options, allowedUrls, expectation and unknown fields', async t => {
  const ctx = await setup(t);
  const requestId = await approved(ctx);
  const expectError = async (body, status, code) => {
    const response = await ctx.api('POST', '/v1/runs', { requestId, instruction: 'Open', ...body });
    assert.equal(response.status, status, JSON.stringify(response.body));
    assert.equal(response.body.error.code, code);
  };
  await expectError({ mode: 'root' }, 400, 'invalid_options');
  await expectError({ providerOptions: { endpoint: 'https://evil.example/v1' } }, 422, 'provider_option_forbidden');
  await expectError({ providerOptions: { keyEnv: 'HOME' } }, 422, 'provider_option_forbidden');
  await expectError({ allowedUrls: ['https://evil.example/x'] }, 422, 'origin_not_granted');
  await expectError({ expectation: { urlHas: '/x' } }, 400, 'invalid_options');
  await expectError({ expectation: { changedSinceStart: 'yes' } }, 400, 'invalid_options');
  await expectError({ unknownField: 1 }, 400, 'invalid_options');
  await expectError({ maxActions: 0 }, 400, 'invalid_options');
  await expectError({ operation: 'act' }, 400, 'invalid_options');
  await expectError({ instruction: '' }, 400, 'invalid_options');
  await expectError({ suppliedText: { name: 5 } }, 400, 'invalid_options');
  await expectError({ outputDir: 'relative/dir' }, 400, 'invalid_options');
  await expectError({ requestId: 'req_unknown' }, 404, 'unknown_request');
  // A mode above the grant is clamped, never a 422: the receipt reports what ran.
  const clamped = await ctx.api('POST', '/v1/runs', { requestId, instruction: 'Open', mode: 'testing', waitMs: 5000 });
  assert.equal(clamped.status, 200, JSON.stringify(clamped.body));
  assert.deepEqual(clamped.body.result.permissions,
    { requested: 'testing', granted: 'read-only', effective: 'read-only', testing: false, scope: 'origin', tabMode: 'single' });
  const observed = await ctx.api('POST', '/v1/observe', { requestId, mode: 'reversible', capture: false });
  assert.equal(observed.status, 200, JSON.stringify(observed.body));
  assert.deepEqual(observed.body.permissions,
    { requested: 'reversible', granted: 'read-only', effective: 'read-only', testing: false, scope: 'origin', tabMode: 'single' });
  assert.equal((await ctx.api('POST', '/v1/observe', { requestId, mode: 'admin' })).body.error.code, 'invalid_options');
  assert.equal((await ctx.api('POST', '/v1/wait', { maxMs: 10 })).body.error.code, 'invalid_options');
  assert.equal((await ctx.api('POST', '/v1/wait', { requestId, while: ['bogus'] })).body.error.code, 'invalid_options');
  assert.equal((await ctx.api('POST', '/v1/wait', { runId: 'nope' })).body.error.code, 'unknown_run');
});

test('provider configuration failures are failed/config results; providerOptions reach the factory', async t => {
  const seen = [];
  const ctx = await setup(t, {
    config: { providerOptions: { endpoint: 'http://127.0.0.1:9/v1/systemone', model: 'from-config' } },
    providerFactory: spec => {
      seen.push(spec);
      if (spec.name === 'local') return clickProvider(['About']);
      const error = new Error('The Jev key is not configured');
      error.code = 'config';
      throw error;
    },
  });
  const requestId = await approved(ctx);
  const failed = await ctx.api('POST', '/v1/runs', { requestId, instruction: 'Open' });
  assert.equal(failed.body.state, 'done');
  assert.equal(failed.body.result.status, 'failed');
  assert.equal(failed.body.result.code, 'config');
  assert.equal(failed.body.result.needs.who, 'user');
  assert.match(failed.body.result.reason, /Jev key/);
  const local = await ctx.api('POST', '/v1/runs', {
    requestId, instruction: 'Open', provider: 'local', providerOptions: { model: 'kev', port: 8009 },
    expectation: { urlIncludes: '/about' },
  });
  assert.equal(local.body.result.status, 'completed');
  assert.deepEqual(seen.at(-1).options, { endpoint: 'http://127.0.0.1:9/v1/systemone', model: 'kev', port: 8009 });
});

test('the default provider factory refuses to run without a Jev key', async t => {
  const home = await mkdtemp(join(tmpdir(), 'fai-daemon-nokey-'));
  const hub = createFakeHub();
  const daemon = createDaemon({ driver: 'jev', home, env: {}, port: 0, hub, sweepIntervalMs: 60_000 });
  await daemon.listen();
  t.after(async () => {
    await daemon.close();
    await rm(home, { recursive: true, force: true });
  });
  const api = (method, path, body) => call(daemon.port, method, path, body, { token: daemon.token });
  const requestId = (await api('POST', '/v1/requests', { origins: [ORIGIN], reason: 'r' })).body.requestId;
  await hub.approve(requestId);
  const response = await api('POST', '/v1/runs', { requestId, instruction: 'Open' });
  assert.equal(response.body.result.code, 'config');
  assert.equal((await api('GET', '/v1/status')).body.provider.keyConfigured, false);
});

test('observe returns offered actions and evidence; act runs one with changedSinceStart', async t => {
  const ctx = await setup(t, { bridgeOptions: { path: '/form' } });
  const requestId = await approved(ctx, { mode: 'reversible' });
  const observed = await ctx.api('POST', '/v1/observe', {
    requestId, mode: 'reversible', suppliedText: { name: 'Ada Lovelace' }, capture: true,
  });
  assert.equal(observed.status, 200, JSON.stringify(observed.body));
  assert.equal(observed.body.state, 'ok');
  assert.equal(observed.body.revision, '/form#1');
  assert.equal(observed.body.page.url, `${ORIGIN}/form`);
  const fill = observed.body.actions.find(action => action.type === 'fill_supplied_text');
  assert.equal(fill.suppliedName, 'name');
  assert.ok(!JSON.stringify(observed.body).includes('Ada Lovelace'));
  assert.ok(observed.body.screenshot.endsWith('observe.jpg'));
  const trace = JSON.parse(await readFile(observed.body.trace, 'utf8'));
  assert.equal(trace.operation, 'observe');
  assert.deepEqual(trace.options.suppliedText, { name: '[redacted]' });
  assert.ok(!JSON.stringify(trace).includes('Ada Lovelace'));
  const evidence = await ctx.api('GET', `/v1/runs/${observed.body.observeId}/evidence`);
  assert.equal(evidence.body.path, observed.body.screenshot);

  const unknownRevision = await ctx.api('POST', '/v1/act', { requestId, actionId: fill.id, revision: 'r_nope' });
  assert.equal(unknownRevision.status, 400);
  assert.equal(unknownRevision.body.error.code, 'invalid_options');
  const unknownAction = await ctx.api('POST', '/v1/act', { requestId, actionId: 'a99', revision: observed.body.revision });
  assert.equal(unknownAction.body.error.code, 'invalid_options');

  const acted = await ctx.api('POST', '/v1/act', {
    requestId, actionId: fill.id, revision: observed.body.revision, expectation: { changedSinceStart: true },
  });
  assert.equal(acted.body.state, 'done');
  assert.equal(acted.body.result.status, 'completed');
  assert.equal(acted.body.result.steps[0].action.type, 'fill_supplied_text');
  assert.ok(!JSON.stringify(acted.body.result).includes('Ada Lovelace'));
  assert.equal(ctx.hub.bridges.get(1).lastText, 'Ada Lovelace');
  const actTrace = await readFile(acted.body.result.trace, 'utf8');
  assert.ok(!actTrace.includes('Ada Lovelace'));
  assert.equal(JSON.parse(actTrace).operation, 'act');
  assert.equal(JSON.parse(actTrace).steps[0].decision.by, 'host');
  assert.equal(JSON.parse(actTrace).steps[0].action.suppliedName, 'name');
  const spent = await ctx.api('POST', '/v1/act', { requestId, actionId: fill.id, revision: observed.body.revision });
  assert.equal(spent.body.error.code, 'invalid_options');
});

// A page whose observed controls carry bounds (1280x800 at dpr 1: image pixels are CSS pixels) and one control the
// observation left out (`unlisted`): the point-click page of test/point-click.test.js, in short.
const POINT_PAGES = {
  '/': {
    title: 'Home',
    text: 'Welcome home',
    controls: [
      { id: '1', role: 'link', label: 'About', href: `${ORIGIN}/about`, enabled: true, risk: 'navigation', bounds: { x: 10, y: 10, width: 100, height: 30 } },
      { id: '2', role: 'button', label: 'Show plan', type: 'button', enabled: true, risk: 'reversible', bounds: { x: 10, y: 50, width: 100, height: 30 } },
    ],
    unlisted: [
      { id: 'u1', role: 'button', label: 'Expand row', type: 'button', enabled: true, risk: 'reversible', bounds: { x: 10, y: 200, width: 100, height: 30 }, unlisted: true },
      { id: 'u2', role: 'button', label: 'Delete', type: 'button', enabled: true, risk: 'delete', bounds: { x: 10, y: 240, width: 100, height: 30 }, unlisted: true },
    ],
  },
  '/about': { title: 'About', text: 'About us', controls: [{ id: '1', role: 'link', label: 'Home', href: `${ORIGIN}/`, enabled: true, risk: 'navigation' }] },
};

test('observe captures with the offered ids as badge labels and reports the image; act takes a point through the same gate', async t => {
  const ctx = await setup(t, { bridgeOptions: { pages: POINT_PAGES } });
  const requestId = await approved(ctx, { mode: 'reversible' });
  const observed = await ctx.api('POST', '/v1/observe', { requestId, mode: 'reversible', capture: true });
  assert.equal(observed.status, 200, JSON.stringify(observed.body));
  const about = observed.body.actions.find(action => action.label === 'About');
  const plan = observed.body.actions.find(action => action.label === 'Show plan');
  // The capture asked for action-id badges for this revision: control ref -> offered ids.
  const bridge = ctx.hub.bridges.get(1);
  assert.equal(bridge.captures.length, 1);
  assert.deepEqual(bridge.captures[0].labels, { 1: [about.id], 2: [plan.id] });
  assert.equal(bridge.captures[0].revision, observed.body.revision);
  assert.deepEqual(observed.body.image, { revision: observed.body.revision, width: 1280, height: 800, tags: 'actionIds' });
  const trace = JSON.parse(await readFile(observed.body.trace, 'utf8'));
  assert.deepEqual(trace.screenshot.tags.map(tag => tag.id), [about.id, plan.id]);
  const evidence = await ctx.api('GET', `/v1/runs/${observed.body.observeId}/evidence`);
  assert.equal(evidence.body.revision, observed.body.revision);
  assert.equal(evidence.body.tags, 'actionIds');

  // Bad points are options errors before anything runs.
  for (const [body, message] of [
    [{ requestId, revision: observed.body.revision }, /actionId or point/],
    [{ requestId, actionId: about.id, point: { x: 1, y: 1 }, revision: observed.body.revision }, /exclusive/],
    [{ requestId, point: { x: 1, y: 1 } }, /revision is required/],
    [{ requestId, point: { x: -1, y: 1 }, revision: observed.body.revision }, /non-negative/],
    [{ requestId, point: { x: 1, y: 1, z: 2 }, revision: observed.body.revision }, /Unknown point key/],
    [{ requestId, point: [1, 2], revision: observed.body.revision }, /must be \{x, y\}/],
    [{ requestId, point: { x: 1, y: 1 }, revision: 'r_nope' }, /Unknown revision/],
  ]) {
    const bad = await ctx.api('POST', '/v1/act', body);
    assert.equal(bad.status, 400, JSON.stringify(bad.body));
    assert.equal(bad.body.error.code, 'invalid_options');
    assert.match(bad.body.error.message, message);
  }

  // A point on the unlisted Delete: refused through the offer gate, with the level that would allow it.
  const refused = await ctx.api('POST', '/v1/act', { requestId, point: { x: 20, y: 250 }, revision: observed.body.revision });
  assert.equal(refused.body.state, 'done');
  assert.equal(refused.body.result.code, 'refused_action');
  assert.equal(refused.body.result.needs.level, 'full');
  assert.deepEqual(refused.body.result.point.control, { ref: 'point', label: 'Delete', offered: false });
  assert.equal(bridge.executions.length, 0);
  const refusedTrace = JSON.parse(await readFile(refused.body.result.trace, 'utf8'));
  assert.deepEqual(refusedTrace.options.point, { x: 20, y: 250 });
  assert.equal(refusedTrace.options.actionId, undefined);

  // The offer is spent; observe again and click the offered link by its point: the offered action runs.
  const again = await ctx.api('POST', '/v1/observe', { requestId, mode: 'reversible', capture: false });
  const acted = await ctx.api('POST', '/v1/act', {
    requestId, point: { x: 15, y: 20 }, revision: again.body.revision, expectation: { urlIncludes: '/about' },
  });
  assert.equal(acted.body.state, 'done', JSON.stringify(acted.body));
  assert.equal(acted.body.result.status, 'completed');
  assert.deepEqual(acted.body.result.steps[0].point, { x: 15, y: 20, ref: '1', offered: true });
  const actTrace = JSON.parse(await readFile(acted.body.result.trace, 'utf8'));
  assert.equal(actTrace.steps[0].decision.by, 'host');
  assert.equal(actTrace.steps[0].decision.actionId, again.body.actions.find(action => action.label === 'About').id);
  assert.deepEqual(actTrace.steps[0].decision.resolved, { ref: '1', label: 'About', offered: true });
  assert.deepEqual(actTrace.options.point, { x: 15, y: 20 });
});

test('retention prunes after each trace write and keeps the newest run', async t => {
  const ctx = await setup(t, { config: { retention: { maxRuns: 1 } } });
  const requestId = await approved(ctx);
  const first = await ctx.api('POST', '/v1/runs', { requestId, instruction: 'Open About', operation: 'step' });
  const second = await ctx.api('POST', '/v1/runs', { requestId, instruction: 'Open Members', operation: 'step' });
  const dirs = await readdir(join(ctx.home, 'artifacts'));
  assert.deepEqual(dirs, [second.body.runId]);
  assert.notEqual(first.body.runId, second.body.runId);
  const noPrune = await ctx.api('POST', '/v1/runs', { requestId, instruction: 'Home', operation: 'step', prune: false });
  assert.equal((await readdir(join(ctx.home, 'artifacts'))).length, 2);
  assert.ok(noPrune.body.result.trace);
});

test('the log carries routes and states but never the key, secret, token or supplied text', async t => {
  const ctx = await setup(t, { bridgeOptions: { path: '/form' } });
  const requestId = await approved(ctx, { mode: 'reversible' });
  await ctx.api('POST', '/v1/runs', {
    requestId, instruction: 'Fill the name', suppliedText: { name: 'supplied-secret-value-4411' }, mode: 'reversible',
  });
  await ctx.api('POST', '/v1/observe', { requestId, suppliedText: { name: 'supplied-secret-value-4411' } });
  await ctx.api('GET', '/v1/status', undefined, { token: 'wrong-token' });
  const log = await readFile(ctx.logFile, 'utf8');
  const env = await readFile(join(ctx.home, '.env.local'), 'utf8');
  const secret = /FAI_BRIDGE_SECRET="([^"]+)"/.exec(env)[1];
  assert.ok(secret.length >= 24);
  assert.match(log, /"route":"runs.create"/);
  assert.match(log, /"event":"run_done"/);
  for (const forbidden of [KEY, secret, ctx.daemon.token, 'supplied-secret-value-4411', 'Profile form', 'wrong-token']) {
    assert.ok(!log.includes(forbidden), `log contains ${forbidden.slice(0, 6)}...`);
  }
  assert.equal((await stat(ctx.logFile)).mode & 0o777, 0o600);
});

test('reload re-reads settings and config; shutdown is requested over the API', async t => {
  const ctx = await setup(t);
  await writeFile(join(ctx.home, 'config.json'), JSON.stringify({ provider: 'local' }));
  const reloaded = await ctx.api('POST', '/v1/daemon/reload');
  assert.equal(reloaded.body.ok, true);
  assert.equal(reloaded.body.secretChanged, false);
  assert.equal((await ctx.api('GET', '/v1/status')).body.provider.default, 'local');
  await writeFile(join(ctx.home, '.env.local'), `FAI_BRIDGE_SECRET="${'b'.repeat(40)}"\n`, { mode: 0o600 });
  const changed = await ctx.api('POST', '/v1/daemon/reload');
  assert.equal(changed.body.secretChanged, true);
  assert.deepEqual(ctx.hub.secrets, ['b'.repeat(40)]);
  await writeFile(join(ctx.home, 'config.json'), '{bad');
  const broken = await ctx.api('POST', '/v1/daemon/reload');
  assert.equal(broken.status, 400);

  const shutdown = await ctx.api('POST', '/v1/daemon/shutdown');
  assert.deepEqual(shutdown.body, { ok: true, state: 'shutting_down' });
  await delay(20);
  assert.equal(ctx.shutdowns(), 1);
});

test('close interrupts runs, releases leases with daemon_shutdown and answers 503 meanwhile', async t => {
  const ctx = await setup(t, { provider: () => slowProvider(300) });
  const requestId = await approved(ctx);
  const leaseId = ctx.daemon.request(requestId).lease.leaseId;
  const run = await ctx.api('POST', '/v1/runs', { requestId, instruction: 'Open About', waitMs: 20 });
  const closing = ctx.daemon.close();
  const during = await ctx.api('GET', '/v1/status').catch(() => null);
  if (during) assert.equal(during.body.error.code, 'shutting_down');
  await closing;
  assert.deepEqual(ctx.hub.updates.at(-1), { leaseId, state: 'released', reason: 'daemon_shutdown' });
  assert.equal(ctx.hub.closed, true);
  const traces = await readdir(join(ctx.home, 'artifacts'));
  assert.deepEqual(traces, [run.body.runId]);
  const trace = JSON.parse(await readFile(join(ctx.home, 'artifacts', run.body.runId, 'trace.json'), 'utf8'));
  assert.equal(trace.code, 'interrupted');
  assert.equal(trace.status, 'stopped');
});

test('answerQuestion passes through /v1/runs and /v1/act; results carry digest and answer, not controls', async t => {
  const calls = [];
  const ctx = await setup(t, {
    provider: () => ({
      ...clickProvider(['About', 'Members']),
      async choose(request) {
        calls.push(request);
        return { choice: request.candidates[0].id, confidence: 0.7 };
      },
    }),
  });
  const requestId = await approved(ctx);

  const bad = await ctx.api('POST', '/v1/runs', { requestId, instruction: 'Open Members', answerQuestion: '   ' });
  assert.equal(bad.status, 400);
  const long = await ctx.api('POST', '/v1/runs', { requestId, instruction: 'x', answerQuestion: 'q'.repeat(2001) });
  assert.equal(long.status, 400);

  const run = await ctx.api('POST', '/v1/runs', {
    requestId, instruction: 'Open Members', answerQuestion: 'Who are the members?', expectation: { textIncludes: 'Ada' },
  });
  const { result } = run.body;
  assert.equal(result.status, 'completed');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].question, 'Who are the members?');
  assert.equal(calls[0].instruction, 'Open Members');
  assert.equal(result.answer.method, 'provider');
  assert.equal(result.answer.candidates[0].text, 'Ada, Grace, Linus');
  assert.equal(result.page.controls, undefined);
  assert.ok(result.page.digest.includes('Ada, Grace, Linus'), 'the lean digest is a list of block texts');
  assert.ok(result.steps.every(step => step.decision === undefined), 'no decision records or probabilities');
  const trace = JSON.parse(await readFile(result.trace, 'utf8'));
  assert.equal(trace.options.answerQuestion, 'Who are the members?');
  assert.ok(Array.isArray(trace.finalObservation.blocks));
  assert.ok(Array.isArray(trace.finalObservation.controls));

  const observed = await ctx.api('POST', '/v1/observe', { requestId, capture: false });
  assert.ok(Array.isArray(observed.body.page.controls), 'observe keeps controls');
  const home = observed.body.actions.find(action => action.label === 'Home');
  const act = await ctx.api('POST', '/v1/act', {
    requestId, actionId: home.id, revision: observed.body.revision, answerQuestion: 'What is on the home page?',
  });
  assert.equal(act.status, 200, JSON.stringify(act.body));
  assert.equal(act.body.result.status, 'checkpoint');
  assert.notEqual(act.body.result.answer.method, 'provider', 'act never asks the provider');
  assert.equal(calls.length, 1);
});

test('observe: the listing (offer) and its relevance task, from the body, else the last run, else the request', async t => {
  const ctx = await setup(t);
  const requestId = await approved(ctx, { instruction: 'Look around the members area' });
  const bridge = ctx.hub.bridgeForTab(1);
  const termsOfLastObserve = () => bridge.observeOptions.at(-1)?.terms ?? [];
  // No task named and no run yet: the request's instruction.
  const first = await ctx.api('POST', '/v1/observe', { requestId, capture: false });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual(first.body.offer, { cap: 40, listed: first.body.actions.map(action => action.id), dropped: 0 });
  assert.ok(termsOfLastObserve().includes('members'), JSON.stringify(termsOfLastObserve()));
  // The body's task wins.
  await ctx.api('POST', '/v1/observe', { requestId, capture: false, instruction: 'Open the pricing page', expectation: { urlIncludes: '/pricing' } });
  assert.ok(termsOfLastObserve().includes('pricing'));
  // After a run: that run's task.
  const run = await ctx.api('POST', '/v1/runs', { requestId, instruction: 'Open About', maxActions: 1, waitMs: 5000 });
  assert.equal(run.status, 200, JSON.stringify(run.body));
  await ctx.api('POST', '/v1/observe', { requestId, capture: false });
  assert.ok(termsOfLastObserve().includes('about'), JSON.stringify(termsOfLastObserve()));
  // The hints are validated like a run's.
  for (const body of [{ instruction: 5 }, { expectation: { bogus: 1 } }, { answerQuestion: ' ' }]) {
    const refused = await ctx.api('POST', '/v1/observe', { requestId, capture: false, ...body });
    assert.equal(refused.body.error?.code, 'invalid_options', JSON.stringify(body));
  }
});

test('the per-request budget in effect: the popup setting (hello or settings), else config.json, else the default', async t => {
  const ctx = await setup(t, { config: { budget: { maxCalls: 9 } } });
  // config.json budget over the defaults, each missing field from the defaults.
  let status = await ctx.api('GET', '/v1/status');
  assert.deepEqual(status.body.budget, { maxCalls: 9, maxMs: 1_200_000, source: 'config' });
  // The extension's hello carries the user's setting; the reply says what applies now.
  const hello = await ctx.hub.emit({ type: 'hello', session: null, settings: { budget: { maxCalls: 30, maxMs: 600_000 } } });
  assert.deepEqual(hello.budget, { maxCalls: 30, maxMs: 600_000, source: 'extension' });
  status = await ctx.api('GET', '/v1/status');
  assert.deepEqual(status.body.budget, { maxCalls: 30, maxMs: 600_000, source: 'extension' });
  // Every request wait carries it: the MCP server reads its ceiling from here.
  const requestId = await requestTab(ctx, { mode: 'read-only' });
  const waited = await ctx.api('POST', '/v1/wait', { requestId, maxMs: 0 });
  assert.deepEqual(waited.body.budget, { maxCalls: 30, maxMs: 600_000, source: 'extension' });
  // A settings message replaces it; an invalid or cleared one falls back to config.json.
  let reply = await ctx.hub.emit({ type: 'settings', settings: { budget: { maxCalls: 2, maxMs: 120_000 } } });
  assert.deepEqual(reply.budget, { maxCalls: 2, maxMs: 120_000, source: 'extension' });
  reply = await ctx.hub.emit({ type: 'settings', settings: { budget: { maxCalls: 2, maxMs: 10 } } });
  assert.deepEqual(reply.budget, { maxCalls: 9, maxMs: 1_200_000, source: 'config' });
  reply = await ctx.hub.emit({ type: 'settings', settings: { budget: null } });
  assert.deepEqual(reply.budget, { maxCalls: 9, maxMs: 1_200_000, source: 'config' });
  // A hello without settings (an older extension) leaves the setting as it is.
  await ctx.hub.emit({ type: 'settings', settings: { budget: { maxCalls: 4, maxMs: 60_000 } } });
  const again = await ctx.hub.emit({ type: 'hello', session: null });
  assert.deepEqual(again.budget, { maxCalls: 4, maxMs: 60_000, source: 'extension' });
});

test('without config.json or a popup setting the budget in effect is the default', async t => {
  const ctx = await setup(t);
  const status = await ctx.api('GET', '/v1/status');
  assert.deepEqual(status.body.budget, { maxCalls: 50, maxMs: 1_200_000, source: 'default' });
});

test('a request is approved on its page when the extension opens pages right away (Interactive or less, a page to open); the wording follows', async t => {
  const ctx = await setup(t);
  const PAGE = /its task page opened in an existing browser window; click Approve in the page request modal \(grant browser site access if asked\), or use the FAI Browser toolbar icon/;
  const WINDOW = /click Open in the FAI Browser window, then Approve in the page request modal/;
  const viewOf = async requestId => (await ctx.api('GET', `/v1/requests/${requestId}`)).body;
  const blocked = async requestId => (await ctx.api('POST', '/v1/runs', { requestId, instruction: 'Open', expectation: { urlIncludes: '/x' } })).body.result;
  // An extension that reports nothing about the setting (older): the window wording.
  await ctx.hub.emit({ type: 'hello', session: null, settings: { budget: null } });
  let created = await ctx.api('POST', '/v1/requests', { origins: [ORIGIN], reason: 'Check', mode: 'reversible', url: `${ORIGIN}/cart` });
  assert.equal(created.body.request.approval, 'window');
  assert.match(created.body.message, WINDOW);
  // The setting on: a Reversible request with a page opens by itself; select_tab says so, in needs.message and next.
  await ctx.hub.emit({ type: 'settings', settings: { budget: null, openRightAway: true } });
  created = await ctx.api('POST', '/v1/requests', { origins: [ORIGIN], reason: 'Check', mode: 'reversible', url: `${ORIGIN}/cart` });
  assert.equal(created.body.request.approval, 'page');
  assert.match(created.body.message, PAGE);
  const pageId = created.body.requestId;
  assert.equal((await viewOf(pageId)).approval, 'page');
  let result = await blocked(pageId);
  assert.equal(result.code, 'select_tab');
  assert.match(result.needs.message, /task page opened in an existing browser window; click Approve in the page request modal/);
  assert.match(result.next.text, PAGE);
  assert.deepEqual(result.lease, { requestId: pageId, state: 'pending' }, 'the lease block is unchanged');
  // Interactive still opens by itself; an exact origin without a url has a page to open too.
  const cancel = requestId => ctx.api('DELETE', `/v1/requests/${requestId}`, { reason: 'done' });
  const interactive = await requestTab(ctx, { mode: 'interactive' });
  assert.equal((await viewOf(interactive)).approval, 'page');
  await cancel(interactive);
  // Full and Testing get the window, where the level is picked; so does a request with only domain roots and no url.
  for (const mode of ['full', 'testing']) {
    const id = await requestTab(ctx, { mode, url: `${ORIGIN}/cart` });
    assert.equal((await viewOf(id)).approval, 'window', mode);
    result = await blocked(id);
    assert.equal(result.needs.message, LEASE_MESSAGES.select_tab, mode);
    assert.match(result.next.text, WINDOW);
    await cancel(id);
  }
  // A request with only a domain root gets its start URL from the daemon (the root's apex), so it opens too.
  const roots = await requestTab(ctx, { origins: ['https://*.example.com'], mode: 'read-only' });
  assert.equal((await viewOf(roots)).url, 'https://example.com/');
  assert.equal((await viewOf(roots)).approval, 'page');
  await cancel(roots);
  // The setting turned off, or no extension connected: the window wording again.
  await ctx.hub.emit({ type: 'settings', settings: { budget: null, openRightAway: false } });
  assert.equal((await viewOf(pageId)).approval, 'window');
  await ctx.hub.emit({ type: 'hello', session: null, settings: { budget: null, openRightAway: true } });
  assert.equal((await viewOf(pageId)).approval, 'page');
  ctx.hub.connected = false;
  assert.equal((await viewOf(pageId)).approval, 'window');
});
