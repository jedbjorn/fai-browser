// The chat panel (Chrome side_panel, Firefox sidebar_action): spec #84 "Panel" for the whole layout, with spec #80's
// view of an open agent inside it. One conversation fills the panel (a FAI chat, a new chat, or an open agent), with
// the drawer (New chat, Chats, Open agents, Settings) over it when narrow and beside it when wide, and Browser Chat
// settings as a view of its own. It talks to the FAI service only through chat-api.js.
// Everything the service, an agent or a provider wrote is set with textContent, never as HTML; links are not
// clickable. The rules (defaults, reason lines, limits) are in chat-view.js.
import { chatApi } from './chat-api.js';
import {
  agentBlockedLine, APPEARANCES, availableProviders, CHATS_PAGE, cleanChatText, composerProblem, defaultAgent, defaultProvider,
  failedTurn, faiLine, formatSize, MAX_FILES, MAX_PROVIDER_TEXT, needsOpenCodeModel, PROVIDER_ORDER, providerName, reasonLine,
  readableLine, relativeTime, retryText, unmatchedPending,
} from './chat-view.js';
import { agentLabel, HOST_NAMES } from './invite-card.js';
import { element } from './ui.js';

const stored = await chrome.storage.local.get(['panelPollMs']);
// About every 2 s while the panel is open (spec #80); a test shortens it through storage.local panelPollMs.
const POLL_MS = Number.isInteger(stored.panelPollMs) && stored.panelPollMs >= 50 ? stored.panelPollMs : 2000;
const WIDE = window.matchMedia('(min-width: 640px)');

const $ = id => document.getElementById(id);
const ui = {
  drawer: $('drawer'), scrim: $('scrim'), toggle: $('drawer-toggle'), drawerClose: $('drawer-close'), newChat: $('new-chat'),
  chatList: $('chat-list'), chatsEmpty: $('chats-empty'), moreChats: $('more-chats'), agentList: $('agent-list'),
  agentsEmpty: $('agents-empty'), openSettings: $('open-settings'), title: $('title'), meta: $('meta'), headerControls: $('header-controls'),
  header: document.querySelector('.header'), conversation: $('conversation'), scroller: $('scroller'), empty: $('empty'), messages: $('messages'),
  browsing: $('browsing'), notice: $('notice'), composer: $('composer'), chips: $('chips'), composerError: $('composer-error'),
  attach: $('attach'), attachHint: $('attach-hint'), fileInput: $('file-input'), text: $('text'), send: $('send'), stop: $('stop'),
  settings: $('settings'), settingsBack: $('settings-back'), settingsTitle: $('settings-title'), settingsBody: $('settings-body'),
  settingsStatus: $('settings-status'), confirm: $('confirm'), confirmText: $('confirm-text'),
};

const state = {
  connected: false,
  providers: [],
  settings: { defaultProvider: null, models: { codex: null, claude: null, opencode: null }, appearance: 'system' },
  models: {},          // provider -> {models: [...]} | {error}
  chats: [], chatsNext: null,
  agents: [], requests: [], suggested: null,
  view: 'loading',     // loading | offline | none | new | chat | agent
  opened: 0,           // counts conversations opened, so work that outlives one does not land on the next
  newProvider: null, newModel: '',
  chat: null, messages: [], cursor: null,
  agent: null, agentMessages: [], agentCursor: null, busy: false, readable: true, ended: false, pending: [],
  files: [],           // [{file, url}]
  previews: new Map(), // file name -> object URL, for images attached from this panel
  sending: false,
  composerError: null,
  settingsOpen: false, settingsNote: null,
  drawerOpen: false, drawerCollapsed: false,
};

// --- theme ----------------------------------------------------------------------------------------------------------

