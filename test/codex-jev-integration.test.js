import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDaemon } from '../src/daemon.js';
import { FakeBridge, ORIGIN, PAGES } from './runtime-fixtures.js';
import { createFakeHub, call } from './helpers/fake-hub.js';
import { spawnMcp } from './helpers/mcp-harness.js';
import { mcpData } from './helpers/mcp-result.js';

async function setup(t, { shotDocument = '/about', blocked = false } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'codex-jev-integration-'));
  const hub = createFakeHub();
  class LiveBridge extends FakeBridge {
    get observation() { return { ...super.observation, revision: `${this.path}:${this.version}` }; }
  }
  const bridge = new LiveBridge({ pages: { ...PAGES, '/': { ...PAGES['/'],
    warnings: ['controls_capped'], consent: { text: 'Cookies', buttons: [] } } } });
  hub.bridges.set(1, bridge);
  const originalBridgeFor = hub.bridgeFor.bind(hub);
  hub.bridgeFor = leaseId => ({ ...originalBridgeFor(leaseId), capture: async () => ({
    dataUrl: 'data:image/jpeg;base64,YQ==', revision: `${shotDocument}:99`, format: 'jpeg',
  }) });
  const daemon = createDaemon({ driver: 'jev', home, port: 0, hub,
    env: { FAI_BRIDGE_SECRET: 'codex-jev-disposable-pairing-000000' },
    providerFactory: () => ({ async decide(_, actions) {
      return blocked ? { actionId: 'handoff', done: { probability: 0.99 }, guards: { blocked: 0.95 } }
        : { actionId: actions.find(a => a.label === 'About')?.id ?? 'handoff', done: { probability: 0.05 } };
    } }),
  });
  await daemon.listen();
  t.after(async () => { await daemon.close(); await rm(home, { recursive: true, force: true }); });
  const api = (method, path, body) => call(daemon.port, method, path, body, { token: daemon.token });
  const request = await api('POST', '/v1/requests', { origins: [ORIGIN], reason: 'Read About' });
  const requestId = request.body.requestId;
  const lease = await hub.approve(requestId);
  assert.deepEqual(lease.origins, [ORIGIN], 'lease exposes only the approved request origins');
  const env = { PATH: process.env.PATH, FAI_HOME: home, FAI_DAEMON_PORT: String(daemon.port),
    FAI_CLIENT_TOKEN: daemon.token };
  return { api, requestId, bridge, env };
}

async function cli(args, env) {
  const child = spawn(process.execPath, [new URL('../src/cli.js', import.meta.url).pathname, ...args],
    { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.resume();
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  return { code, value: JSON.parse(stdout) };
}

test('codex Jev: CLI and MCP observe preserve warnings, consent and choose next', async t => {
  const { requestId, env } = await setup(t);
  const mcp = spawnMcp(env);
  t.after(() => mcp.child.kill('SIGKILL'));
  await mcp.initialize();
  const observed = await mcp.callTool('fai_browser_observe', { requestId, returnImages: 'none' });
  assert.equal(observed.isError, undefined, JSON.stringify(observed));
  const result = await cli(['observe', '--request', requestId, '--capture', 'none'], env);
  assert.equal(result.code, 0);
  const data = mcpData(observed);
  assert.deepEqual(result.value.warnings, data.warnings);
  assert.match(data.text, /^cookie dialog: Cookies/m, 'consent stays in the text');
  assert.equal(result.value.next.kind, 'choose');
  assert.equal(data.next.kind, 'choose');
  assert.equal(typeof result.value.next.text, 'string');
});

for (const [document, kept] of [['/about', true], ['/different', false]]) {
  test(`codex Jev: capture last evidence ${kept ? 'keeps a later revision' : 'rejects another document'}`, async t => {
    const { requestId, env, bridge, api } = await setup(t, { shotDocument: document });
    delete bridge.pages['/'].consent;
    const run = await cli(['run', 'Open About', '--request', requestId, '--capture', 'last', '--max-actions', '1'], env);
    const runId = run.value.runId;
    const trace = await api('GET', `/v1/runs/${runId}/evidence?kind=trace`);
    const raw = await readFile(trace.body.path, 'utf8');
    assert.ok(!raw.includes('data:image/') && !raw.includes('base64'));
    const evidence = await cli(['evidence', runId, '--kind', 'screenshot'], env);
    if (kept) {
      assert.equal(evidence.code, 0);
      assert.equal(trace.body.trace.steps[0].screenshot.observedRevision, '/about:2');
      assert.equal(trace.body.trace.steps[0].screenshot.revision, '/about:99');
    } else {
      assert.notEqual(evidence.code, 0);
      assert.equal(trace.body.trace.steps[0].captureError.code, 'revision_mismatch');
    }
  });
}

test('codex Jev: blocked runtime outcome survives CLI with exit code 2 and relay', async t => {
  const { requestId, env, bridge } = await setup(t, { blocked: true });
  delete bridge.pages['/'].consent;
  const result = await cli(['run', 'Read home', '--request', requestId, '--capture', 'none'], env);
  assert.equal(result.code, 2);
  assert.equal(result.value.code, 'blocked');
  assert.equal(result.value.status, 'needs_user');
  assert.equal(result.value.next.kind, 'relay');
});
