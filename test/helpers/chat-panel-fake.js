// A fake chrome API with a fake FAI service behind it, for the chat panel (extension/panel.html) in a plain page:
// test/chat-panel.test.js (Chromium), test/firefox-panel.test.js (Firefox) and scripts/panel-screenshots.mjs. It
// answers extension/chat-api.js's contract from `scenario`, and records every message in globalThis.__sent.
//
// installFakeChrome runs inside the page, so it uses nothing from this module's scope: pass it to Playwright's
// addInitScript(installFakeChrome, scenario), or inline fakeChromeSource(scenario) into a <script>.

export function installFakeChrome(scenario) {
  const s = {
    connected: true, pollMs: 100, windowTabs: [7], requests: [], agents: [], providers: [], models: {},
    settings: { defaultProvider: null, models: { codex: null, claude: null, opencode: null }, appearance: 'system' },
    chats: [], transcripts: {}, agentReads: {}, sendError: null, agentSendError: null, reply: null, replyMs: 300,
    turnFailure: null, stuck: false, delays: {}, ...scenario,
  };
  const sent = [];
  const fail = (error, code) => ({ error, code });
  const files = new Map();
  globalThis.__sent = sent;
  globalThis.__scenario = s;
  // Lets a test change what the service says next (a turn ending, an agent turning busy).
  globalThis.__fake = {
    push(chatId, message) { (s.transcripts[chatId] ??= []).push(message); },
    finish(chatId) { const chat = s.chats.find(item => item.chatId === chatId); if (chat) chat.running = false; },
    agent(sessionId, change) { Object.assign(s.agentReads[sessionId] ??= { messages: [] }, change); },
    // The service drops waiting files (aged out, or restarted): chat_send then answers unknown_file.
    forgetFiles() { files.clear(); },
  };
  const chatView = chat => ({ chatId: chat.chatId, title: chat.title, provider: chat.provider, model: chat.model ?? null,
    ...(chat.reportedModel ? { reportedModel: chat.reportedModel } : {}), running: Boolean(chat.running) });
  const now = () => new Date().toISOString();
  // The service cleans a user's text before the host or the chat runner writes it (main src/wake.js cleanChatText).
  const clean = text => String(text).replace(/\r\n?|[\u2028\u2029]/g, '\n').replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, '')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]+/g, ' ').replace(/[^\S\n]+/g, ' ').trim();

  function answer(message) {
    sent.push(structuredClone(message));
    const worker = { connection: { connected: s.connected }, requests: s.requests, session: null };
    switch (message.type) {
      case 'state': return worker;
      case 'agents': return { ...worker, agents: { sessions: s.agents, invites: [] } };
      case 'chat_providers': return { providers: s.providers, defaultProvider: s.providers.find(item => item.available)?.provider ?? null };
      case 'chat_settings': return { settings: s.settings };
      case 'chat_settings_set': s.settings = message.settings; return { settings: s.settings };
      case 'chat_models': {
        const models = s.models[message.provider];
        return Array.isArray(models) ? { models } : fail(`${message.provider} did not list its models`, 'chat_models_failed');
      }
      case 'chat_list': {
        const sorted = [...s.chats].sort((a, b) => Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt));
        const page = sorted.slice(message.offset, message.offset + message.limit);
        const next = message.offset + message.limit < sorted.length ? message.offset + message.limit : null;
        return { chats: page.map(chat => ({ ...chatView(chat), lastActiveAt: chat.lastActiveAt })), next };
      }
      case 'chat_history': {
        const chat = s.chats.find(item => item.chatId === message.chatId);
        if (!chat) return fail('No such chat', 'unknown_chat');
        const all = s.transcripts[chat.chatId] ?? [];
        const after = Number.isInteger(message.after) ? message.after : 0;
        return { chat: chatView(chat), messages: all.slice(after), cursor: all.length };
      }
      case 'chat_file': {
        const fileId = `file_${sent.filter(item => item.type === 'chat_file').length}`;
        files.set(fileId, { name: message.name, size: message.size, type: message.mime });
        return { fileId };
      }
      case 'chat_send': {
        if ((message.files ?? []).some(id => !files.has(id))) return fail('A file is no longer waiting to be sent. Attach it again.', 'unknown_file');
        if (s.sendError) return fail(s.sendError.message ?? 'Refused', s.sendError.code);
        let chat = s.chats.find(item => item.chatId === message.chatId);
        if (!chat) {
          chat = { chatId: `chat_${s.chats.length + 1}`, title: message.text.slice(0, 60), provider: message.provider,
            model: message.model ?? null, lastActiveAt: now(), running: false };
          s.chats.push(chat);
        }
        const fileMeta = (message.files ?? []).map(id => files.get(id));
        for (const id of message.files ?? []) files.delete(id);
        (s.transcripts[chat.chatId] ??= []).push({ id: `m${Date.now()}`, role: 'user', text: clean(message.text), at: now(), files: fileMeta });
        chat.running = true;
        chat.lastActiveAt = now();
        if (!s.stuck) {
          setTimeout(() => {
            const record = s.turnFailure
              ? { id: `m${Date.now()}f`, role: 'fai', text: '', at: now(), ...s.turnFailure }
              : { id: `m${Date.now()}a`, role: 'agent', text: s.reply ?? `You said: ${message.text}`, at: now() };
            s.transcripts[chat.chatId].push(record);
            chat.running = false;
          }, s.replyMs);
        }
        return { chatId: chat.chatId };
      }
      case 'chat_stop': {
        const chat = s.chats.find(item => item.chatId === message.chatId);
        if (chat?.running) {
          chat.running = false;
          s.stuck = true;
          s.transcripts[chat.chatId].push({ id: `m${Date.now()}s`, role: 'fai', text: '', code: 'chat_stopped', at: now() });
        }
        return {};
      }
      case 'chat_delete':
        s.chats = s.chats.filter(chat => chat.chatId !== message.chatId);
        return {};
      case 'chat_model': {
        const chat = s.chats.find(item => item.chatId === message.chatId);
        if (chat) chat.model = message.model;
        return {};
      }
      case 'agent_chat': {
        const read = s.agentReads[message.sessionId];
        if (!read) return fail('This agent session has ended.', 'session_ended');
        const all = (read.messages ?? []).map((item, index) => ({ seq: index + 1, ...item }));
        // A cursor older than the window (read.window) gets the window with reset, like the service's 200 messages.
        let after = Number.isInteger(message.after) ? message.after : 0;
        const floor = read.window ? Math.max(0, all.length - read.window) : 0;
        const reset = after < floor;
        if (reset) after = floor;
        return { messages: all.slice(after), cursor: all.length, busy: Boolean(read.busy), readable: read.readable ?? true,
          ended: Boolean(read.ended), ...(reset ? { reset: true } : {}), sends: read.sends ?? [] };
      }
      case 'agent_send': {
        if (s.agentSendError) return fail(s.agentSendError, 'wake_failed');
        const read = s.agentReads[message.sessionId];
        if (read && s.echoMs !== undefined) {
          setTimeout(() => read.messages.push({ id: `u${Date.now()}`, role: 'user', text: clean(message.text), at: now() }), s.echoMs);
        }
        const wakeId = `wake_${sent.filter(item => item.type === 'agent_send').length}`;
        // Delivery still running when the service answers: the outcome comes later in agent_chat's sends.
        if (s.agentSendQueued && read) {
          setTimeout(() => (read.sends ??= []).push({ wakeId, state: 'delivered', error: null }), s.agentSendQueued);
          return { ok: true, wakeId, state: 'queued' };
        }
        return { ok: true, wakeId };
      }
      default: return fail('Unsupported control');
    }
  }

  const sidePanelOpened = [];
  globalThis.__sidePanelOpened = sidePanelOpened;
  globalThis.chrome = {
    storage: {
      local: { async get() { return { panelPollMs: s.pollMs }; }, async set() {} },
      session: { async get() { return {}; } },
      onChanged: { addListener() {} },
    },
    tabs: { async query() { return s.windowTabs.map(id => ({ id, windowId: 1, url: 'https://shop.example/cart', title: 'Cart' })); } },
    runtime: {
      id: 'fake',
      getManifest: () => ({ version: '0.11.0' }),
      getURL: path => `${location.origin}/${path}`,
      // delays: {type: ms} holds that reply back, as a slow upload does.
      async sendMessage(message) {
        const reply = answer(message);
        const ms = s.delays[message.type];
        return ms ? new Promise(resolve => setTimeout(() => resolve(reply), ms)) : reply;
      },
    },
    sidePanel: { async open(options) { sidePanelOpened.push(options); } },
  };
}

