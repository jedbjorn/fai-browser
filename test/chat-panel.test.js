// The chat panel (extension/panel.html; spec #84 "Panel" with spec #80's view of an open agent inside it): its rules
// (extension/chat-view.js), its manifests, and the panel itself in headless Chromium against a fake FAI service
// (test/helpers/chat-panel-fake.js): first open, no provider, OpenCode only, sending and Stop, stored chats and the
// drawer, Delete, attachments, failed turns, open agents, themes, WCAG AA contrast and the keyboard.
// The Firefox side is test/firefox-panel.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { headlessEnv } from '../scripts/headless-env.mjs';
import { firefoxManifest } from '../scripts/build-firefox.mjs';
import {
  agentBlockedLine, cleanChatText, composerProblem, defaultAgent, defaultProvider, faiLine, MAX_TEXT, needsOpenCodeModel, readableLine, reasonLine,
  unmatchedPending,
} from '../extension/chat-view.js';
import {
  ALL_PROVIDERS, CLAUDE_AGENT, CODEX_AGENT, CONVERSATION, MODELS, NO_PROVIDERS, PNG, STORED_CHATS, installFakeChrome,
  panelPage, scenarios,
} from './helpers/chat-panel-fake.js';
import { contrastFailures, namedControls } from './helpers/panel-checks.js';

const SETTINGS = { defaultProvider: null, models: { codex: null, claude: null, opencode: null }, appearance: 'system' };
const BASE = { providers: ALL_PROVIDERS, models: MODELS, chats: STORED_CHATS, transcripts: { chat_a: CONVERSATION, chat_b: [], chat_c: [] },
  agents: [CLAUDE_AGENT, CODEX_AGENT], settings: SETTINGS };

// --- rules ----------------------------------------------------------------------------------------------------------

test('a new chat takes Codex, then Claude, then OpenCode, or the user default when it is available', () => {
  assert.equal(defaultProvider(ALL_PROVIDERS, SETTINGS), 'codex');
  const noCodex = ALL_PROVIDERS.map(item => item.provider === 'codex' ? { ...item, available: false } : item);
  assert.equal(defaultProvider(noCodex, SETTINGS), 'claude');
  assert.equal(defaultProvider([...ALL_PROVIDERS].reverse(), SETTINGS), 'codex', 'order is FAI\'s, not the list\'s');
  assert.equal(defaultProvider(ALL_PROVIDERS, { ...SETTINGS, defaultProvider: 'opencode' }), 'opencode');
  assert.equal(defaultProvider(noCodex, { ...SETTINGS, defaultProvider: 'codex' }), 'claude', 'an unavailable default is skipped');
  assert.equal(defaultProvider(NO_PROVIDERS, SETTINGS), null);
  const openCodeOnly = [NO_PROVIDERS[0], NO_PROVIDERS[1], ALL_PROVIDERS[2]];
  assert.equal(needsOpenCodeModel(openCodeOnly, SETTINGS), true);
  assert.equal(needsOpenCodeModel(openCodeOnly, { ...SETTINGS, models: { opencode: 'ollama-cloud/x' } }), false);
  assert.equal(needsOpenCodeModel(ALL_PROVIDERS, SETTINGS), false);
});

test('the open agent chosen by default: the owner of a task tab in this window, else the only live session', () => {
  const task = { requestId: 'r1', state: 'active', lease: { tabId: 7 }, owner: { sessionId: 'ses_2' } };
  assert.deepEqual(defaultAgent([CLAUDE_AGENT, CODEX_AGENT], [task], [7, 8]), { sessionId: 'ses_2', why: 'task' });
  assert.equal(defaultAgent([CLAUDE_AGENT, CODEX_AGENT], [task], [9]), null, 'a task tab in another window does not count');
  assert.equal(defaultAgent([CLAUDE_AGENT, CODEX_AGENT], [{ ...task, state: 'pending' }], [7]), null);
  assert.deepEqual(defaultAgent([CLAUDE_AGENT], [], [7]), { sessionId: 'ses_1', why: 'only' });
  assert.equal(defaultAgent([], [task], [7]), null);
});

test('a turn\'s reason codes have fixed lines; provider fix lines and unknown codes are the service\'s own', () => {
  const codes = ['chat_no_model', 'chat_start_failed', 'chat_stopped', 'chat_timed_out', 'chat_too_many', 'chat_turn_failed'];
  const lines = codes.map(code => reasonLine(code, 'claude', { exit: 2 }));
  assert.equal(new Set(lines).size, codes.length);
  assert.equal(reasonLine('chat_stopped', 'codex'), 'Stopped.');
  assert.equal(reasonLine('chat_turn_failed', 'codex', { exit: 1 }), 'Codex could not finish this turn (exit 1).');
  // The availability fix lines come from chat_providers' `line` (contract amendment 1): the panel writes none.
  for (const code of ['chat_not_installed', 'chat_signed_out', 'chat_unsupported_version', 'unknown_chat', '<b>made up</b>']) {
    assert.equal(reasonLine(code, 'codex'), null, code);
  }
  assert.equal(readableLine(true, CLAUDE_AGENT), null);
  assert.deepEqual(readableLine({ code: 'unreadable', host: 'codex', version: '0.169.0' }, CLAUDE_AGENT),
    { text: 'Can\'t read this conversation (Codex 0.169.0). Messages you send still reach the agent.', blocks: false });
  assert.equal(readableLine({ code: 'not_ready' }, CODEX_AGENT).blocks, true);
  assert.equal(readableLine({ code: 'ambiguous_session', host: 'opencode' }, CODEX_AGENT).blocks, true);
  assert.equal(faiLine('[FAI Browser] Approved tab request r12.\nMore'), 'FAI: Approved tab request r12.');
  assert.equal(agentBlockedLine(CODEX_AGENT), 'This agent is not ready yet. Ask it to run any FAI command.');
  assert.equal(agentBlockedLine(CLAUDE_AGENT), null);
  assert.match(agentBlockedLine({ ...CLAUDE_AGENT, wake: 'none', wakeReason: 'claude_no_messaging' }), /messaging enabled/);
});

