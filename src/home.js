// Daemon state files: lock, daemon.json, daemon.pid, client token, log and config.
//
// The settings directory (FAI_HOME, else the platform's per-user settings directory, src/paths.js) holds .env.local
// and config.json. Runtime state (daemon.lock, daemon.json, daemon.pid, client-token, logs/) and artifacts/ live in
// the platform's state directory, or in FAI_HOME itself when it is set. FAI_DAEMON_DIR moves the runtime state
// alone, so a benchmark or test can run an isolated daemon next to the user's. Site profiles (domains/) are the
// package's own unless FAI_HOME or FAI_DOMAINS_DIR names another directory. Every file is created 0600.
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { PACKAGE_ROOT, customHome, dataDir, faiHome } from './paths.js';
import { resolveThresholds } from './oversight.js';
import { checkBudget } from './settings.js';
import { normalizeAdditions } from './guardrails.js';
import { resolveRetry, resolveSlim } from './runtime.js';
import { resolveProfiles } from './domains.js';
import { scrubSecrets } from './secrets.js';

export const DAEMON_DEFAULT_PORT = 4318;
/**
 * Who chooses each browser action. `agent` (the default): the host agent itself, through MCP observe/act; FAI makes
 * no provider calls. `jev` (experimental, opt-in): the delegated Jev driver runs whole tasks with a provider key.
 */
export const DRIVERS = Object.freeze(['agent', 'jev']);
export const DEFAULT_DRIVER = 'agent';
const TOKEN = /^[0-9a-f]{64}$/;
const LOG_MAX_BYTES = 5 * 1024 * 1024;

/** Resolve every daemon path for a home directory and environment. */
export function homePaths({ home, env = process.env } = {}) {
  const root = home ? resolve(home) : faiHome(env);
  const custom = customHome(root, env);
  const data = dataDir(root, env);
  const stateDir = env.FAI_DAEMON_DIR ? resolve(env.FAI_DAEMON_DIR) : data;
  const logDir = join(stateDir, 'logs');
  return {
    home: root,
    // False for the platform default: a spawned daemon then resolves the same directories without FAI_HOME.
    custom,
    dataDir: data,
    stateDir,
    envFile: join(root, '.env.local'),
    config: join(root, 'config.json'),
    artifacts: join(data, 'artifacts'),
    domains: env.FAI_DOMAINS_DIR ? resolve(env.FAI_DOMAINS_DIR) : join(custom ? root : PACKAGE_ROOT, 'domains'),
    clientToken: join(stateDir, 'client-token'),
    lock: join(stateDir, 'daemon.lock'),
    daemonJson: join(stateDir, 'daemon.json'),
    pidFile: join(stateDir, 'daemon.pid'),
    logDir,
    logFile: join(logDir, 'daemon.log'),
  };
}

/**
 * The port the daemon listens on and clients connect to: FAI_DAEMON_PORT, else FAI_BRIDGE_PORT (the extension
 * shares the listener), else 4318. `0` means "any free port" for the daemon; clients then read daemon.json.
 */
export function configuredPort(env = process.env) {
  for (const name of ['FAI_DAEMON_PORT', 'FAI_BRIDGE_PORT']) {
    const value = env[name];
    if (value === undefined || value === '') continue;
    const port = Number(value);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`${name} must be a port number`);
    return port;
  }
  return DAEMON_DEFAULT_PORT;
}

export function ensureDir(path, mode = 0o700) {
  mkdirSync(path, { recursive: true, mode });
}

export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function writeExclusive(path, content) {
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
}

/** Atomic replace with mode 0600. */
export function writePrivate(path, content) {
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' });
  renameSync(temporary, path);
}

function unlinkQuiet(path) {
  try {
    unlinkSync(path);
  } catch {
    // Already gone.
  }
}

/**
 * Take the single-instance lock by creating daemon.lock exclusively. A lock left by a dead process is removed and
 * the create retried once. Returns {ok:true} or {ok:false, pid} when a live process holds it.
 */
