// Update check: is a newer tagged GitHub release of FAI Browser out? (docs/REFERENCE.md "Updates")
//
// The daemon asks GitHub's releases API for the latest release (GitHub leaves drafts and prereleases out of
// /releases/latest; a draft, prerelease or malformed answer counts as no release) about once a day, the first time
// STARTUP_DELAY_MS after it starts when the last check is older than that. One plain https GET with a generic
// User-Agent, no token, no cookie, nothing about the user, a 10 s timeout and If-None-Match with the cached ETag; when
// the release is newer, one more GET asks which commit its tag names. Failures only set `status`. The result is cached
// in the state directory (update-check.json), so a CLI check and the daemon share it and a restart does not re-ask.
//
// A private repository answers the anonymous API with 404. Then, when the caller gives a `gitSource` (the daemon and
// the CLI do for a git clone), the check falls back to `git ls-remote --tags` on the clone's verified remote with the
// user's own git credentials (src/update-git.js; FAI stores and reads no token): the highest plain vX.Y.Z tag, its
// peeled commit. That path cannot see drafts or prereleases, so only final releases may get a vX.Y.Z tag. `source`
// says which path found the release (api or git).
//
// Off switch: FAI_UPDATE_CHECK=0 (or false/off/no) or config.json "updateCheck": false stops the automatic checks;
// `fai-browser update --check` and `fai-browser update` still check once when the user runs them. Under node --test
// the daemon never checks unless a test turns it on (createDaemon option updateCheck).
//
// Nothing here installs anything: src/update-install.js does, only after the user's click in the popup or their
// `fai-browser update` command. Release data from the network is never trusted as text: the tag must match TAG (a
// plain vX.Y.Z), the commit SHA, and the release notes link is built here from the validated tag.
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDir, isAlive, writePrivate } from './home.js';
import { UPDATE_REPO_PATH } from './update-git.js';

export const UPDATE_REPO = UPDATE_REPO_PATH;
export const RELEASES_API = `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`;
export const RELEASES_PAGE = `https://github.com/${UPDATE_REPO}/releases`;
export const USER_AGENT = 'fai-browser-update-check';
export const CHECK_INTERVAL_MS = 24 * 60 * 60_000;
// After a failed check, try again sooner than a day (never sooner than this).
export const RETRY_AFTER_ERROR_MS = 60 * 60_000;
// A check the user asks for (CLI --check, the popup) reuses a result younger than this instead of asking again.
export const FORCED_CHECK_GAP_MS = 60_000;
export const CHECK_TIMEOUT_MS = 10_000;
export const STARTUP_DELAY_MS = 30_000;
// How often the daemon looks whether a check is due (the check itself runs at most once per CHECK_INTERVAL_MS).
export const POLL_MS = 60 * 60_000;
// A rate limit's retry time is never trusted beyond this.
export const MAX_RETRY_MS = 24 * 60 * 60_000;
// An update lock or running record older than this is stale even when its pid is alive (a reused pid).
export const UPDATE_MAX_MS = 45 * 60_000;

// Stable releases only: v + three plain numbers, no prerelease or build part, no leading zeros, bounded length.
const VERSION = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
const TAG = /^v((?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5}))$/;
const SHA = /^[0-9a-f]{40}$/;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/;
const OFF = new Set(['0', 'false', 'off', 'no']);
const CHECK_STATES = new Set(['ok', 'not_found', 'error', 'rate_limited']);
const SOURCES = new Set(['api', 'git']);
// up_to_date: an updater that found nothing to install (the popup's click on a release that is already in).
const INSTALL_STATES = new Set(['running', 'succeeded', 'failed', 'rolled_back', 'up_to_date']);
const ERROR_CODE = /^[a-z0-9_]{1,40}$/;

/** [major, minor, patch] of a plain "X.Y.Z" version, or null. */
export function parseVersion(text) {
  const match = typeof text === 'string' ? VERSION.exec(text) : null;
  return match ? match.slice(1, 4).map(Number) : null;
}

