// Watched reads through the daemon (spec #80 AC 3) and the panel's chat wake: a panel's `agent_chat` (through the fake
// hub, as the extension sends it) starts a watch; only then does the session's long poll carry a chatRead; only that
// session's own MCP server (its key) may post the read; the daemon keeps the newest 200 messages in memory and drops
// them when the watch ends (30 s without a panel read); nothing of a conversation reaches a log line. Panel messages
// follow the Sprint 3 panel contract: agent_chat and agent_send.
// Browserless.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHAT_SENDS_PER_MINUTE, createDaemon } from '../src/daemon.js';
import { createSessionRegistry, CHAT_WATCH_MS } from '../src/sessions.js';
import { AgentSession } from '../src/mcp-session.js';
import { FaiBrowserClient } from '../src/client.js';
import { MAX_CHAT_TEXT } from '../src/wake.js';
import { call, createFakeHub } from './helpers/fake-hub.js';
import { EXTENSION_ID, FakeExtension, SECRET } from './helpers/fake-extension.js';

const SECRET_WORDS = 'the payroll figure is 98431';

async function setup(t, { clock = null, chatFirstReadMs, chatSendWaitMs } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'fai-chat-relay-'));
  const hub = createFakeHub();
  const lines = [];
  const daemon = createDaemon({ home, env: {}, port: 0, hub, isAlive: () => true, sweepIntervalMs: 60_000,
    log: (event, fields) => lines.push(JSON.stringify({ event, ...fields })), ...(clock ? { now: () => clock.now } : {}),
    chatFirstReadMs, chatSendWaitMs });
  await daemon.listen();
  t.after(async () => {
    await daemon.close();
    await rm(home, { recursive: true, force: true });
  });
  const api = (method, path, body, extra = {}) => call(daemon.port, method, path, body, { token: daemon.token, ...extra });
  return { home, hub, daemon, api, lines };
}

async function register(ctx, body = {}) {
  const response = await ctx.api('POST', '/v1/sessions', { host: 'claude', repo: 'my-repo', pid: process.pid,
    startedAt: new Date().toISOString(), wake: 'claude-socket', ...body });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  const { sessionId, key } = response.body;
  return { sessionId, key, headers: { 'X-Fai-Session': `${sessionId}:${key}` } };
}

const poll = (ctx, session, maxMs = 0) => ctx.api('POST', `/v1/sessions/${session.sessionId}/poll`, { maxMs },
  { headers: session.headers });
const post = (ctx, session, body, headers = session.headers) => ctx.api('POST', `/v1/sessions/${session.sessionId}/chat`,
  body, { headers });
const panel = (ctx, type, fields) => ctx.hub.emit({ type, browserId: 'browser-1', ...fields });
const message = (n, text = `message ${n}`, role = 'agent') => ({ id: String(n), role, text, at: new Date(1_800_000_000_000 + n).toISOString() });

