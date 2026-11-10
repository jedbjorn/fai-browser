// The wake channel (src/wake.js): host detection, capabilities, the FAI-authored texts, delivery to a fake Claude Code
// messaging socket (auth line + user line) and to a fake `codex` binary. Nothing here touches a real session: every
// socket and binary is a throwaway this test starts, and every environment is built from scratch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  claudeSocket, cleanInviteText, codexSupportsQueue, codexThreadId, deliverClaudeSocket, deliverCodexQueue, deliverWake,
  detectHost, hostSessionId, repoName, resetCodexSupport, wakeCapability, wakeText,
} from '../src/wake.js';
import { fakeCodex, startFakeClaudeSocket } from './helpers/fake-agents.js';

test('host detection: the MCP client name first, then the environment', () => {
  assert.equal(detectHost({ name: 'claude-code' }, {}), 'claude');
  assert.equal(detectHost({ name: 'codex-mcp-client' }, {}), 'codex');
  assert.equal(detectHost({ name: 'opencode' }, { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'x' }), 'opencode',
    'an OpenCode started from a Claude Code shell is OpenCode');
  assert.equal(detectHost({ name: 'test-host' }, { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'x' }), 'unknown',
    'a named other client is never taken for Claude Code (so a test harness never writes to a real socket)');
  assert.equal(detectHost(null, { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'abc' }), 'claude');
  assert.equal(detectHost(null, { OPENCODE: '1' }), 'opencode');
  assert.equal(detectHost(null, {}), 'unknown');
});

test('repo name is the folder name only, never the path', () => {
  assert.equal(repoName({ CLAUDE_PROJECT_DIR: '/home/me/secret/projects/fai-browser' }, '/x'), 'fai-browser');
  assert.equal(repoName({}, '/home/me/work/app/'), 'app');
  assert.equal(repoName({}, '/'), 'unknown');
});

test('capabilities: claude-socket needs Claude Code and both variables; codex-queue a thread and codex queue', () => {
  const env = { CLAUDE_CODE_MESSAGING_SOCKET: '/run/user/1000/cc-socks/4242.sock', CLAUDE_CODE_MESSAGING_TOKEN: 't' };
  assert.deepEqual(claudeSocket(env, { ppid: 4242 }), { path: '/run/user/1000/cc-socks/4242.sock', token: 't' });
  assert.deepEqual(claudeSocket({ CLAUDE_CODE_MESSAGING_SOCKET: '/s/4242.sock', CLAUDE_CODE_MESSAGING_SOCKET_TOKEN: 'u' }, { ppid: 4242 }),
    { path: '/s/4242.sock', token: 'u' });
  assert.equal(claudeSocket({ CLAUDE_CODE_MESSAGING_SOCKET: '/s/4242.sock' }, { ppid: 4242 }), null, 'no token (a --bare or older session)');
  assert.equal(wakeCapability({ host: 'claude', env, ppid: 4242 }), 'claude-socket');
  assert.equal(wakeCapability({ host: 'unknown', env, ppid: 4242 }), 'none');
  assert.equal(wakeCapability({ host: 'claude', env: { ...env, FAI_WAKE: '0' }, ppid: 4242 }), 'none');
  assert.equal(wakeCapability({ host: 'codex', env: {}, threadId: '01a1c03e-9e28-72a2-8cdb-bb6ca9545521', codexReady: true }), 'codex-queue');
  assert.equal(wakeCapability({ host: 'codex', env: {}, threadId: null, codexReady: true }), 'none', 'no thread yet');
  assert.equal(wakeCapability({ host: 'codex', env: {}, threadId: '01a1c03e-9e28-72a2-8cdb-bb6ca9545521', codexReady: false }), 'none');
});

test('an inherited messaging socket is not this session\'s: only one named after the MCP server\'s parent counts', () => {
  // Everything Claude Code starts inherits the variables, a Bash command's children too; the socket is <claude pid>.sock.
  const env = { CLAUDE_CODE_MESSAGING_SOCKET: '/run/user/1000/cc-socks/4242.sock', CLAUDE_CODE_MESSAGING_TOKEN: 't' };
  assert.equal(claudeSocket(env, { ppid: 5151 }), null, 'started by something else (a shell, npx): no socket');
  assert.equal(wakeCapability({ host: 'claude', env, ppid: 5151 }), 'none', 'fails closed to the copy line');
  assert.equal(claudeSocket(env, { ppid: 1 }), null);
  assert.equal(claudeSocket({ ...env, CLAUDE_CODE_MESSAGING_SOCKET: '/x/4242.sock.evil' }, { ppid: 4242 }), null);
  assert.equal(hostSessionId('claude', { CLAUDE_CODE_SESSION_ID: '655645a7-9481-41d0-9ebc-892634b309cf' }), '655645a7-9481-41d0-9ebc-892634b309cf');
  assert.equal(hostSessionId('codex', { CLAUDE_CODE_SESSION_ID: 'x' }), null);
});