test('the composer refuses over 4,000 characters, more than 10 files and a file over 25 MB', () => {
  assert.equal(composerProblem('x'.repeat(MAX_TEXT)), null);
  assert.match(composerProblem('x'.repeat(MAX_TEXT + 1)), /limited to 4,000 characters \(this one has 4,001\)/);
  assert.match(composerProblem('hi', Array.from({ length: 11 }, (_, i) => ({ name: `f${i}`, size: 1 }))), /up to 10 files/);
  assert.equal(composerProblem('hi', Array.from({ length: 10 }, (_, i) => ({ name: `f${i}`, size: 25 * 1024 * 1024 }))), null);
  assert.match(composerProblem('hi', [{ name: 'big.mov', size: 25 * 1024 * 1024 + 1 }]), /big\.mov is larger than 25 MB/);
});

test('a message sent to an open agent shows once: the pending copy goes when the host writes it', () => {
  const before = new Set(['old']);
  const pending = [{ key: 'p1', text: 'go on', state: 'sent', before }, { key: 'p2', text: 'and then', state: 'sending', before }];
  const keys = messages => unmatchedPending(pending, messages).map(item => item.key);
  assert.deepEqual(keys([{ id: 'a', role: 'agent', text: 'go on' }]), ['p1', 'p2']);
  assert.deepEqual(keys([{ id: 'a', role: 'user', text: 'go on' }]), ['p2']);
  assert.deepEqual(keys([{ id: 'a', role: 'user', text: 'and then' }]), ['p1', 'p2'], 'a message still sending is kept');
  // The host writes the service's cleaned text: spaces and tabs run together, zero-width characters go.
  const typed = [{ key: 'p3', text: 'Go to settings.  Then\tclick\u200b Save.\r\n  next', state: 'sent', before }];
  assert.deepEqual(unmatchedPending(typed, [{ id: 'a', role: 'user', text: 'Go to settings. Then click Save.\n next' }]), []);
  // A message with the same words that was there before this one was sent is not its copy.
  assert.deepEqual(keys([{ id: 'old', role: 'user', text: 'go on' }]), ['p1', 'p2']);
});

test('the panel cleans a message the way the service does', () => {
  assert.equal(cleanChatText('  a \t b\u200b\u2028c\u0007d  '), 'a b\nc d');
  assert.equal(cleanChatText(null), '');
});

test('manifests: Chrome\'s side panel and Firefox\'s sidebar are panel.html', async () => {
  const chrome = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  assert.equal(chrome.side_panel.default_path, 'panel.html');
  assert.ok(chrome.permissions.includes('sidePanel'));
  const firefox = firefoxManifest(chrome);
  assert.equal(firefox.sidebar_action.default_panel, 'panel.html');
  assert.equal(firefox.sidebar_action.open_at_install, false);
  assert.equal(firefox.side_panel, undefined);
  assert.ok(!firefox.permissions.includes('sidePanel'));
});

test('the page shown after install names the Chat button as the way to start', async () => {
  const welcome = await readFile(new URL('../src/launcher/welcome.html', import.meta.url), 'utf8');
  assert.match(welcome, /<h2 id="chat-title">Start a chat<\/h2>/);
  assert.match(welcome, /then <b>Chat<\/b>\. The chat panel opens beside the page/);
});

test('the dark palette is the same whether forced by Appearance or taken from the system', async () => {
  const css = await readFile(new URL('../extension/panel.css', import.meta.url), 'utf8');
  const block = selector => css.slice(css.indexOf(selector)).match(/\{([^}]*)\}/)[1].replace(/\s+/g, ' ').trim();
  assert.equal(block(':root:not([data-theme="light"])'), block(':root[data-theme="dark"]'));
});

// --- the panel in Chromium ------------------------------------------------------------------------------------------

let browser;
test.before(async () => {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true,
    env: headlessEnv(), args: ['--no-sandbox'] });
});
test.after(() => browser?.close());

async function open(t, scenario, options) {
  const page = await panelPage(browser, { ...BASE, ...scenario }, options);
  t.after(() => page.close());
  return page;
}
const sent = (page, type) => page.evaluate(kind => globalThis.__sent.filter(message => message.type === kind), type);
const texts = page => page.locator('#messages li').allTextContents();

async function openFromDrawer(page, chatId) {
  if (await page.locator('#drawer').isHidden()) await page.click('#drawer-toggle');
  await page.click(`[data-chat-id="${chatId}"]`);
  await page.waitForSelector('#messages li');
}

test('first open: an empty new chat on Codex with the cursor in the composer; a message starts a turn', async t => {
  const page = await open(t, { reply: 'Two listings: 32 GB and 16 GB.', replyMs: 400 });
  assert.equal(await page.textContent('#title'), 'New chat');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'text');
  assert.equal(await page.inputValue('[aria-label="Provider for this chat"]'), 'codex');
  assert.equal(await page.inputValue('[aria-label="Model for this chat"]'), '', 'no model unless one is picked');
  await page.fill('#text', 'Which listing has more memory?');
  await page.keyboard.press('Enter');
  // While the turn runs: Browsing…, the composer disabled, Stop instead of Send.
  await page.waitForSelector('#stop:not([hidden])');
  assert.equal(await page.isVisible('#send'), false);
  assert.equal(await page.isDisabled('#text'), true);
  assert.equal(await page.isVisible('#browsing'), true);
  const [body] = await sent(page, 'chat_send');
  assert.deepEqual(body, { type: 'chat_send', provider: 'codex', model: null, text: 'Which listing has more memory?', files: [] });
  await page.waitForSelector('#send:not([hidden])');
  assert.equal(await page.isVisible('#stop'), false);
  assert.equal(await page.isVisible('#browsing'), false);
  assert.deepEqual(await texts(page), ['Which listing has more memory?', 'CodexTwo listings: 32 GB and 16 GB.']);
  assert.equal(await page.textContent('#title'), 'Which listing has more memory?');
});

