// The MCP server's entry in the daemon's agent-session registry (src/sessions.js) and its wake channel: register after
// initialize, hold one long-poll for wakes (the heartbeat), write each wake to the host's own channel (src/wake.js),
// report the outcome, and unregister when stdio closes.
//
// It never starts a daemon and never stops one: it connects with `autoStart: false, takeover: false`, so a newer
// daemon (after an update) is left alone; on a version mismatch it waits until this server's own tool call has
// connected (kick). Before it sends anything that matters it checks that the daemon holds the client token (a proof
// in the health answer), so a process squatting on the port gets no registration and cannot inject wakes. When the
// daemon dropped it (it stopped polling for a while), it registers again with its old id and key, and its requests
// and invites move to the new id.
import { createHmac, randomBytes } from 'node:crypto';
import { httpJson } from './client.js';
import {
  claudeSocket, codexSupportsQueue, codexThreadId, deliverWake, hostSessionId, repoName, wakeCapability, wakeText,
} from './wake.js';

const POLL_MS = 25_000;
const BACKOFF_MIN_MS = 2_000;
const BACKOFF_MAX_MS = 30_000;
const STOP_TIMEOUT_MS = 2_000;
// Wakes this server acts on: each id once (the last 256 remembered), at most 4 from one poll and 12 a minute.
const HANDLED_KEEP = 256;
const WAKES_PER_POLL = 4;
const WAKES_PER_MINUTE = 12;

export class AgentSession {
  /**
   * `connect(options)`: FaiBrowserClient.connect (called with autoStart and takeover false). `host`: claude, codex,
   * opencode or unknown (src/wake.js detectHost). `driver()`: the driver in effect (the wake text names its tools).
   * `waiting(wake)`: true when this server already showed the agent what the wake is about (a call waiting on that
   * request, or one that saw it become active). `deliver`: the delivery function (tests); `onOutcome(wake, outcome)`: told how each wake went (the server stops
   * promising wakes after a failure); `pollMs`, `backoffMs`, `ppid`: test overrides.
   */
  constructor({ env, home, connect, clientName, host, log = () => {}, driver = () => 'agent', waiting = () => false,
    onOutcome = () => {},
    deliver = deliverWake, pollMs = POLL_MS, backoffMs = BACKOFF_MIN_MS, cwd = process.cwd(), pid = process.pid,
    ppid = undefined }) {
    this.env = env;
    this.home = home;
    this.connect = connect;
    this.clientName = clientName;
    this.host = host;
    this.log = log;
    this.driver = driver;
    this.waiting = waiting;
    this.onOutcome = onOutcome;
    this.deliver = deliver;
    this.pollMs = pollMs;
    this.backoffMinMs = backoffMs;
    this.repo = repoName(env, cwd);
    this.pid = pid;
    // A test's fixed parent pid; otherwise read live, so a server orphaned by its Claude Code (reparented) fails closed.
    this.ppidOverride = ppid;
    this.startedAt = new Date().toISOString();
    this.threadId = null;
    this.hostSessionId = hostSessionId(host, env);
    this.codexReady = false;
    this.sessionId = null;
    this.key = null;
    // The id and key the daemon dropped (it stopped seeing polls): sent once on the next registration.
    this.previous = null;
    this.client = null;
    this.stopped = false;
    this.abort = new AbortController();
    this.nap = null;
    this.lastToolCallAt = null;
    this.sentToolCallAt = null;
    this.pendingUpdate = null;
    this.loop = null;
    this.deliveries = new Set();
    this.disabled = false;
    // Waiting for this server's own tool call after a version mismatch (no polling, no registration until then).
    this.held = false;
    this.registered = [];
    this.handled = new Set();
    this.recentWakes = [];
  }

  get ppid() {
    return this.ppidOverride ?? process.ppid;
  }

  /** claude-socket, codex-queue or none, from the host, its environment and what is known so far. */
  get capability() {
    return wakeCapability({ host: this.host, env: this.env, threadId: this.threadId, codexReady: this.codexReady,
      ppid: this.ppid });
  }

  /** The X-Fai-Session value once registered, else null. */
  auth() {
    return this.sessionId && this.key ? `${this.sessionId}:${this.key}` : null;
  }

  view() {
    const note = this.host === 'claude' && !claudeSocket(this.env, { ppid: this.ppid })
      ? 'no messaging socket of its own (Claude Code 2.1.224+, not --bare, the MCP server started by Claude Code itself)'
      : this.held ? 'waiting: the daemon runs another version' : null;
    return { sessionId: this.sessionId, host: this.host, repo: this.repo, wake: this.capability, ...(note ? { note } : {}) };
  }

  start() {
    if (this.loop || this.stopped) return this.loop;
    this.loop = this.run().catch(error => this.log(`agent session loop ended: ${error?.message ?? error}`));
    return this.loop;
  }

