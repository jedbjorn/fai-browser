// The updater inside the daemon: the scheduled check (mocked fetch), `update` in status and in the extension's hello,
// the popup's `update` message (status, install with its refusals), the hub's authenticated /update route, and the
// MCP status line. The real updater process is never started: `spawnUpdater` is a recorder.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDaemon } from '../src/daemon.js';
import { createHub } from '../src/bridge.js';
import { controlText } from '../src/mcp.js';
import { RELEASES_API, UPDATE_REPO } from '../src/update.js';
import { call, createFakeHub } from './helpers/fake-hub.js';
import { EXTENSION_ID, EXTENSION_ORIGIN, SECRET } from './helpers/fake-extension.js';

const SHA = 'c'.repeat(40);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function releaseFetch(tag = 'v9.0.0') {
  const calls = [];
  const fetch = async url => {
    calls.push(String(url));
    if (String(url) === RELEASES_API) {
      return new Response(JSON.stringify({ tag_name: tag, draft: false, prerelease: false, target_commitish: 'main',
        published_at: '2026-11-20T10:00:00Z' }), { status: 200, headers: { etag: '"x"' } });
    }
    return new Response(SHA, { status: 200 });
  };
  fetch.calls = calls;
  return fetch;
}

async function setup(t, options = {}) {
  const home = options.home ?? await mkdtemp(join(tmpdir(), 'fai-update-daemon-'));
  const hub = createFakeHub();
  const spawned = [];
  const daemon = createDaemon({ home, env: options.env ?? { FAI_BRIDGE_SECRET: SECRET }, port: 0, hub, sweepIntervalMs: 60_000,
    updateStartupDelayMs: 0, updateInstallable: true,
    // The recorder answers with this test process's pid: alive, like a real updater that just started.
    spawnUpdater: (args, env) => {
      spawned.push({ args, env });
      return process.pid;
    }, ...options });
  await daemon.listen();
  t.after(async () => {
    await daemon.close();
    await rm(home, { recursive: true, force: true });
  });
  const api = (method, path, body) => call(daemon.port, method, path, body, { token: daemon.token });
  return { home, hub, daemon, api, spawned };
}

async function untilAvailable(api) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const { body } = await api('GET', '/v1/status');
    if (body.update?.available) return body.update;
    await sleep(10);
  }
  throw new Error('no update became available');
}

test('daemon: under node --test it never checks unless told to; status still carries the update block', async t => {
  const fetch = releaseFetch();
  const { api } = await setup(t, { updateFetch: fetch });
  await sleep(50);
  assert.equal(fetch.calls.length, 0);
  const { body } = await api('GET', '/v1/status');
  assert.equal(body.update.enabled, false);
  assert.equal(body.update.status, 'never');
  assert.equal(body.update.available, false);
});

test('daemon: the startup check finds a newer release; status, hello and the update message show it', async t => {
  const fetch = releaseFetch('v9.0.0');
  const { api, hub } = await setup(t, { updateFetch: fetch, updateCheck: true });
  const update = await untilAvailable(api);
  assert.equal(update.latest, '9.0.0');
  assert.equal(update.tag, 'v9.0.0');
  assert.equal(update.notesUrl, `https://github.com/${UPDATE_REPO}/releases/tag/v9.0.0`);
  assert.equal(update.install, null);
  assert.deepEqual(fetch.calls, [RELEASES_API, `https://api.github.com/repos/${UPDATE_REPO}/commits/v9.0.0`]);
  const hello = await hub.emit({ type: 'hello', session: null });
  assert.equal(hello.update.available, true);
  const status = await hub.emit({ type: 'update', action: 'status' });
  assert.equal(status.update.latest, '9.0.0');
  assert.equal((await api('POST', '/v1/update', {})).status, 404, 'no client-API route installs anything');
  const text = controlText({ state: 'ok', update });
  assert.match(text, /update: FAI Browser 9\.0\.0 is available .*Never update it yourself\./);
});