test('a picked provider and model reach the turn; the user default provider opens first', async t => {
  const page = await open(t, { settings: { ...SETTINGS, defaultProvider: 'claude', models: { codex: null, claude: 'sonnet', opencode: null } } });
  assert.equal(await page.inputValue('[aria-label="Provider for this chat"]'), 'claude');
  await page.waitForSelector('[aria-label="Model for this chat"] option[value="opus"]', { state: 'attached' });
  assert.equal(await page.inputValue('[aria-label="Model for this chat"]'), 'sonnet');
  await page.selectOption('[aria-label="Model for this chat"]', 'opus');
  await page.fill('#text', 'hello');
  await page.click('#send');
  await page.waitForFunction(() => globalThis.__sent.some(message => message.type === 'chat_send'));
  const [body] = await sent(page, 'chat_send');
  assert.equal(body.provider, 'claude');
  assert.equal(body.model, 'opus');
});

test('no provider available: the three providers with their fix lines, and the open agents', async t => {
  const page = await open(t, { providers: NO_PROVIDERS });
  const empty = await page.textContent('#empty');
  assert.match(empty, /No chat provider is ready/);
  // Each provider's name and fix line are the service's, as is.
  for (const provider of NO_PROVIDERS) assert.ok(empty.includes(`${provider.name}${provider.line}`), provider.provider);
  assert.match(empty, /Claude Code · fai-browser/);
  assert.equal(await page.isVisible('#composer'), false);
  await page.click('#empty [data-session-id="ses_1"]');
  await page.waitForFunction(() => document.getElementById('title').textContent === 'Claude Code · fai-browser');
});

test('OpenCode only: New chat opens settings on OpenCode\'s model list, and a pick is saved', async t => {
  const page = await open(t, { providers: [NO_PROVIDERS[0], NO_PROVIDERS[1], ALL_PROVIDERS[2]] });
  await page.waitForSelector('#settings:not([hidden])');
  await page.waitForFunction(() => document.activeElement?.dataset?.modelProvider === 'opencode');
  assert.match(await page.textContent('#settings'), /OpenCode needs a model to chat/);
  await page.selectOption('[data-model-provider="opencode"]', 'ollama-cloud/deepseek-v4.1-flash-1017');
  await page.waitForFunction(() => globalThis.__sent.some(message => message.type === 'chat_settings_set'));
  const [saved] = await sent(page, 'chat_settings_set');
  assert.equal(saved.settings.models.opencode, 'ollama-cloud/deepseek-v4.1-flash-1017');
  assert.equal(saved.settings.models.codex, null, 'nothing else is set');
  await page.keyboard.press('Escape');
  await page.waitForSelector('#settings', { state: 'hidden' });
  await page.click('#drawer-toggle');
  await page.click('#new-chat');
  assert.equal(await page.inputValue('[aria-label="Provider for this chat"]'), 'opencode');
  assert.equal(await page.isVisible('#settings'), false, 'with a model set, New chat opens the chat');
});

test('settings: model lists read live, a typed name when listing fails, and no provider file is written', async t => {
  const page = await open(t, { models: { claude: MODELS.claude } });
  await page.click('#drawer-toggle');
  await page.click('#open-settings');
  await page.waitForFunction(() => document.activeElement?.id === 'settings-title');
  const lists = [...new Set((await sent(page, 'chat_models')).map(message => message.provider))].sort();
  assert.deepEqual(lists, ['claude', 'codex', 'opencode']);
  const claude = await page.locator('[data-model-provider="claude"] option').allTextContents();
  assert.deepEqual(claude, ['Claude\'s own default', 'opus', 'sonnet', 'fable', 'haiku', 'Another model (type its name)']);
  // Codex did not list: its picker is a text field.
  assert.equal(await page.getAttribute('[data-model-provider="codex"]', 'type'), 'text');
  assert.match(await page.textContent('#settings'), /Codex did not list its models\. Type a model name\./);
  await page.fill('[data-model-provider="codex"]', 'gpt-5.5-sol');
  await page.keyboard.press('Tab');
  await page.waitForFunction(() => globalThis.__sent.some(message => message.type === 'chat_settings_set'));
  assert.equal((await sent(page, 'chat_settings_set')).at(-1).settings.models.codex, 'gpt-5.5-sol');
  // Every call went to the service; the panel has no other route (and the service never writes provider files).
  const types = new Set((await page.evaluate(() => globalThis.__sent)).map(message => message.type));
  assert.ok([...types].every(type => ['state', 'agents', 'chat_providers', 'chat_settings', 'chat_list', 'chat_models', 'chat_settings_set'].includes(type)));
});

test('the drawer: chats most recent first, 50 at a time, open one, and Delete after a confirmation', async t => {
  const many = Array.from({ length: 60 }, (_, i) => ({ chatId: `c${i}`, title: `Chat ${i}`, provider: 'codex',
    lastActiveAt: new Date(Date.now() - i * 60_000).toISOString() }));
  const page = await open(t, { chats: [...many.slice(30), ...many.slice(0, 30)], transcripts: { c0: CONVERSATION } });
  await page.click('#drawer-toggle');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'new-chat', 'focus moves into the drawer');
  await page.waitForFunction(() => document.querySelectorAll('#chat-list li').length === 50);
  const titles = await page.locator('#chat-list .drawer-open-title').allTextContents();
  assert.deepEqual(titles.slice(0, 3), ['Chat 0', 'Chat 1', 'Chat 2']);
  await page.click('#more-chats');
  await page.waitForFunction(() => document.querySelectorAll('#chat-list li').length === 60);
  assert.equal(await page.isVisible('#more-chats'), false);
  // Escape closes it and focus returns to the menu button.
  await page.keyboard.press('Escape');
  assert.equal(await page.isVisible('#drawer'), false);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'drawer-toggle');

  await openFromDrawer(page, 'c0');
  assert.equal(await page.textContent('#title'), 'Chat 0');
  assert.equal((await texts(page)).length, CONVERSATION.length);

  await page.click('#drawer-toggle');
  await page.click('[data-chat-id="c1"] + .drawer-delete');
  assert.equal(await page.isVisible('#confirm'), true);
  assert.match(await page.textContent('#confirm-text'), /Codex keeps its own copy of the conversation; FAI does not remove it\./);
  await page.click('#confirm-cancel');
  assert.equal((await sent(page, 'chat_delete')).length, 0);
  await page.click('[data-chat-id="c1"] + .drawer-delete');
  await page.click('#confirm-delete');
  await page.waitForFunction(() => !document.querySelector('[data-chat-id="c1"]'));
  assert.deepEqual((await sent(page, 'chat_delete')).map(message => message.chatId), ['c1']);
});