/** `{ tag, version }` for a strict release tag "vX.Y.Z", or null for anything else (prerelease, build, junk). */
export function parseTag(tag) {
  const match = typeof tag === 'string' ? TAG.exec(tag) : null;
  return match ? { tag, version: match[1] } : null;
}

export function isReleaseTag(tag) {
  return parseTag(tag) !== null;
}

export function isCommitSha(value) {
  return typeof value === 'string' && SHA.test(value);
}

/** -1, 0 or 1 comparing two "X.Y.Z" versions; null when either is not one. */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

export function isNewer(candidate, current) {
  return compareVersions(candidate, current) === 1;
}

/** The release notes page for a validated tag (built here, never taken from the API). */
export function notesUrl(tag) {
  return isReleaseTag(tag) ? `${RELEASES_PAGE}/tag/${tag}` : null;
}

/** True inside node --test (this process or the environment handed to a daemon). */
export function underTest(env = process.env) {
  return Boolean(env.NODE_TEST_CONTEXT || process.env.NODE_TEST_CONTEXT);
}

/**
 * Whether the automatic check runs: `{ enabled, reason }`, reason naming what turned it off (`env`, `config`, `test`,
 * `option`). `override` is the createDaemon option (true/false), which wins over the test rule but not the user's
 * switches.
 */
export function automaticCheck({ env = process.env, config = {}, override } = {}) {
  const value = env.FAI_UPDATE_CHECK;
  if (typeof value === 'string' && OFF.has(value.trim().toLowerCase())) return { enabled: false, reason: 'env' };
  if (config?.updateCheck === false) return { enabled: false, reason: 'config' };
  if (override === false) return { enabled: false, reason: 'option' };
  if (override !== true && underTest(env)) return { enabled: false, reason: 'test' };
  return { enabled: true, reason: null };
}

/** Files of the updater in the daemon's state directory. */
export function updatePaths(paths) {
  return {
    check: join(paths.stateDir, 'update-check.json'),
    install: join(paths.stateDir, 'update-install.json'),
    lock: join(paths.stateDir, 'update.lock'),
    log: join(paths.logDir, 'update.log'),
  };
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

const isoOrNull = value => (typeof value === 'string' && ISO.test(value) ? value : null);
const msOf = value => (isoOrNull(value) ? Date.parse(value) : null);

/** A release record as cached: only validated fields. */
function cleanRelease(value) {
  const parsed = parseTag(value?.tag);
  if (!parsed) return null;
  return {
    tag: parsed.tag,
    version: parsed.version,
    commit: isCommitSha(value.commit) ? value.commit : null,
    publishedAt: isoOrNull(value.publishedAt),
  };
}

/** The cached check (update-check.json), validated; an empty record when absent or malformed. */
export function readCheckState(paths) {
  const raw = readJson(updatePaths(paths).check) ?? {};
  return {
    attemptAt: isoOrNull(raw.attemptAt),
    checkedAt: isoOrNull(raw.checkedAt),
    status: CHECK_STATES.has(raw.status) ? raw.status : null,
    error: typeof raw.error === 'string' && ERROR_CODE.test(raw.error) ? raw.error : null,
    retryAt: isoOrNull(raw.retryAt),
    etag: typeof raw.etag === 'string' && raw.etag.length <= 200 && /^[\x21-\x7e]+$/.test(raw.etag) ? raw.etag : null,
    source: SOURCES.has(raw.source) ? raw.source : null,
    latest: cleanRelease(raw.latest),
  };
}

function writeCheckState(paths, state) {
  ensureDir(paths.stateDir);
  writePrivate(updatePaths(paths).check, `${JSON.stringify(state, null, 2)}\n`);
}

/** The last install's record (update-install.json), validated, or null. A `running` one whose process died is failed. */
export function readInstallState(paths) {
  const raw = readJson(updatePaths(paths).install);
  if (!raw || !INSTALL_STATES.has(raw.state)) return null;
  const version = value => (parseVersion(value) ? value : null);
  const record = {
    state: raw.state,
    from: version(raw.from),
    to: version(raw.to),
    at: isoOrNull(raw.at),
    step: typeof raw.step === 'string' && ERROR_CODE.test(raw.step) ? raw.step : null,
    error: typeof raw.error === 'string' && ERROR_CODE.test(raw.error) ? raw.error : null,
    message: typeof raw.message === 'string' ? raw.message.slice(0, 500) : null,
    // The release commit the checkout moved to and the commit before it (written at the move): an unfinished update is
    // resumed only on that very commit (src/update-cli.js).
    commit: isCommitSha(raw.commit) ? raw.commit : null,
    previous: isCommitSha(raw.previous) ? raw.previous : null,
    // A resume that was refused (a tab held) keeps this marker, so the next run resumes again.
    resume: raw.resume === true,
  };
  if (record.state === 'running' && !liveHolder(raw.pid, raw.at, raw.pidStart)) {
    return { ...record, state: 'failed', error: 'interrupted',
      message: 'The update stopped before it finished. Run node src/cli.js update to finish it or see where the checkout is.' };
  }
  return record;
}

/**
 * When a process started, as the kernel counts it (Linux: field 22 of /proc/<pid>/stat), or null where that cannot be
 * read. A pid with another start time is another process (a reused pid).
 */
export function processStart(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // "pid (comm) state ..." where comm may hold spaces and parentheses: the fields follow the last ")".
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const start = fields[19];
    return /^\d+$/.test(start ?? '') ? start : null;
  } catch {
    return null;
  }
}

