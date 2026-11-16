// The chat panel's conversation readers (src/chat.js, spec #80 AC 1 and 2) on recorded fixtures (test/fixtures/chat):
// Claude Code and Codex from their own files, OpenCode through FAI's plugin with a fake OpenCode client. Messages only,
// in order; nothing a host injects, no tool, thinking or subagent text; unknown or cut records skipped; a read resumes
// from its cursor and tells whether a turn runs. Every file and socket here is a throwaway in a temp folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLIPPED, MAX_MESSAGE_TEXT, claudeRecord, codexRecord, createChatReader, faiMessage, findClaudeConversation,
  findCodexRollout, fitPost, readJsonLines, readOpencodePlugin,
} from '../src/chat.js';
import { FaiBrowserWake } from '../src/opencode-plugin.js';
import { wakeText } from '../src/wake.js';

const FIXTURES = new URL('./fixtures/chat/', import.meta.url);
const fixture = name => new URL(name, FIXTURES);
const CLAUDE_SESSION = '5f0c2a8e-1d34-4b6a-9e77-0c1f2d3e4a5b';
const CODEX_THREAD = '01a1e396-0000-7000-8000-00000000f1c5';
const STATE = Symbol.for('fai-browser.opencode-wake.v1');
// Words that appear only in what a reader must never return.
const NEVER = /never shown|Fixture thinking|Fixture reminder|Fixture skill|system-reminder|task-notification|command-name|local-command|AGENTS\.md|environment_context|developer instructions|Fixture summary|Image:|fixture tool|Subagent prompt|half a record|unknown to the reader|\[FAI Browser\]/;

