// The FAI Browser daemon: one loopback HTTP server shared by agent clients (/v1/*) and the extension (everything
// else, handled by the hub). It owns tab requests and leases, acts, traces, retention and the
// pairing secret. See the Phase 2 design, sections 1 and 2.
import http from 'node:http';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { BrowserRuntime, actionLabels, checkActChoice, redactionMeta } from './runtime.js';
import { checkDeclarative, validateExpectation } from './expectation.js';
import { setTimeout as delay } from 'node:timers/promises';
import { agentResult, applyLeaseMessage, approvalSteps, createResult, isKnownCode, outcomeResult, setOutcome } from './result.js';
import { hostInfo, imageSize, toAgentResult, writeRun } from './trace.js';
import { prune, retentionConfig } from './retention.js';
import { PACKAGE_ROOT } from './paths.js';
import {
  acquireLock, configuredPort, createLogger, ensureClientToken, ensureDir, homePaths, loadConfig, readDaemonInfo,
  releaseLock, removeDaemonInfo, writeDaemonInfo,
} from './home.js';
import { DEFAULT_BUDGET, checkBudget, loadDaemonSettings } from './settings.js';
import { LEVELS, clampLevel, isLevel, levelRank, normalizeAdditions } from './guardrails.js';
import { probeHealth } from './client.js';
import { pickBrowser } from './bridge.js';
import { checkOriginEntry, entryCovered, isSiteEntry, leaseOrigins, originCovered, siteRoots, urlCovered } from './origins.js';
import { scrubSecrets } from './secrets.js';
import { spawn } from 'node:child_process';
import { automaticCheck, createUpdateChecker, runningUpdate, underTest, claimUpdateLock, writeInstallState } from './update.js';
import { gitReleaseSource, scrubbedEnv } from './update-git.js';
import { SessionError, SESSION_POLL_MAX_MS, createSessionRegistry } from './sessions.js';
import { cleanInviteText } from './wake.js';

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
// A paused request nobody can continue (its agent session is gone, or none made it) for this long is `stale`: the
// popup no longer offers it for Resume by default and status says so (issue #13).
export const STALE_IDLE_MS = 5 * 60_000;
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

const ACT_KEYS = new Set(['requestId', 'actionId', 'point', 'revision', 'expectation', 'capture', 'timeoutMs', 'waitMs',
  'prune', 'outputDir', 'answerQuestion', 'approvalWaitMs', 'reason',
  // Host-composed acts (src/runtime.js checkActChoice): typed text, batched fills, keys, hover, URLs, history, tabs,
  // dialog answers and uploads.
  'text', 'submit', 'fills', 'hover', 'key', 'url', 'openTab', 'nav', 'tab', 'dialog', 'file']);
// The parts of an act body that make up the runtime's choice.
const CHOICE_KEYS = ['actionId', 'point', 'text', 'submit', 'fills', 'hover', 'key', 'url', 'openTab', 'nav', 'tab', 'dialog', 'file'];
const OBSERVE_KEYS = new Set(['requestId', 'mode', 'allowedUrls', 'suppliedText', 'capture', 'prune', 'outputDir',
  'instruction', 'expectation', 'answerQuestion', 'policy', 'focus', 'digestChars', 'waitFor', 'maxMs', 'logs', 'afterAsk']);
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
const REQUEST_KEYS = new Set(['origins', 'mode', 'reason', 'instruction', 'url', 'ttlMs', 'browser']);
// Invites (the popup's "Invite agent"): an invite id lives 10 minutes and is used once; a browser may make a few a minute.
export const INVITE_TTL_MS = 10 * 60_000;
export const INVITES_PER_MINUTE = 6;
const INVITE_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const INVITE_KEEP_MS = 60 * 60_000;
const SESSION_KEYS = new Set(['host', 'hostSessionId', 'repo', 'pid', 'startedAt', 'wake', 'client', 'previous']);
const CHALLENGE = /^[A-Za-z0-9_-]{16,64}$/;
const SESSION_UPDATE_KEYS = new Set(['lastToolCallAt', 'hostSessionId', 'wake', 'maxMs']);
const WAIT_KEYS = new Set(['requestId', 'runId', 'maxMs', 'afterStep', 'while', 'ask']);
// An agent's ask for more on a request it holds (POST /v1/requests/:id/ask): a higher level, more origins, or both.
const ASK_KEYS = new Set(['mode', 'origins']);
// Bridge codes that describe the lease rather than the page: an act or observe that fails with one while the request
// is still active waits this long for the extension's status report, then reports what the request really is.
const LEASE_CODES = new Set(['stopped', 'paused', 'session_inactive', 'tab_changed', 'origin_changed', 'child_tab',
  'disconnected']);
const LEASE_SETTLE_MS = 1500;
// tab_not_ready answers in a row before the request is paused as a lost session (session_inactive).
const NOT_READY_MAX = 3;
// How long after an approval the extension may still give it back (`not_approved`: its own check of the tab failed).
const UNDO_APPROVAL_MS = 30_000;

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
    tabMode: record.grant?.tabMode ?? 'single',
    // The browser that holds the tab, when several may be paired (issue #9).
    ...(record.lease?.browserId && record.browser?.name ? { browser: { ...record.browser } } : {}) };
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

/**
 * Optional guardrail additions for this run (src/guardrails.js): an array of plain phrases or { forbid, note }.
 * Validated here, before any observe or act; returns the normalized { forbid, note } or undefined.
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

function iso(ms) {
  return ms === null || ms === undefined ? null : new Date(ms).toISOString();
}

/** A short invite id the user can read out or paste: inv- and 8 characters (40 bits), single use, 10 minutes. */
function newInviteId() {
  const bytes = randomBytes(8);
  return `inv-${[...bytes].map(byte => INVITE_ALPHABET[byte & 31]).join('')}`;
}

function newRequestId() {
  return `req_${randomBytes(9).toString('base64url')}`;
}

function digest(value) {
  return createHash('sha256').update(String(value)).digest();
}

