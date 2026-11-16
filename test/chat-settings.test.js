// Browser Chat settings (spec #84 "Browser Chat settings", acceptance 8): FAI's own file in FAI's settings directory,
// defaults (no provider pick, each program's own model, the system's appearance), partial updates, validation, and a
// hand-edited bad value that does not lose the rest. Browserless.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChatSettings, defaultChatSettings, mergeChatSettings } from '../src/chat-settings.js';

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'fai-chat-settings-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, file: join(dir, 'settings', 'chat-settings.json') };
}

test('defaults, partial updates, and a saved file another daemon reads back', async t => {
  const ctx = await setup(t);
  const settings = createChatSettings({ file: ctx.file });
  assert.deepEqual(await settings.get(), { defaultProvider: null, models: { codex: null, claude: null, opencode: null },
    appearance: 'system' });
  await settings.set({ models: { opencode: ' ollama-cloud/deepseek-v4.1-flash:1017 ' } });
  const saved = await settings.set({ defaultProvider: 'claude', appearance: 'dark', models: { claude: 'opus' } });
  assert.deepEqual(saved, { defaultProvider: 'claude', models: { codex: null, claude: 'opus',
    opencode: 'ollama-cloud/deepseek-v4.1-flash:1017' }, appearance: 'dark' });
  assert.deepEqual(await createChatSettings({ file: ctx.file }).get(), saved);
  assert.deepEqual(JSON.parse(await readFile(ctx.file, 'utf8')), saved);
  assert.deepEqual((await settings.set({ models: { claude: '' } })).models.claude, null, 'empty: the program\'s own default');
  assert.deepEqual(await readdir(join(ctx.dir, 'settings')), ['chat-settings.json'], 'no temporary file left behind');
});

test('only known settings and plain values are taken; a refused update changes nothing', async t => {
  const ctx = await setup(t);
  const settings = createChatSettings({ file: ctx.file });
  for (const bad of [null, [], 'x', { defaultProvider: 'gemini' }, { appearance: 'blue' }, { models: { gemini: 'x' } },
    { models: { codex: '-m' } }, { models: { codex: 'a\nb' } }, { models: { codex: 'x'.repeat(201) } }, { models: { codex: 3 } },
    { models: [] }, { theme: 'dark' }]) {
    await assert.rejects(settings.set(bad), { code: 'bad_request' }, JSON.stringify(bad));
  }
  assert.deepEqual(await settings.get(), defaultChatSettings());
  assert.deepEqual(mergeChatSettings(defaultChatSettings(), { defaultProvider: null }).defaultProvider, null);
});

test('a hand-edited file: each bad field falls back alone; a broken file gives the defaults', async t => {
  const ctx = await setup(t);
  await createChatSettings({ file: ctx.file }).set({ appearance: 'light' });
  await writeFile(ctx.file, JSON.stringify({ defaultProvider: 'nope', appearance: 'light', models: { claude: 'sonnet', codex: '-x' },
    extra: 1 }));
  assert.deepEqual(await createChatSettings({ file: ctx.file }).get(), { defaultProvider: null,
    models: { codex: null, claude: null, opencode: null }, appearance: 'light' });
  await writeFile(ctx.file, '{not json');
  assert.deepEqual(await createChatSettings({ file: ctx.file }).get(), defaultChatSettings());
});
