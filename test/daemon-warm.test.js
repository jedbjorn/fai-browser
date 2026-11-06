// Provider warm-up in the daemon: in the background at start and on tab approval, never blocking readiness, never
// failing startup (no key, network down) and never logging secrets.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDaemon } from '../src/daemon.js';
import { TypeSafeProvider } from '../src/typesafe.js';
import { ORIGIN, clickProvider } from './runtime-fixtures.js';
import { call, createFakeHub } from './helpers/fake-hub.js';

const KEY = 'jev-warm-key-must-not-be-logged-5521';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(predicate, ms = 2000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await delay(5);
  }
}

async function setup(t, { env = { TYPESAFE_API_KEY: KEY }, providerFactory, warm } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'fai-daemon-warm-'));
  const hub = createFakeHub();
  const events = [];
  const log = (event, data) => events.push({ event, ...data });
  const daemon = createDaemon({ driver: 'jev', home, env, port: 0, hub, log, sweepIntervalMs: 60_000, providerFactory,
    ...(warm === undefined ? {} : { warm }) });
  t.after(async () => {
    await daemon.close();
    await rm(home, { recursive: true, force: true });
  });
  return { home, hub, daemon, events };
}

/** A provider whose warm() resolves only when released, recording each call. */
function warmable() {
  const calls = [];
  let release;
  const gate = new Promise(resolve => {
    release = resolve;
  });
  const provider = Object.assign(clickProvider(['About']), {
    async warm(options) {
      calls.push(options);
      await gate;
      return { ok: true, status: 200, ms: 12 };
    },
  });
  return { provider, calls, release };
}

test('the daemon warms the provider at start without waiting for it', async t => {
  const { provider, calls, release } = warmable();
  const ctx = await setup(t, { providerFactory: () => provider });
  await ctx.daemon.listen(); // resolves while warm() is still pending
  await until(() => calls.length === 1);
  assert.ok(calls[0].signal instanceof AbortSignal, 'shutdown can abandon it');
  const health = await call(ctx.daemon.port, 'GET', '/v1/health');
  assert.equal(health.status, 200, 'the daemon serves while the warm-up is pending');
  // An approval while the start warm-up is still pending does not start a second one.
  const api = (method, path, body) => call(ctx.daemon.port, method, path, body, { token: ctx.daemon.token });
  const pending = ctx.daemon.warming;
  assert.ok(pending, 'the start warm-up is in flight');
  const requestId = (await api('POST', '/v1/requests', { origins: [ORIGIN], reason: 'r' })).body.requestId;
  await ctx.hub.approve(requestId);
  assert.equal(ctx.daemon.warming, pending, 'one warm-up at a time: the approval joined the pending one');
  release();
  await pending;
  assert.equal(calls.length, 1);
  await until(() => ctx.events.some(entry => entry.event === 'provider_warm'));
  assert.deepEqual(ctx.events.find(entry => entry.event === 'provider_warm'),
    { event: 'provider_warm', reason: 'start', ok: true, status: 200, ms: 12 });
});

test('approving a tab warms again; warm: false disables it', async t => {
  const made = [];
  const ctx = await setup(t, { providerFactory: () => {
    const entry = warmable();
    entry.release();
    made.push(entry);
    return entry.provider;
  } });
  await ctx.daemon.listen();
  await until(() => ctx.events.filter(entry => entry.event === 'provider_warm').length === 1);
  const api = (method, path, body) => call(ctx.daemon.port, method, path, body, { token: ctx.daemon.token });
  const requestId = (await api('POST', '/v1/requests', { origins: [ORIGIN], reason: 'r' })).body.requestId;
  await ctx.hub.approve(requestId);
  await until(() => ctx.events.filter(entry => entry.event === 'provider_warm').length === 2);
  assert.equal(ctx.events.filter(entry => entry.event === 'provider_warm')[1].reason, 'approval');

  const off = await setup(t, { providerFactory: () => {
    throw new Error('the factory must not be called');
  }, warm: false });
  await off.daemon.listen();
  assert.equal(off.daemon.warming, null, 'no warm-up was started');
  assert.ok(!off.events.some(entry => entry.event.startsWith('provider_warm')));
});