test('everything is text: markup in a reply stays text, and a provider\'s own error is shown clipped and marked', async t => {
  const failure = { id: 'f1', role: 'fai', code: 'chat_turn_failed', exit: 1, providerText: `<img src=x onerror="globalThis.__pwned=1">${'e'.repeat(1200)}`, at: new Date().toISOString() };
  const page = await open(t, { transcripts: { chat_a: [...CONVERSATION,
    { id: 'x1', role: 'agent', text: '<b>bold</b> <a href="https://evil.example">link</a>', at: new Date().toISOString() }, failure] } });
  await openFromDrawer(page, 'chat_a');
  assert.equal(await page.locator('#messages img, #messages a, #messages b').count(), 0);
  assert.match(await page.textContent('#messages'), /<b>bold<\/b> <a href="https:\/\/evil\.example">link<\/a>/);
  assert.match(await page.textContent('[data-kind="error"]'), /^Codex could not finish this turn \(exit 1\)\.Codex said:/);
  assert.equal((await page.textContent('.provider-said')).length, 1000);
  assert.equal(await page.evaluate(() => globalThis.__pwned), undefined);
  assert.equal(await page.isEnabled('#text'), true, 'the chat stays usable');
});

test('a refused turn shows FAI\'s line and the chat stays usable; Stop ends a running turn', async t => {
  const page = await open(t, { sendError: { code: 'chat_too_many', message: 'busy' } });
  await page.fill('#text', 'hi');
  await page.click('#send');
  await page.waitForSelector('#composer-error:not([hidden])');
  assert.equal(await page.textContent('#composer-error'), 'Three chats are already running. Wait for one to finish, or stop one.');
  assert.equal(await page.inputValue('#text'), 'hi', 'the text is kept');

  const running = await open(t, { stuck: true });
  await running.fill('#text', 'long task');
  await running.click('#send');
  await running.waitForSelector('#stop:not([hidden])');
  await running.click('#stop');
  await running.waitForSelector('#send:not([hidden])');
  assert.equal((await sent(running, 'chat_stop')).length, 1);
  assert.equal((await texts(running)).at(-1), 'Stopped.');
  assert.equal(await running.isEnabled('#text'), true);
});

test('attachments: chips with names and image previews, the hint line, uploads before the turn, and the limits', async t => {
  const page = await open(t, {});
  assert.equal(await page.isVisible('#attach-hint'), false);
  await page.setInputFiles('#file-input', [
    { name: 'shot.png', mimeType: 'image/png', buffer: PNG },
    { name: 'notes.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') },
  ]);
  assert.deepEqual(await page.locator('#chips .chip-name').allTextContents(), ['shot.png', 'notes.pdf']);
  assert.equal(await page.locator('#chips img.chip-preview').count(), 1);
  assert.equal(await page.textContent('#attach-hint'), 'Attached files go to Codex\'s service under your account, like your message.');
  assert.equal(await page.isVisible('#attach-hint'), true);
  await page.click('[aria-label="Remove notes.pdf"]');
  assert.deepEqual(await page.locator('#chips .chip-name').allTextContents(), ['shot.png']);
  await page.fill('#text', 'What is in this screenshot?');
  await page.click('#send');
  await page.waitForSelector('#messages .message-files');
  const [file] = await sent(page, 'chat_file');
  assert.deepEqual({ ...file, data: undefined }, { type: 'chat_file', chatId: null, name: 'shot.png', mime: 'image/png', size: PNG.length, data: undefined });
  assert.equal(Buffer.from(file.data, 'base64').equals(PNG), true);
  assert.deepEqual((await sent(page, 'chat_send'))[0].files, ['file_1']);
  assert.equal(await page.locator('#messages .message-files img').count(), 1, 'the sent image keeps its preview');
  assert.equal(await page.isVisible('#chips'), false);

  await page.setInputFiles('#file-input', Array.from({ length: 11 }, (_, i) => ({ name: `f${i}.txt`, mimeType: 'text/plain', buffer: Buffer.from('x') })));
  assert.equal(await page.textContent('#composer-error'), 'Attach up to 10 files per message.');
  assert.equal(await page.locator('#chips li').count(), 10);
});

test('a file over 25 MB is refused before it is sent', async t => {
  const page = await open(t, {});
  // Moving 25 MB into the page takes longer than the 4 s page default on a CI runner.
  await page.setInputFiles('#file-input', [{ name: 'movie.mov', mimeType: 'video/quicktime', buffer: Buffer.alloc(25 * 1024 * 1024 + 1) }],
    { timeout: 60_000 });
  assert.equal(await page.textContent('#composer-error'), 'movie.mov is larger than 25 MB.');
  assert.equal(await page.locator('#chips li').count(), 0);
});

test('a resent draft reuses the files already uploaded, and uploads again only when the service no longer has them', async t => {
  const page = await open(t, { sendError: { code: 'chat_too_many', message: 'Too many chats are running.' } });
  await page.setInputFiles('#file-input', [{ name: 'shot.png', mimeType: 'image/png', buffer: PNG }]);
  await page.fill('#text', 'What is in this screenshot?');
  await page.click('#send');
  await page.waitForSelector('#composer-error:not([hidden])');
  await page.click('#send');
  await page.waitForFunction(() => globalThis.__sent.filter(message => message.type === 'chat_send').length === 2);
  await page.waitForSelector('#send:not([disabled])');
  assert.equal((await sent(page, 'chat_file')).length, 1, 'one upload for two refused sends');
  assert.deepEqual((await sent(page, 'chat_send')).map(message => message.files), [['file_1'], ['file_1']]);
  // The service lost the file: chat_send answers unknown_file, and the draft's file goes up again once.
  await page.evaluate(() => { globalThis.__scenario.sendError = null; globalThis.__fake.forgetFiles(); });
  await page.click('#send');
  await page.waitForSelector('#messages .message-files');
  assert.equal((await sent(page, 'chat_file')).length, 2);
  assert.deepEqual((await sent(page, 'chat_send')).map(message => message.files).slice(2), [['file_1'], ['file_2']]);
  assert.equal(await page.isVisible('#composer-error'), false);
});

