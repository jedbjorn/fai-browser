// Client SDK for the FAI Browser daemon (design section 2). Used by the CLI, the MCP server and scripts.
//
//   const client = await FaiBrowserClient.connect({ clientName: 'my-agent' });   // auto-starts the daemon
//   const { requestId } = await client.requestTab({ origins: ['https://example.com'], reason: 'Check members' });
//   await client.waitForTab(requestId, { timeoutMs: 120000 });
//   const page = await client.observe({ requestId });
//   const { result } = await client.act({ requestId, actionId: 'a3', expectation: { urlIncludes: '/members' } });
//
// HTTP errors throw FaiClientError {status, code, message}. Task outcomes (needs_user, failed, ...) are results.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { PACKAGE_ROOT } from './paths.js';
import {
  DAEMON_DEFAULT_PORT,
  configuredPort,
  ensureDir,
  homePaths,
  readClientToken,
  readDaemonInfo,
} from './home.js';

export const CLIENT_VERSION = readVersion();
const HEALTH_TIMEOUT_MS = 500;
const POLL_MS = 100;
const DEFAULT_START_TIMEOUT_MS = 5000;
const WINDOWS_START_TIMEOUT_MS = 15_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const LONG_POLL_SLACK_MS = 5000;
const MAX_WAIT_MS = 45_000;
const DAEMON_ENTRY = join(PACKAGE_ROOT, 'src', 'daemon-main.js');