/**
 * A pid that is alive and is the process that wrote the record or lock: the same start time where the platform tells
 * it (Linux), else written less than UPDATE_MAX_MS ago (a reused pid ages out).
 */
function liveHolder(pid, at, pidStart, now = Date.now()) {
  if (!Number.isInteger(pid) || !isAlive(pid)) return false;
  const current = typeof pidStart === 'string' ? processStart(pid) : null;
  if (current !== null) return current === pidStart;
  const time = msOf(at);
  return time !== null && now - time < UPDATE_MAX_MS;
}

export function writeInstallState(paths, record) {
  ensureDir(paths.stateDir);
  const pidStart = Number.isInteger(record.pid) ? processStart(record.pid) : null;
  writePrivate(updatePaths(paths).install, `${JSON.stringify({ ...record, ...(pidStart ? { pidStart } : {}),
    at: new Date().toISOString() }, null, 2)}\n`);
}

function lockBody(pid) {
  const pidStart = processStart(pid);
  return JSON.stringify({ pid, ...(pidStart ? { pidStart } : {}), startedAt: new Date().toISOString() });
}

/**
 * Create update.lock for `pid` exclusively (`wx`): true when this call created it or it already names `pid`; a stale
 * lock is cleared once and the create retried; false when another live process holds it.
 */
export function claimUpdateLock(paths, pid) {
  ensureDir(paths.stateDir);
  const { lock } = updatePaths(paths);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lock, lockBody(pid), { flag: 'wx', mode: 0o600 });
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    if (runningUpdate(paths) === pid) return true;
    if (!clearStaleLock(paths)) return false;
  }
  return false;
}

/** Remove update.lock only while it still names `pid` (never another updater's lock). */
export function releaseUpdateLock(paths, pid) {
  const current = readJson(updatePaths(paths).lock);
  if (current?.pid !== pid) return false;
  try {
    unlinkSync(updatePaths(paths).lock);
  } catch {
    // Already gone.
  }
  return true;
}