async function tempDir(t, prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// A Claude Code settings folder holding the fixture as <projects>/<slug>/<session>.jsonl.
async function claudeHome(t) {
  const dir = await tempDir(t, 'fai-chat-claude-');
  await mkdir(join(dir, 'projects', '-home-user-other'), { recursive: true });
  await mkdir(join(dir, 'projects', '-home-user-demo-repo'), { recursive: true });
  const path = join(dir, 'projects', '-home-user-demo-repo', `${CLAUDE_SESSION}.jsonl`);
  await copyFile(fixture('claude-code.jsonl'), path);
  return { env: { CLAUDE_CONFIG_DIR: dir }, path };
}

// A Codex home holding the fixture as sessions/YYYY/MM/DD/rollout-<timestamp>-<thread>.jsonl, next to other days.
async function codexHome(t) {
  const dir = await tempDir(t, 'fai-chat-codex-');
  await mkdir(join(dir, 'sessions', '2026', '11', '15'), { recursive: true });
  await writeFile(join(dir, 'sessions', '2026', '11', '15', 'rollout-2026-11-15T08-00-00-01a1e000-0000-7000-8000-000000000001.jsonl'), '');
  const day = join(dir, 'sessions', '2026', '11', '16');
  await mkdir(day, { recursive: true });
  const path = join(day, `rollout-2026-11-16T10-00-29-${CODEX_THREAD}.jsonl`);
  await copyFile(fixture('codex.jsonl'), path);
  return { env: { CODEX_HOME: dir }, path };
}

const brief = messages => messages.map(({ role, text }) => [role, text]);

test('Claude Code: messages only, in order; FAI wakes as FAI lines; nothing injected, sidechain, tool or thinking', async t => {
  const { env, path } = await claudeHome(t);
  assert.equal(await findClaudeConversation(CLAUDE_SESSION, { env }), path, 'found under any project slug');
  assert.equal(await findClaudeConversation('not-a-session', { env }), null);
  const reader = createChatReader({ host: 'claude', env, version: '2.1.325' });
  const read = await reader.read({ target: CLAUDE_SESSION });
  assert.deepEqual(brief(read.messages), [
    ['user', 'Open the pricing page on example.com and tell me the plan names.'],
    ['agent', 'I am reading the pricing page now.'],
    ['agent', 'The pricing page lists three plans: Starter, Team and Enterprise.'],
    ['fai', 'FAI: invited you to a browser tab (invite inv-fixture1)'],
    ['agent', 'I joined the tab you invited me to. The cart holds two items.'],
  ]);
  assert.doesNotMatch(JSON.stringify(read.messages), NEVER);
  assert.equal(read.busy, false, 'the last turn ended');
  for (const message of read.messages) {
    assert.match(message.id, /^\d+$/);
    assert.match(message.at, /^\d{4}-\d\d-\d\dT/);
  }
});

test('Claude Code: a read resumes from its cursor; busy from the panel message until the turn ends', async t => {
  const { env, path } = await claudeHome(t);
  const reader = createChatReader({ host: 'claude', env, version: '2.1.325' });
  const first = await reader.read({ target: CLAUDE_SESSION });
  const again = await reader.read({ target: CLAUDE_SESSION, cursor: first.cursor });
  assert.deepEqual(again.messages, [], 'nothing new, nothing repeated');
  await appendFile(path, await readFile(fixture('claude-code-append.jsonl')));
  const mid = await reader.read({ target: CLAUDE_SESSION, cursor: again.cursor });
  assert.deepEqual(brief(mid.messages), [
    ['user', 'Use the other account page.\nThen stop.'],
    ['agent', 'Switching to the other account page.'],
  ], 'the chat panel\'s own message comes back as the user\'s words, line break kept');
  assert.equal(mid.busy, true, 'mid-turn');
  // Half a record (the host is still writing it) waits for the next read.
  const finish = (await readFile(fixture('claude-code-finish.jsonl'), 'utf8')).split('\n');
  await appendFile(path, finish[0].slice(0, 40));
  const partial = await reader.read({ target: CLAUDE_SESSION, cursor: mid.cursor });
  assert.deepEqual([partial.messages, partial.busy, partial.cursor], [[], true, mid.cursor]);
  await appendFile(path, `${finish[0].slice(40)}\n${finish[1]}\n`);
  const done = await reader.read({ target: CLAUDE_SESSION, cursor: partial.cursor });
  assert.deepEqual(brief(done.messages), [['agent', 'Done: the other account page shows no open invoices.']]);
  assert.equal(done.busy, false, 'the turn ended');
  // The ids are stable: a fresh read (no cursor) names the same lines the same way.
  const fresh = await reader.read({ target: CLAUDE_SESSION });
  assert.deepEqual(fresh.messages.slice(-3), [...mid.messages, ...done.messages]);
});

test('Claude Code: an interruption ends the turn; a file it cannot find or read says so with host and version', async t => {
  const { env, path } = await claudeHome(t);
  const reader = createChatReader({ host: 'claude', env, version: '2.1.325' });
  await appendFile(path, await readFile(fixture('claude-code-append.jsonl')));
  const mid = await reader.read({ target: CLAUDE_SESSION });
  assert.equal(mid.busy, true);
  const interrupted = (await readFile(fixture('claude-code-finish.jsonl'), 'utf8')).trim().split('\n').at(-1);
  await appendFile(path, `${interrupted}\n`);
  const after = await reader.read({ target: CLAUDE_SESSION, cursor: mid.cursor });
  assert.deepEqual([after.messages, after.busy], [[], false]);
  assert.deepEqual(await reader.read({ target: '00000000-0000-4000-8000-000000000000' }),
    { error: { code: 'unreadable', host: 'claude', version: '2.1.325' } });
  assert.deepEqual(await reader.read({ target: null }), { error: { code: 'not_ready', host: 'claude', version: '2.1.325' } });
  await rm(path);
  assert.equal((await reader.read({ target: CLAUDE_SESSION, cursor: after.cursor })).error.code, 'unreadable');
});

test('Codex: user and agent messages only, injected AGENTS.md and environment never; busy from task_started', async t => {
  const { env, path } = await codexHome(t);
  assert.equal(await findCodexRollout(CODEX_THREAD, { env }), path, 'the newest day that holds the thread');
  assert.equal(await findCodexRollout('01a1e000-0000-7000-8000-00000000ffff', { env }), null);
  const reader = createChatReader({ host: 'codex', env, version: '0.169.0' });
  const read = await reader.read({ target: CODEX_THREAD });
  assert.deepEqual(brief(read.messages), [
    ['user', 'Open the pricing page on example.com and list the plans.'],
    ['agent', 'Opening the pricing page now.'],
    ['agent', 'Three plans: Starter, Team and Enterprise.'],
    ['fai', 'FAI: invited you to a browser tab (invite inv-fixture2)'],
    ['agent', 'I joined the tab. What should I do on it?'],
  ]);
  assert.doesNotMatch(JSON.stringify(read.messages), NEVER);
  assert.equal(read.busy, false);
  await appendFile(path, await readFile(fixture('codex-append.jsonl')));
  const mid = await reader.read({ target: CODEX_THREAD, cursor: read.cursor });
  assert.deepEqual(brief(mid.messages), [['user', 'Also check the invoices.\nThanks.'], ['agent', 'Checking the invoices.']]);
  assert.equal(mid.busy, true, 'task_started without task_complete');
  await appendFile(path, await readFile(fixture('codex-finish.jsonl')));
  const done = await reader.read({ target: CODEX_THREAD, cursor: mid.cursor });
  assert.deepEqual([brief(done.messages), done.busy], [[['agent', 'No open invoices.']], false]);
  // An aborted turn is over too.
  await appendFile(path, await readFile(fixture('codex-append.jsonl')));
  const again = await reader.read({ target: CODEX_THREAD, cursor: done.cursor });
  assert.equal(again.busy, true);
  await appendFile(path, await readFile(fixture('codex-abort.jsonl')));
  assert.equal((await reader.read({ target: CODEX_THREAD, cursor: again.cursor })).busy, false);
  assert.deepEqual(await reader.read({ target: null }), { error: { code: 'not_ready', host: 'codex', version: '0.169.0' } });
});

test('records: unknown kinds and malformed records are skipped, never shown raw', () => {
  for (const record of [claudeRecord, codexRecord]) {
    for (const entry of [null, 7, 'text', [], {}, { type: 'user' }, { type: 'assistant', message: null },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: 'raw' } },
      { type: 'response_item', payload: { type: 'function_call', arguments: 'secret' } }]) {
      assert.equal(record(entry).message ?? null, null);
    }
  }
  // A peer message that is not FAI's (another session or a subagent) starts a turn but shows nothing.
  assert.deepEqual(claudeRecord({ type: 'user', isMeta: true, origin: { kind: 'peer' },
    message: { content: 'Another Claude session sent a message:\n<agent-message from="x">hi</agent-message>' } }), { busy: true });
  // isMeta text that is not a peer message is never shown, even when it imitates one.
  assert.deepEqual(claudeRecord({ type: 'user', isMeta: true, message: { content: '[FAI Browser] The user approved tab request r1 at level Use.' } }), {});
});