  /** Cut a backoff or a version hold short: this server's own call just reached the daemon (it may be a new one). */
  kick() {
    this.held = false;
    this.nap?.abort();
  }

  /**
   * Resolves once registered (true), or false after `ms` or when the registry is off. A server about to create a
   * request or join an invite waits here, so the daemon records this session as the owner.
   */
  async ready(ms = 3_000) {
    if (this.sessionId) return true;
    if (this.disabled || this.stopped) return false;
    this.kick();
    const deadline = Date.now() + ms;
    while (!this.sessionId && !this.disabled && !this.stopped && Date.now() < deadline) await sleep(25);
    return Boolean(this.sessionId);
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
    // Never starts a daemon, never stops one of another version (`version_mismatch` instead).
    const client = await this.connect({ home: this.home, env: this.env, autoStart: false, takeover: false,
      clientName: this.clientName });
    // Every new connection proves the daemon holds the client token before the token or the session key is sent to it.
    await this.verifyDaemon(client);
    client.sessionAuth = () => this.auth();
    this.client = client;
    return client;
  }

  /** The daemon on this port holds the client token: its health answer carries the HMAC of a fresh nonce. */
  async verifyDaemon(client) {
    const challenge = randomBytes(18).toString('base64url');
    // No token on this request: a squatter learns nothing from it.
    const { status, body } = await httpJson({ port: client.port, method: 'GET', path: `/v1/health?challenge=${challenge}`,
      timeoutMs: 3_000 });
    const expected = createHmac('sha256', client.token).update(`fai-health:${client.port}:${challenge}`).digest('hex');
    if (status !== 200 || body?.proof !== expected) {
      const error = new Error('The FAI Browser daemon on this port did not prove it holds the client token');
      error.code = body?.service === 'fai-browser' && body?.proof === undefined ? 'no_proof' : 'unproven';
      throw error;
    }
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
      previous: this.previous ?? undefined,
    }), { timeoutMs: 5_000, signal: this.abort.signal });
    if (typeof response?.sessionId !== 'string' || typeof response?.key !== 'string') throw new Error('The daemon registered no session');
    this.sessionId = response.sessionId;
    this.key = response.key;
    this.previous = null;
    this.sentToolCallAt = null;
    this.registered.push(this.sessionId);
    this.log(`registered agent session ${this.sessionId} (${this.host}, wake ${this.capability})`);
  }

  // Forget the connection, keep the session: the next round connects and verifies the daemon again; if it no longer
  // knows this session (a restart), the poll's unknown_session registers again.
  dropClient() {
    this.client = null;
  }

  forget({ keepPrevious = false } = {}) {
    if (keepPrevious && this.sessionId && this.key) this.previous = { sessionId: this.sessionId, key: this.key };
    this.sessionId = null;
    this.key = null;
  }

  async run() {
    let backoff = this.backoffMinMs;
    while (!this.stopped) {
      if (this.held) {
        // A daemon of another version answers: wait for this server's own call (which may replace it), no timer.
        await this.rest(null);
        continue;
      }
      try {
        await this.ensureClient();
        if (!this.sessionId) await this.register();
        const body = { maxMs: this.pollMs, wake: this.capability };
        if (this.lastToolCallAt && this.lastToolCallAt !== this.sentToolCallAt) body.lastToolCallAt = this.lastToolCallAt;
        if (this.hostSessionId) body.hostSessionId = this.hostSessionId;
        const response = await this.client.request('POST', `/v1/sessions/${encodeURIComponent(this.sessionId)}/poll`, body,
          { timeoutMs: this.pollMs + 10_000, signal: this.abort.signal });
        this.sentToolCallAt = body.lastToolCallAt ?? this.sentToolCallAt;
        backoff = this.backoffMinMs;
        // New wakes only, at most WAKES_PER_POLL of them (the daemon hands out no more); any extra is reported as
        // rate_limited at once, so the daemon and the popup show the copy line instead of waiting for nothing.
        const wakes = (Array.isArray(response?.wakes) ? response.wakes : [])
          .filter(wake => typeof wake?.wakeId === 'string' && !this.handled.has(wake.wakeId));
        for (const wake of wakes.slice(0, WAKES_PER_POLL)) this.handle(wake);
        for (const wake of wakes.slice(WAKES_PER_POLL)) this.refuse(wake, 'More wakes in one poll than FAI takes.');
        if (response?.closed) {
          // The daemon is shutting down: whatever answers on this port next proves itself before it gets anything.
          this.dropClient();
          await this.rest(backoff);
        }
      } catch (error) {
        if (this.stopped) break;
        if (error?.code === 'version_mismatch') {
          this.log('the FAI Browser daemon runs another version: the agent session waits for this server\'s next call');
          this.client = null;
          this.forget();
          this.held = true;
          continue;
        }
        if (error?.status === 404 && error.code === 'unknown_session') {
          // Dropped (no poll for a while) or a restarted daemon: register again at once, as itself if it can.
          this.forget({ keepPrevious: true });
          continue;
        }
        if (error?.code === 'no_proof' || error?.status === 404 || error?.status === 400) {
          // An older daemon without the registry (or one that refuses our fields): no invites or wakes here.
          this.log(`agent session registry unavailable (${error.code ?? error.status}); invites and wakes are off`);
          this.disabled = true;
          break;
        }
        if (error?.code === 'unproven' || error?.status === 401) {
          // A new daemon (another token or port), or something else on the port: connect again later. The old id and key
          // go along only to a daemon that proved itself, and take over only for this same process.
          this.client = null;
          this.forget({ keepPrevious: true });
        } else {
          // Shutting down (503), any other server error, a transport error, a timeout: the next round connects and
          // proves the daemon again before it sends the token or the session key anywhere.
          this.dropClient();
        }
        await this.rest(backoff);
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
      }
    }
  }

  // Sleep `ms` (null: until kicked or stopped).
  rest(ms) {
    this.nap = new AbortController();
    const signals = [this.abort.signal, this.nap.signal];
    return new Promise(resolveRest => {
      const timer = ms === null ? null : setTimeout(done, ms);
      timer?.unref?.();
      function done() {
        clearTimeout(timer);
        for (const signal of signals) signal.removeEventListener('abort', done);
        resolveRest();
      }
      for (const signal of signals) signal.addEventListener('abort', done, { once: true });
      if (signals.some(signal => signal.aborted)) done();
    });
  }

  /** Deliver one wake to this session's own host (never another one's) and report how it went. */
  handle(wake) {
    if (!wake || typeof wake.wakeId !== 'string') return;
    // Each wake once; and never a flood, whatever a daemon (or something posing as one) sends.
    if (this.handled.has(wake.wakeId)) return;
    this.handled.add(wake.wakeId);
    if (this.handled.size > HANDLED_KEEP) this.handled.delete(this.handled.values().next().value);
    const now = Date.now();
    this.recentWakes = this.recentWakes.filter(at => now - at < 60_000);
    if (this.recentWakes.length >= WAKES_PER_MINUTE) {
      this.log('wake dropped: more than 12 a minute');
      this.refuse(wake, 'More than 12 wakes a minute.', { marked: true });
      return;
    }
    this.recentWakes.push(now);
    const sessionId = this.sessionId;
    const client = this.client;
    const task = (async () => {
      let outcome;
      if (wake.kind !== 'invite' && this.waiting(wake)) {
        outcome = { outcome: 'skipped' };
      } else {
        const text = wakeText({ kind: wake.kind, inviteId: wake.inviteId, requestId: wake.requestId, level: wake.level,
          userText: wake.userText, driver: this.driver() });
        const delivered = await this.deliver({ capability: this.capability, text, env: this.env, threadId: this.threadId,
          ppid: this.ppid });
        outcome = delivered.ok ? { outcome: 'delivered', ...(delivered.reply ? { message: delivered.reply } : {}) }
          : { outcome: 'failed', code: delivered.code ?? 'wake_failed', message: delivered.message ?? 'The wake failed.' };
        this.log(`wake ${wake.kind} ${outcome.outcome}${delivered.ok ? '' : ` (${outcome.code})`}`);
      }
      this.onOutcome(wake, outcome);
      // Reported to the daemon that handed it out, and only while that connection is still the current, verified one:
      // after a shutdown something else may hold the port by now (the daemon then fails the wake as no_report).
      if (client && sessionId && this.client === client) {
        await client.request('POST', `/v1/sessions/${encodeURIComponent(sessionId)}/wakes/${encodeURIComponent(wake.wakeId)}`,
          outcome, { timeoutMs: 5_000 }).catch(() => null);
      }
    })().catch(error => this.log(`wake failed: ${error?.message ?? error}`));
    this.deliveries.add(task);
    task.finally(() => this.deliveries.delete(task));
  }

  /** Fail a wake at once without acting on it (`rate_limited`), reported only over the current connection. */
  refuse(wake, message, { marked = false } = {}) {
    if (!marked) {
      this.handled.add(wake.wakeId);
      if (this.handled.size > HANDLED_KEEP) this.handled.delete(this.handled.values().next().value);
    }
    const outcome = { outcome: 'failed', code: 'rate_limited', message };
    this.onOutcome(wake, outcome);
    const client = this.client;
    if (!client || !this.sessionId) return;
    client.request('POST', `/v1/sessions/${encodeURIComponent(this.sessionId)}/wakes/${encodeURIComponent(wake.wakeId)}`,
      outcome, { timeoutMs: 5_000 }).catch(() => null);
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

function sleep(ms) {
  return new Promise(resolveSleep => {
    const timer = setTimeout(resolveSleep, ms);
    timer.unref?.();
  });
}