export function fakeChromeSource(scenario) {
  return `(${installFakeChrome})(${JSON.stringify(scenario)});`;
}

// --- scenarios: the states of spec #84's design review, shared by the tests and the screenshot script ---------------

const minutesAgo = minutes => new Date(Date.now() - minutes * 60_000).toISOString();
export const ALL_PROVIDERS = [
  { provider: 'codex', name: 'Codex', available: true, code: null, version: '0.169.0', line: null },
  { provider: 'claude', name: 'Claude', available: true, code: null, version: '2.1.325', line: null },
  { provider: 'opencode', name: 'OpenCode', available: true, code: null, version: '1.19.5', line: null },
];
export const NO_PROVIDERS = [
  // The service's own fixed lines (WU13/WU16 own the wording); the panel shows them as is.
  { provider: 'codex', name: 'Codex', available: false, code: 'chat_not_installed', version: null,
    line: 'Install the Codex command line, then reopen this panel.' },
  { provider: 'claude', name: 'Claude', available: false, code: 'chat_signed_out', version: '2.1.325',
    line: 'Sign in to the Claude command line once (run claude, then /login).' },
  { provider: 'opencode', name: 'OpenCode', available: false, code: 'chat_unsupported_version', version: '1.12.0',
    line: 'Update OpenCode to 1.19 or later in the 1.x series.' },
];
export const MODELS = {
  codex: ['gpt-5.5-sol', 'gpt-5.5-sol-mini', 'gpt-5.4'],
  claude: ['opus', 'sonnet', 'fable', 'haiku'],
  opencode: ['ollama-cloud/deepseek-v4.1-flash-1017', 'anthropic/claude-sonnet-5-5'],
};
export const CLAUDE_AGENT = { sessionId: 'ses_1', host: 'claude', repo: 'fai-browser', lastActiveAt: minutesAgo(1),
  wake: 'claude-socket', wakeReason: 'ok', ready: true };