test('no chatRead without a watch; a panel read asks the session\'s poll at once and waits for the first read', async t => {
  const ctx = await setup(t);
  const session = await register(ctx);
  assert.deepEqual((await poll(ctx, session)).body, { wakes: [] }, 'nobody watches: no read');
  assert.equal((await post(ctx, session, { messages: [message(1)], busy: false, cursor: '1.0' })).status, 409,
    'a read nobody asked for is refused');
  const held = poll(ctx, session, 5_000);
  await new Promise(resolve => setTimeout(resolve, 50));
  const first = panel(ctx, 'agent_chat', { sessionId: session.sessionId });
  const answered = await held;
  assert.deepEqual(answered.body, { wakes: [], chatRead: { cursor: null } }, 'the held poll answered with a read');
  assert.deepEqual((await poll(ctx, session)).body, { wakes: [] }, 'one read per panel read');
  const posted = await post(ctx, session, { messages: [message(1, 'hello'), message(2, 'there', 'user')], busy: true, cursor: '120.1' });
  assert.deepEqual(posted.body, { taken: 2 });
  const view = await first;
  assert.deepEqual(Object.keys(view).sort(), ['busy', 'cursor', 'ended', 'messages', 'readable', 'reset', 'sends']);
  assert.deepEqual([view.readable, view.busy, view.ended, view.reset], [true, true, false, false]);
  assert.deepEqual(view.messages.map(item => [item.role, item.text]), [['agent', 'hello'], ['user', 'there']]);
  assert.equal(view.cursor, view.messages.at(-1).seq);
  assert.deepEqual(Object.keys(view.messages[0]).sort(), ['at', 'id', 'role', 'seq', 'text']);
  await panel(ctx, 'agent_chat', { sessionId: session.sessionId, after: view.cursor });
  assert.deepEqual((await poll(ctx, session)).body.chatRead, { cursor: '120.1' }, 'the next read resumes from the cursor');
  // Only what is new after the panel's cursor; a message posted twice is kept once.
  await post(ctx, session, { messages: [message(2, 'there', 'user'), message(3, 'more')], busy: false, cursor: '200.0' });
  const next = await panel(ctx, 'agent_chat', { sessionId: session.sessionId, after: view.cursor });
  assert.deepEqual(next.messages.map(item => item.text), ['more']);
  assert.deepEqual([next.reset, next.busy], [false, false]);
  const same = await panel(ctx, 'agent_chat', { sessionId: session.sessionId, after: next.cursor });
  assert.deepEqual([same.messages, same.cursor], [[], next.cursor], 'nothing new: the cursor stays');
  // A read error is `readable: {code, host, version}`; sending still works.
  await post(ctx, session, { error: { code: 'unreadable', version: '2.1.325' } });
  assert.deepEqual((await panel(ctx, 'agent_chat', { sessionId: session.sessionId, after: same.cursor })).readable,
    { code: 'unreadable', host: 'claude', version: '2.1.325' });
});

test('a new watch answers after CHAT_FIRST_READ_MS when no read comes', async t => {
  const ctx = await setup(t, { chatFirstReadMs: 200 });
  const session = await register(ctx);
  const started = Date.now();
  const view = await panel(ctx, 'agent_chat', { sessionId: session.sessionId });
  assert.ok(Date.now() - started >= 150);
  assert.deepEqual([view.messages, view.readable, view.ended, view.cursor], [[], true, false, 0]);
});

test('only the session\'s own MCP server posts its read: another session\'s key or id is refused', async t => {
  const ctx = await setup(t, { chatFirstReadMs: 0 });
  const a = await register(ctx);
  const b = await register(ctx, { pid: 70003, host: 'codex', wake: 'codex-queue' });
  await panel(ctx, 'agent_chat', { sessionId: a.sessionId });
  assert.equal((await post(ctx, a, { messages: [message(1)] }, b.headers)).status, 403, 'B\'s header on A\'s route');
  assert.equal((await post(ctx, a, { messages: [message(1)] }, { 'X-Fai-Session': `${a.sessionId}:wrong` })).status, 403);
  assert.equal((await post(ctx, a, { messages: [message(1)] }, {})).status, 403);
  assert.equal((await post(ctx, b, { messages: [message(1)] })).status, 409, 'B is not watched');
  assert.equal((await call(ctx.daemon.port, 'POST', `/v1/sessions/${a.sessionId}/chat`, { messages: [] },
    { headers: a.headers })).status, 401, 'the client token is required too');
  assert.equal((await post(ctx, a, { messages: [], extra: 1 })).status, 400, 'closed keys');
  assert.deepEqual((await panel(ctx, 'agent_chat', { sessionId: a.sessionId })).messages, []);
});

