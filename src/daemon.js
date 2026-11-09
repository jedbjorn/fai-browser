// The FAI Browser daemon: one loopback HTTP server shared by agent clients (/v1/*) and the extension (everything
// else, handled by the hub). It owns tab requests and leases, runs, traces, retention, provider config and the
// Jev key. See the Phase 2 design, sections 1 and 2.
import http from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { BrowserRuntime, actionLabels, checkActChoice, redactionMeta, resolveRetry, resolveSlim } from './runtime.js';
import { checkDeclarative, validateExpectation } from './expectation.js';
import { setTimeout as delay } from 'node:timers/promises';
import { LIST_MAX_ACTIONS, checkSummary, foldTopLevel, listActionBudget, listInstruction } from './steps.js';
import { agentResult, applyLeaseMessage, approvalSteps, createResult, isKnownCode, outcomeResult, setOutcome } from './result.js';
import { hostInfo, imageSize, toAgentResult, writeRun } from './trace.js';
import { prune, retentionConfig } from './retention.js';
import { LocalSystemOneProvider, TypeSafeProvider } from './typesafe.js';
import { PACKAGE_ROOT } from './paths.js';
import {
  acquireLock,
  configuredPort,
  DEFAULT_DRIVER,
  createLogger,
  ensureClientToken,
  ensureDir,
  homePaths,
  loadConfig,
  readDaemonInfo,
  releaseLock,
  removeDaemonInfo,
  saveDriver,
  writeDaemonInfo,
} from './home.js';
import { DEFAULT_BUDGET, checkBudget, envFileMtime, loadDaemonSettings } from './settings.js';
import { DEFAULT_THRESHOLDS, resolveThresholds } from './oversight.js';
import { LEVELS, clampLevel, isLevel, levelRank, normalizeAdditions } from './guardrails.js';
import { probeHealth } from './client.js';
import { createDomainStore, domainStatsDir, resolveProfiles } from './domains.js';
import { checkOriginEntry, isSiteEntry, leaseOrigins, originCovered, siteRoots, urlCovered } from './origins.js';
import { scrubSecrets } from './secrets.js';
import { spawn } from 'node:child_process';
import { automaticCheck, createUpdateChecker, runningUpdate, underTest, claimUpdateLock, writeInstallState } from './update.js';
import { gitReleaseSource, scrubbedEnv } from './update-git.js';

export const DAEMON_VERSION = readPackageVersion();
export const SERVICE_NAME = 'fai-browser';
/** Every blocking client call returns within this bound (Codex's default MCP tool timeout is 60 s). */
export const MAX_WAIT_MS = 45_000;
export const DEFAULT_WAIT_MS = 30_000;
export const DEFAULT_RUN_WAIT_MS = 40_000;
export const MAX_PENDING_REQUESTS = 5;

/** The longest start URL a tab request takes (the page the extension opens on approval). */
const MAX_START_URL = 2048;
const OBSERVE_TIMEOUT_MS = 15_000;
const OBSERVE_CAPTURE_MS = 5_000;
const STOP_WAIT_MS = 5_000;
const SHUTDOWN_RUN_WAIT_MS = 5_000;
const DEFAULT_REQUEST_TTL_MS = 600_000;
const DEFAULT_LEASE_IDLE_MS = 900_000;
const PAUSED_TTL_MS = 30 * 60_000;
const TERMINAL_KEEP_MS = 60 * 60_000;
const BODY_LIMIT = 1024 * 1024;
const LOCK_WAIT_MS = 5_000;

const TERMINAL = new Set(['cancelled', 'expired', 'denied', 'released']);
const LIVE = new Set(['pending', 'active', 'paused']);
const LEASED = new Set(['active', 'paused']);
const REQUEST_STATES = new Set([...LIVE, ...TERMINAL]);
const MODE_RANK = Object.freeze(Object.fromEntries(LEVELS.map((level, rank) => [level, rank])));
const PAUSE_REASONS = new Set(['paused', 'tab_changed', 'origin_changed', 'child_tab', 'session_inactive',
  'disconnected']);
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SUPPLIED_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const PROVIDER_OPTION_KEYS = new Set(['port', 'model', 'timeoutMs']);

const RUN_KEYS = new Set(['requestId', 'operation', 'instruction', 'maxActions', 'maxDecisions', 'timeoutMs',
  'capture', 'mode', 'expectation', 'allowedUrls', 'suppliedText', 'provider', 'providerOptions', 'prune', 'waitMs',
  'outputDir', 'minConfidence', 'doneThreshold', 'answerQuestion', 'thresholds', 'policy', 'retry', 'slim', 'steps',
  'profiles']);
const ACT_KEYS = new Set(['requestId', 'actionId', 'point', 'revision', 'expectation', 'capture', 'timeoutMs', 'waitMs',
  'prune', 'outputDir', 'answerQuestion', 'approvalWaitMs', 'reason',
  // Host-composed acts (src/runtime.js checkActChoice): typed text, batched fills, keys, hover, URLs, history, tabs,
  // dialog answers and uploads.
  'text', 'submit', 'fills', 'hover', 'key', 'url', 'openTab', 'nav', 'tab', 'dialog', 'file']);
// The parts of an act body that make up the runtime's choice.
const CHOICE_KEYS = ['actionId', 'point', 'text', 'submit', 'fills', 'hover', 'key', 'url', 'openTab', 'nav', 'tab', 'dialog', 'file'];
const OBSERVE_KEYS = new Set(['requestId', 'mode', 'allowedUrls', 'suppliedText', 'capture', 'prune', 'outputDir',
  'instruction', 'expectation', 'answerQuestion', 'policy', 'focus', 'digestChars', 'waitFor', 'maxMs', 'logs']);
// observe {waitFor, maxMs}: the conditions a host may wait for (matched on the redacted page), the default and longest
// wait, and the poll interval.
const WAIT_FOR_FIELDS = new Set(['textIncludes', 'textAbsent', 'urlIncludes']);
const OBSERVE_WAIT_DEFAULT_MS = 10_000;
const OBSERVE_WAIT_MAX_MS = 30_000;
const OBSERVE_WAIT_POLL_MS = 400;
// The largest file an act may upload (src/mcp.js MAX_UPLOAD_BYTES; the extension accepts up to 25 MB).
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
// The most page text one observe's digest may carry when the host asks for more (digestChars).
export const OBSERVE_DIGEST_MAX_CHARS = 6000;
const REQUEST_KEYS = new Set(['origins', 'mode', 'reason', 'instruction', 'url', 'ttlMs']);
const WAIT_KEYS = new Set(['requestId', 'runId', 'maxMs', 'afterStep', 'while']);

function readPackageVersion() {
  try {
    return JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Errors and validation helpers
// ---------------------------------------------------------------------------------------------------------------

export class HttpError extends Error {
  constructor(status, code, message, { retryable = false } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

const badOptions = message => new HttpError(400, 'invalid_options', message);

function errorBody(code, message, retryable = false) {
  return { error: { code, message, retryable } };
}

/** Clamp a client wait to [0, max]; undefined gives the default. */
export function clampWait(value, fallback, max = MAX_WAIT_MS) {
  if (value === undefined || value === null) return Math.min(fallback, max);
  if (typeof value !== 'number' || !Number.isFinite(value)) throw badOptions('Wait times must be numbers');
  return Math.min(Math.max(Math.trunc(value), 0), max);
}

function checkKeys(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'bad_request', 'Body must be a JSON object');
  const unknown = Object.keys(body).filter(key => !allowed.has(key));
  if (unknown.length) throw badOptions(`Unknown field: ${unknown.join(', ')}`);
}

function withoutUndefinedFields(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

function optionalInt(body, name, min, max) {
  const value = body[name];
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw badOptions(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

/**
 * The page the extension opens when the user approves a request: `value` when it is an http(s) URL on one of
 * `origins`, else (absent) the first exact origin's root, else the first domain root's apex (which may redirect to www).
 */
function startUrl(value, origins) {
  if (value === undefined || value === null) {
    const exact = origins.find(entry => !isSiteEntry(entry));
    return exact ? `${exact}/` : `https://${siteRoots(origins)[0]}/`;
  }
  if (typeof value !== 'string' || value.length > MAX_START_URL || !/^https?:\/\//i.test(value)) {
    throw badOptions(`url must be an http(s) URL of at most ${MAX_START_URL} characters`);
  }
  if (!urlCovered(value, origins)) throw new HttpError(422, 'origin_not_granted', `url is outside the requested origins: ${value.slice(0, 200)}`);
  return new URL(value).href;
}

function optionalString(body, name, max) {
  const value = body[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > max) throw badOptions(`${name} must be a string of at most ${max} characters`);
  return value;
}

function oneOf(body, name, values, fallback) {
  const value = body[name];
  if (value === undefined) return fallback;
  if (!values.includes(value)) throw badOptions(`${name} must be one of ${values.join(', ')}`);
  return value;
}

/**
 * The origins a record's runs may use: the lease's (narrowed to the tab's origin when the user approved a domain root
 * for that origin only), else the request's entries.
 */
function coveredOrigins(record) {
  return [...(record.lease?.origins ?? record.origins)];
}

/** The scope a lease message asks for: `domain` only when the request has a domain root and the extension says so. */
function leaseScope(event, record) {
  return event.scope === 'domain' && siteRoots(record.origins).length ? 'domain' : 'origin';
}

/**
 * The run's requested mode (default: the request's). No longer refused when above the grant: the run is clamped to
 * the level the user approved (effectiveLevel) and the receipt's `permissions` block reports both.
 */
function checkMode(body, record) {
  return oneOf(body, 'mode', [...LEVELS], record.mode);
}

/** The level a run on this record uses: the requested mode clamped to the user's grant (read-only without one). */
function effectiveLevel(mode, record) {
  return clampLevel(mode, record.grant?.level ?? 'read-only');
}

/** The trusted `permissions` block for a receipt on this record. */
function permissionsOf(mode, record) {
  const granted = record.grant?.level ?? null;
  const effective = effectiveLevel(mode, record);
  // scope: what the approved tab covers, `origin` (exact origins) or `domain` (the request's domain roots); null
  // before approval.
  const scope = record.grant ? (record.grant.scope === 'domain' ? 'domain' : 'origin') : null;
  return { requested: mode, granted, effective, testing: effective === 'testing', scope,
    tabMode: record.grant?.tabMode ?? 'single' };
}

// Refusal text for a lease_level message that would raise the grant (src/bridge.js refuses it the same way).
const LEVEL_RAISE_MESSAGE = 'A lease_level message can only lower the level; raising it needs a new approval '
  + 'in the FAI Browser popup';

/**
 * The grant a lease message carries: the level the user chose in the popup. A missing level (an older extension)
 * keeps the old behaviour: reversible when the request asked for at least that, else read-only. Null for an
 * invalid level (the lease is refused).
 */
export function grantFor(level, record, grantedAt, scope = 'origin', tabMode = 'single') {
  if (!['single', 'multiple'].includes(tabMode)) return null;
  if (level === undefined || level === null) {
    const fallback = levelRank(record.mode) >= MODE_RANK.reversible ? 'reversible' : 'read-only';
    return { level: fallback, testing: false, grantedAt, scope, tabMode };
  }
  if (!isLevel(level)) return null;
  return { level, testing: level === 'testing', grantedAt, scope, tabMode };
}

function checkAllowedUrls(body, record) {
  const urls = body.allowedUrls ?? [];
  if (!Array.isArray(urls) || urls.length > 10 || !urls.every(url => typeof url === 'string' && url.length <= 2048)) {
    throw badOptions('allowedUrls must be an array of at most 10 URL strings');
  }
  for (const url of urls) {
    if (!urlCovered(url, coveredOrigins(record))) {
      throw new HttpError(422, 'origin_not_granted', `allowedUrls entry is outside the requested origins: ${url}`);
    }
  }
  return [...urls];
}

function checkSuppliedText(body) {
  const supplied = body.suppliedText ?? {};
  if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) {
    throw badOptions('suppliedText must be an object of strings');
  }
  const entries = Object.entries(supplied);
  if (entries.length > 20) throw badOptions('suppliedText accepts at most 20 values');
  for (const [name, value] of entries) {
    if (!SUPPLIED_NAME.test(name)) throw badOptions('suppliedText names must be 1-64 letters, digits, "_", "." or "-"');
    if (typeof value !== 'string' || value.length > 10_000) throw badOptions(`suppliedText.${name} must be a string`);
  }
  return Object.fromEntries(entries);
}

/**
 * Optional step list (src/steps.js) instead of instruction: validated here, before any provider call, with a
 * top-level expectation and answerQuestion folded in (foldTopLevel). Returns the normalized list or undefined.
 */
function checkSteps(body, operation) {
  if (body.steps === undefined || body.steps === null) return undefined;
  if (operation !== 'run') throw badOptions('steps need operation run');
  try {
    // An instruction next to steps is the task summary (runSpec keeps it); the steps are the task.
    checkSummary(body.instruction);
    // A top-level expectation or question is folded into the last step (or checked at the end by the runtime).
    return foldTopLevel(body.steps, { expectation: body.expectation, answerQuestion: body.answerQuestion, maxActions: 100 }).steps;
  } catch (error) {
    throw badOptions(error.message);
  }
}

/** A step list's default action budget (the runtime's: each step's maxActions, default 8, summed; at most 60). */
function listActions(steps) {
  return steps ? listActionBudget(steps) : undefined;
}


function checkExpectation(body) {
  const expectation = body.expectation;
  if (expectation === undefined || expectation === null) return undefined;
  if (typeof expectation !== 'object' || Array.isArray(expectation)) {
    throw badOptions('expectation must be a declarative JSON object');
  }
  try {
    validateExpectation(expectation);
  } catch (error) {
    throw badOptions(error.message);
  }
  return { ...expectation };
}

function checkProviderOptions(body) {
  const options = body.providerOptions;
  if (options === undefined) return {};
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw badOptions('providerOptions must be an object');
  const forbidden = Object.keys(options).filter(key => !PROVIDER_OPTION_KEYS.has(key));
  if (forbidden.length) {
    throw new HttpError(422, 'provider_option_forbidden',
      `providerOptions accepts only port, model and timeoutMs; set ${forbidden.join(', ')} in config.json`);
  }
  if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535)) {
    throw badOptions('providerOptions.port must be a port number');
  }
  if (options.model !== undefined && (typeof options.model !== 'string' || !options.model || options.model.length > 100)) {
    throw badOptions('providerOptions.model must be a short string');
  }
  if (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 100
    || options.timeoutMs > 120_000)) {
    throw badOptions('providerOptions.timeoutMs must be an integer between 100 and 120000');
  }
  return { ...options };
}

/** Optional done threshold (0-1); the runtime defaults it to 0.5. */
function checkDoneThreshold(body) {
  const value = body.doneThreshold;
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !(value >= 0 && value <= 1)) throw badOptions('doneThreshold must be a number from 0 to 1');
  return value;
}

function checkMinConfidence(body) {
  const value = body.minConfidence;
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !(value >= 0 && value <= 1)) throw badOptions('minConfidence must be a number from 0 to 1');
  return value;
}