function applyTheme() {
  const appearance = APPEARANCES.includes(state.settings.appearance) ? state.settings.appearance : 'system';
  if (appearance === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = appearance;
}

// --- loading --------------------------------------------------------------------------------------------------------

async function windowTabIds() {
  try {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    return tabs.map(tab => tab.id);
  } catch {
    return [];
  }
}

async function loadAgents() {
  const reply = await chatApi.agents().catch(() => null);
  state.agents = Array.isArray(reply?.agents?.sessions) ? reply.agents.sessions : [];
  state.requests = Array.isArray(reply?.requests) ? reply.requests : [];
  state.suggested = defaultAgent(state.agents, state.requests, await windowTabIds());
}

async function loadChats(offset = 0) {
  const reply = await chatApi.list(offset, CHATS_PAGE).catch(() => null);
  const chats = Array.isArray(reply?.chats) ? reply.chats : [];
  state.chats = offset ? [...state.chats, ...chats] : chats;
  state.chatsNext = Number.isInteger(reply?.next) ? reply.next : null;
}

async function start() {
  const worker = await chatApi.state().catch(() => null);
  state.connected = Boolean(worker?.connection?.connected);
  if (!state.connected) {
    state.view = 'offline';
    render();
    return;
  }
  const [providers, settings] = await Promise.all([
    chatApi.providers().catch(() => null), chatApi.settings().catch(() => null), loadAgents(), loadChats(),
  ]);
  state.providers = Array.isArray(providers?.providers) ? providers.providers : [];
  if (settings?.settings) state.settings = normalizeSettings(settings.settings);
  applyTheme();
  // An agent that works in a tab of this window is what the user opened Chat to watch (spec #80); otherwise a new chat
  // when a provider is available, else the providers with their fix lines (spec #84 "First open").
  if (state.suggested?.why === 'task') return openAgent(state.suggested.sessionId);
  newChat({ focus: true });
}

function normalizeSettings(value) {
  const models = {};
  for (const provider of PROVIDER_ORDER) {
    const model = value?.models?.[provider];
    models[provider] = typeof model === 'string' && model ? model : null;
  }
  return {
    defaultProvider: PROVIDER_ORDER.includes(value?.defaultProvider) ? value.defaultProvider : null,
    models,
    appearance: APPEARANCES.includes(value?.appearance) ? value.appearance : 'system',
  };
}

// --- views ----------------------------------------------------------------------------------------------------------

function resetConversation() {
  state.opened += 1;
  state.chat = null;
  state.messages = [];
  state.cursor = null;
  state.agent = null;
  state.agentMessages = [];
  state.agentCursor = null;
  state.pending = [];
  state.busy = false;
  state.readable = true;
  state.ended = false;
  state.composerError = null;
}

// `from`: a failed turn's way out (decision #48): the chat's provider and model when that provider is still available,
// and its text in the composer. Attachments are not carried.
function newChat({ focus = false, from = null } = {}) {
  resetConversation();
  clearFiles();
  const same = Boolean(from) && availableProviders(state.providers).includes(from.provider);
  state.newProvider = same ? from.provider : defaultProvider(state.providers, state.settings);
  state.newModel = same ? from.model ?? '' : state.newProvider ? state.settings.models[state.newProvider] ?? '' : '';
  state.view = state.newProvider ? 'new' : 'none';
  closeDrawer({ restore: false });
  // OpenCode alone, with no model chosen: its model list first (spec #84 "Defaults").
  if (!same && needsOpenCodeModel(state.providers, state.settings)) {
    openSettings({ note: 'OpenCode needs a model to chat. Choose one below, then start your chat.', focusProvider: 'opencode' });
    return;
  }
  closeSettings({ restore: false });
  if (from) {
    ui.text.value = from.text;
    ui.text.dispatchEvent(new Event('input'));
  }
  render();
  if (focus && state.view === 'new') ui.text.focus();
}

async function openChat(chatId) {
  resetConversation();
  clearFiles();
  const known = state.chats.find(chat => chat.chatId === chatId);
  state.chat = known ? { ...known } : { chatId, title: 'Chat', provider: null, model: null, running: false };
  state.view = 'chat';
  closeDrawer({ restore: false });
  closeSettings({ restore: false });
  render();
  await readChat();
  ui.text.focus();
}

async function openAgent(sessionId) {
  resetConversation();
  clearFiles();
  state.agent = state.agents.find(agent => agent.sessionId === sessionId) ?? { sessionId, host: 'unknown', repo: 'unknown' };
  state.view = 'agent';
  closeDrawer({ restore: false });
  closeSettings({ restore: false });
  render();
  await readAgent();
  if (!ui.text.disabled) ui.text.focus();
}

// --- reading --------------------------------------------------------------------------------------------------------

async function readChat() {
  const chat = state.chat;
  if (!chat) return;
  let reply;
  try {
    reply = await chatApi.history(chat.chatId, state.cursor);
  } catch (error) {
    if (state.chat === chat) setNotice(error.message);
    return;
  }
  if (state.chat !== chat) return;
  const wasRunning = chat.running;
  if (reply.chat) Object.assign(chat, reply.chat);
  const messages = Array.isArray(reply.messages) ? reply.messages : [];
  const seen = new Set(state.messages.map(message => message.id));
  const fresh = messages.filter(message => !seen.has(message.id));
  // A message sent from here shows at once; the stored one (cleaned by the service) replaces it when the transcript has
  // it. `fresh` holds only messages read after it was sent.
  const written = new Set(fresh.filter(message => message.role === 'user').map(message => cleanChatText(message.text)));
  state.messages = [...state.messages.filter(message => !(message.local && written.has(cleanChatText(message.text)))), ...fresh];
  state.cursor = reply.cursor ?? state.cursor;
  setNotice(null);
  render();
  if (wasRunning && !chat.running) loadChats().then(renderDrawer);
}

async function readAgent() {
  const agent = state.agent;
  if (!agent) return;
  let reply;
  try {
    reply = await chatApi.agentRead(agent.sessionId, state.agentCursor);
  } catch (error) {
    if (state.agent !== agent) return;
    if (error.code === 'session_ended' || error.code === 'unknown_session') state.ended = true;
    else setNotice(error.message);
    render();
    return;
  }
  if (state.agent !== agent) return;
  // `reset`: our cursor fell out of the service's 200-message window, so its messages replace ours.
  if (reply.reset === true) state.agentMessages = [];
  const seen = new Set(state.agentMessages.map(message => message.id));
  state.agentMessages.push(...(Array.isArray(reply.messages) ? reply.messages : []).filter(message => !seen.has(message.id)));
  state.agentCursor = reply.cursor ?? state.agentCursor;
  state.busy = reply.busy === true;
  state.readable = reply.readable ?? true;
  state.ended = reply.ended === true;
  applySends(Array.isArray(reply.sends) ? reply.sends : []);
  state.pending = unmatchedPending(state.pending, state.agentMessages);
  setNotice(null);
  render();
}

let polling = false;
async function poll() {
  if (polling || document.hidden) return;
  polling = true;
  try {
    if (state.view === 'chat') await readChat();
    else if (state.view === 'agent') await readAgent();
  } finally {
    polling = false;
  }
}

// --- sending --------------------------------------------------------------------------------------------------------

function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

function errorLine(error, provider) {
  return reasonLine(error?.code, provider) ?? error?.message;
}

// The message goes to the conversation it was written in (spec #84 "A turn"): the chat, or a new one on the provider and
// model shown, taken once here. Its bubble and the composer change only while that conversation is still open.
async function sendChat(text) {
  const opened = state.opened;
  const chat = state.chat;
  const target = chat?.chatId ?? null;
  const provider = chat?.provider ?? state.newProvider;
  const model = state.newModel || null;
  const items = [...state.files];
  const files = items.map(item => item.file);
  const here = () => state.opened === opened;
  state.sending = true;
  state.composerError = null;
  render();
  try {
    const fileIds = await uploadFiles(items, target);
    const body = chat ? { chatId: chat.chatId, text, files: fileIds } : { provider, model, text, files: fileIds };
    const sent = { id: `local-${Date.now()}`, role: 'user', text, at: new Date().toISOString(), local: true,
      files: files.map(file => ({ name: file.name, size: file.size, type: file.type })) };
    let reply;
    try {
      reply = await chatApi.send(body);
    } catch (error) {
      // A file the service no longer holds (aged out, or the service restarted): upload the draft's files again, once.
      if (error.code !== 'unknown_file' || !items.length) throw error;
      for (const item of items) item.fileId = null;
      body.files = await uploadFiles(items, target);
      reply = await chatApi.send(body);
    }
    loadChats().then(renderDrawer);
    if (!here()) return;
    if (!chat) {
      state.chat = { chatId: reply.chatId, title: text.slice(0, 60) || 'Chat', provider, model, running: true };
      state.view = 'chat';
    } else chat.running = true;
    state.messages.push(sent);
    ui.text.value = '';
    clearFiles({ keepPreviews: true });
  } catch (error) {
    if (here()) state.composerError = errorLine(error, provider);
  } finally {
    state.sending = false;
    render();
  }
  if (!here()) return;
  await readChat();
  if (here() && !ui.text.disabled) ui.text.focus();
}

// The service holds a waiting file for one chat (or for a new chat: null) and only so many at once, so a draft's file
// keeps the id it got and a resend of that draft to the same chat reuses it; only a file without one is uploaded.
async function uploadFiles(items, target) {
  const fileIds = [];
  for (const item of items) {
    if (!item.fileId || item.fileFor !== target) {
      const { file } = item;
      const data = await readFile(file);
      const reply = await chatApi.file(target, { name: file.name, mime: file.type, size: file.size, data });
      item.fileId = reply.fileId;
      item.fileFor = target;
    }
    fileIds.push(item.fileId);
  }
  return fileIds;
}

// A chat wake still being delivered when agent_send answered: its outcome arrives in agent_chat's `sends`.
function applySends(sends) {
  for (const item of state.pending) {
    const wake = item.wakeId ? sends.find(send => send.wakeId === item.wakeId) : null;
    if (!wake || item.state !== 'sending') continue;
    if (wake.state === 'delivered') item.state = 'sent';
    else if (wake.state === 'failed') {
      item.state = 'failed';
      item.reason = wake.error?.message ?? 'the agent did not take it';
    }
  }
}

function sendAgent(item) {
  const agent = state.agent;
  item.state = 'sending';
  item.reason = null;
  item.wakeId = null;
  // Only a user message that arrives after this send can be its copy (unmatchedPending).
  item.before = new Set(state.agentMessages.map(message => message.id));
  render();
  chatApi.agentSend(agent.sessionId, item.text).then(reply => {
    item.wakeId = typeof reply.wakeId === 'string' ? reply.wakeId : null;
    item.state = ['queued', 'sent'].includes(reply.state) && item.wakeId ? 'sending' : 'sent';
  }, error => {
    item.state = 'failed';
    item.reason = error.message;
  }).finally(() => {
    if (state.agent === agent) {
      state.pending = unmatchedPending(state.pending, state.agentMessages);
      render();
    }
  });
}

function submit() {
  const text = ui.text.value.trim();
  if (state.sending || (!text && !state.files.length)) return;
  const problem = composerProblem(text, state.files.map(item => item.file));
  if (problem) {
    state.composerError = problem;
    renderComposer();
    return;
  }
  if (state.view === 'agent') {
    if (!text) return;
    ui.text.value = '';
    state.composerError = null;
    const item = { key: `p${Date.now()}`, text, at: new Date().toISOString(), state: 'sending' };
    state.pending.push(item);
    sendAgent(item);
    return;
  }
  if (!text) {
    state.composerError = 'Add a message to send with the files.';
    renderComposer();
    return;
  }
  sendChat(text);
}

async function stopTurn() {
  const chat = state.chat;
  if (!chat) return;
  ui.stop.disabled = true;
  try {
    await chatApi.stop(chat.chatId);
  } catch (error) {
    state.composerError = errorLine(error, chat.provider);
  }
  await readChat();
  ui.stop.disabled = false;
}

// --- attachments ----------------------------------------------------------------------------------------------------

function addFiles(list) {
  const incoming = [...list];
  const all = [...state.files.map(item => item.file), ...incoming];
  const problem = composerProblem('', all);
  if (problem) {
    state.composerError = problem;
    const room = Math.max(0, MAX_FILES - state.files.length);
    for (const file of incoming.filter(file => file.size <= 25 * 1024 * 1024).slice(0, room)) state.files.push(fileItem(file));
  } else {
    state.composerError = null;
    for (const file of incoming) state.files.push(fileItem(file));
  }
  renderComposer();
}

let fileCount = 0;
function fileItem(file) {
  const url = /^image\/(png|jpeg|gif|webp)$/.test(file.type) ? URL.createObjectURL(file) : null;
  if (url) state.previews.set(file.name, url);
  fileCount += 1;
  return { file, url, key: `f${fileCount}` };
}

function clearFiles({ keepPreviews = false } = {}) {
  if (!keepPreviews) {
    for (const item of state.files) if (item.url) URL.revokeObjectURL(item.url);
  }
  state.files = [];
}

function chip({ name, size, type }, { url = null, onRemove = null } = {}) {
  const node = element('li', 'chip');
  if (url) {
    const image = element('img', 'chip-preview');
    image.src = url;
    image.alt = '';
    node.append(image);
  } else {
    const extension = String(name).includes('.') ? String(name).split('.').pop().slice(0, 4) : (type || 'file').split('/')[0].slice(0, 4);
    node.append(element('span', 'chip-kind', extension));
  }
  node.append(element('span', 'chip-name', name), element('span', 'chip-size', formatSize(size)));
  node.title = name;
  if (onRemove) {
    const remove = element('button', 'chip-remove');
    remove.type = 'button';
    remove.setAttribute('aria-label', `Remove ${name}`);
    remove.append(icon('M5 5l10 10M15 5L5 15'));
    remove.addEventListener('click', onRemove);
    node.append(remove);
  }
  return node;
}

function icon(path) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('aria-hidden', 'true');
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  line.setAttribute('d', path);
  svg.append(line);
  return svg;
}