test('daemon: Update from the popup refuses during a lease and otherwise starts the updater with the validated tag', async t => {
  const { api, hub, spawned, daemon, home } = await setup(t, { updateFetch: releaseFetch('v9.0.0'), updateCheck: true });
  await untilAvailable(api);
  const { body: created } = await api('POST', '/v1/requests', { origins: ['https://example.com'], reason: 'Check it' });
  await hub.approve(created.requestId);
  const refused = await hub.emit({ type: 'update', action: 'install' });
  assert.equal(refused.error.code, 'lease_active');
  assert.equal(spawned.length, 0);
  await api('DELETE', `/v1/requests/${created.requestId}`, {});
  const started = await hub.emit({ type: 'update', action: 'install' });
  assert.equal(started.update.install.state, 'running', JSON.stringify(started));
  assert.equal(started.update.install.to, '9.0.0');
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0].args.slice(1), ['update', '--tag', 'v9.0.0']);
  assert.match(spawned[0].args[0], /src[/\\]cli\.js$/);
  assert.equal(spawned[0].env.FAI_DAEMON_PORT, String(daemon.port));
  assert.equal(spawned[0].env.FAI_HOME, home);
  const unknown = await hub.emit({ type: 'update', action: 'rm -rf' });
  assert.equal(unknown.error.code, 'invalid_action');
});

