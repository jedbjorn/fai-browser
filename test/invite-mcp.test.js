// Invites and wakes end to end through the spawned MCP server (src/mcp.js + src/mcp-session.js) and the real daemon
// with a fake hub: the session registers after initialize, an invite wakes it through a fake Claude Code messaging
// socket (or a fake `codex queue`), fai_browser_open {inviteId} returns the page, Approve and Resume wake the owner,
// and stdio close unregisters it. Every socket, binary and environment here is a throwaway this test makes: no real
// Claude Code or Codex session is ever reachable from it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createDaemon } from '../src/daemon.js';
import { call, createFakeHub } from './helpers/fake-hub.js';
import { spawnMcp } from './helpers/mcp-harness.js';
import { ORIGIN, link } from './runtime-fixtures.js';
import { fakeCodex, startFakeClaudeSocket } from './helpers/fake-agents.js';

const SECRET_TITLE = 'Payroll - TOP SECRET 5521';
const SECRET_TEXT = 'Salary of Ada Lovelace: 98,765';
const PAGES = {
  '/': { title: SECRET_TITLE, text: SECRET_TEXT, controls: [link('1', 'About', '/about')] },
  '/about': { title: 'About', text: 'About us', controls: [link('1', 'Home', '/')] },
};

async function until(predicate, what, ms = 8000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(20);
  }
}

async function setup(t, { clientName = 'claude-code', env = {}, socket = true } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'fai-invite-mcp-'));
  const hub = createFakeHub({ bridgeOptions: { pages: PAGES } });
  const daemon = createDaemon({ home, env: {}, port: 0, hub });
  await daemon.listen();
  const fake = socket ? await startFakeClaudeSocket(t) : null;
  // Built from scratch: never the test runner's own environment (which may be a real Claude Code session's).
  const mcpEnv = {
    PATH: process.env.PATH, HOME: home, FAI_HOME: home, FAI_DAEMON_PORT: String(daemon.port), FAI_MCP_APPROVAL_WAIT_MS: '1500',
    ...(fake ? { CLAUDE_CODE_MESSAGING_SOCKET: fake.path, CLAUDE_CODE_MESSAGING_TOKEN: fake.token } : {}),
    CLAUDE_CODE_SESSION_ID: '00000000-test-session', CLAUDE_PROJECT_DIR: '/somewhere/private/my-project',
    ...env,
  };
  const mcp = spawnMcp(mcpEnv);
  t.after(async () => {
    await mcp.close();
    await daemon.close();
    await rm(home, { recursive: true, force: true });
  });
  await mcp.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: clientName, version: 'test' } });
  mcp.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const api = (method, path, body) => call(daemon.port, method, path, body, { token: daemon.token });
  const session = await until(async () => (await api('GET', '/v1/status')).body.sessions?.[0], 'the MCP server to register');
  return { home, hub, daemon, mcp, api, fake, session, mcpEnv };
}

const text = result => result.content.map(block => block.text ?? '').join('\n');
// The invite and its wake as the popup sees them (a client without the owner's session sees only id and state).
const inviteOf = (ctx, requestId) => ctx.hub.published.at(-1)?.find(view => view.requestId === requestId)?.invite;

test('MCP: registers after initialize as Claude Code with its socket; the repo is the folder name only', async t => {
  const ctx = await setup(t);
  assert.equal(ctx.session.host, 'claude');
  assert.equal(ctx.session.wake, 'claude-socket');
  assert.equal(ctx.session.repo, 'my-project');
  const status = await ctx.mcp.callTool('fai_browser_status', {});
  assert.match(text(status), new RegExp(`agent session: ${ctx.session.sessionId} \\(claude, wake claude-socket\\)`));
  assert.ok(!text(status).includes('/somewhere/private'), 'never the path');
  const code = await ctx.mcp.close();
  assert.equal(code, 0);
  await until(async () => (await ctx.api('GET', '/v1/status')).body.sessions.length === 0, 'stdio close to unregister');
});

