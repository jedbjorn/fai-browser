// The updater inside the daemon: the scheduled check (mocked fetch), `update` in status and in the extension's hello,
// the popup's `update` message (status, install with its refusals), the hub's authenticated /update route, and the
// MCP status line. The real updater process is never started: `spawnUpdater` is a recorder.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
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
  const home = await mkdtemp(join(tmpdir(), 'fai-update-daemon-'));
  const hub = createFakeHub();
  const spawned = [];
  const daemon = createDaemon({ home, env: { FAI_BRIDGE_SECRET: SECRET }, port: 0, hub, sweepIntervalMs: 60_000,
    updateStartupDelayMs: 0, spawnUpdater: (args, env) => spawned.push({ args, env }), ...options });
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
