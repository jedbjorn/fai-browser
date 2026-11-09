// Regression tests from the security review of feat/invite: the MCP session loop never stops a newer daemon after an
// update and never registers with (or sends the client token to) something that cannot prove it holds the token; an
// inherited messaging socket is not this session's; next texts promise a wake only for this session's own requests and
// never steer it into another session's tab. Browserless; every socket and daemon here is a throwaway.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { FaiBrowserClient } from '../src/client.js';
import { createDaemon } from '../src/daemon.js';
import { homePaths, saveDriver } from '../src/home.js';
import { AgentSession } from '../src/mcp-session.js';
import { call, createFakeHub } from './helpers/fake-hub.js';
import { startFakeClaudeSocket } from './helpers/fake-agents.js';
import { spawnMcp } from './helpers/mcp-harness.js';
import { ORIGIN } from './runtime-fixtures.js';

const PACKAGE = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

/** A stand-in daemon answering health with `version` (and `proof`, a function of the challenge), recording every call. */
async function fakeDaemon(t, { version, proof = () => undefined }) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push({ method: req.method, url: req.url, auth: req.headers.authorization ?? null });
    res.setHeader('content-type', 'application/json');
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/v1/health') {
      return res.end(JSON.stringify({ ok: true, service: 'fai-browser', version, pid: 1, proof: proof(url.searchParams.get('challenge')) }));
    }
    if (url.pathname === '/v1/status') return res.end(JSON.stringify({ requests: [], runs: { active: [] } }));
    if (url.pathname === '/v1/daemon/shutdown') return res.end('{"ok":true}');
    if (url.pathname === '/v1/sessions') {
      res.statusCode = 201;
      return res.end(JSON.stringify({ sessionId: 'ses_fake', key: 'k' }));
    }
    res.statusCode = 404;
    return res.end('{"error":{"code":"not_found"}}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const home = await mkdtemp(join(tmpdir(), 'fai-review-'));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(home, { recursive: true, force: true });
  });
  const env = { FAI_HOME: home, FAI_DAEMON_PORT: String(server.address().port), FAI_CLIENT_TOKEN: 'fake-token-for-test-only-xxxxxxxx',
    PATH: process.env.PATH };
  return { hits, home, env };
}

test('review: an old MCP server\'s session loop never shuts down a newer, idle daemon; it waits for its own call', async t => {
  const fake = await fakeDaemon(t, { version: '9.9.9' });
  const session = new AgentSession({ env: fake.env, home: fake.home, connect: options => FaiBrowserClient.connect(options),
    clientName: 'probe', host: 'unknown', backoffMs: 50 });
  session.start();
  await delay(800);
  assert.equal(fake.hits.filter(hit => hit.url.includes('shutdown')).length, 0, 'no takeover from the background loop');
  assert.equal(fake.hits.filter(hit => hit.url === '/v1/sessions').length, 0, 'no registration with another version');
  assert.equal(session.held, true);
  const probes = fake.hits.length;
  await delay(300);
  assert.equal(fake.hits.length, probes, 'held: no polling until this server\'s own call kicks it');
  session.kick();
  await delay(200);
  assert.ok(fake.hits.length > probes, 'a kick tries again');
  assert.equal(fake.hits.filter(hit => hit.url.includes('shutdown')).length, 0);
  await session.stop();
});

test('review: a process squatting on the port gets no registration and never sees the client token', async t => {
  const squatter = await fakeDaemon(t, { version: PACKAGE.version, proof: () => 'f'.repeat(64) });
  const session = new AgentSession({ env: squatter.env, home: squatter.home, connect: options => FaiBrowserClient.connect(options),
    clientName: 'probe', host: 'claude', backoffMs: 50 });
  session.start();
  await delay(500);
  await session.stop();
  assert.ok(squatter.hits.some(hit => hit.url.startsWith('/v1/health?challenge=')), 'it was challenged');
  assert.equal(squatter.hits.filter(hit => hit.url === '/v1/sessions').length, 0, 'no registration');
  assert.ok(squatter.hits.every(hit => hit.auth === null), 'no request carried the token');
  assert.equal(session.sessionId, null);
});