/** Remove a stale lock file (tests, a crashed updater): only when its holder is gone or not the same process. */
export function clearStaleLock(paths) {
  const lock = readJson(updatePaths(paths).lock);
  if (lock && liveHolder(lock.pid, lock.startedAt, lock.pidStart)) return false;
  try {
    unlinkSync(updatePaths(paths).lock);
  } catch {
    // Already gone.
  }
  return true;
}

/** The pid of a live update in progress, or null. */
export function runningUpdate(paths) {
  const lock = readJson(updatePaths(paths).lock);
  return lock && liveHolder(lock.pid, lock.startedAt, lock.pidStart) ? lock.pid : null;
}

function header(response, name) {
  try {
    return response.headers?.get?.(name) ?? null;
  } catch {
    return null;
  }
}

async function getWithTimeout(fetchImpl, url, headers, timeoutMs, signal) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  // No credentials, cookies or referrer: Node's fetch sends none; redirects are not followed off GitHub's API.
  return fetchImpl(url, { method: 'GET', headers, redirect: 'error', signal: combined });
}

/**
 * One check against GitHub. Resolves one of:
 *   { status: 'ok', release, etag }                a valid stable release (release.commit when it is newer)
 *   { status: 'not_modified' }                     304 for the cached ETag
 *   { status: 'not_found' }                        no published stable release (404, draft, prerelease, bad tag)
 *   { status: 'rate_limited', retryAt }            403/429 with the rate limit spent
 *   { status: 'error', error }                     network, timeout, HTTP or JSON error (a code, never a message)
 */
export async function fetchLatestRelease({ fetch: fetchImpl = globalThis.fetch, etag = null, currentVersion,
  timeoutMs = CHECK_TIMEOUT_MS, signal, now = Date.now } = {}) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': USER_AGENT, 'X-GitHub-Api-Version': '2022-11-28' };
  if (etag) headers['If-None-Match'] = etag;
  let response;
  try {
    response = await getWithTimeout(fetchImpl, RELEASES_API, headers, timeoutMs, signal);
  } catch (error) {
    return { status: 'error', error: error?.name === 'TimeoutError' ? 'timeout' : 'network' };
  }
  if (response.status === 304) return { status: 'not_modified' };
  if (response.status === 404) return { status: 'not_found' };
  if (response.status === 403 || response.status === 429) {
    // A header that is absent stays absent (Number(null) would be 0).
    const numeric = name => {
      const value = header(response, name);
      return typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : null;
    };
    const remaining = numeric('x-ratelimit-remaining');
    const reset = numeric('x-ratelimit-reset');
    const retryAfter = numeric('retry-after');
    if (remaining === 0 || response.status === 429 || retryAfter !== null) {
      const at = reset ? reset * 1000 : now() + (retryAfter ? retryAfter * 1000 : RETRY_AFTER_ERROR_MS);
      const capped = Math.min(Math.max(at, now() + FORCED_CHECK_GAP_MS), now() + MAX_RETRY_MS);
      return { status: 'rate_limited', retryAt: new Date(capped).toISOString() };
    }
    return { status: 'error', error: 'http_403' };
  }
  if (response.status !== 200) return { status: 'error', error: `http_${Number(response.status) || 0}` };
  let body;
  try {
    body = await response.json();
  } catch {
    return { status: 'error', error: 'bad_json' };
  }
  if (!body || typeof body !== 'object' || body.draft !== false || body.prerelease !== false) return { status: 'not_found' };
  const parsed = parseTag(body.tag_name);
  if (!parsed) return { status: 'not_found' };
  const release = { tag: parsed.tag, version: parsed.version, commit: null, publishedAt: isoOrNull(body.published_at) };
  const newEtag = header(response, 'etag');
  // The commit always comes from the tag itself (target_commitish only names where the tag was made).
  if (!currentVersion || isNewer(release.version, currentVersion)) {
    release.commit = await fetchTagCommit({ fetch: fetchImpl, tag: release.tag, timeoutMs, signal });
  }
  return { status: 'ok', release, etag: typeof newEtag === 'string' ? newEtag : null };
}