test('a missing key, a throwing factory or a provider without warm() never fails startup or logs a message', async t => {
  // The default factory without a key: a config error, logged as a code only.
  const nokey = await setup(t, { env: {} });
  await nokey.daemon.listen();
  await until(() => nokey.events.some(entry => entry.event === 'provider_warm_skipped'));
  assert.deepEqual(nokey.events.find(entry => entry.event === 'provider_warm_skipped'),
    { event: 'provider_warm_skipped', reason: 'start', code: 'config' });

  const throwing = await setup(t, { providerFactory: () => {
    throw new Error(`boom with ${KEY}`);
  } });
  await throwing.daemon.listen();
  await until(() => throwing.events.some(entry => entry.event === 'provider_warm_skipped'));
  assert.equal(throwing.events.find(entry => entry.event === 'provider_warm_skipped').code, 'unavailable');
  assert.ok(!JSON.stringify(throwing.events).includes(KEY), 'no error text, no key');

  const plain = await setup(t, { providerFactory: () => clickProvider(['About']) });
  await plain.daemon.listen();
  const warming = plain.daemon.warming;
  assert.ok(warming, 'a warm-up was started');
  await warming; // settled: the provider had no warm(), so nothing was logged
  assert.ok(!plain.events.some(entry => entry.event.startsWith('provider_warm')));
});

test('network down: the warm-up logs ok false without the error text, and shutdown abandons a pending one', async t => {
  const seen = [];
  const down = await setup(t, { providerFactory: ({ options }) => new TypeSafeProvider({ ...options,
    fetchImpl: async (url, init) => {
      seen.push({ url: String(url), init });
      throw new Error(`getaddrinfo ENOTFOUND api.typesafe.ai ${KEY}`);
    } }) });
  await down.daemon.listen();
  await until(() => down.events.some(entry => entry.event === 'provider_warm'));
  const entry = down.events.find(item => item.event === 'provider_warm');
  assert.equal(entry.ok, false);
  assert.equal(entry.status, null);
  assert.ok(!JSON.stringify(down.events).includes(KEY));
  assert.ok(!JSON.stringify(down.events).includes('ENOTFOUND'));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].init.method, 'GET');
  assert.equal(seen[0].init.headers, undefined, 'the warm-up never sends the key');
  assert.match(seen[0].url, /\/v1\/models$/);

  // A warm-up that never answers: close() aborts it and nothing is logged after shutdown.
  let aborted = false;
  let entered;
  const fetching = new Promise(resolve => { entered = resolve; });
  const hanging = await setup(t, { providerFactory: ({ options }) => new TypeSafeProvider({ ...options,
    fetchImpl: (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        aborted = true;
        reject(init.signal.reason);
      }, { once: true });
      entered();
    }) }) });
  await hanging.daemon.listen();
  const inFlight = hanging.daemon.warming;
  assert.ok(inFlight);
  await fetching; // Ensure this exercises an in-flight abort, rather than cancelling before the fetch starts.
  await hanging.daemon.close();
  await inFlight; // settles once close() aborted the fetch
  assert.ok(aborted);
  assert.ok(!hanging.events.some(item => item.event === 'provider_warm'));
});

test('a run warms its own provider (with its providerOptions) next to its first observe', async t => {
  const specs = [];
  const ctx = await setup(t, { providerFactory: spec => {
    specs.push(spec.options);
    const entry = warmable();
    entry.release();
    return entry.provider;
  } });
  await ctx.daemon.listen();
  await ctx.daemon.warming;
  const api = (method, path, body) => call(ctx.daemon.port, method, path, body, { token: ctx.daemon.token });
  const requestId = (await api('POST', '/v1/requests', { origins: [ORIGIN], reason: 'r' })).body.requestId;
  await ctx.hub.approve(requestId);
  await ctx.daemon.warming;
  const run = await api('POST', '/v1/runs', { requestId, instruction: 'Open About', providerOptions: { model: 'kev-test' },
    expectation: { urlIncludes: '/about' } });
  assert.equal(run.body.result.status, 'completed');
  await ctx.daemon.warming;
  const warms = ctx.events.filter(entry => entry.event === 'provider_warm').map(entry => entry.reason);
  assert.deepEqual(warms, ['start', 'approval', 'run']);
  assert.equal(specs.at(-1).model, 'kev-test', 'the run provider, built from the run spec, is the one warmed');
});
