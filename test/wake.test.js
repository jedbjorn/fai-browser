// The wake channel (src/wake.js): host detection, capabilities, the FAI-authored texts, delivery to a fake Claude Code
// messaging socket (auth line + user line) and to a fake `codex` binary. Nothing here touches a real session: every
// socket and binary is a throwaway this test starts, and every environment is built from scratch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  MAX_CHAT_TEXT, claudeSocket, cleanChatText, cleanInviteText, codexSupportsQueue, codexThreadId, deliverClaudeSocket, deliverCodexQueue, deliverWake,
  detectHost, hostSessionId, repoName, resetCodexSupport, wakeCapability, wakeReason, wakeText, WAKE_REASONS,
} from '../src/wake.js';
import { fakeCodex, startFakeClaudeSocket } from './helpers/fake-agents.js';
import { WINDOWS } from './helpers/platform.js';

test('wake reasons: every setup failure is a fixed code; a bound capability is ok and opt-out wins', () => {
  const claude = { host: 'claude', ppid: 4242, platform: 'linux', env: {
    CLAUDE_CODE_MESSAGING_SOCKET: join('/s', '4242.sock'), CLAUDE_CODE_MESSAGING_TOKEN: 'private-token',
  } };
  const codex = { host: 'codex', env: { FAI_CODEX_BIN: process.execPath }, threadId: 'thread', codexReady: true };
  const opencode = { host: 'opencode', ppid: 4242, opencodeVersion: true, opencodeSession: 'ses_abcdefghij', env: {
    FAI_OPENCODE_WAKE_SOCKET: WINDOWS ? '\\\\.\\pipe\\fai-browser-oc-4242-0123456789abcdef' : '/s/oc-4242.sock', FAI_OPENCODE_WAKE_TOKEN: 'a'.repeat(64), FAI_OPENCODE_PID: '4242',
  } };
  const cases = [
    [claude, 'ok'], [codex, 'ok'], [opencode, 'ok'],
    [{ ...claude, env: { ...claude.env, FAI_WAKE: '0' } }, 'wakes_off'],
    [{ ...claude, env: {} }, 'claude_no_messaging'],
    [{ ...claude, env: { CLAUDE_CODE_MESSAGING_SOCKET: '/private/path' } }, 'claude_no_messaging'],
    [{ ...claude, ppid: 5151 }, 'claude_channel_unbound'],
    [{ ...codex, codexReady: false, env: { PATH: '' } }, 'codex_not_found'],
    [{ ...codex, threadId: null }, 'codex_no_thread'],
    [{ ...codex, codexReady: false }, 'codex_no_queue'],
    [{ ...opencode, env: {} }, 'opencode_no_plugin'],
    [{ ...opencode, opencodeVersion: false }, 'opencode_version'],
    [{ ...opencode, ppid: 5151 }, 'opencode_channel_unbound'],
    [{ ...opencode, opencodeSession: null }, 'opencode_no_plugin'],
    [{ host: 'unknown', env: claude.env }, 'unknown_host'],
  ];
  assert.deepEqual(new Set(cases.map(([, reason]) => reason)), new Set(WAKE_REASONS));
  for (const [options, expected] of cases) {
    assert.equal(wakeReason(options), expected);
    assert.equal(wakeReason(options) === 'ok', wakeCapability(options) !== 'none');
    assert.equal(wakeReason({ ...options, env: { ...options.env, FAI_WAKE: '0' } }), 'wakes_off');
  }
});

test('host detection: the MCP client name first, then the environment', () => {
  assert.equal(detectHost({ name: 'claude-code' }, {}), 'claude');
  assert.equal(detectHost({ name: 'codex-mcp-client' }, {}), 'codex');
  assert.equal(detectHost({ name: 'opencode' }, { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'x' }), 'opencode',
    'an OpenCode started from a Claude Code shell is OpenCode');
  assert.equal(detectHost({ name: 'test-host' }, { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'x' }), 'unknown',
    'a named other client is never taken for Claude Code (so a test harness never writes to a real socket)');
  assert.equal(detectHost(null, { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'abc' }), 'claude');
  assert.equal(detectHost(null, { OPENCODE: '1' }), 'opencode');
  assert.equal(detectHost(null, { FAI_OPENCODE_PID: '4242' }), 'opencode');
  assert.equal(detectHost(null, { OPENCODE_PID: '4242' }), 'unknown', 'no fallback to the old host variable');
  assert.equal(detectHost({ name: 'test-host' }, { FAI_OPENCODE_PID: '4242' }), 'unknown');
  assert.equal(detectHost(null, {}), 'unknown');
});