/** The commit a release tag names, from GitHub's commits API (text SHA), or null. */
export async function fetchTagCommit({ fetch: fetchImpl = globalThis.fetch, tag, timeoutMs = CHECK_TIMEOUT_MS, signal } = {}) {
  if (!isReleaseTag(tag)) return null;
  try {
    const response = await getWithTimeout(fetchImpl, `https://api.github.com/repos/${UPDATE_REPO}/commits/${tag}`,
      { Accept: 'application/vnd.github.sha', 'User-Agent': USER_AGENT, 'X-GitHub-Api-Version': '2022-11-28' },
      timeoutMs, signal);
    if (response.status !== 200) return null;
    const text = String(await response.text()).trim();
    return isCommitSha(text) ? text : null;
  } catch {
    return null;
  }
}

/** Whether an automatic check is due now for this cached state. */
export function checkDue(state, { now = Date.now, intervalMs = CHECK_INTERVAL_MS } = {}) {
  const at = now();
  const retryAt = msOf(state.retryAt);
  if (retryAt && at < retryAt) return false;
  // Rate limited: due again once GitHub's reset time has passed.
  if (state.status === 'rate_limited') return true;
  const attempt = msOf(state.attemptAt);
  // Never checked, or the last attempt lies in the future (the clock moved back): due.
  if (!attempt || attempt > at) return true;
  const wait = state.status === 'error' ? Math.min(RETRY_AFTER_ERROR_MS, intervalMs) : intervalMs;
  return at - attempt >= wait;
}

/**
 * Check now and cache the result. `force` (the user asked) still reuses a result younger than FORCED_CHECK_GAP_MS
 * and honours a rate limit. Resolves the cached state after the check.
 */
export async function runCheck({ paths, currentVersion, fetch: fetchImpl, now = Date.now, force = false,
  intervalMs = CHECK_INTERVAL_MS, signal, timeoutMs, gitSource = null } = {}) {
  const state = readCheckState(paths);
  const at = now();
  if (force) {
    const attempt = msOf(state.attemptAt);
    const retryAt = msOf(state.retryAt);
    if ((attempt && attempt <= at && at - attempt < FORCED_CHECK_GAP_MS) || (retryAt && at < retryAt)) return state;
  } else if (!checkDue(state, { now, intervalMs })) {
    return state;
  }
  const result = await fetchLatestRelease({ fetch: fetchImpl, etag: state.source === 'api' && state.latest ? state.etag : null,
    currentVersion, signal, now, timeoutMs });
  // A check stopped half-way (daemon shutdown) is not an outcome: nothing is recorded.
  if (signal?.aborted) return state;
  const attemptAt = new Date(now()).toISOString();
  const next = { ...state, attemptAt, retryAt: null, error: null };
  if (result.status === 'ok') {
    Object.assign(next, { status: 'ok', checkedAt: attemptAt, latest: result.release, etag: result.etag, source: 'api' });
  } else if (result.status === 'not_modified') {
    next.status = 'ok';
    next.checkedAt = attemptAt;
    // The cached release stands; ask for its commit once more if it is newer and the commit is still unknown.
    if (next.latest && !next.latest.commit && isNewer(next.latest.version, currentVersion)) {
      next.latest = { ...next.latest, commit: await fetchTagCommit({ fetch: fetchImpl, tag: next.latest.tag, signal, timeoutMs }) };
    }
  } else if (result.status === 'not_found' && gitSource) {
    // A private repository (or none published): the clone's own remote, with the user's git credentials.
    try {
      const release = cleanRelease(await gitSource());
      Object.assign(next, release ? { status: 'ok', checkedAt: attemptAt, latest: release, etag: null, source: 'git' }
        : { status: 'not_found', checkedAt: attemptAt, latest: null, etag: null, source: 'git' });
    } catch (error) {
      // A fork or another remote (no github.com/<repo> remote to ask) has no release here: not_found, as the API said.
      // Only a real git failure (network, credentials, timeout) is an error.
      Object.assign(next, error?.code === 'git_remote'
        ? { status: 'not_found', checkedAt: attemptAt, latest: null, etag: null, source: 'git' }
        : { status: 'error', error: 'git_failed' });
    }
  } else if (result.status === 'not_found') {
    Object.assign(next, { status: 'not_found', checkedAt: attemptAt, latest: null, etag: null, source: 'api' });
  } else if (result.status === 'rate_limited') {
    Object.assign(next, { status: 'rate_limited', retryAt: result.retryAt });
  } else {
    Object.assign(next, { status: 'error', error: result.error });
  }
  if (signal?.aborted) return state;
  writeCheckState(paths, next);
  return readCheckState(paths);
}

