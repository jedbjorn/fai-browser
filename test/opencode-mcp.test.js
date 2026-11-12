// OpenCode wakes end to end: FAI's real plugin (src/opencode-plugin.js) runs in this test process with a fake OpenCode
// client, so this process plays OpenCode (OPENCODE_PID is its pid and it spawns the MCP server directly), and the real
// daemon runs with a fake hub. The plugin's tag reaches the MCP server as _faiHostSession; invites, Approve and Resume
// are delivered through the plugin's socket to the right session. No real OpenCode is ever reachable from here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createDaemon } from '../src/daemon.js';
import { FaiBrowserWake } from '../src/opencode-plugin.js';
import { call, createFakeHub } from './helpers/fake-hub.js';
import { spawnMcp } from './helpers/mcp-harness.js';
import { ORIGIN, link } from './runtime-fixtures.js';
import { NO_WAKES } from './helpers/platform.js';

const STATE = Symbol.for('fai-browser.opencode-wake.v1');
const SES_A = 'ses_aaaaaaaaaaaaaaaaaaaa';
const SES_B = 'ses_bbbbbbbbbbbbbbbbbbbb';
const PAGES = { '/': { title: 'Home', text: 'Welcome', controls: [link('1', 'About', '/about')] } };

async function until(predicate, what, ms = 8000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(20);
  }
}

async function setup(t, { clientInfo = { name: 'opencode', version: '1.19.5' }, plugin = true, parents = {} } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'fai-oc-mcp-'));
  const hub = createFakeHub({ bridgeOptions: { pages: PAGES } });
  const daemon = createDaemon({ home, env: {}, port: 0, hub });
  await daemon.listen();
  const prompts = [];
  const client = {
    session: {
      promptAsync: async request => { prompts.push(request); return { response: { status: 204 } }; },
      messages: async () => ({ data: [{ info: { role: 'user', agent: 'plan', model: { providerID: 'opencode', modelID: 'm1' } } }] }),
      get: async ({ path }) => ({ data: { id: path.id, ...(parents[path.id] ? { parentID: parents[path.id] } : {}) } }),
    },
  };
  const savedRuntime = process.env.XDG_RUNTIME_DIR;
  let hooks = {};
  if (plugin) {
    process.env.XDG_RUNTIME_DIR = home;
    hooks = await FaiBrowserWake({ client });
  }
  const mcpEnv = {
    PATH: process.env.PATH, HOME: home, FAI_HOME: home, FAI_DAEMON_PORT: String(daemon.port), FAI_MCP_APPROVAL_WAIT_MS: '1000',
    OPENCODE: '1', OPENCODE_PID: String(process.pid),
    ...(plugin ? { FAI_OPENCODE_WAKE_SOCKET: process.env.FAI_OPENCODE_WAKE_SOCKET, FAI_OPENCODE_WAKE_TOKEN: process.env.FAI_OPENCODE_WAKE_TOKEN } : {}),
  };
  const mcp = spawnMcp(mcpEnv);
  t.after(async () => {
    await mcp.close();
    await daemon.close();
    globalThis[STATE]?.server.close();
    delete globalThis[STATE];
    delete process.env.FAI_OPENCODE_WAKE_SOCKET;
    delete process.env.FAI_OPENCODE_WAKE_TOKEN;
    if (savedRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = savedRuntime;
    await rm(home, { recursive: true, force: true });
  });
  await mcp.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo });
  mcp.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const api = (method, path, body) => call(daemon.port, method, path, body, { token: daemon.token });
  const session = await until(async () => (await api('GET', '/v1/status')).body.sessions?.[0], 'the MCP server to register');
  // A FAI tool call as OpenCode makes it: the plugin's hook tags the arguments in place, then the call goes out.
  const callAs = async (sessionID, name, args) => {
    const output = { args: { ...args } };
    await hooks['tool.execute.before']?.({ tool: `fai-browser_${name}`, sessionID, callID: 'c1' }, output);
    return mcp.callTool(name, output.args);
  };
  return { hub, daemon, mcp, api, session, prompts, callAs };
}

const text = result => result.content.map(block => block.text ?? '').join('\n');
const inviteOf = (ctx, requestId) => ctx.hub.published.at(-1)?.find(view => view.requestId === requestId)?.invite;
const sessionNow = async ctx => (await ctx.api('GET', '/v1/status')).body.sessions[0];

test('MCP (OpenCode): not ready until a tagged FAI call; the tag never reaches the schema; an invite wakes that session', { skip: NO_WAKES }, async t => {
  const ctx = await setup(t);
  assert.equal(ctx.session.host, 'opencode');
  assert.equal(ctx.session.wake, 'none');
  assert.equal(ctx.session.ready, false);
  const status = await ctx.callAs(SES_A, 'fai_browser_status', {});
  assert.ok(!status.isError, text(status));
  const ready = await until(async () => {
    const session = await sessionNow(ctx);
    return session?.wake === 'opencode-plugin' ? session : null;
  }, 'the opencode-plugin capability');
  assert.equal(ready.ready, true);

  const reply = await ctx.hub.emit({ type: 'invite', tabId: 7, origin: ORIGIN, level: 'reversible', sessionId: ready.sessionId,
    text: 'Read it' });
  await until(() => ctx.prompts.length === 1, 'the plugin prompt');
  assert.deepEqual(ctx.prompts[0].path, { id: SES_A });
  assert.equal(ctx.prompts[0].body.agent, 'plan', 'the session\'s own agent');
  assert.equal(ctx.prompts[0].body.parts.length, 1);
  assert.match(ctx.prompts[0].body.parts[0].text, new RegExp(`^\\[FAI Browser\\] The user invited you .*${reply.invite.inviteId}`));
  await until(async () => inviteOf(ctx, reply.requestId)?.wake.state === 'delivered', 'the delivered report');
});

