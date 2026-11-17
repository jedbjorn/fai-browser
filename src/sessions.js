// The daemon's registry of live coding-agent sessions (one entry per running fai-browser-mcp process) and the wake
// queue addressed to them. An MCP server registers after initialize, holds a long-poll for wakes (which doubles as its
// heartbeat), reports each wake's outcome, and unregisters when its stdio closes. Entries whose process is gone or that
// stopped polling are dropped. Each entry has a random key only its MCP server knows: polls, reports and updates
// need it, so a session only ever receives the wakes addressed to it. Views never carry the key.
//
// The FAI chat panel (spec #80) watches one session at a time per panel: while it is watched, the session's long poll
// also asks its MCP server to read its own conversation (chatRead, with the last cursor), and the messages it posts
// back are kept here, in memory only, the newest CHAT_KEEP of them, until the watch ends. They never reach a log.
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { CHAT_KEEP, clipText } from './chat.js';
import { WAKE_REASONS, cleanBundleItems } from './wake.js';

export const SESSION_POLL_MAX_MS = 25_000;
// A session that has not polled for this long (and has no poll open) is gone.
export const SESSION_STALE_MS = 90_000;
// A wake nobody picked up (no poll open) fails after this long; one picked up but never reported, after REPORT_MS.
export const WAKE_PICKUP_MS = 10_000;
export const WAKE_REPORT_MS = 25_000;
export const MAX_SESSIONS = 32;
export const WAKES_PER_POLL = 4;
// One MCP server process registers once (again only after the daemon forgot it); two per pid allows that overlap.
export const MAX_SESSIONS_PER_PID = 2;
// A dropped session's key is remembered this long, so the same MCP server can come back as itself (`previous`).
const TOMBSTONE_MS = 60 * 60_000;
// A watch ends this long after the panel's last read (it reads about every 2 s while open).
export const CHAT_WATCH_MS = 30_000;
const CHAT_ROLES = new Set(['user', 'agent', 'fai']);
const CHAT_ERRORS = new Set(['unreadable', 'not_ready', 'ambiguous_session']);
const CHAT_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const WAKE_KEEP_MS = 10 * 60_000;
const HOSTS = new Set(['claude', 'codex', 'opencode', 'unknown']);
// fai-chat: an MCP server started inside a FAI chat turn (spec #84), bound to its chat by the turn token. The daemon
// wakes the chat with a new turn; nothing is delivered through this server's poll.
const CAPABILITIES = new Set(['claude-socket', 'codex-queue', 'opencode-plugin', 'fai-chat', 'none']);
const CHAT_REPO = 'FAI chat';
const REASONS = new Set(WAKE_REASONS);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export class SessionError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const digest = value => createHash('sha256').update(String(value)).digest();
const iso = ms => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

/** Whether process `pid` is alive (same user): ESRCH means gone, EPERM means alive but not ours. */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function cleanRepo(value) {
  const text = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f/\\]/g, '').trim().slice(0, 60) : '';
  return text || 'unknown';
}

/**
 * `options`: now (ms clock), log(event, fields), isAlive(pid), onChange() (a session or wake changed: views to
 * republish, invites to update), staleMs, pickupMs, reportMs (test overrides).
 */