test('MCP: an invite wakes the session through its own socket with the FAI text only; open {inviteId} returns the page', async t => {
  const ctx = await setup(t);
  const reply = await ctx.hub.emit({ type: 'invite', tabId: 7, origin: ORIGIN, title: SECRET_TITLE, level: 'reversible',
    sessionId: ctx.session.sessionId, text: 'Summarise this page for me', browserId: 'b1' });
  assert.ok(reply.leaseId, JSON.stringify(reply));
  const inviteId = reply.invite.inviteId;
  const message = await until(() => ctx.fake.received[0], 'the wake on the fake socket');
  assert.equal(message.type, 'user');
  assert.equal(message.message.role, 'user');
  const wake = message.message.content;
  assert.match(wake, /^\[FAI Browser\] The user invited you/);
  assert.match(wake, new RegExp(`fai_browser_open with \\{"inviteId": "${inviteId}"\\}`));
  assert.match(wake, /"Summarise this page for me"/);
  // Deep scan: the wake carries no page title, text, URL or origin.
  for (const secret of [SECRET_TITLE, 'TOP SECRET', SECRET_TEXT, 'Lovelace', ORIGIN, 'example.com']) {
    assert.ok(!wake.includes(secret), `the wake must not contain ${secret}`);
  }
  await until(async () => inviteOf(ctx, reply.requestId)?.wake.state === 'delivered',
    'the delivered report');
  const opened = await ctx.mcp.callTool('fai_browser_open', { inviteId });
  assert.ok(!opened.isError, text(opened));
  const body = text(opened);
  assert.match(opened.content[0].text, new RegExp(`^invite ${inviteId}: the user invited you to this tab at level Use`));
  assert.match(opened.content[0].text, /the user's own words, not page text\): "Summarise this page for me"/);
  assert.match(body, new RegExp(reply.requestId));
  assert.match(body, /Welcome|Salary|About/);
  const again = await ctx.mcp.callTool('fai_browser_open', { inviteId });
  assert.equal(again.isError, true);
  assert.match(text(again), /invite_joined|already used/);
  assert.equal(ctx.fake.received.length, 1, 'one wake, one message');
});

test('MCP: Resume wakes the owner when it is idle; a call already waiting on the approval gets no wake', async t => {
  const ctx = await setup(t);
  // The call waits for approval itself: approving while it waits needs no wake.
  const opening = ctx.mcp.callTool('fai_browser_open', { origins: [ORIGIN], reason: 'Read the page', task: 'read' });
  const pending = await until(() => ctx.hub.published.at(-1)?.find(item => item.state === 'pending'), 'the request');
  const lease = await ctx.hub.approve(pending.requestId, { level: 'read-only' });
  const result = await opening;
  assert.ok(!result.isError, text(result));
  await delay(300);
  assert.equal(ctx.fake.received.length, 0, 'skipped: the waiting call returned the page');
  // Paused, the agent ended its turn; the user's Resume wakes it.
  await ctx.hub.emit({ type: 'status', leaseId: lease.leaseId, status: 'paused', reason: 'tab_changed' });
  const paused = await ctx.mcp.callTool('fai_browser_wait', { requestId: pending.requestId, maxMs: 0 });
  assert.match(text(paused), /FAI Browser wakes this session with a message once the user has done it/);
  assert.ok(!/--until active/.test(text(paused)), 'no background wait command for a session FAI can wake');
  await ctx.hub.approve(pending.requestId, { level: 'read-only' });
  const message = await until(() => ctx.fake.received[0], 'the resume wake');
  assert.match(message.message.content, new RegExp(`resumed tab request ${pending.requestId}.*fai_browser_observe`));
  assert.ok(!message.message.content.includes(SECRET_TITLE));
});

// Issue #13: a paused request the agent moved on from is stale; status names it so the agent can release it, and its
// next is about the new request, never "ask the user to resume" the old one.
test('MCP: status names this session\'s stale requests for release and points next at the newer one', async t => {
  const ctx = await setup(t);
  const opening = ctx.mcp.callTool('fai_browser_open', { origins: [ORIGIN], reason: 'Old task', task: 'read' });
  const first = await until(() => ctx.hub.published.at(-1)?.find(item => item.state === 'pending'), 'the first request');
  const lease = await ctx.hub.approve(first.requestId, { level: 'read-only' });
  assert.ok(!(await opening).isError);
  await ctx.hub.emit({ type: 'status', leaseId: lease.leaseId, status: 'paused', reason: 'tab_changed' });
  const second = await ctx.mcp.callTool('fai_browser_open', { origins: ['https://example.org'], reason: 'New task', task: 'read' });
  assert.ok(!second.isError, text(second));
  const newer = ctx.hub.published.at(-1).find(item => item.state === 'pending');
  assert.equal(ctx.hub.published.at(-1).find(item => item.requestId === first.requestId).stale, 'newer_request');
  const status = text(await ctx.mcp.callTool('fai_browser_status', {}));
  const next = status.split('\n')[0];
  assert.match(next, new RegExp(`^next \\(relay\\): .*${newer.requestId}`), next);
  assert.match(next, new RegExp(`Stale \\(paused, folded under Older paused tasks in the user's popup\\): ${first.requestId}; release each one you no `
    + 'longer need with fai_browser_release\\.$'));
  assert.match(status, new RegExp(`^request: ${first.requestId} paused \\(tab_changed\\) read-only.*, stale \\(newer_request\\)$`, 'm'));
  // Asked about the stale request itself, the relay says where the user finds its Resume.
  const waited = text(await ctx.mcp.callTool('fai_browser_wait', { requestId: first.requestId, maxMs: 0 }));
  assert.match(waited, /open the FAI Browser popup, unfold Older paused tasks and click Resume on this task/);
});

test('MCP: a session that cannot be woken keeps the wait command and the copy fallback', async t => {
  const ctx = await setup(t, { clientName: 'test-host' });
  assert.equal(ctx.session.host, 'unknown');
  assert.equal(ctx.session.wake, 'none', 'never the socket of an environment that is not its host\'s');
  const reply = await ctx.hub.emit({ type: 'invite', tabId: 7, origin: ORIGIN, level: 'read-only', sessionId: ctx.session.sessionId });
  assert.equal(reply.invite.wake.state, 'none');
  await delay(200);
  assert.equal(ctx.fake.received.length, 0);
  // The agent finds its invite in status.
  const status = await ctx.mcp.callTool('fai_browser_status', {});
  assert.match(text(status), new RegExp(`next \\(choose\\): The user invited you to a browser tab \\(invite ${reply.invite.inviteId}\\)`));
  assert.match(text(status), new RegExp(`invite: ${reply.invite.inviteId} for this session, level read-only`));
  const opening = ctx.mcp.callTool('fai_browser_open', { origins: ['https://example.org'], reason: 'Other site' });
  const pending = await until(() => ctx.hub.published.at(-1)?.find(item => item.state === 'pending'), 'the request');
  assert.ok(pending);
  const result = await opening;
  assert.match(text(result), /--until active/, 'no wake: the background wait command as before');
});

test('MCP: Codex registers not ready, learns its thread from _meta, and is woken with codex queue', async t => {
  const codex = await fakeCodex(t);
  const ctx = await setup(t, { clientName: 'codex-mcp-client', socket: false,
    env: { FAI_CODEX_BIN: codex.bin, FAKE_CODEX_LOG: join(codex.dir, 'argv.log'), FAKE_CODEX_MODE: 'ok',
      CLAUDE_CODE_SESSION_ID: '' } });
  assert.equal(ctx.session.host, 'codex');
  assert.equal(ctx.session.wake, 'none');
  assert.equal(ctx.session.ready, false);
  const thread = '01a1c03e-9e28-72a2-8cdb-bb6ca9545521';
  await ctx.mcp.callTool('fai_browser_status', {}, { meta: { 'x-codex-turn-metadata': { thread_id: thread }, threadId: thread } });
  const ready = await until(async () => {
    const session = (await ctx.api('GET', '/v1/status')).body.sessions[0];
    return session?.wake === 'codex-queue' ? session : null;
  }, 'the codex-queue capability');
  assert.equal(ready.ready, true);
  const reply = await ctx.hub.emit({ type: 'invite', tabId: 7, origin: ORIGIN, title: SECRET_TITLE, level: 'reversible',
    sessionId: ready.sessionId, text: 'Check the form' });
  const queued = await until(async () => (await codex.calls()).find(entry => entry.argv[0] === 'queue' && entry.argv[1] === '--thread'),
    'codex queue');
  assert.deepEqual(queued.argv.slice(0, 4), ['queue', '--thread', thread, '--message']);
  assert.match(queued.argv[4], new RegExp(`inviteId": "${reply.invite.inviteId}"`));
  assert.ok(!queued.argv[4].includes(SECRET_TITLE));
  assert.deepEqual(queued.fai, [], 'no FAI_ variable reaches codex');
  await until(async () => inviteOf(ctx, reply.requestId)?.wake.state === 'delivered',
    'the delivered report');
});

test('MCP: a Codex thread codex does not know is reported as a failed wake (the popup falls back)', async t => {
  const codex = await fakeCodex(t, { mode: 'unknown' });
  const ctx = await setup(t, { clientName: 'codex-mcp-client', socket: false,
    env: { FAI_CODEX_BIN: codex.bin, FAKE_CODEX_LOG: join(codex.dir, 'argv.log'), FAKE_CODEX_MODE: 'unknown' } });
  await ctx.mcp.callTool('fai_browser_status', {}, { meta: { threadId: '01a1c03e-0000-7000-8000-00000000dead' } });
  await until(async () => (await ctx.api('GET', '/v1/status')).body.sessions[0]?.wake === 'codex-queue', 'capability');
  const reply = await ctx.hub.emit({ type: 'invite', tabId: 7, origin: ORIGIN, level: 'reversible', sessionId: ctx.session.sessionId });
  const failed = await until(async () => {
    const view = inviteOf(ctx, reply.requestId)?.wake;
    return view?.state === 'failed' ? view : null;
  }, 'the failed report');
  assert.equal(failed.error.code, 'unknown_thread');
});