test('review: a daemon without the proof (an older one) turns invites and wakes off instead of registering', async t => {
  const older = await fakeDaemon(t, { version: PACKAGE.version });
  const session = new AgentSession({ env: older.env, home: older.home, connect: options => FaiBrowserClient.connect(options),
    clientName: 'probe', host: 'claude', backoffMs: 50 });
  session.start();
  await delay(300);
  assert.equal(session.disabled, true);
  assert.equal(older.hits.filter(hit => hit.url === '/v1/sessions').length, 0);
  await session.stop();
});

async function realSetup(t, { socketPid = process.pid } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'fai-review-mcp-'));
  saveDriver('agent', homePaths({ home, env: {} }));
  const hub = createFakeHub();
  const daemon = createDaemon({ home, env: {}, port: 0, hub, providerFactory: () => { throw new Error('no provider'); } });
  await daemon.listen();
  const fake = await startFakeClaudeSocket(t, { pid: socketPid });
  const mcp = spawnMcp({ PATH: process.env.PATH, HOME: home, FAI_HOME: home, FAI_DAEMON_PORT: String(daemon.port),
    FAI_MCP_APPROVAL_WAIT_MS: '300', CLAUDE_CODE_MESSAGING_SOCKET: fake.path, CLAUDE_CODE_MESSAGING_TOKEN: fake.token });
  t.after(async () => {
    await mcp.close();
    await daemon.close();
    await rm(home, { recursive: true, force: true });
  });
  await mcp.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'claude-code', version: 'test' } });
  mcp.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const api = (method, path, body) => call(daemon.port, method, path, body, { token: daemon.token });
  let session;
  for (let i = 0; i < 200 && !session; i++) {
    session = (await api('GET', '/v1/status')).body.sessions?.[0];
    if (!session) await delay(20);
  }
  return { hub, daemon, mcp, api, fake, session };
}

const text = result => result.content.map(block => block.text ?? '').join('\n');

test('review: an inherited messaging socket (named after another process) is not used: no wake, the wait command', async t => {
  const ctx = await realSetup(t, { socketPid: 999999 });
  assert.equal(ctx.session.host, 'claude');
  assert.equal(ctx.session.wake, 'none', 'the socket of a Claude Code that did not start this server');
  const opening = await ctx.mcp.callTool('fai_browser_open', { origins: [ORIGIN], reason: 'Check' });
  assert.match(text(opening), /--until active/);
});

test('review: a wake is promised only for this session\'s own request, and status never points at another\'s tab', async t => {
  const ctx = await realSetup(t);
  assert.equal(ctx.session.wake, 'claude-socket');
  // A request another client made (no session): this session is not its owner, so nobody would wake it.
  const foreign = await ctx.api('POST', '/v1/requests', { origins: [ORIGIN], reason: 'Someone else' });
  const waited = await ctx.mcp.callTool('fai_browser_wait', { requestId: foreign.body.requestId, maxMs: 0 });
  assert.match(text(waited), /--until active/);
  assert.ok(!/wakes this session/.test(text(waited)));
  // Its own request: registered before it was created, so the daemon records it as the owner and the relay says so.
  const own = await ctx.mcp.callTool('fai_browser_open', { origins: [ORIGIN], reason: 'Mine' });
  assert.match(text(own), /FAI Browser wakes this session/);
  // Another session's approved tab is never this session's next step.
  await ctx.hub.approve(foreign.body.requestId, { tabId: 40 });
  const status = await ctx.mcp.callTool('fai_browser_status', {});
  assert.ok(!text(status).includes(`observe with requestId ${foreign.body.requestId}`), text(status));
  assert.ok(!new RegExp(`next \\([a-z]+\\): .*${foreign.body.requestId}`).test(text(status)));
});
