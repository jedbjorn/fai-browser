// The chat panel's pure rules (extension/panel.js): which provider and which open agent are chosen by default, the
// fixed FAI-written line for each reason code, message limits, and how a sent message is matched to the one the host
// later writes. No DOM and no browser API here, so the rules are tested directly (test/chat-panel.test.js).
import { WAKE_REASON_TEXT } from './invite-card.js';

// The order a new chat's provider is chosen in (spec #84 "Defaults"; FnB, 2026-11-16).
export const PROVIDER_ORDER = Object.freeze(['codex', 'claude', 'opencode']);
export const PROVIDER_NAMES = Object.freeze({ codex: 'Codex', claude: 'Claude', opencode: 'OpenCode' });

export const MAX_TEXT = 4000;
export const MAX_FILES = 10;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
// The provider's own error text, as the daemon passes it on chat_turn_failed (decision #28): plain text, clipped.
export const MAX_PROVIDER_TEXT = 1000;
export const CHATS_PAGE = 50;
export const APPEARANCES = Object.freeze(['system', 'light', 'dark']);

export function providerName(provider) {
  return PROVIDER_NAMES[provider] ?? 'Provider';
}

/**
 * FAI's own line for a reason code (spec #84 "Availability"): one fixed sentence naming the fix. `exit` is the exit
 * status of a turn the program failed. Unknown codes get a generic line; nothing the daemon sends is shown as the line.
 */
export function reasonLine(code, provider, { exit = null } = {}) {
  const name = providerName(provider);
  switch (code) {
    case 'chat_not_installed': return `Install ${name} to chat with it here.`;
    case 'chat_signed_out': return `Sign in to the ${name} command line once, then try again.`;
    case 'chat_unsupported_version': return `Update ${name} to chat with it here.`;
    case 'chat_no_model': return 'Choose an OpenCode model in Settings to chat with OpenCode.';
    case 'chat_start_failed': return `${name} could not be started.`;
    case 'chat_stopped': return 'Stopped.';
    case 'chat_timed_out': return 'This turn ran for 30 minutes and was stopped.';
    case 'chat_too_many': return 'Three chats are already running. Wait for one to finish, or stop one.';
    case 'chat_turn_failed': return `${name} could not finish this turn${Number.isInteger(exit) ? ` (exit ${exit})` : ''}.`;
    default: return 'Something went wrong. Try again.';
  }
}

/** The available providers in PROVIDER_ORDER. */
export function availableProviders(providers) {
  const list = Array.isArray(providers) ? providers : [];
  return PROVIDER_ORDER.filter(id => list.some(item => item?.provider === id && item.available === true));
}

/** A new chat's provider: the user's default when it is available, else the first available one; null when none. */
export function defaultProvider(providers, settings) {
  const available = availableProviders(providers);
  const chosen = settings?.defaultProvider;
  return available.includes(chosen) ? chosen : available[0] ?? null;
}

/** OpenCode is the only provider and no OpenCode model is set: New chat opens Settings on its model list first. */
export function needsOpenCodeModel(providers, settings) {
  const available = availableProviders(providers);
  return available.length === 1 && available[0] === 'opencode' && !settings?.models?.opencode;
}

/**
 * The open agent the panel chooses by default (spec #80 "Panel"): the owner of a task tab in this window, else the
 * only live session, else none (the user picks). `requests` are the worker's request views, `windowTabIds` the ids of
 * this window's tabs. Returns {sessionId, why: 'task' | 'only'} or null.
 */
export function defaultAgent(sessions, requests, windowTabIds) {
  const live = Array.isArray(sessions) ? sessions : [];
  const tabs = new Set(windowTabIds ?? []);
  for (const request of Array.isArray(requests) ? requests : []) {
    if (!['active', 'paused'].includes(request?.state) || !tabs.has(request.lease?.tabId)) continue;
    const owner = live.find(session => session.sessionId === request.owner?.sessionId);
    if (owner) return { sessionId: owner.sessionId, why: 'task' };
  }
  return live.length === 1 ? { sessionId: live[0].sessionId, why: 'only' } : null;
}

/**
 * Why an open agent cannot be read or written to yet, in a fixed line, or null when it can (spec #80: a Codex or
 * OpenCode session before its first FAI call, or wake capability none).
 */
export function agentBlockedLine(session) {
  if (['codex', 'opencode'].includes(session?.host) && session.ready === false) {
    return 'This agent is not ready yet. Ask it to run any FAI command.';
  }
  if (session?.wake === 'none' || (session?.wakeReason && session.wakeReason !== 'ok')) {
    return Object.hasOwn(WAKE_REASON_TEXT, session.wakeReason) && session.wakeReason !== 'ok'
      ? WAKE_REASON_TEXT[session.wakeReason] : 'FAI cannot send messages to this agent.';
  }
  return null;
}

/** "Can't read this conversation (Codex 0.169.0). …": the line for a reader that cannot find or parse its source. */
export function unreadableLine(readable, hostName) {
  const version = typeof readable?.version === 'string' && readable.version ? ` ${readable.version.slice(0, 40)}` : '';
  return `Can't read this conversation (${hostName}${version}). Messages you send still reach the agent.`;
}

/** The composer's refusal for `text` and `files` ({name, size}), or null when it may be sent. */
export function composerProblem(text, files = []) {
  const length = [...String(text ?? '')].length;
  if (length > MAX_TEXT) return `Messages are limited to ${MAX_TEXT.toLocaleString('en-US')} characters (this one has ${length.toLocaleString('en-US')}).`;
  if (files.length > MAX_FILES) return `Attach up to ${MAX_FILES} files per message.`;
  const big = files.find(file => file.size > MAX_FILE_BYTES);
  if (big) return `${big.name} is larger than 25 MB.`;
  return null;
}

/** 1.2 MB, 340 KB, 12 bytes. */
export function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** "just now", "5 min ago", "3 h ago", or a date. */
export function relativeTime(at, now = Date.now()) {
  const time = Date.parse(at ?? '');
  if (!Number.isFinite(time)) return '';
  const ms = now - time;
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)} h ago`;
  return new Date(time).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/** A FAI wake text as one short line: "[FAI Browser] Approved …" -> "FAI: Approved …". */
export function faiLine(text) {
  const line = String(text ?? '').replace(/^\[FAI Browser\]\s*/, '').split('\n')[0].trim();
  return `FAI: ${line}`;
}

/**
 * Messages sent from the panel that the host has not written yet (spec #80 "Sending"): a pending message is dropped
 * once a user message with the same text appears in `messages` after it was sent, so it never shows twice.
 */
export function unmatchedPending(pending, messages) {
  const written = (messages ?? []).filter(message => message.role === 'user').map(message => message.text);
  return (pending ?? []).filter(item => {
    if (item.state !== 'sent') return true;
    const index = written.indexOf(item.text);
    if (index < 0) return true;
    written.splice(index, 1);
    return false;
  });
}
