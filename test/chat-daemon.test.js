// FAI chats through the daemon (spec #84, the daemon part of acceptance 9): the panel's `chat` message (as the
// extension sends it through the hub) lists the providers, sends, reads, lists, stops and deletes chats; a chat
// reopens with its transcript after a daemon restart and continues by id; the drawer's list holds every chat on disk,
// most recently active first; Delete removes the chat's folder. Stand-in provider programs. Browserless.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDaemon } from '../src/daemon.js';
import { createFakeHub } from './helpers/fake-hub.js';

const STANDIN = join(import.meta.dirname, 'helpers', 'chat-standin.js');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const programs = Object.fromEntries(['claude', 'codex', 'opencode']
  .map(provider => [provider, { file: process.execPath, prefix: [STANDIN, provider] }]));

async function setup(t) {
  const home = await mkdtemp(join(tmpdir(), 'fai-chat-daemon-'));
  await writeFile(join(home, 'control.json'), '{}');
  t.after(() => rm(home, { recursive: true, force: true }));
  let daemon = null;
  let hub = null;
  const start = async () => {
    hub = createFakeHub();
    daemon = createDaemon({ home, env: { ...process.env, STANDIN_DIR: home }, port: 0, hub, chatPrograms: programs,
      sweepIntervalMs: 60_000 });
    await daemon.listen();
  };
  const stop = async () => {
    await daemon?.close();
    daemon = null;
  };
  t.after(stop);
  await start();
  const chat = (op, args) => hub.emit({ type: 'chat', op, args, browserId: 'browser-1' });
  const calls = async () => (await readFile(join(home, 'calls.jsonl'), 'utf8')).split('\n').filter(Boolean)
    .map(line => JSON.parse(line));
  const settle = async chatId => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const got = await chat('get', { chatId });
      if (!got.running) return got;
      if (Date.now() > deadline) throw new Error('turn did not end');
      await delay(25);
    }
  };
  return { home, chat, calls, settle, start, stop, daemon: () => daemon };
}

test('chat message: providers in order; a turn; the transcript read in full or after an id', async t => {
  const ctx = await setup(t);
  const { providers } = await ctx.chat('providers');
  assert.deepEqual(providers.map(item => [item.provider, item.available]), [['codex', true], ['claude', true], ['opencode', true]]);

  const sent = await ctx.chat('send', { provider: 'codex', text: 'Hello\nthere' });
  assert.match(sent.chatId, /^c[a-f0-9]{20}$/);
  assert.ok(sent.turnId);
  assert.deepEqual(Object.keys(sent).sort(), ['chatId', 'turnId']);
  const done = await ctx.settle(sent.chatId);
  assert.equal(done.running, false);
  assert.equal(done.chat.provider, 'codex');
  assert.equal(done.chat.conversationId, 'conv-codex');
  assert.deepEqual(done.records.map(record => [record.id, record.role, record.text]),
    [[1, 'user', 'Hello\nthere'], [2, 'agent', 'answer 1 from codex']]);
  assert.deepEqual((await ctx.chat('get', { chatId: sent.chatId, after: 1 })).records.map(record => record.id), [2]);
  // The folder is under the daemon's own home (FAI_HOME), and the transcript is there.
  await stat(join(ctx.home, 'FAI-Local-Chats', 'chats', sent.chatId, 'chat.jsonl'));
});

test('chat message: refusals are {error: {code, message}}', async t => {
  const ctx = await setup(t);
  assert.equal((await ctx.chat('nope', {})).error.code, 'bad_request');
  assert.equal((await ctx.chat('get', { chatId: '../../etc' })).error.code, 'unknown_chat');
  assert.equal((await ctx.chat('get', { chatId: 'c0123456789abcdef0123' })).error.code, 'unknown_chat');
  assert.equal((await ctx.chat('send', { provider: 'opencode', text: 'hi' })).error.code, 'chat_no_model');
  assert.equal((await ctx.chat('send', { provider: 'claude', text: '   ' })).error.code, 'bad_request');
  assert.equal((await ctx.chat('send', { provider: 'other', text: 'hi' })).error.code, 'bad_request');
  assert.equal((await ctx.chat('send', { provider: 'claude', text: 42 })).error.code, 'bad_request');
  assert.equal((await ctx.chat('list', { limit: 'all' })).error.code, 'bad_request');
  assert.deepEqual(await ctx.chat('stop', { chatId: 'c0123456789abcdef0123' }), { stopped: false });
});