test('a message goes to the chat it was written in, even when another chat is opened while its file uploads', async t => {
  const page = await open(t, { delays: { chat_file: 600 }, stuck: true });
  await page.setInputFiles('#file-input', [{ name: 'shot.png', mimeType: 'image/png', buffer: PNG }]);
  await page.fill('#text', 'What is in this screenshot?');
  await page.click('#send');
  await page.click('#drawer-toggle');
  await page.click('[data-chat-id="chat_b"]');
  await page.waitForFunction(() => globalThis.__sent.some(message => message.type === 'chat_send'));
  const [body] = await sent(page, 'chat_send');
  assert.deepEqual(body, { type: 'chat_send', provider: 'codex', model: null, text: 'What is in this screenshot?', files: ['file_1'] });
  assert.equal((await sent(page, 'chat_file'))[0].chatId, null);
  // The open chat is untouched: no bubble, not running, the composer usable.
  await page.waitForSelector('#send:not([disabled])');
  assert.equal(await page.textContent('#title'), STORED_CHATS[1].title);
  assert.equal(await page.locator('#messages li').count(), 0);
  assert.equal(await page.isVisible('#stop'), false);
  // The new chat is listed and holds the message.
  await page.waitForSelector('[data-chat-id="chat_4"]', { state: 'attached' });
});

test('a sent message shows once though the service cleans its spaces, in a FAI chat and to an open agent', async t => {
  const page = await open(t, { agentReads: { ses_1: { messages: [] } }, echoMs: 200 });
  await page.fill('#text', 'Go to settings.  Then\tclick Save.');
  await page.click('#send');
  await page.waitForFunction(() => [...document.querySelectorAll('#messages li')].some(li => li.textContent.startsWith('Codex')));
  assert.deepEqual((await texts(page)).filter(text => text.includes('Then')).length, 2, 'the message and the reply quoting it');
  assert.equal((await texts(page)).filter(text => text === 'Go to settings. Then click Save.').length, 1);
  await page.click('#drawer-toggle');
  await page.click('#agent-list [data-session-id="ses_1"]');
  await page.fill('#text', 'Go to settings.  Then click Save.');
  await page.click('#send');
  await page.waitForFunction(() => document.querySelector('#messages li') && !document.querySelector('[data-pending]'));
  assert.deepEqual(await texts(page), ['Go to settings. Then click Save.']);
});

test('a message to an open agent with the same words as an earlier one stays shown until the host writes it', async t => {
  const page = await open(t, { agentReads: { ses_1: { busy: true, messages: [
    { id: 'c1', role: 'user', text: 'continue', at: new Date().toISOString() }] } } });
  await page.click('#drawer-toggle');
  await page.click('#agent-list [data-session-id="ses_1"]');
  await page.waitForSelector('#messages li');
  await page.fill('#text', 'continue');
  await page.click('#send');
  await page.waitForSelector('[data-pending="sent"]');
  await page.waitForTimeout(300);
  assert.equal(await page.locator('[data-pending="sent"]').count(), 1, 'not dropped against the earlier "continue"');
  await page.evaluate(() => globalThis.__fake.agent('ses_1', { messages: [...globalThis.__scenario.agentReads.ses_1.messages,
    { id: 'c2', role: 'user', text: 'continue', at: new Date().toISOString() }] }));
  await page.waitForFunction(() => !document.querySelector('[data-pending]'));
  assert.deepEqual(await texts(page), ['continue', 'continue']);
});

test('open agents (spec #80): the agent working in this window is chosen, Browsing… while busy, Sending… then Sent', async t => {
  const reads = { ses_1: { busy: true, messages: [{ id: 'a1', role: 'agent', text: 'Working on <i>it</i>', at: new Date().toISOString() }] } };
  const page = await open(t, { requests: [{ requestId: 'r1', state: 'active', lease: { tabId: 7 }, owner: { sessionId: 'ses_1' } }],
    agentReads: reads, echoMs: 300 });
  await page.waitForFunction(() => document.getElementById('title').textContent === 'Claude Code · fai-browser');
  await page.waitForSelector('#messages li');
  assert.equal(await page.textContent('#meta'), 'Open agent · Claude Code');
  assert.equal(await page.isVisible('#browsing'), true);
  assert.equal(await page.textContent('#browsing'), 'Browsing…');
  assert.equal(await page.locator('#messages i').count(), 0);
  assert.equal(await page.isVisible('#attach'), false, 'no attachments to an open agent');
  // A busy session still takes a message.
  await page.fill('#text', 'use the other account page');
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-pending="sent"]');
  assert.deepEqual((await sent(page, 'agent_send')).map(message => [message.sessionId, message.text]), [['ses_1', 'use the other account page']]);
  // The host writes it: it shows once.
  await page.waitForFunction(() => !document.querySelector('[data-pending]'));
  assert.equal((await texts(page)).filter(text => text === 'use the other account page').length, 1);
  await page.evaluate(() => globalThis.__fake.agent('ses_1', { busy: false }));
  await page.waitForSelector('#browsing', { state: 'hidden' });
  await page.click('#drawer-toggle');
  assert.equal(await page.locator('#agent-list .drawer-open-title').first().textContent(), 'Claude Code · fai-browser');
  assert.equal(await page.locator('#agent-list .drawer-open-meta').first().textContent(), 'Working in this window');
});