// --- keeping nodes --------------------------------------------------------------------------------------------------

// A poll redraws from state every 2 s, so a node whose content did not change stays the same node: focus, an open
// dropdown list and a text selection live on it. `entries`, in order: [{key, sig, build, update?}]. A child with the
// same key and sig is kept (`update` sets on it what may change in place); any other is built anew, and focus in the
// node it replaces moves to the same part (data-part) of the new one. Unchanged children at the front are not touched.
const kept = new WeakMap(); // node -> {key, sig}

function syncChildren(parent, entries) {
  const current = [...parent.children];
  const byKey = new Map(current.map(node => [kept.get(node)?.key, node]));
  const active = document.activeElement;
  let refocus = null;
  const nodes = entries.map(({ key, sig, build, update }) => {
    const old = byKey.get(key);
    byKey.delete(key);
    if (old && kept.get(old).sig === sig) {
      update?.(old);
      return old;
    }
    const node = build();
    kept.set(node, { key, sig });
    if (old?.contains(active)) refocus = active === old ? node : node.querySelector(`[data-part="${active.dataset.part}"]`);
    return node;
  });
  let same = 0;
  while (same < nodes.length && nodes[same] === current[same]) same += 1;
  if (same === nodes.length && same === current.length) return;
  for (const node of current.slice(same)) node.remove();
  parent.append(...nodes.slice(same));
  // A kept node that moved lost focus on the way.
  (refocus ?? (active !== document.activeElement && active?.isConnected ? active : null))?.focus();
}

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

