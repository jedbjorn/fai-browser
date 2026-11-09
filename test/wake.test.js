// The wake channel (src/wake.js): host detection, capabilities, the FAI-authored texts, delivery to a fake Claude Code
// messaging socket (auth line + user line) and to a fake `codex` binary. Nothing here touches a real session: every
// socket and binary is a throwaway this test starts, and every environment is built from scratch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  claudeSocket, cleanInviteText, codexSupportsQueue, codexThreadId, deliverClaudeSocket, deliverCodexQueue, deliverPiSocket,
  deliverWake, detectHost, hostSessionId, piSocket, repoName, resetCodexSupport, wakeCapability, wakeText,
} from '../src/wake.js';
import { checkWakeText, encodeWake, safeConfigValue, socketPathOk } from '../src/pi-wake.js';
import { fakeCodex, startFakeClaudeSocket, startFakePiSocket } from './helpers/fake-agents.js';

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
  assert.match(wakeText({ kind: 'invite', inviteId: 'inv-abc12345', level: 'full', driver: 'jev' }), /fai_browser_run/);
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

// --- pi (the FAI pi extension's socket, src/pi-wake.js) -------------------------------------------------------------

const PI_SESSION = '01a1c20b-3ac0-7271-9837-9f9f0bd19838';

test('pi: host from clientInfo "pi"; the environment alone needs the extension\'s socket variable', () => {
  assert.equal(detectHost({ name: 'pi' }, {}), 'pi');
  assert.equal(detectHost({ name: 'pi-coding-agent' }, {}), 'pi');
  assert.equal(detectHost({ name: 'pipeline' }, {}), 'unknown', 'only pi or pi-*');
  assert.equal(detectHost(null, { PI_CODING_AGENT: 'true', AI_AGENT: 'pi' }), 'unknown',
    'a bash-tool child inherits these: not enough');
  assert.equal(detectHost(null, { PI_CODING_AGENT: 'true', FAI_PI_WAKE_SOCKET: '/run/user/1000/fai-pi-x/7.sock' }), 'pi');
  assert.equal(hostSessionId('pi', { FAI_PI_SESSION_ID: PI_SESSION }), PI_SESSION);
  assert.equal(hostSessionId('pi', { FAI_PI_SESSION_ID: 'bad id; x' }), null);
  assert.equal(hostSessionId('claude', { FAI_PI_SESSION_ID: PI_SESSION }), null);
});

test('pi: the socket counts only when named after the parent pid, with a token, on a short absolute path', () => {
  const env = { FAI_PI_WAKE_SOCKET: '/run/user/1000/fai-pi-abc/4242.sock', FAI_PI_WAKE_TOKEN: 't' };
  assert.deepEqual(piSocket(env, { ppid: 4242 }), { path: env.FAI_PI_WAKE_SOCKET, token: 't' });
  assert.equal(piSocket(env, { ppid: 5151 }), null, 'a wrapper or a reparented server fails closed');
  assert.equal(piSocket(env, { ppid: 1 }), null);
  assert.equal(piSocket({ FAI_PI_WAKE_SOCKET: env.FAI_PI_WAKE_SOCKET }, { ppid: 4242 }), null, 'no token');
  assert.equal(piSocket({ ...env, FAI_PI_WAKE_SOCKET: `/${'d'.repeat(120)}/4242.sock` }, { ppid: 4242 }), null, 'too long');
  assert.equal(piSocket({ ...env, FAI_PI_WAKE_SOCKET: 'rel/4242.sock' }, { ppid: 4242 }), null, 'relative');
  assert.equal(wakeCapability({ host: 'pi', env, ppid: 4242 }), 'pi-socket');
  assert.equal(wakeCapability({ host: 'pi', env: { ...env, FAI_WAKE: '0' }, ppid: 4242 }), 'none');
  assert.equal(wakeCapability({ host: 'claude', env, ppid: 4242 }), 'none', 'another host never uses pi\'s socket');
  assert.equal(wakeCapability({ host: 'pi', env: {}, ppid: 4242 }), 'none');
});

test('pi: wake texts name the tools the way pi shows them', () => {
  assert.match(wakeText({ kind: 'invite', inviteId: 'inv-abc12345', level: 'interactive', host: 'pi' }),
    /Call mcp__fai_browser__fai_browser_open with \{"inviteId": "inv-abc12345"\}/);
  assert.match(wakeText({ kind: 'resume', requestId: 'req_9', host: 'pi' }),
    /mcp__fai_browser__fai_browser_observe with requestId req_9/);
  assert.match(wakeText({ kind: 'approved', requestId: 'req_9', driver: 'jev', host: 'pi' }), /mcp__fai_browser__fai_browser_run/);
  assert.doesNotMatch(wakeText({ kind: 'resume', requestId: 'req_9', host: 'claude' }), /mcp__/);
  for (const kind of ['invite', 'resume', 'approved']) {
    const text = wakeText({ kind, inviteId: 'inv-abc12345', requestId: 'req_1', userText: 'x\ny', host: 'pi' });
    assert.equal(checkWakeText(text), true, `${kind} passes the extension's check`);
  }
});

