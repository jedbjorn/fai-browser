// FAI chats' runner (spec #84 "A turn", acceptance 3): one provider process per turn with the exact arguments, the
// chat's files folder as working folder and no shell; one turn per chat and three in all; Stop and the time limit
// leave no process; a missing, too old or signed-out program gives its fixed code; a program that fails a turn has
// its own error shown, clipped, as plain text. Also the turn token and the transcript. Uses a stand-in program
// (test/helpers/chat-standin.js) on every OS. Browserless.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHAT_CODES, chatTurnText, cleanChatText, clipProviderError, createChatRunner } from '../src/chat-runner.js';
import { createChatStore } from '../src/chat-store.js';
import { turnCommand } from '../src/chat-providers.js';

const STANDIN = join(import.meta.dirname, 'helpers', 'chat-standin.js');
const SERVER = { command: process.execPath, args: ['/fai/src/mcp-main.js'] };
const TOOLS = ['fai_browser_open', 'fai_browser_observe'];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const standins = () => Object.fromEntries(['claude', 'codex', 'opencode']
  .map(provider => [provider, { file: process.execPath, prefix: [STANDIN, provider] }]));

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function until(predicate, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(25);
  }
  throw new Error('timed out waiting');
}

async function setup(t, { control = {}, programs = standins(), ...options } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'fai-chat-runner-'));
  const root = join(dir, 'FAI-Local-Chats');
  await writeFile(join(dir, 'control.json'), JSON.stringify(control));
  const store = createChatStore({ root });
  const spawned = [];
  const runner = createChatRunner({ store, root, server: SERVER, tools: TOOLS, programs,
    opencodeConfigDir: join(dir, 'opencode-config'),
    env: { ...process.env, STANDIN_DIR: dir, FAI_BRIDGE_SECRET: 'never-passed-on', FAI_CLIENT_TOKEN: 'never-either' },
    spawn: (file, args, spawnOptions) => {
      spawned.push({ file, args, options: spawnOptions });
      return spawn(file, args, spawnOptions);
    }, ...options });
  t.after(async () => {
    await runner.close();
    await rm(dir, { recursive: true, force: true });
  });
  const calls = async () => (await readFile(join(dir, 'calls.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean)
    .map(line => JSON.parse(line)).filter(entry => entry.args);
  const grandchildren = async () => (await readFile(join(dir, 'calls.jsonl'), 'utf8').catch(() => '')).split('\n')
    .filter(Boolean).map(line => JSON.parse(line)).filter(entry => entry.grandchild).map(entry => entry.grandchild);
  const setControl = value => writeFile(join(dir, 'control.json'), JSON.stringify(value));
  return { dir, root, store, runner, spawned, calls, grandchildren, setControl };
}

test('chat template: the user\'s words cleaned (line breaks kept), 4,000 characters, inside spec #80\'s template', () => {
  assert.equal(cleanChatText('  one\r\ntwo\u0007​three four  '), 'one\ntwo three four');
  assert.equal(cleanChatText('x'.repeat(5000)).length, 4000);
  assert.equal(cleanChatText(42), '');
  assert.equal(chatTurnText('hi\n"there"'),
    '[FAI Browser] The user sent you a message from the FAI chat panel (the user\'s own words): "hi\\n\\"there\\""');
});

test('a turn: one process with the exact arguments, in the chat\'s files folder, no shell, no window; the transcript', async t => {
  const ctx = await setup(t);
  const { chatId, done } = await ctx.runner.send({ provider: 'claude', text: 'What is on the page?' });
  assert.deepEqual(await done, { chatId, turnId: (await done).turnId, code: null });
  const [call] = await ctx.calls();
  const filesDir = ctx.store.filesDir(chatId);
  assert.equal(await realpath(call.cwd), await realpath(filesDir), 'the working folder is chats/<chatId>/files');
  const expected = turnCommand('claude', { text: chatTurnText('What is on the page?'), filesDir, root: ctx.root,
    server: SERVER, tools: TOOLS, platform: process.platform });
  assert.deepEqual(call.args, expected.args, 'exactly the discovery argument list, and no --model when none was picked');
  assert.ok(!call.args.includes('--model'));
  assert.equal(typeof call.token, 'string', 'the turn token is in the environment');
  assert.deepEqual(call.faiSecret, [], 'none of FAI\'s own variables reach the program');
  const [spawned] = ctx.spawned;
  assert.equal(spawned.options.shell, false);
  assert.equal(spawned.options.windowsHide, true);
  assert.deepEqual(spawned.options.stdio, ['ignore', 'pipe', 'pipe']);

  const { chat, records } = await ctx.store.read(chatId);
  assert.equal(chat.provider, 'claude');
  assert.equal(chat.model, null);
  assert.equal(chat.reportedModel, 'stand-in-model', 'the model the program chose, from its output');
  assert.equal(chat.conversationId, 'conv-claude');
  assert.equal(chat.title, 'What is on the page?');
  assert.deepEqual(records.map(record => [record.id, record.role, record.text]),
    [[1, 'user', 'What is on the page?'], [2, 'agent', 'answer 1 from claude']],
    'messages only: no thinking, tool call, tool result or unknown output');
  assert.deepEqual(records[0].files, []);
  assert.ok(!Number.isNaN(Date.parse(records[1].at)));
});

test('resume by id: the next turn continues the provider\'s conversation, on every provider; a picked model is passed', async t => {
  const ctx = await setup(t);
  for (const [provider, model] of [['claude', 'sonnet'], ['codex', null], ['opencode', 'p/m']]) {
    const first = await ctx.runner.send({ provider, model, text: 'one' });
    await first.done;
    const second = await ctx.runner.send({ chatId: first.chatId, text: 'two' });
    await second.done;
    const calls = (await ctx.calls()).filter(call => call.provider === provider);
    const resume = { claude: ['--resume', 'conv-claude'], codex: ['resume'], opencode: ['--session', 'conv-opencode'] }[provider];
    assert.ok(!calls[0].args.includes(resume.at(-1)), `${provider}: the first turn starts a conversation`);
    for (const arg of resume) assert.ok(calls[1].args.includes(arg), `${provider}: the second continues it (${arg})`);
    if (provider === 'codex') assert.equal(calls[1].args.at(-2), 'conv-codex');
    if (model) assert.equal(calls[1].args[calls[1].args.indexOf(provider === 'claude' ? '--model' : '-m') + 1], model);
    else assert.ok(!calls[1].args.includes('-m'));
    const { records } = await ctx.store.read(first.chatId);
    assert.deepEqual(records.map(record => record.text), ['one', `answer 1 from ${provider}`, 'two', `answer 2 from ${provider}`]);
  }
});

test('limits: one running turn per chat, three in all; the fourth is refused with a fixed line', async t => {
  const ctx = await setup(t, { control: { claude: { mode: 'hang' } } });
  const started = [];
  for (let index = 0; index < 3; index++) started.push(await ctx.runner.send({ provider: 'claude', text: `chat ${index}` }));
  await assert.rejects(ctx.runner.send({ chatId: started[0].chatId, text: 'again' }),
    { code: 'chat_too_many', message: CHAT_CODES.chat_too_many(null, true) });
  await assert.rejects(ctx.runner.send({ provider: 'claude', text: 'a fourth' }),
    { code: 'chat_too_many', message: CHAT_CODES.chat_too_many() });
  assert.equal((await ctx.store.list()).total, 3, 'a refused new chat leaves nothing on disk');
  await ctx.runner.stop(started[0].chatId);
  const next = await ctx.runner.send({ provider: 'claude', text: 'now there is room' });
  assert.ok(next.chatId);
});

test('Stop ends the turn\'s whole process tree and writes Stopped.; the chat continues', async t => {
  const ctx = await setup(t, { control: { claude: { mode: 'hang' } } });
  const { chatId, done } = await ctx.runner.send({ provider: 'claude', text: 'long task' });
  await until(async () => (await ctx.grandchildren()).length === 1);
  const pids = [(await ctx.calls())[0].pid, ...await ctx.grandchildren()];
  assert.ok(pids.every(alive));
  assert.equal(ctx.runner.running(chatId), true);
  assert.equal(await ctx.runner.stop(chatId), true);
  assert.equal((await done).code, 'chat_stopped');
  await until(() => !pids.some(alive));
  assert.equal(ctx.runner.running(chatId), false);
  const { records } = await ctx.store.read(chatId);
  assert.deepEqual(records.at(-1), { ...records.at(-1), role: 'fai', text: 'Stopped.', code: 'chat_stopped' });
  assert.equal(await ctx.runner.stop(chatId), false, 'nothing left to stop');
  await ctx.setControl({});
  const again = await ctx.runner.send({ chatId, text: 'try again' });
  assert.equal((await again.done).code, null);
});

test('the time limit stops a turn that runs too long and leaves no process', async t => {
  const ctx = await setup(t, { control: { codex: { mode: 'hang' } }, turnLimitMs: 400 });
  const { chatId, done } = await ctx.runner.send({ provider: 'codex', text: 'never ends' });
  await until(async () => (await ctx.grandchildren()).length === 1);
  const pids = [(await ctx.calls())[0].pid, ...await ctx.grandchildren()];
  assert.equal((await done).code, 'chat_timed_out');
  await until(() => !pids.some(alive));
  const { records } = await ctx.store.read(chatId);
  assert.equal(records.at(-1).text, CHAT_CODES.chat_timed_out());
});

test('availability: missing, too old, signed out; OpenCode by found and version only; no model for OpenCode', async t => {
  const ctx = await setup(t, { control: { claude: { signedIn: false }, codex: { version: '0.168.0' },
    opencode: { version: '2.3.0' } } });
  const missing = { file: join(ctx.dir, 'no-such-program'), prefix: [] };
  const byProvider = Object.fromEntries((await ctx.runner.providers()).map(item => [item.provider, item]));
  assert.deepEqual(Object.keys(byProvider), ['codex', 'claude', 'opencode'], 'the default order');
  assert.equal(byProvider.claude.code, 'chat_signed_out');
  assert.equal(byProvider.claude.line, CHAT_CODES.chat_signed_out('claude'));
  assert.equal(byProvider.codex.code, 'chat_unsupported_version');
  assert.equal(byProvider.codex.version, '0.168.0');
  assert.equal(byProvider.opencode.code, 'chat_unsupported_version', 'OpenCode 2.x is not supported');
  await assert.rejects(ctx.runner.send({ provider: 'claude', text: 'hi' }), { code: 'chat_signed_out' });
  await assert.rejects(ctx.runner.send({ provider: 'opencode', text: 'hi' }), { code: 'chat_no_model',
    message: CHAT_CODES.chat_no_model() });
  assert.equal((await ctx.store.list()).total, 0, 'a refused turn starts no chat');

  const gone = await setup(t, { programs: { claude: missing, codex: missing, opencode: missing } });
  for (const item of await gone.runner.providers()) {
    assert.equal(item.available, false);
    assert.equal(item.code, 'chat_not_installed');
  }
  await gone.setControl({});

  // OpenCode's status command cannot tell signed in from out: found and supported is available.
  const fine = await setup(t, { control: { opencode: { version: '1.19.5' } } });
  assert.deepEqual(await fine.runner.availability('opencode'),
    { provider: 'opencode', name: 'OpenCode', available: true, version: '1.19.5' });
  assert.ok(!(await fine.calls()).length, 'no turn ran for the checks');
});

test('a program that fails a turn: chat_turn_failed with the exit status and its own error, clipped plain text', async t => {
  const error = `Model <b>refused</b> ${'x'.repeat(1500)}`;
  const ctx = await setup(t, { control: { claude: { mode: 'fail', error }, codex: { mode: 'fail', error: 'model not supported' },
    opencode: { mode: 'stderr', stderr: 'boom on stderr\n' } } });
  const claude = await ctx.runner.send({ provider: 'claude', text: 'hi' });
  assert.equal((await claude.done).code, 'chat_turn_failed');
  const claudeRecords = (await ctx.store.read(claude.chatId)).records;
  assert.deepEqual(claudeRecords.map(record => record.role), ['user', 'fai'], 'the error is not an agent message');
  const failed = claudeRecords.at(-1);
  assert.equal(failed.code, 'chat_turn_failed');
  assert.equal(failed.text, 'Claude ended the turn with exit status 1.');
  assert.equal(failed.providerError, error.slice(0, 1000), 'the program\'s own words, clipped, as text (never parsed as HTML)');

  const codex = await ctx.runner.send({ provider: 'codex', text: 'hi' });
  await codex.done;
  assert.equal((await ctx.store.read(codex.chatId)).records.at(-1).providerError, 'model not supported');

  // A program that writes nothing to stdout (Codex when its sandbox cannot start): its stderr is its error.
  const opencode = await ctx.runner.send({ provider: 'opencode', model: 'p/m', text: 'hi' });
  await opencode.done;
  const last = (await ctx.store.read(opencode.chatId)).records.at(-1);
  assert.equal(last.text, 'OpenCode ended the turn with exit status 1.');
  assert.equal(last.providerError, 'boom on stderr');
  assert.equal(clipProviderError('a\u0000b\u001bc  '), 'abc');
});

test('a program that cannot be started gives chat_start_failed', async t => {
  // Found and checked, then gone before the turn starts.
  const ctx = await setup(t, { spawn: (file, args, options) => spawn(join(tmpdir(), 'fai-chat-vanished-program'), args, options) });
  const { chatId, done } = await ctx.runner.send({ provider: 'claude', text: 'hi' });
  assert.equal((await done).code, 'chat_start_failed');
  assert.equal((await ctx.store.read(chatId)).records.at(-1).text, CHAT_CODES.chat_start_failed('claude'));
});

test('turn token: accepted once, only while its turn runs; unknown or used tokens are refused', async t => {
  const ctx = await setup(t, { control: { opencode: { mode: 'hang' } } });
  const { chatId, turnId, done } = await ctx.runner.send({ provider: 'opencode', model: 'p/m', text: 'hi' });
  await until(async () => (await ctx.calls()).length === 1);
  const [{ token, xdg }] = await ctx.calls();
  assert.equal(xdg, join(ctx.dir, 'opencode-config'), 'OpenCode runs on FAI\'s empty config folder');
  assert.equal(ctx.runner.claimToken('not-a-token'), null);
  assert.deepEqual(ctx.runner.claimToken(token), { chatId, turnId });
  assert.equal(ctx.runner.claimToken(token), null, 'single use');
  await ctx.runner.stop(chatId);
  await done;
  assert.equal(ctx.runner.claimToken(token), null, 'its turn has ended');

  await ctx.setControl({ opencode: { mode: 'hang' } });
  const next = await ctx.runner.send({ chatId, text: 'again' });
  await until(async () => (await ctx.calls()).length === 2);
  const second = (await ctx.calls())[1].token;
  assert.notEqual(second, token, 'a new token per turn');
  await ctx.runner.stop(chatId);
  await next.done;
  assert.equal(ctx.runner.claimToken(second), null, 'never claimed, and its turn ended');
});

test('close stops every running turn (daemon shutdown)', async t => {
  const ctx = await setup(t, { control: { claude: { mode: 'hang' } } });
  const turn = await ctx.runner.send({ provider: 'claude', text: 'hi' });
  await until(async () => (await ctx.calls()).length === 1);
  const [{ pid }] = await ctx.calls();
  await ctx.runner.close();
  assert.equal((await turn.done).code, 'chat_stopped');
  await until(() => !alive(pid));
  await assert.rejects(ctx.runner.send({ provider: 'claude', text: 'late' }), { code: 'chat_start_failed' });
});