// --- drawer ---------------------------------------------------------------------------------------------------------

function drawerShown() {
  return WIDE.matches ? !state.drawerCollapsed : state.drawerOpen;
}

function openDrawer() {
  if (WIDE.matches) state.drawerCollapsed = false;
  else state.drawerOpen = true;
  loadChats().then(renderDrawer);
  loadAgents().then(renderDrawer);
  renderDrawer();
  ui.newChat.focus();
}

function closeDrawer({ restore = true } = {}) {
  if (!state.drawerOpen && !(WIDE.matches && restore)) return renderDrawer();
  if (WIDE.matches) state.drawerCollapsed = true;
  state.drawerOpen = false;
  renderDrawer();
  if (restore) ui.toggle.focus();
}

function renderDrawer() {
  const shown = drawerShown();
  document.body.toggleAttribute('data-wide', WIDE.matches);
  ui.drawer.hidden = !shown;
  ui.scrim.hidden = !shown || WIDE.matches;
  ui.toggle.setAttribute('aria-expanded', String(shown));
  ui.toggle.setAttribute('aria-label', shown ? 'Close menu' : 'Open menu');

  syncChildren(ui.chatList, state.chats.map(chat => {
    const current = state.view === 'chat' && state.chat?.chatId === chat.chatId;
    const line = `${providerName(chat.provider)} · ${relativeTime(chat.lastActiveAt)}${chat.running ? ' · running' : ''}`;
    return { key: chat.chatId, sig: JSON.stringify([chat.title, line, Boolean(chat.running), current]), build: () => chatRow(chat, line, current) };
  }));
  ui.chatsEmpty.hidden = state.chats.length > 0;
  ui.moreChats.hidden = state.chatsNext === null;

  const agents = [...state.agents].sort((a, b) => (b.sessionId === state.suggested?.sessionId) - (a.sessionId === state.suggested?.sessionId));
  syncChildren(ui.agentList, agents.map(agentEntry));
  ui.agentsEmpty.hidden = state.agents.length > 0;
}

function chatRow(chat, line, current) {
  const row = element('li', 'drawer-row');
  if (current) row.setAttribute('aria-current', 'true');
  const open = element('button', 'drawer-open');
  open.type = 'button';
  open.dataset.chatId = chat.chatId;
  open.dataset.part = 'open';
  const meta = element('span', 'drawer-open-meta');
  if (chat.running) meta.append(element('span', 'running-mark'));
  meta.append(line);
  open.append(element('span', 'drawer-open-title', chat.title || 'Chat'), meta);
  open.addEventListener('click', () => openChat(chat.chatId));
  const remove = element('button', 'drawer-delete', 'Delete');
  remove.type = 'button';
  remove.dataset.part = 'delete';
  remove.setAttribute('aria-label', `Delete chat ${chat.title || 'Chat'}`);
  remove.addEventListener('click', () => confirmDelete(chat));
  row.append(open, remove);
  return row;
}