/** Optional gate thresholds (linkFloor, controlFloor, doneThreshold, strongDone, answerConfirm, answerMargin). */
function checkThresholds(body) {
  const value = body.thresholds;
  if (value === undefined) return undefined;
  try {
    resolveThresholds({ thresholds: value });
  } catch (error) {
    throw badOptions(`thresholds: ${error.message}`);
  }
  return { ...value };
}

/** Optional in-call retry switches (src/runtime.js resolveRetry): a boolean or { secondOpinion, backOut, rerun }. */
function checkRetry(body) {
  if (body.retry === undefined || body.retry === null) return undefined;
  try {
    resolveRetry(body.retry);
  } catch (error) {
    throw badOptions(error.message);
  }
  return typeof body.retry === 'boolean' ? body.retry : { ...body.retry };
}

/** Optional site-profile switch (src/domains.js resolveProfiles): "on", "off", a boolean or { fastPath, hints }. */
function checkProfiles(body) {
  if (body.profiles === undefined || body.profiles === null) return undefined;
  try {
    resolveProfiles(body.profiles);
  } catch (error) {
    throw badOptions(error.message);
  }
  return typeof body.profiles === 'object' ? { ...body.profiles } : body.profiles;
}

/** Optional slim provider request switches (src/runtime.js resolveSlim): a boolean or single switches. */
function checkSlim(body) {
  if (body.slim === undefined || body.slim === null) return undefined;
  try {
    resolveSlim(body.slim);
  } catch (error) {
    throw badOptions(error.message);
  }
  return typeof body.slim === 'boolean' ? body.slim : { ...body.slim };
}

/**
 * Optional guardrail additions for this run (src/guardrails.js): an array of plain phrases or { forbid, note }.
 * Validated here, before any provider call; returns the normalized { forbid, note } or undefined.
 */
function checkPolicy(body) {
  if (body.policy === undefined || body.policy === null) return undefined;
  try {
    const policy = normalizeAdditions(body.policy, 'policy');
    return policy.forbid.length || policy.note ? policy : undefined;
  } catch (error) {
    throw badOptions(error.message);
  }
}

/** Optional question for the answer candidates; the runtime defaults it to the instruction. */
function checkAnswerQuestion(body) {
  const value = optionalString(body, 'answerQuestion', 2000);
  if (value !== undefined && !value.trim()) throw badOptions('answerQuestion must not be blank');
  return value;
}

function checkOutputDir(body) {
  if (body.outputDir === undefined) return undefined;
  if (typeof body.outputDir !== 'string' || !isAbsolute(body.outputDir)) throw badOptions('outputDir must be an absolute path');
  return resolve(body.outputDir);
}

function checkPrune(body) {
  if (body.prune === undefined) return true;
  if (typeof body.prune !== 'boolean') throw badOptions('prune must be a boolean');
  return body.prune;
}

function configError(message) {
  const error = new Error(message);
  error.code = 'config';
  return error;
}

/** Default provider construction. Endpoints come only from config.json, never from a client. */
export function defaultProviderFactory({ name, options, env }) {
  if (name === 'local') return new LocalSystemOneProvider(options);
  if (name !== 'typesafe') throw configError(`Unknown provider "${name}"; expected typesafe or local`);
  if (!env.TYPESAFE_API_KEY) throw configError('The Jev key is not configured');
  return new TypeSafeProvider(options);
}

function iso(ms) {
  return ms === null || ms === undefined ? null : new Date(ms).toISOString();
}

function newRequestId() {
  return `req_${randomBytes(9).toString('base64url')}`;
}

function digest(value) {
  return createHash('sha256').update(String(value)).digest();
}

function clientName(header) {
  if (typeof header !== 'string' || !header) return null;
  const name = header.split('/')[0];
  return /^[A-Za-z0-9_.-]{1,40}$/.test(name) ? name : 'unknown';
}

function sendJson(res, status, value, headers = {}) {
  if (res.writableEnded || res.destroyed) return;
  // Secret redaction, final daemon pass (src/secrets.js): no response body carries a secret.
  const body = JSON.stringify(scrubSecrets(value));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > BODY_LIMIT) throw new HttpError(413, 'too_large', 'Request body exceeds 1 MB');
    chunks.push(chunk);
  }
  if (!length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'bad_request', 'Request body is not valid JSON');
  }
}

