// One chat cleaner (Planner rulings, Sprint 3 messages 206 and 218; decision #41): the same input gives the same text
// from src/wake.js cleanChatText (open agents' chat wakes), the FAI chat runner (src/chat-runner.js: the transcript's
// user line and the turn's template), and the panel's copy (extension/chat-view.js cleanChatText, which matches a
// sent message against what the host wrote). A later change to one of them that the others do not follow brings a
// doubled message back; this test fails first. The daemon-level check of both delivery paths is in
// test/chat-binding.test.js. Browserless.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChatRunner } from '../src/chat-runner.js';
import { createChatStore } from '../src/chat-store.js';
import { cleanChatText, wakeText } from '../src/wake.js';

const STANDIN = join(import.meta.dirname, 'helpers', 'chat-standin.js');
const PANEL = new URL('../extension/chat-view.js', import.meta.url);
// The panel's copy arrives with the chat panel (PR #81, Sprint 3 WU #14): from then on this test always covers it.
const panel = existsSync(PANEL) ? await import(PANEL) : null;

// Every rule of the cleaner: CRLF and CR, U+2028 and U+2029, zero-width and direction characters, C0 and C1 controls,
// tabs, runs of spaces within a line, blank lines kept, edges trimmed, quotes and backslashes, non-Latin text.
const INPUTS = [
  'plain words',
  '  Pay the bill\r\nnow\rplease  ',
  'two   spaces\tand a tab ‮evil‬ "quoted" \\ back',
  'zero​width﻿⁠joined\u0085next\u009bline\n\n\nend',
  '\u0000nul\u0007bell\u001b[31mred\u007f  nbsp　ideographic',
  'Привет, 世界 \u{1F600}\n  indented line\t\n',
  ' ​\n\t ',
];

async function runnerTexts(t) {
  const dir = await mkdtemp(join(tmpdir(), 'fai-chat-parity-'));
  await writeFile(join(dir, 'control.json'), '{}');
  const root = join(dir, 'FAI-Local-Chats');
  const store = createChatStore({ root });
  const runner = createChatRunner({ store, root, server: { command: process.execPath, args: ['/fai/src/mcp-main.js'] },
    tools: ['fai_browser_open'], opencodeConfigDir: join(dir, 'opencode-config'), env: { ...process.env, STANDIN_DIR: dir },
    programs: { claude: { file: process.execPath, prefix: [STANDIN, 'claude'] } } });
  // One cleanup, in order (t.after hooks run in the order added): the runner, then its folder.
  t.after(async () => {
    await runner.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  const out = [];
  for (const input of INPUTS) {
    let sent;
    try {
      sent = await runner.send({ provider: 'claude', text: input });
    } catch (error) {
      // Nothing left after cleaning: refused, nothing written or started.
      out.push({ input, refused: error.code });
      continue;
    }
    await sent.done;
    const calls = (await readFile(join(dir, 'calls.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))
      .filter(entry => entry.args);
    const { records } = await store.read(sent.chatId);
    const args = calls.at(-1).args;
    out.push({ input, transcript: records.find(record => record.role === 'user').text, turn: args[args.indexOf('-p') + 1] });
  }
  return out;
}

test('parity: the FAI chat runner cleans and wraps exactly as src/wake.js does', async t => {
  for (const { input, refused, transcript, turn } of await runnerTexts(t)) {
    const clean = cleanChatText(input);
    if (refused) {
      assert.equal(clean, '', `refused only when nothing is left: ${JSON.stringify(input)}`);
      assert.equal(refused, 'bad_request');
      continue;
    }
    assert.equal(transcript, clean, JSON.stringify(input));
    assert.equal(turn, wakeText({ kind: 'chat', userText: input }), JSON.stringify(input));
  }
});

test('parity: the panel\'s copy of the cleaner gives the same text', { skip: panel ? false
  : 'extension/chat-view.js arrives with the chat panel (PR #81, WU #14)' }, () => {
  assert.equal(typeof panel.cleanChatText, 'function', 'the panel keeps a cleanChatText');
  for (const input of [...INPUTS, 42, null]) {
    assert.equal(panel.cleanChatText(input), cleanChatText(input), JSON.stringify(input));
  }
});