test('FAI lines: each wake template becomes one short FAI line; the chat template the user\'s words', () => {
  const cases = [
    [{ kind: 'approved', requestId: 'r12', level: 'read-only' }, 'FAI: approved tab request r12'],
    [{ kind: 'resume', requestId: 'r12' }, 'FAI: resumed tab request r12'],
    [{ kind: 'invite', inviteId: 'inv-1', level: 'full', userText: 'buy it' }, 'FAI: invited you to a browser tab (invite inv-1)'],
    [{ kind: 'action_approved', requestId: 'r12', actionId: 'a3', revision: 'x:1' }, 'FAI: approved action a3 on tab request r12'],
    [{ kind: 'action_denied', requestId: 'r12', actionId: 'a3' }, 'FAI: denied action a3 on tab request r12'],
  ];
  for (const [fields, line] of cases) assert.deepEqual(faiMessage(wakeText(fields)), { role: 'fai', text: line });
  assert.deepEqual(faiMessage(wakeText({ kind: 'chat', userText: 'two\nlines' })), { role: 'user', text: 'two\nlines' });
  assert.deepEqual(faiMessage('[FAI Browser] something new <b>x</b>'), { role: 'fai', text: 'FAI: a FAI Browser message' });
});

test('limits: a text over 8,000 characters is clipped and says so; a first read keeps the newest 200; a post fits 1 MB', async t => {
  const dir = await tempDir(t, 'fai-chat-limits-');
  const path = join(dir, 'c.jsonl');
  const line = (text, n) => JSON.stringify({ type: 'user', message: { content: text }, timestamp: new Date(n * 1000).toISOString() });
  const lines = [line('y'.repeat(MAX_MESSAGE_TEXT + 50), 1)];
  for (let n = 0; n < 250; n += 1) lines.push(line(`message ${n}`, n + 2));
  await writeFile(path, `${lines.join('\n')}\n`);
  const all = await readJsonLines(path, null, claudeRecord, { tailBytes: 10 * 1024 * 1024 });
  assert.equal(all.messages.length, 200, 'the newest 200');
  assert.equal(all.messages.at(-1).text, 'message 249');
  const one = await readJsonLines(path, '0.0', entry => (entry.message?.content?.length > 1000 ? claudeRecord(entry) : {}));
  assert.equal(one.messages.length, 1);
  assert.equal(one.messages[0].text.length, MAX_MESSAGE_TEXT);
  assert.ok(one.messages[0].text.endsWith(CLIPPED));
  // A first read starts near the end of a long file, at a whole line.
  const tail = await readJsonLines(path, null, claudeRecord, { tailBytes: 2000 });
  assert.ok(tail.messages.length > 0 && tail.messages.length < 250);
  assert.match(tail.messages[0].text, /^message \d+$/);
  const many = Array.from({ length: 200 }, (_, n) => ({ id: String(n), role: 'agent', text: 'z'.repeat(MAX_MESSAGE_TEXT), at: null }));
  const fitted = fitPost(many);
  assert.ok(fitted.length < 200 && fitted.length > 50);
  assert.equal(fitted.at(-1).id, '199', 'the newest are kept');
  assert.ok(Buffer.byteLength(JSON.stringify(fitted)) < 1024 * 1024);
  // The daemon counts bytes: text in Cyrillic (2 bytes a character) and CJK (3) fits fewer, never over 1 MB.
  for (const letter of ['ж', '漢']) {
    const wide = many.map(item => ({ ...item, text: letter.repeat(MAX_MESSAGE_TEXT) }));
    const fit = fitPost(wide);
    assert.ok(fit.length > 10 && fit.length < fitted.length, `${letter}: ${fit.length}`);
    assert.equal(fit.at(-1).id, '199');
    assert.ok(Buffer.byteLength(JSON.stringify({ messages: fit, busy: false, cursor: 'x'.repeat(256) })) < 1024 * 1024);
  }
});