test('the Codex thread id comes from a tools/call _meta', () => {
  const id = '01a1c03e-9e28-72a2-8cdb-bb6ca9545521';
  assert.equal(codexThreadId({ 'x-codex-turn-metadata': { thread_id: id, session_id: id } }), id);
  assert.equal(codexThreadId({ threadId: id }), id);
  assert.equal(codexThreadId({ threadId: 'not-a-uuid' }), null);
  assert.equal(codexThreadId({ 'claudecode/toolUseId': 'toolu_1' }), null);
  assert.equal(codexThreadId({ threadId: 'bad id; rm -rf /' }), null);
  assert.equal(codexThreadId(undefined), null);
});

test('wake texts are fixed FAI templates: ids, level and the user\'s own words only', () => {
  const invite = wakeText({ kind: 'invite', inviteId: 'inv-abc12345', requestId: 'req_1', level: 'reversible',
    userText: 'Find the\ncheapest   flight\u0000' });
  assert.match(invite, /^\[FAI Browser\] The user invited you/);
  assert.match(invite, /Call fai_browser_open with \{"inviteId": "inv-abc12345"\}/);
  assert.match(invite, /level Use/);
  assert.match(invite, /the user's own words\): "Find the cheapest flight"/);
  assert.equal(invite.split('\n').length, 2, 'the user text is one labelled line');
  assert.match(wakeText({ kind: 'invite', inviteId: 'inv-abc12345', level: 'full' }), /typed no task/);
  assert.match(wakeText({ kind: 'resume', requestId: 'req_9' }), /resumed tab request req_9.*fai_browser_observe with requestId req_9/);
  assert.match(wakeText({ kind: 'approved', requestId: 'req_9', level: 'interactive' }), /approved tab request req_9 at level Use/);
  assert.match(wakeText({ kind: 'resume', requestId: 'req 9; evil' }), /request unknown/, 'an id that is not one is never echoed');
  assert.equal(cleanInviteText('x'.repeat(900)).length, 500);
  assert.equal(cleanInviteText(42), '');
  // Bidi overrides and isolates, zero-width characters and C1 controls never reach the agent.
  assert.equal(cleanInviteText('pay \u202enoitpircsbus\u202c now\u200b\u2066x\u2069\ufeff\u0085y\u009bz'), 'pay noitpircsbus nowx y z');
});

test('Claude socket: delivered writes the auth line then one user line', async t => {
  const fake = await startFakeClaudeSocket(t);
  const outcome = await deliverClaudeSocket({ path: fake.path, token: fake.token, text: 'hello from FAI' });
  assert.deepEqual(outcome, { ok: true });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(fake.received, [{ type: 'user', message: { role: 'user', content: 'hello from FAI' } }]);
});

test('Claude socket: a refusal line, no socket and a write that never lands each fail with a code', async t => {
  const refusing = await startFakeClaudeSocket(t, { mode: 'refuse' });
  const refused = await deliverClaudeSocket({ path: refusing.path, token: refusing.token, text: 'x' });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'refused');
  assert.match(refused.message, /crossSessionInbound/);
  assert.equal(refusing.received.length, 0);

  const wrongToken = await startFakeClaudeSocket(t);
  const unauthorized = await deliverClaudeSocket({ path: wrongToken.path, token: 'wrong', text: 'x' });
  assert.equal(unauthorized.code, 'refused');

  const missing = await deliverClaudeSocket({ path: join(refusing.dir, 'nope.sock'), token: 't', text: 'x' });
  assert.deepEqual([missing.ok, missing.code], [false, 'no_socket']);
  const unset = await deliverClaudeSocket({ path: '', token: '', text: 'x' });
  assert.equal(unset.code, 'no_socket');

  // A session that never reads: a write too large for the socket buffer never completes, so the wake times out.
  const silent = await startFakeClaudeSocket(t, { mode: 'silent' });
  const started = Date.now();
  const timedOut = await deliverClaudeSocket({ path: silent.path, token: silent.token, text: 'x'.repeat(8 * 1024 * 1024), timeoutMs: 300 });
  assert.deepEqual([timedOut.ok, timedOut.code], [false, 'timeout']);
  assert.ok(Date.now() - started < 3000);
});

