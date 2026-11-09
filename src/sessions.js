// The daemon's registry of live coding-agent sessions (one entry per running fai-browser-mcp process) and the wake
// queue addressed to them. An MCP server registers after initialize, holds a long-poll for wakes (which doubles as its
// heartbeat), reports each wake's outcome, and unregisters when its stdio closes. Entries whose process is gone or that
// stopped polling are dropped. Each entry has a random key only its MCP server knows: polls, reports and updates
// need it, so a session only ever receives the wakes addressed to it. Views never carry the key.
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';

export const SESSION_POLL_MAX_MS = 25_000;
// A session that has not polled for this long (and has no poll open) is gone.
export const SESSION_STALE_MS = 90_000;
// A wake nobody picked up (no poll open) fails after this long; one picked up but never reported, after REPORT_MS.
export const WAKE_PICKUP_MS = 10_000;
export const WAKE_REPORT_MS = 25_000;
export const MAX_SESSIONS = 32;
const WAKE_KEEP_MS = 10 * 60_000;
const HOSTS = new Set(['claude', 'codex', 'opencode', 'unknown']);
const CAPABILITIES = new Set(['claude-socket', 'codex-queue', 'none']);
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
  const sessions = new Map();
  const wakes = new Map();

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
      // A Codex session can be woken only once its thread id is known (its first FAI tool call).
      ready: session.wake !== 'none' || session.host !== 'codex' || Boolean(session.hostSessionId),
    };
  }

  function wakeView(wake) {
    return { wakeId: wake.wakeId, sessionId: wake.sessionId, kind: wake.kind, requestId: wake.requestId ?? null,
      inviteId: wake.inviteId ?? null, state: wake.state, error: wake.error ?? null, createdAt: iso(wake.createdAt),
      settledAt: iso(wake.settledAt ?? null) };
  }

  function register(body = {}) {
    const host = HOSTS.has(body.host) ? body.host : 'unknown';
    const wake = CAPABILITIES.has(body.wake) ? body.wake : 'none';
    const pid = Number.isInteger(body.pid) && body.pid > 0 ? body.pid : null;
    if (!pid) throw new SessionError(400, 'invalid_options', 'pid must be the MCP server process id');
    const startedAt = Date.parse(body.startedAt ?? '');
    sweep();
    if (sessions.size >= MAX_SESSIONS) {
      throw new SessionError(429, 'too_many_sessions', `At most ${MAX_SESSIONS} agent sessions can register at once`);
    }
    const session = {
      sessionId: `ses_${randomBytes(9).toString('base64url')}`,
      keyDigest: null,
      host,
      hostSessionId: ID.test(String(body.hostSessionId ?? '')) ? body.hostSessionId : null,
      repo: cleanRepo(body.repo),
      pid,
      startedAt: Number.isFinite(startedAt) ? startedAt : now(),
      registeredAt: now(),
      lastSeenAt: now(),
      lastToolCallAt: null,
      wake,
      client: typeof body.client === 'string' ? body.client.slice(0, 80) : null,
      waiter: null,
    };
    const key = randomBytes(24).toString('base64url');
    session.keyDigest = digest(key);
    sessions.set(session.sessionId, session);
    log('session_registered', { sessionId: session.sessionId, host, wake });
    changed();
    return { sessionId: session.sessionId, key, pollMs: SESSION_POLL_MAX_MS, staleMs };
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
    if (CAPABILITIES.has(body.wake) && body.wake !== session.wake) {
      session.wake = body.wake;
      log('session_wake', { sessionId: session.sessionId, wake: session.wake });
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
      const list = pendingFor(session);
      for (const wake of list) {
        wake.state = 'sent';
        wake.sentAt = now();
      }
      if (list.length) changed();
      return { wakes: list.map(wake => ({ wakeId: wake.wakeId, kind: wake.kind, text: wake.text,
        requestId: wake.requestId ?? null, inviteId: wake.inviteId ?? null })) };
    };
    if (pendingFor(session).length || maxMs <= 0) return Promise.resolve(deliver());
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
      const onAbort = () => {
        if (session.waiter === waiter) release(session, { wakes: [] });
      };
      signal?.addEventListener?.('abort', onAbort, { once: true });
      session.waiter = waiter;
    });
  }

  /**
   * Queue a wake for `sessionId`. Returns the wake view, or null when the session is unknown or cannot be woken (its
   * capability is none): the caller then shows the copy fallback.
   */
  function queueWake(sessionId, { kind, text, requestId = null, inviteId = null }) {
    const session = sessions.get(sessionId);
    if (!session || session.wake === 'none') return null;
    const wake = { wakeId: `wake_${randomBytes(8).toString('base64url')}`, sessionId, kind, text, requestId, inviteId,
      state: 'queued', error: null, createdAt: now(), sentAt: null, settledAt: null };
    wakes.set(wake.wakeId, wake);
    log('wake_queued', { sessionId, kind, requestId, inviteId });
    if (session.waiter) {
      const waiter = session.waiter;
      session.waiter = null;
      clearTimeout(waiter.timer);
      waiter.resolve(waiter.deliver());
    }
    changed();
    return wakeView(wake);
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
        failWakesOf(session.sessionId, 'session_gone', 'The agent session is no longer running.');
        log('session_dropped', { sessionId: session.sessionId, reason: silent ? 'stale' : 'pid' });
        dirty = true;
      }
    }
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
