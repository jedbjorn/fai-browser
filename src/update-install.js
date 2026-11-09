// Install a tagged release into this git checkout (docs/REFERENCE.md "Updates"). Runs only from the user's
// `fai-browser update` command or their Update click in the extension popup (the daemon then starts this same command
// in its own process); never on a schedule, never from an agent's MCP call.
//
// Order: refuse unless the checkout is safe to move (a git clone of UPDATE_REPO, no local modifications, on main with
// nothing unpushed or on a detached HEAD, no tab lease active or paused), `git fetch --tags` from that remote, check
// the tag names the commit the release names (GitHub's API, or `git ls-remote` for a private repository) and its
// package.json the release's version, then move:
//   - HEAD already at the release commit: nothing to move (the CLI finishes an interrupted update instead);
//   - on main: fast-forward main to the tag's commit (`git merge --ff-only`); refused when main has commits the tag
//     does not contain;
//   - on a detached HEAD (an earlier update, or a clone of a tag): check out the tag's commit, detached;
//   - on any other branch: refused (switch to main or check the tag out yourself).
// Then, best effort, `npm ci --include=dev --ignore-scripts` when package-lock.json changed and node_modules exists
// (the runtime has no npm dependencies, so a failure is a warning, never a rollback); the refresh steps of the new
// version (`fai-browser update --finish`: browser pairing and already installed user-level skills; never a secret or a
// key); and a daemon restart that must come back with the new version. The restart looks at the leases once more
// right before it stops the daemon: a tab held by then (the daemon refuses new requests and approvals while an update
// runs, so only a race gets there) rolls the update back without stopping the daemon, rather than killing that task.
// A failure after the move rolls the checkout back to the previous commit (main: `git reset --keep`, which refuses to
// touch local changes; detached: checkout), repeats the refresh and, when the daemon was stopped, the restart from
// the old version, and reports `rolled_back`. node_modules is left as it is.
//
// Every git, npm and node call is execFile with an argv array (no shell) and an environment without FAI's secrets
// (src/update-git.js); the only network-derived values that reach an argv are a tag matching parseTag() and a
// 40-hex commit.
import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { PACKAGE_ROOT } from './paths.js';
import { scrubSecrets } from './secrets.js';
import { UPDATE_REPO, claimUpdateLock, isCommitSha, parseTag, parseVersion, releaseUpdateLock, updatePaths, writeInstallState } from './update.js';
import { findVerifiedRemote, gitRunner, remoteMatches, scrubbedEnv, toolEnv } from './update-git.js';

export { gitRunner, remoteMatches } from './update-git.js';

const execFileAsync = promisify(execFile);
const NPM_TIMEOUT_MS = 600_000;
const FINISH_TIMEOUT_MS = 120_000;
const RESTART_TIMEOUT_MS = 20_000;
const LEASED = new Set(['active', 'paused']);

