// Setup's closing summary (spec #84 "Setup", acceptance 7's summary line): which providers can start a FAI chat now,
// and the fixed fix line of each that cannot, from the chat runner's own availability check (no second detection).
// Stand-in provider programs. Browserless.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHAT_CODES, chatSummary, createChatRunner } from '../src/chat-runner.js';

const STANDIN = join(import.meta.dirname, 'helpers', 'chat-standin.js');
const ROOT = new URL('../', import.meta.url);

async function summary(t, control, programs = ['claude', 'codex', 'opencode']) {
  const dir = await mkdtemp(join(tmpdir(), 'fai-chat-summary-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'control.json'), JSON.stringify(control));
  const runner = createChatRunner({ env: { ...process.env, STANDIN_DIR: dir },
    programs: Object.fromEntries(programs.map(provider => [provider, { file: process.execPath, prefix: [STANDIN, provider] }])) });
  return chatSummary(await runner.providers());
}

test('setup summary: every provider ready', async t => {
  assert.equal(await summary(t, {}),
    'FAI chats: ChatGPT (Codex), Claude and OpenCode can start a chat now (the Chat button in the browser).');
});

test('setup summary: the ones that cannot each get their fixed fix line', async t => {
  const text = await summary(t, { claude: { signedIn: false }, opencode: { version: '2.3.0' } });
  assert.deepEqual(text.split('\n'), [
    'FAI chats: ChatGPT (Codex) can start a chat now (the Chat button in the browser).',
    `  ${CHAT_CODES.chat_signed_out('claude')}`,
    `  ${CHAT_CODES.chat_unsupported_version('opencode')}`,
  ]);
});

test('setup summary: none ready', async t => {
  const text = await summary(t, { codex: { signedIn: false }, claude: { signedIn: false }, opencode: { version: '0.1.0' } });
  const lines = text.split('\n');
  assert.equal(lines[0], 'FAI chats: no provider can start a chat yet.');
  assert.equal(lines.length, 4);
  assert.equal(lines[1], `  ${CHAT_CODES.chat_signed_out('codex')}`);
});

test('setup prints the summary from the chat runner\'s own check', async () => {
  const setup = await readFile(new URL('scripts/setup.mjs', ROOT), 'utf8');
  assert.match(setup, /console\.log\(chatSummary\(await createChatRunner\(\{\}\)\.providers\(\)\)\)/);
});