// The client instance: the whole X-Fai-Client header, "<name>/<instance id>" (FaiBrowserClient adds a random id per
// client, so one MCP server, SDK client or CLI run), else null. Used only to recognise a repeated request.
function clientInstance(header) {
  return typeof header === 'string' && /^[A-Za-z0-9_.-]{1,40}\/[A-Za-z0-9-]{1,64}$/.test(header) ? header : null;
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
 * hubFactory, now, log, version, maxWaitMs, sweepIntervalMs, onShutdownRequest.
 */
// The failed approval reasons (bridge approvalEvent `reason`) that change how the agent words a pending request's
// approval: `toolbar` when the icon on the task tab gets past them, `declined` when the user declined the browser's
// site-access prompt. Any other reason is only logged.
const APPROVAL_REMEDIES = Object.freeze({
  site_access_timeout: 'toolbar', site_access_request_threw: 'toolbar', page_not_loaded: 'toolbar',
  still_loading: 'toolbar', moved_on_site: 'toolbar', prompt_window_failed: 'toolbar', not_confirmed: 'toolbar',
  popup_no_outcome: 'toolbar', error: 'toolbar',
  site_access_denied: 'declined',
});

export function createDaemon(options = {}) {
  const env = options.env ?? process.env;
  const paths = homePaths({ home: options.home, env });
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  const version = options.version ?? DAEMON_VERSION;
  const maxWaitMs = options.maxWaitMs ?? MAX_WAIT_MS;
  const requestedPort = options.port ?? configuredPort(env);

  const requests = new Map();
  // Creation order of requests (createdAt can tie within a millisecond): `newer_request` staleness compares it.
  let requestSeq = 0;
  // The stale markers last published, so the sweep re-publishes when one changes with time alone.
  let publishedStale = '';
  // Invites by id ({inviteId, requestId, sessionId, state, ...}); see onInviteEvent.
  const invites = new Map();
  // The live coding-agent sessions (one per MCP server process) and their wakes (src/sessions.js).
  const sessions = options.sessions ?? createSessionRegistry({ now, log, isAlive: options.isAlive,
    onChange: () => changed() });
  // Values filled into password inputs (testing level) by any run of this daemon: redacted from later results.
  const filledSecrets = new Set();
  const runs = new Map();
  const watchers = new Set();
  let settings = null;
  let config = {};
  // The popup settings each browser reported (hello and settings messages), by browserId: {budget, openRightAway,
  // approvalAsks}. `budget` is the user's per-request call budget ({maxCalls, maxMs}) or null; `openRightAway` whether
  // that extension opens a request's page by itself (null when it never said: an older one); `approvalAsks` the
  // Approve gate's asks ({purchase, secret, level}; all on until reported), so an offer marks "(asks the user)" only
  // what that browser will ask about. A run, gate or approval wording uses the settings of the browser that holds or
  // awaits the tab; the browser used last only when none is known (several browsers, issue #9).
  const browserSettings = new Map();
  let lastSettingsFrom = null;
  const DEFAULT_ASKS = { purchase: true, secret: true, level: true };
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
  const warnings = [];
  // Update check (src/update.js): about once a day, off with FAI_UPDATE_CHECK=0, config.json updateCheck: false, or
  // under node --test unless options.updateCheck is true. Installing needs the user's click (onUpdateEvent) or command.
  // The environment this daemon was started with, without FAI's secrets: the updater and everything it starts (git, npm, the restarted daemon) get only this.
  const launchEnv = scrubbedEnv(env);
  // Only a git clone can update itself; anything else is told how to update by hand.
  const installable = options.updateInstallable ?? existsSync(join(PACKAGE_ROOT, '.git'));
  // When the anonymous API answers 404, the fallback is `git ls-remote` on the clone's verified remote, with
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
    assignBrowsers();
    wake();
    try {
      hub?.publishRequests(liveViews());
    } catch (error) {
      log('hub_publish_error', { message: String(error?.message ?? error) });
    }
  }

  // --- browsers (several may be connected; issue #9) ---------------------------------------------------------

  // The connected browsers a request can go to ({id, product, name, usedAt, connectedAt}); an injected hub without
  // multi-browser support has none, and requests then carry no browser.
  const browserCandidates = () => hub?.candidates?.() ?? [];
  const browserRef = browser => (browser ? { id: browser.id, product: browser.product ?? null, name: browser.name ?? null } : null);

  /**
   * Gives every pending request a browser to wait in: one the agent named keeps it; any other one without a connected
   * browser goes to the browser the user used FAI in last (pickBrowser). Approved requests keep the browser that
   * holds their tab.
   */
  function assignBrowsers() {
    const candidates = browserCandidates();
    if (!candidates.length) return;
    const connected = new Set(candidates.map(browser => browser.id));
    let preferred;
    for (const record of requests.values()) {
      if (record.state !== 'pending') continue;
      if (record.browser?.id && connected.has(record.browser.id)) continue;
      // A browser the agent named (or the user moved it to) that has been gone for pinGraceMs (a minute; much longer
      // than the hub's 3 s disconnect grace, so a laptop sleep or a service hiccup moves nothing): the request no
      // longer waits for it, and says so (`browserNote`, in the agent's next text).
      const gone = record.browserPinned ? record.browser : null;
      if (gone && now() - (goneSince.get(gone.id) ?? startedAt ?? 0) < pinGraceMs) continue;
      preferred ??= pickBrowser(candidates).browser;
      if (!preferred) return;
      record.browserPinned = false;
      record.browser = browserRef(preferred);
      if (gone) {
        record.browserNote = `${gone.name ?? 'The browser it was meant for'} disconnected; the request now waits in `
          + `${preferred.name ?? 'the browser used last'}.`;
      }
      log('request_browser', { requestId: record.requestId, browserId: preferred.id, reason: gone ? 'unpinned' : 'assigned' });
    }
  }

  // When each browser went away (the hub's `disconnected`, after its grace), for unpinning requests named for it.
  const goneSince = new Map();
  const pinGraceMs = options.pinGraceMs ?? 60_000;

  // The browser whose settings apply to a request: the one holding its tab, else the one it waits in.
  const browserOf = record => record?.lease?.browserId ?? record?.browser?.id ?? null;

  // The settings of `browserId`; when it is unknown (or reported none), those of the browser used last, else of the
  // browser that reported last.
  function settingsFor(browserId) {
    if (browserId && browserSettings.has(browserId)) return browserSettings.get(browserId);
    const latest = pickBrowser(browserCandidates()).browser?.id;
    if (!browserId && latest && browserSettings.has(latest)) return browserSettings.get(latest);
    if (!browserId && lastSettingsFrom !== null && browserSettings.has(lastSettingsFrom)) return browserSettings.get(lastSettingsFrom);
    return null;
  }
  const asksFor = record => settingsFor(browserOf(record))?.approvalAsks ?? DEFAULT_ASKS;

  // The lease belongs to `browserId` (null: the event or hub names no browser, as with an older hub: any).
  const sameBrowser = (record, browserId) => !browserId || !record.lease?.browserId || record.lease.browserId === browserId;

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
      // origin_changed: the origin the tab went to, when the extension could see it (origin only).
      ...(record.state === 'paused' && record.stateReason === 'origin_changed' && record.leftOrigin ? { leftOrigin: record.leftOrigin } : {}),
      // child_tab: the origin of the tab or window the page opened, when the extension could see it (origin only).
      ...(record.state === 'paused' && record.stateReason === 'child_tab' && record.childOrigin ? { childOrigin: record.childOrigin } : {}),
      // A paused request nobody is expected to continue (staleOf): `newer_request` or `idle`. The popup shows it apart
      // and offers no Resume for it by default; an agent that no longer needs it releases it.
      ...(staleOf(record) ? { stale: staleOf(record) } : {}),
      ...(record.state === 'paused' && record.pausedAt ? { pausedAt: iso(record.pausedAt) } : {}),
      origins: [...record.origins],
      mode: record.mode,
      grant: record.grant ? { ...record.grant } : null,
      // The agent asked for more on this approved request (a higher level, more origins): it waits for the user's
      // Approve on the same request and tab (issue #30). `askDeclined`: the user declined the last ask.
      ...(record.ask ? { ask: { id: record.ask.id, level: record.ask.level, origins: [...record.ask.origins],
        access: [...(record.ask.access ?? [])], at: iso(record.ask.at) } } : {}),
      ...(record.askDeclined ? { askDeclined: iso(record.askDeclined) } : {}),
      // A pending request made to ask for more than an earlier pending one, which it replaced (its id).
      ...(record.replaces ? { replaces: record.replaces } : {}),
      reason: record.reason,
      instruction: record.instruction,
      url: record.url,
      client: record.client,
      createdAt: iso(record.createdAt),
      expiresAt: iso(expiresAt(record)),
      lease: record.lease ? { ...record.lease } : null,
      // The browser that holds the tab (once approved), else the one the request waits in; null while no browser
      // with the extension is connected.
      browser: record.browser ? { ...record.browser } : null,
      // Set when the browser the request was meant for went away and it moved to another one.
      ...(record.browserNote ? { browserNote: record.browserNote } : {}),
      activeRunId: record.activeRunId,
      lastRunId: record.lastRunId,
      // How a pending request is approved (`page`: its page opened by itself, the icon click on it approves; `window`:
      // Open in the FAI Browser window first); null once it is no longer pending.
      approval: record.state === 'pending' ? approvalOf(record) : null,
      // The last approval attempt in the browser that failed (onApprovalEvent): codes only, while it is pending.
      ...(record.state === 'pending' && record.approvalIssue ? { approvalIssue: { ...record.approvalIssue } } : {}),
      // The agent session that owns this request (it made it, or joined its invite), while it runs: host and repo
      // folder only. The popup warns before an invite ends another agent's task in the same browser.
      owner: ownerView(record),
      ownerWake: ownerWakeView(record),
      // A tab the user invited an agent to from the popup: the invite and its wake (see onInviteEvent).
      ...(record.invite && invites.has(record.invite) ? { invite: inviteView(invites.get(record.invite)) } : {}),
    };
  }

  function liveViews() {
    return [...requests.values()].filter(record => LIVE.has(record.state)).map(view);
  }

  /**
   * Why a paused request is stale, or null (issue #13: a finished or abandoned request must not capture the user's
   * next Resume or Approve). `newer_request`: the agent that made it (the same owner session, else the same client
   * instance) has asked for another tab since, so it moved on; approving that newer request in the same browser
   * supersedes this one anyway. `idle`: no live agent session owns it and nothing used it for STALE_IDLE_MS since it
   * paused. A stale request can still be resumed (the popup keeps it under "Older paused tasks") or released.
   */
  function staleOf(record, t = now()) {
    if (record.state !== 'paused') return null;
    // A tab the user invited an agent to and nobody joined yet waits for that agent (the invite lives 10 minutes).
    if (record.invite && invites.get(record.invite)?.state === 'open') return null;
    const owner = record.ownerSession ?? null;
    const instance = owner ? null : record.clientInstance ?? null;
    if (owner || instance) {
      for (const other of requests.values()) {
        if (other === record || (other.seq ?? 0) <= (record.seq ?? 0)) continue;
        // A newer request that ended without ever being approved (denied, cancelled, expired) did not replace it.
        if (TERMINAL.has(other.state) && !other.lease) continue;
        if (owner ? other.ownerSession === owner : !other.ownerSession && other.clientInstance === instance) return 'newer_request';
      }
    }
    const ownerLive = owner ? Boolean(sessions.view(owner)) : false;
    if (!ownerLive && t - Math.max(record.pausedAt ?? 0, record.lastCallAt ?? 0) >= STALE_IDLE_MS) return 'idle';
    return null;
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
    syncInvite(record);
    changed();
  }

  /**
   * Who may use a request (observe, act, run, release): every request a client made stays open to any holder of the
   * client token, as before (the CLI's `wait --until active`, an SDK caller). A tab the user invited an agent to is
   * personal: until an agent joins (`invite_not_joined`) nobody uses it, and after that only the joining session
   * (`X-Fai-Session`, `not_owner`).
   */
  function checkUse(record, caller) {
    const invite = record.invite ? invites.get(record.invite) : null;
    if (!invite) return;
    if (invite.state === 'open') {
      throw new HttpError(409, 'invite_not_joined', 'This tab was offered by invite and nobody joined it yet: call '
        + 'fai_browser_open with its inviteId (it is used once, by the agent it was meant for).');
    }
    if (!record.ownerSession || caller?.sessionId !== record.ownerSession) {
      throw new HttpError(403, 'not_owner', 'This tab belongs to the agent session the user invited to it.');
    }
  }

  /**
   * A run or observe of `requestId` (`options`: its trace's options, for one whose request record is gone): only the
   * owner of an invited tab may read, wait on, stop or fetch the evidence of it. Throws `not_owner` otherwise.
   */
  function checkRunUse(requestId, options, caller) {
    const record = requestId ? requests.get(requestId) : null;
    if (record) return checkUse(record, caller);
    if (options?.invite && (!caller || !options.ownerSession || caller.sessionId !== options.ownerSession)) {
      throw new HttpError(403, 'not_owner', 'This run belongs to the agent session the user invited to that tab.');
    }
    return undefined;
  }

  // Whether `caller` may see a run or observe in a list (the same rule, without throwing).
  function seesRun(requestId, options, caller) {
    try {
      checkRunUse(requestId, options, caller);
      return true;
    } catch {
      return false;
    }
  }

  // Whether `caller` may see an invited tab in full: its addressee before the join, its owner after.
  function seesInvite(record, caller) {
    const invite = record.invite ? invites.get(record.invite) : null;
    if (!invite) return true;
    if (!caller) return false;
    if (record.ownerSession) return caller.sessionId === record.ownerSession;
    return invite.state === 'open' && invite.sessionId === caller.sessionId;
  }

  // A request as `caller` may see it: in full, or for an invited tab that is not theirs only its id and state (the CLI's
  // resume wait still works; the personal tab's origin and invite id stay hidden).
  function viewFor(record, caller) {
    if (seesInvite(record, caller)) return view(record);
    return { requestId: record.requestId, state: record.state, stateReason: record.stateReason, invited: true };
  }

  // The requests a client lists: an invited tab only for its addressee or owner.
  function clientViews(caller) {
    return [...requests.values()].filter(record => LIVE.has(record.state) && seesInvite(record, caller)).map(view);
  }

  // Open invites a client may see: those for no session in particular (the user's copy line names one) and its own.
  function inviteViewsFor(caller) {
    return [...invites.values()].filter(invite => invite.state === 'open'
      && (!invite.sessionId || invite.sessionId === caller?.sessionId)).map(inviteView);
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

  /**
   * Compatibility for an extension that names no request (a v2 popup's "Select tab and start"): the newest pending
   * request for the tab's origin; with none pending, a paused one only on its own tab. Never the oldest request, never a
   * paused request on another tab, and never a paused one while a request for the origin waits (issue #13). Never an
   * invited tab (it is bound only through its invite, at the level the user chose), never a request pinned to another
   * browser, and never a paused request another browser holds (tab ids are per browser).
   */
  function pickRequestFor(origin, tabId = null, browserId = null) {
    const other = id => Boolean(browserId && id && id !== browserId);
    const candidates = [...requests.values()]
      .filter(record => !record.invite && originCovered(origin, record.origins))
      .sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0) || b.createdAt - a.createdAt);
    return candidates.find(record => record.state === 'pending' && !(record.browserPinned && other(record.browser?.id)))
      ?? candidates.find(record => record.state === 'paused' && Number.isInteger(tabId) && record.lease?.tabId === tabId
        && !other(record.lease?.browserId))
      ?? null;
  }

  /**
   * What a lease code from the extension (stopped, paused, tab_changed, ...) means for `record`: the request's own
   * state once the extension's status report has arrived (it follows the failed command within moments), as
   * `{blocked}` (blockedResult) when the request is no longer active. A request still active after LEASE_SETTLE_MS
   * was not stopped or paused at all (a command that reached the browser while it was still switching to this tab):
   * `{code: 'tab_not_ready'}`, which says to observe again. Codes that pause the request keep their code.
   */
  async function settledLease(record, code) {
    // Real time, not the daemon's clock: this waits for a message from the browser.
    const until = Date.now() + LEASE_SETTLE_MS;
    while (record.state === 'active' && Date.now() < until) await delay(50);
    if (record.state !== 'active') {
      record.notReady = 0;
      return { blocked: blockedResult(record), code };
    }
    if (!['stopped', 'paused', 'session_inactive'].includes(code)) return { code };
    // The browser keeps answering that it does not hold this lease: after NOT_READY_MAX in a row it is no transient
    // switch but a lost session. The request pauses (session_inactive) so the user's Resume binds the tab again.
    record.notReady = (record.notReady ?? 0) + 1;
    if (record.notReady < NOT_READY_MAX) return { code: 'tab_not_ready' };
    record.notReady = 0;
    interruptActive(record, 'session_inactive');
    setState(record, 'paused', 'session_inactive');
    try {
      if (record.lease?.leaseId) hub.updateLease(record.lease.leaseId, 'paused', 'session_inactive');
    } catch (error) {
      log('hub_update_error', { message: String(error?.message ?? error) });
    }
    return { blocked: blockedResult(record), code };
  }

  /**
   * The agent asks for more on a request (issue #30): a higher level and/or origins the request does not cover yet.
   * Pending: the request itself asks for them. Approved (active or paused): `record.ask` waits for the user's Approve
   * on the same request, tab and page; nothing is granted until then (onLeaseEvent applies it). Asks add up until the
   * user answers. Returns the request view and whether anything was asked.
   */
  function askRoute(requestId, body, caller) {
    checkKeys(body, ASK_KEYS);
    const record = getRecord(requestId);
    checkUse(record, caller);
    touch(record);
    if (!LIVE.has(record.state)) {
      throw new HttpError(409, 'request_closed', `This tab request is ${record.state}; request a tab again.`);
    }
    const mode = body.mode === undefined ? null : oneOf(body, 'mode', [...LEVELS], null);
    const origins = body.origins ?? [];
    if (!Array.isArray(origins) || origins.length > 10) throw badOptions('origins must list at most 10 origins');
    for (const origin of origins) {
      const checked = checkOriginEntry(origin);
      if (checked.error) throw badOptions(checked.error);
    }
    const added = [...new Set(origins)].filter(origin => !entryCovered(origin, record.origins));
    if (record.origins.length + added.length > 10) throw badOptions('A request covers at most 10 origins');
    if (record.state === 'pending') {
      // Not approved yet, and maybe on the user's screen: it never grows under their cursor (issue #38 review). A
      // request for more is a successor; this one expires as replaced, so a click on it approves nothing.
      const raise = mode && levelRank(mode) > levelRank(record.mode);
      if (!raise && !added.length) return { requestId, state: record.state, asked: false, request: viewFor(record, caller) };
      const owner = caller ?? (record.ownerSession ? { sessionId: record.ownerSession } : null);
      const created = createRequest(withoutUndefinedFields({ origins: [...record.origins, ...added], mode: raise ? mode : record.mode,
        reason: record.reason, instruction: record.instruction ?? undefined, url: record.url ?? undefined }),
      record.client, owner, record.clientInstance ?? null);
      const successor = requests.get(created.body.requestId);
      if (successor && successor !== record) {
        if (record.browserPinned) {
          successor.browser = record.browser ? { ...record.browser } : null;
          successor.browserPinned = true;
        }
        record.replacedBy = successor.requestId;
        record.replacedHow = 'successor';
        // The successor names it, so the extension can close this request's own task tab instead of keeping two.
        successor.replaces = requestId;
        setState(record, 'expired', 'replaced');
        log('request_replaced', { requestId, by: successor.requestId });
      }
      return { requestId: created.body.requestId, state: 'pending', asked: false, replaced: requestId,
        request: viewFor(successor ?? record, caller) };
    }
    // An approved request: a domain root cannot join it (the lease keeps its exact-origin scope, so a root would be
    // shown and approved without becoming usable).
    const roots = added.filter(origin => isSiteEntry(origin));
    if (roots.length) {
      throw new HttpError(422, 'ask_root', `A domain root cannot be added to an approved request (${roots[0]}): ask for `
        + 'the exact origins it needs (a frame list or leftOrigin names them).');
    }
    // An exact origin the request already lists that the browser gives FAI Browser no access to yet (the extension
    // reports the ones it can follow as `reachable`): the ask is for its site access.
    const reachable = record.runtime?.lastOffer?.observation?.reachable;
    const access = [...new Set(origins)].filter(origin => !added.includes(origin) && !isSiteEntry(origin)
      && origin !== record.lease?.origin && !(Array.isArray(reachable) && reachable.includes(origin)));
    const held = record.grant?.level ?? 'read-only';
    const pendingLevel = record.ask?.level ?? null;
    const level = [mode, pendingLevel].filter(item => item && levelRank(item) > levelRank(held))
      .sort((a, b) => levelRank(b) - levelRank(a))[0] ?? null;
    const askOrigins = [...new Set([...(record.ask?.origins ?? []), ...added])];
    const askAccess = [...new Set([...(record.ask?.access ?? []), ...access])].filter(origin => !askOrigins.includes(origin));
    if (!level && !askOrigins.length && !askAccess.length) {
      return { requestId, state: record.state, asked: false, request: viewFor(record, caller) };
    }
    // Every ask has its own id: the user's Approve names the one its card showed, and only that one is applied. A second
    // ask while one waits replaces it (with both), under a new id, so a card showing the first approves nothing.
    record.ask = { id: randomBytes(6).toString('hex'), level, origins: askOrigins, access: askAccess, at: now() };
    delete record.askDeclined;
    log('request_ask', { requestId, level, origins: askOrigins.length, access: askAccess.length });
    changed();
    return { requestId, state: record.state, asked: true, request: viewFor(record, caller) };
  }

  /** The v1 result a run call returns when the lease is not active. */
  function blockedResult(record, expectation, mode = record.mode) {
    const lease = { requestId: record.requestId, state: record.state };
    const describe = expectation ? { ...expectation } : null;
    const base = { lease, expectation: describe, permissions: permissionsOf(mode, record) };
    if (record.state === 'pending') return outcomeResult('select_tab', { ...base, approval: approvalOf(record) });
    if (record.state === 'paused') {
      const code = PAUSE_REASONS.has(record.stateReason) ? record.stateReason : 'paused';
      return withLeftOrigin(record, outcomeResult(code, base));
    }
    if (record.state === 'released' && record.stateReason === 'stopped') {
      return outcomeResult('stopped', base);
    }
    // The user refused the request (issue #36): said so, never as a technical close.
    if (record.state === 'denied') return outcomeResult('denied', base);
    const closed = outcomeResult('request_closed', base);
    // Replaced by another approval in the same browser. The successor is named only when it is this agent's own
    // request (then the agent continues there); anything else is the user's choice of another task.
    if (['superseded', 'replaced'].includes(record.stateReason)) {
      const by = record.replacedBy ? requests.get(record.replacedBy) : null;
      if (by && sameSession(by, record) && LIVE.has(by.state)) {
        closed.replacedBy = by.requestId;
        closed.needs.message = `Your request ${by.requestId} replaced this one.`;
      } else if (record.replacedHow === 'successor') {
        // A newer request asked for more than this one (an ask on it while it waited): nobody approved anything.
        closed.needs.message = 'This request was replaced by a newer request.';
      } else {
        closed.needs.message = 'The user approved another task in this browser, which ended this one.';
      }
    }
    return closed;
  }

  /**
   * An origin_changed pause that named where the tab went (the extension's status, origin only): needs.message says
   * so, so the agent can ask the user and request that origin up front next time. Returns the result.
   */
  function withLeftOrigin(record, result) {
    if (typeof result?.needs?.message !== 'string') return result;
    if (result.code === 'origin_changed' && record.leftOrigin) {
      // The origin itself goes in `leftOrigin` (untrusted: a page chooses where it sends the tab); the trusted message
      // only says where to find it.
      result.leftOrigin = record.leftOrigin;
      result.needs.message = `${result.needs.message} It went to leftOrigin (page-chosen: check it with the user). To `
        + 'add it to this task, fai_browser_open with this requestId and it in origins.';
    } else if (result.code === 'child_tab' && record.childOrigin) {
      // The same for a tab or window the page opened (issue #13): its origin is page-chosen, so untrusted.
      result.childOrigin = record.childOrigin;
      result.needs.message = `${result.needs.message} It opened childOrigin (page-chosen: check it with the user). To `
        + 'add it to this task, fai_browser_open with this requestId and it in origins.';
    }
    return result;
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
    const record = event.requestId ? requests.get(event.requestId) : pickRequestFor(event.origin, event.tabId,
      typeof event.browserId === 'string' ? event.browserId : null);
    if (!record) return replyTo(event, { error: { code: 'no_request', message: 'No such tab request' } });
    // What the request was before this approval, so the extension can still give it back (`not_approved`, see
    // revertApproval) and a refused one changes nothing.
    const prior = { state: record.state, stateReason: record.stateReason, lease: record.lease, grant: record.grant,
      origins: [...record.origins], mode: record.mode, ask: record.ask ?? null, runtime: record.runtime,
      bridge: record.bridge, childOrigin: record.childOrigin ?? null, leftOrigin: record.leftOrigin ?? null };
    // The user approved the agent's ask (issue #30): exactly the ask the card showed (its id), or nothing.
    if (event.ask === true && (!record.ask || event.requestId !== record.requestId || event.askId !== record.ask.id)) {
      return replyTo(event, { error: { code: 'ask_changed', message: record.ask
        ? 'The agent changed what it asks for since this card showed it. Nothing was approved: check the card again.'
        : 'Nothing is asked on this request any more. Nothing was approved.' } });
    }
    const asked = event.ask === true ? record.ask : null;
    if (asked) {
      record.origins = [...new Set([...record.origins, ...asked.origins])];
      if (asked.level && levelRank(asked.level) > levelRank(record.mode)) record.mode = asked.level;
      record.ask = null;
    }
    const reply = leaseReply(record, event);
    if (reply?.error) {
      record.origins = prior.origins;
      record.mode = prior.mode;
      record.ask = prior.ask;
    } else {
      record.undo = { leaseId: reply.leaseId, at: now(), prior, expired: expireReplaced(record) };
      if (asked) {
        delete record.askDeclined;
        log('request_ask_approved', { requestId: record.requestId, level: record.grant?.level, origins: asked.origins.length });
        changed();
      }
    }
    return replyTo(event, reply);
  }

  // The lease reply for an approval of `record` (see onLeaseEvent): a re-approval of its active lease, or a binding.
  function leaseReply(record, event) {
    // Re-approval: the user changes the level of the active lease on the same tab (no new lease). A lower level
    // takes effect on the next command (the hub clamps every command to it); a higher one on the next run.
    if (record.state === 'active' && event.requestId && record.lease?.tabId === event.tabId
      && sameBrowser(record, event.browserId)
      && originCovered(event.origin, record.origins) && event.level !== undefined && event.level !== null) {
      const scope = leaseScope(event, record);
      const grant = grantFor(event.level, record, iso(now()), scope, event.tabMode ?? 'single');
      if (!grant) {
        return { error: { code: 'bad_request', message: `level must be one of ${LEVELS.join(', ')}` } };
      }
      const origins = leaseOrigins(record.origins, event.origin, scope);
      record.grant = grant;
      record.lease = { ...record.lease, origin: event.origin, origins };
      hub.setLeaseLevel?.(record.lease.leaseId, grant.level);
      hub.setLeaseTabMode?.(record.lease.leaseId, grant.tabMode);
      hub.setLeaseOrigins?.(record.lease.leaseId, event.origin, origins);
      record.lastCallAt = now();
      log('lease_regranted', { requestId: record.requestId, level: grant.level, scope });
      // The agent waits for this approval of its ask (fai_browser_open): wake it as for any approval.
      if (event.ask === true) wakeOwner(record, 'approved');
      changed();
      return { leaseId: record.lease.leaseId, requestId: record.requestId, origins: [...origins], grant: { ...grant } };
    }
    if (record.state !== 'pending' && record.state !== 'paused') {
      return { error: { code: 'request_not_pending', message: `This request is ${record.state}` } };
    }
    if (!Number.isInteger(event.tabId) || !originCovered(event.origin, record.origins)) {
      return {
        error: {
          code: 'origin_not_requested',
          message: "This tab's origin was not requested",
          origins: [...record.origins],
        },
      };
    }
    const resumed = record.state === 'paused';
    const bound = bindRecord(record, event);
    if (!bound.error) wakeOwner(record, resumed ? 'resume' : 'approved');
    return bound;
  }

  /**
   * The user approved `record`: the older requests its agent still has waiting (the same owner session, else the same
   * client instance) in the same browser are replaced by it, so they expire now (`replaced`). Left pending, a late
   * click on one of them (a modal or permission prompt that answers after the fact) would supersede the request just
   * approved (issue #36). A request the agent asked for after this one is left alone; so are invited tabs.
   */
  function expireReplaced(record) {
    const expired = [];
    const owner = record.ownerSession ?? null;
    const instance = owner ? null : record.clientInstance ?? null;
    if (!owner && !instance) return expired;
    // Only in the browser the approval happened in (one lease per browser): a request waiting in another browser does
    // not compete with it.
    const browserId = record.lease?.browserId ?? null;
    for (const other of [...requests.values()]) {
      if (other === record || other.state !== 'pending' || other.invite || (other.seq ?? 0) >= (record.seq ?? 0)) continue;
      if (!sameSession(other, record)) continue;
      if (browserId && other.browser?.id && other.browser.id !== browserId) continue;
      other.replacedBy = record.requestId;
      setState(other, 'expired', 'replaced');
      expired.push(other);
      log('request_replaced', { requestId: other.requestId, by: record.requestId });
    }
    return expired;
  }

  // Whether two requests come from the same agent: the same owner session, else (no session) the same client instance.
  function sameSession(a, b) {
    const owner = b.ownerSession ?? null;
    if (owner) return a.ownerSession === owner;
    const instance = b.clientInstance ?? null;
    return Boolean(instance) && !a.ownerSession && a.clientInstance === instance;
  }

  /**
   * The extension gave an approval back right after making it (status `not_approved`: its own last check of the tab
   * failed, so nothing was approved): the request returns to what it was before, the same request id still waiting
   * (pending), paused, or active at its earlier level. Leases the approval superseded stay ended. Returns true when
   * reverted.
   */
  function revertApproval(record, leaseId) {
    const undo = record.undo;
    if (!undo || undo.leaseId !== leaseId || now() - undo.at > UNDO_APPROVAL_MS) return false;
    if (record.state !== 'active' || record.lease?.leaseId !== leaseId) return false;
    const { prior } = undo;
    record.undo = null;
    // The requests this approval replaced wait again (it was never made).
    for (const other of undo.expired ?? []) {
      if (other.state === 'expired' && other.stateReason === 'replaced' && other.replacedBy === record.requestId) {
        delete other.replacedBy;
        other.endedAt = null;
        setState(other, 'pending', null);
      }
    }
    const regrant = prior.lease?.leaseId === leaseId;
    record.origins = prior.origins;
    record.mode = prior.mode;
    record.ask = prior.ask;
    record.grant = prior.grant;
    record.lease = prior.lease;
    record.childOrigin = prior.childOrigin;
    record.leftOrigin = prior.leftOrigin;
    if (regrant) {
      // The same lease at its earlier grant, active again (the extension's session never changed).
      hub.setLeaseLevel?.(leaseId, prior.grant.level);
      hub.setLeaseTabMode?.(leaseId, prior.grant.tabMode);
      hub.setLeaseOrigins?.(leaseId, prior.lease.origin, prior.lease.origins);
      hub.updateLease(leaseId, 'active');
      log('approval_reverted', { requestId: record.requestId, to: 'active' });
      changed();
      return true;
    }
    // A run that started on the given-back lease ends as what the request is again (waiting, or its pause).
    interruptActive(record, prior.state === 'pending' ? 'select_tab'
      : PAUSE_REASONS.has(prior.stateReason) ? prior.stateReason : 'paused');
    try {
      hub.forgetLease?.(leaseId);
    } catch (error) {
      log('hub_update_error', { message: String(error?.message ?? error) });
    }
    record.runtime = prior.runtime;
    record.bridge = prior.bridge;
    setState(record, prior.state, prior.stateReason);
    log('approval_reverted', { requestId: record.requestId, to: prior.state });
    return true;
  }

  /**
   * Bind `record` (pending or paused) to the tab the user approved in `event` ({tabId, origin, level, scope, tabMode,
   * browserId, browser}): supersede this browser's other lease, create the lease and its runtime, and make the record
   * active. Returns the lease reply, or {error} when the level is not one. The caller checked the origin.
   */
  function bindRecord(record, event) {
    // The level the user approved for this tab (validated again here: the hub is not the only caller).
    // The scope the user approved: `domain` (the request's domain roots, with Chrome's host permission granted in the
    // extension) or `origin` (the tab's exact origin in place of a root, as for any exact request).
    const scope = leaseScope(event, record);
    const grant = grantFor(event.level, record, iso(now()), scope, event.tabMode ?? 'single');
    if (!grant) {
      return { error: { code: 'bad_request', message: `level must be one of ${LEVELS.join(', ')}` } };
    }
    const origins = leaseOrigins(record.origins, event.origin, scope);
    // One active lease per browser (its extension holds one session): approving another request in the same browser
    // supersedes the current one there. A lease in another browser is left alone.
    const browserId = typeof event.browserId === 'string' ? event.browserId : null;
    for (const other of requests.values()) {
      if (other !== record && LEASED.has(other.state) && sameBrowser(other, browserId)) {
        other.replacedBy = record.requestId;
        endRequest(other, 'released', 'superseded', { interrupt: 'request_closed' });
      }
    }
    // A paused request resumed in another browser: the old browser's session for it ends.
    const previous = record.lease;
    if (previous?.leaseId && browserId && previous.browserId && previous.browserId !== browserId) {
      try {
        hub.updateLease(previous.leaseId, 'released', 'superseded');
      } catch (error) {
        log('hub_update_error', { message: String(error?.message ?? error) });
      }
    }
    const leaseId = randomBytes(16).toString('hex');
    record.lease = { leaseId, tabId: event.tabId, origin: event.origin, origins, grantedAt: grant.grantedAt,
      ...(browserId ? { browserId } : {}) };
    if (browserId) record.browser = browserRef(event.browser ?? { id: browserId });
    delete record.browserNote;
    record.grant = grant;
    record.lastCallAt = now();
    hub.bindLease({
      leaseId,
      requestId: record.requestId,
      browserId,
      tabId: event.tabId,
      origin: event.origin,
      allowedOrigins: [...origins],
      level: grant.level,
      tabMode: grant.tabMode,
    });
    record.runtime = new BrowserRuntime({ bridge: hub.bridgeFor(leaseId), asks: () => asksFor(record) });
    // Password values filled at testing stay redacted in every later result, across leases (a re-approval at another
    // level is a new lease and a new runtime on the same tab, and the page may still echo the value).
    record.runtime.secrets = filledSecrets;
    record.bridge = hub.bridgeFor(leaseId);
    setState(record, 'active', null);
    // origins: what the lease covers. The extension follows a consent wall's redirect only to one of these
    // (followConsentRedirect) and, with `domain` scope, keeps the session across the roots' subdomains.
    return { leaseId, requestId: record.requestId, origins: [...origins], grant: { ...grant } };
  }

  // --- agent sessions, wakes and invites (docs/REFERENCE.md "Invites and wakes") --------------------------------

  /**
   * The user approved or resumed a request an agent session made through MCP: wake that session (its MCP server writes
   * a fixed FAI text to the host's own channel), so it continues without a background wait command. A session that
   * cannot be woken, or one gone, gets nothing: its next text told it to wait or to ask the user.
   */
  function wakeOwner(record, kind) {
    if (!record.ownerSession) return null;
    const wake = sessions.queueWake(record.ownerSession, { kind, requestId: record.requestId, level: record.grant?.level });
    record.ownerWakeId = wake?.wakeId ?? null;
    return wake;
  }

  // The last Approve or Resume wake of a request's owner, for the popup: a failed one shows "tell your agent".
  function ownerWakeView(record) {
    const wake = record.ownerWakeId ? sessions.wake(record.ownerWakeId) : null;
    return wake ? { kind: wake.kind, state: wake.state, error: wake.error } : null;
  }

  function ownerView(record) {
    const owner = record.ownerSession ? sessions.view(record.ownerSession) : null;
    return owner ? { sessionId: owner.sessionId, host: owner.host, repo: owner.repo } : null;
  }

  // Re-registration after a drop: requests and invites of the old session id move to the new one.
  function transferOwner(from, to) {
    for (const record of requests.values()) if (record.ownerSession === from) record.ownerSession = to;
    for (const run of runs.values()) if (run.ownerSession === from) run.ownerSession = to;
    for (const invite of invites.values()) {
      if (invite.sessionId === from) invite.sessionId = to;
      if (invite.joinedBy === from) invite.joinedBy = to;
    }
    log('session_replaced', { from, to });
    changed();
  }

  const inviteLog = new Map(); // browserId -> invite times (ms), for the rate limit
  function inviteView(invite) {
    const wake = invite.wakeId ? sessions.wake(invite.wakeId) : null;
    const target = invite.sessionId ? sessions.view(invite.sessionId) ?? invite.target : null;
    const joined = invite.joinedBy ? sessions.view(invite.joinedBy) ?? invite.joinedView : null;
    return {
      inviteId: invite.inviteId,
      requestId: invite.requestId,
      state: invite.state,
      endReason: invite.endReason ?? null,
      level: invite.level,
      origin: invite.origin,
      createdAt: iso(invite.createdAt),
      expiresAt: iso(invite.expiresAt),
      hasText: Boolean(invite.text),
      session: target ? { sessionId: target.sessionId, host: target.host, repo: target.repo } : null,
      // none: nobody to wake (no session chosen, or it cannot be woken): the popup shows the copy text.
      wake: wake ? { state: wake.state, error: wake.error, ...(wake.detail ? { detail: wake.detail } : {}) } : { state: 'none', error: null },
      joinedBy: joined ? { host: joined.host, repo: joined.repo } : invite.state === 'joined' ? { host: 'unknown', repo: 'unknown' } : null,
    };
  }

  function endInvite(invite, state, reason) {
    if (invite.state !== 'open') return;
    invite.state = state;
    invite.endReason = reason;
    invite.endedAt = now();
    log('invite_ended', { inviteId: invite.inviteId, state, reason });
  }

  /**
   * Keep an invite and its request in step: a request that ends while its invite is open revokes the invite, and an
   * invited tab that leaves its origin (or closes) before an agent joined ends the request (the invite named that tab
   * on that origin only).
   */
  function syncInvite(record) {
    const invite = record.invite ? invites.get(record.invite) : null;
    if (!invite || invite.state !== 'open') return;
    if (TERMINAL.has(record.state)) {
      endInvite(invite, invite.cancelled ? 'cancelled' : 'revoked', record.stateReason ?? record.state);
    } else if (record.state === 'paused' && record.stateReason === 'origin_changed') {
      endInvite(invite, 'revoked', 'origin_changed');
      endRequest(record, 'released', 'invite_revoked', { interrupt: 'request_closed' });
    }
  }

  /**
   * The popup's Invite click (extension channel only, authenticated by the pairing secret; the worker accepts it only
   * from popup.html): a request bound at once to the tab the user is on, at the level they chose, on that tab's exact
   * origin; a single-use invite id with a short life; and a wake for the chosen agent session.
   */
  function onInviteEvent(event) {
    if (runningUpdate(paths)) {
      return replyTo(event, { error: { code: 'update_running',
        message: 'FAI Browser is installing an update and restarts in a moment. Invite again in a minute.' } });
    }
    const checked = typeof event.origin === 'string' ? checkOriginEntry(event.origin) : { error: 'no origin' };
    if (checked.error || isSiteEntry(event.origin) || !/^https?:\/\//.test(event.origin)) {
      return replyTo(event, { error: { code: 'bad_request', message: 'Invite works on an http(s) page only.' } });
    }
    if (!Number.isInteger(event.tabId) || !isLevel(event.level)) {
      return replyTo(event, { error: { code: 'bad_request', message: 'tabId and a level are required' } });
    }
    const browserId = typeof event.browserId === 'string' ? event.browserId : '';
    const t = now();
    const recent = (inviteLog.get(browserId) ?? []).filter(at => t - at < 60_000);
    if (recent.length >= INVITES_PER_MINUTE) {
      return replyTo(event, { error: { code: 'rate_limited', message: 'Too many invites in a minute; wait a moment.' } });
    }
    let target = null;
    if (event.sessionId !== undefined && event.sessionId !== null) {
      target = typeof event.sessionId === 'string' ? sessions.view(event.sessionId) : null;
      if (!target) {
        return replyTo(event, { error: { code: 'unknown_session', message: 'That agent session has ended. Open the popup again to pick one.' } });
      }
    }
    recent.push(t);
    inviteLog.set(browserId, recent);
    // One open invite per tab: a new one on the same tab replaces the earlier one (and its request).
    for (const other of invites.values()) {
      if (other.state === 'open' && other.tabId === event.tabId && other.browserId === browserId) {
        other.cancelled = true;
        const earlier = requests.get(other.requestId);
        if (earlier && !TERMINAL.has(earlier.state)) endRequest(earlier, 'released', 'invite_replaced', { interrupt: 'request_closed' });
        endInvite(other, 'cancelled', 'replaced');
      }
    }
    const text = cleanInviteText(event.text);
    const inviteId = newInviteId();
    const record = {
      requestId: newRequestId(),
      seq: ++requestSeq,
      state: 'pending',
      stateReason: null,
      origins: [event.origin],
      mode: event.level,
      grant: null,
      reason: 'You invited an agent to this tab from the FAI popup.',
      instruction: text ? text.slice(0, 300) : null,
      url: null,
      client: 'invite',
      ttlMs: INVITE_TTL_MS,
      createdAt: t,
      lastCallAt: t,
      pausedAt: null,
      endedAt: null,
      lease: null,
      browser: browserId ? browserRef(event.browser ?? { id: browserId }) : null,
      browserPinned: true,
      activeRunId: null,
      lastRunId: null,
      runtime: null,
      bridge: null,
      invite: inviteId,
      ownerSession: null,
    };
    // Listed only once bound: no view ever shows it pending (an approval window would open for it).
    const bound = bindRecord(record, { ...event, scope: 'origin', tabMode: event.tabMode ?? 'single' });
    if (bound.error) return replyTo(event, bound);
    requests.set(record.requestId, record);
    const invite = { inviteId, requestId: record.requestId, sessionId: target?.sessionId ?? null, target, browserId,
      tabId: event.tabId, origin: event.origin, level: record.grant.level, text, createdAt: t,
      expiresAt: t + INVITE_TTL_MS, state: 'open', endReason: null, wakeId: null, joinedBy: null };
    invites.set(inviteId, invite);
    if (target) {
      const wake = sessions.queueWake(target.sessionId, { kind: 'invite', inviteId, requestId: record.requestId,
        level: invite.level, userText: text });
      invite.wakeId = wake?.wakeId ?? null;
    }
    log('invite_created', { inviteId, requestId: record.requestId, level: invite.level, wake: invite.wakeId ? 'queued' : 'none' });
    changed();
    return replyTo(event, { ...bound, invite: inviteView(invite) });
  }

  // The popup's "Cancel invite", or the worker when an invited tab closed before an agent joined.
  function onInviteCancelEvent(event) {
    const invite = [...invites.values()].find(item => item.inviteId === event.inviteId
      || (event.requestId && item.requestId === event.requestId));
    if (!invite) return replyTo(event, { error: { code: 'unknown_invite', message: 'No such invite' } });
    if (invite.browserId && typeof event.browserId === 'string' && invite.browserId !== event.browserId) {
      return replyTo(event, { error: { code: 'unknown_invite', message: 'Another browser made this invite' } });
    }
    if (invite.state === 'open') {
      invite.cancelled = event.reason !== 'tab_closed';
      const record = requests.get(invite.requestId);
      endInvite(invite, invite.cancelled ? 'cancelled' : 'revoked', event.reason === 'tab_closed' ? 'tab_closed' : 'cancelled');
      if (record && !TERMINAL.has(record.state)) {
        endRequest(record, 'released', invite.cancelled ? 'invite_cancelled' : 'invite_revoked', { interrupt: 'request_closed' });
      }
      changed();
    }
    return replyTo(event, { invite: inviteView(invite) });
  }

  /** The live agent sessions, for the popup's Invite list: host, repo name, last activity and whether it can be woken. */
  function onAgentsEvent(event) {
    sessions.sweep();
    replyTo(event, {
      sessions: sessions.views().map(item => ({ sessionId: item.sessionId, host: item.host, repo: item.repo,
        startedAt: item.startedAt, lastActiveAt: item.lastActiveAt, wake: item.wake, ready: item.ready })),
      invites: [...invites.values()].filter(invite => invite.state === 'open' && (!event.browserId || invite.browserId === event.browserId))
        .map(inviteView),
    });
  }

  /**
   * An agent joins an invite (POST /v1/invites/:id/join, the client token, from fai_browser_open {inviteId}): single
   * use, within its life, while its tab is still held. The joining session (if it says which) owns the request from
   * now on and is the one woken on Resume.
   */
  function joinInvite(inviteId, session) {
    const invite = typeof inviteId === 'string' ? invites.get(inviteId.trim()) : null;
    if (!invite) {
      throw new HttpError(404, 'unknown_invite', 'No such invite; it may have expired. Ask the user to invite you again from the FAI popup.');
    }
    if (invite.state === 'open' && now() >= invite.expiresAt) expireInvite(invite);
    if (invite.state !== 'open') {
      const why = { joined: 'was already used', expired: 'expired', revoked: 'was revoked (the tab closed or left its site)',
        cancelled: 'was cancelled by the user' }[invite.state] ?? invite.state;
      throw new HttpError(409, `invite_${invite.state}`, `This invite ${why}. Ask the user to invite you again from the FAI popup.`);
    }
    if (!session) {
      throw new HttpError(403, 'session_required', 'Joining an invite needs a registered agent session (the FAI MCP '
        + 'server registers by itself; set no FAI_MCP_REGISTRY=0).');
    }
    if (invite.sessionId && invite.sessionId !== session.sessionId) {
      throw new HttpError(403, 'invite_for_another_session', 'This invite is for another agent session.');
    }
    const record = requests.get(invite.requestId);
    if (!record || !LIVE.has(record.state)) {
      endInvite(invite, 'revoked', 'request_ended');
      throw new HttpError(409, 'invite_revoked', 'The invited tab is no longer held. Ask the user to invite you again.');
    }
    invite.state = 'joined';
    invite.joinedAt = now();
    invite.joinedBy = session.sessionId;
    invite.joinedView = sessions.view(session.sessionId);
    record.ownerSession = session.sessionId;
    // The agent that joins now owns the invited tab: its older pending requests are replaced by it (issue #36).
    expireReplaced(record);
    record.lastCallAt = now();
    log('invite_joined', { inviteId: invite.inviteId, requestId: record.requestId, sessionId: invite.joinedBy });
    changed();
    return { inviteId: invite.inviteId, requestId: record.requestId, state: record.state, level: invite.level,
      origin: invite.origin, userText: invite.text || null, request: view(record) };
  }

  function expireInvite(invite) {
    endInvite(invite, 'expired', 'ttl');
    const record = requests.get(invite.requestId);
    if (record && !TERMINAL.has(record.state)) endRequest(record, 'expired', 'invite_expired', { interrupt: 'request_closed' });
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
    // The user declined the agent's ask for more: the request keeps what it had (it is not released).
    if (event.ask === true) {
      if (!record.ask) return replyTo(event, { error: { code: 'request_not_pending', message: 'Nothing is asked on this request' } });
      record.ask = null;
      record.askDeclined = now();
      log('request_ask_declined', { requestId: record.requestId });
      if (record.ownerSession && LEASED.has(record.state)) wakeOwner(record, record.state === 'active' ? 'approved' : 'resume');
      changed();
      return replyTo(event, { requestId: record.requestId, state: record.state });
    }
    // A tab another browser holds is only released there (a pending request can be denied from any browser).
    if (LEASED.has(record.state) && !sameBrowser(record, event.browserId)) {
      return replyTo(event, { error: { code: 'request_not_pending', message: 'Another browser holds this tab' } });
    }
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

  // The popup's "Open here" in another browser: the pending request now waits there (and stays there: the user chose).
  function onMoveEvent(event) {
    const record = event.requestId ? requests.get(event.requestId) : null;
    if (!record) return replyTo(event, { error: { code: 'no_request', message: 'No such tab request' } });
    if (record.state !== 'pending') {
      return replyTo(event, { error: { code: 'request_not_pending', message: `This request is ${record.state}` } });
    }
    if (typeof event.browserId !== 'string') {
      return replyTo(event, { error: { code: 'bad_request', message: 'No browser to move the request to' } });
    }
    record.browser = browserRef(event.browser ?? { id: event.browserId });
    record.browserPinned = true;
    // The user chose where it waits: an earlier note about a browser that went away no longer applies.
    delete record.browserNote;
    log('request_browser', { requestId: record.requestId, browserId: event.browserId, reason: 'moved' });
    changed();
    return replyTo(event, { requestId: record.requestId, browser: { ...record.browser } });
  }

  function onStatusEvent(event) {
    const record = findByLease(event.leaseId);
    if (!record) return;
    // The extension gave back an approval it had just made (its last check of the tab failed): nothing was approved,
    // and the request is what it was before (never "the user stopped it", issue #31).
    if (event.status === 'stopped' && event.reason === 'not_approved' && revertApproval(record, event.leaseId)) return;
    if (event.status === 'stopped') {
      // `stopped` (the user's Stop, the only reason an extension of this version sends besides not_approved) is the
      // one the agent is told "the user stopped the tab" for; anything else ended it without the user.
      const why = event.reason === 'stopped' ? 'stopped' : 'released';
      endRequest(record, 'released', why, { interrupt: why === 'stopped' ? 'stopped' : 'request_closed', notifyHub: false });
      return;
    }
    if (event.status === 'paused' && record.state === 'active') {
      const reason = PAUSE_REASONS.has(event.reason) ? event.reason : 'paused';
      interruptActive(record, reason);
      record.leftOrigin = reason === 'origin_changed' && typeof event.origin === 'string' ? event.origin : null;
      record.childOrigin = reason === 'child_tab' && typeof event.origin === 'string' ? event.origin : null;
      setState(record, 'paused', reason);
    } else if (event.status === 'paused' && record.state === 'paused' && record.stateReason === 'child_tab'
      && event.reason === 'child_tab' && !record.childOrigin && typeof event.origin === 'string') {
      // The child's address became readable only after the pause (a window that opens on about:blank first): the
      // extension reports its origin once, for the same lease.
      record.childOrigin = event.origin;
      log('child_origin', { requestId: record.requestId });
      changed();
    }
  }

  /**
   * The per-request call budget in effect, the ceiling the MCP server enforces: the user's popup setting, else
   * config.json `budget` (validated by loadConfig), else DEFAULT_BUDGET; `source` names which.
   */
  function effectiveBudget(browserId = null) {
    const userBudget = settingsFor(browserId)?.budget ?? null;
    if (userBudget) return { ...userBudget, source: 'extension' };
    const configured = config.budget && typeof config.budget === 'object' ? config.budget : null;
    if (configured && Object.keys(configured).length) return { ...DEFAULT_BUDGET, ...configured, source: 'config' };
    return { ...DEFAULT_BUDGET, source: 'default' };
  }

  /**
   * A browser's popup settings (hello or a settings message): the budget, when valid and complete, else none; "open
   * right away" and the Approve gate's asks when reported (an older extension leaves its earlier ones standing).
   */
  function applySettings(settings, browserId = null) {
    const key = typeof browserId === 'string' ? browserId : '';
    const before = browserSettings.get(key) ?? { budget: null, openRightAway: null, approvalAsks: DEFAULT_ASKS };
    let budget = null;
    try {
      const clean = checkBudget(settings?.budget ?? null);
      if (clean.maxCalls !== undefined && clean.maxMs !== undefined) budget = clean;
    } catch {
      budget = null;
    }
    const next = { ...before, budget };
    if (JSON.stringify(budget) !== JSON.stringify(before.budget)) log('budget_setting', { budget, browserId: key || null });
    if (typeof settings?.openRightAway === 'boolean') next.openRightAway = settings.openRightAway;
    const asks = settings?.approvals;
    if (asks && typeof asks === 'object') {
      next.approvalAsks = { purchase: asks.purchase !== false, secret: asks.secret !== false, level: asks.level !== false };
    }
    browserSettings.set(key, next);
    lastSettingsFrom = key;
  }

  // An approval surface shown, an approval attempt, or why one failed, as the extension reports it (bridge
  // approvalEvent: codes and an origin only): one daemon.log line each (no hub_event line besides). A failure that the
  // toolbar icon on the task tab gets past is kept on its pending request, and so is the user declining the browser's
  // site-access prompt; the agent's approval steps say so (approvalOf). Refusals the surface handles itself (a stale
  // approval it retries, a request that changed) or that the toolbar would not fix are only logged.
  function onApprovalEvent(event) {
    log('approval', { requestId: event.requestId, surface: event.surface, step: event.step, reason: event.reason,
      origin: event.origin, browserId: event.browserId });
    const record = event.requestId ? requests.get(event.requestId) : null;
    if (!record || record.state !== 'pending') return;
    const remedy = event.step === 'failed' ? APPROVAL_REMEDIES[event.reason ?? 'error'] : null;
    if (remedy) {
      record.approvalIssue = { surface: event.surface, reason: event.reason ?? 'error', at: iso(Date.now()), remedy };
      changed();
    } else if (['attempt', 'approved'].includes(event.step) && record.approvalIssue) {
      // A new click (or the approval itself): the earlier failure no longer describes the request.
      delete record.approvalIssue;
      changed();
    }
  }

  // How the user approves a pending request, for the agent's wording (result.js approvalSteps): `page` when the
  // extension opens the request's page by itself (connected, the setting on, a page to open, Interactive or less,
  // and no live session on a tab that already covers it), where the icon click on that page approves; else `window`.
  // After a failed approval in the browser: `toolbar` (the icon on the task tab gets past it) or `declined` (the user
  // declined the browser's site-access prompt).
  function approvalOf(record) {
    if (record.approvalIssue?.remedy) return record.approvalIssue.remedy;
    const extension = hub.extension();
    if (!extension.connected || settingsFor(browserOf(record))?.openRightAway !== true) return 'window';
    const hasPage = Boolean(record.url) || record.origins.some(entry => !isSiteEntry(entry));
    if (!hasPage || levelRank(record.mode) > levelRank('interactive')) return 'window';
    const live = extension.session;
    if (live && ['active', 'paused'].includes(live.status) && live.origin && originCovered(live.origin, record.origins)) {
      return 'window';
    }
    return 'page';
  }

  function onSettingsEvent(event) {
    applySettings(event.settings, event.browserId);
    replyTo(event, { budget: effectiveBudget(event.browserId ?? '') });
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
    if (event.settings !== undefined) applySettings(event.settings, event.browserId);
    const reply = endSession => replyTo(event, {
      mode: 'daemon',
      daemonVersion: version,
      endSession,
      requests: liveViews(),
      budget: effectiveBudget(event.browserId ?? ''),
      update: updates.view(),
    });
    const session = event.session;
    const browserId = typeof event.browserId === 'string' ? event.browserId : null;
    if (!session) {
      // The worker restarted and lost its session: the leases of THIS browser can no longer be served. Another
      // browser's lease is not affected.
      for (const record of requests.values()) {
        if (record.state === 'active' && sameBrowser(record, browserId)) {
          interruptActive(record, 'session_inactive');
          setState(record, 'paused', 'session_inactive');
        }
      }
      return reply(false);
    }
    const record = findByLease(session.leaseId);
    // Unknown, or a lease another browser holds: that session is over.
    if (!record || !sameBrowser(record, browserId)) return reply(true);
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
        browserId: record.lease.browserId ?? browserId,
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

  // A browser went away: only the leases it holds pause (every lease when the hub names no browser).
  function onDisconnected(event) {
    const browserId = typeof event?.browserId === 'string' ? event.browserId : null;
    if (browserId) {
      goneSince.set(browserId, now());
      // Look again once a pinned request may move on.
      setTimeout(() => {
        if (!shuttingDown) changed();
      }, pinGraceMs + 50).unref?.();
    }
    for (const record of requests.values()) {
      if (record.state === 'active' && sameBrowser(record, browserId)) {
        interruptActive(record, 'disconnected');
        setState(record, 'paused', 'disconnected');
      }
    }
  }

  function onHubEvent(event) {
    try {
      // An approval event is its own `approval` line (onApprovalEvent).
      if (event?.type !== 'approval') log('hub_event', { type: event?.type });
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
        case 'update':
          return onUpdateEvent(event);
        case 'disconnected':
          onDisconnected(event);
          return changed();
        case 'connected':
          if (typeof event.browserId === 'string') goneSince.delete(event.browserId);
          return changed();
        case 'move':
          return onMoveEvent(event);
        case 'invite':
          return onInviteEvent(event);
        case 'invite_cancel':
          return onInviteCancelEvent(event);
        case 'agents':
          return onAgentsEvent(event);
        case 'usage':
          return saveKnownBrowsers(event.browsers);
        case 'approval':
          return onApprovalEvent(event);
        default:
          return undefined;
      }
    } catch (error) {
      log('hub_event_error', { type: event?.type, message: String(error?.message ?? error) });
      replyTo(event, { error: { code: 'internal', message: 'Daemon error' } });
      return undefined;
    }
  }

  // --- settings and config --------------------------------------------------------------------------

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
    try {
      config = loadConfig(paths);
    } catch (error) {
      throw badOptions(error.message);
    }
    log('reloaded', { secretChanged });
    return { ok: true, secretChanged };
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

  // An invited tab's runs and observes carry its invite flag and owner session, so who may read them still holds once
  // the request record is gone (traces stay on disk up to retention's 7 days).
  const inviteStamp = record => (record.invite ? { invite: true, ownerSession: record.ownerSession ?? null } : {});

  function traceOptions(spec, record) {
    const options = {
      requestId: record.requestId,
      ...inviteStamp(record),
      mode: spec.mode,
      level: effectiveLevel(spec.mode, record),
      grant: record.grant?.level ?? null,
      capture: spec.capture,
      timeoutMs: spec.timeoutMs,
      allowedOrigins: coveredOrigins(record),
    };
    if (spec.answerQuestion) options.answerQuestion = spec.answerQuestion;
    // Host- and config-written plain phrases (never page text), for the audit trail.
    if (spec.policy) options.policy = spec.policy;
    if (config.guardrails && (config.guardrails.forbid?.length || config.guardrails.note)) options.guardrails = config.guardrails;
    if (spec.expectation) options.expectation = spec.expectation;
    if (spec.allowedUrls?.length) options.allowedUrls = spec.allowedUrls;
    if (spec.suppliedText && Object.keys(spec.suppliedText).length) options.suppliedText = spec.suppliedText;
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
    // An act that reached the page ends any run of tab_not_ready answers (settledLease counts them in a row).
    if (!LEASE_CODES.has(raw?.code) && raw?.code !== 'tab_not_ready') record.notReady = 0;
    if (LEASE_CODES.has(raw?.code)) {
      const settled = await settledLease(record, raw.code);
      const code = settled.blocked?.code ?? settled.code;
      if (code !== raw.code) {
        // The receipt's verdict and next were written for the extension's code: they go with it.
        delete raw.verdict;
        delete raw.next;
        setOutcome(raw, code);
        if (raw.verification) raw.verification = { ...raw.verification, passed: false };
      }
    }
    applyLeaseMessage(raw);
    if (record.state === 'paused') withLeftOrigin(record, raw);
    raw.lease = { requestId: record.requestId, state: record.state };
    const dir = outputDir(spec.outputDir);
    let result;
    try {
      const written = await writeRun(raw, {
        dir,
        instruction: spec.instruction,
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

  function startRun(record, spec, operation) {
    const runId = randomUUID();
    const run = {
      runId,
      requestId: record.requestId,
      operation,
      state: 'running',
      startedAt: now(),
      finishedAt: null,
      steps: 0,
      maxActions: 1,
      lastStep: null,
      result: null,
      done: null,
      // An invited tab's run keeps who may read it, for the time between the request record's removal and its own.
      ...inviteStamp(record),
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
    const promise = runtime.act(spec.choice, { ...common, revision: spec.revision, revisionless: spec.revisionless,
      approvalWaitMs: spec.approvalWaitMs, reason: spec.reason });
    log('run_start', { runId, requestId: record.requestId, operation });
    run.done = promise
      .catch(error => {
        const result = createResult({ runId, expectation: spec.expectation ?? null });
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

  /**
   * The open health answer. With `?challenge=<nonce>` it also proves the daemon holds the client token (an HMAC of its
   * own listening port and the nonce under it, so a proof cannot be relayed from a daemon on another port), so an MCP server checks it is talking to the real daemon before it registers (src/mcp-session.js):
   * a process squatting on the port learns no token and cannot inject wakes.
   */
  function health(url) {
    const challenge = url?.searchParams?.get('challenge');
    const proof = typeof challenge === 'string' && CHALLENGE.test(challenge) && token
      ? createHmac('sha256', token).update(`fai-health:${port}:${challenge}`).digest('hex') : undefined;
    return { ok: true, service: SERVICE_NAME, version, pid: process.pid, ...(proof ? { proof } : {}) };
  }

  function statusView(caller = null) {
    const all = [...runs.values()].filter(run => seesRun(run.requestId, run, caller));
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
      // Every browser with the extension the hub knows: connected ones, and recently gone ones that hold a lease.
      browsers: hub.browsers?.() ?? [],
      // The per-request call budget in effect (the MCP server's ceiling) and where it comes from.
      budget: effectiveBudget(),
      // Newer release (src/update.js): tell the user; only their popup click or `fai-browser update` installs it.
      update: updates.view(),
      requests: clientViews(caller),
      // The live coding-agent sessions (no keys) and the open invites this caller may join (docs/REFERENCE.md
      // "Invites and wakes").
      sessions: sessions.views(),
      invites: inviteViewsFor(caller),
      runs: {
        active: all.filter(run => run.state === 'running').map(runSummary),
        recent: all.filter(run => run.state === 'done').sort((a, b) => b.finishedAt - a.finishedAt).slice(0, 10)
          .map(runSummary),
      },
      warnings: [...warnings, ...(hub.warnings?.() ?? [])],
    };
  }

  function createRequest(body, client, session = null, instance = null) {
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
    // The browser the request waits in: the one the agent named (it must be connected), else the one the user used
    // FAI in last (assigned again when it goes away, or when none is connected yet).
    let wanted;
    if (body.browser !== undefined) {
      if (typeof body.browser !== 'string' || !body.browser.trim() || body.browser.length > 64) {
        throw badOptions('browser must name a connected browser, such as firefox, chrome, chromium, edge or brave');
      }
      const picked = pickBrowser(browserCandidates(), body.browser);
      if (picked.error) throw new HttpError(409, picked.error.code, picked.error.message);
      wanted = picked.browser;
    }
    // The same client instance (one MCP server, SDK client or CLI run: the whole X-Fai-Client header) asking again
    // with the same arguments while its request still waits for the user (a retried call): that pending request is the
    // answer. A second one would open a second task tab and request window, and the user's click would approve only
    // one of them. Another instance (another agent session, another CLI run), or another owner session (X-Fai-Session),
    // always gets its own request.
    const unique = [...new Set(origins)];
    const repeat = instance && [...requests.values()].find(record => record.state === 'pending'
      && record.clientInstance === instance && (record.ownerSession ?? null) === (session?.sessionId ?? null)
      && now() < record.createdAt + record.ttlMs
      && record.mode === mode && record.reason === reason && record.instruction === instruction && record.url === url
      && record.ttlMs === ttlMs && record.origins.length === unique.length
      && unique.every(origin => record.origins.includes(origin))
      && (wanted ? record.browserPinned && record.browser?.id === wanted.id : !record.browserPinned));
    if (repeat) {
      log('request_repeat', { requestId: repeat.requestId });
      return { status: 200, body: { ...requestCreated(repeat), repeated: true } };
    }
    const pending = [...requests.values()].filter(record => record.state === 'pending').length;
    if (pending >= MAX_PENDING_REQUESTS) {
      throw new HttpError(429, 'too_many_requests', 'Too many pending tab requests; cancel one first', { retryable: true });
    }
    const record = {
      requestId: newRequestId(),
      seq: ++requestSeq,
      state: 'pending',
      stateReason: null,
      origins: [...new Set(origins)],
      mode,
      grant: null,
      reason,
      instruction,
      url,
      client,
      clientInstance: instance,
      ttlMs,
      createdAt: now(),
      lastCallAt: now(),
      pausedAt: null,
      endedAt: null,
      lease: null,
      browser: browserRef(wanted ?? null),
      browserPinned: Boolean(wanted),
      activeRunId: null,
      lastRunId: null,
      runtime: null,
      bridge: null,
      // The agent session (MCP server) that asked: woken when the user approves or resumes this request.
      ownerSession: session?.sessionId ?? null,
    };
    requests.set(record.requestId, record);
    log('request_state', { requestId: record.requestId, state: 'pending' });
    changed();
    return { status: 201, body: requestCreated(record) };
  }

  function requestCreated(record) {
    return {
      requestId: record.requestId,
      state: 'pending',
      extensionConnected: Boolean(hub.extension().connected),
      expiresAt: iso(expiresAt(record)),
      message: `Ask the user to approve this request in ${record.browser?.name ?? 'their browser'}: ${approvalSteps(approvalOf(record))}.`,
      request: view(record),
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

  async function waitRoute(body, signal, caller = null) {
    checkKeys(body, WAIT_KEYS);
    const maxMs = clampWait(body.maxMs, DEFAULT_WAIT_MS, maxWaitMs);
    const started = Date.now();
    if (body.runId !== undefined) {
      const run = runs.get(body.runId);
      if (!run) {
        const found = await runFor(body.runId, caller);
        if (found) return found.stored;
        throw new HttpError(404, 'unknown_run', `No run ${body.runId}`);
      }
      const afterStep = optionalInt(body, 'afterStep', 0, 10_000);
      const record = requests.get(run.requestId);
      if (record) checkUse(record, caller);
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
    if (body.ask !== undefined && typeof body.ask !== 'boolean') throw badOptions('ask must be a boolean');
    // ask: also wait while the agent's ask for more on this request waits for the user.
    await waitUntil(() => !watched.includes(record.state) && !(body.ask === true && record.ask && LIVE.has(record.state)),
      maxMs, signal);
    touch(record);
    // `budget`: the call budget in effect for this request (the MCP server reads its ceiling from here).
    return { state: record.state, request: viewFor(record, caller), waitedMs: Date.now() - started,
      budget: effectiveBudget(browserOf(record)) };
  }

  async function actRoute(body, signal, caller = null) {
    checkKeys(body, ACT_KEYS);
    const record = getRecord(body.requestId);
    checkUse(record, caller);
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
    if (record.state !== 'active') {
      return { state: 'done', runId: null, requestId: record.requestId, result: blockedResult(record, spec.expectation) };
    }
    ensureIdle(record);
    const run = startRun(record, spec, 'act');
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
        ...inviteStamp(record),
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

  async function observeRoute(body, caller = null) {
    checkKeys(body, OBSERVE_KEYS);
    const record = getRecord(body.requestId);
    checkUse(record, caller);
    touch(record);
    // The open that asked for more (afterAsk): the ask still waits, or the user declined it. Answered before the
    // allowed URLs are checked, which may name the origin that was asked for.
    if (body.afterAsk !== undefined && typeof body.afterAsk !== 'boolean') throw badOptions('afterAsk must be a boolean');
    if (body.afterAsk === true && LEASED.has(record.state) && (record.ask || record.askDeclined)) {
      const code = record.ask ? 'ask_pending' : 'ask_declined';
      if (!record.ask) delete record.askDeclined;
      return { state: 'done', requestId: record.requestId, result: outcomeResult(code, {
        lease: { requestId: record.requestId, state: record.state }, permissions: permissionsOf(checkMode(body, record), record) }) };
    }
    const spec = {
      mode: checkMode(body, record),
      allowedUrls: checkAllowedUrls(body, record),
      suppliedText: checkSuppliedText(body),
      policy: checkPolicy(body),
      prune: checkPrune(body),
      outputDir: checkOutputDir(body),
      // Relevance hints for the listing cap and the digest only (local only): the body's, else the
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
      // The browser answered for this lease: earlier tab_not_ready answers were transient (settledLease).
      record.notReady = 0;
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
      // A lease code is checked against the request itself (issue #31): the extension's word for one command is not
      // the request's state.
      if (LEASE_CODES.has(code)) {
        const settled = await settledLease(record, code);
        if (settled.blocked) return { state: 'done', requestId: record.requestId, result: settled.blocked };
        if (settled.code !== code) {
          return { state: 'done', requestId: record.requestId, result: outcomeResult(settled.code, {
            lease: { requestId: record.requestId, state: record.state }, permissions: permissionsOf(spec.mode, record) }) };
        }
      }
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
      options: stored.trace.options ?? null,
      result: stored.trace.operation === 'observe' ? stored.trace : toAgentResult(stored.trace),
    };
  }

  // A run by id as `caller` may read it: in memory or on disk, the owner check applied (src/daemon.js checkRunUse).
  async function runFor(runId, caller) {
    const run = runs.get(runId);
    if (run) {
      checkRunUse(run.requestId, run, caller);
      return { run };
    }
    const stored = await storedRun(runId);
    if (!stored) return null;
    checkRunUse(stored.requestId, stored.options, caller);
    const { options: _options, ...answer } = stored;
    return { stored: answer };
  }

  async function listRuns(url, caller = null) {
    const limitText = url.searchParams.get('limit');
    const limit = limitText === null ? 20 : Number(limitText);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw badOptions('limit must be an integer 1-200');
    const requestId = url.searchParams.get('requestId');
    const byId = new Map();
    for (const run of runs.values()) {
      if (seesRun(run.requestId, run, caller)) byId.set(run.runId, runSummary(run));
      else byId.set(run.runId, null);
    }
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
      if (!seesRun(trace.options?.requestId ?? null, trace.options, caller)) continue;
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
      .filter(run => run && (!requestId || run.requestId === requestId))
      .sort((a, b) => String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')))
      .slice(0, limit);
    return { runs: list };
  }

  async function evidenceRoute(runId, url, caller = null) {
    const kind = url.searchParams.get('kind') ?? 'screenshot';
    if (kind !== 'screenshot' && kind !== 'trace') throw badOptions('kind must be screenshot or trace');
    const stepText = url.searchParams.get('step');
    const step = stepText === null ? undefined : Number(stepText);
    if (step !== undefined && (!Number.isInteger(step) || step < 1)) throw badOptions('step must be a positive integer');
    const inline = url.searchParams.get('inline') === '1';

    let tracePath = null;
    const run = runs.get(runId);
    if (run) {
      checkRunUse(run.requestId, run, caller);
      if (run.state !== 'done') throw new HttpError(404, 'no_evidence', 'The run is still running; wait for it first');
      tracePath = run.result?.trace ?? null;
      if (!tracePath) throw new HttpError(404, 'no_evidence', 'This run has no trace on disk');
    } else {
      const stored = await readStoredTrace(runId);
      if (!stored) throw new HttpError(404, 'unknown_run', `No run ${runId}`);
      checkRunUse(stored.trace.options?.requestId ?? null, stored.trace.options, caller);
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

  async function stopRun(runId, caller = null) {
    const found = await runFor(runId, caller);
    if (!found) throw new HttpError(404, 'unknown_run', `No run ${runId}`);
    if (found.stored) return found.stored;
    const { run } = found;
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
    ['POST', /^\/v1\/requests\/([^/]+)\/ask$/, 'requests.ask'],
    ['POST', /^\/v1\/wait$/, 'wait'],
    ['GET', /^\/v1\/runs$/, 'runs.list'],
    ['GET', /^\/v1\/runs\/([^/]+)$/, 'runs.get'],
    ['POST', /^\/v1\/runs\/([^/]+)\/stop$/, 'runs.stop'],
    ['GET', /^\/v1\/runs\/([^/]+)\/evidence$/, 'runs.evidence'],
    ['POST', /^\/v1\/observe$/, 'observe'],
    ['POST', /^\/v1\/act$/, 'act'],
    // Agent sessions (one per MCP server process): register, long-poll for wakes (the heartbeat), report, leave. They
    // are not client activity (`quiet`): a registered session alone never keeps an idle daemon up.
    ['POST', /^\/v1\/sessions$/, 'sessions.register', false, true],
    ['GET', /^\/v1\/sessions$/, 'sessions.list', false, true],
    ['POST', /^\/v1\/sessions\/([^/]+)\/poll$/, 'sessions.poll', false, true],
    ['POST', /^\/v1\/sessions\/([^/]+)\/update$/, 'sessions.update', false, true],
    ['POST', /^\/v1\/sessions\/([^/]+)\/wakes\/([^/]+)$/, 'sessions.report', false, true],
    ['DELETE', /^\/v1\/sessions\/([^/]+)$/, 'sessions.delete', false, true],
    // An agent joins the invite the user made in the popup. There is no route that creates one.
    ['POST', /^\/v1\/invites\/([^/]+)\/join$/, 'invites.join'],
    ['POST', /^\/v1\/daemon\/reload$/, 'daemon.reload'],
    ['POST', /^\/v1\/daemon\/shutdown$/, 'daemon.shutdown'],
  ];

  function matchRoute(method, pathname) {
    for (const [routeMethod, pattern, name, open, quiet] of ROUTES) {
      const match = pattern.exec(pathname);
      if (match && routeMethod === method) {
        return { name, open: Boolean(open), quiet: Boolean(quiet), param: match[1] && decodeURIComponent(match[1]),
          param2: match[2] && decodeURIComponent(match[2]) };
      }
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

  // A registry error as the HTTP error it maps to.
  function sessionCall(fn) {
    try {
      return fn();
    } catch (error) {
      if (error instanceof SessionError) throw new HttpError(error.status, error.code, error.message);
      throw error;
    }
  }

  /**
   * The agent session a call comes from: the X-Fai-Session header, `<sessionId>:<key>`. `id`: the session the route
   * names (it must be the header's). `optional`: no header, or one that does not authenticate, is just no session.
   */
  function sessionFrom(req, { id = null, optional = false } = {}) {
    const header = req.headers['x-fai-session'];
    const text = typeof header === 'string' ? header : '';
    const split = text.indexOf(':');
    const sessionId = split > 0 ? text.slice(0, split) : '';
    const key = split > 0 ? text.slice(split + 1) : '';
    try {
      if (id !== null && sessionId !== id) throw new SessionError(403, 'session_forbidden', 'The session header names another session');
      return sessions.authenticate(sessionId, key);
    } catch (error) {
      if (optional) return null;
      if (error instanceof SessionError) throw new HttpError(error.status, error.code, error.message);
      throw error;
    }
  }

  async function dispatch(route, req, url, signal) {
    const body = req.method === 'POST' || req.method === 'DELETE' ? await readJsonBody(req) : {};
    const client = clientName(req.headers['x-fai-client']);
    // The agent session the call comes from (X-Fai-Session), when it names one that authenticates.
    const caller = route.open ? null : sessionFrom(req, { optional: true });
    const instance = clientInstance(req.headers['x-fai-client']);
    switch (route.name) {
      case 'health':
        return { body: health(url) };
      case 'status':
        return { body: statusView(caller) };
      case 'requests.create':
        return createRequest(body, client, caller, instance);
      case 'sessions.register': {
        checkKeys(body, SESSION_KEYS);
        const registered = sessionCall(() => sessions.register(body));
        // A session the daemon dropped (it stopped polling for a while) came back with its old key: its requests and
        // the invites meant for it are its own again.
        if (registered.replaced) transferOwner(registered.replaced, registered.sessionId);
        const { replaced: _replaced, ...answer } = registered;
        return { status: 201, body: answer };
      }
      case 'sessions.list':
        sessions.sweep();
        return { body: { sessions: sessions.views() } };
      case 'sessions.poll': {
        const session = sessionFrom(req, { id: route.param });
        checkKeys(body, SESSION_UPDATE_KEYS);
        sessions.update(session, body);
        const maxMs = clampWait(body.maxMs, SESSION_POLL_MAX_MS, SESSION_POLL_MAX_MS);
        return { body: await sessions.poll(session, shuttingDown ? 0 : maxMs, signal) };
      }
      case 'sessions.update': {
        const session = sessionFrom(req, { id: route.param });
        checkKeys(body, SESSION_UPDATE_KEYS);
        return { body: { session: sessions.update(session, body) } };
      }
      case 'sessions.report': {
        const session = sessionFrom(req, { id: route.param });
        return { body: { wake: sessionCall(() => sessions.report(session, route.param2, body)) } };
      }
      case 'sessions.delete': {
        const session = sessionFrom(req, { id: route.param });
        return { body: { removed: sessions.unregister(session) } };
      }
      case 'invites.join':
        return { body: joinInvite(route.param, caller) };
      case 'requests.list': {
        const cutoff = now() - TERMINAL_KEEP_MS;
        const list = [...requests.values()]
          .filter(record => (LIVE.has(record.state) || record.endedAt >= cutoff) && seesInvite(record, caller))
          .sort((a, b) => b.createdAt - a.createdAt)
          .map(view);
        return { body: { requests: list } };
      }
      case 'requests.ask':
        return { body: askRoute(route.param, body, caller) };
      case 'requests.get': {
        const record = getRecord(route.param);
        return { body: viewFor(record, caller) };
      }
      case 'requests.delete': {
        if (body.reason !== undefined && (typeof body.reason !== 'string' || body.reason.length > 200)) {
          throw badOptions('reason must be a short string');
        }
        const record = getRecord(route.param);
        checkUse(record, caller);
        return { body: await deleteRequest(record) };
      }
      case 'wait':
        return { body: await waitRoute(body, signal, caller) };
      case 'runs.list':
        return { body: await listRuns(url, caller) };
      case 'runs.get': {
        const found = await runFor(route.param, caller);
        if (!found) throw new HttpError(404, 'unknown_run', `No run ${route.param}`);
        return { body: found.run ? runResponse(found.run) : found.stored };
      }
      case 'runs.stop':
        return { body: await stopRun(route.param, caller) };
      case 'runs.evidence':
        return { body: await evidenceRoute(route.param, url, caller) };
      case 'observe':
        return { body: await observeRoute(body, caller) };
      case 'act':
        return { body: await actRoute(body, signal, caller) };
      case 'daemon.reload':
        return { body: await reload() };
      case 'daemon.shutdown':
        requestShutdown();
        return { body: { ok: true, state: 'shutting_down' } };
      default:
        throw new HttpError(404, 'not_found', 'Unknown route');
    }
  }

  async function clientApi(req, res, url) {
    const started = Date.now();
    let status = 500;
    let routeName = 'unknown';
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
      if (shuttingDown && !route.open) throw new HttpError(503, 'shutting_down', 'The daemon is shutting down', { retryable: true });
      if (!route.open && !route.quiet) lastClientCallAt = now();
      const value = await dispatch(route, req, url, controller.signal);
      status = value.status ?? 200;
      sendJson(res, status, value.body);
    } catch (error) {
      if (error instanceof HttpError) {
        status = error.status;
        sendJson(res, status, errorBody(error.code, error.message, error.retryable));
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

  // Each browser's last use and extension Origin ({id: {usedAt, origin}}), in browsers.json in the state directory, so
  // new requests still go to the browser used last after a restart or an update. Nothing secret is kept there.
  const knownBrowsersFile = () => join(paths.stateDir, 'browsers.json');
  async function loadKnownBrowsers() {
    // A write cut short by a crash leaves its temporary file behind.
    try {
      for (const name of await readdir(paths.stateDir)) {
        if (/^browsers\.json\..+\.tmp$/.test(name)) await unlink(join(paths.stateDir, name)).catch(() => {});
      }
    } catch {
      // No state directory yet.
    }
    try {
      const parsed = JSON.parse(await readFile(knownBrowsersFile(), 'utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  let savingBrowsers = Promise.resolve();
  function saveKnownBrowsers(browsers) {
    if (!browsers || typeof browsers !== 'object') return savingBrowsers;
    const text = `${JSON.stringify(browsers)}\n`;
    savingBrowsers = savingBrowsers.then(async () => {
      const file = knownBrowsersFile();
      const temp = `${file}.${process.pid}.tmp`;
      await mkdir(paths.stateDir, { recursive: true });
      await writeFile(temp, text, { mode: 0o600 });
      await rename(temp, file);
    }).catch(error => log('browsers_save_error', { message: String(error?.message ?? error).slice(0, 200) }));
    return savingBrowsers;
  }

  async function resolveHub() {
    const hubOptions = {
      secret: settings.secret,
      extensionId: settings.extensionId,
      mode: 'daemon',
      log,
      version,
      // Each browser's last use and extension Origin, kept across restarts and updates (browsers.json).
      knownBrowsers: await loadKnownBrowsers(),
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
    for (const [browserId, times] of [...inviteLog]) {
      if (!times.some(at => t - at < 60_000)) inviteLog.delete(browserId);
    }
    for (const invite of [...invites.values()]) {
      if (invite.state === 'open' && t >= invite.expiresAt) expireInvite(invite);
      else if (invite.state !== 'open' && t - (invite.endedAt ?? invite.joinedAt ?? invite.createdAt) >= INVITE_KEEP_MS) invites.delete(invite.inviteId);
    }
    sessions.sweep();
    // A paused request turns stale with time alone (or its agent session went away): show the popup at once.
    const stale = [...requests.values()].filter(record => staleOf(record, t)).map(record => record.requestId).join(',');
    if (stale !== publishedStale) {
      publishedStale = stale;
      changed();
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
    config = loadConfig(paths);
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
    updates.start();
    return { port };
  }

  /** Graceful shutdown: interrupt runs (traces written), release leases, close the hub and the server. */
  function close() {
    if (closing) return closing;
    closing = (async () => {
      shuttingDown = true;
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
      // Open wake polls answer now (empty), so the MCP servers re-register with the next daemon.
      sessions.close();
      wake();
      try {
        await hub?.close();
        await savingBrowsers;
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