test('the watch ends 30 s after the last panel read; its messages are dropped', async () => {
  const clock = { now: 1_000_000 };
  const lines = [];
  const registry = createSessionRegistry({ now: () => clock.now, isAlive: () => true,
    log: (event, fields) => lines.push({ event, ...fields }) });
  const { sessionId } = registry.register({ host: 'claude', pid: process.pid, wake: 'claude-socket' });
  const session = registry.get(sessionId);
  assert.equal(registry.chatView(sessionId), null);
  assert.equal(registry.watchChat('ses_unknown'), false);
  assert.equal(registry.watchChat(sessionId), true);
  registry.postChat(session, { messages: [message(1, SECRET_WORDS)], busy: false, cursor: '9.0' });
  clock.now += CHAT_WATCH_MS - 1;
  registry.sweep();
  assert.equal(registry.chatView(sessionId).messages.length, 1, 'still watched just under 30 s');
  registry.watchChat(sessionId);
  clock.now += CHAT_WATCH_MS - 1;
  registry.sweep();
  assert.ok(registry.chatView(sessionId), 'each panel read extends the watch');
  clock.now += 1;
  registry.sweep();
  assert.equal(registry.chatView(sessionId), null, 'ended 30 s after the last panel read');
  assert.throws(() => registry.postChat(session, { messages: [message(2)] }), { code: 'not_watched' });
  const read = await registry.poll(session, 0);
  assert.equal(read.chatRead, undefined, 'nothing is read while nobody watches');
  // A new watch starts empty (from the start of the conversation's tail), and unwatchChat ends it at once.
  registry.watchChat(sessionId);
  assert.deepEqual(registry.chatView(sessionId).messages, []);
  assert.equal((await registry.poll(session, 0)).chatRead.cursor, null);
  assert.equal(registry.unwatchChat(sessionId), true);
  assert.equal(registry.chatView(sessionId), null);
  assert.deepEqual(lines.filter(line => line.event.startsWith('chat_')).map(line => [line.event, line.reason ?? null]),
    [['chat_watch', null], ['chat_unwatch', 'idle'], ['chat_watch', null], ['chat_unwatch', 'closed']]);
  assert.doesNotMatch(JSON.stringify(lines), /payroll|98431/);
});

test('limits: the newest 200 messages, each clipped to 8,000 characters; unknown roles and ids are dropped; reset', async () => {
  const registry = createSessionRegistry({ isAlive: () => true });
  const { sessionId } = registry.register({ host: 'codex', pid: process.pid, wake: 'codex-queue' });
  const session = registry.get(sessionId);
  registry.watchChat(sessionId);
  registry.postChat(session, { messages: [message(0, 'x'.repeat(9_000)), { id: 'bad id', role: 'agent', text: 'no' },
    { id: '9', role: 'tool', text: 'no' }, { id: '10', role: 'user', text: 42 }, null], busy: false });
  const first = registry.chatView(sessionId);
  assert.equal(first.messages.length, 1);
  assert.equal(first.messages[0].text.length, 8_000);
  assert.match(first.messages[0].text, /… \(clipped\)$/);
  const firstSeq = first.messages[0].seq;
  registry.postChat(session, { messages: Array.from({ length: 250 }, (_, n) => message(n + 1)) });
  const view = registry.chatView(sessionId);
  assert.equal(view.messages.length, 200);
  assert.equal(view.messages.at(-1).text, 'message 250');
  const stale = registry.chatView(sessionId, firstSeq);
  assert.equal(stale.reset, true, 'the panel\'s last message fell out of the window: it replaces its list');
  assert.equal(stale.messages.length, 200);
  // An error replaces nothing that was read, and names the host itself (never a host-supplied string).
  registry.postChat(session, { error: { code: 'nonsense', version: '0.169.0<script>' } });
  const failed = registry.chatView(sessionId);
  assert.deepEqual(failed.error, { code: 'unreadable', host: 'codex', version: '0.169.0script' });
  assert.equal(failed.readable, false);
  registry.postChat(session, { error: { code: 'not_ready' } });
  assert.equal(registry.chatView(sessionId).error.code, 'not_ready');
});

test('a session that ended is `ended` for the panel', async t => {
  const ctx = await setup(t, { chatFirstReadMs: 0 });
  const session = await register(ctx);
  await panel(ctx, 'agent_chat', { sessionId: session.sessionId });
  await ctx.api('DELETE', `/v1/sessions/${session.sessionId}`, {}, { headers: session.headers });
  const gone = await panel(ctx, 'agent_chat', { sessionId: session.sessionId, after: 7 });
  assert.deepEqual([gone.ended, gone.messages, gone.cursor], [true, [], 7]);
  assert.equal((await panel(ctx, 'agent_chat', { sessionId: 'ses_nobody' })).ended, true);
});

