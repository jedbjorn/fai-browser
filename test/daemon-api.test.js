import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDaemon } from '../src/daemon.js';
import { createLogger, homePaths } from '../src/home.js';
import { LEASE_MESSAGES } from '../src/result.js';
import { ORIGIN } from './runtime-fixtures.js';
import { call, createFakeHub } from './helpers/fake-hub.js';

const KEY = 'leftover-key-must-not-be-logged-9137';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function setup(t, options = {}) {
  const home = await mkdtemp(join(tmpdir(), 'fai-daemon-api-'));
  if (options.config) await writeFile(join(home, 'config.json'), JSON.stringify(options.config));
  const hub = createFakeHub({ bridgeOptions: options.bridgeOptions });
  const env = { ...options.env };
  const log = createLogger(homePaths({ home, env }));
  let shutdowns = 0;
  const daemon = createDaemon({
    home,
    env,
    port: 0,
    hub,
    log,
    now: options.now,
    maxWaitMs: options.maxWaitMs,
    sweepIntervalMs: 60_000,
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

/** Observe, then act on the offered click on `label` (POST /v1/act); returns the act response body. */
async function actOn(ctx, requestId, label, extra = {}) {
  const observed = await ctx.api('POST', '/v1/observe', { requestId });
  assert.equal(observed.status, 200, JSON.stringify(observed.body));
  const action = observed.body.actions.find(entry => entry.type === 'click' && entry.label === label);
  assert.ok(action, `no action for ${label}: ${JSON.stringify(observed.body.actions ?? observed.body).slice(0, 400)}`);
  const acted = await ctx.api('POST', '/v1/act', { requestId, actionId: action.id, revision: observed.body.revision, ...extra });
  assert.equal(acted.status, 200, JSON.stringify(acted.body));
  return acted.body;
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
  assert.equal(status.body.provider, undefined, 'no provider: the agent drives');
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

test('an identical repeat from the same client instance is the same request only for the same agent session (X-Fai-Session)', async t => {
  const ctx = await setup(t);
  const register = async () => {
    const response = await ctx.api('POST', '/v1/sessions', { host: 'claude', repo: 'my-repo', pid: process.pid,
      startedAt: new Date().toISOString(), wake: 'claude-socket' });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return `${response.body.sessionId}:${response.body.key}`;
  };
  const [one, two] = [await register(), await register()];
  const client = 'claude-code/0f6c1d2e-aaaa-4bbb-8ccc-123456789abc';
  const body = { origins: [ORIGIN], reason: 'Check members' };
  const ask = session => ctx.api('POST', '/v1/requests', body, { headers: { 'X-Fai-Client': client, ...(session ? { 'X-Fai-Session': session } : {}) } });
  const first = await ask(one);
  assert.equal(first.status, 201);
  const same = await ask(one);
  assert.equal(same.status, 200);
  assert.equal(same.body.requestId, first.body.requestId, 'the same session gets its pending request back');
  const other = await ask(two);
  assert.equal(other.status, 201);
  assert.notEqual(other.body.requestId, first.body.requestId, 'another session owns its own request');
  const none = await ask(null);
  assert.equal(none.status, 201);
  assert.ok(![first.body.requestId, other.body.requestId].includes(none.body.requestId), 'no session is not session one');
  assert.equal((await ask(two)).body.requestId, other.body.requestId);
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

test('an origin_changed pause that names the origin: the request view and needs.message say where the tab went', async t => {
  const ctx = await setup(t);
  const requestId = await approved(ctx);
  const leaseId = ctx.daemon.request(requestId).lease.leaseId;
  await ctx.hub.emit({ type: 'status', leaseId, status: 'paused', reason: 'origin_changed', origin: 'https://login.example.org' });
  assert.equal(ctx.daemon.request(requestId).stateReason, 'origin_changed');
  assert.equal(ctx.daemon.request(requestId).leftOrigin, 'https://login.example.org');
  const blocked = await ctx.api('POST', '/v1/act', { requestId, actionId: 'a0' });
  assert.equal(blocked.body.result.code, 'origin_changed');
  assert.match(blocked.body.result.needs.message, /^Paused: the tab left the approved sites\./);
  // The origin is page-chosen: in leftOrigin (untrusted), never in the trusted needs.message, which names the remedy:
  // the same request asks for it (issue #30).
  assert.match(blocked.body.result.needs.message, /It went to leftOrigin \(page-chosen.*fai_browser_open with this requestId/);
  assert.doesNotMatch(blocked.body.result.needs.message, /login\.example\.org/);
  assert.equal(blocked.body.result.leftOrigin, 'https://login.example.org');
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
  const closed = await ctx.api('POST', '/v1/act', { requestId: first, actionId: 'a0' });
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
  const first = await actOn(ctx, requestId, 'About');
  const second = await actOn(ctx, requestId, 'Members');
  const dirs = await readdir(join(ctx.home, 'artifacts'));
  assert.deepEqual(dirs, [second.runId]);
  assert.notEqual(first.runId, second.runId);
  const noPrune = await actOn(ctx, requestId, 'Home', { prune: false });
  assert.equal((await readdir(join(ctx.home, 'artifacts'))).length, 2);
  assert.ok(noPrune.result.trace);
});

test('the log carries routes and states but never the key, secret, token or supplied text', async t => {
  const ctx = await setup(t, { bridgeOptions: { path: '/form' } });
  const requestId = await approved(ctx, { mode: 'reversible' });
  await ctx.api('POST', '/v1/observe', { requestId, suppliedText: { name: 'supplied-secret-value-4411' } });
  const observed = await ctx.api('POST', '/v1/observe', { requestId });
  const fill = observed.body.actions.find(action => action.type === 'fill_supplied_text');
  assert.ok(fill, JSON.stringify(observed.body.actions));
  await ctx.api('POST', '/v1/act', { requestId, actionId: fill.id, revision: observed.body.revision });
  await ctx.api('GET', '/v1/status', undefined, { token: 'wrong-token' });
  const log = await readFile(ctx.logFile, 'utf8');
  const env = await readFile(join(ctx.home, '.env.local'), 'utf8');
  const secret = /FAI_BRIDGE_SECRET="([^"]+)"/.exec(env)[1];
  assert.ok(secret.length >= 24);
  assert.match(log, /"route":"act"/);
  assert.match(log, /"event":"run_done"/);
  for (const forbidden of [KEY, secret, ctx.daemon.token, 'supplied-secret-value-4411', 'Profile form', 'wrong-token']) {
    assert.ok(!log.includes(forbidden), `log contains ${forbidden.slice(0, 6)}...`);
  }
  assert.equal((await stat(ctx.logFile)).mode & 0o777, 0o600);
});

test('reload re-reads settings and config; shutdown is requested over the API', async t => {
  const ctx = await setup(t);
  await writeFile(join(ctx.home, 'config.json'), JSON.stringify({ budget: { maxCalls: 7 } }));
  const reloaded = await ctx.api('POST', '/v1/daemon/reload');
  assert.equal(reloaded.body.ok, true);
  assert.equal(reloaded.body.secretChanged, false);
  assert.equal((await ctx.api('GET', '/v1/status')).body.budget.maxCalls, 7);
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

test('close releases leases with daemon_shutdown and answers 503 meanwhile', async t => {
  const ctx = await setup(t);
  const requestId = await approved(ctx);
  const leaseId = ctx.daemon.request(requestId).lease.leaseId;
  const closing = ctx.daemon.close();
  const during = await ctx.api('GET', '/v1/status').catch(() => null);
  if (during) assert.equal(during.body.error.code, 'shutting_down');
  await closing;
  assert.deepEqual(ctx.hub.updates.at(-1), { leaseId, state: 'released', reason: 'daemon_shutdown' });
  assert.equal(ctx.hub.closed, true);
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
  // The bound: 10000 calls applies; 10001 is out of bounds and config.json applies again.
  reply = await ctx.hub.emit({ type: 'settings', settings: { budget: { maxCalls: 10_000, maxMs: 14_400_000 } } });
  assert.deepEqual(reply.budget, { maxCalls: 10_000, maxMs: 14_400_000, source: 'extension' });
  reply = await ctx.hub.emit({ type: 'settings', settings: { budget: { maxCalls: 10_001, maxMs: 14_400_000 } } });
  assert.deepEqual(reply.budget, { maxCalls: 9, maxMs: 1_200_000, source: 'config' });
});

test('config.json budget.maxCalls takes up to 10000; 10001 is refused at reload', async t => {
  const ctx = await setup(t);
  await writeFile(join(ctx.home, 'config.json'), JSON.stringify({ budget: { maxCalls: 10_000 } }));
  assert.equal((await ctx.api('POST', '/v1/daemon/reload')).body.ok, true);
  assert.deepEqual((await ctx.api('GET', '/v1/status')).body.budget, { maxCalls: 10_000, maxMs: 1_200_000, source: 'config' });
  await writeFile(join(ctx.home, 'config.json'), JSON.stringify({ budget: { maxCalls: 10_001 } }));
  const refused = await ctx.api('POST', '/v1/daemon/reload');
  assert.equal(refused.status, 400);
  assert.match(JSON.stringify(refused.body), /budget\.maxCalls must be 1 to 10000/);
  assert.equal((await ctx.api('GET', '/v1/status')).body.budget.maxCalls, 10_000, 'the last valid config.json stays in effect');
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
  const blocked = async requestId => (await ctx.api('POST', '/v1/act', { requestId, actionId: 'a0', expectation: { urlIncludes: '/x' } })).body.result;
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