export function acquireLock(paths, { pid = process.pid, now = Date.now } = {}) {
  ensureDir(paths.stateDir);
  const content = JSON.stringify({ pid, startedAt: new Date(now()).toISOString() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeExclusive(paths.lock, content);
      return { ok: true };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const holder = readJson(paths.lock);
    if (holder && isAlive(holder.pid)) return { ok: false, pid: holder.pid };
    unlinkQuiet(paths.lock);
  }
  const holder = readJson(paths.lock);
  return { ok: false, pid: holder?.pid ?? null };
}

/** Remove the lock only if this process holds it. */
export function releaseLock(paths, pid = process.pid) {
  const holder = readJson(paths.lock);
  if (holder?.pid === pid) unlinkQuiet(paths.lock);
}

export function readLock(paths) {
  return readJson(paths.lock);
}

export function writeDaemonInfo(paths, info) {
  ensureDir(paths.stateDir);
  writePrivate(paths.daemonJson, `${JSON.stringify(info)}\n`);
  writePrivate(paths.pidFile, `${info.pid}\n`);
}

export function readDaemonInfo(paths) {
  return readJson(paths.daemonJson);
}

/** Remove daemon.json and daemon.pid if they belong to `pid`. */
export function removeDaemonInfo(paths, pid = process.pid) {
  const info = readJson(paths.daemonJson);
  if (!info || info.pid === pid) unlinkQuiet(paths.daemonJson);
  try {
    if (Number(readFileSync(paths.pidFile, 'utf8').trim()) === pid) unlinkQuiet(paths.pidFile);
  } catch {
    // No pid file.
  }
}

/** Create the client token (64 hex chars, 0600) if absent and return it. */
export function ensureClientToken(paths) {
  ensureDir(paths.stateDir);
  try {
    writeExclusive(paths.clientToken, `${randomBytes(32).toString('hex')}\n`);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const token = readFileSync(paths.clientToken, 'utf8').trim();
  if (!TOKEN.test(token)) throw new Error(`${paths.clientToken} is not a valid client token; delete it and restart`);
  return token;
}

/** The token a client sends: FAI_CLIENT_TOKEN, else the token file; null when neither exists. */
export function readClientToken(paths, env = process.env) {
  if (env.FAI_CLIENT_TOKEN) return env.FAI_CLIENT_TOKEN;
  try {
    const token = readFileSync(paths.clientToken, 'utf8').trim();
    return TOKEN.test(token) ? token : null;
  } catch {
    return null;
  }
}

// No config key grants a permission level or a capability, and none can raise one: the level comes only from the
// user's approval in the extension (the lease), `guardrails` can only add forbidden labels and `thresholds.commitVeto`
// can only be lowered. Unknown keys (a "level", "mode" or "testing" key included) are rejected.
const CONFIG_KEYS = new Set([
  'retention', 'provider', 'providerOptions', 'requestTtlMs', 'leaseIdleMs', 'idleShutdownMs', 'outputDir',
  'thresholds', 'budget', 'guardrails', 'retry', 'slim', 'profiles', 'driver',
]);
/** Read FAI_HOME/config.json (only the driver when absent; `defaultDriver` when it names none). Throws on invalid JSON or unknown keys. */
/** Read FAI_HOME/config.json ({} when absent). Throws on invalid JSON or unknown keys. */
export function loadConfig(paths, { defaultDriver = DEFAULT_DRIVER } = {}) {
  let text;
  try {
    text = readFileSync(paths.config, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { driver: defaultDriver };
    throw new Error(`Cannot read ${paths.config}: ${error.code ?? error.message}`);
  }
  let config;
  try {
    config = JSON.parse(text);
  } catch (error) {
    throw new Error(`${paths.config} is not valid JSON: ${error.message}`);
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`${paths.config} must contain a JSON object`);
  }
  const unknown = Object.keys(config).filter(key => !CONFIG_KEYS.has(key));
  if (unknown.length) throw new Error(`Unknown config.json key: ${unknown.join(', ')}`);
  if (config.driver !== undefined && !DRIVERS.includes(config.driver)) {
    throw new Error('config.json driver must be agent or jev');
  }
  for (const key of ['requestTtlMs', 'leaseIdleMs', 'idleShutdownMs']) {
    if (config[key] !== undefined && (!Number.isSafeInteger(config[key]) || config[key] < 0)) {
      throw new Error(`config.json ${key} must be a non-negative integer`);
    }
  }
  if (config.providerOptions !== undefined && (typeof config.providerOptions !== 'object'
    || config.providerOptions === null || Array.isArray(config.providerOptions))) {
    throw new Error('config.json providerOptions must be an object');
  }
  if (config.thresholds !== undefined) {
    try {
      resolveThresholds({ thresholds: config.thresholds });
    } catch (error) {
      throw new Error(`config.json thresholds: ${error.message}`);
    }
  }
  if (config.budget !== undefined) {
    try {
      checkBudget(config.budget);
    } catch (error) {
      throw new Error(`config.json ${error.message}`);
    }
  }
  // Guardrail additions for every run (src/guardrails.js): { forbid: [plain phrases], note }. Restrict-only.
  if (config.guardrails !== undefined) {
    try {
      config.guardrails = normalizeAdditions(config.guardrails, 'config.json guardrails');
    } catch (error) {
      throw new Error(error.message);
    }
  }
  // In-call retries for every run (src/runtime.js resolveRetry): false turns them off, an object single switches.
  if (config.retry !== undefined) {
    try {
      resolveRetry(config.retry);
    } catch (error) {
      throw new Error(`config.json ${error.message}`);
    }
  }
  // Slim provider requests for every run (src/runtime.js resolveSlim): a boolean or single switches.
  if (config.slim !== undefined) {
    try {
      resolveSlim(config.slim);
    } catch (error) {
      throw new Error(`config.json ${error.message}`);
    }
  }
  // Site profiles for every run (src/domains.js resolveProfiles): "off" (default), "on" or { fastPath, hints }.
  if (config.profiles !== undefined) {
    try {
      resolveProfiles(config.profiles);
    } catch (error) {
      throw new Error(`config.json ${error.message}`);
    }
  }
  if (config.outputDir !== undefined) config.outputDir = resolve(paths.home, String(config.outputDir));
  config.driver ??= defaultDriver;
  return config;
}

/**
 * The saved driver without ever throwing: `{ driver, error }`, where a missing, unreadable or invalid config.json
 * yields DEFAULT_DRIVER and `error` names the problem (null when the file was fine). For callers that must always
 * answer (the MCP server's initialize and tools/list), never for anything that writes the config.
 */
export function readDriver(paths) {
  try {
    return { driver: loadConfig(paths).driver, error: null };
  } catch (error) {
    return { driver: DEFAULT_DRIVER, error: String(error?.message ?? error) };
  }
}

/** Setup's control choice, preserving the user's other config values as written. */
export function saveDriver(driver, paths = homePaths()) {
  if (!DRIVERS.includes(driver)) throw new Error('driver must be agent or jev');
  loadConfig(paths); // Refuse to overwrite a malformed or unsupported config.
  let config = {};
  try {
    config = JSON.parse(readFileSync(paths.config, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  ensureDir(paths.home);
  writePrivate(paths.config, `${JSON.stringify({ ...config, driver }, null, 2)}\n`);
}

/**
 * JSON-lines logger with rotation at 5 MB (one previous file kept as daemon.log.1). Callers must pass only
 * routes, statuses, ids, durations and state names: never bodies, page text, tokens, secrets or keys.
 */
export function createLogger(paths, { maxBytes = LOG_MAX_BYTES } = {}) {
  ensureDir(paths.logDir);
  let fd = openSync(paths.logFile, 'a', 0o600);
  let size = 0;
  try {
    size = statSync(paths.logFile).size;
  } catch {
    size = 0;
  }
  const log = (event, fields = {}) => {
    if (fd === null) return;
    // Callers pass no page text; the secret pass (src/secrets.js) still guards an error message that quoted one.
    const line = `${JSON.stringify(scrubSecrets({ t: new Date().toISOString(), event, ...fields }))}\n`;
    if (size + line.length > maxBytes) {
      closeSync(fd);
      try {
        renameSync(paths.logFile, `${paths.logFile}.1`);
      } catch {
        // Rotation is best effort.
      }
      fd = openSync(paths.logFile, 'a', 0o600);
      size = 0;
    }
    writeSync(fd, line);
    size += line.length;
  };
  log.close = () => {
    if (fd !== null) closeSync(fd);
    fd = null;
  };
  log.path = paths.logFile;
  return log;
}
