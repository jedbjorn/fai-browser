// Install a tagged release into this git checkout (docs/REFERENCE.md "Updates"). Runs only from the user's
// `fai-browser update` command or their Update click in the extension popup (the daemon then starts this same command
// in its own process); never on a schedule, never from an agent's MCP call.
//
// Order: refuse unless the checkout is safe to move (a git clone of UPDATE_REPO, no local modifications, on main with
// nothing unpushed or on a detached HEAD, no tab lease active or paused), `git fetch --tags` from that remote, check
// the tag names the commit GitHub's release names and its package.json the release's version, then move:
//   - on main: fast-forward main to the tag's commit (`git merge --ff-only`); refused when main has commits the tag
//     does not contain;
//   - on a detached HEAD (an earlier update, or a clone of a tag): check out the tag's commit, detached;
//   - on any other branch: refused (switch to main or check the tag out yourself).
// Then `npm ci --ignore-scripts` when package-lock.json changed and node_modules exists, the refresh steps of the
// new version (`fai-browser update --finish`: browser pairing and already installed user-level skills; never a secret
// or a key), and a daemon restart that must come back with the new version. A failure after the move rolls the
// checkout back to the previous commit (main: `git reset --keep`, which refuses to touch local changes; detached:
// checkout), repeats the refresh and restart from the old version, and reports `rolled_back`.
//
// Every git, npm and node call is execFile with an argv array (no shell); the only network-derived values that reach
// an argv are a tag matching parseTag() and a 40-hex commit.
import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { appendFile, mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { PACKAGE_ROOT } from './paths.js';
import { UPDATE_REPO, clearStaleLock, isCommitSha, parseTag, parseVersion, updatePaths, writeInstallState } from './update.js';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 120_000;
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
  constructor(step, message, { rolledBack = false, rollbackError = null } = {}) {
    super(message);
    this.code = 'update_failed';
    this.step = step;
    this.rolledBack = rolledBack;
    this.rollbackError = rollbackError;
  }
}

/** True for an https, ssh or scp-style URL of github.com/<repo> (case-insensitive, optional .git and slash). */
export function remoteMatches(url, repo = UPDATE_REPO) {
  if (typeof url !== 'string') return false;
  const escaped = repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const forms = [
    `https://(?:[^@/]+@)?github\\.com/${escaped}`,
    `ssh://git@github\\.com(?::22)?/${escaped}`,
    `git@github\\.com:${escaped}`,
  ];
  return new RegExp(`^(?:${forms.join('|')})(?:\\.git)?/?$`, 'i').test(url.trim());
}

/**
 * A git runner for `cwd`: `git(args)` resolves trimmed stdout, rejects with the git error. Never prompts: no terminal
 * prompt, no askpass, ssh in batch mode (unless the user set GIT_SSH_COMMAND).
 */