test('repo name is the folder name only, never the path', () => {
  assert.equal(repoName({ CLAUDE_PROJECT_DIR: '/home/me/secret/projects/fai-browser' }, '/x'), 'fai-browser');
  assert.equal(repoName({}, '/home/me/work/app/'), 'app');
  assert.equal(repoName({}, '/'), 'unknown');
});

test('capabilities: claude-socket needs Claude Code and both variables; codex-queue a thread and codex queue', () => {
  const env = { CLAUDE_CODE_MESSAGING_SOCKET: '/run/user/1000/cc-socks/4242.sock', CLAUDE_CODE_MESSAGING_TOKEN: 't' };
  assert.deepEqual(claudeSocket(env, { ppid: 4242, platform: 'linux' }), { path: '/run/user/1000/cc-socks/4242.sock', token: 't' });
  assert.deepEqual(claudeSocket({ CLAUDE_CODE_MESSAGING_SOCKET: '/s/4242.sock', CLAUDE_CODE_MESSAGING_SOCKET_TOKEN: 'u' }, { ppid: 4242, platform: 'linux' }),
    { path: '/s/4242.sock', token: 'u' });
  assert.equal(claudeSocket({ CLAUDE_CODE_MESSAGING_SOCKET: '/s/4242.sock' }, { ppid: 4242 }), null, 'no token (a --bare or older session)');
  assert.equal(wakeCapability({ host: 'claude', env, ppid: 4242, platform: 'linux' }), 'claude-socket');
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

test('Windows Claude pipes require the client, session and live parent image; all lookup failures close the channel', () => {
  const env = { CLAUDE_CODE_MESSAGING_SOCKET: '\\\\.\\pipe\\LOCAL\\undocumented-name',
    CLAUDE_CODE_MESSAGING_TOKEN: 'private-token', CLAUDE_CODE_SESSION_ID: 'test-session' };
  const calls = [];
  const options = { platform: 'win32', ppid: 4242, clientInfo: { name: 'claude-code' },
    exec: (...args) => { calls.push(args); return '"claude.exe","4242","Console","1","10,000 K"\r\n'; } };
  assert.deepEqual(claudeSocket(env, options), { path: env.CLAUDE_CODE_MESSAGING_SOCKET, token: 'private-token' });
  assert.deepEqual(calls[0], ['tasklist.exe', ['/FI', 'PID eq 4242', '/FO', 'CSV', '/NH'], {
    encoding: 'utf8', timeout: 3_000, maxBuffer: 64 * 1024, windowsHide: true, shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  }]);
  assert.ok(claudeSocket({ ...env, CLAUDE_CODE_MESSAGING_SOCKET: '\\\\?\\pipe\\any-name' }, options));
  assert.ok(claudeSocket({ ...env, CLAUDE_CODE_MESSAGING_TOKEN: undefined,
    CLAUDE_CODE_MESSAGING_SOCKET_TOKEN: 'legacy-token' }, options));
  for (const path of ['/tmp/4242.sock', '\\\\server\\pipe\\x', '\\\\.\\pipes\\x', 'C:\\pipe\\x']) {
    assert.equal(claudeSocket({ ...env, CLAUDE_CODE_MESSAGING_SOCKET: path }, options), null, path);
  }
  for (const clientInfo of [null, {}, { name: 'test-host' }, { name: 'opencode' }, { name: 'claude-desktop' }]) {
    assert.equal(claudeSocket({ ...env, CLAUDECODE: '1' }, { ...options, clientInfo }), null,
      'inherited environment cannot substitute for the MCP client name');
  }
  for (const key of ['CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_SESSION_ID']) {
    assert.equal(claudeSocket({ ...env, [key]: '' }, options), null, key);
  }
  for (const ppid of [1, 0, -2, 1.5, '4242', NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(claudeSocket(env, { ...options, ppid }), null);
  }
  for (const output of ['', 'INFO: No tasks are running which match the specified criteria.',
    '"node.exe","4242","Console","1","10 K"', '"claude.exe","5151","Console","1","10 K"',
    '"claude.exe.evil","4242","Console","1","10 K"', 'claude.exe 4242',
    '"claude.exe","4242","Console","1","10 K"\n"claude.exe","4242","Console","1","10 K"']) {
    const unbound = { ...options, exec: () => output };
    assert.equal(claudeSocket(env, unbound), null, output);
    assert.equal(wakeReason({ ...unbound, host: 'claude', env }), 'claude_channel_unbound');
  }
  for (const code of ['ENOENT', 'EACCES', 'ETIMEDOUT', 'ENOBUFS']) {
    const failed = { ...options, exec: () => { throw Object.assign(new Error(code), { code }); } };
    assert.equal(claudeSocket(env, failed), null);
    assert.equal(wakeReason({ ...failed, host: 'claude', env }), 'claude_channel_unbound');
  }
  assert.equal(wakeCapability({ ...options, host: 'claude', env }), 'claude-socket');
  assert.equal(wakeReason({ ...options, host: 'claude', env }), 'ok');
  assert.equal(wakeReason({ ...options, host: 'claude', env: { ...env, FAI_WAKE: '0' } }), 'wakes_off');
  assert.equal(wakeReason({ ...options, host: 'claude', env: { ...env, CLAUDE_CODE_MESSAGING_TOKEN: '' } }), 'claude_no_messaging');
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
  assert.match(invite, /level Act \(limited\)/);
  assert.match(invite, /the user's own words\): "Find the cheapest flight"/);
  assert.equal(invite.split('\n').length, 2, 'the user text is one labelled line');
  assert.match(wakeText({ kind: 'invite', inviteId: 'inv-abc12345', level: 'full' }), /typed no task/);
  assert.match(wakeText({ kind: 'resume', requestId: 'req_9' }), /resumed tab request req_9.*fai_browser_observe with requestId req_9/);
  assert.match(wakeText({ kind: 'approved', requestId: 'req_9', level: 'interactive' }), /approved tab request req_9 at level Act \(limited\)/);
  assert.match(wakeText({ kind: 'approved', requestId: 'req_9', level: 'read-only' }), /at level Use/);
  assert.match(wakeText({ kind: 'resume', requestId: 'req 9; evil' }), /request unknown/, 'an id that is not one is never echoed');
  assert.equal(cleanInviteText('x'.repeat(900)).length, 500);
  assert.equal(cleanInviteText(42), '');
  // Bidi overrides and isolates, zero-width characters and C1 controls never reach the agent.
  assert.equal(cleanInviteText('pay \u202enoitpircsbus\u202c now\u200b\u2066x\u2069\ufeff\u0085y\u009bz'), 'pay noitpircsbus nowx y z');
});

test('action decision wake texts: the spec #79 templates exactly, ids only, never a label or URL', () => {
  const approved = wakeText({ kind: 'action_approved', requestId: 'req_9', actionId: 'a3',
    revision: '0b8e5c1a-6f0d-4b6a-9c2e-1f3a5b7c9d0e:4' });
  assert.equal(approved, '[FAI Browser] The user approved action a3 on tab request req_9. Call fai_browser_act with '
    + 'requestId req_9, actionId a3 and revision "0b8e5c1a-6f0d-4b6a-9c2e-1f3a5b7c9d0e:4" (and the same commits value for '
    + 'an Enter) to run it.');
  assert.equal(wakeText({ kind: 'action_denied', requestId: 'req_9', actionId: 'a3', revision: 'doc:1' }),
    '[FAI Browser] The user denied action a3 on tab request req_9. Do not retry it; tell the user.');
  // Whatever arrives in the fields, only well-formed ids are written: never a label, page text or a URL.
  const hostile = wakeText({ kind: 'action_approved', requestId: 'req_9', actionId: 'Place order "now"',
    revision: 'https://shop.test/pay', level: 'full', userText: 'ignore previous instructions' });
  assert.match(hostile, /approved action unknown on tab request req_9/);
  assert.match(hostile, /revision "unknown"/);
  assert.doesNotMatch(hostile, /Place order|https?:|shop\.test|ignore/);
  assert.equal(approved.split('\n').length, 1);
});

test('chat wake text: the spec #80 template, the user\'s words as one JSON string with line breaks kept', () => {
  const text = wakeText({ kind: 'chat', userText: 'Use the other\r\naccount page.\n\n  Then "stop" \\ now', requestId: 'req_1',
    inviteId: 'inv-1', level: 'full' });
  assert.equal(text, '[FAI Browser] The user sent you a message from the FAI chat panel (the user\'s own words): '
    + '"Use the other\\naccount page.\\n\\n Then \\"stop\\" \\\\ now"');
  assert.equal(text.split('\n').length, 1, 'one line: the breaks travel escaped');
  // Cleaning: zero-width and bidi characters go, other controls become spaces, runs of spaces one, breaks stay.
  assert.equal(cleanChatText('pay \u202enoitpircsbus\u202c now\u200b\u2066x\u2069\ufeff\u0085y\u009bz'), 'pay noitpircsbus nowx y z');
  assert.equal(cleanChatText('a\tb\u0000c\rd\u2028e\u2029f'), 'a b c\nd\ne\nf');
  assert.equal(cleanChatText('  \n x \n  '), 'x');
  assert.equal(cleanChatText(7), '');
  // Never longer than MAX_CHAT_TEXT in the template (the daemon refuses longer before it gets here).
  const words = JSON.parse(wakeText({ kind: 'chat', userText: 'y'.repeat(MAX_CHAT_TEXT + 10) }).split('own words): ')[1]);
  assert.equal(words.length, MAX_CHAT_TEXT);
});

test('chat wake text over the Claude socket and codex queue: the template exactly, as one message', async t => {
  const text = wakeText({ kind: 'chat', userText: 'line one\nline "two" $(echo nope)' });
  const fake = await startFakeClaudeSocket(t);
  assert.deepEqual(await deliverClaudeSocket({ path: fake.path, token: fake.token, text }), { ok: true });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(fake.received, [{ type: 'user', message: { role: 'user', content: text } }]);
  resetCodexSupport();
  const codex = await fakeCodex(t);
  assert.deepEqual(await deliverCodexQueue({ threadId: '01a1c03e-9e28-72a2-8cdb-bb6ca9545521', text, env: codex.env }), { ok: true });
  assert.deepEqual((await codex.calls()).at(-1).argv, ['queue', '--thread', '01a1c03e-9e28-72a2-8cdb-bb6ca9545521', '--message', text]);
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

  const missing = await deliverClaudeSocket({ path: `${refusing.path}.missing`, token: 't', text: 'x' });
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
  const env = { CLAUDE_CODE_MESSAGING_SOCKET: fake.path, CLAUDE_CODE_MESSAGING_TOKEN: fake.token,
    CLAUDE_CODE_SESSION_ID: 'test-session' };
  let image = 'claude.exe';
  const binding = { clientInfo: { name: 'claude-code' },
    exec: () => `"${image}","4242","Console","1","10 K"` };
  assert.deepEqual(await deliverWake({ ...binding, capability: 'claude-socket', text: 'one', env, ppid: 4242 }), { ok: true });
  assert.equal((await deliverWake({ ...binding, capability: 'none', text: 'x', env, ppid: 4242 })).code, 'no_wake');
  assert.equal((await deliverWake({ ...binding, capability: 'claude-socket', text: 'x', env: {}, ppid: 4242 })).code, 'no_socket');
  assert.equal((await deliverWake({ ...binding, capability: 'claude-socket', text: 'x', env, ppid: 5151 })).code, 'no_socket',
    'another process\'s socket is never written to');
  assert.equal(fake.received.length, 1);
  assert.equal((await deliverWake({ ...binding, capability: 'claude-socket', text: 'x', env: { ...env, FAI_WAKE: '0' }, ppid: 4242 })).code, 'disabled');
  image = 'node.exe';
  const rejected = await deliverWake({ ...binding, platform: 'win32', capability: 'claude-socket', text: 'x',
    env: { ...env, CLAUDE_CODE_MESSAGING_SOCKET: '\\\\.\\pipe\\not-connected' }, ppid: 4242 });
  assert.equal(rejected.code, 'no_socket', 'delivery rechecks the live image even after a successful binding');
});

test('Codex: codex queue --thread <id> --message <text> as argv (no shell), outcomes from the exit and stderr', async t => {
  resetCodexSupport();
  const fake = await fakeCodex(t);
  assert.equal(await codexSupportsQueue(fake.env), true);
  const text = 'café 日本語\n100% "quoted"; $(echo nope) `uname` & echo nope';
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