function agentEntry(agent) {
  const current = state.view === 'agent' && state.agent?.sessionId === agent.sessionId;
  const blocked = agentBlockedLine(agent);
  const line = blocked
    ?? (agent.sessionId === state.suggested?.sessionId && state.suggested.why === 'task' ? 'Working in this window' : relativeTime(agent.lastActiveAt));
  return { key: agent.sessionId, sig: JSON.stringify([agentLabel(agent), line, Boolean(blocked), current]),
    build: () => agentRow(agent, line, Boolean(blocked), current) };
}

function agentRow(agent, line, blocked, current) {
  const row = element('li', 'drawer-row');
  if (current) row.setAttribute('aria-current', 'true');
  const open = element('button', 'drawer-open');
  open.type = 'button';
  open.dataset.sessionId = agent.sessionId;
  open.dataset.part = 'open';
  const meta = element('span', 'drawer-open-meta', line);
  if (blocked) meta.dataset.blocked = '';
  open.append(element('span', 'drawer-open-title', agentLabel(agent)), meta);
  open.addEventListener('click', () => openAgent(agent.sessionId));
  row.append(open);
  return row;
}

// --- delete ---------------------------------------------------------------------------------------------------------

function confirmDelete(chat) {
  const name = providerName(chat.provider);
  ui.confirmText.textContent = `“${chat.title || 'Chat'}” and its attached files are removed from FAI-Local-Chats. `
    + `${name} keeps its own copy of the conversation; FAI does not remove it.`;
  const opener = document.activeElement;
  ui.confirm.returnValue = '';
  ui.confirm.onclose = async () => {
    if (ui.confirm.returnValue !== 'delete') {
      opener?.focus?.();
      return;
    }
    try {
      await chatApi.remove(chat.chatId);
    } catch (error) {
      setNotice(error.message);
    }
    if (state.chat?.chatId === chat.chatId) newChat();
    await loadChats();
    renderDrawer();
    (drawerShown() ? ui.newChat : ui.text).focus();
  };
  ui.confirm.showModal();
  document.getElementById('confirm-cancel').focus();
}

// --- settings -------------------------------------------------------------------------------------------------------

async function openSettings({ note = null, focusProvider = null } = {}) {
  state.settingsOpen = true;
  state.settingsNote = note;
  closeDrawer({ restore: false });
  renderSettings();
  render();
  // The lists are read live each time settings open (spec #84 "Browser Chat settings").
  await Promise.all(availableProviders(state.providers).map(async provider => {
    state.models[provider] = await chatApi.models(provider).then(reply => ({ models: Array.isArray(reply.models) ? reply.models : [] }),
      error => ({ error: error.message }));
  }));
  renderSettings();
  const target = focusProvider ? ui.settingsBody.querySelector(`[data-model-provider="${focusProvider}"]`) : null;
  (target ?? ui.settingsTitle).focus();
}

function closeSettings({ restore = true } = {}) {
  if (!state.settingsOpen) return;
  state.settingsOpen = false;
  state.settingsNote = null;
  render();
  if (restore) (state.view === 'none' || state.view === 'offline' ? ui.toggle : ui.text.disabled ? ui.toggle : ui.text).focus();
}

async function saveSettings(change) {
  const next = normalizeSettings({ ...state.settings, ...change, models: { ...state.settings.models, ...change.models } });
  const previous = state.settings;
  state.settings = next;
  applyTheme();
  ui.settingsStatus.textContent = 'Saving…';
  delete ui.settingsStatus.dataset.error;
  try {
    const reply = await chatApi.saveSettings(next);
    if (reply.settings) state.settings = normalizeSettings(reply.settings);
    applyTheme();
    ui.settingsStatus.textContent = 'Saved.';
  } catch (error) {
    state.settings = previous;
    applyTheme();
    ui.settingsStatus.textContent = error.message;
    ui.settingsStatus.dataset.error = '';
  }
  if (state.view === 'new' && !state.chat) {
    state.newProvider = defaultProvider(state.providers, state.settings);
    state.newModel = state.newProvider ? state.settings.models[state.newProvider] ?? '' : '';
  }
  renderSettings();
  renderHeader();
}

function settingField(labelText, control, help) {
  const wrap = element('div', 'setting');
  const label = element('label', 'setting-label', labelText);
  const id = `set-${Math.random().toString(36).slice(2, 9)}`;
  control.id = id;
  label.htmlFor = id;
  wrap.append(label, control);
  if (help) {
    const line = element('p', 'setting-help', help);
    line.id = `${id}-help`;
    control.setAttribute('aria-describedby', line.id);
    wrap.append(line);
  }
  return wrap;
}

function option(value, text, selected) {
  const node = element('option', '', text);
  node.value = value;
  node.selected = selected;
  return node;
}

const OTHER = '\u0000other';