test('open agents: Not delivered with Retry, a session that ended, one that cannot be read, one not ready', async t => {
  const page = await open(t, { agentSendError: 'held by Claude Code', agentReads: { ses_1: { messages: [] }, ses_2: { messages: [] } } });
  await page.click('#drawer-toggle');
  await page.click('#agent-list [data-session-id="ses_1"]');
  await page.fill('#text', 'hello agent');
  await page.click('#send');
  await page.waitForSelector('[data-pending="failed"]');
  assert.equal(await page.textContent('[data-pending="failed"] .message-state'), 'Not delivered: held by Claude CodeRetry');
  await page.evaluate(() => { globalThis.__scenario.agentSendError = null; });
  await page.click('[data-pending="failed"] .link-button');
  await page.waitForSelector('[data-pending="sent"]');
  assert.equal((await sent(page, 'agent_send')).length, 2, 'no automatic retry: one per click');

  await page.evaluate(() => globalThis.__fake.agent('ses_1', { readable: { code: 'unreadable', host: 'claude', version: '2.1.325' } }));
  await page.waitForFunction(() => document.getElementById('notice').textContent.includes('Can\'t read'));
  assert.equal(await page.textContent('#notice'), 'Can\'t read this conversation (Claude Code 2.1.325). Messages you send still reach the agent.');
  assert.equal(await page.isEnabled('#text'), true, 'sending stays available');

  await page.evaluate(() => globalThis.__fake.agent('ses_1', { ended: true }));
  await page.waitForFunction(() => document.getElementById('notice').textContent === 'This agent session has ended.');
  assert.equal(await page.isDisabled('#text'), true);

  await page.click('#drawer-toggle');
  assert.match(await page.textContent('#agent-list [data-session-id="ses_2"]'), /not ready yet\. Ask it to run any FAI command/);
  await page.click('#agent-list [data-session-id="ses_2"]');
  await page.waitForFunction(() => document.getElementById('notice').textContent.includes('not ready'));
  assert.equal(await page.isDisabled('#text'), true);
});

test('open agents: a send still being delivered stays Sending… until agent_chat\'s sends say delivered; reset replaces the list', async t => {
  const messages = Array.from({ length: 5 }, (_, i) => ({ id: `h${i}`, role: 'agent', text: `line ${i}`, at: new Date().toISOString() }));
  const page = await open(t, { agentSendQueued: 600, agentReads: { ses_1: { messages } } });
  await page.click('#drawer-toggle');
  await page.click('#agent-list [data-session-id="ses_1"]');
  await page.waitForFunction(() => document.querySelectorAll('#messages li').length === 5);
  await page.fill('#text', 'queued one');
  await page.click('#send');
  await page.waitForSelector('[data-pending="sending"]');
  await page.waitForTimeout(300);
  assert.equal(await page.textContent('[data-pending] .message-state'), 'Sending…', 'queued: not Sent yet');
  await page.waitForSelector('[data-pending="sent"]');
  // The service's window moved past our cursor: its messages replace ours.
  await page.evaluate(() => {
    const read = globalThis.__scenario.agentReads.ses_1;
    for (let i = 5; i < 12; i++) read.messages.push({ id: `h${i}`, role: 'agent', text: `line ${i}`, at: new Date().toISOString() });
    read.window = 3;
  });
  await page.waitForFunction(() => document.querySelectorAll('#messages li:not([data-pending])').length === 3);
  assert.deepEqual((await texts(page)).filter(text => text.startsWith('Claude Code')), ['Claude Codeline 9', 'Claude Codeline 10', 'Claude Codeline 11']);
});

test('open agents: not_ready and ambiguous_session close sending with their line', async t => {
  const page = await open(t, { agentReads: { ses_1: { messages: [], readable: { code: 'ambiguous_session', host: 'opencode' } } } });
  await page.click('#drawer-toggle');
  await page.click('#agent-list [data-session-id="ses_1"]');
  await page.waitForFunction(() => document.getElementById('notice').textContent.includes('Several OpenCode sessions'));
  assert.equal(await page.isDisabled('#text'), true);
  await page.evaluate(() => globalThis.__fake.agent('ses_1', { readable: { code: 'not_ready', host: 'claude' } }));
  await page.waitForFunction(() => document.getElementById('notice').textContent === 'This agent is not ready yet. Ask it to run any FAI command.');
  assert.equal(await page.isDisabled('#text'), true);
});

test('the model a program chose itself is shown, and a code the panel has no line for shows the service\'s message', async t => {
  const page = await open(t, { chats: STORED_CHATS.map(chat => chat.chatId === 'chat_a' ? { ...chat, reportedModel: 'gpt-5.5-sol' } : chat),
    sendError: { code: 'unknown_chat', message: 'This chat is no longer on disk.' } });
  await openFromDrawer(page, 'chat_a');
  await page.waitForFunction(() => document.querySelector('[aria-label="Model for this chat"] option')?.textContent === 'Default (gpt-5.5-sol)');
  await page.fill('#text', 'hi');
  await page.click('#send');
  await page.waitForSelector('#composer-error:not([hidden])');
  assert.equal(await page.textContent('#composer-error'), 'This chat is no longer on disk.');
});

test('with no agent in this window the panel opens a new chat; the only live session is first under Open agents', async t => {
  const page = await open(t, { agents: [CODEX_AGENT], agentReads: { ses_2: { messages: [] } } });
  assert.equal(await page.textContent('#title'), 'New chat');
  await page.click('#drawer-toggle');
  assert.equal(await page.locator('#agent-list li').count(), 1);
});

test('themes: the system setting by default, and Appearance forces light or dark', async t => {
  const background = page => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const systemDark = await open(t, {}, { colorScheme: 'dark' });
  assert.equal(await background(systemDark), 'rgb(27, 25, 22)');
  const systemLight = await open(t, {}, { colorScheme: 'light' });
  assert.equal(await background(systemLight), 'rgb(244, 240, 232)');
  const forcedLight = await open(t, { settings: { ...SETTINGS, appearance: 'light' } }, { colorScheme: 'dark' });
  assert.equal(await background(forcedLight), 'rgb(244, 240, 232)');
  const forcedDark = await open(t, { settings: { ...SETTINGS, appearance: 'dark' } }, { colorScheme: 'light' });
  assert.equal(await background(forcedDark), 'rgb(27, 25, 22)');
  // Changing Appearance applies at once and is saved.
  await systemLight.click('#drawer-toggle');
  await systemLight.click('#open-settings');
  await systemLight.click('input[name="appearance"][value="dark"]', { force: true });
  await systemLight.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  assert.equal(await background(systemLight), 'rgb(27, 25, 22)');
  assert.equal((await sent(systemLight, 'chat_settings_set')).at(-1).settings.appearance, 'dark');
});