test('M1: the updater starts from the launch environment without the Jev key, a pairing override or a client token', async t => {
  const home = await mkdtemp(join(tmpdir(), 'fai-update-env-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, '.env.local'), `FAI_BRIDGE_SECRET=${SECRET}\nTYPESAFE_API_KEY=fake-review-key-not-real\n`, { mode: 0o600 });
  const env = { FAI_BRIDGE_SECRET: SECRET, FAI_CLIENT_TOKEN: 'f'.repeat(64), PATH: process.env.PATH ?? '' };
  const ctx = await setup(t, { home, env, updateFetch: releaseFetch('v9.0.0'), updateCheck: true });
  await untilAvailable(ctx.api);
  assert.equal(env.TYPESAFE_API_KEY, 'fake-review-key-not-real', 'the daemon itself loaded the key');
  const started = await ctx.hub.emit({ type: 'update', action: 'install' });
  assert.equal(started.update.install.state, 'running');
  const childEnv = ctx.spawned[0].env;
  for (const name of ['TYPESAFE_API_KEY', 'FAI_BRIDGE_SECRET', 'FAI_CLIENT_TOKEN']) assert.equal(childEnv[name], undefined, name);
  assert.ok(!JSON.stringify(childEnv).includes('fake-review-key-not-real'));
  assert.equal(childEnv.PATH, env.PATH);
});

test('M2/S4: while an update installs, a second click, new tab requests and approvals are refused', async t => {
  const { api, hub, spawned, home } = await setup(t, { updateFetch: releaseFetch('v9.0.0'), updateCheck: true });
  await untilAvailable(api);
  const { body: pending } = await api('POST', '/v1/requests', { origins: ['https://example.com'], reason: 'Before the update' });
  await hub.emit({ type: 'update', action: 'install' });
  const { readInstallState, runningUpdate } = await import('../src/update.js');
  const { homePaths } = await import('../src/home.js');
  const paths = homePaths({ home, env: { FAI_HOME: home } });
  assert.equal(runningUpdate(paths), process.pid, 'the daemon wrote the lock for the updater it started');
  assert.equal(readInstallState(paths).state, 'running');
  assert.equal((await hub.emit({ type: 'update', action: 'install' })).error.code, 'update_running');
  assert.equal(spawned.length, 1, 'a second click starts nothing');
  const blocked = await api('POST', '/v1/requests', { origins: ['https://example.com'], reason: 'During the update' });
  assert.equal(blocked.status, 503);
  assert.equal(blocked.body.error.code, 'update_running');
  assert.match(blocked.body.error.message, /retry in a minute/);
  const approval = await hub.approve(pending.requestId);
  assert.equal(approval.error.code, 'update_running');
  const { unlink } = await import('node:fs/promises');
  const { updatePaths } = await import('../src/update.js');
  await unlink(updatePaths(paths).lock);
  assert.equal((await api('POST', '/v1/requests', { origins: ['https://example.com'], reason: 'After' })).status, 201);
});

test('M2: the restart looks at the leases again and stops nothing while a tab is held', async t => {
  const { api, hub, daemon, home } = await setup(t);
  const { body: created } = await api('POST', '/v1/requests', { origins: ['https://example.com'], reason: 'Hold a tab' });
  await hub.approve(created.requestId);
  const { LeaseHeld, restartDaemon } = await import('../src/update-install.js');
  await assert.rejects(restartDaemon({ home, env: { FAI_HOME: home, FAI_DAEMON_PORT: String(daemon.port) }, version: '9.9.9' }),
    error => error instanceof LeaseHeld && error.daemonUntouched === true);
  assert.equal((await api('GET', '/v1/health')).status, 200, 'the daemon still runs');
  assert.equal((await api('GET', `/v1/requests/${created.requestId}`)).body.state, 'active', 'the task keeps its tab');
});

test('daemon: a copy that is not a git clone shows the update but offers no install; a private repo is found by git', async t => {
  const npm = await setup(t, { updateFetch: releaseFetch('v9.0.0'), updateCheck: true, updateInstallable: false });
  const view = await untilAvailable(npm.api);
  assert.equal(view.installable, false);
  assert.equal((await npm.hub.emit({ type: 'update', action: 'install' })).error.code, 'not_git');
  assert.equal(npm.spawned.length, 0);
  const notFound = async () => new Response('{"message":"Not Found"}', { status: 404 });
  const priv = await setup(t, { updateFetch: notFound, updateCheck: true,
    updateGitSource: async () => ({ tag: 'v9.1.0', version: '9.1.0', commit: SHA }) });
  const found = await untilAvailable(priv.api);
  assert.equal(found.source, 'git');
  assert.equal(found.latest, '9.1.0');
});

test('daemon: nothing to install when up to date, and no real updater under node --test', async t => {
  const same = await setup(t, { updateFetch: releaseFetch('v0.0.1'), updateCheck: true });
  await sleep(50);
  assert.equal((await same.hub.emit({ type: 'update', action: 'install' })).error.code, 'no_update');
  const real = await setup(t, { updateFetch: releaseFetch('v9.0.0'), updateCheck: true, spawnUpdater: undefined });
  await untilAvailable(real.api);
  assert.equal((await real.hub.emit({ type: 'update', action: 'install' })).error.code, 'update_failed');
});

test('hub: the update message needs the paired extension and passes only known actions to the daemon', async t => {
  const hub = createHub({ secret: SECRET, extensionId: EXTENSION_ID, mode: 'daemon', log: () => {} });
  const events = [];
  hub.onEvent(event => {
    if (event.type === 'update') events.push(event);
    if (event.type === 'update') event.reply({ update: { available: true, latest: '9.0.0' } });
  });
  const server = http.createServer((req, res) => {
    if (!hub.handleHttp(req, res)) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => {
    hub.close();
    server.closeAllConnections();
    await new Promise(done => server.close(done));
  });
  const post = (body, headers) => fetch(`http://127.0.0.1:${server.address().port}/update`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
    .then(async response => ({ status: response.status, body: await response.json() }));
  const auth = { Origin: EXTENSION_ORIGIN, Authorization: `Bearer ${SECRET}` };
  assert.equal((await post({ action: 'install' }, { Origin: EXTENSION_ORIGIN })).status, 403);
  assert.equal((await post({ action: 'install' }, { Origin: 'https://evil.example', Authorization: `Bearer ${SECRET}` })).status, 403);
  assert.equal(events.length, 0);
  const ok = await post({ action: 'install' }, auth);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.update.latest, '9.0.0');
  assert.deepEqual(events.map(event => event.action), ['install']);
  const bad = await post({ action: 'exec' }, auth);
  assert.equal(bad.body.code, 'invalid_action');
  assert.equal(events.length, 1);
});