// Settle the session's next chat wake the way its MCP server would.
async function settleNext(ctx, session, outcome) {
  for (let n = 0; n < 40; n += 1) {
    const { wakes } = (await poll(ctx, session)).body;
    if (wakes.length) {
      await ctx.api('POST', `/v1/sessions/${session.sessionId}/wakes/${wakes[0].wakeId}`, outcome, { headers: session.headers });
      return wakes[0];
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('no wake');
}

test('agent_send: the user\'s cleaned words as a chat wake; ok once delivered, the wake\'s error when not', async t => {
  const ctx = await setup(t, { chatFirstReadMs: 0 });
  const session = await register(ctx);
  const sending = panel(ctx, 'agent_send', { sessionId: session.sessionId, text: '  use the other\r\naccount page ​ ' });
  const wake = await settleNext(ctx, session, { outcome: 'delivered' });
  assert.deepEqual([wake.kind, wake.userText], ['chat', 'use the other\naccount page']);
  assert.deepEqual(await sending, { ok: true, wakeId: wake.wakeId });
  const failing = panel(ctx, 'agent_send', { sessionId: session.sessionId, text: 'again' });
  await settleNext(ctx, session, { outcome: 'failed', code: 'refused', message: 'The session refused it.' });
  assert.deepEqual(await failing, { error: { code: 'refused', message: 'The session refused it.' } });
  const view = await panel(ctx, 'agent_chat', { sessionId: session.sessionId });
  assert.deepEqual(view.sends.map(item => item.state), ['delivered', 'failed']);
});

test('agent_send: still on its way after the wait is ok with its state; limits and refusals', async t => {
  const ctx = await setup(t, { chatFirstReadMs: 0, chatSendWaitMs: 50 });
  const session = await register(ctx);
  const pending = await panel(ctx, 'agent_send', { sessionId: session.sessionId, text: 'hello' });
  assert.deepEqual([pending.ok, pending.state], [true, 'queued']);
  assert.equal((await panel(ctx, 'agent_send', { sessionId: session.sessionId, text: 'x'.repeat(MAX_CHAT_TEXT + 1) })).error.code, 'too_long');
  assert.equal((await panel(ctx, 'agent_send', { sessionId: session.sessionId, text: 'x'.repeat(MAX_CHAT_TEXT) })).ok, true);
  assert.equal((await panel(ctx, 'agent_send', { sessionId: session.sessionId, text: ' ​\n ' })).error.code, 'empty');
  assert.equal((await panel(ctx, 'agent_send', { sessionId: 'ses_nobody', text: 'hi' })).error.code, 'unknown_session');
  const mute = await register(ctx, { wake: 'none', pid: 70001 });
  assert.equal((await panel(ctx, 'agent_send', { sessionId: mute.sessionId, text: 'hi' })).error.code, 'cannot_wake');
  // A Codex session before its first FAI call has no thread to queue to.
  const early = await register(ctx, { host: 'codex', wake: 'none', pid: 70002 });
  assert.equal((await panel(ctx, 'agent_send', { sessionId: early.sessionId, text: 'hi' })).error.code, 'cannot_wake');
  for (let n = 2; n < CHAT_SENDS_PER_MINUTE; n += 1) {
    assert.equal((await panel(ctx, 'agent_send', { sessionId: session.sessionId, text: `n${n}` })).ok, true);
  }
  const limited = await panel(ctx, 'agent_send', { sessionId: session.sessionId, text: 'one more' });
  assert.equal(limited.error.code, 'rate_limited');
  assert.equal(typeof limited.error.message, 'string');
});

test('nothing of a conversation reaches the daemon\'s log or its files', async t => {
  const ctx = await setup(t, { chatFirstReadMs: 0, chatSendWaitMs: 50 });
  const session = await register(ctx);
  await panel(ctx, 'agent_chat', { sessionId: session.sessionId });
  await post(ctx, session, { messages: [message(1, SECRET_WORDS, 'user')], busy: true, cursor: '5.1' });
  await panel(ctx, 'agent_send', { sessionId: session.sessionId, text: SECRET_WORDS });
  await poll(ctx, session);
  await panel(ctx, 'agent_chat', { sessionId: session.sessionId });
  assert.ok(ctx.lines.length > 0);
  assert.doesNotMatch(ctx.lines.join('\n'), /payroll|98431/);
  const files = await readdir(ctx.home, { recursive: true });
  for (const name of files) {
    const text = await readFile(join(ctx.home, name), 'utf8').catch(() => '');
    assert.doesNotMatch(text, /payroll|98431/, name);
  }
});

const CHANNEL_PATH = process.platform === 'win32' ? '\\\\.\\pipe\\fai-browser-oc-4242-0123456789abcdef' : '/r/fai-browser/oc-4242.sock';
const SES_A = 'ses_1a2b3c4d5e6f7g8h9i0j';
const SES_B = 'ses_ZZZZZZZZZZZZZZZZZZZZ';
const OPENCODE_ENV = { FAI_OPENCODE_WAKE_SOCKET: CHANNEL_PATH, FAI_OPENCODE_WAKE_TOKEN: 'ab'.repeat(32), FAI_OPENCODE_PID: '4242' };

test('MCP server: reads only on the daemon\'s chatRead, posts with its own key, and sends chat wakes to its host', async t => {
  const ctx = await setup(t);
  const reads = [];
  const delivered = [];
  const agent = new AgentSession({
    env: OPENCODE_ENV, home: ctx.home, host: 'opencode', clientVersion: '1.19.5', clientName: 'test', pollMs: 300, ppid: 4242,
    connect: async () => new FaiBrowserClient({ port: ctx.daemon.port, token: ctx.daemon.token, clientName: 'test' }),
    chatReader: { read: async request => {
      reads.push(request);
      return { messages: [{ id: 'msg_17', role: 'agent', text: 'I am on the cart page.', at: null }], busy: true, cursor: 'msg_17' };
    } },
    deliver: async request => {
      delivered.push(request);
      return { ok: true };
    },
  });
  t.after(() => agent.stop());
  agent.noteToolCall({}, { opencodeSession: SES_A });
  agent.start();
  assert.equal(await agent.ready(3_000), true);
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.deepEqual(reads, [], 'no read while nobody watches');
  const sessionId = agent.sessionId;
  const view = await panel(ctx, 'agent_chat', { sessionId });
  assert.deepEqual(view.messages.map(item => item.text), ['I am on the cart page.'], 'the first read lands within the wait');
  assert.equal(view.busy, true);
  await panel(ctx, 'agent_chat', { sessionId, after: view.cursor });
  for (let n = 0; n < 40 && reads.length < 2; n += 1) await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(reads[0], { target: SES_A, cursor: null });
  assert.ok(reads.slice(1).every(read => read.cursor === 'msg_17'), 'later reads resume from the posted cursor');
  const sent = await panel(ctx, 'agent_send', { sessionId, text: 'Use the other\naccount page.' });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  assert.equal(sent.state, undefined, 'answered once delivered');
  for (let n = 0; n < 40 && !delivered.length; n += 1) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(delivered[0].capability, 'opencode-plugin');
  assert.equal(delivered[0].opencodeSession, SES_A, 'to the session the panel reads');
  assert.equal(delivered[0].text, '[FAI Browser] The user sent you a message from the FAI chat panel (the user\'s own words): '
    + '"Use the other\\naccount page."');
  assert.equal((await panel(ctx, 'agent_chat', { sessionId })).sends.find(item => item.wakeId === sent.wakeId)?.state, 'delivered');
});

test('MCP server: a read the daemon refuses is posted as cannot-read, never as an empty readable conversation', async () => {
  const posts = [];
  const client = { request: async (method, path, body) => {
    posts.push({ method, path, body });
    if (body.messages) throw Object.assign(new Error('Request body exceeds 1 MB'), { status: 413, code: 'too_large' });
    return { taken: 0 };
  } };
  const agent = new AgentSession({ env: { CLAUDE_CODE_SESSION_ID: '5f0c2a8e-1d34-4b6a-9e77-0c1f2d3e4a5b' }, host: 'claude',
    clientVersion: '2.1.0', connect: async () => client,
    chatReader: { read: async () => ({ messages: [{ id: 'm1', role: 'agent', text: 'hi', at: null }], busy: false, cursor: 'c1' }) } });
  agent.client = client;
  agent.sessionId = 'sess_1';
  agent.readChat(null);
  await Promise.allSettled([...agent.deliveries]);
  assert.deepEqual(posts.map(post => post.body), [
    { messages: [{ id: 'm1', role: 'agent', text: 'hi', at: null }], busy: false, cursor: 'c1' },
    { error: { code: 'unreadable', version: '2.1.0' } },
  ]);
  // The watch ended (409): nothing more is posted.
  posts.length = 0;
  client.request = async (method, path, body) => {
    posts.push(body);
    throw Object.assign(new Error('No chat panel watches this session'), { status: 409, code: 'not_watched' });
  };
  agent.readChat(null);
  await Promise.allSettled([...agent.deliveries]);
  assert.equal(posts.length, 1);
});

test('MCP server: the chat target is its own session; with several OpenCode sessions lately, none (ambiguous)', async () => {
  const offline = async () => { throw new Error('offline'); };
  const claude = new AgentSession({ env: { CLAUDE_CODE_SESSION_ID: '5f0c2a8e-1d34-4b6a-9e77-0c1f2d3e4a5b' }, host: 'claude', connect: offline });
  assert.deepEqual(claude.chatTarget(), { target: '5f0c2a8e-1d34-4b6a-9e77-0c1f2d3e4a5b' });
  const codex = new AgentSession({ env: {}, host: 'codex', connect: offline });
  assert.deepEqual(codex.chatTarget(), { target: null }, 'no thread before its first FAI call');
  codex.noteToolCall({ threadId: '01a1e396-0000-7000-8000-00000000f1c5' });
  assert.deepEqual(codex.chatTarget(), { target: '01a1e396-0000-7000-8000-00000000f1c5' });
  const clock = { now: 1_000_000 };
  const opencode = new AgentSession({ env: OPENCODE_ENV, host: 'opencode', clientVersion: '1.19.5', ppid: 4242,
    connect: offline, now: () => clock.now });
  assert.deepEqual(opencode.chatTarget(), { target: null });
  opencode.noteToolCall({}, { opencodeSession: SES_A });
  assert.deepEqual(opencode.chatTarget(), { target: SES_A });
  opencode.noteToolCall({}, { opencodeSession: SES_B });
  assert.deepEqual(opencode.chatTarget(), { target: null, ambiguous: true });
  // A chat wake then goes nowhere, with its own reason.
  const outcomes = [];
  opencode.onOutcome = (wake, outcome) => outcomes.push(outcome);
  opencode.handle({ wakeId: 'w1', kind: 'chat', userText: 'hi' });
  await Promise.all([...opencode.deliveries]);
  assert.equal(outcomes[0].code, 'ambiguous_session');
  assert.match(outcomes[0].message, /cannot tell which one/);
});

test('the real hub: agent_chat and agent_send over the paired WebSocket, validated', async t => {
  const home = await mkdtemp(join(tmpdir(), 'fai-chat-hub-'));
  const daemon = createDaemon({ home, env: { FAI_BRIDGE_SECRET: SECRET, FAI_EXTENSION_ID: EXTENSION_ID },
    port: 0, sweepIntervalMs: 60_000, chatFirstReadMs: 0, chatSendWaitMs: 50 });
  await daemon.listen();
  const ext = await FakeExtension.connect({ port: daemon.port });
  t.after(async () => {
    ext.close();
    await daemon.close();
    await rm(home, { recursive: true, force: true });
  });
  assert.equal((await ext.hello()).ok, true);
  const ctx = { api: (method, path, body, extra = {}) => call(daemon.port, method, path, body, { token: daemon.token, ...extra }) };
  const session = await register(ctx);
  for (const [type, bad] of [['agent_chat', {}], ['agent_chat', { sessionId: 42 }], ['agent_chat', { sessionId: 'x'.repeat(65) }],
    ['agent_send', { sessionId: session.sessionId }], ['agent_send', { sessionId: session.sessionId, text: 7 }]]) {
    const refused = await ext.request(type, bad);
    assert.deepEqual([refused.ok, refused.error.code], [false, 'bad_request'], `${type} ${JSON.stringify(bad)}`);
  }
  assert.equal((await ext.request('agent_send', { sessionId: session.sessionId, text: 'x'.repeat(16_001) })).error.code, 'too_long');
  const watched = await ext.request('agent_chat', { sessionId: session.sessionId, after: 'x' });
  assert.equal(watched.ok, true);
  assert.equal(watched.data.ended, false);
  assert.deepEqual((await poll(ctx, session)).body.chatRead, { cursor: null });
  await post(ctx, session, { messages: [message(1, 'hi there')], busy: false, cursor: '9.0' });
  const read = await ext.request('agent_chat', { sessionId: session.sessionId, after: 0 });
  assert.deepEqual(read.data.messages.map(item => item.text), ['hi there']);
  const sent = await ext.request('agent_send', { sessionId: session.sessionId, text: 'go on' });
  assert.deepEqual([sent.ok, sent.data.ok, sent.data.state], [true, true, 'queued']);
  const long = await ext.request('agent_send', { sessionId: session.sessionId, text: 'x'.repeat(MAX_CHAT_TEXT + 1) });
  assert.deepEqual([long.ok, long.error.code], [false, 'too_long']);
});