export const CODEX_AGENT = { sessionId: 'ses_2', host: 'codex', repo: 'shop', lastActiveAt: minutesAgo(12), wake: 'none',
  wakeReason: 'codex_no_thread', ready: false };

export const STORED_CHATS = [
  { chatId: 'chat_a', title: 'Compare the two laptop listings on this page', provider: 'codex', model: null, lastActiveAt: minutesAgo(3) },
  { chatId: 'chat_b', title: 'Fill in the shipping form from my notes', provider: 'claude', model: 'sonnet', lastActiveAt: minutesAgo(90) },
  { chatId: 'chat_c', title: 'Which flights leave before noon?', provider: 'opencode', model: 'ollama-cloud/deepseek-v4.1-flash-1017', lastActiveAt: minutesAgo(60 * 30) },
];
export const CONVERSATION = [
  { id: 'm1', role: 'user', text: 'Compare the two laptop listings on this page. Which has more memory?', at: minutesAgo(4) },
  { id: 'm2', role: 'fai', text: '[FAI Browser] Approved tab request r12 (Use).', at: minutesAgo(4) },
  { id: 'm3', role: 'agent', text: 'The first listing (ThinkPad X1) has 32 GB of memory; the second (XPS 13) has 16 GB.\n\nBoth have 1 TB storage. The ThinkPad costs $240 more.', at: minutesAgo(3) },
  { id: 'm4', role: 'user', text: 'Open the ThinkPad and check the delivery date.', at: minutesAgo(1) },
];