test('MCP (OpenCode): Approve wakes exactly the session that asked; with two sessions an invite falls back to the copy line', { skip: NO_WAKES }, async t => {
  const ctx = await setup(t);
  await ctx.callAs(SES_A, 'fai_browser_status', {});
  const opened = await ctx.callAs(SES_B, 'fai_browser_open', { origins: [ORIGIN], reason: 'Read the page', task: 'read' });
  assert.ok(!opened.isError, text(opened));
  assert.match(text(opened), /FAI Browser wakes this session with a message once the user has done it/);
  const pending = await until(() => ctx.hub.published.at(-1)?.find(item => item.state === 'pending'), 'the request');
  await ctx.hub.approve(pending.requestId, { level: 'read-only' });
  await until(() => ctx.prompts.length === 1, 'the approval wake');
  assert.deepEqual(ctx.prompts[0].path, { id: SES_B }, 'the requesting session, not the newest or another one');
  assert.match(ctx.prompts[0].body.parts[0].text, new RegExp(`approved tab request ${pending.requestId}`));

  const session = await sessionNow(ctx);
  const reply = await ctx.hub.emit({ type: 'invite', tabId: 8, origin: ORIGIN, level: 'reversible', sessionId: session.sessionId });
  const failed = await until(async () => {
    const view = inviteOf(ctx, reply.requestId)?.wake;
    return view?.state === 'failed' ? view : null;
  }, 'the failed invite wake');
  assert.equal(failed.error.code, 'ambiguous_session');
  assert.equal(ctx.prompts.length, 1);
});

test('MCP (OpenCode): a request a subagent (a task inside a task) made wakes the root conversation, never the child', { skip: NO_WAKES }, async t => {
  const child = 'ses_cccccccccccccccccccc';
  const grandchild = 'ses_dddddddddddddddddddd';
  const ctx = await setup(t, { parents: { [child]: SES_A, [grandchild]: child } });
  const opened = await ctx.callAs(grandchild, 'fai_browser_open', { origins: [ORIGIN], reason: 'Read the page', task: 'read' });
  assert.ok(!opened.isError, text(opened));
  assert.match(text(opened), /FAI Browser wakes this session/);
  const pending = await until(() => ctx.hub.published.at(-1)?.find(item => item.state === 'pending'), 'the request');
  await ctx.hub.approve(pending.requestId, { level: 'read-only' });
  await until(() => ctx.prompts.length === 1, 'the approval wake');
  assert.deepEqual(ctx.prompts[0].path, { id: SES_A });
  const session = await sessionNow(ctx);
  const reply = await ctx.hub.emit({ type: 'invite', tabId: 8, origin: ORIGIN, level: 'reversible', sessionId: session.sessionId });
  await until(() => ctx.prompts.length === 2, 'the invite wake');
  assert.deepEqual(ctx.prompts[1].path, { id: SES_A }, 'one conversation: the invite goes to its root');
  assert.ok(reply.invite.inviteId);
});

test('MCP (OpenCode): a request no tagged call made keeps the wait command and its Approve wake fails closed', async t => {
  const ctx = await setup(t);
  await ctx.callAs(SES_A, 'fai_browser_status', {});
  await until(async () => (await sessionNow(ctx))?.wake === 'opencode-plugin', 'capability');
  // An untagged call (a model, or an OpenCode without the plugin's hook on this call).
  const opened = await ctx.mcp.callTool('fai_browser_open', { origins: [ORIGIN], reason: 'Read the page', task: 'read' });
  assert.ok(!opened.isError, text(opened));
  assert.match(text(opened), /--until active/);
  const pending = await until(() => ctx.hub.published.at(-1)?.find(item => item.state === 'pending'), 'the request');
  await ctx.hub.approve(pending.requestId, { level: 'read-only' });
  await delay(400);
  assert.equal(ctx.prompts.length, 0, 'no guess at a session');
});

test('MCP: _faiHostSession is stripped for every host; without OpenCode\'s channel it is ignored', async t => {
  const ctx = await setup(t, { clientInfo: { name: 'claude-code', version: 'test' }, plugin: false });
  const status = await ctx.mcp.callTool('fai_browser_status', { _faiHostSession: SES_A });
  assert.ok(!status.isError, text(status));
  assert.equal((await sessionNow(ctx)).wake, 'none');

  const v2 = await setup(t, { clientInfo: { name: 'opencode', version: '2.0.0' } });
  await v2.callAs(SES_A, 'fai_browser_status', {});
  await delay(300);
  const session = (await v2.api('GET', '/v1/status')).body.sessions[0];
  assert.equal(session.wake, 'none', 'OpenCode 2 is not supported by this plugin');
});