test('pi protocol helpers: wake lines, text check, config values, path length', () => {
  assert.deepEqual(encodeWake('tok', '[FAI Browser] hi').trim().split('\n').map(line => JSON.parse(line)),
    [{ type: 'auth', v: 1, token: 'tok' }, { type: 'wake', text: '[FAI Browser] hi' }]);
  assert.equal(checkWakeText('[FAI Browser] a\nb'), true);
  assert.equal(checkWakeText('hello'), false);
  assert.equal(checkWakeText('[FAI Browser] a\u0000'), false);
  assert.equal(checkWakeText('[FAI Browser] a\rb'), false);
  assert.equal(checkWakeText('[FAI Browser] a\u001b[2J'), false);
  assert.equal(checkWakeText(`[FAI Browser] ${'x'.repeat(4000)}`), false);
  assert.equal(safeConfigValue('/usr/bin/node'), true);
  for (const bad of ['', '!rm -rf ~', '${HOME}', '/a/$b', '~/x', 'a\nb', 42]) {
    assert.equal(safeConfigValue(bad), false, String(bad));
  }
  assert.equal(socketPathOk('/run/user/1000/fai-pi-abc/1.sock'), true);
  assert.equal(socketPathOk(`/${'x'.repeat(100)}`), false);
  assert.equal(socketPathOk('x.sock'), false);
});

test('pi socket: ok with its delivery; refused, no ack, timeout and no socket each fail with a code', async t => {
  const fake = await startFakePiSocket(t);
  assert.deepEqual(await deliverPiSocket({ path: fake.path, token: fake.token, text: '[FAI Browser] one' }),
    { ok: true, reply: 'turn' });
  assert.deepEqual(fake.received, [{ type: 'wake', text: '[FAI Browser] one' }]);
  const busy = await startFakePiSocket(t, { delivery: 'followUp' });
  assert.deepEqual(await deliverPiSocket({ path: busy.path, token: busy.token, text: '[FAI Browser] two' }),
    { ok: true, reply: 'followUp' });

  const wrong = await deliverPiSocket({ path: fake.path, token: 'wrong', text: '[FAI Browser] x' });
  assert.deepEqual([wrong.ok, wrong.code, wrong.message], [false, 'refused', 'unauthorized']);
  const limited = await startFakePiSocket(t, { mode: 'refuse' });
  assert.deepEqual(await deliverPiSocket({ path: limited.path, token: limited.token, text: '[FAI Browser] x' }),
    { ok: false, code: 'refused', message: 'busy_limit' });
  const noAck = await startFakePiSocket(t, { mode: 'no-ack' });
  assert.equal((await deliverPiSocket({ path: noAck.path, token: noAck.token, text: '[FAI Browser] x' })).code, 'no_ack');
  const silent = await startFakePiSocket(t, { mode: 'silent' });
  const started = Date.now();
  const timedOut = await deliverPiSocket({ path: silent.path, token: silent.token, text: '[FAI Browser] x', timeoutMs: 300 });
  assert.equal(timedOut.code, 'timeout');
  assert.ok(Date.now() - started < 3000);
  const missing = await deliverPiSocket({ path: join(fake.dir, 'nope.sock'), token: 't', text: '[FAI Browser] x' });
  assert.equal(missing.code, 'no_socket');

  const before = fake.received.length;
  const bad = await deliverPiSocket({ path: fake.path, token: fake.token, text: 'not a FAI text' });
  assert.deepEqual([bad.ok, bad.code], [false, 'bad_text']);
  assert.equal(fake.received.length, before, 'refused before connecting');
});

test('pi socket: the token never appears in a result', async t => {
  const echo = await startFakePiSocket(t, { mode: 'echo-token' });
  const refused = await deliverPiSocket({ path: echo.path, token: echo.token, text: '[FAI Browser] x' });
  assert.equal(refused.code, 'refused');
  assert.ok(!JSON.stringify(refused).includes(echo.token));
  assert.match(refused.message, /\[token\]/);
});

test('deliverWake routes pi-socket to the parent\'s socket only', async t => {
  const fake = await startFakePiSocket(t, { pid: 4242 });
  const env = { FAI_PI_WAKE_SOCKET: fake.path, FAI_PI_WAKE_TOKEN: fake.token };
  assert.deepEqual(await deliverWake({ capability: 'pi-socket', text: '[FAI Browser] one', env, ppid: 4242 }),
    { ok: true, reply: 'turn' });
  assert.equal((await deliverWake({ capability: 'pi-socket', text: '[FAI Browser] x', env, ppid: 5151 })).code, 'no_socket');
  const off = await deliverWake({ capability: 'pi-socket', text: '[FAI Browser] x', env: { ...env, FAI_WAKE: '0' }, ppid: 4242 });
  assert.equal(off.code, 'disabled');
  assert.equal(fake.received.length, 1);
});