export function createSessionRegistry(options = {}) {
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  const isAlive = options.isAlive ?? pidAlive;
  const onChange = options.onChange ?? (() => {});
  const staleMs = options.staleMs ?? SESSION_STALE_MS;
  const pickupMs = options.pickupMs ?? WAKE_PICKUP_MS;
  const reportMs = options.reportMs ?? WAKE_REPORT_MS;
  const chatWatchMs = options.chatWatchMs ?? CHAT_WATCH_MS;
  const sessions = new Map();
  // Every kept chat message's number, across watches: a panel's `after` from an earlier watch is never mistaken.
  let chatSeq = 0;
  const wakes = new Map();
  // Dropped or unregistered sessions: {keyDigest, at} by session id (see `previous` in register).
  const tombstones = new Map();

  const changed = () => {
    try {
      onChange();
    } catch (error) {
      log('sessions_change_error', { message: String(error?.message ?? error).slice(0, 200) });
    }
  };

  function view(session) {
    return {
      sessionId: session.sessionId,
      host: session.host,
      repo: session.repo,
      pid: session.pid,
      startedAt: iso(session.startedAt),
      registeredAt: iso(session.registeredAt),
      lastSeenAt: iso(session.lastSeenAt),
      lastToolCallAt: iso(session.lastToolCallAt),
      // The newest sign of use: the last tool call, else registration.
      lastActiveAt: iso(Math.max(session.lastToolCallAt ?? 0, session.registeredAt)),
      wake: session.wake,
      wakeReason: session.wakeReason,
      // A Codex or OpenCode session can be woken only once its session id is known (its first FAI tool call).
      ready: session.wake !== 'none' || !['codex', 'opencode'].includes(session.host) || Boolean(session.hostSessionId),
    };
  }

  function wakeView(wake) {
    return { wakeId: wake.wakeId, sessionId: wake.sessionId, kind: wake.kind, requestId: wake.requestId ?? null,
      inviteId: wake.inviteId ?? null, state: wake.state, error: wake.error ?? null, detail: wake.detail ?? null,
      createdAt: iso(wake.createdAt),
      settledAt: iso(wake.settledAt ?? null) };
  }

  /**
   * `chat`: {chatId, turnId} when the daemon accepted this server's turn token (the runner's claimToken): the session
   * belongs to that chat, its capability is fai-chat whatever the server says, and it keeps the chat across a
   * re-registration as itself (`previous`).
   */
  function register(body = {}, { chat = null } = {}) {
    const host = HOSTS.has(body.host) ? body.host : 'unknown';
    // fai-chat only ever comes from the daemon's own check of a turn token.
    const wake = CAPABILITIES.has(body.wake) && body.wake !== 'fai-chat' ? body.wake : 'none';
    const pid = Number.isInteger(body.pid) && body.pid > 0 ? body.pid : null;
    if (!pid) throw new SessionError(400, 'invalid_options', 'pid must be the MCP server process id');
    const startedAt = Date.parse(body.startedAt ?? '');
    sweep();
    if (sessions.size >= MAX_SESSIONS) {
      throw new SessionError(429, 'too_many_sessions', `At most ${MAX_SESSIONS} agent sessions can register at once`);
    }
    if ([...sessions.values()].filter(item => item.pid === pid).length >= MAX_SESSIONS_PER_PID) {
      throw new SessionError(429, 'too_many_sessions', 'This process already registered');
    }
    // `previous`: the id and key this MCP server held before the daemon dropped it; proven by the key, it takes its
    // requests and invites back (the daemon's transferOwner).
    let replaced = null;
    let chatId = chat?.chatId ?? null;
    const previous = body.previous;
    if (previous && typeof previous === 'object' && typeof previous.sessionId === 'string' && typeof previous.key === 'string') {
      const stone = tombstones.get(previous.sessionId);
      // The same process only: the key proves the id, the pid that it is still the same MCP server.
      if (stone && stone.pid === pid && timingSafeEqual(digest(previous.key), stone.keyDigest)) {
        replaced = previous.sessionId;
        chatId ??= stone.chatId ?? null;
        tombstones.delete(previous.sessionId);
      }
    }
    const session = {
      sessionId: `ses_${randomBytes(9).toString('base64url')}`,
      keyDigest: null,
      host,
      hostSessionId: ID.test(String(body.hostSessionId ?? '')) ? body.hostSessionId : null,
      repo: chatId ? CHAT_REPO : cleanRepo(body.repo),
      pid,
      startedAt: Number.isFinite(startedAt) ? startedAt : now(),
      registeredAt: now(),
      lastSeenAt: now(),
      lastToolCallAt: null,
      wake: chatId ? 'fai-chat' : wake,
      wakeReason: chatId ? 'ok' : REASONS.has(body.wakeReason) ? body.wakeReason : null,
      // The FAI chat this session belongs to (spec #84 "Approvals and wakes"), or null.
      chatId,
      client: typeof body.client === 'string' ? body.client.slice(0, 80) : null,
      waiter: null,
      // The chat panel's watch of this session (watchChat), or null.
      chat: null,
    };
    const key = randomBytes(24).toString('base64url');
    session.keyDigest = digest(key);
    sessions.set(session.sessionId, session);
    log('session_registered', { sessionId: session.sessionId, host, wake: session.wake, replaced });
    changed();
    return { sessionId: session.sessionId, key, pollMs: SESSION_POLL_MAX_MS, staleMs, ...(replaced ? { replaced } : {}),
      ...(chatId ? { chat: true } : {}) };
  }

  /** The session `sessionId` when `key` is its key; 404 when unknown (re-register), 403 on a wrong key. */
  function authenticate(sessionId, key) {
    const session = typeof sessionId === 'string' ? sessions.get(sessionId) : null;
    if (!session) throw new SessionError(404, 'unknown_session', 'No such agent session; register again');
    if (typeof key !== 'string' || !key || !timingSafeEqual(digest(key), session.keyDigest)) {
      throw new SessionError(403, 'session_forbidden', 'Wrong session key');
    }
    return session;
  }

  /** Fields an MCP server may update on its own entry: the last tool call, a thread id learned late, its capability. */
  function update(session, body = {}) {
    let dirty = false;
    session.lastSeenAt = now();
    const called = Date.parse(body.lastToolCallAt ?? '');
    if (Number.isFinite(called) && called !== session.lastToolCallAt) {
      session.lastToolCallAt = Math.min(called, now());
      dirty = true;
    }
    if (body.hostSessionId !== undefined && ID.test(String(body.hostSessionId)) && body.hostSessionId !== session.hostSessionId) {
      session.hostSessionId = body.hostSessionId;
      dirty = true;
    }
    // A chat's session keeps fai-chat: its wakes are the chat's, whatever its server can do itself.
    if (!session.chatId && CAPABILITIES.has(body.wake) && body.wake !== 'fai-chat' && body.wake !== session.wake) {
      session.wake = body.wake;
      log('session_wake', { sessionId: session.sessionId, wake: session.wake });
      dirty = true;
    }
    if (!session.chatId && REASONS.has(body.wakeReason) && body.wakeReason !== session.wakeReason) {
      session.wakeReason = body.wakeReason;
      dirty = true;
    }
    if (dirty) changed();
    return view(session);
  }

  function pendingFor(session) {
    return [...wakes.values()].filter(wake => wake.sessionId === session.sessionId && wake.state === 'queued');
  }

  function release(session, value) {
    const waiter = session.waiter;
    if (!waiter) return;
    session.waiter = null;
    clearTimeout(waiter.timer);
    waiter.resolve(value);
  }

  /** Wakes for this session as soon as there are any, else {wakes: []} after maxMs. One poll per session at a time. */
  function poll(session, maxMs, signal) {
    session.lastSeenAt = now();
    // A newer poll replaces an older one (the MCP server reconnected).
    release(session, { wakes: [] });
    const deliver = () => {
      // At most WAKES_PER_POLL at a time, as the MCP server takes them; the rest wait for its next poll.
      const list = pendingFor(session).slice(0, WAKES_PER_POLL);
      for (const wake of list) {
        wake.state = 'sent';
        wake.sentAt = now();
      }
      if (list.length) changed();
      // A panel read since the last one: the MCP server reads what is new after the cursor it posted last.
      const chatRead = session.chat?.want ? { cursor: session.chat.cursor } : null;
      if (chatRead) session.chat.want = false;
      // Fields only: the MCP server writes the wake text itself from its fixed template (src/wake.js wakeText).
      return { wakes: list.map(wake => ({ wakeId: wake.wakeId, kind: wake.kind, requestId: wake.requestId ?? null,
        inviteId: wake.inviteId ?? null, level: wake.level ?? null, at: iso(wake.createdAt),
        ...(wake.actionId ? { actionId: wake.actionId, revision: wake.revision } : {}),
        ...(wake.items ? { items: wake.items } : {}),
        ...(wake.userText ? { userText: wake.userText } : {}) })), ...(chatRead ? { chatRead } : {}) };
    };
    if (pendingFor(session).length || session.chat?.want || maxMs <= 0) return Promise.resolve(deliver());
    return new Promise(resolvePoll => {
      const waiter = {
        resolve: value => {
          signal?.removeEventListener?.('abort', onAbort);
          session.lastSeenAt = now();
          resolvePoll(value);
        },
        deliver,
        timer: setTimeout(() => {
          if (session.waiter === waiter) release(session, { wakes: [] });
        }, Math.min(maxMs, SESSION_POLL_MAX_MS)),
      };
      // A held poll never keeps the daemon's process alive by itself (close() answers it anyway).
      waiter.timer.unref?.();
      const onAbort = () => {
        if (session.waiter === waiter) release(session, { wakes: [] });
      };
      signal?.addEventListener?.('abort', onAbort, { once: true });
      session.waiter = waiter;
    });
  }

  // Answer a held poll now (a wake or a chat read is waiting).
  function answerPoll(session) {
    if (!session.waiter) return;
    const waiter = session.waiter;
    session.waiter = null;
    clearTimeout(waiter.timer);
    waiter.resolve(waiter.deliver());
  }

  /**
   * Queue a wake for `sessionId`: `kind` (invite, resume, approved, action_approved, action_denied, ask_declined,
   * bundle_approved, bundle_denied, bundle_expired, chat), the ids (an action decision: its actionId and revision; a
   * bundle: its items, src/wake.js cleanBundleItems), the level and, for an invite or a chat message, the user's own words.
   * Returns the wake view, or null when the session is unknown or cannot be woken (its capability is none): the caller
   * then shows the copy fallback.
   */
  function queueWake(sessionId, { kind, requestId = null, inviteId = null, level = null, userText = '', actionId = null,
    revision = null, items = null }) {
    const session = sessions.get(sessionId);
    // A chat's session is woken through its chat (the daemon starts a turn), never through this queue.
    if (!session || session.wake === 'none' || session.chatId) return null;
    const wake = { wakeId: `wake_${randomBytes(8).toString('base64url')}`, sessionId, kind, requestId, inviteId, level,
      actionId, revision, items: items ? cleanBundleItems(items) : null, userText: typeof userText === 'string' ? userText : '',
      state: 'queued', error: null, createdAt: now(), sentAt: null, settledAt: null };
    wakes.set(wake.wakeId, wake);
    log('wake_queued', { sessionId, kind, requestId, inviteId });
    answerPoll(session);
    changed();
    return wakeView(wake);
  }

  /** This session's wakes of `kind` still kept (settled ones for WAKE_KEEP_MS), oldest first. */
  function wakesOf(sessionId, kind) {
    return [...wakes.values()].filter(wake => wake.sessionId === sessionId && wake.kind === kind)
      .sort((a, b) => a.createdAt - b.createdAt).map(wake => ({ ...wakeView(wake), createdMs: wake.createdAt }));
  }

  /**
   * A panel reads `sessionId`'s chat: the watch starts (or goes on for CHAT_WATCH_MS more) and the session's poll asks
   * its MCP server for what is new. False when the session is unknown.
   */
  function watchChat(sessionId) {
    const session = typeof sessionId === 'string' ? sessions.get(sessionId) : null;
    if (!session) return false;
    if (!session.chat) {
      session.chat = { messages: [], ids: new Set(), cursor: null, busy: false, readable: false, error: null,
        want: false, polledAt: 0 };
      log('chat_watch', { sessionId });
    }
    session.chat.polledAt = now();
    session.chat.want = true;
    answerPoll(session);
    return true;
  }

  /** The panel closed: the watch ends now and its messages are dropped. */
  function unwatchChat(sessionId, reason = 'closed') {
    const session = typeof sessionId === 'string' ? sessions.get(sessionId) : null;
    if (!session?.chat) return false;
    session.chat = null;
    log('chat_unwatch', { sessionId, reason });
    return true;
  }

  /**
   * The MCP server's read of its own conversation: {messages, busy, cursor} or {error: {code, version}}. Taken only
   * while a panel watches (409 not_watched otherwise); messages already kept (same id) are not added twice.
   */
  function postChat(session, body = {}) {
    const chat = session.chat;
    if (!chat) throw new SessionError(409, 'not_watched', 'No chat panel watches this session');
    session.lastSeenAt = now();
    if (body.error && typeof body.error === 'object') {
      chat.error = { code: CHAT_ERRORS.has(body.error.code) ? body.error.code : 'unreadable', host: session.host,
        version: typeof body.error.version === 'string' ? body.error.version.replace(/[^0-9A-Za-z .+-]/g, '').slice(0, 32) : 'unknown version' };
      chat.readable = false;
      return { taken: 0 };
    }
    let taken = 0;
    for (const item of Array.isArray(body.messages) ? body.messages.slice(-CHAT_KEEP) : []) {
      if (!item || !CHAT_ROLES.has(item.role) || typeof item.text !== 'string' || !CHAT_ID.test(String(item.id ?? ''))
        || chat.ids.has(item.id)) continue;
      const at = Date.parse(item.at ?? '');
      chat.ids.add(item.id);
      chat.messages.push({ seq: ++chatSeq, id: item.id, role: item.role, text: clipText(item.text),
        at: Number.isFinite(at) ? iso(at) : null });
      taken += 1;
    }
    while (chat.messages.length > CHAT_KEEP) chat.ids.delete(chat.messages.shift().id);
    chat.busy = body.busy === true;
    if (typeof body.cursor === 'string' && body.cursor.length <= 256) chat.cursor = body.cursor;
    chat.readable = true;
    chat.error = null;
    return { taken };
  }

  /**
   * What a panel shows of `sessionId`'s chat: the kept messages newer than `after` (its highest seq), busy, readable and
   * the read error. reset: `after` is no longer kept (dropped from the window, or from an earlier watch), so the panel
   * replaces its list with these messages. null when nobody watches it.
   */
  function chatView(sessionId, after = 0) {
    const chat = typeof sessionId === 'string' ? sessions.get(sessionId)?.chat : null;
    if (!chat) return null;
    const since = Number.isSafeInteger(after) && after > 0 ? after : 0;
    const reset = since > 0 && chat.readable && !chat.messages.some(item => item.seq === since);
    return { busy: chat.busy, readable: chat.readable, error: chat.error ? { ...chat.error } : null, reset,
      messages: chat.messages.filter(item => reset || item.seq > since).map(item => ({ ...item })) };
  }

  /** The MCP server's word on a wake it was given: delivered, or failed with a code. */
  function report(session, wakeId, body = {}) {
    const wake = typeof wakeId === 'string' ? wakes.get(wakeId) : null;
    // Only the session a wake was addressed to can settle it.
    if (!wake || wake.sessionId !== session.sessionId) throw new SessionError(404, 'unknown_wake', 'No such wake for this session');
    session.lastSeenAt = now();
    if (wake.state === 'delivered' || wake.state === 'failed' || wake.state === 'skipped') return wakeView(wake);
    const outcome = ['delivered', 'failed', 'skipped'].includes(body.outcome) ? body.outcome : 'failed';
    wake.state = outcome;
    wake.settledAt = now();
    // What the host's channel answered on a delivered wake, if anything (a Claude Code socket reply line).
    wake.detail = outcome === 'delivered' && typeof body.message === 'string' ? body.message.replace(/\s+/g, ' ').slice(0, 200) : null;
    wake.error = outcome === 'failed'
      ? { code: typeof body.code === 'string' ? body.code.slice(0, 40) : 'wake_failed',
        message: typeof body.message === 'string' ? body.message.replace(/\s+/g, ' ').slice(0, 200) : 'The wake failed.' }
      : null;
    log('wake_settled', { sessionId: session.sessionId, kind: wake.kind, state: wake.state, code: wake.error?.code ?? null });
    changed();
    return wakeView(wake);
  }

  function unregister(session) {
    if (!sessions.has(session.sessionId)) return false;
    release(session, { wakes: [], closed: true });
    sessions.delete(session.sessionId);
    failWakesOf(session.sessionId, 'session_gone', 'The agent session ended before the wake reached it.');
    log('session_unregistered', { sessionId: session.sessionId });
    changed();
    return true;
  }

  function failWakesOf(sessionId, code, message) {
    for (const wake of wakes.values()) {
      if (wake.sessionId === sessionId && (wake.state === 'queued' || wake.state === 'sent')) {
        wake.state = 'failed';
        wake.settledAt = now();
        wake.error = { code, message };
      }
    }
  }

  /** Drop sessions whose process is gone or that stopped polling; time out wakes; forget old ones. */
  function sweep() {
    const t = now();
    let dirty = false;
    for (const session of [...sessions.values()]) {
      const silent = !session.waiter && t - session.lastSeenAt >= staleMs;
      if (silent || !isAlive(session.pid)) {
        release(session, { wakes: [], closed: true });
        sessions.delete(session.sessionId);
        // Only a session that went quiet may come back as itself; a dead process never does.
        if (silent && isAlive(session.pid)) {
          tombstones.set(session.sessionId, { keyDigest: session.keyDigest, pid: session.pid, chatId: session.chatId, at: t });
        }
        failWakesOf(session.sessionId, 'session_gone', 'The agent session is no longer running.');
        log('session_dropped', { sessionId: session.sessionId, reason: silent ? 'stale' : 'pid' });
        dirty = true;
      }
    }
    for (const session of sessions.values()) {
      if (session.chat && t - session.chat.polledAt >= chatWatchMs) unwatchChat(session.sessionId, 'idle');
    }
    for (const [id, stone] of [...tombstones]) if (t - stone.at >= TOMBSTONE_MS) tombstones.delete(id);
    for (const wake of [...wakes.values()]) {
      if (wake.state === 'queued' && t - wake.createdAt >= pickupMs) {
        wake.state = 'failed';
        wake.settledAt = t;
        wake.error = { code: 'not_polling', message: 'The agent session did not pick the wake up.' };
        dirty = true;
      } else if (wake.state === 'sent' && t - (wake.sentAt ?? wake.createdAt) >= reportMs) {
        wake.state = 'failed';
        wake.settledAt = t;
        wake.error = { code: 'no_report', message: 'The agent session did not report the wake.' };
        dirty = true;
      } else if (wake.settledAt && t - wake.settledAt >= WAKE_KEEP_MS) {
        wakes.delete(wake.wakeId);
      }
    }
    if (dirty) changed();
  }

  function close() {
    for (const session of sessions.values()) release(session, { wakes: [], closed: true });
  }

  return {
    register,
    authenticate,
    update,
    poll,
    queueWake,
    wakesOf,
    watchChat,
    unwatchChat,
    postChat,
    chatView,
    report,
    unregister,
    sweep,
    close,
    get: sessionId => sessions.get(sessionId) ?? null,
    wake: wakeId => (wakes.has(wakeId) ? wakeView(wakes.get(wakeId)) : null),
    /** Live sessions, newest activity first, without keys. */
    views: () => [...sessions.values()].map(view)
      .sort((a, b) => Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt)),
    view: sessionId => (sessions.has(sessionId) ? view(sessions.get(sessionId)) : null),
  };
}