test('a line too long to read is skipped to its end, never shown', async t => {
  const dir = await tempDir(t, 'fai-chat-huge-');
  const path = join(dir, 'c.jsonl');
  const huge = JSON.stringify({ type: 'user', message: { content: 'h'.repeat(300 * 1024) } });
  const after = JSON.stringify({ type: 'user', message: { content: 'after the huge line' } });
  await writeFile(path, `${huge}\n${after}\n`);
  const read = await readJsonLines(path, '0.0', claudeRecord, { readBytes: 64 * 1024 });
  assert.deepEqual(brief(read.messages), [['user', 'after the huge line']]);
});

// --- OpenCode through FAI's plugin ----------------------------------------------------------------------------

function resetPlugin() {
  const state = globalThis[STATE];
  if (state) {
    state.server.close();
    delete globalThis[STATE];
  }
  for (const key of ['FAI_OPENCODE_WAKE_SOCKET', 'FAI_OPENCODE_WAKE_TOKEN', 'FAI_OPENCODE_PID']) delete process.env[key];
}

async function opencodePlugin(t) {
  const data = JSON.parse(await readFile(fixture('opencode.json'), 'utf8'));
  const dir = await tempDir(t, 'fai-chat-oc-');
  const saved = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = dir;
  resetPlugin();
  t.after(() => {
    resetPlugin();
    if (saved === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = saved;
  });
  const store = { [data.sessionID]: [...data.messages] };
  const client = {
    limits: [],
    session: {
      promptAsync: async () => ({ response: { status: 204 } }),
      // Newest `limit`, the way OpenCode pages them.
      messages: async ({ path, query }) => {
        client.limits.push(query?.limit);
        const list = store[path.id] ?? [];
        return { data: query?.limit ? list.slice(-query.limit) : list };
      },
      get: async ({ path }) => ({ data: { id: path.id } }),
    },
  };
  const hooks = await FaiBrowserWake({ client, directory: dir });
  const state = globalThis[STATE];
  if (!state.server.listening) await new Promise(resolve => state.server.once('listening', resolve));
  const channel = { path: process.env.FAI_OPENCODE_WAKE_SOCKET, token: process.env.FAI_OPENCODE_WAKE_TOKEN };
  return { data, store, client, hooks, channel };
}

test('OpenCode: the plugin reads a FAI session\'s text parts only; busy until the last assistant message completes', async t => {
  const { data, store, client, hooks, channel } = await opencodePlugin(t);
  const reader = createChatReader({ host: 'opencode', version: '1.19.5', opencode: () => channel });
  // Before the session used FAI, the plugin refuses to read it.
  assert.deepEqual(await reader.read({ target: data.sessionID }), { error: { code: 'unreadable', host: 'opencode', version: '1.19.5' } });
  await hooks['tool.execute.before']({ tool: 'fai-browser_fai_browser_open', sessionID: data.sessionID, callID: 'c1' }, { args: {} });
  const read = await reader.read({ target: data.sessionID });
  assert.deepEqual(brief(read.messages), [
    ['user', 'Open the pricing page on example.com and list the plans.'],
    ['agent', 'Opening the pricing page.'],
    ['agent', 'Three plans: Starter, Team and Enterprise.'],
    ['fai', 'FAI: approved tab request req_fixture3'],
    ['agent', 'Continuing in the approved tab.'],
  ]);
  assert.doesNotMatch(JSON.stringify(read.messages), NEVER);
  assert.equal(read.busy, false);
  assert.equal(read.cursor, data.messages.at(-1).info.id);
  assert.equal(client.limits.at(-1), 200, 'the newest 200 at most');
  // New messages: only those after the cursor; a half-written assistant message waits and makes it busy.
  store[data.sessionID].push(...data.append);
  const mid = await reader.read({ target: data.sessionID, cursor: read.cursor });
  assert.deepEqual(brief(mid.messages), [['user', 'Now the invoices page.\nThanks.'], ['agent', 'Checking the invoices page.']]);
  assert.equal(mid.busy, true);
  assert.equal(mid.cursor, data.append[1].info.id, 'the cursor stays before the unfinished message');
  store[data.sessionID].at(-1).info.time.completed = Date.now();
  const done = await reader.read({ target: data.sessionID, cursor: mid.cursor });
  assert.deepEqual([brief(done.messages), done.busy], [[['agent', 'Half-written answer (not shown until complete).']], false]);
  // A busy status from OpenCode's events counts too.
  globalThis[STATE].busy.add(data.sessionID);
  assert.equal((await reader.read({ target: data.sessionID, cursor: done.cursor })).busy, true);
});

test('OpenCode: an older assistant message OpenCode never completed does not hold the read back', async t => {
  const { data, store, hooks, channel } = await opencodePlugin(t);
  const reader = createChatReader({ host: 'opencode', version: '1.19.5', opencode: () => channel });
  await hooks['tool.execute.before']({ tool: 'fai-browser_fai_browser_open', sessionID: data.sessionID, callID: 'c1' }, { args: {} });
  const first = await reader.read({ target: data.sessionID });
  const base = Number(data.messages.at(-1).info.time.created) + 1000;
  const message = (id, role, text, created, completed) => ({
    info: { id, sessionID: data.sessionID, role, time: completed ? { created, completed } : { created } },
    parts: [{ type: 'text', text }],
  });
  // A turn cut off (no completed time), then the user went on and the next turn finished.
  store[data.sessionID].push(
    message('msg_zcut00000000000001', 'assistant', 'Cut off mid', base, false),
    message('msg_zcut00000000000002', 'user', 'Try again.', base + 1, false),
    message('msg_zcut00000000000003', 'assistant', 'Done this time.', base + 2, true),
  );
  const read = await reader.read({ target: data.sessionID, cursor: first.cursor });
  assert.deepEqual(brief(read.messages), [['agent', 'Cut off mid'], ['user', 'Try again.'], ['agent', 'Done this time.']]);
  assert.equal(read.busy, false);
  assert.equal(read.cursor, 'msg_zcut00000000000003');
  // While OpenCode reports the session busy, an unfinished message still waits (its turn may be running).
  globalThis[STATE].busy.add(data.sessionID);
  const running = await reader.read({ target: data.sessionID, cursor: first.cursor });
  assert.deepEqual([read.messages.length > running.messages.length, running.busy, running.cursor], [true, true, first.cursor]);
});

test('OpenCode: a wrong token, an unknown session or no plugin channel cannot read', async t => {
  const { data, hooks, channel } = await opencodePlugin(t);
  await hooks['tool.execute.before']({ tool: 'fai-browser_fai_browser_open', sessionID: data.sessionID, callID: 'c1' }, { args: {} });
  await assert.rejects(readOpencodePlugin({ ...channel, token: 'cd'.repeat(32), sessionID: data.sessionID }), { code: 'unreadable' });
  await assert.rejects(readOpencodePlugin({ ...channel, sessionID: 'ses_unknownunknown01' }), { code: 'unreadable' });
  const none = createChatReader({ host: 'opencode', version: '1.19.5', opencode: () => null });
  assert.equal((await none.read({ target: data.sessionID })).error.code, 'unreadable');
  assert.equal((await none.read({ target: 'not-a-session' })).error.code, 'unreadable');
});