function modelSetting(provider) {
  const name = providerName(provider);
  const current = state.settings.models[provider] ?? '';
  const listed = state.models[provider];
  const info = state.providers.find(item => item.provider === provider);
  const available = info?.available === true;
  const typed = element('input');
  typed.type = 'text';
  typed.spellcheck = false;
  typed.autocomplete = 'off';
  typed.placeholder = provider === 'opencode' ? 'provider/model' : 'Model name';
  typed.setAttribute('aria-label', `${name} model name`);
  typed.dataset.setting = `typed-${provider}`;
  typed.value = current;
  typed.addEventListener('change', () => saveSettings({ models: { [provider]: typed.value.trim() || null } }));
  const select = element('select');
  select.dataset.modelProvider = provider;
  select.dataset.setting = `model-${provider}`;
  const models = listed?.models ?? [];
  const isOther = Boolean(current) && !models.includes(current);
  select.append(option('', provider === 'opencode' ? 'None chosen' : `${name}'s own default`, !current));
  for (const model of models) select.append(option(model, model, model === current));
  select.append(option(OTHER, 'Another model (type its name)', isOther));
  select.addEventListener('change', () => {
    if (select.value === OTHER) {
      typed.hidden = false;
      typed.focus();
      return;
    }
    saveSettings({ models: { [provider]: select.value || null } });
  });
  let help;
  if (!available) help = info?.line ?? '';
  else if (listed?.error) help = `${name} did not list its models. Type a model name.`;
  else if (!listed) help = 'Reading the list…';
  else help = provider === 'opencode' ? 'OpenCode needs a model to chat.' : `Empty: ${name} picks its own default.`;
  // Listing failed: the picker takes a typed name (spec #84).
  const field = settingField(`${name} model`, listed?.error ? typed : select, help);
  if (!listed?.error) {
    typed.hidden = !isOther;
    field.insertBefore(typed, field.querySelector('.setting-help'));
  } else typed.dataset.modelProvider = provider;
  return field;
}

function renderSettings() {
  if (!state.settingsOpen) return;
  // Every control is rebuilt; the one that had focus gets it back, so a keyboard user can keep stepping through a
  // radio group or a select (spec #84 "Appearance and quality").
  const focused = ui.settingsBody.contains(document.activeElement) ? document.activeElement.dataset.setting : null;
  const nodes = [];
  if (state.settingsNote) {
    const note = element('p', 'notice', state.settingsNote);
    note.setAttribute('role', 'note');
    nodes.push(note);
  }
  const available = availableProviders(state.providers);
  const provider = element('select');
  provider.dataset.setting = 'default-provider';
  if (available.length) {
    const chosen = defaultProvider(state.providers, state.settings);
    for (const id of available) provider.append(option(id, providerName(id), id === chosen));
    provider.addEventListener('change', () => saveSettings({ defaultProvider: provider.value }));
  } else {
    provider.append(option('', 'None available', true));
    provider.disabled = true;
  }
  nodes.push(settingField('Default provider', provider, 'New chats start with this one. You can pick another before the first message.'));
  for (const id of PROVIDER_ORDER) nodes.push(modelSetting(id));

  const appearance = element('fieldset', 'setting');
  appearance.append(element('legend', '', 'Appearance'));
  const group = element('div', 'segmented');
  for (const value of APPEARANCES) {
    const label = element('label');
    const input = element('input');
    input.type = 'radio';
    input.name = 'appearance';
    input.value = value;
    input.dataset.setting = `appearance-${value}`;
    input.checked = state.settings.appearance === value;
    input.addEventListener('change', () => saveSettings({ appearance: value }));
    label.append(input, element('span', '', value[0].toUpperCase() + value.slice(1)));
    group.append(label);
  }
  appearance.append(group);
  nodes.push(appearance);
  ui.settingsBody.replaceChildren(...nodes);
  if (focused) ui.settingsBody.querySelector(`[data-setting="${focused}"]`)?.focus();
}

// --- rendering ------------------------------------------------------------------------------------------------------

function setNotice(text) {
  setText(ui.notice, text ?? '');
  ui.notice.hidden = !text;
}

function metaSelect(label, options, value, onChange, className = 'meta-select') {
  const select = element('select', className);
  select.setAttribute('aria-label', label);
  for (const [optionValue, text] of options) select.append(option(optionValue, text, optionValue === value));
  select.addEventListener('change', () => onChange(select.value));
  return select;
}

// `reported`: the model the program chose itself, as it named it in its output (spec #84 "Defaults").
function modelOptions(provider, current, reported = null) {
  const listed = state.models[provider]?.models ?? [];
  const fallback = provider === 'opencode' ? 'Choose a model' : 'Default model';
  const options = [['', typeof reported === 'string' && reported ? `Default (${reported.slice(0, 60)})` : fallback]];
  for (const model of new Set([...listed, ...(current ? [current] : [])])) options.push([model, model]);
  return options;
}

function ensureModels(provider) {
  if (!provider || state.models[provider]) return;
  state.models[provider] = { loading: true };
  chatApi.models(provider).then(reply => ({ models: Array.isArray(reply.models) ? reply.models : [] }), error => ({ error: error.message }))
    .then(result => {
      state.models[provider] = result;
      renderHeader();
    });
}

// The chat's dropdowns sit at the right of the title's row; plain text about the chat stays under the title.
// A dropdown is kept across renders while its options stay the same, so a poll leaves it open and focused.
function selectEntry(key, label, options, value, onChange, className) {
  return { key, sig: JSON.stringify(options), build: () => metaSelect(label, options, value, onChange, className),
    update: select => { if (select.value !== value) select.value = value; } };
}