test('reduced motion stops Browsing…\'s animation and keeps its text', async t => {
  const page = await open(t, { stuck: true }, { reducedMotion: 'reduce' });
  await page.fill('#text', 'go');
  await page.click('#send');
  await page.waitForSelector('#browsing:not([hidden])');
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.browsing-dot')).animationName), 'none');
  assert.equal(await page.textContent('#browsing'), 'Browsing…');
});

// Every review state, light and dark, narrow and wide: AA contrast, named controls, nothing wider than the panel.
for (const [name, scenario] of Object.entries(scenarios())) {
  test(`contrast, names and width: ${name}`, async t => {
    const { showState } = await import('./helpers/chat-panel-fake.js');
    for (const theme of ['light', 'dark']) {
      for (const width of [320, 720]) {
        const page = await open(t, { ...scenario, settings: { ...SETTINGS, appearance: theme } }, { width, colorScheme: theme });
        await showState(page, scenario, { wide: width >= 640 });
        const where = `${name} ${theme} ${width}`;
        assert.deepEqual(await page.evaluate(contrastFailures), [], `contrast: ${where}`);
        const unnamed = (await page.evaluate(namedControls)).filter(control => !control.name);
        assert.deepEqual(unnamed, [], `names: ${where}`);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `width: ${where}`);
        await page.close();
      }
    }
  });
}

// The FnB's design ruling (decision #45): the dropdowns sit at the right of the title's row, in one row even at 320 px.
test('header: the dropdowns sit at the right of the title row, without wrapping', async t => {
  const page = await open(t, {}, { width: 320 });
  await page.waitForSelector('[aria-label="Model for this chat"]');
  const boxes = await page.evaluate(() => {
    const box = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
    return { header: box('.header'), title: box('#title'), provider: box('[aria-label="Provider for this chat"]'),
      model: box('[aria-label="Model for this chat"]') };
  });
  for (const control of [boxes.provider, boxes.model]) {
    assert.ok(control.top < boxes.title.bottom && control.bottom > boxes.title.top, 'in the title row');
    assert.ok(control.left >= boxes.title.right, 'right of the title');
  }
  assert.equal(boxes.provider.top, boxes.model.top, 'one row');
  assert.ok(boxes.header.right - boxes.model.right <= 12, 'right-aligned');
  // OpenCode lists long model names: Provider still shows its name in full and the Model dropdown takes the shrink.
  await page.selectOption('[aria-label="Provider for this chat"]', 'opencode');
  await page.waitForFunction(() => [...document.querySelector('[aria-label="Model for this chat"]').options].length > 1);
  const fit = await page.evaluate(() => {
    const provider = document.querySelector('[aria-label="Provider for this chat"]');
    const alone = provider.cloneNode(true);
    alone.style.position = 'absolute';
    document.body.append(alone);
    const full = alone.getBoundingClientRect().width;
    alone.remove();
    const box = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
    return { full, provider: box('[aria-label="Provider for this chat"]'), model: box('[aria-label="Model for this chat"]'),
      header: box('.header'), wide: document.documentElement.scrollWidth <= document.documentElement.clientWidth };
  });
  assert.equal(fit.provider.width, fit.full, 'OpenCode in full');
  assert.equal(fit.provider.top, fit.model.top, 'one row on OpenCode');
  assert.ok(fit.model.right <= fit.header.right && fit.wide, 'no overflow on OpenCode');
});

test('keyboard: every control in the conversation, drawer and settings is reached by Tab, with a focus mark', async t => {
  const page = await open(t, {});
  await openFromDrawer(page, 'chat_a');
  const reach = async () => {
    const seen = new Set();
    await page.evaluate(() => document.activeElement?.blur());
    for (let i = 0; i < 60; i++) {
      await page.keyboard.press('Tab');
      const focused = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        const style = getComputedStyle(el);
        return { key: el.id || el.dataset.chatId || el.dataset.sessionId || el.getAttribute('aria-label') || el.className,
          outline: style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 2 };
      });
      if (!focused) continue;
      assert.ok(focused.outline, `a visible focus mark on ${focused.key}`);
      seen.add(focused.key);
    }
    return seen;
  };
  const conversation = await reach();
  for (const key of ['drawer-toggle', 'Model for this chat', 'attach', 'text']) assert.ok(conversation.has(key), `conversation reaches ${key}`);
  await page.click('#drawer-toggle');
  const drawer = await reach();
  for (const key of ['new-chat', 'chat_a', 'chat_b', 'ses_1', 'open-settings']) assert.ok(drawer.has(key), `drawer reaches ${key}`);
  await page.keyboard.press('Escape');
  await page.click('#drawer-toggle');
  await page.focus('#open-settings');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.activeElement?.id === 'settings-title');
  const settings = await reach();
  assert.ok([...settings].filter(key => String(key).startsWith('set-')).length >= 4, 'settings fields are reached');
  assert.ok(settings.has('settings-back'));
  await page.keyboard.press('Escape');
  await page.waitForSelector('#settings', { state: 'hidden' });
  assert.equal(await page.evaluate(() => document.activeElement.id), 'text', 'Escape returns to the composer');
});

test('keyboard: a settings change keeps focus on its control, so arrows step through Appearance and a select', async t => {
  const page = await open(t, {});
  await page.click('#drawer-toggle');
  await page.click('#open-settings');
  await page.waitForFunction(() => document.activeElement?.id === 'settings-title');
  const focused = () => page.evaluate(() => document.activeElement?.dataset.setting ?? document.activeElement?.tagName);
  const saves = () => page.evaluate(() => globalThis.__sent.filter(message => message.type === 'chat_settings_set').length);
  await page.focus('input[name="appearance"][value="system"]');
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => document.getElementById('settings-status').textContent === 'Saved.');
  assert.equal(await focused(), 'appearance-light');
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(count => globalThis.__sent.filter(message => message.type === 'chat_settings_set').length > count, 1);
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  assert.equal(await focused(), 'appearance-dark');
  const before = await saves();
  await page.focus('[data-setting="default-provider"]');
  await page.keyboard.press('ArrowDown');
  await page.waitForFunction(count => globalThis.__sent.filter(message => message.type === 'chat_settings_set').length > count, before);
  await page.waitForFunction(() => document.getElementById('settings-status').textContent === 'Saved.');
  assert.equal((await sent(page, 'chat_settings_set')).at(-1).settings.defaultProvider, 'claude');
  assert.equal(await focused(), 'default-provider');
});