test('stored chats: listed most recently active first, 50 at a time; reopened after a restart and continued by id; deleted', async t => {
  const ctx = await setup(t);
  const first = await ctx.chat('send', { provider: 'claude', model: 'sonnet', text: 'First chat about invoices' });
  await ctx.settle(first.chatId);
  await delay(30);
  const second = await ctx.chat('send', { provider: 'opencode', model: 'p/m', text: 'Second chat' });
  await ctx.settle(second.chatId);

  let listed = await ctx.chat('list', {});
  assert.equal(listed.total, 2);
  assert.deepEqual(listed.chats.map(chat => chat.chatId), [second.chatId, first.chatId]);
  assert.deepEqual(listed.chats[1], { ...listed.chats[1], provider: 'claude', model: 'sonnet', title: 'First chat about invoices',
    running: false });
  assert.deepEqual((await ctx.chat('list', { offset: 1, limit: 1 })).chats.map(chat => chat.chatId), [first.chatId]);

  // The daemon restarts: the chat is still there and its next turn continues the provider's conversation.
  await ctx.stop();
  await ctx.start();
  const reopened = await ctx.chat('get', { chatId: first.chatId });
  assert.deepEqual(reopened.records.map(record => record.text), ['First chat about invoices', 'answer 1 from claude']);
  await delay(30);
  const next = await ctx.chat('send', { chatId: first.chatId, text: 'And the second one?' });
  assert.equal(next.chatId, first.chatId);
  const continued = await ctx.settle(first.chatId);
  assert.equal(continued.records.at(-1).text, 'answer 2 from claude');
  const lastCall = (await ctx.calls()).filter(call => call.args).at(-1);
  assert.deepEqual(lastCall.args.slice(lastCall.args.indexOf('--resume'), lastCall.args.indexOf('--resume') + 2),
    ['--resume', 'conv-claude']);
  assert.equal(lastCall.args[lastCall.args.indexOf('--model') + 1], 'sonnet', 'a chat keeps its model');
  listed = await ctx.chat('list', {});
  assert.deepEqual(listed.chats.map(chat => chat.chatId), [first.chatId, second.chatId], 'activity reorders the list');

  assert.deepEqual(await ctx.chat('delete', { chatId: second.chatId }), { deleted: true });
  await assert.rejects(stat(join(ctx.home, 'FAI-Local-Chats', 'chats', second.chatId)), { code: 'ENOENT' });
  assert.deepEqual((await ctx.chat('list', {})).chats.map(chat => chat.chatId), [first.chatId]);
  assert.equal((await ctx.chat('get', { chatId: second.chatId })).error.code, 'unknown_chat');
});

test('stop through the chat message; delete stops a running turn first; shutdown stops running turns', async t => {
  const ctx = await setup(t);
  await writeFile(join(ctx.home, 'control.json'), JSON.stringify({ claude: { mode: 'hang' } }));
  const one = await ctx.chat('send', { provider: 'claude', text: 'long' });
  assert.equal((await ctx.chat('get', { chatId: one.chatId })).running, true);
  assert.equal((await ctx.chat('list', {})).chats[0].running, true);
  assert.deepEqual(await ctx.chat('stop', { chatId: one.chatId }), { stopped: true });
  const stopped = await ctx.chat('get', { chatId: one.chatId });
  assert.equal(stopped.running, false);
  assert.equal(stopped.records.at(-1).text, 'Stopped.');

  const two = await ctx.chat('send', { provider: 'claude', text: 'long too' });
  assert.deepEqual(await ctx.chat('delete', { chatId: two.chatId }), { deleted: true });

  const three = await ctx.chat('send', { provider: 'claude', text: 'still running at shutdown' });
  await ctx.stop();
  const transcript = await readFile(join(ctx.home, 'FAI-Local-Chats', 'chats', three.chatId, 'chat.jsonl'), 'utf8');
  assert.equal(JSON.parse(transcript.trim().split('\n').at(-1)).code, 'chat_stopped');
});