function renderHeader() {
  let meta = null;
  const controls = [];
  if (state.settingsOpen) {
    setText(ui.title, 'Settings');
  } else if (state.view === 'new') {
    setText(ui.title, 'New chat');
    ensureModels(state.newProvider);
    const providers = availableProviders(state.providers).map(id => [id, providerName(id)]);
    // The provider's name shows in full; the model takes the shrink when the row is short (decision #45, 320 px).
    controls.push(selectEntry('new-provider', 'Provider for this chat', providers, state.newProvider, value => {
      state.newProvider = value;
      state.newModel = state.settings.models[value] ?? '';
      render();
    }, 'meta-select meta-select-fixed'));
    controls.push(selectEntry(`new-model-${state.newProvider}`, 'Model for this chat', modelOptions(state.newProvider, state.newModel), state.newModel, value => {
      state.newModel = value;
    }));
  } else if (state.view === 'chat' && state.chat) {
    setText(ui.title, state.chat.title || 'Chat');
    ensureModels(state.chat.provider);
    meta = providerName(state.chat.provider);
    // A chat keeps its provider; its model can change and applies from the next turn (spec #84).
    const chat = state.chat;
    // The kept dropdown outlives this render, so its change reads the chat open then.
    controls.push(selectEntry(`chat-model-${chat.chatId}`, 'Model for this chat', modelOptions(chat.provider, chat.model, chat.reportedModel), chat.model ?? '', value => {
      const open = state.chat;
      open.model = value || null;
      chatApi.setModel(open.chatId, value || null).catch(error => setNotice(error.message));
    }));
  } else if (state.view === 'agent' && state.agent) {
    setText(ui.title, agentLabel(state.agent));
    meta = `Open agent · ${HOST_NAMES[state.agent.host] ?? 'Agent'}`;
  } else {
    setText(ui.title, 'FAI Chat');
  }
  syncChildren(ui.meta, meta ? [{ key: 'meta', sig: meta, build: () => element('span', 'meta-text', meta) }] : []);
  ui.meta.hidden = !meta;
  syncChildren(ui.headerControls, controls);
}

