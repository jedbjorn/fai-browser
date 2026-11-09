// The MCP server's entry in the daemon's agent-session registry (src/sessions.js) and its wake channel: register after
// initialize, hold one long-poll for wakes (the heartbeat), write each wake to the host's own channel (src/wake.js),
// report the outcome, and unregister when stdio closes. It never starts the daemon: while none answers, it retries
// with a backoff, and re-registers when a restarted daemon no longer knows it.
import {
  claudeSocket, codexSupportsQueue, codexThreadId, deliverWake, hostSessionId, repoName, wakeCapability, wakeText,
} from './wake.js';

const POLL_MS = 25_000;
const BACKOFF_MIN_MS = 2_000;
const BACKOFF_MAX_MS = 30_000;
const STOP_TIMEOUT_MS = 2_000;

export class AgentSession {
  /**
   * `connect(options)`: FaiBrowserClient.connect (called with autoStart false). `host`: claude, codex, opencode or
   * unknown (src/wake.js detectHost). `driver()`: the driver in effect (the wake text names its tools). `waiting(wake)`:
   * true when a tool call in flight is already waiting on the wake's request (a resume or approval it will see itself).
   * `deliver`: the delivery function (tests); `pollMs`, `backoffMs`: test overrides.
   */
  constructor({ env, home, connect, clientName, host, log = () => {}, driver = () => 'agent', waiting = () => false,
    deliver = deliverWake, pollMs = POLL_MS, backoffMs = BACKOFF_MIN_MS, cwd = process.cwd(), pid = process.pid }) {
    this.env = env;
    this.home = home;
    this.connect = connect;
    this.clientName = clientName;
    this.host = host;
    this.log = log;
    this.driver = driver;
    this.waiting = waiting;
    this.deliver = deliver;
    this.pollMs = pollMs;
    this.backoffMinMs = backoffMs;
    this.repo = repoName(env, cwd);
    this.pid = pid;
    this.startedAt = new Date().toISOString();
    this.threadId = null;
    this.hostSessionId = hostSessionId(host, env);
    this.codexReady = false;
    this.sessionId = null;
    this.key = null;
    this.client = null;
    this.stopped = false;
    this.abort = new AbortController();
    this.lastToolCallAt = null;
    this.sentToolCallAt = null;
    this.pendingUpdate = null;
    this.loop = null;
    this.deliveries = new Set();
    this.disabled = false;
  }

  /** claude-socket, codex-queue or none, from the host, its environment and what is known so far. */
  get capability() {
    return wakeCapability({ host: this.host, env: this.env, threadId: this.threadId, codexReady: this.codexReady });
  }

  /** The X-Fai-Session value once registered, else null. */
  auth() {
    return this.sessionId && this.key ? `${this.sessionId}:${this.key}` : null;
  }

  view() {
    return { sessionId: this.sessionId, host: this.host, repo: this.repo, wake: this.capability,
      ...(this.host === 'claude' && !claudeSocket(this.env) ? { note: 'no messaging socket (Claude Code 2.1.224+, not --bare)' } : {}) };
  }

  start() {
    if (this.loop || this.stopped) return this.loop;
    this.loop = this.run().catch(error => this.log(`agent session loop ended: ${error?.message ?? error}`));
    return this.loop;
  }

  /** A tool call arrived (its _meta): the last activity, and a Codex thread id the first time one is named. */
  noteToolCall(meta) {
    this.lastToolCallAt = new Date().toISOString();
    if (this.host !== 'codex' || this.threadId) return;
    const threadId = codexThreadId(meta);
    if (!threadId) return;
    this.threadId = threadId;
    this.hostSessionId = threadId;
    codexSupportsQueue(this.env).then(ready => {
      this.codexReady = ready;
      this.pushUpdate();
    }, () => {});
  }

  // Send the thread id and the capability now (not at the next poll), so an invite right after works.
  pushUpdate() {
    if (!this.sessionId || !this.client || this.stopped) return;
    const body = { hostSessionId: this.hostSessionId ?? undefined, wake: this.capability };
    this.pendingUpdate = this.client.request('POST', `/v1/sessions/${encodeURIComponent(this.sessionId)}/update`,
      withoutUndefined(body), { timeoutMs: 5_000 }).catch(() => null);
  }

  async ensureClient() {
    if (this.client) return this.client;
    const client = await this.connect({ home: this.home, env: this.env, autoStart: false, clientName: this.clientName });
    client.sessionAuth = () => this.auth();
    this.client = client;
    return client;
  }