export function gitRunner({ cwd, env = process.env, timeoutMs = GIT_TIMEOUT_MS } = {}) {
  const gitEnv = { ...env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '', LC_ALL: 'C', LANG: 'C' };
  if (!env.GIT_SSH_COMMAND) gitEnv.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes';
  return async (args, options = {}) => {
    const { stdout } = await execFileAsync('git', args, { cwd, env: gitEnv, timeout: options.timeoutMs ?? timeoutMs,
      maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    return stdout.trim();
  };
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
  const remotes = (await gitOrNull(git, ['remote']))?.split('\n').filter(Boolean) ?? [];
  const tracked = branch ? await gitOrNull(git, ['config', '--get', `branch.${branch}.remote`]) : null;
  const ordered = [...new Set([tracked, 'origin', ...remotes].filter(name => name && remotes.includes(name)))];
  let remote = null;
  for (const name of ordered) {
    if (remoteOk(await gitOrNull(git, ['remote', 'get-url', name]))) {
      remote = name;
      break;
    }
  }
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

function firstLine(error) {
  const text = String(error?.stderr || error?.message || error).trim().split('\n').find(Boolean) ?? 'error';
  return text.slice(0, 200);
}

/** `npm` next to the running node, else on PATH. */
export function npmCommand(execPath = process.execPath) {
  const sibling = join(dirname(execPath), process.platform === 'win32' ? 'npm.cmd' : 'npm');
  return existsSync(sibling) ? sibling : 'npm';
}

/** Default step implementations (each replaceable in tests). */
export function defaultSteps({ root = PACKAGE_ROOT, env = process.env, home, execPath = process.execPath } = {}) {
  return {
    async npmCi() {
      await execFileAsync(npmCommand(execPath), ['ci', '--ignore-scripts', '--no-audit', '--no-fund'],
        { cwd: root, env, timeout: NPM_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
    },
    // The refresh steps of the version now on disk, in a fresh process, so the new code does them.
    async finish() {
      const { stdout } = await execFileAsync(execPath, [join(root, 'src', 'cli.js'), 'update', '--finish'],
        { cwd: root, env, timeout: FINISH_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
      return stdout.trim().split('\n').at(-1) ?? '';
    },
    async restart(version) {
      return restartDaemon({ home, env, version });
    },
  };
}

/**
 * Stop the running daemon (if any) and start the one on disk; resolves its health and fails unless it reports
 * `version` (null: any).
 */
export async function restartDaemon({ home, env = process.env, version, timeoutMs = RESTART_TIMEOUT_MS } = {}) {
  const { FaiBrowserClient, ensureDaemon } = await import('./client.js');
  try {
    const client = await FaiBrowserClient.connect({ home, env, autoStart: false, clientName: 'update' });
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
  } catch {
    // Not running.
  }
  const daemon = await ensureDaemon({ home, env, autoStart: true, version: version ?? undefined, startTimeoutMs: timeoutMs });
  if (version && daemon.health?.version !== version) {
    throw new Error(`the FAI service came back as version ${daemon.health?.version ?? 'unknown'}, not ${version}`);
  }
  return daemon.health;
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

/** Take update.lock (exclusive, with this pid); throws UpdateRefused `update_running` when a live process holds it. */
export async function takeUpdateLock(paths, pid = process.pid) {
  const { lock } = updatePaths(paths);
  await mkdir(dirname(lock), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(lock, JSON.stringify({ pid, startedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
      return async () => unlink(lock).catch(() => {});
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (!clearStaleLock(paths)) break;
    }
  }
  throw new UpdateRefused('update_running', 'Another update is already running.', 'Wait for it to finish (node src/cli.js status shows it).');
}

/**
 * Install `target` ({tag, version, commit}) into the checkout at `root`. Resolves
 * `{ state: 'succeeded', from, to, moved: 'fast_forward'|'checkout', previous, commit, npm, finish, daemon }`;
 * throws UpdateRefused before anything moved, or UpdateFailed (rolledBack true/false) after.
 * `steps` = { npmCi, finish, restart(version) }; `paths` (optional) receives the install record for the popup.
 */
export async function installUpdate({ root = PACKAGE_ROOT, target, currentVersion, git = gitRunner({ cwd: root }),
  steps = defaultSteps({ root }), remoteOk, requests = [], log = async () => {}, paths = null }) {
  const record = fields => {
    if (paths) writeInstallState(paths, { pid: process.pid, from: currentVersion, to: target?.version ?? null, ...fields });
  };
  refuseLeases(requests);
  if (!parseVersion(currentVersion)) throw new UpdateRefused('bad_version', 'This checkout has no valid version.', 'Run git status.');
  const where = await preflight({ root, git, remoteOk });
  await log('update_preflight', { branch: where.branch ?? 'detached', remote: where.remote, from: currentVersion, to: target?.version });
  const commit = await verifyTarget({ git, remote: where.remote, target });
  // After the fetch: main must still be pushed, and HEAD must be inside the release (nothing of the user's left behind).
  if (where.upstream) await refuseUnpushed(git, where.upstream);
  if (!(await gitOk(git, ['merge-base', '--is-ancestor', where.head, commit]))) {
    throw new UpdateRefused('not_fast_forward', `The checkout has commits that ${target.tag} does not contain.`,
      `Check the release out yourself (git checkout ${target.tag}) or keep your version.`);
  }
  const previous = where.head;
  const lockChanged = !(await gitOk(git, ['diff', '--quiet', previous, commit, '--', 'package-lock.json']));
  const runNpm = lockChanged && existsSync(join(root, 'node_modules'));
  const moved = where.branch ? 'fast_forward' : 'checkout';
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
  let step = 'npm';
  const outcome = { npm: runNpm ? 'ran' : 'skipped', finish: null, daemon: null };
  try {
    if (runNpm) {
      record({ state: 'running', step: 'npm', message: `Installing ${target.version}: npm ci.` });
      await steps.npmCi();
    }
    step = 'finish';
    record({ state: 'running', step: 'finish', message: `Installing ${target.version}: refreshing pairing and skills.` });
    outcome.finish = await steps.finish();
    step = 'restart';
    record({ state: 'running', step: 'restart', message: `Installing ${target.version}: restarting the FAI service.` });
    outcome.daemon = await steps.restart(target.version);
  } catch (error) {
    await log('update_step_failed', { step, message: firstLine(error) });
    const rollbackError = await rollback({ git, branch: where.branch, previous, commit, runNpm, steps, currentVersion, log });
    const message = `${step} failed: ${firstLine(error)}`;
    throw new UpdateFailed(step, message, { rolledBack: !rollbackError, rollbackError });
  }
  await log('update_done', { from: currentVersion, to: target.version, commit });
  return { state: 'succeeded', from: currentVersion, to: target.version, tag: target.tag, moved, previous, commit, ...outcome };
}

/** Back to `previous`; resolves null when the old version runs again, else the error text. */
async function rollback({ git, branch, previous, commit, runNpm, steps, currentVersion, log }) {
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
    if (runNpm) await steps.npmCi();
    // An older version may not have `update --finish`; its own files were left as they were.
    await steps.finish().catch(() => null);
    await steps.restart(currentVersion);
    await log('update_rolled_back', { previous });
    return null;
  } catch (error) {
    const text = firstLine(error);
    await log('update_rollback_failed', { message: text });
    return text;
  }
}