test('deliverWake routes by capability and never throws', async t => {
  const fake = await startFakeClaudeSocket(t, { pid: 4242 });
  const env = { CLAUDE_CODE_MESSAGING_SOCKET: fake.path, CLAUDE_CODE_MESSAGING_TOKEN: fake.token };
  assert.deepEqual(await deliverWake({ capability: 'claude-socket', text: 'one', env, ppid: 4242 }), { ok: true });
  assert.equal((await deliverWake({ capability: 'none', text: 'x', env, ppid: 4242 })).code, 'no_wake');
  assert.equal((await deliverWake({ capability: 'claude-socket', text: 'x', env: {}, ppid: 4242 })).code, 'no_socket');
  assert.equal((await deliverWake({ capability: 'claude-socket', text: 'x', env, ppid: 5151 })).code, 'no_socket',
    'another process\'s socket is never written to');
  assert.equal(fake.received.length, 1);
  assert.equal((await deliverWake({ capability: 'claude-socket', text: 'x', env: { ...env, FAI_WAKE: '0' }, ppid: 4242 })).code, 'disabled');
});

test('Codex: codex queue --thread <id> --message <text> as argv (no shell), outcomes from the exit and stderr', async t => {
  resetCodexSupport();
  const fake = await fakeCodex(t);
  assert.equal(await codexSupportsQueue(fake.env), true);
  const text = 'it\'s "quoted"; $(echo nope) `uname`';
  assert.deepEqual(await deliverCodexQueue({ threadId: '01a1c03e-9e28-72a2-8cdb-bb6ca9545521', text, env: fake.env }), { ok: true });
  const calls = await fake.calls();
  assert.deepEqual(calls.at(-1).argv, ['queue', '--thread', '01a1c03e-9e28-72a2-8cdb-bb6ca9545521', '--message', text], 'the text is one argv entry, unexpanded');
  assert.deepEqual(calls.at(-1).fai, [], 'no FAI_ variable (the client token) reaches codex');

  const unknown = await fakeCodex(t, { mode: 'unknown' });
  const missingThread = await deliverCodexQueue({ threadId: '01a1c03e-0000-7000-8000-000000000002', text: 'x', env: unknown.env });
  assert.deepEqual([missingThread.ok, missingThread.code], [false, 'unknown_thread']);

  const crash = await fakeCodex(t, { mode: 'crash' });
  const failed = await deliverCodexQueue({ threadId: '01a1c03e-9e28-72a2-8cdb-bb6ca9545521', text: 'x', env: crash.env });
  assert.deepEqual([failed.ok, failed.code], [false, 'codex_failed']);

  const absent = await deliverCodexQueue({ threadId: '01a1c03e-9e28-72a2-8cdb-bb6ca9545521', text: 'x', env: { PATH: '', FAI_CODEX_BIN: join(fake.dir, 'nope') } });
  assert.deepEqual([absent.ok, absent.code], [false, 'no_codex']);
  const noPath = await deliverCodexQueue({ threadId: '01a1c03e-9e28-72a2-8cdb-bb6ca9545521', text: 'x', env: { PATH: '' } });
  // A relative PATH entry is never searched (it would resolve against the MCP server's working directory).
  const relative = await deliverCodexQueue({ threadId: '01a1c03e-9e28-72a2-8cdb-bb6ca9545521', text: 'x', env: { PATH: '.:bin' } });
  assert.equal(relative.code, 'no_codex');
  assert.equal((await deliverCodexQueue({ threadId: 'thread-1', text: 'x', env: fake.env })).code, 'unknown_thread',
    'only a UUID thread id reaches argv');
  assert.equal(noPath.code, 'no_codex');
  assert.equal(await codexSupportsQueue({ PATH: '' }), false);
  const badThread = await deliverCodexQueue({ threadId: '-rf', text: 'x', env: fake.env });
  assert.equal(badThread.code, 'unknown_thread', 'a thread id that is not one never reaches argv');
});

test('Claude socket: whatever the session writes back is kept without the token', async t => {
  const echo = await startFakeClaudeSocket(t, { mode: 'echo' });
  const sent = await deliverClaudeSocket({ path: echo.path, token: echo.token, text: 'hi' });
  assert.equal(sent.ok, true);
  assert.match(sent.reply, /\[token\]/);
  assert.ok(!sent.reply.includes(echo.token), 'the token is never in a reply');
  const refusing = await startFakeClaudeSocket(t, { mode: 'echo-refuse' });
  const refused = await deliverClaudeSocket({ path: refusing.path, token: refusing.token, text: 'hi' });
  assert.equal(refused.code, 'refused');
  assert.ok(!refused.message.includes(refusing.token), 'nor in a refusal');
});