// Polls redraw from state (every 2 s for real; 100 ms here): across several, the nodes a user acts on stay.
const polled = async (page, type, count = 4) => {
  const start = (await sent(page, type)).length;
  await page.waitForFunction(([kind, until]) => globalThis.__sent.filter(message => message.type === kind).length >= until, [type, start + count]);
};
const selectIn = (page, selector) => page.evaluate(target => {
  const node = document.querySelector(target).lastChild;
  const range = document.createRange();
  range.setStart(node, 0);
  range.setEnd(node, 12);
  getSelection().removeAllRanges();
  getSelection().addRange(range);
  return getSelection().toString();
}, selector);
const selection = page => page.evaluate(() => getSelection().toString());

test('polls keep a stored chat as it is: the Model dropdown, its focus, a selection, and messages already shown', async t => {
  const page = await open(t, {});
  await openFromDrawer(page, 'chat_a');
  await page.focus('[aria-label="Model for this chat"]');
  await page.evaluate(() => { globalThis.__model = document.querySelector('[aria-label="Model for this chat"]'); });
  await polled(page, 'chat_history');
  assert.equal(await page.evaluate(() => document.querySelector('[aria-label="Model for this chat"]') === globalThis.__model), true, 'the same node');
  assert.equal(await page.evaluate(() => document.activeElement === globalThis.__model), true, 'focus stays');
  // A change keeps focus on the dropdown, and the next polls keep the choice.
  await page.keyboard.press('ArrowDown');
  await page.waitForFunction(() => globalThis.__sent.some(message => message.type === 'chat_model'));
  await polled(page, 'chat_history');
  assert.equal(await page.evaluate(() => document.activeElement === globalThis.__model), true, 'focus stays after a change');
  assert.equal(await page.inputValue('[aria-label="Model for this chat"]'), 'gpt-5.5-sol');
  const picked = await selectIn(page, '#messages li[data-role="agent"]');
  assert.equal(picked, 'The first li');
  await page.evaluate(() => { globalThis.__first = document.querySelector('#messages li'); });
  await polled(page, 'chat_history');
  assert.equal(await selection(page), picked, 'a selection stays');
  // A new message is added under the others; those already shown stay, and so does the selection.
  await page.evaluate(() => globalThis.__fake.push('chat_a', { id: 'm9', role: 'agent', text: 'Delivery is on Friday.', at: new Date().toISOString() }));
  await page.waitForFunction(() => document.querySelectorAll('#messages li').length === 5);
  assert.equal(await page.evaluate(() => document.querySelector('#messages li') === globalThis.__first), true);
  assert.equal(await selection(page), picked, 'a selection stays when a message arrives');
});

for (const width of [320, 720]) {
  test(`polls keep focus on a chat's row in the drawer, and a selection in an open agent's messages (${width} px)`, async t => {
    const page = await open(t, { requests: [{ requestId: 'r1', state: 'active', lease: { tabId: 7 }, owner: { sessionId: 'ses_1' } }],
      agentReads: { ses_1: { busy: true, messages: [{ id: 'a1', role: 'agent', text: 'The order is marked as shipped.', at: new Date().toISOString() }] } } },
    { width });
    await page.waitForSelector('#messages li');
    const picked = await selectIn(page, '#messages li');
    await polled(page, 'agent_chat');
    assert.equal(await selection(page), picked, 'a selection in an open agent stays');
    if (await page.locator('#drawer').isHidden()) await page.click('#drawer-toggle');
    await page.focus('[data-chat-id="chat_b"]');
    await polled(page, 'agent_chat');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.chatId), 'chat_b', 'focus stays on the row');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Delete chat Fill in the shipping form from my notes');
    // The same in a stored chat.
    await page.click('[data-chat-id="chat_a"]');
    await page.waitForSelector('#messages li[data-role="agent"]');
    if (await page.locator('#drawer').isHidden()) await page.click('#drawer-toggle');
    await page.focus('[data-session-id="ses_1"]');
    await polled(page, 'chat_history');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.sessionId), 'ses_1', 'focus stays on the row in a stored chat');
  });
}

test('keyboard: ArrowDown on a new chat\'s Provider changes it and keeps focus there', async t => {
  const page = await open(t, {});
  await page.focus('[aria-label="Provider for this chat"]');
  await page.keyboard.press('ArrowDown');
  await page.waitForFunction(() => document.querySelector('[aria-label="Provider for this chat"]').value === 'claude');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Provider for this chat');
  await page.waitForFunction(() => [...document.querySelector('[aria-label="Model for this chat"]').options].some(item => item.value === 'opus'));
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Provider for this chat');
});

test('the popup\'s Chat button opens the side panel in its window', async t => {
  const page = await browser.newPage({ viewport: { width: 400, height: 700 } });
  t.after(() => page.close());
  const extension = new URL('../extension/', import.meta.url);
  await page.route('https://panel.test/**', async route => {
    const file = new URL(route.request().url()).pathname.slice(1);
    const type = file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'text/html';
    const body = await readFile(new URL(file, extension)).catch(() => null);
    return body ? route.fulfill({ contentType: type, body }) : route.fulfill({ status: 404, body: '' });
  });
  await page.addInitScript(installFakeChrome, BASE);
  await page.addInitScript(() => {
    const fake = globalThis.chrome;
    fake.commands = { async getAll() { return []; } };
    fake.action = { async getUserSettings() { return { isOnToolbar: true }; } };
    fake.permissions = { async request() { return true; }, async contains() { return false; }, async remove() { return true; } };
    fake.storage.local.get = async () => ({});
    globalThis.close = () => { globalThis.__closed = true; };
  });
  await page.goto('https://panel.test/popup.html');
  await page.click('#chat');
  await page.waitForFunction(() => globalThis.__closed === true);
  assert.deepEqual(await page.evaluate(() => globalThis.__sidePanelOpened), [{ windowId: 1 }]);
  await page.goto('https://panel.test/popup.html?window=1');
  await page.waitForSelector('#chat', { state: 'hidden' });
});