export function scenarios() {
  const base = { providers: ALL_PROVIDERS, models: MODELS, chats: STORED_CHATS, agents: [CLAUDE_AGENT, CODEX_AGENT],
    transcripts: { chat_a: CONVERSATION, chat_b: [], chat_c: [] } };
  return {
    'first-open': { ...base },
    'no-provider': { ...base, providers: NO_PROVIDERS },
    'opencode-only': { ...base, providers: [NO_PROVIDERS[0], NO_PROVIDERS[1], ALL_PROVIDERS[2]] },
    running: { ...base, chats: STORED_CHATS.map(chat => chat.chatId === 'chat_a' ? { ...chat, running: true } : chat), stuck: true, open: 'chat_a' },
    'failed-turn': { ...base, open: 'chat_a', transcripts: { ...base.transcripts, chat_a: [...CONVERSATION,
      { id: 'm5', role: 'fai', text: '', code: 'chat_timed_out', at: minutesAgo(0) }] } },
    attachments: { ...base, open: 'chat_a', attach: true, transcripts: { ...base.transcripts, chat_a: [CONVERSATION[0],
      { id: 'm6', role: 'user', text: 'Here are the receipt and the spec sheet. Does the total match?', at: minutesAgo(1),
        files: [{ name: 'receipt.png', size: 182_331, type: 'image/png' }, { name: 'spec-sheet.pdf', size: 1_240_112, type: 'application/pdf' }] },
      { id: 'm7', role: 'agent', text: 'Yes: the receipt total ($1,489.00) matches the price on the page.', at: minutesAgo(0) }] } },
    'provider-failed': { ...base, open: 'chat_a', transcripts: { ...base.transcripts, chat_a: [CONVERSATION[0],
      { id: 'm8', role: 'fai', text: '', code: 'chat_turn_failed', exit: 1, at: minutesAgo(0),
        providerText: 'error: model "gpt-9" is not available on your plan. <b>Upgrade</b> at https://example.invalid/plans' }] } },
    drawer: { ...base, drawer: true },
    settings: { ...base, settingsOpen: true },
    'delete-confirm': { ...base, drawer: true, deleteChat: 'chat_b' },
    'open-agent': { ...base, open: null, requests: [{ requestId: 'r12', state: 'active', lease: { tabId: 7 }, owner: { sessionId: 'ses_1' } }],
      agentReads: { ses_1: { busy: true, messages: [
        { id: 'a1', role: 'user', text: 'Check the order status on the shop tab.', at: minutesAgo(2) },
        { id: 'a2', role: 'fai', text: '[FAI Browser] Approved tab request r12 (Use).', at: minutesAgo(2) },
        { id: 'a3', role: 'agent', text: 'The order #4471 is marked as shipped. I am opening the tracking page now.', at: minutesAgo(1) }] } } },
  };
}

// --- driving a page into a scenario's state (Playwright page) --------------------------------------------------------

const EXTENSION = new URL('../../extension/', import.meta.url);

/** Serves extension/ at https://panel.test/ on `page`, with the fake chrome API for `scenario` installed first. */
export async function panelPage(browser, scenario, { width = 360, height = 720, colorScheme = 'light', reducedMotion = 'no-preference' } = {}) {
  const { readFile } = await import('node:fs/promises');
  const page = await browser.newPage({ viewport: { width, height }, colorScheme, reducedMotion });
  page.setDefaultTimeout(4000);
  await page.route('https://panel.test/**', async route => {
    const file = new URL(route.request().url()).pathname.slice(1);
    const type = file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript'
      : file.endsWith('.png') ? 'image/png' : 'text/html';
    const body = await readFile(new URL(file, EXTENSION)).catch(() => null);
    if (!body) return route.fulfill({ status: 404, body: '' });
    route.fulfill({ contentType: type, body });
  });
  await page.addInitScript(installFakeChrome, scenario);
  await page.goto('https://panel.test/panel.html');
  await page.waitForFunction(() => document.getElementById('title').textContent !== 'New chat' || document.activeElement?.id === 'text'
    || !document.getElementById('empty').hidden);
  return page;
}

/** Drives `page` into the review state the scenario names (open a chat, the drawer, settings, a confirmation). */
export async function showState(page, scenario, { wide = false } = {}) {
  const drawer = async () => {
    if (!wide && await page.locator('#drawer').isHidden()) await page.click('#drawer-toggle');
  };
  if (scenario.open) {
    await drawer();
    await page.click(`[data-chat-id="${scenario.open}"]`);
    await page.waitForSelector('#messages li');
  }
  if (scenario.attach) {
    await page.setInputFiles('#file-input', [
      { name: 'screenshot.png', mimeType: 'image/png', buffer: PNG },
      { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Shipping to: 12 Harbour St') },
    ]);
  }
  if (scenario.drawer) await drawer();
  if (scenario.settingsOpen) {
    await drawer();
    await page.click('#open-settings');
    await page.waitForFunction(() => !document.querySelector('.setting-help')?.textContent.includes('Reading'));
  }
  if (scenario.deleteChat) await page.click(`[data-chat-id="${scenario.deleteChat}"] + .drawer-delete`);
  if (scenario.agentReads && !scenario.open) await page.waitForSelector('#messages li');
  await page.waitForTimeout(150);
}

// A 24x24 PNG (amber square) for attachment previews.
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAIAAABvFaqvAAAAI0lEQVR4nGN4vMKTKohh1KDRMBpNR6NZZLQYGS0hHw94LQIAcJMdPVTueSIAAAAASUVORK5CYII=', 'base64');