export class UpdateRefused extends Error {
  /** `code` names the rule; `hint` says what to do instead. */
  constructor(code, message, hint) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

export class UpdateFailed extends Error {
  /** `moved`: the checkout had moved to the release (then `rolledBack` says whether it is back). */
  constructor(step, message, { moved = false, rolledBack = false, rollbackError = null, commit = null, previous = null } = {}) {
    super(message);
    this.code = 'update_failed';
    this.step = step;
    this.moved = moved;
    this.commit = commit;
    this.previous = previous;
    this.rolledBack = rolledBack;
    this.rollbackError = rollbackError;
  }
}

async function gitOk(git, args) {
  try {
    await git(args);
    return true;
  } catch {
    return false;
  }
}

async function gitOrNull(git, args) {
  try {
    return await git(args);
  } catch {
    return null;
  }
}

function samePath(a, b) {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/**
 * The checks before anything moves. Resolves `{ remote, branch, head, upstream }`; throws UpdateRefused with code
 * not_git, wrong_remote, dirty, other_branch or unpushed.
 */
export async function preflight({ root, git, remoteOk = url => remoteMatches(url) }) {
  const top = await gitOrNull(git, ['rev-parse', '--show-toplevel']);
  if (!top || !samePath(top, root)) {
    throw new UpdateRefused('not_git', `${root} is not a git clone, so it cannot update itself.`,
      'Update the way you installed it (npm install -g fai-browser@latest, or a fresh git clone).');
  }
  const branch = await gitOrNull(git, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const remote = await findVerifiedRemote({ git, branch, remoteOk });
  if (!remote) {
    throw new UpdateRefused('wrong_remote', `No git remote of this checkout is github.com/${UPDATE_REPO}.`,
      `Update by hand from the remote you use (git fetch --tags, then check out the release tag), or add github.com/${UPDATE_REPO} as origin.`);
  }
  const changes = await git(['status', '--porcelain', '--untracked-files=no']);
  if (changes) {
    throw new UpdateRefused('dirty', 'The checkout has local modifications; the updater never stashes, resets or discards them.',
      'Commit or stash your changes yourself (git status shows them), then update again.');
  }
  if (branch && branch !== 'main') {
    throw new UpdateRefused('other_branch', `The checkout is on branch ${branch}; the updater moves only main or a detached release checkout.`,
      'Switch to main (git switch main) and update again, or check out the release tag yourself.');
  }
  const head = await git(['rev-parse', 'HEAD']);
  const upstream = branch ? await upstreamOf(git, branch, remote) : null;
  if (upstream) await refuseUnpushed(git, upstream);
  return { remote, branch, head, upstream };
}

async function upstreamOf(git, branch, remote) {
  const configured = await gitOrNull(git, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branch}@{upstream}`]);
  if (configured) return configured;
  const fallback = `${remote}/${branch}`;
  return (await gitOk(git, ['rev-parse', '--verify', '--quiet', `refs/remotes/${fallback}`])) ? fallback : null;
}

async function refuseUnpushed(git, upstream) {
  const ahead = Number(await gitOrNull(git, ['rev-list', '--count', `${upstream}..HEAD`]));
  if (ahead > 0) {
    throw new UpdateRefused('unpushed', `main has ${ahead} commit(s) that are not on ${upstream}.`,
      'Push or move them to another branch yourself, then update again.');
  }
}

/** Refuse while a tab lease is active or paused (`requests` is the daemon status's live request list). */
export function refuseLeases(requests) {
  const leased = (Array.isArray(requests) ? requests : []).filter(view => LEASED.has(view?.state));
  if (leased.length) {
    throw new UpdateRefused('lease_active', `An agent holds a browser tab (${leased.map(view => view.requestId).join(', ')}).`,
      'Let the task finish, or press Stop in the FAI Browser popup, then update again.');
  }
}

/**
 * Fetch the tags and check the release: the tag exists, names `target.commit` (when known) and its package.json says
 * `target.version`. Resolves the commit.
 */
export async function verifyTarget({ git, remote, target }) {
  const parsed = parseTag(target?.tag);
  if (!parsed || parsed.version !== target.version) {
    throw new UpdateRefused('bad_release', 'The release tag is not a plain vX.Y.Z release.', 'Nothing to do.');
  }
  try {
    await git(['fetch', '--quiet', '--tags', remote]);
  } catch (error) {
    throw new UpdateRefused('fetch_failed', `git fetch --tags ${remote} failed: ${firstLine(error)}`,
      'Check your network and git access to GitHub (git fetch --tags), then update again.');
  }
  const commit = await gitOrNull(git, ['rev-parse', '--verify', '--quiet', `refs/tags/${parsed.tag}^{commit}`]);
  if (!isCommitSha(commit)) {
    throw new UpdateRefused('tag_missing', `The release tag ${parsed.tag} is not on ${remote}.`, 'Try again later.');
  }
  if (target.commit && commit !== target.commit) {
    throw new UpdateRefused('tag_mismatch', `Tag ${parsed.tag} names commit ${commit.slice(0, 12)}, but the release names ${target.commit.slice(0, 12)}.`,
      'Do not update; check the tag (git show-ref --tags) and report it.');
  }
  let manifest = null;
  try {
    manifest = JSON.parse(await git(['show', `${commit}:package.json`]));
  } catch {
    // Checked below.
  }
  if (manifest?.version !== parsed.version) {
    throw new UpdateRefused('tag_mismatch', `Tag ${parsed.tag} does not carry version ${parsed.version} in package.json.`,
      'Do not update; report the release.');
  }
  return commit;
}

/** The first line of a git or npm error, without credentials a remote URL may carry (it goes to the log and status). */
export function firstLine(error) {
  const text = String(error?.stderr || error?.message || error).trim().split('\n').find(Boolean) ?? 'error';
  return scrubSecrets(text.replace(/\/\/[^/@\s]+@/g, '//[redacted]@')).slice(0, 200);
}

/** `npm` next to the running node, else on PATH. */
export function npmCommand(execPath = process.execPath) {
  const sibling = join(dirname(execPath), process.platform === 'win32' ? 'npm.cmd' : 'npm');
  return existsSync(sibling) ? sibling : 'npm';
}

/**
 * Default step implementations (each replaceable in tests). npm gets toolEnv(), `update --finish` and the restarted
 * daemon scrubbedEnv(): no FAI secret reaches any of them (`steps.env` shows both, for tests).
 */
export function defaultSteps({ root = PACKAGE_ROOT, env = process.env, home, execPath = process.execPath } = {}) {
  const child = scrubbedEnv(env);
  const tool = toolEnv(env);
  return {
    env: { child, tool },
    async npmCi() {
      await execFileAsync(npmCommand(execPath), ['ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
        { cwd: root, env: tool, timeout: NPM_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
    },
    // The refresh steps of the version now on disk, in a fresh process, so the new code does them.
    async finish() {
      const { stdout } = await execFileAsync(execPath, [join(root, 'src', 'cli.js'), 'update', '--finish'],
        { cwd: root, env: child, timeout: FINISH_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
      return stdout.trim().split('\n').at(-1) ?? '';
    },
    async restart(version) {
      return restartDaemon({ home, env: child, version });
    },
  };
}

/** The restart found a tab lease held: nothing was stopped. */
export class LeaseHeld extends UpdateRefused {
  constructor(requests) {
    super('lease_active', `A browser tab was approved while the update ran (${requests.map(view => view.requestId).join(', ')}).`,
      'The update was undone so that task keeps running; update again when it is done.');
    this.daemonUntouched = true;
  }
}

/**
 * Stop the running daemon (if any) and start the one on disk; resolves its health and fails unless it reports
 * `version` (null: any). Right before the stop it reads the leases again and throws LeaseHeld (stopping nothing)
 * when a tab is active or paused.
 */
export async function restartDaemon({ home, env = process.env, version, timeoutMs = RESTART_TIMEOUT_MS } = {}) {
  const { FaiBrowserClient, ensureDaemon } = await import('./client.js');
  let client = null;
  try {
    client = await FaiBrowserClient.connect({ home, env, autoStart: false, clientName: 'update' });
  } catch {
    // Not running.
  }
  // `daemonStopped` on any error says whether a shutdown was sent: a rollback restarts the old daemon only then.
  let stopped = false;
  try {
    if (client) {
      const status = await client.status();
      const leased = (status?.requests ?? []).filter(view => LEASED.has(view?.state));
      if (leased.length) throw new LeaseHeld(leased);
      stopped = true;
      await client.shutdown().catch(() => {});
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try {
          await client.health();
        } catch {
          break;
        }
        await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
      }
    }
    const daemon = await ensureDaemon({ home, env, autoStart: true, version: version ?? undefined, startTimeoutMs: timeoutMs });
    if (version && daemon.health?.version !== version) {
      throw new Error(`the FAI service came back as version ${daemon.health?.version ?? 'unknown'}, not ${version}`);
    }
    return daemon.health;
  } catch (error) {
    if (error && typeof error === 'object') error.daemonStopped = stopped;
    throw error;
  }
}

/** Append one JSON line to logs/update.log (steps, versions, codes; never output of git or npm beyond a first line). */
export function updateLogger(paths) {
  const file = updatePaths(paths).log;
  return async (event, fields = {}) => {
    try {
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      await appendFile(file, `${JSON.stringify({ t: new Date().toISOString(), event, ...fields })}\n`, { mode: 0o600 });
    } catch {
      // Logging is best effort.
    }
  };
}

/**
 * Take update.lock (exclusive, with this pid); a lock the daemon wrote for this very process (its pid) is adopted.
 * Throws UpdateRefused `update_running` when another live process holds it.
 */
export async function takeUpdateLock(paths, pid = process.pid) {
  // release() removes the lock only while it still names this pid (never another updater's).
  if (claimUpdateLock(paths, pid)) return async () => releaseUpdateLock(paths, pid);
  throw new UpdateRefused('update_running', 'Another update is already running.', 'Wait for it to finish (node src/cli.js status shows it).');
}

/**
 * Install `target` ({tag, version, commit}) into the checkout at `root`. Resolves
 * `{ state: 'succeeded', from, to, moved: 'fast_forward'|'checkout'|'none', previous, commit, npm, finish, daemon,
 * warnings }`; throws UpdateRefused before anything moved, or UpdateFailed (with `moved`, `rolledBack`).
 * `steps` = { npmCi, finish, restart(version) }; `paths` (optional) receives the install record for the popup.
 */
export async function installUpdate({ root = PACKAGE_ROOT, target, currentVersion, git, steps,
  remoteOk, requests = [], log = async () => {}, paths = null, env = process.env }) {
  git ??= gitRunner({ cwd: root, env });
  steps ??= defaultSteps({ root, env });
  // From the move on, every record names the verified release commit and the commit before it: an interrupted update
  // is resumed only when HEAD is that very commit (src/update-cli.js).
  let moveInfo = {};
  const record = fields => {
    if (paths) writeInstallState(paths, { pid: process.pid, from: currentVersion, to: target?.version ?? null, ...moveInfo, ...fields });
  };
  refuseLeases(requests);
  if (!parseVersion(currentVersion)) throw new UpdateRefused('bad_version', 'This checkout has no valid version.', 'Run git status.');
  let where;
  let commit;
  try {
    where = await preflight({ root, git, remoteOk });
    await log('update_preflight', { branch: where.branch ?? 'detached', remote: where.remote, from: currentVersion, to: target?.version });
    commit = await verifyTarget({ git, remote: where.remote, target });
    // After the fetch: main must still be pushed, and HEAD must be inside the release (nothing of the user's left behind).
    if (where.upstream) await refuseUnpushed(git, where.upstream);
  } catch (error) {
    if (error instanceof UpdateRefused) throw error;
    throw new UpdateFailed('check', firstLine(error));
  }
  const base = { from: currentVersion, to: target.version, tag: target.tag, previous: where.head, commit, warnings: [] };
  if (where.head === commit) {
    await log('update_already_current', { commit });
    return { state: 'succeeded', moved: 'none', npm: 'skipped', finish: null, daemon: null, ...base };
  }
  if (!(await gitOk(git, ['merge-base', '--is-ancestor', where.head, commit]))) {
    throw new UpdateRefused('not_fast_forward', `The checkout has commits that ${target.tag} does not contain.`,
      `Check the release out yourself (git checkout ${target.tag}) or keep your version.`);
  }
  const previous = where.head;
  const lockChanged = !(await gitOk(git, ['diff', '--quiet', previous, commit, '--', 'package-lock.json']));
  const runNpm = lockChanged && existsSync(join(root, 'node_modules'));
  const moved = where.branch ? 'fast_forward' : 'checkout';
  moveInfo = { commit, previous };
  record({ state: 'running', step: 'move', message: `Installing ${target.version}.` });
  await log('update_move', { moved, previous, commit });
  try {
    if (where.branch) await git(['merge', '--ff-only', '--quiet', commit]);
    else await git(['checkout', '--quiet', '--detach', commit]);
  } catch (error) {
    // Nothing moved (git refuses atomically, e.g. an untracked file in the way).
    throw new UpdateRefused('move_failed', `git could not move to ${target.tag}: ${firstLine(error)}`,
      'Check git status for files in the way, then update again.');
  }
  const outcome = { npm: runNpm ? 'ran' : 'skipped', finish: null, daemon: null };
  if (runNpm) {
    // Best effort: the runtime has no npm dependencies; the dev tools can be installed again by hand.
    record({ state: 'running', step: 'npm', message: `Installing ${target.version}: npm ci.` });
    try {
      await steps.npmCi();
    } catch (error) {
      outcome.npm = 'failed';
      base.warnings.push(`npm_failed: ${firstLine(error)}; run npm ci in the fai-browser folder for the development tools`);
      await log('update_npm_failed', { message: firstLine(error) });
    }
  }
  let step = 'finish';
  try {
    record({ state: 'running', step: 'finish', message: `Installing ${target.version}: refreshing pairing and skills.` });
    outcome.finish = await steps.finish();
    step = 'restart';
    record({ state: 'running', step: 'restart', message: `Installing ${target.version}: restarting the FAI service.` });
    outcome.daemon = await steps.restart(target.version);
  } catch (error) {
    await log('update_step_failed', { step, message: firstLine(error) });
    // The old daemon is started again only when this update stopped it: after a refresh failure, or a restart that
    // refused before its shutdown (a tab held), the old daemon still runs.
    const restartOld = step === 'restart' && error?.daemonStopped !== false && !error?.daemonUntouched;
    const rollbackError = await rollback({ git, branch: where.branch, previous, commit, steps, currentVersion, log, restartOld });
    throw new UpdateFailed(step, `${step} failed: ${firstLine(error)}`, { moved: true, rolledBack: !rollbackError, rollbackError,
      commit, previous });
  }
  await log('update_done', { from: currentVersion, to: target.version, commit, npm: outcome.npm });
  return { state: 'succeeded', moved, ...outcome, ...base };
}

/** Back to `previous`; resolves null when the old version runs again, else the error text. node_modules stays. */
async function rollback({ git, branch, previous, commit, steps, currentVersion, log, restartOld }) {
  try {
    if (branch) {
      // Only our own fast-forward is undone: main must still be at the release commit, and --keep refuses to touch a
      // file with local changes.
      const head = await git(['rev-parse', 'HEAD']);
      if (head !== commit) throw new Error(`main moved to ${head.slice(0, 12)} during the update; not touching it`);
      await git(['reset', '--quiet', '--keep', previous]);
    } else {
      await git(['checkout', '--quiet', '--detach', previous]);
    }
    // An older version may not have `update --finish`; its own files were left as they were.
    await steps.finish().catch(() => null);
    // A daemon that was never stopped still runs the old version.
    if (restartOld) await steps.restart(currentVersion);
    await log('update_rolled_back', { previous, restarted: restartOld });
    return null;
  } catch (error) {
    const text = firstLine(error);
    await log('update_rollback_failed', { message: text });
    return text;
  }
}