/** Lean agent result of an unwritten runtime result (the trace could not be written): trace null. */
/** Start the updater in its own process group: it outlives this daemon, which it restarts. argv only, no shell. */
function defaultSpawnUpdater(args, env) {
  const child = spawn(process.execPath, args, { cwd: PACKAGE_ROOT, env, detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  return child.pid;
}

function unwrittenResult(raw) {
  return { ...agentResult(JSON.parse(JSON.stringify(raw))), trace: null };
}

// ---------------------------------------------------------------------------------------------------------------
// Daemon
// ---------------------------------------------------------------------------------------------------------------

/**
 * Create a daemon. Nothing is read or bound until listen().
 * Options: home, env, port (default FAI_DAEMON_PORT / FAI_BRIDGE_PORT / 4318; 0 = any), hub (injected hub),
 * hubFactory, providerFactory, now, log, version, maxWaitMs, sweepIntervalMs, onShutdownRequest, warm (false skips
 * the background provider warm-up at start and on approval).
 */
export function createDaemon(options = {}) {
  const env = options.env ?? process.env;
  const paths = homePaths({ home: options.home, env });
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  const version = options.version ?? DAEMON_VERSION;
  const maxWaitMs = options.maxWaitMs ?? MAX_WAIT_MS;
  const providerFactory = options.providerFactory ?? defaultProviderFactory;
  // The driver when config.json names none (an embedding or a test harness may pick Jev); DEFAULT_DRIVER otherwise.
  const defaultDriver = options.driver ?? DEFAULT_DRIVER;
  // Site profiles (src/domains.js): $FAI_DOMAINS_DIR, FAI_HOME/domains or the package's, matched by exact origin per
  // run. Counters go to <data dir>/domain-stats (or the state dir, or a temp dir): never inside the package's domains/.
  const domains = options.domains ?? createDomainStore({
    dir: paths.domains, statsDir: domainStatsDir({ home: paths.dataDir, stateDir: paths.stateDir }), log: (event, fields) => log(event, fields),
  });
  const requestedPort = options.port ?? configuredPort(env);

  const requests = new Map();
  // Values filled into password inputs (testing level) by any run of this daemon: redacted from later results.
  const filledSecrets = new Set();
  const runs = new Map();
  const watchers = new Set();
  let settings = null;
  let config = { driver: defaultDriver };
  let driverChanges = Promise.resolve();
  // The user's per-request call budget from the extension popup ({maxCalls, maxMs}), null until one is reported.
  let userBudget = null;
  // Whether the extension opens a request's page by itself (its "Open requested pages right away" setting, reported
  // with the budget in the hello and settings messages); null until an extension reports it (an older one never does).
  let openRightAway = null;
  // The Approve gate's asks the extension reports ({purchase, secret, level}; booleans, never anything sensitive), so
  // an agent's offer marks "(asks the user)" only what the extension will ask about. All on until reported.
  let approvalAsks = { purchase: true, secret: true, level: true };
  let token = null;
  let tokenDigest = null;
  let hub = null;
  let server = null;
  let port = null;
  let startedAt = null;
  let sweepTimer = null;
  let lastClientCallAt = now();
  let shuttingDown = false;
  let closing = null;
  let warming = null; // the provider warm-up in flight (warmProvider)
  let warmAbort = new AbortController();
  const warnings = [];
  // Update check (src/update.js): about once a day, off with FAI_UPDATE_CHECK=0, config.json updateCheck: false, or
  // under node --test unless options.updateCheck is true. Installing needs the user's click (onUpdateEvent) or command.
  // The environment this daemon was started with, before loadDaemonSettings adds the Jev key to `env`, and without
  // FAI's secrets: the updater and everything it starts (git, npm, the restarted daemon) get only this.
  const launchEnv = scrubbedEnv(env);
  // Only a git clone can update itself; anything else is told how to update by hand.
  const installable = options.updateInstallable ?? existsSync(join(PACKAGE_ROOT, '.git'));
  // A private repository is invisible to the anonymous API: then `git ls-remote` on the clone's verified remote, with
  // the user's own git credentials (never under node --test unless a test supplies its own source).
  const gitSource = options.updateGitSource
    ?? (installable && !underTest(env) ? gitReleaseSource({ root: PACKAGE_ROOT, env: launchEnv }) : null);
  const updates = createUpdateChecker({ paths, currentVersion: version, fetch: options.updateFetch, log, gitSource, installable,
    enabled: () => automaticCheck({ env, config, override: options.updateCheck }).enabled,
    ...(options.updateStartupDelayMs !== undefined ? { startupDelayMs: options.updateStartupDelayMs } : {}) });

  // --- change notification ----------------------------------------------------------------------------------

  function wake() {
    for (const watcher of [...watchers]) watcher();
  }

  function changed() {
    wake();
    try {
      hub?.publishRequests(liveViews());
    } catch (error) {
      log('hub_publish_error', { message: String(error?.message ?? error) });
    }
  }

  /** Resolve when predicate() holds, at the deadline, or when the signal aborts. Uses real time. */
  async function waitUntil(predicate, maxMs, signal) {
    const deadline = Date.now() + maxMs;
    while (!predicate() && !shuttingDown && !signal?.aborted) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      await new Promise(resolveWait => {
        const done = () => {
          clearTimeout(timer);
          watchers.delete(done);
          signal?.removeEventListener('abort', done);
          resolveWait();
        };
        const timer = setTimeout(done, remaining);
        watchers.add(done);
        signal?.addEventListener('abort', done, { once: true });
      });
    }
  }

  // --- requests ---------------------------------------------------------------------------------------------

  function expiresAt(record) {
    switch (record.state) {
      case 'pending':
        return record.createdAt + record.ttlMs;
      case 'active':
        return record.lastCallAt + leaseIdleMs();
      case 'paused':
        return record.pausedAt + PAUSED_TTL_MS;
      default:
        return null;
    }
  }

  function view(record) {
    return {
      requestId: record.requestId,
      state: record.state,
      stateReason: record.stateReason,
      origins: [...record.origins],
      mode: record.mode,
      grant: record.grant ? { ...record.grant } : null,
      reason: record.reason,
      instruction: record.instruction,
      url: record.url,
      client: record.client,
      createdAt: iso(record.createdAt),
      expiresAt: iso(expiresAt(record)),
      lease: record.lease ? { ...record.lease } : null,
      activeRunId: record.activeRunId,
      lastRunId: record.lastRunId,
      // How a pending request is approved (`page`: its page opened by itself, the icon click on it approves; `window`:
      // Open in the FAI Browser window first); null once it is no longer pending.
      approval: record.state === 'pending' ? approvalOf(record) : null,
    };
  }

  function liveViews() {
    return [...requests.values()].filter(record => LIVE.has(record.state)).map(view);
  }

  function setState(record, state, reason = null) {
    record.state = state;
    record.stateReason = reason;
    if (state === 'paused') record.pausedAt = now();
    if (TERMINAL.has(state)) {
      record.endedAt = now();
      record.runtime = null;
    }
    log('request_state', { requestId: record.requestId, state, reason });
    changed();
  }

  function getRecord(requestId) {
    if (typeof requestId !== 'string' || !requestId) throw badOptions('requestId is required');
    const record = requests.get(requestId);
    if (!record) {
      throw new HttpError(404, 'unknown_request',
        `No tab request ${requestId}; the daemon may have restarted. Request a tab again.`);
    }
    return record;
  }

  function touch(record) {
    record.lastCallAt = now();
  }

  function interruptActive(record, code) {
    if (code) record.runtime?.interrupt(code);
  }

  /** End a lease or request. `interrupt` is the outcome code for an active run; `notifyHub` pushes lease_update. */
  function endRequest(record, state, reason, { interrupt = null, notifyHub = true } = {}) {
    interruptActive(record, interrupt);
    const leaseId = record.lease?.leaseId;
    setState(record, state, reason);
    if (leaseId && notifyHub) {
      try {
        hub.updateLease(leaseId, state, reason);
      } catch (error) {
        log('hub_update_error', { message: String(error?.message ?? error) });
      }
    }
  }

  function findByLease(leaseId) {
    if (!leaseId) return null;
    for (const record of requests.values()) {
      if (record.lease?.leaseId === leaseId && !TERMINAL.has(record.state)) return record;
    }
    return null;
  }

  /** Compatibility for a v2 extension that sends no requestId: the newest pending, else paused, request. */
  function pickRequestFor(origin) {
    const candidates = [...requests.values()]
      .filter(record => originCovered(origin, record.origins))
      .sort((a, b) => b.createdAt - a.createdAt);
    return candidates.find(record => record.state === 'pending')
      ?? candidates.find(record => record.state === 'paused')
      ?? null;
  }

  /** The v1 result a run call returns when the lease is not active. */
  function blockedResult(record, expectation, mode = record.mode) {
    const lease = { requestId: record.requestId, state: record.state };
    const describe = expectation ? { ...expectation } : null;
    const base = { lease, expectation: describe, permissions: permissionsOf(mode, record) };
    if (record.state === 'pending') return outcomeResult('select_tab', { ...base, approval: approvalOf(record) });
    if (record.state === 'paused') {
      const code = PAUSE_REASONS.has(record.stateReason) ? record.stateReason : 'paused';
      return outcomeResult(code, base);
    }
    if (record.state === 'released' && record.stateReason === 'stopped') {
      return outcomeResult('stopped', base);
    }
    return outcomeResult('request_closed', base);
  }

  // --- hub events -------------------------------------------------------------------------------------------

  function replyTo(event, value) {
    try {
      event.reply?.(value);
    } catch (error) {
      log('hub_reply_error', { message: String(error?.message ?? error) });
    }
  }

  function onLeaseEvent(event) {
    // An update that is installing restarts this daemon: a tab approved now would be cut off by it.
    if (runningUpdate(paths)) {
      return replyTo(event, { error: { code: 'update_running',
        message: 'FAI Browser is installing an update and restarts in a moment. Approve again in a minute.' } });
    }
    const record = event.requestId ? requests.get(event.requestId) : pickRequestFor(event.origin);
    if (!record) return replyTo(event, { error: { code: 'no_request', message: 'No such tab request' } });
    // Re-approval: the user changes the level of the active lease on the same tab (no new lease). A lower level
    // takes effect on the next command (the hub clamps every command to it); a higher one on the next run.
    if (record.state === 'active' && event.requestId && record.lease?.tabId === event.tabId
      && originCovered(event.origin, record.origins) && event.level !== undefined && event.level !== null) {
      const scope = leaseScope(event, record);
      const grant = grantFor(event.level, record, iso(now()), scope, event.tabMode ?? 'single');
      if (!grant) {
        return replyTo(event, { error: { code: 'bad_request', message: `level must be one of ${LEVELS.join(', ')}` } });
      }
      const origins = leaseOrigins(record.origins, event.origin, scope);
      record.grant = grant;
      record.lease = { ...record.lease, origin: event.origin, origins };
      hub.setLeaseLevel?.(record.lease.leaseId, grant.level);
      hub.setLeaseTabMode?.(record.lease.leaseId, grant.tabMode);
      hub.setLeaseOrigins?.(record.lease.leaseId, event.origin, origins);
      record.lastCallAt = now();
      log('lease_regranted', { requestId: record.requestId, level: grant.level, scope });
      changed();
      return replyTo(event, {
        leaseId: record.lease.leaseId, requestId: record.requestId, origins: [...origins], grant: { ...grant },
      });
    }
    if (record.state !== 'pending' && record.state !== 'paused') {
      return replyTo(event, { error: { code: 'request_not_pending', message: `This request is ${record.state}` } });
    }
    if (!Number.isInteger(event.tabId) || !originCovered(event.origin, record.origins)) {
      return replyTo(event, {
        error: {
          code: 'origin_not_requested',
          message: "This tab's origin was not requested",
          origins: [...record.origins],
        },
      });
    }
    // The level the user approved for this tab (validated again here: the hub is not the only caller).
    // The scope the user approved: `domain` (the request's domain roots, with Chrome's host permission granted in the
    // extension) or `origin` (the tab's exact origin in place of a root, as for any exact request).
    const scope = leaseScope(event, record);
    const grant = grantFor(event.level, record, iso(now()), scope, event.tabMode ?? 'single');
    if (!grant) {
      return replyTo(event, { error: { code: 'bad_request', message: `level must be one of ${LEVELS.join(', ')}` } });
    }
    const origins = leaseOrigins(record.origins, event.origin, scope);
    // Phase 2: one active lease at a time. Approving another request supersedes the current one.
    for (const other of requests.values()) {
      if (other !== record && LEASED.has(other.state)) {
        endRequest(other, 'released', 'superseded', { interrupt: 'request_closed' });
      }
    }
    const leaseId = randomBytes(16).toString('hex');
    record.lease = { leaseId, tabId: event.tabId, origin: event.origin, origins, grantedAt: grant.grantedAt };
    record.grant = grant;
    record.lastCallAt = now();
    hub.bindLease({
      leaseId,
      requestId: record.requestId,
      tabId: event.tabId,
      origin: event.origin,
      allowedOrigins: [...origins],
      level: grant.level,
      tabMode: grant.tabMode,
    });
    record.runtime = new BrowserRuntime({ bridge: hub.bridgeFor(leaseId), asks: () => approvalAsks });
    // Password values filled at testing stay redacted in every later result, across leases (a re-approval at another
    // level is a new lease and a new runtime on the same tab, and the page may still echo the value).
    record.runtime.secrets = filledSecrets;
    record.bridge = hub.bridgeFor(leaseId);
    setState(record, 'active', null);
    // The first decision usually follows the approval at once; an idle daemon's connection has gone cold by now.
    warmProvider('approval');
    // origins: what the lease covers. The extension follows a consent wall's redirect only to one of these
    // (followConsentRedirect) and, with `domain` scope, keeps the session across the roots' subdomains.
    replyTo(event, { leaseId, requestId: record.requestId, origins: [...origins], grant: { ...grant } });
  }

  /**
   * Lower the user's grant on a leased record without a new approval: the extension dropped a testing session on
   * its own (the user removed a testing environment in the popup). Only ever lowers; a higher level returns a
   * `level_not_granted` error (raising needs a new approval on a request card). The hub's lease, the active run (its
   * next decision) and the next receipt's `permissions` follow at once. Returns an error reply or null.
   */
  function lowerGrant(record, level, source) {
    if (!isLevel(level)) {
      return { error: { code: 'bad_request', message: `level must be one of ${LEVELS.join(', ')}` } };
    }
    const current = record.grant?.level ?? 'read-only';
    if (levelRank(level) > levelRank(current)) {
      return { error: { code: 'level_not_granted', message: LEVEL_RAISE_MESSAGE } };
    }
    if (level === current) return null;
    record.grant = { ...record.grant, level, testing: level === 'testing', grantedAt: record.grant?.grantedAt ?? iso(now()), loweredAt: iso(now()) };
    if (record.lease?.leaseId) hub.setLeaseLevel?.(record.lease.leaseId, level);
    record.runtime?.lowerGrant?.(level);
    log('lease_lowered', { requestId: record.requestId, from: current, level, source });
    changed();
    return null;
  }

  function onLeaseLevelEvent(event) {
    const record = findByLease(event.leaseId);
    if (!record) return replyTo(event, { error: { code: 'no_request', message: 'No such tab lease' } });
    const refused = lowerGrant(record, event.level, 'extension');
    if (refused) return replyTo(event, refused);
    return replyTo(event, { leaseId: record.lease.leaseId, requestId: record.requestId, grant: { ...record.grant } });
  }

  function onDenyEvent(event) {
    const record = requests.get(event.requestId);
    if (!record) return replyTo(event, { error: { code: 'no_request', message: 'No such tab request' } });
    // The popup uses its deny control as "Release" for a paused request.
    if (record.state === 'paused') {
      endRequest(record, 'released', 'released', { interrupt: 'cancelled' });
      return replyTo(event, { requestId: record.requestId, state: 'released' });
    }
    if (record.state !== 'pending') {
      return replyTo(event, { error: { code: 'request_not_pending', message: `This request is ${record.state}` } });
    }
    setState(record, 'denied', 'denied');
    replyTo(event, { requestId: record.requestId, state: 'denied' });
  }

  function onStatusEvent(event) {
    const record = findByLease(event.leaseId);
    if (!record) return;
    if (event.status === 'stopped') {
      endRequest(record, 'released', 'stopped', { interrupt: 'stopped', notifyHub: false });
      return;
    }
    if (event.status === 'paused' && record.state === 'active') {
      const reason = PAUSE_REASONS.has(event.reason) ? event.reason : 'paused';
      interruptActive(record, reason);
      setState(record, 'paused', reason);
    }
  }

  /**
   * The per-request call budget in effect, the ceiling the MCP server enforces: the user's popup setting, else
   * config.json `budget` (validated by loadConfig), else DEFAULT_BUDGET; `source` names which.
   */
  function effectiveBudget() {
    if (userBudget) return { ...userBudget, source: 'extension' };
    const configured = config.budget && typeof config.budget === 'object' ? config.budget : null;
    if (configured && Object.keys(configured).length) return { ...DEFAULT_BUDGET, ...configured, source: 'config' };
    return { ...DEFAULT_BUDGET, source: 'default' };
  }

  /** The extension's popup settings (hello or a settings message): the budget, when valid and complete, else none. */
  function applySettings(settings) {
    let next = null;
    try {
      const clean = checkBudget(settings?.budget ?? null);
      if (clean.maxCalls !== undefined && clean.maxMs !== undefined) next = clean;
    } catch {
      next = null;
    }
    const changedBudget = JSON.stringify(next) !== JSON.stringify(userBudget);
    userBudget = next;
    if (changedBudget) log('budget_setting', { budget: userBudget });
    if (typeof settings?.openRightAway === 'boolean') openRightAway = settings.openRightAway;
    const asks = settings?.approvals;
    if (asks && typeof asks === 'object') {
      approvalAsks = { purchase: asks.purchase !== false, secret: asks.secret !== false, level: asks.level !== false };
    }
  }

  // How the user approves a pending request, for the agent's wording (result.js approvalSteps): `page` when the
  // extension opens the request's page by itself (connected, the setting on, a page to open, Interactive or less,
  // and no live session on a tab that already covers it), where the icon click on that page approves; else `window`.
  function approvalOf(record) {
    const extension = hub.extension();
    if (!extension.connected || openRightAway !== true) return 'window';
    const hasPage = Boolean(record.url) || record.origins.some(entry => !isSiteEntry(entry));
    if (!hasPage || levelRank(record.mode) > levelRank('interactive')) return 'window';
    const live = extension.session;
    if (live && ['active', 'paused'].includes(live.status) && live.origin && originCovered(live.origin, record.origins)) {
      return 'window';
    }
    return 'page';
  }

  function onSettingsEvent(event) {
    applySettings(event.settings);
    replyTo(event, { budget: effectiveBudget() });
  }

  function driverView() {
    return { driver: config.driver, jevAvailable: config.provider === 'local' || Boolean(env.TYPESAFE_API_KEY) };
  }

  function onDriverEvent(event) {
    // Serialize clicks from multiple popup windows. Only the authenticated extension channel exposes this command.
    driverChanges = driverChanges.then(async () => {
      if (event.driver !== undefined) {
        if (!['agent', 'jev'].includes(event.driver)) {
          return replyTo(event, { error: { code: 'invalid_driver', message: 'Choose your agent or Jev autopilot.' } });
        }
        if (event.driver === 'jev' && !driverView().jevAvailable) {
          return replyTo(event, { error: { code: 'key_missing', message: 'Jev needs an API key. Add it during setup first.' } });
        }
        if (event.driver !== config.driver) {
          const previous = config.driver;
          saveDriver(event.driver, paths);
          config = loadConfig(paths, { defaultDriver });
          // The reply goes out as soon as the choice is saved; applyDriver never waits on a run.
          applyDriver(previous);
          log('driver_changed', { driver: config.driver });
        }
      }
      replyTo(event, { control: driverView() });
    }).catch(() => replyTo(event, { error: { code: 'driver_save_failed',
      message: 'Could not save browser control. Reconnect and try again.' } }));
    return driverChanges;
  }

  // The popup's update card (extension channel only, authenticated by the pairing secret): `status`, `check` (the
  // user asked; a result younger than a minute is reused) or `install` (the user's Update click). Install starts
  // `fai-browser update --tag <tag>` (src/update-cli.js) detached, since it restarts this daemon; the tag is the
  // validated cached release. There is no client-API route for it, so an agent's MCP call cannot start an update.
  function onUpdateEvent(event) {
    const action = event.action ?? 'status';
    if (action === 'status') return replyTo(event, { update: updates.view() });
    if (action === 'check') return updates.check({ force: true }).then(() => replyTo(event, { update: updates.view() }));
    if (action !== 'install') return replyTo(event, { error: { code: 'invalid_action', message: 'Unknown update action.' } });
    const view = updates.view();
    const refuse = (code, message) => replyTo(event, { error: { code, message } });
    if (!view.available || !view.tag) return refuse('no_update', 'FAI Browser is up to date.');
    if (!view.installable) return refuse('not_git', 'This FAI Browser is not a git clone; update it the way you installed it.');
    if (runningUpdate(paths)) return refuse('update_running', 'An update is already running.');
    if ([...requests.values()].some(record => LEASED.has(record.state))) {
      return refuse('lease_active', 'An agent holds a browser tab. Let the task finish or press Stop, then update.');
    }
    const childEnv = { ...launchEnv, FAI_DAEMON_PORT: String(port), ...(paths.custom ? { FAI_HOME: paths.home } : {}) };
    const args = [join(PACKAGE_ROOT, 'src', 'cli.js'), 'update', '--tag', view.tag];
    // A test never runs the real updater against the checkout it runs from.
    if (!options.spawnUpdater && underTest(env)) return refuse('update_failed', 'No updates under node --test.');
    let pid;
    try {
      pid = (options.spawnUpdater ?? defaultSpawnUpdater)(args, childEnv);
    } catch (error) {
      log('update_spawn_error', { message: String(error?.message ?? error).slice(0, 200) });
      return refuse('update_failed', 'Could not start the update. Run node src/cli.js update in the fai-browser folder.');
    }
    // The lock (created exclusively) and the running record are written now, for the updater's pid: a second click, a
    // new tab request or an approval sees the update at once (the updater adopts the lock; its records replace this
    // one). A lock another live updater took in the meantime (a CLI `update`) stops the child just started.
    if (Number.isInteger(pid) && pid > 0) {
      let claimed;
      try {
        claimed = claimUpdateLock(paths, pid);
      } catch (error) {
        log('update_record_error', { message: String(error?.message ?? error).slice(0, 200) });
        claimed = true; // The updater takes the lock itself and refuses on its own when it cannot.
      }
      if (!claimed) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          // Already gone.
        }
        return refuse('update_running', 'An update is already running.');
      }
      try {
        writeInstallState(paths, { pid, state: 'running', from: view.current, to: view.latest, step: 'start',
          message: `Installing ${view.latest}.` });
      } catch (error) {
        log('update_record_error', { message: String(error?.message ?? error).slice(0, 200) });
      }
    }
    log('update_install_started', { from: view.current, to: view.latest });
    return replyTo(event, { update: { ...view, install: { state: 'running', from: view.current, to: view.latest,
      at: iso(now()), step: 'start', error: null, message: `Installing ${view.latest}.` } } });
  }

  function onHelloEvent(event) {
    if (event.settings !== undefined) applySettings(event.settings);
    const reply = endSession => replyTo(event, {
      mode: 'daemon',
      daemonVersion: version,
      endSession,
      requests: liveViews(),
      budget: effectiveBudget(),
      control: driverView(),
      update: updates.view(),
    });
    const session = event.session;
    if (!session) {
      // The worker restarted and lost its session: any active lease can no longer be served.
      for (const record of requests.values()) {
        if (record.state === 'active') {
          interruptActive(record, 'session_inactive');
          setState(record, 'paused', 'session_inactive');
        }
      }
      return reply(false);
    }
    const record = findByLease(session.leaseId);
    if (!record) return reply(true);
    // The worker may have lowered its level while the lease_level message could not reach us (disconnected): its
    // hello carries the level it holds now. Only a lower level is taken from it.
    if (session.level && record.grant && levelRank(session.level) < levelRank(record.grant.level)) {
      lowerGrant(record, session.level, 'hello');
    }
    const blip = record.state === 'paused' && record.stateReason === 'disconnected' && session.status === 'active';
    if (blip) {
      // Socket blip: the same lease continues.
      hub.bindLease({
        leaseId: record.lease.leaseId,
        requestId: record.requestId,
        tabId: record.lease.tabId,
        origin: record.lease.origin,
        allowedOrigins: coveredOrigins(record),
        // The grant stays the hub's ceiling for the resumed lease.
        level: record.grant?.level ?? 'read-only',
      });
      record.lastCallAt = now();
      setState(record, 'active', null);
    }
    return reply(false);
  }

  function onDisconnected() {
    for (const record of requests.values()) {
      if (record.state === 'active') {
        interruptActive(record, 'disconnected');
        setState(record, 'paused', 'disconnected');
      }
    }
  }

  function onHubEvent(event) {
    try {
      log('hub_event', { type: event?.type });
      switch (event?.type) {
        case 'lease':
          return onLeaseEvent(event);
        case 'lease_level':
          return onLeaseLevelEvent(event);
        case 'deny':
          return onDenyEvent(event);
        case 'status':
          return onStatusEvent(event);
        case 'hello':
          return onHelloEvent(event);
        case 'settings':
          return onSettingsEvent(event);
        case 'driver':
          return onDriverEvent(event);
        case 'update':
          return onUpdateEvent(event);
        case 'disconnected':
          return onDisconnected();
        case 'connected':
          return changed();
        default:
          return undefined;
      }
    } catch (error) {
      log('hub_event_error', { type: event?.type, message: String(error?.message ?? error) });
      replyTo(event, { error: { code: 'internal', message: 'Daemon error' } });
      return undefined;
    }
  }

  // --- settings, config, providers --------------------------------------------------------------------------

  function leaseIdleMs() {
    return config.leaseIdleMs ?? DEFAULT_LEASE_IDLE_MS;
  }

  function idleShutdownMs() {
    const fromEnv = Number(env.FAI_DAEMON_IDLE_MS);
    if (env.FAI_DAEMON_IDLE_MS && Number.isInteger(fromEnv) && fromEnv >= 0) return fromEnv;
    return config.idleShutdownMs ?? 0;
  }

  function outputDir(override) {
    return override ?? config.outputDir ?? paths.artifacts;
  }

  async function reloadSettings() {
    const next = await loadDaemonSettings(paths.envFile, { env });
    const secretChanged = Boolean(settings) && next.secret !== settings.secret;
    settings = next;
    if (secretChanged) {
      log('pairing_secret_changed');
      await hub?.setSecret?.(next.secret);
    }
    return { secretChanged };
  }

  async function reload() {
    const { secretChanged } = await reloadSettings();
    const previous = config.driver;
    try {
      config = loadConfig(paths, { defaultDriver });
    } catch (error) {
      throw badOptions(error.message);
    }
    applyDriver(previous);
    log('reloaded', { secretChanged });
    return { ok: true, keyConfigured: settings.keyConfigured, secretChanged };
  }

  /**
   * A switch to Agent direct (from `previous`, only on an actual change): abandon the provider warm-up, interrupt
   * Jev's own runs and steps (a host act keeps going), and drop every retained provider. Synchronous: nothing here
   * waits on an in-flight run, so the toggle and reload reply at once.
   */
  function applyDriver(previous) {
    if (config.driver !== 'agent' || previous === 'agent') return;
    warmAbort.abort();
    warmAbort = new AbortController();
    for (const record of requests.values()) {
      const active = record.activeRunId ? runs.get(record.activeRunId) : null;
      if (active?.state === 'running' && active.operation !== 'act') record.runtime?.interrupt('interrupted');
      if (record.runtime) record.runtime.provider = null;
    }
  }

  async function makeProvider(spec) {
    if (config.driver === 'agent') {
      throw configError('Your agent is driving (Agent direct). Use observe and act; select Jev autopilot in the extension to delegate runs.');
    }
    if (envFileMtime(paths.envFile) !== settings.mtimeMs) await reloadSettings();
    const name = spec.provider ?? config.provider ?? 'typesafe';
    const options = { ...(config.providerOptions ?? {}), ...spec.providerOptions };
    const provider = await providerFactory({ name, options, env, config });
    if (config.driver === 'agent') throw configError('Your agent is driving (Agent direct). Use observe and act.');
    return provider;
  }

  /**
   * Prime the default provider's connection (DNS, TCP, TLS; TypeSafeProvider.warm() is an unauthenticated GET) in
   * the background, at daemon start, when the user approves a tab and when a run or act starts (with that run's own
   * provider and providerOptions, in parallel with its first observe): the moments before a first decision. Callers
   * never await it and it never throws. A missing key, a provider without warm() or a network failure only logs a
   * fixed code: no messages, URLs or key material. One warm-up at a time; shutdown abandons it.
   */
  function warmProvider(reason, runProvider = null) {
    if (config.driver === 'agent') return null;
    if (warming || shuttingDown || options.warm === false) return warming;
    const controller = warmAbort;
    warming = (async () => {
      let provider = runProvider;
      try {
        provider ??= await makeProvider({});
      } catch (error) {
        const code = typeof error?.code === 'string' && /^[a-z_]{1,40}$/.test(error.code) ? error.code : 'unavailable';
        log('provider_warm_skipped', { reason, code });
        return;
      }
      if (config.driver === 'agent' || controller.signal.aborted || typeof provider?.warm !== 'function') return;
      const outcome = await provider.warm({ signal: controller.signal });
      if (shuttingDown) return; // the log may already be closed
      log('provider_warm', {
        reason,
        ok: outcome?.ok === true,
        status: Number.isInteger(outcome?.status) ? outcome.status : null,
        ms: Number.isFinite(outcome?.ms) ? outcome.ms : null,
      });
    })().catch(() => {
      try {
        if (!shuttingDown) log('provider_warm_skipped', { reason, code: 'failed' });
      } catch {
        // Logging is best effort here.
      }
    }).finally(() => {
      warming = null;
    });
    return warming;
  }

  // --- runs -------------------------------------------------------------------------------------------------

  function runProgress(run) {
    return {
      steps: run.steps,
      maxActions: run.maxActions,
      elapsedMs: now() - run.startedAt,
      lastStep: run.lastStep,
    };
  }

  function runResponse(run) {
    if (run.state === 'done') return { state: 'done', runId: run.runId, requestId: run.requestId, result: run.result };
    return { state: 'running', runId: run.runId, requestId: run.requestId, progress: runProgress(run) };
  }

  function runSummary(run) {
    return {
      runId: run.runId,
      state: run.state,
      operation: run.operation,
      requestId: run.requestId,
      status: run.result?.status ?? null,
      code: run.result?.code ?? null,
      startedAt: iso(run.startedAt),
      finishedAt: iso(run.finishedAt ?? null),
      trace: run.result?.trace ?? null,
    };
  }

  /**
   * config.json `thresholds` under the run's own; undefined when neither sets any. `commitVeto` can only be lowered
   * by a run (stricter), never raised above the configured or default value.
   */
  function runThresholds(spec) {
    const merged = { ...(config.thresholds ?? {}), ...(spec.thresholds ?? {}) };
    if (spec.thresholds?.commitVeto !== undefined) {
      merged.commitVeto = Math.min(spec.thresholds.commitVeto, config.thresholds?.commitVeto ?? DEFAULT_THRESHOLDS.commitVeto);
    }
    return Object.keys(merged).length ? merged : undefined;
  }

  function traceOptions(spec, record) {
    const options = {
      requestId: record.requestId,
      mode: spec.mode,
      level: effectiveLevel(spec.mode, record),
      grant: record.grant?.level ?? null,
      capture: spec.capture,
      timeoutMs: spec.timeoutMs,
      allowedOrigins: coveredOrigins(record),
    };
    if (spec.maxActions !== undefined) options.maxActions = spec.maxActions;
    if (spec.minConfidence) options.minConfidence = spec.minConfidence;
    if (spec.doneThreshold !== undefined) options.doneThreshold = spec.doneThreshold;
    const thresholds = runThresholds(spec);
    if (thresholds) options.thresholds = thresholds;
    if (spec.answerQuestion) options.answerQuestion = spec.answerQuestion;
    // Host- and config-written plain phrases (never page text), for the audit trail.
    if (spec.policy) options.policy = spec.policy;
    if (config.guardrails && (config.guardrails.forbid?.length || config.guardrails.note)) options.guardrails = config.guardrails;
    // The in-call retry switches the run used (resolved: run, then config.json, then on).
    if (spec.actionId === undefined && (spec.instruction !== undefined || spec.steps)) options.retry = resolveRetry(spec.retry ?? config.retry);
    // The slim provider request switches the run used (resolved: run, then config.json, then DEFAULT_SLIM).
    if (spec.actionId === undefined && (spec.instruction !== undefined || spec.steps)) options.slim = resolveSlim(spec.slim ?? config.slim);
    if (spec.steps) options.steps = spec.steps.map(step => ({ ...step, expectation: { ...step.expectation } }));
    // The site-profile switch the run used (run, then config.json, then on).
    if (spec.actionId === undefined && (spec.instruction !== undefined || spec.steps)) {
      const { fastPath, hints } = resolveProfiles(spec.profiles ?? config.profiles);
      options.profiles = { fastPath, hints };
    }
    if (spec.expectation) options.expectation = spec.expectation;
    if (spec.allowedUrls?.length) options.allowedUrls = spec.allowedUrls;
    if (spec.suppliedText && Object.keys(spec.suppliedText).length) options.suppliedText = spec.suppliedText;
    if (spec.provider) options.provider = spec.provider;
    if (spec.providerOptions && Object.keys(spec.providerOptions).length) options.providerOptions = spec.providerOptions;
    if (spec.revision) options.revision = spec.revision;
    const choice = spec.choice ?? {};
    if (choice.actionId) options.actionId = choice.actionId;
    if (choice.point) options.point = { x: choice.point.x, y: choice.point.y };
    // A composed act for the audit trail: what kind, never a typed value or a file's bytes (lengths and names only).
    for (const key of ['key', 'url', 'nav', 'tab', 'dialog', 'hover', 'submit']) if (choice[key] !== undefined) options[key] = choice[key];
    if (typeof choice.text === 'string') options.textChars = choice.text.length;
    if (Array.isArray(choice.fills)) options.fills = choice.fills.map(fill => ({ actionId: fill.actionId, chars: String(fill.text ?? '').length }));
    if (choice.file) options.file = { name: choice.file.name, size: choice.file.size };
    return options;
  }

  async function retain(dir, keepId) {
    const keep = [keepId, ...[...runs.values()].filter(run => run.state === 'running').map(run => run.runId)];
    try {
      const retention = retentionConfig(config.retention, env);
      if (!retention) return;
      const { pruned } = await prune(dir, { ...retention, keep });
      for (const entry of pruned) log('pruned', { runId: entry.runId, bytes: entry.bytes, reason: entry.reason });
    } catch (error) {
      log('retention_error', { message: String(error?.message ?? error) });
    }
  }

  async function finishRun(run, record, raw, spec) {
    applyLeaseMessage(raw);
    raw.lease = { requestId: record.requestId, state: record.state };
    const dir = outputDir(spec.outputDir);
    let result;
    try {
      const written = await writeRun(raw, {
        dir,
        instruction: spec.steps ? listInstruction(spec.steps, spec.summary) : spec.instruction,
        operation: run.operation,
        options: traceOptions(spec, record),
        startedAt: iso(run.startedAt),
        finishedAt: iso(now()),
      });
      result = written.result;
      if (spec.prune) await retain(dir, written.runId);
    } catch (error) {
      log('trace_error', { runId: run.runId, message: String(error?.message ?? error) });
      result = unwrittenResult(raw);
    }
    run.result = result;
    run.state = 'done';
    run.finishedAt = now();
    if (record.activeRunId === run.runId) record.activeRunId = null;
    record.lastCallAt = now();
    log('run_done', { runId: run.runId, requestId: record.requestId, status: result.status, code: result.code,
      ms: run.finishedAt - run.startedAt });
    changed();
  }

  function startRun(record, spec, operation, provider) {
    const runId = randomUUID();
    const run = {
      runId,
      requestId: record.requestId,
      operation,
      state: 'running',
      startedAt: now(),
      finishedAt: null,
      steps: 0,
      maxActions: operation === 'run' ? spec.maxActions ?? listActions(spec.steps) ?? 8 : 1,
      lastStep: null,
      result: null,
      done: null,
    };
    runs.set(runId, run);
    record.activeRunId = runId;
    record.lastRunId = runId;
    const onAction = step => {
      run.steps = Math.max(run.steps, step.i);
      run.lastStep = { i: step.i, action: { type: step.action.type, ref: step.action.ref }, ms: { total: step.ms.total } };
      wake();
    };
    const common = {
      runId,
      capture: spec.capture,
      timeoutMs: spec.timeoutMs,
      expectation: spec.expectation,
      onAction,
    };
    if (spec.answerQuestion) common.answerQuestion = spec.answerQuestion;
    const runtime = record.runtime;
    let promise;
    if (operation === 'act') {
      runtime.provider = provider; // Clear any provider retained from before a switch to Agent direct.
      promise = runtime.act(spec.choice, { ...common, revision: spec.revision, revisionless: spec.revisionless,
        approvalWaitMs: spec.approvalWaitMs, reason: spec.reason });
    } else {
      runtime.provider = provider;
      const runOptions = {
        ...common,
        // The runtime clamps the mode to the grant again; the extension intersects with the user's choice too.
        mode: spec.mode,
        grant: { level: record.grant?.level ?? 'read-only', tabMode: record.grant?.tabMode ?? 'single' },
        allowedOrigins: coveredOrigins(record),
        allowedUrls: spec.allowedUrls,
        suppliedText: spec.suppliedText,
      };
      if (operation === 'run' && spec.maxActions !== undefined) runOptions.maxActions = spec.maxActions;
      if (spec.maxDecisions !== undefined) runOptions.maxDecisions = spec.maxDecisions;
      if (spec.minConfidence) runOptions.minConfidence = spec.minConfidence;
      if (spec.doneThreshold !== undefined) runOptions.doneThreshold = spec.doneThreshold;
      const thresholds = runThresholds(spec);
      if (thresholds) runOptions.thresholds = thresholds;
      if (spec.policy) runOptions.policy = spec.policy;
      if (config.guardrails) runOptions.guardrails = config.guardrails;
      // In-call retries: the run's own switch, else config.json `retry`, else on.
      const retry = spec.retry ?? config.retry;
      if (retry !== undefined) runOptions.retry = retry;
      // Site profiles (experimental, opt-in): the run's switch, else config.json `profiles`, else off.
      runOptions.domains = domains;
      const profiles = spec.profiles ?? config.profiles;
      if (profiles !== undefined) runOptions.profiles = profiles;
      // Slim provider requests: the run's own switches, else config.json `slim`, else DEFAULT_SLIM.
      const slim = spec.slim ?? config.slim;
      if (slim !== undefined) runOptions.slim = slim;
      if (spec.steps) runOptions.steps = spec.steps;
      promise = spec.steps ? runtime.run(runOptions) : runtime[operation](spec.instruction, runOptions);
      // The task this request last ran: a later observe ranks its listing by it when the host names none.
      record.lastTask = {
        instruction: spec.steps ? listInstruction(spec.steps, spec.summary) : spec.instruction,
        expectation: spec.expectation,
        answerQuestion: spec.answerQuestion,
      };
    }
    log('run_start', { runId, requestId: record.requestId, operation });
    run.done = promise
      .catch(error => {
        const result = createResult({ runId, expectation: spec.expectation ?? null, provider: null });
        result.permissions = permissionsOf(spec.mode ?? record.mode, record);
        return setOutcome(result, 'failed', String(error?.message ?? error));
      })
      .then(raw => finishRun(run, record, raw, spec))
      .catch(error => log('run_finish_error', { runId, message: String(error?.message ?? error) }));
    changed();
    return run;
  }

  async function awaitRun(run, waitMs, signal) {
    await waitUntil(() => run.state === 'done', waitMs, signal);
    return runResponse(run);
  }

  function ensureIdle(record) {
    if (record.activeRunId || record.runtime?.active) {
      throw new HttpError(409, 'run_active', 'A run is already active on this tab lease; wait for it or stop it');
    }
  }

  // --- route handlers ---------------------------------------------------------------------------------------

  function health() {
    return { ok: true, service: SERVICE_NAME, version, pid: process.pid };
  }

  function statusView() {
    const all = [...runs.values()];
    return {
      daemon: {
        version,
        pid: process.pid,
        port,
        uptimeMs: now() - startedAt,
        home: paths.home,
        log: log.path ?? null,
      },
      extension: hub.extension(),
      driver: config.driver,
      provider: { default: config.driver === 'agent' ? null : config.provider ?? 'typesafe',
        keyConfigured: Boolean(env.TYPESAFE_API_KEY) },
      // The per-request call budget in effect (the MCP server's ceiling) and where it comes from.
      budget: effectiveBudget(),
      // Newer release (src/update.js): tell the user; only their popup click or `fai-browser update` installs it.
      update: updates.view(),
      requests: liveViews(),
      runs: {
        active: all.filter(run => run.state === 'running').map(runSummary),
        recent: all.filter(run => run.state === 'done').sort((a, b) => b.finishedAt - a.finishedAt).slice(0, 10)
          .map(runSummary),
      },
      warnings: [...warnings],
    };
  }

  function createRequest(body, client) {
    checkKeys(body, REQUEST_KEYS);
    if (runningUpdate(paths)) {
      throw new HttpError(503, 'update_running', 'An FAI Browser update is installing and restarts the service; '
        + 'retry in a minute.', { retryable: true });
    }
    const origins = body.origins;
    if (!Array.isArray(origins) || origins.length < 1 || origins.length > 10) {
      throw badOptions('origins must list 1-10 exact origins such as https://app.example.com or domain roots such as https://*.example.com');
    }
    for (const origin of origins) {
      // An exact origin, or a domain root "https://*.example.com" (src/origins.js); a public suffix is refused.
      const checked = checkOriginEntry(origin);
      if (checked.error) throw badOptions(checked.error);
    }
    // Any level may be asked for (the agent states a need); only the user's approval in the extension grants one.
    const mode = oneOf(body, 'mode', [...LEVELS], 'read-only');
    const reason = body.reason;
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 200) {
      throw badOptions('reason is required: 1-200 characters shown to the user');
    }
    const instruction = optionalString(body, 'instruction', 300) ?? null;
    const url = startUrl(body.url, origins);
    const ttlMs = optionalInt(body, 'ttlMs', 60_000, 3_600_000) ?? config.requestTtlMs ?? DEFAULT_REQUEST_TTL_MS;
    const pending = [...requests.values()].filter(record => record.state === 'pending').length;
    if (pending >= MAX_PENDING_REQUESTS) {
      throw new HttpError(429, 'too_many_requests', 'Too many pending tab requests; cancel one first', { retryable: true });
    }
    const record = {
      requestId: newRequestId(),
      state: 'pending',
      stateReason: null,
      origins: [...new Set(origins)],
      mode,
      grant: null,
      reason,
      instruction,
      url,
      client,
      ttlMs,
      createdAt: now(),
      lastCallAt: now(),
      pausedAt: null,
      endedAt: null,
      lease: null,
      activeRunId: null,
      lastRunId: null,
      runtime: null,
      bridge: null,
    };
    requests.set(record.requestId, record);
    log('request_state', { requestId: record.requestId, state: 'pending' });
    changed();
    return {
      status: 201,
      body: {
        requestId: record.requestId,
        state: 'pending',
        extensionConnected: Boolean(hub.extension().connected),
        expiresAt: iso(expiresAt(record)),
        message: `Ask the user to approve this request in Chrome: ${approvalSteps(approvalOf(record))}.`,
        request: view(record),
      },
    };
  }

  async function deleteRequest(record) {
    if (record.state === 'pending') {
      setState(record, 'cancelled', 'cancelled');
      return { requestId: record.requestId, state: 'cancelled' };
    }
    if (LEASED.has(record.state)) {
      const run = runs.get(record.activeRunId);
      endRequest(record, 'released', 'released', { interrupt: 'cancelled' });
      if (run) await waitUntil(() => run.state === 'done', STOP_WAIT_MS);
      return { requestId: record.requestId, state: 'released' };
    }
    return { requestId: record.requestId, state: record.state };
  }

  async function waitRoute(body, signal) {
    checkKeys(body, WAIT_KEYS);
    const maxMs = clampWait(body.maxMs, DEFAULT_WAIT_MS, maxWaitMs);
    const started = Date.now();
    if (body.runId !== undefined) {
      const run = runs.get(body.runId);
      if (!run) {
        const stored = await storedRun(body.runId);
        if (stored) return stored;
        throw new HttpError(404, 'unknown_run', `No run ${body.runId}`);
      }
      const afterStep = optionalInt(body, 'afterStep', 0, 10_000);
      const record = requests.get(run.requestId);
      if (record) touch(record);
      await waitUntil(() => run.state === 'done' || (afterStep !== undefined && run.steps > afterStep), maxMs, signal);
      return runResponse(run);
    }
    const record = getRecord(body.requestId);
    touch(record);
    let watched = ['pending', 'paused'];
    if (body.while !== undefined) {
      if (!Array.isArray(body.while) || !body.while.every(state => REQUEST_STATES.has(state))) {
        throw badOptions(`while must be an array of request states: ${[...REQUEST_STATES].join(', ')}`);
      }
      watched = body.while;
    }
    await waitUntil(() => !watched.includes(record.state), maxMs, signal);
    touch(record);
    // `budget`: the call budget in effect for this request (the MCP server reads its ceiling from here).
    return { state: record.state, request: view(record), waitedMs: Date.now() - started, budget: effectiveBudget() };
  }

  function runSpec(body, record, operation) {
    checkKeys(body, RUN_KEYS);
    const steps = checkSteps(body, operation);
    const instruction = body.instruction;
    if (!steps && (typeof instruction !== 'string' || !instruction.trim() || instruction.length > 4000)) {
      throw badOptions('instruction (at most 4000 characters) or steps is required');
    }
    const provider = body.provider;
    if (provider !== undefined && provider !== 'typesafe' && provider !== 'local') {
      throw badOptions('provider must be typesafe or local');
    }
    return {
      instruction: steps ? undefined : instruction,
      steps,
      // With steps, the host's overall instruction: the trace's instruction leads with it (listInstruction).
      summary: steps ? checkSummary(instruction) : undefined,
      // One run: at most 100 actions; a step list's total budget: at most 120 (each step keeps its own maxActions).
      maxActions: operation === 'run' ? optionalInt(body, 'maxActions', 1, steps ? LIST_MAX_ACTIONS : 100) : undefined,
      maxDecisions: optionalInt(body, 'maxDecisions', 1, 200),
      // Undefined lets the runtime pick 30 s, or 45 s for instructions that name four or more pages.
      timeoutMs: optionalInt(body, 'timeoutMs', 1000, 300_000),
      capture: oneOf(body, 'capture', ['each', 'last', 'none'], 'last'),
      mode: checkMode(body, record),
      expectation: checkExpectation(body),
      minConfidence: checkMinConfidence(body),
      doneThreshold: checkDoneThreshold(body),
      thresholds: checkThresholds(body),
      answerQuestion: checkAnswerQuestion(body),
      policy: checkPolicy(body),
      retry: checkRetry(body),
      profiles: checkProfiles(body),
      slim: checkSlim(body),
      allowedUrls: checkAllowedUrls(body, record),
      suppliedText: checkSuppliedText(body),
      provider,
      providerOptions: checkProviderOptions(body),
      prune: checkPrune(body),
      outputDir: checkOutputDir(body),
      waitMs: clampWait(body.waitMs, DEFAULT_RUN_WAIT_MS, maxWaitMs),
    };
  }

  async function runsRoute(body, signal) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'bad_request', 'Body must be a JSON object');
    const record = getRecord(body.requestId);
    touch(record);
    const operation = body.operation ?? 'run';
    if (operation !== 'run' && operation !== 'step') throw badOptions('operation must be run or step');
    const spec = runSpec(body, record, operation);
    if (config.driver === 'agent') {
      throw new HttpError(409, 'agent_direct',
        'Runs and steps use the experimental Jev driver, and your agent is driving (Agent direct). Use request-tab, '
        + 'observe and act (MCP: fai_browser_open and fai_browser_act); select Jev autopilot in the extension to delegate runs.');
    }
    if (record.state !== 'active') {
      return { state: 'done', runId: null, requestId: record.requestId, result: blockedResult(record, spec.expectation, spec.mode) };
    }
    ensureIdle(record);
    let provider;
    try {
      provider = await makeProvider(spec);
    } catch (error) {
      const result = outcomeResult('config', {
        detail: String(error?.message ?? error),
        expectation: spec.expectation ?? null,
        lease: { requestId: record.requestId, state: record.state },
        permissions: permissionsOf(spec.mode, record),
      });
      return { state: 'done', runId: null, requestId: record.requestId, result };
    }
    if (record.state !== 'active') {
      return { state: 'done', runId: null, requestId: record.requestId, result: blockedResult(record, spec.expectation, spec.mode) };
    }
    ensureIdle(record);
    warmProvider('run', provider);
    const run = startRun(record, spec, operation, provider);
    return awaitRun(run, spec.waitMs, signal);
  }

  async function actRoute(body, signal) {
    checkKeys(body, ACT_KEYS);
    const record = getRecord(body.requestId);
    touch(record);
    // An offered action (actionId), a point (pixels of the screenshot of `revision`, a guarded click on whatever
    // control is there), or a host-composed act (checkActChoice, against the offer below).
    const point = checkPoint(body);
    if (body.actionId !== undefined && (typeof body.actionId !== 'string' || !body.actionId)) throw badOptions('actionId must be a string');
    if (point !== null && body.actionId !== undefined) throw badOptions('actionId and point are exclusive: send one');
    if (point !== null && typeof body.revision !== 'string') throw badOptions('revision is required with point');
    if (body.revision !== undefined && typeof body.revision !== 'string') throw badOptions('revision must be a string');
    if (body.submit !== undefined && typeof body.submit !== 'boolean') throw badOptions('submit must be a boolean');
    if (body.hover !== undefined && typeof body.hover !== 'boolean') throw badOptions('hover must be a boolean');
    const choice = {};
    for (const key of CHOICE_KEYS) if (body[key] !== undefined && body[key] !== null && body[key] !== false) choice[key] = body[key];
    if (point !== null) choice.point = point;
    // An upload: the file the MCP server checked lies in the host's workspace, read here (its bytes go to the
    // extension only; results and traces keep its name and size).
    if (choice.file !== undefined) choice.file = await readUpload(choice.file);
    const spec = {
      choice,
      revision: body.revision,
      expectation: checkExpectation(body),
      answerQuestion: checkAnswerQuestion(body),
      capture: oneOf(body, 'capture', ['each', 'last', 'none'], 'last'),
      timeoutMs: optionalInt(body, 'timeoutMs', 1000, 300_000) ?? 15_000,
      prune: checkPrune(body),
      outputDir: checkOutputDir(body),
      waitMs: clampWait(body.waitMs, DEFAULT_RUN_WAIT_MS, maxWaitMs),
      mode: record.mode,
      // The Approve gate: how long the act waits for the user's Approve click (0 to 120 s, default 60 s), and the one
      // line the approval window shows as "Agent says" (untrusted).
      approvalWaitMs: optionalInt(body, 'approvalWaitMs', 0, 120_000) ?? 60_000,
      reason: typeof body.reason === 'string' && body.reason.trim() ? body.reason.replace(/\s+/g, ' ').trim().slice(0, 200) : undefined,
    };
    if (record.state !== 'active') {
      return { state: 'done', runId: null, requestId: record.requestId, result: blockedResult(record, spec.expectation) };
    }
    ensureIdle(record);
    const runtime = record.runtime;
    const offer = spec.revision !== undefined ? runtime.offers.get(spec.revision) : runtime.lastOffer;
    if (!offer) {
      // Each act spends its revision; the act's result (or an observe) carries the next one.
      const current = runtime.lastOffer?.revision;
      throw badOptions(`Unknown revision${spec.revision !== undefined ? ` "${String(spec.revision).slice(0, 40)}"` : ''}: `
        + 'revisions are single-use (each act spends its own) and a lowered level drops them. '
        + (current ? `The current revision is "${current}" (from the last act or observe).` : 'Call observe for a fresh one.'));
    }
    spec.revisionless = spec.revision === undefined;
    const problem = checkActChoice(offer, choice, { revisionless: spec.revisionless });
    if (problem) throw badOptions(problem);
    spec.revision = offer.revision;
    spec.mode = offer.config.mode;
    // The provider answers the purchase guard for the chosen control (runtime act(), below testing). Without one
    // (no key configured) the act keeps the mechanical checks only.
    let provider = null;
    try {
      if (config.driver !== 'agent') provider = await makeProvider({});
    } catch (error) {
      log('act_provider_unavailable', { message: String(error?.message ?? error) });
    }
    if (record.state !== 'active') {
      return { state: 'done', runId: null, requestId: record.requestId, result: blockedResult(record, spec.expectation) };
    }
    ensureIdle(record);
    if (provider) warmProvider('act', provider);
    const run = startRun(record, spec, 'act', provider);
    return awaitRun(run, spec.waitMs, signal);
  }

  // A point click's point: { x, y } finite, non-negative numbers (pixels of the observe screenshot), or null when
  // absent. Anything else is a bad option.
  function checkPoint(body) {
    if (body.point === undefined || body.point === null) return null;
    const point = body.point;
    if (!point || typeof point !== 'object' || Array.isArray(point)) throw badOptions('point must be {x, y}');
    const keys = Object.keys(point).filter(key => key !== 'x' && key !== 'y');
    if (keys.length) throw badOptions(`Unknown point key: ${keys[0]}`);
    const x = point.x;
    const y = point.y;
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 100_000 || y > 100_000) {
      throw badOptions('point.x and point.y must be non-negative numbers (screenshot pixels)');
    }
    return { x, y };
  }

  async function writeObserveArtifact({ observeId, record, observed, shot, spec, startedAt: observeStart }) {
    const dir = outputDir(spec.outputDir);
    const runDir = join(dir, observeId);
    await mkdir(runDir, { recursive: true, mode: 0o700 });
    let screenshot = null;
    const match = /^data:image\/(png|jpeg);base64,(.*)$/s.exec(shot?.dataUrl ?? '');
    if (match) {
      const format = match[1] === 'png' ? 'png' : 'jpeg';
      const bytes = Buffer.from(match[2], 'base64');
      const path = join(runDir, `observe.${format === 'png' ? 'png' : 'jpg'}`);
      await writeFile(path, bytes, { mode: 0o600 });
      // The size read from the bytes, else the one the extension reported for the frame it encoded.
      const reported = shot.width > 0 && shot.height > 0 ? { width: shot.width, height: shot.height } : {};
      screenshot = { path, revision: shot.revision, format, ...reported, ...imageSize(bytes), ...(Array.isArray(shot.tags) ? { tags: shot.tags } : {}),
        ...redactionMeta(shot) };
    }
    const tracePath = join(runDir, 'trace.json');
    const trace = {
      v: 1,
      runId: observeId,
      observeId,
      operation: 'observe',
      status: 'observed',
      code: 'observed',
      revision: observed.observation.revision,
      page: observed.observation,
      actions: observed.actions,
      offer: observed.offer,
      screenshot,
      trace: tracePath,
      options: {
        requestId: record.requestId,
        mode: spec.mode,
        level: effectiveLevel(spec.mode, record),
        allowedUrls: spec.allowedUrls,
        suppliedText: Object.fromEntries(Object.keys(spec.suppliedText).map(name => [name, '[redacted]'])),
      },
      startedAt: iso(observeStart),
      finishedAt: iso(now()),
      host: hostInfo(),
    };
    await writeFile(tracePath, JSON.stringify(scrubSecrets(trace), null, 2), { mode: 0o600 });
    if (spec.prune) await retain(dir, observeId);
    return { screenshot, tracePath };
  }

  function checkLogsFlag(body) {
    if (body.logs !== undefined && typeof body.logs !== 'boolean') throw badOptions('logs must be a boolean');
    return body.logs === true;
  }

  // An act's upload file: { path (absolute, already resolved through symlinks), name, size, type? } from the MCP
  // server, which confined it to the host's workspace. Read again here: still that real path, a regular file of the
  // same size, at most MAX_UPLOAD_BYTES. Returns { name, size, type, data (base64) }.
  async function readUpload(file) {
    if (!file || typeof file !== 'object' || typeof file.path !== 'string' || !isAbsolute(file.path)
      || typeof file.name !== 'string' || !file.name || file.name.length > 255 || /[\\/\u0000-\u001f]/.test(file.name)
      || !Number.isInteger(file.size) || file.size < 0 || file.size > MAX_UPLOAD_BYTES
      || (file.type !== undefined && (typeof file.type !== 'string' || file.type.length > 100))) {
      throw badOptions(`file must be { path, name, size } of a file of at most ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`);
    }
    let real;
    let info;
    try {
      real = await realpath(file.path);
      info = await stat(real);
    } catch {
      throw badOptions('The file to upload cannot be read');
    }
    if (real !== file.path || !info.isFile() || info.size !== file.size) throw badOptions('The file to upload changed; act again');
    const bytes = await readFile(real);
    if (bytes.length !== file.size) throw badOptions('The file to upload changed; act again');
    return { name: file.name, size: file.size, type: file.type ?? '', data: bytes.toString('base64') };
  }

  // observe's waitFor: one to three of textIncludes, textAbsent and urlIncludes (non-empty strings), or undefined.
  function checkWaitFor(body) {
    const value = body.waitFor;
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length) throw badOptions('waitFor must be an object');
    for (const [key, item] of Object.entries(value)) {
      if (!WAIT_FOR_FIELDS.has(key)) throw badOptions(`waitFor takes textIncludes, textAbsent or urlIncludes, not ${key.slice(0, 40)}`);
      if (typeof item !== 'string' || !item || item.length > 500) throw badOptions(`waitFor.${key} must be a non-empty string`);
    }
    return { ...value };
  }

  /**
   * The host's standing terms for a request (host-driven control): every observe adds to them and none removes
   * anything. Forbidden labels are unioned (only additions), supplied values and allowed URLs are added to (a later
   * value for the same name replaces the earlier one). So an observe that omits the opening call's policy, values
   * or URLs keeps them; the act on its offer inherits the same terms.
   */
  function standingTerms(record, spec) {
    const held = record.hostTerms ?? { forbid: [], note: undefined, suppliedText: {}, allowedUrls: [] };
    const forbid = [...held.forbid];
    for (const label of spec.policy?.forbid ?? []) if (!forbid.includes(label)) forbid.push(label);
    const terms = {
      forbid,
      note: held.note ?? spec.policy?.note,
      suppliedText: { ...held.suppliedText, ...spec.suppliedText },
      allowedUrls: [...new Set([...held.allowedUrls, ...spec.allowedUrls])].slice(0, 10),
    };
    record.hostTerms = terms;
    return terms;
  }

  async function observeRoute(body) {
    checkKeys(body, OBSERVE_KEYS);
    const record = getRecord(body.requestId);
    touch(record);
    const spec = {
      mode: checkMode(body, record),
      allowedUrls: checkAllowedUrls(body, record),
      suppliedText: checkSuppliedText(body),
      policy: checkPolicy(body),
      prune: checkPrune(body),
      outputDir: checkOutputDir(body),
      // Relevance hints for the listing cap and the digest only (never sent to a provider): the body's, else the
      // request's last named task (an earlier observe's or run's), else the request's own instruction.
      instruction: optionalString(body, 'instruction', 4000),
      expectation: checkExpectation(body),
      answerQuestion: checkAnswerQuestion(body),
      // More of the page: a text query the digest is ranked by for this observe only, and a larger digest budget.
      focus: optionalString(body, 'focus', 300),
      digestChars: optionalInt(body, 'digestChars', 500, OBSERVE_DIGEST_MAX_CHARS),
      waitFor: checkWaitFor(body),
      maxMs: optionalInt(body, 'maxMs', 0, OBSERVE_WAIT_MAX_MS),
      logs: checkLogsFlag(body),
    };
    const named = spec.instruction !== undefined || spec.expectation !== undefined || spec.answerQuestion !== undefined;
    const task = named ? spec : record.lastTask ?? { instruction: record.instruction ?? undefined };
    if (named) {
      record.lastTask = { instruction: spec.instruction, expectation: spec.expectation, answerQuestion: spec.answerQuestion };
    }
    // The screenshot is taken (and written to disk) only when the host asks for an image.
    if (body.capture !== undefined && typeof body.capture !== 'boolean') throw badOptions('capture must be a boolean');
    const capture = body.capture ?? false;
    if (record.state !== 'active') return { state: 'done', requestId: record.requestId, result: blockedResult(record, undefined, spec.mode) };
    ensureIdle(record);
    const observeStart = now();
    const terms = standingTerms(record, spec);
    spec.allowedUrls = terms.allowedUrls;
    spec.suppliedText = terms.suppliedText;
    let observed;
    let waited = null;
    try {
      const look = () => record.runtime.observe({
        mode: spec.mode,
        grant: { level: record.grant?.level ?? 'read-only', tabMode: record.grant?.tabMode ?? 'single' },
        allowedOrigins: coveredOrigins(record),
        allowedUrls: terms.allowedUrls,
        suppliedText: terms.suppliedText,
        policy: terms.forbid.length || terms.note ? withoutUndefinedFields({ forbid: terms.forbid, note: terms.note }) : undefined,
        ...(spec.focus ? { focus: spec.focus } : {}),
        ...(spec.digestChars ? { digestChars: spec.digestChars } : {}),
        ...(spec.logs ? { logs: true } : {}),
        ...(task.instruction ? { instruction: task.instruction } : {}),
        ...(task.expectation && typeof task.expectation === 'object' ? { expectation: task.expectation } : {}),
        ...(task.answerQuestion ? { answerQuestion: task.answerQuestion } : {}),
        timeoutMs: OBSERVE_TIMEOUT_MS,
        ...(config.guardrails ? { guardrails: config.guardrails } : {}),
      });
      observed = await look();
      // waitFor: look again until the page (as the host is shown it: redacted) meets the condition, or maxMs passed.
      if (spec.waitFor) {
        const until = observeStart + (spec.maxMs ?? OBSERVE_WAIT_DEFAULT_MS);
        let passed = checkDeclarative(observed.observation, spec.waitFor);
        while (!passed && now() < until && record.state === 'active') {
          await delay(Math.min(OBSERVE_WAIT_POLL_MS, Math.max(0, until - now())));
          const earlier = observed.observation.logs;
          observed = await look();
          // Each look drains the page's logs: keep the earlier looks' entries.
          if (Array.isArray(earlier) && earlier.length) observed.observation.logs = [...earlier, ...(observed.observation.logs ?? [])].slice(-50);
          passed = checkDeclarative(observed.observation, spec.waitFor);
        }
        waited = { passed, ms: Math.max(0, now() - observeStart) };
      }
    } catch (error) {
      if (/already active/.test(String(error?.message))) throw new HttpError(409, 'run_active', 'A run is active on this lease');
      if (error instanceof TypeError || error instanceof RangeError) throw badOptions(error.message);
      const code = error?.name === 'TimeoutError' ? 'timeout' : isKnownCode(error?.code) ? error.code : 'failed';
      const result = outcomeResult(code, {
        detail: code === 'failed' || code === 'timeout' ? String(error?.message ?? error) : undefined,
        lease: { requestId: record.requestId, state: record.state },
        permissions: permissionsOf(spec.mode, record),
      });
      return { state: 'done', requestId: record.requestId, result };
    }
    let shot = null;
    if (capture && typeof record.bridge?.capture === 'function') {
      try {
        // The badges read the offered action ids (control ref -> ids), drawn only when the frame still shows this
        // revision; the extension reports the revision it captured either way.
        const details = {
          action: null, target: null, fromUrl: observed.observation.url,
          labels: actionLabels(observed.actions), revision: observed.observation.revision,
        };
        shot = await record.bridge.capture(details, AbortSignal.timeout(OBSERVE_CAPTURE_MS));
        // The image a point click's coordinates refer to (its size maps image pixels back to the page).
        if (shot?.revision === observed.observation.revision) record.runtime.noteImage(shot.revision, shot);
      } catch (error) {
        log('observe_capture_error', { requestId: record.requestId, code: error?.code ?? 'capture_failed' });
      }
    }
    const observeId = randomUUID();
    let written = { screenshot: null, tracePath: null };
    try {
      written = await writeObserveArtifact({ observeId, record, observed, shot, spec, startedAt: observeStart });
    } catch (error) {
      log('trace_error', { runId: observeId, message: String(error?.message ?? error) });
    }
    record.lastCallAt = now();
    return {
      state: 'ok',
      observeId,
      requestId: record.requestId,
      revision: observed.observation.revision,
      page: observed.observation,
      actions: observed.actions,
      offer: observed.offer,
      digest: observed.digest,
      digestTruncated: observed.digestTruncated === true,
      permissions: permissionsOf(spec.mode, record),
      ...(waited ? { waited } : {}),
      screenshot: written.screenshot?.path ?? null,
      // The screenshot's revision and size (what a point click's coordinates are in) and whether its badges are the
      // offered action ids (`tags: "actionIds"`) or, on a frame of another revision, the control refs.
      image: written.screenshot ? {
        revision: written.screenshot.revision,
        width: written.screenshot.width ?? null,
        height: written.screenshot.height ?? null,
        tags: written.screenshot.revision === observed.observation.revision && written.screenshot.tags ? 'actionIds' : 'refs',
        ...redactionMeta(written.screenshot),
      } : null,
      trace: written.tracePath,
    };
  }

  // Runs no longer in memory are read from the default artifacts directory.
  async function readStoredTrace(runId) {
    if (typeof runId !== 'string' || !RUN_ID.test(runId)) return null;
    const runDir = join(outputDir(), runId);
    try {
      const trace = JSON.parse(await readFile(join(runDir, 'trace.json'), 'utf8'));
      return { trace, runDir, path: join(runDir, 'trace.json') };
    } catch {
      return null;
    }
  }

  async function storedRun(runId) {
    const stored = await readStoredTrace(runId);
    if (!stored) return null;
    return {
      state: 'done',
      runId,
      requestId: stored.trace.options?.requestId ?? null,
      result: stored.trace.operation === 'observe' ? stored.trace : toAgentResult(stored.trace),
    };
  }

  async function listRuns(url) {
    const limitText = url.searchParams.get('limit');
    const limit = limitText === null ? 20 : Number(limitText);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw badOptions('limit must be an integer 1-200');
    const requestId = url.searchParams.get('requestId');
    const byId = new Map();
    for (const run of runs.values()) byId.set(run.runId, runSummary(run));
    const dir = outputDir();
    let entries = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || byId.has(entry.name)) continue;
      const stored = await readStoredTrace(entry.name);
      if (!stored) continue;
      const { trace } = stored;
      byId.set(entry.name, {
        runId: entry.name,
        state: 'done',
        operation: trace.operation ?? null,
        requestId: trace.options?.requestId ?? null,
        status: trace.status ?? null,
        code: trace.code ?? null,
        startedAt: trace.startedAt ?? null,
        finishedAt: trace.finishedAt ?? null,
        trace: stored.path,
      });
    }
    const list = [...byId.values()]
      .filter(run => !requestId || run.requestId === requestId)
      .sort((a, b) => String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')))
      .slice(0, limit);
    return { runs: list };
  }

  async function evidenceRoute(runId, url) {
    const kind = url.searchParams.get('kind') ?? 'screenshot';
    if (kind !== 'screenshot' && kind !== 'trace') throw badOptions('kind must be screenshot or trace');
    const stepText = url.searchParams.get('step');
    const step = stepText === null ? undefined : Number(stepText);
    if (step !== undefined && (!Number.isInteger(step) || step < 1)) throw badOptions('step must be a positive integer');
    const inline = url.searchParams.get('inline') === '1';

    let tracePath = null;
    const run = runs.get(runId);
    if (run) {
      if (run.state !== 'done') throw new HttpError(404, 'no_evidence', 'The run is still running; wait for it first');
      tracePath = run.result?.trace ?? null;
      if (!tracePath) throw new HttpError(404, 'no_evidence', 'This run has no trace on disk');
    } else {
      const stored = await readStoredTrace(runId);
      if (!stored) throw new HttpError(404, 'unknown_run', `No run ${runId}`);
      tracePath = stored.path;
    }
    let trace;
    try {
      trace = JSON.parse(await readFile(tracePath, 'utf8'));
    } catch {
      throw new HttpError(404, 'no_evidence', 'The trace is no longer on disk (retention may have pruned it)');
    }
    if (kind === 'trace') return { runId, path: tracePath, trace };

    const shots = trace.operation === 'observe'
      ? (trace.screenshot ? [{ i: null, shot: trace.screenshot }] : [])
      : (trace.steps ?? []).filter(entry => entry.screenshot?.path).map(entry => ({ i: entry.i, shot: entry.screenshot }));
    const chosen = step === undefined ? shots.at(-1) : shots.find(entry => entry.i === step);
    if (!chosen) throw new HttpError(404, 'no_evidence', step === undefined ? 'No step has a screenshot' : `Step ${step} has no screenshot`);
    const runDir = await realpath(dirname(tracePath));
    let imagePath;
    try {
      imagePath = await realpath(chosen.shot.path);
    } catch {
      throw new HttpError(404, 'no_evidence', 'The screenshot file is missing');
    }
    if (dirname(imagePath) !== runDir) throw new HttpError(404, 'no_evidence', 'The screenshot is outside the run directory');
    const info = await stat(imagePath);
    const response = {
      runId,
      step: chosen.i,
      path: imagePath,
      mimeType: chosen.shot.format === 'png' ? 'image/png' : 'image/jpeg',
      width: chosen.shot.width ?? null,
      height: chosen.shot.height ?? null,
      bytes: info.size,
      // The revision the frame shows and what its badges are: offered action ids (`actionIds`, usable as
      // fai_browser_act ids with that revision) or control refs.
      revision: chosen.shot.revision ?? null,
      tags: Array.isArray(chosen.shot.tags) ? 'actionIds' : 'refs',
      ...redactionMeta(chosen.shot),
    };
    if (inline) response.data = (await readFile(imagePath)).toString('base64');
    return response;
  }

  async function stopRun(runId) {
    const run = runs.get(runId);
    if (!run) {
      const stored = await storedRun(runId);
      if (stored) return stored;
      throw new HttpError(404, 'unknown_run', `No run ${runId}`);
    }
    if (run.state === 'running') {
      requests.get(run.requestId)?.runtime?.interrupt('cancelled');
      await waitUntil(() => run.state === 'done', STOP_WAIT_MS);
    }
    return runResponse(run);
  }

  function requestShutdown() {
    setImmediate(() => {
      Promise.resolve((options.onShutdownRequest ?? close)()).catch(error => {
        log('shutdown_error', { message: String(error?.message ?? error) });
      });
    });
  }

  // --- HTTP dispatch ----------------------------------------------------------------------------------------

  const ROUTES = [
    ['GET', /^\/v1\/health$/, 'health', true],
    ['GET', /^\/v1\/status$/, 'status'],
    ['POST', /^\/v1\/requests$/, 'requests.create'],
    ['GET', /^\/v1\/requests$/, 'requests.list'],
    ['GET', /^\/v1\/requests\/([^/]+)$/, 'requests.get'],
    ['DELETE', /^\/v1\/requests\/([^/]+)$/, 'requests.delete'],
    ['POST', /^\/v1\/wait$/, 'wait'],
    ['POST', /^\/v1\/runs$/, 'runs.create'],
    ['GET', /^\/v1\/runs$/, 'runs.list'],
    ['GET', /^\/v1\/runs\/([^/]+)$/, 'runs.get'],
    ['POST', /^\/v1\/runs\/([^/]+)\/stop$/, 'runs.stop'],
    ['GET', /^\/v1\/runs\/([^/]+)\/evidence$/, 'runs.evidence'],
    ['POST', /^\/v1\/observe$/, 'observe'],
    ['POST', /^\/v1\/act$/, 'act'],
    ['POST', /^\/v1\/daemon\/reload$/, 'daemon.reload'],
    ['POST', /^\/v1\/daemon\/shutdown$/, 'daemon.shutdown'],
  ];

  function matchRoute(method, pathname) {
    for (const [routeMethod, pattern, name, open] of ROUTES) {
      const match = pattern.exec(pathname);
      if (match && routeMethod === method) return { name, open: Boolean(open), param: match[1] && decodeURIComponent(match[1]) };
    }
    return null;
  }

  function validHost(host) {
    return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
  }

  function authorized(header) {
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
    return timingSafeEqual(digest(header.slice(7)), tokenDigest);
  }

  async function dispatch(route, req, url, signal) {
    const body = req.method === 'POST' || req.method === 'DELETE' ? await readJsonBody(req) : {};
    const client = clientName(req.headers['x-fai-client']);
    switch (route.name) {
      case 'health':
        return { body: health() };
      case 'status':
        return { body: statusView() };
      case 'requests.create':
        return createRequest(body, client);
      case 'requests.list': {
        const cutoff = now() - TERMINAL_KEEP_MS;
        const list = [...requests.values()]
          .filter(record => LIVE.has(record.state) || record.endedAt >= cutoff)
          .sort((a, b) => b.createdAt - a.createdAt)
          .map(view);
        return { body: { requests: list } };
      }
      case 'requests.get': {
        const record = getRecord(route.param);
        return { body: view(record) };
      }
      case 'requests.delete': {
        if (body.reason !== undefined && (typeof body.reason !== 'string' || body.reason.length > 200)) {
          throw badOptions('reason must be a short string');
        }
        return { body: await deleteRequest(getRecord(route.param)) };
      }
      case 'wait':
        return { body: await waitRoute(body, signal) };
      case 'runs.create':
        return { body: await runsRoute(body, signal) };
      case 'runs.list':
        return { body: await listRuns(url) };
      case 'runs.get': {
        const run = runs.get(route.param);
        if (run) return { body: runResponse(run) };
        const stored = await storedRun(route.param);
        if (!stored) throw new HttpError(404, 'unknown_run', `No run ${route.param}`);
        return { body: stored };
      }
      case 'runs.stop':
        return { body: await stopRun(route.param) };
      case 'runs.evidence':
        return { body: await evidenceRoute(route.param, url) };
      case 'observe':
        return { body: await observeRoute(body) };
      case 'act':
        return { body: await actRoute(body, signal) };
      case 'daemon.reload':
        return { body: await reload() };
      case 'daemon.shutdown':
        requestShutdown();
        return { body: { ok: true, state: 'shutting_down' } };
      default:
        throw new HttpError(404, 'not_found', 'Unknown route');
    }
  }

  // Every authenticated answer names the driver in effect, so a client (the MCP server) follows the daemon's choice
  // instead of reading config.json on its own.
  function driverHeader(authed) {
    return authed ? { 'X-Fai-Driver': config.driver } : {};
  }

  async function clientApi(req, res, url) {
    const started = Date.now();
    let status = 500;
    let routeName = 'unknown';
    let authed = false;
    // A long-poll whose client went away stops waiting.
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    try {
      if (req.headers.origin !== undefined) {
        throw new HttpError(403, 'forbidden_origin', 'Requests with an Origin header are not accepted');
      }
      if (!validHost(req.headers.host)) throw new HttpError(403, 'bad_host', 'Host must be 127.0.0.1 or localhost');
      const route = matchRoute(req.method, url.pathname);
      if (!route) throw new HttpError(404, 'not_found', `No route ${req.method} ${url.pathname}`);
      routeName = route.name;
      if (!route.open && !authorized(req.headers.authorization)) {
        throw new HttpError(401, 'unauthorized', 'Missing or wrong client token');
      }
      authed = !route.open;
      if (shuttingDown && !route.open) throw new HttpError(503, 'shutting_down', 'The daemon is shutting down', { retryable: true });
      if (!route.open) lastClientCallAt = now();
      const value = await dispatch(route, req, url, controller.signal);
      status = value.status ?? 200;
      sendJson(res, status, value.body, driverHeader(authed));
    } catch (error) {
      if (error instanceof HttpError) {
        status = error.status;
        sendJson(res, status, errorBody(error.code, error.message, error.retryable), driverHeader(authed));
      } else {
        status = 500;
        log('internal_error', { route: routeName, message: String(error?.message ?? error) });
        sendJson(res, 500, errorBody('internal', 'Internal daemon error'));
      }
    }
    log('http', { route: routeName, method: req.method, status, ms: Date.now() - started });
  }

  function onRequest(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://127.0.0.1');
    } catch {
      return sendJson(res, 400, errorBody('bad_request', 'Bad URL'));
    }
    if (url.pathname === '/v1' || url.pathname.startsWith('/v1/')) return clientApi(req, res, url);
    if (hub && hub.handleHttp(req, res)) return undefined;
    return sendJson(res, 404, errorBody('not_found', 'Unknown route'));
  }

  function onUpgrade(req, socket, head) {
    if (hub && !shuttingDown && hub.handleUpgrade(req, socket, head)) return;
    socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  }

  // --- lifecycle --------------------------------------------------------------------------------------------

  async function resolveHub() {
    const hubOptions = {
      secret: settings.secret,
      extensionId: settings.extensionId,
      mode: 'daemon',
      log,
      version,
    };
    if (options.hub) return options.hub;
    if (options.hubFactory) return options.hubFactory(hubOptions);
    const bridge = await import('./bridge.js');
    if (typeof bridge.createHub !== 'function') throw new Error('src/bridge.js does not export createHub');
    const created = bridge.createHub(hubOptions);
    await created.start?.();
    return created;
  }

  /** Sweep timers: request TTL, lease idle, paused expiry, terminal cleanup, idle shutdown. */
  function sweep() {
    const t = now();
    for (const record of [...requests.values()]) {
      if (record.state === 'pending' && t >= record.createdAt + record.ttlMs) {
        setState(record, 'expired', 'ttl');
      } else if (record.state === 'active' && !record.activeRunId && !record.runtime?.active
        && t - record.lastCallAt >= leaseIdleMs()) {
        endRequest(record, 'expired', 'idle');
      } else if (record.state === 'paused' && t - record.pausedAt >= PAUSED_TTL_MS) {
        endRequest(record, 'expired', 'paused_timeout');
      } else if (TERMINAL.has(record.state) && t - record.endedAt >= TERMINAL_KEEP_MS) {
        requests.delete(record.requestId);
        if (record.lease?.leaseId) hub.forgetLease?.(record.lease.leaseId);
      }
    }
    for (const run of [...runs.values()]) {
      if (run.state === 'done' && t - run.finishedAt >= TERMINAL_KEEP_MS) runs.delete(run.runId);
    }
    const idleMs = idleShutdownMs();
    if (idleMs > 0 && !shuttingDown && t - lastClientCallAt >= idleMs) {
      const busy = [...requests.values()].some(record => LIVE.has(record.state))
        || [...runs.values()].some(run => run.state === 'running');
      if (!busy) {
        log('idle_shutdown', { idleMs });
        requestShutdown();
      }
    }
  }

  async function listen() {
    ensureDir(paths.stateDir);
    config = loadConfig(paths, { defaultDriver });
    settings = await loadDaemonSettings(paths.envFile, { env });
    if (settings.generatedSecret) log('pairing_secret_generated');
    token = ensureClientToken(paths);
    tokenDigest = digest(token);
    hub = await resolveHub();
    hub.onEvent(onHubEvent);
    server = http.createServer(onRequest);
    server.on('upgrade', onUpgrade);
    try {
      await new Promise((resolveListen, reject) => {
        server.once('error', reject);
        server.listen(requestedPort, '127.0.0.1', () => {
          server.off('error', reject);
          resolveListen();
        });
      });
    } catch (error) {
      await hub.close?.();
      if (error.code === 'EADDRINUSE') {
        const busy = new Error(`Port ${requestedPort} is already in use`);
        busy.code = 'port_in_use';
        throw busy;
      }
      throw error;
    }
    port = server.address().port;
    startedAt = now();
    lastClientCallAt = now();
    sweepTimer = setInterval(sweep, options.sweepIntervalMs ?? 1000);
    sweepTimer.unref();
    changed();
    log('listening', { port, hub: hub.kind ?? 'hub' });
    // In the background: readiness never waits on the network or on a configured key.
    warmProvider('start');
    updates.start();
    return { port };
  }

  /** Graceful shutdown: interrupt runs (traces written), release leases, close the hub and the server. */
  function close() {
    if (closing) return closing;
    closing = (async () => {
      shuttingDown = true;
      warmAbort.abort();
      updates.stop();
      clearInterval(sweepTimer);
      const running = [...runs.values()].filter(run => run.state === 'running');
      for (const run of running) requests.get(run.requestId)?.runtime?.interrupt('interrupted');
      for (const record of requests.values()) {
        if (record.runtime?.active && !record.activeRunId) record.runtime.interrupt('interrupted');
      }
      if (running.length) {
        let timer;
        await Promise.race([
          Promise.allSettled(running.map(run => run.done)),
          new Promise(resolveWait => {
            timer = setTimeout(resolveWait, SHUTDOWN_RUN_WAIT_MS);
          }),
        ]);
        clearTimeout(timer);
      }
      for (const record of requests.values()) {
        if (LEASED.has(record.state)) endRequest(record, 'released', 'daemon_shutdown');
        else if (record.state === 'pending') setState(record, 'cancelled', 'daemon_shutdown');
      }
      wake();
      try {
        await hub?.close();
      } catch (error) {
        log('hub_close_error', { message: String(error?.message ?? error) });
      }
      if (server) {
        await new Promise(resolveClose => {
          server.close(() => resolveClose());
          server.closeAllConnections();
        });
      }
      log('closed');
    })();
    return closing;
  }

  return {
    listen,
    close,
    reload,
    sweep,
    paths,
    get port() {
      return port;
    },
    /** The provider warm-up in flight, or null (tests await it). */
    get warming() {
      return warming;
    },
    get token() {
      return token;
    },
    get hub() {
      return hub;
    },
    get version() {
      return version;
    },
    /** Snapshot of a request for tests and in-process hosts. */
    request: requestId => {
      const record = requests.get(requestId);
      return record ? view(record) : null;
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Foreground process: lock, daemon.json, signals
// ---------------------------------------------------------------------------------------------------------------

async function takeLock(paths, log) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    const lock = acquireLock(paths);
    if (lock.ok) return { ok: true };
    const info = readDaemonInfo(paths);
    if (info?.port && (await probeHealth(info.port, 500))?.service === SERVICE_NAME) {
      return { ok: false, alreadyRunning: true, pid: info.pid, port: info.port };
    }
    if (Date.now() >= deadline) {
      log('lock_held', { pid: lock.pid });
      const error = new Error(`Another daemon (pid ${lock.pid}) holds ${paths.lock} but is not answering`);
      error.code = 'lock_held';
      throw error;
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
  }
}

/**
 * Run the daemon in this process until SIGTERM/SIGINT or POST /v1/daemon/shutdown.
 * Resolves {status:'already_running', pid, port} immediately when another healthy daemon holds the lock, or
 * {status:'ready', port, pid, daemon, stopped} where `stopped` resolves after a clean shutdown.
 * Throws an Error with code port_in_use or lock_held.
 */
export async function runDaemon({ home, env = process.env, handleSignals = true, daemonOptions = {} } = {}) {
  process.umask(0o077);
  const paths = homePaths({ home, env });
  ensureDir(paths.stateDir);
  const log = createLogger(paths);
  const lock = await takeLock(paths, log);
  if (!lock.ok) {
    log('already_running', { pid: lock.pid, port: lock.port });
    log.close();
    return { status: 'already_running', pid: lock.pid, port: lock.port };
  }
  let resolveStopped;
  const stopped = new Promise(resolveStop => {
    resolveStopped = resolveStop;
  });
  let stopping = null;
  const onSignal = () => stop();
  const onHup = () => {
    daemon.reload().catch(error => log('reload_error', { message: String(error?.message ?? error) }));
  };
  const daemon = createDaemon({ home, env, log, ...daemonOptions, onShutdownRequest: () => stop() });
  function stop() {
    if (stopping) return stopping;
    stopping = (async () => {
      log('stopping');
      try {
        await daemon.close();
      } finally {
        removeDaemonInfo(paths);
        releaseLock(paths);
        if (handleSignals) {
          process.off('SIGTERM', onSignal);
          process.off('SIGINT', onSignal);
          process.off('SIGHUP', onHup);
        }
        log('stopped');
        log.close();
        resolveStopped();
      }
    })();
    return stopping;
  }
  try {
    await daemon.listen();
  } catch (error) {
    releaseLock(paths);
    log('listen_error', { code: error.code ?? 'internal', message: String(error?.message ?? error) });
    log.close();
    throw error;
  }
  const startedIso = new Date().toISOString();
  writeDaemonInfo(paths, {
    pid: process.pid,
    port: daemon.port,
    version: daemon.version,
    startedAt: startedIso,
    log: paths.logFile,
  });
  if (handleSignals) {
    process.on('SIGTERM', onSignal);
    process.on('SIGINT', onSignal);
    process.on('SIGHUP', onHup);
  }
  log('ready', { port: daemon.port, pid: process.pid, version: daemon.version });
  return { status: 'ready', port: daemon.port, pid: process.pid, daemon, stopped, stop };
}

/**
 * Process entry for `fai-browser daemon` and auto-start. Prints one JSON line to stdout, errors as
 * {"error":{code,message}} on stderr, and exits 0 (ready then stopped, or already running) or 1.
 */
export async function runDaemonMain({ env = process.env } = {}) {
  let outcome;
  try {
    outcome = await runDaemon({ env });
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: { code: error.code ?? 'internal', message: error.message } })}\n`);
    process.exit(1);
  }
  if (outcome.status === 'already_running') {
    process.stdout.write(`${JSON.stringify({ ok: true, state: 'already_running', pid: outcome.pid, port: outcome.port })}\n`);
    process.exit(0);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, state: 'ready', pid: outcome.pid, port: outcome.port })}\n`);
  await outcome.stopped;
  process.exit(0);
}