function messageNode(message, provider) {
  const node = element('li', 'message');
  node.dataset.role = ['user', 'agent', 'fai'].includes(message.role) ? message.role : 'fai';
  if (message.role === 'fai' && typeof message.code === 'string') {
    // FAI's own fixed line, then the program's own words for a turn it failed (decision #28): plain text, clipped,
    // and marked as the provider's.
    node.dataset.kind = 'error';
    node.append(element('span', '', reasonLine(message.code, provider, { exit: message.exit }) ?? String(message.text || 'This turn failed.')));
    if (message.code === 'chat_turn_failed' && message.providerText) {
      node.append(element('span', 'provider-said-label', `${providerName(provider)} said:`),
        element('p', 'provider-said', String(message.providerText).slice(0, MAX_PROVIDER_TEXT)));
    }
    if (failedTurn(message) && state.view === 'chat') node.append(newChatAction(message));
    return node;
  }
  if (node.dataset.role === 'fai') {
    node.textContent = faiLine(message.text);
    node.title = node.textContent;
    return node;
  }
  if (node.dataset.role === 'agent') node.append(element('span', 'message-who', state.view === 'agent' ? HOST_NAMES[state.agent?.host] ?? 'Agent' : providerName(provider)));
  node.append(document.createTextNode(String(message.text ?? '')));
  const files = Array.isArray(message.files) ? message.files : [];
  if (files.length) {
    const list = element('ul', 'message-files');
    list.setAttribute('aria-label', 'Attached files');
    list.append(...files.map(file => chip(file, { url: /^image\//.test(file.type ?? '') ? state.previews.get(file.name) : null })));
    node.append(list);
  }
  return node;
}

// A failed turn's one action (decision #48). It reads the chat open when clicked: the row outlives the render that
// built it.
function newChatAction(message) {
  const line = element('span', 'message-action');
  const button = element('button', 'link-button', 'Start a new chat');
  button.type = 'button';
  button.dataset.part = 'new-chat';
  button.addEventListener('click', () => {
    const chat = state.chat;
    if (!chat) return;
    newChat({ focus: true, from: { provider: chat.provider, model: chat.model ?? null, text: retryText(state.messages, message.id) } });
  });
  line.append(button);
  return line;
}

function pendingNode(item) {
  const node = element('li', 'message');
  node.dataset.role = 'user';
  node.dataset.pending = item.state;
  node.append(document.createTextNode(item.text));
  const line = element('span', 'message-state');
  line.dataset.state = item.state;
  if (item.state === 'sending') line.textContent = 'Sending…';
  else if (item.state === 'sent') line.textContent = 'Sent';
  else {
    line.textContent = `Not delivered: ${item.reason ?? 'unknown reason'}`;
    const retry = element('button', 'link-button', 'Retry');
    retry.type = 'button';
    retry.dataset.part = 'retry';
    retry.addEventListener('click', () => sendAgent(item));
    line.append(retry);
  }
  node.append(line);
  return node;
}

function emptyView() {
  const nodes = [];
  if (state.view === 'offline') {
    nodes.push(element('p', 'empty-title', 'FAI is not connected'),
      element('p', 'empty-text', 'Open the FAI Browser popup from the toolbar to pair, then reopen this panel.'));
    return nodes;
  }
  if (state.view === 'loading') return [element('p', 'empty-text', 'Loading…')];
  if (state.view === 'new') {
    nodes.push(element('p', 'empty-title', 'Start a chat'),
      element('p', 'empty-text', `Ask about the page beside this panel, or anything else. ${providerName(state.newProvider)} answers here and works in your browser only through FAI.`));
    return nodes;
  }
  // No provider available: the three providers with their fix lines, and the open agents if any (spec #84).
  nodes.push(element('p', 'empty-title', 'No chat provider is ready'),
    element('p', 'empty-text', 'FAI chats use a coding app already on this computer. Do one of these, then reopen this panel.'));
  const list = element('ul', 'provider-list');
  for (const id of PROVIDER_ORDER) {
    const info = state.providers.find(item => item.provider === id);
    const row = element('li', 'provider-row');
    // The service's own name and fixed fix line, shown as is.
    row.append(element('span', 'provider-row-name', info?.name ?? providerName(id)),
      element('span', 'provider-row-fix', info?.line ?? ''));
    list.append(row);
  }
  nodes.push(list);
  if (state.agents.length) {
    nodes.push(element('p', 'drawer-section', 'Open agents'));
    const agents = element('ul', 'drawer-list');
    agents.append(...state.agents.map(agent => agentEntry(agent).build()));
    nodes.push(agents);
  }
  return nodes;
}

function renderComposer() {
  const agent = state.view === 'agent';
  const running = state.view === 'chat' && state.chat?.running === true;
  const blocked = agent ? agentBlockedLine(state.agent) ?? readableLine(state.readable, state.agent)?.blocks : null;
  const usable = ['new', 'chat', 'agent'].includes(state.view);
  ui.composer.hidden = !usable;
  // While a turn runs the composer is disabled and Stop replaces Send (spec #84 "Layout").
  const locked = state.sending || running || (agent && (state.ended || Boolean(blocked)));
  ui.text.disabled = locked;
  ui.attach.hidden = agent;
  ui.attach.disabled = locked;
  ui.send.hidden = running;
  ui.send.disabled = locked;
  ui.stop.hidden = !running;
  ui.text.placeholder = agent ? `Message ${HOST_NAMES[state.agent?.host] ?? 'the agent'}` : running ? 'Waiting for the reply…' : 'Message';
  syncChildren(ui.chips, state.files.map(item => ({ key: item.key, sig: '', build: () => chip(item.file, { url: item.url, onRemove: () => {
    if (item.url) URL.revokeObjectURL(item.url);
    state.files.splice(state.files.indexOf(item), 1);
    state.composerError = null;
    renderComposer();
    ui.attach.focus();
  } }) })));
  ui.chips.hidden = state.files.length === 0;
  setText(ui.attachHint, `Attached files go to ${providerName(state.chat?.provider ?? state.newProvider)}'s service under your account, like your message.`);
  ui.composer.dataset.files = state.files.length ? 'yes' : 'no';
  setText(ui.composerError, state.composerError ?? '');
  ui.composerError.hidden = !state.composerError;
}

function render() {
  applyTheme();
  renderHeader();
  renderDrawer();
  ui.settings.hidden = !state.settingsOpen;
  ui.header.hidden = state.settingsOpen;
  ui.conversation.hidden = state.settingsOpen;
  if (state.settingsOpen) return;

  const nearBottom = ui.scroller.scrollHeight - ui.scroller.scrollTop - ui.scroller.clientHeight < 60;
  const conversation = state.view === 'chat' || state.view === 'agent';
  const messages = state.view === 'agent' ? state.agentMessages : state.messages;
  const provider = state.chat?.provider ?? state.newProvider;
  const who = state.view === 'agent' ? state.agent?.host : provider;
  const entries = conversation ? messages.map((message, index) => ({ key: `m:${message.id ?? index}`,
    sig: JSON.stringify([message, who]), build: () => messageNode(message, provider) })) : [];
  if (state.view === 'agent') {
    entries.push(...state.pending.map(item => ({ key: `p:${item.key}`, sig: JSON.stringify([item.text, item.state, item.reason]),
      build: () => pendingNode(item) })));
  }
  syncChildren(ui.messages, entries);
  ui.messages.hidden = entries.length === 0;
  ui.empty.replaceChildren(...(conversation ? [] : emptyView()));
  ui.empty.hidden = conversation;
  // Browsing… under the last message while the agent works (spec #80); the text stays with reduced motion.
  ui.browsing.hidden = !(state.view === 'agent' ? state.busy && !state.ended : state.view === 'chat' && state.chat?.running);

  if (state.view === 'agent') {
    const lines = [];
    if (state.ended) lines.push('This agent session has ended.');
    else {
      const blocked = agentBlockedLine(state.agent);
      const unread = readableLine(state.readable, state.agent);
      if (unread && unread.text !== blocked) lines.push(unread.text);
      if (blocked) lines.push(blocked);
    }
    if (lines.length) setNotice(lines.join(' '));
  }
  renderComposer();
  if (nearBottom) ui.scroller.scrollTop = ui.scroller.scrollHeight;
}

// --- events ---------------------------------------------------------------------------------------------------------

ui.toggle.addEventListener('click', () => (drawerShown() ? closeDrawer() : openDrawer()));
ui.drawerClose.addEventListener('click', () => closeDrawer());
ui.scrim.addEventListener('click', () => closeDrawer());
ui.newChat.addEventListener('click', () => newChat({ focus: true }));
ui.moreChats.addEventListener('click', () => loadChats(state.chatsNext ?? 0).then(renderDrawer));
ui.openSettings.addEventListener('click', () => openSettings());
ui.settingsBack.addEventListener('click', () => closeSettings());
ui.attach.addEventListener('click', () => ui.fileInput.click());
ui.fileInput.addEventListener('change', () => {
  addFiles(ui.fileInput.files ?? []);
  ui.fileInput.value = '';
});
ui.composer.addEventListener('submit', event => {
  event.preventDefault();
  submit();
});
ui.stop.addEventListener('click', stopTurn);
ui.text.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    submit();
  }
});
ui.text.addEventListener('input', () => {
  ui.text.style.height = 'auto';
  ui.text.style.height = `${Math.min(ui.text.scrollHeight + 2, 160)}px`;
  if (state.composerError) {
    state.composerError = null;
    renderComposer();
  }
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || ui.confirm.open) return;
  if (state.settingsOpen) {
    event.preventDefault();
    closeSettings();
  } else if (state.drawerOpen && !WIDE.matches) {
    event.preventDefault();
    closeDrawer();
  }
});
WIDE.addEventListener('change', () => {
  state.drawerOpen = false;
  renderDrawer();
});
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
setInterval(poll, POLL_MS);

await start();