  async register() {
    const client = await this.ensureClient();
    const response = await client.request('POST', '/v1/sessions', withoutUndefined({
      host: this.host,
      hostSessionId: this.hostSessionId ?? undefined,
      repo: this.repo,
      pid: this.pid,
      startedAt: this.startedAt,
      wake: this.capability,
      client: this.clientName,
    }), { timeoutMs: 5_000, signal: this.abort.signal });
    if (typeof response?.sessionId !== 'string' || typeof response?.key !== 'string') throw new Error('The daemon registered no session');
    this.sessionId = response.sessionId;
    this.key = response.key;
    this.sentToolCallAt = null;
    this.log(`registered agent session ${this.sessionId} (${this.host}, wake ${this.capability})`);
  }

  async run() {
    let backoff = this.backoffMinMs;
    while (!this.stopped) {
      try {
        if (!this.sessionId) await this.register();
        const body = { maxMs: this.pollMs, wake: this.capability };
        if (this.lastToolCallAt && this.lastToolCallAt !== this.sentToolCallAt) body.lastToolCallAt = this.lastToolCallAt;
        if (this.hostSessionId) body.hostSessionId = this.hostSessionId;
        const response = await this.client.request('POST', `/v1/sessions/${encodeURIComponent(this.sessionId)}/poll`, body,
          { timeoutMs: this.pollMs + 10_000, signal: this.abort.signal });
        this.sentToolCallAt = body.lastToolCallAt ?? this.sentToolCallAt;
        backoff = this.backoffMinMs;
        for (const wake of Array.isArray(response?.wakes) ? response.wakes : []) this.handle(wake);
      } catch (error) {
        if (this.stopped) break;
        if (error?.status === 404 && error.code === 'unknown_session') {
          // A restarted daemon: register again at once.
          this.sessionId = null;
          this.key = null;
          continue;
        }
        if (error?.status === 404 || error?.status === 400) {
          // An older daemon without the registry (or one that refuses our fields): no invites or wakes here.
          this.log(`agent session registry unavailable (${error.code ?? error.status}); invites and wakes are off`);
          this.disabled = true;
          break;
        }
        if (error?.status === 401 || error?.code === 'daemon_unreachable') {
          // A new daemon (another token or port), or none yet: connect again after a while.
          this.client = null;
          this.sessionId = null;
          this.key = null;
        }
        await sleep(backoff, this.abort.signal);
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
      }
    }
  }

  /** Deliver one wake to this session's own host (never another one's) and report how it went. */
  handle(wake) {
    const task = (async () => {
      if (!wake || typeof wake.wakeId !== 'string') return;
      let outcome;
      if (wake.kind !== 'invite' && this.waiting(wake)) {
        outcome = { outcome: 'skipped' };
      } else {
        const text = wakeText({ kind: wake.kind, inviteId: wake.inviteId, requestId: wake.requestId, level: wake.level,
          userText: wake.userText, driver: this.driver() });
        const delivered = await this.deliver({ capability: this.capability, text, env: this.env, threadId: this.threadId });
        outcome = delivered.ok ? { outcome: 'delivered', ...(delivered.reply ? { message: delivered.reply } : {}) }
          : { outcome: 'failed', code: delivered.code ?? 'wake_failed', message: delivered.message ?? 'The wake failed.' };
        this.log(`wake ${wake.kind} ${outcome.outcome}${delivered.ok ? '' : ` (${outcome.code})`}`);
      }
      await this.client?.request('POST', `/v1/sessions/${encodeURIComponent(this.sessionId)}/wakes/${encodeURIComponent(wake.wakeId)}`,
        outcome, { timeoutMs: 5_000 }).catch(() => null);
    })().catch(error => this.log(`wake failed: ${error?.message ?? error}`));
    this.deliveries.add(task);
    task.finally(() => this.deliveries.delete(task));
  }

  /** stdio closed: stop polling and leave the registry (bounded; a gone daemon drops the entry by pid anyway). */
  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.abort.abort(new Error('closing'));
    const client = this.client;
    const sessionId = this.sessionId;
    await Promise.race([Promise.allSettled([...this.deliveries]), sleep(STOP_TIMEOUT_MS)]);
    if (client && sessionId) {
      await client.request('DELETE', `/v1/sessions/${encodeURIComponent(sessionId)}`, {},
        { timeoutMs: STOP_TIMEOUT_MS }).catch(() => null);
    }
    await this.loop?.catch?.(() => {});
  }
}

function withoutUndefined(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

function sleep(ms, signal) {
  return new Promise(resolveSleep => {
    const timer = setTimeout(resolveSleep, ms);
    timer.unref?.();
    signal?.addEventListener?.('abort', () => {
      clearTimeout(timer);
      resolveSleep();
    }, { once: true });
  });
}