/**
 * What status, the popup and the agent see: `{ enabled, current, latest, tag, available, notesUrl, checkedAt, status,
 * error, install }`. `status`: never (no check yet), ok, not_found, error, rate_limited. `install`: the last
 * install's record, or null.
 */
export function updateView({ paths, currentVersion, enabled = true, installable = true }) {
  const state = readCheckState(paths);
  const latest = state.latest;
  const available = Boolean(latest && isNewer(latest.version, currentVersion));
  return {
    enabled,
    // False when this package is not a git clone: the popup then says how to update by hand instead of a button.
    installable,
    source: state.source,
    current: currentVersion,
    latest: latest?.version ?? null,
    tag: latest?.tag ?? null,
    available,
    notesUrl: available ? notesUrl(latest.tag) : null,
    checkedAt: state.checkedAt,
    status: state.status ?? 'never',
    error: state.error,
    install: readInstallState(paths),
  };
}

/**
 * The daemon's checker: a first check STARTUP_DELAY_MS after start when one is due, then a look every POLL_MS.
 * Timers are unref'd; `stop()` cancels them and any check in flight. `check({force})` runs one now.
 */
export function createUpdateChecker({ paths, currentVersion, enabled = () => true, fetch: fetchImpl, now = Date.now,
  log = () => {}, startupDelayMs = STARTUP_DELAY_MS, pollMs = POLL_MS, intervalMs = CHECK_INTERVAL_MS, gitSource = null,
  installable = true } = {}) {
  let startTimer = null;
  let pollTimer = null;
  let pending = null;
  let controller = new AbortController();

  function check({ force = false } = {}) {
    if (pending) return pending;
    if (!force && !enabled()) return Promise.resolve(readCheckState(paths));
    const { signal } = controller;
    pending = runCheck({ paths, currentVersion, fetch: fetchImpl, now, force, intervalMs, signal, gitSource })
      .then(state => {
        // Codes and versions only: never a URL with data, a header or a body. A stopped check logs nothing.
        if (!signal.aborted) {
          log('update_check', { status: state.status, error: state.error, source: state.source,
            latest: state.latest?.version ?? null, available: Boolean(state.latest && isNewer(state.latest.version, currentVersion)) });
        }
        return state;
      })
      .catch(error => {
        log('update_check', { status: 'error', error: 'internal', message: String(error?.message ?? error).slice(0, 200) });
        return readCheckState(paths);
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  }

  return {
    start() {
      if (startTimer || pollTimer) return;
      startTimer = setTimeout(() => {
        startTimer = null;
        check();
      }, startupDelayMs);
      startTimer.unref?.();
      pollTimer = setInterval(() => check(), pollMs);
      pollTimer.unref?.();
    },
    stop() {
      clearTimeout(startTimer);
      clearInterval(pollTimer);
      startTimer = null;
      pollTimer = null;
      controller.abort();
      controller = new AbortController();
    },
    check,
    view: () => updateView({ paths, currentVersion, enabled: enabled(), installable }),
    get pending() {
      return pending;
    },
  };
}