function readVersion() {
  try {
    return JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
}

export class FaiClientError extends Error {
  constructor(status, code, message, { retryable = false } = {}) {
    super(message);
    this.name = 'FaiClientError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));

/** One HTTP/JSON call. Resolves {status, body}; rejects only on transport failures. */
export function httpJson({ port, method, path, token, body, timeoutMs, signal, headers = {} }) {
  return new Promise((resolveCall, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const requestHeaders = { Accept: 'application/json', ...headers };
    if (token) requestHeaders.Authorization = `Bearer ${token}`;
    if (payload !== null) {
      requestHeaders['Content-Type'] = 'application/json';
      requestHeaders['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: requestHeaders, agent: false });
    const onAbort = () => req.destroy(signal.reason ?? new Error('Aborted'));
    const timer = setTimeout(() => req.destroy(new Error(`Request timed out after ${timeoutMs} ms`)), timeoutMs);
    req.on('response', res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          parsed = null;
        }
        resolveCall({ status: res.statusCode, body: parsed });
      });
      res.on('error', reject);
    });
    req.on('error', error => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    req.end(payload ?? undefined);
  });
}

/** GET /v1/health. Resolves the health body, or null when nothing healthy answers. */
export async function probeHealth(port, timeoutMs = HEALTH_TIMEOUT_MS) {
  if (!port) return null;
  try {
    const { status, body } = await httpJson({ port, method: 'GET', path: '/v1/health', timeoutMs });
    return status === 200 && body?.service === 'fai-browser' ? body : null;
  } catch {
    return null;
  }
}

/** The port a client should use: explicit, else a non-zero env port, else daemon.json, else 4318 (or null). */
export function resolveClientPort(paths, { port, env = process.env } = {}) {
  if (port) return port;
  const fromEnv = configuredPort(env);
  if (fromEnv) return fromEnv;
  const fromFile = readDaemonInfo(paths)?.port ?? null;
  // An explicit port 0 (tests, benchmarks) means "whatever daemon.json says": never fall back to 4318.
  const explicitZero = [env.FAI_DAEMON_PORT, env.FAI_BRIDGE_PORT].some(value => value !== undefined && value !== '');
  return fromFile ?? (explicitZero ? null : DAEMON_DEFAULT_PORT);
}

const HOST_WAKE_ENV = ['FAI_OPENCODE_WAKE_SOCKET', 'FAI_OPENCODE_WAKE_TOKEN', 'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_MESSAGING_SOCKET_TOKEN'];
function withoutHostWakeEnv(env) {
  if (!env || !HOST_WAKE_ENV.some(key => Object.hasOwn(env, key))) return env;
  const out = { ...env };
  for (const key of HOST_WAKE_ENV) delete out[key];
  return out;
}

/**
 * Windows: start the daemon through WMI (src/breakaway.js), outside the caller's job object and with none of its
 * handles, so a daemon the pairing helper starts outlives it (Firefox kills the helper's job) and one started under a
 * pipe (the MCP server's stdio, an agent running setup) does not hold that pipe open. False when that is not possible;
 * the caller then spawns normally.
 */
async function spawnDaemonOutsideJob(paths, env, command, spawnOutside) {
  ensureDir(paths.logDir);
  const [file, ...args] = command ?? [process.execPath, DAEMON_ENTRY];
  try {
    const start = spawnOutside ?? (await import('./breakaway.js')).spawnOutsideJob;
    await start({ file, args, outputFile: join(paths.logDir, 'daemon-start.log'), cwd: paths.home,
      env: withoutHostWakeEnv(paths.custom ? { ...env, FAI_HOME: paths.home } : env) });
    return true;
  } catch {
    return false;
  }
}

function spawnDaemon(paths, env, command) {
  ensureDir(paths.logDir);
  const logFd = openSync(paths.logFile, 'a', 0o600);
  try {
    const [file, ...args] = command ?? [process.execPath, DAEMON_ENTRY];
    const child = spawn(file, args, {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      // The default directories need no FAI_HOME: the daemon resolves the same ones (src/paths.js). The wake channels of
      // the host that started it (FAI's OpenCode plugin token, Claude Code's messaging token) stay with that host.
      env: withoutHostWakeEnv(paths.custom ? { ...env, FAI_HOME: paths.home } : env),
    });
    child.unref();
    return child;
  } finally {
    closeSync(logFd);
  }
}

async function waitForHealth(paths, options, deadline, child) {
  let exitCode = null;
  child?.once('exit', code => {
    exitCode = code;
  });
  while (Date.now() < deadline) {
    const port = resolveClientPort(paths, options);
    const health = await probeHealth(port);
    if (health) return { port, health };
    // Exit 0 means another client's daemon won the lock race; keep polling for it to become healthy.
    if (exitCode !== null && exitCode !== 0) {
      throw new FaiClientError(0, 'port_in_use',
        `The daemon could not start (exit ${exitCode}); port ${port} may be held by another program. `
        + `See ${paths.logFile}.`);
    }
    await delay(POLL_MS);
  }
  throw new FaiClientError(0, 'daemon_unreachable', `The daemon did not become healthy; see ${paths.logFile}`,
    { retryable: true });
}

async function isIdle(port, token) {
  try {
    const { status, body } = await httpJson({ port, method: 'GET', path: '/v1/status', token, timeoutMs: 2000 });
    if (status !== 200) return false;
    return !body.requests?.length && !body.runs?.active?.length;
  } catch {
    return false;
  }
}

async function waitForExit(port, deadline) {
  while (Date.now() < deadline) {
    if (!(await probeHealth(port, 200))) return true;
    await delay(POLL_MS);
  }
  return false;
}

/**
 * Make sure a daemon is running and healthy, auto-starting one if needed (section 1).
 * Options: home, env, port, autoStart (default true), takeover (default true: an idle daemon of another version is
 * shut down and replaced; false: `version_mismatch` instead), startTimeoutMs (default FAI_DAEMON_START_TIMEOUT_MS or
 * 5000), command (argv to spawn instead of src/daemon-main.js), version (default this package's).
 * Resolves {port, token, health, started, warnings}.
 */
export async function ensureDaemon(options = {}) {
  const env = options.env ?? process.env;
  const paths = homePaths({ home: options.home, env });
  const version = options.version ?? CLIENT_VERSION;
  const platform = options.platform ?? process.platform;
  // Windows starts the daemon through PowerShell and WMI, which takes a few seconds more.
  const startTimeoutMs = options.startTimeoutMs ?? (Number(env.FAI_DAEMON_START_TIMEOUT_MS)
    || (platform === 'win32' ? WINDOWS_START_TIMEOUT_MS : DEFAULT_START_TIMEOUT_MS));
  const warnings = [];
  let started = false;

  let port = resolveClientPort(paths, { port: options.port, env });
  let health = await probeHealth(port);

  // `takeover: false` (the MCP server's background session loop): never stop a daemon of another version, however
  // idle; refuse with `version_mismatch` instead, and leave the takeover to a real client call.
  if (health && health.version !== version && options.takeover === false) {
    throw new FaiClientError(409, 'version_mismatch', `The FAI Browser daemon runs ${health.version}, this client ${version}`,
      { retryable: true });
  }
  if (health && health.version !== version) {
    const token = readClientToken(paths, env);
    if (await isIdle(port, token)) {
      await httpJson({ port, method: 'POST', path: '/v1/daemon/shutdown', token, body: {}, timeoutMs: 2000 })
        .catch(() => null);
      await waitForExit(port, Date.now() + startTimeoutMs);
      health = null;
    } else {
      warnings.push('daemon_version_mismatch');
    }
  }

  if (!health) {
    if (options.autoStart === false) {
      const where = port ? `on port ${port}` : `(port 0 requested and no ${paths.daemonJson})`;
      throw new FaiClientError(0, 'daemon_unreachable', `No FAI Browser daemon is answering ${where}`,
        { retryable: true });
    }
    const outside = platform === 'win32' && options.breakaway !== false
      && await spawnDaemonOutsideJob(paths, env, options.command, options.spawnOutsideJob);
    const child = outside ? null : spawnDaemon(paths, env, options.command);
    started = true;
    try {
      ({ port, health } = await waitForHealth(paths, { port: options.port, env }, Date.now() + startTimeoutMs, child));
    } catch (error) {
      // A daemon started through WMI writes its startup failure (a port in use, say) to daemon-start.log.
      if (outside && error instanceof FaiClientError) {
        error.message += ` (startup output: ${join(paths.logDir, 'daemon-start.log')})`;
      }
      throw error;
    }
  }

  const token = readClientToken(paths, env);
  if (!token) throw new FaiClientError(401, 'unauthorized', `No client token at ${paths.clientToken}`);
  return { port, token, health, started, warnings };
}

function query(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

export class FaiBrowserClient {
  /**
   * @param {{port:number, token:string, clientName?:string, warnings?:string[]}} options
   */
  constructor({ port, token, clientName = 'sdk', warnings = [] }) {
    this.port = port;
    this.token = token;
    this.clientName = `${clientName}/${randomUUID()}`;
    this.warnings = warnings;
  }

  /** Connect to the daemon, auto-starting it unless autoStart is false. */
  static async connect({ home, env, port, autoStart = true, takeover = true, clientName = 'sdk', startTimeoutMs, command } = {}) {
    const daemon = await ensureDaemon({ home, env, port, autoStart, takeover, startTimeoutMs, command });
    return new FaiBrowserClient({ port: daemon.port, token: daemon.token, clientName, warnings: daemon.warnings });
  }

  /**
   * The agent session this client speaks for (an MCP server's registry entry, `<sessionId>:<key>`), when one is set:
   * `sessionAuth` is a string or a function returning one. The daemon records it as the owner of the requests it
   * creates (woken on Approve and Resume) and as the session that joins an invite.
   */
  sessionHeader() {
    const auth = typeof this.sessionAuth === 'function' ? this.sessionAuth() : this.sessionAuth;
    return typeof auth === 'string' && auth ? { 'X-Fai-Session': auth } : {};
  }

  async request(method, path, body, { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, signal } = {}) {
    let response;
    try {
      response = await httpJson({
        port: this.port,
        method,
        path,
        token: this.token,
        body,
        timeoutMs,
        signal,
        headers: { 'X-Fai-Client': this.clientName, ...this.sessionHeader() },
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new FaiClientError(0, 'daemon_unreachable', `Daemon request failed: ${error.message}`, { retryable: true });
    }
    if (response.status >= 400) {
      const detail = response.body?.error ?? {};
      throw new FaiClientError(response.status, detail.code ?? 'internal', detail.message ?? `HTTP ${response.status}`,
        { retryable: Boolean(detail.retryable) });
    }
    return response.body;
  }

  health() {
    return this.request('GET', '/v1/health');
  }

  status() {
    return this.request('GET', '/v1/status');
  }

  requestTab(body) {
    return this.request('POST', '/v1/requests', body);
  }

  listRequests() {
    return this.request('GET', '/v1/requests');
  }

  getRequest(requestId) {
    return this.request('GET', `/v1/requests/${encodeURIComponent(requestId)}`);
  }

  /**
   * Ask for more on a request (a higher `mode`, more `origins`): an approved one keeps its id, tab and page and waits
   * for the user's Approve of the ask (`asked: true`); a pending one simply asks for it all.
   */
  ask(requestId, body) {
    return this.request('POST', `/v1/requests/${encodeURIComponent(requestId)}/ask`, body);
  }

  release(requestId, reason) {
    return this.request('DELETE', `/v1/requests/${encodeURIComponent(requestId)}`, reason ? { reason } : {});
  }

  /** One long-poll: {requestId} or {runId, afterStep}; maxMs at most 45000. */
  wait(body, { signal } = {}) {
    const maxMs = Math.min(Math.max(body?.maxMs ?? 30_000, 0), MAX_WAIT_MS);
    return this.request('POST', '/v1/wait', body, { timeoutMs: maxMs + LONG_POLL_SLACK_MS, signal });
  }

  /** Loop wait until the request leaves pending/paused or timeoutMs passes. Resolves the last wait response. */
  async waitForTab(requestId, { timeoutMs = 120_000, signal } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      const response = await this.wait({ requestId, maxMs: Math.max(0, Math.min(remaining, MAX_WAIT_MS)) }, { signal });
      if (!['pending', 'paused'].includes(response.state) || Date.now() >= deadline) return response;
    }
  }

  /** Loop wait on a run until it is done. With onProgress(progress), reports each new step. */
  async waitForRun(response, { signal, onProgress } = {}) {
    let current = response;
    while (current.state === 'running') {
      if (signal?.aborted) {
        await this.stop(current.runId).catch(() => null);
        throw signal.reason ?? new Error('Aborted');
      }
      const afterStep = onProgress ? current.progress?.steps ?? 0 : undefined;
      try {
        current = await this.wait({ runId: current.runId, maxMs: MAX_WAIT_MS, afterStep }, { signal });
      } catch (error) {
        if (signal?.aborted) {
          await this.stop(current.runId).catch(() => null);
        }
        throw error;
      }
      if (current.state === 'running') onProgress?.(current.progress);
    }
    return current;
  }

  observe(body) {
    return this.request('POST', '/v1/observe', body, { timeoutMs: 30_000 });
  }

  async act(body, options = {}) {
    const waitMs = Math.min(Math.max(body?.waitMs ?? 40_000, 0), MAX_WAIT_MS);
    const response = await this.request('POST', '/v1/act', body,
      { timeoutMs: waitMs + LONG_POLL_SLACK_MS, signal: options.signal });
    return this.waitForRun(response, options);
  }

  stop(runId) {
    return this.request('POST', `/v1/runs/${encodeURIComponent(runId)}/stop`, {});
  }

  getRun(runId) {
    return this.request('GET', `/v1/runs/${encodeURIComponent(runId)}`);
  }

  runs({ limit, requestId } = {}) {
    return this.request('GET', `/v1/runs${query({ limit, requestId })}`);
  }

  evidence(runId, { step, kind, inline } = {}) {
    return this.request('GET',
      `/v1/runs/${encodeURIComponent(runId)}/evidence${query({ step, kind, inline: inline ? 1 : undefined })}`);
  }

  reload() {
    return this.request('POST', '/v1/daemon/reload', {});
  }

  shutdown() {
    return this.request('POST', '/v1/daemon/shutdown', {});
  }
}
