// The updater's review fixes: no FAI secret in any child, ssh batch mode only without the user's own ssh command,
// the git ls-remote fallback after an API 404, best-effort npm, rollbacks (detached, lease approved during
// the update), move_failed, errors before the move, early-exit records, finishing an interrupted update, the 403 and
// retry rules, the commit lookup, a stopped check, and `update --finish`. Local git repos only; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { homePaths } from '../src/home.js';
import { RELEASES_API, UPDATE_REPO, checkDue, createUpdateChecker, readInstallState, runCheck, updatePaths, updateView,
  writeInstallState } from '../src/update.js';
import { LeaseHeld, UpdateRefused, defaultSteps, gitRunner, installUpdate } from '../src/update-install.js';
import { gitReleaseSource, lsRemoteLatest } from '../src/update-git.js';
import { finishInstall, updateCommand } from '../src/update-cli.js';
import { SH_SHIMS } from './helpers/platform.js';

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const SHA5 = 'a'.repeat(40);
const GIT = (() => {
  try {
    return execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim() || '/usr/bin/git';
  } catch {
    return '/usr/bin/git';
  }
})();

function mockFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  fn.calls = calls;
  return fn;
}

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const release = (tag, extra = {}) => ({ tag_name: tag, draft: false, prerelease: false, target_commitish: 'main',
  published_at: '2026-11-20T10:00:00Z', ...extra });
const releases = (body, { commit = SHA5 } = {}) => mockFetch(url => (url === RELEASES_API
  ? json(200, body, { etag: '"e1"' }) : new Response(commit, { status: 200 })));

function clock(start = Date.parse('2026-11-21T08:00:00Z')) {
  let at = start;
  const now = () => at;
  now.advance = ms => {
    at += ms;
  };
  return now;
}

async function stateHome(t) {
  const home = await mkdtemp(join(tmpdir(), 'fai-update-hard-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return homePaths({ home, env: { FAI_HOME: home } });
}

function gitEnv(home) {
  return { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
}

/** A bare "GitHub" repo with v0.4.0, a clone at v0.4.0 on main, then v0.5.0 pushed (annotated tags). */
async function repos(t, { lockChange = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'fai-update-hard-git-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = gitEnv(dir);
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
  const remote = join(dir, 'remote.git');
  const source = join(dir, 'source');
  const checkout = join(dir, 'checkout');
  git(dir, 'init', '-q', '--bare', '-b', 'main', remote);
  git(dir, 'init', '-q', '-b', 'main', source);
  const commitVersion = async (version, lock) => {
    await writeFile(join(source, 'package.json'), `${JSON.stringify({ name: 'fai-browser', version })}\n`);
    await writeFile(join(source, 'package-lock.json'), `${JSON.stringify({ lock })}\n`);
    git(source, 'add', '-A');
    git(source, 'commit', '-q', '-m', `Release ${version}`);
    git(source, 'tag', '-a', `v${version}`, '-m', `v${version}`);
  };
  await commitVersion('0.4.0', 1);
  git(source, 'remote', 'add', 'origin', remote);
  git(source, 'push', '-q', 'origin', 'main', '--tags');
  git(dir, 'clone', '-q', remote, checkout);
  await commitVersion('0.5.0', lockChange ? 2 : 1);
  git(source, 'push', '-q', 'origin', 'main', '--tags');
  const v4 = git(source, 'rev-parse', 'v0.4.0^{commit}');
  const v5 = git(source, 'rev-parse', 'v0.5.0^{commit}');
  return { dir, env, git, remote, source, checkout, v4, v5, run: gitRunner({ cwd: checkout, env }),
    remoteOk: url => url === remote, target: { tag: 'v0.5.0', version: '0.5.0', commit: v5 } };
}

function fakeSteps({ failAt = null } = {}) {
  const calls = [];
  return {
    calls,
    async npmCi() {
      calls.push('npm');
      if (failAt === 'npm') throw new Error('npm ERR! network');
    },
    async finish() {
      calls.push('finish');
      return '{"state":"finished"}';
    },
    async restart(version) {
      calls.push(`restart:${version}`);
      if (failAt === 'restart' && version === '0.5.0') throw new Error('the FAI service did not come back');
      return { version };
    },
  };
}

const install = (r, extra = {}) => installUpdate({ root: r.checkout, target: r.target, currentVersion: '0.4.0', git: r.run,
  remoteOk: r.remoteOk, steps: fakeSteps(), ...extra });

async function refused(promise, code) {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof UpdateRefused, `${error?.name}: ${error?.message}`);
    assert.equal(error.code, code, error.message);
    return true;
  });
}

async function faiHome(r) {
  const home = join(r.dir, 'fai-home');
  await mkdir(home, { recursive: true });
  const env = { ...r.env, FAI_HOME: home };
  delete env.FAI_DAEMON_DIR;
  return { home, env, paths: homePaths({ home, env }) };
}

// --- M1: secrets ---------------------------------------------------------------------------------------------------

const SECRETS = { TYPESAFE_API_KEY: 'fake-jev-key-not-real', FAI_BRIDGE_SECRET: 'fake-pairing-secret-not-real-0000',
  FAI_CLIENT_TOKEN: 'f'.repeat(64), GITHUB_TOKEN: 'fake-gh-token-not-real' };

function assertNoSecrets(env, where) {
  for (const name of [...Object.keys(SECRETS), 'GIT_DIR', 'GIT_WORK_TREE']) assert.equal(env[name], undefined, `${where}: ${name}`);
  const text = JSON.stringify(env);
  for (const value of Object.values(SECRETS)) assert.ok(!text.includes(value), `${where}: a secret value`);
}

async function dumpedEnv(path) {
  const text = await readFile(path, 'utf8');
  return Object.fromEntries(text.split('\n').filter(line => line.includes('='))
    .map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
}

test('M1: no FAI secret reaches git, npm, update --finish or the restarted daemon', { skip: SH_SHIMS }, async t => {
  const r = await repos(t);
  const bin = join(r.dir, 'bin');
  await mkdir(bin);
  // A fake node and npm (npm is looked up next to node), and a git wrapper, that record their environment.
  for (const name of ['node', 'npm']) {
    await writeFile(join(bin, name), `#!/bin/sh\nenv > '${join(r.dir, `${name}.env`)}'\necho '{"state":"finished"}'\n`, { mode: 0o755 });
  }
  await writeFile(join(bin, 'git'), `#!/bin/sh\nenv > '${join(r.dir, 'git.env')}'\nexec '${GIT}' "$@"\n`, { mode: 0o755 });
  const env = { ...r.env, ...SECRETS, GIT_DIR: '/nonexistent/.git', GIT_WORK_TREE: '/nonexistent', PATH: `${bin}:${process.env.PATH}` };
  const steps = defaultSteps({ root: r.checkout, env, execPath: join(bin, 'node') });
  assertNoSecrets(steps.env.child, 'updater children and the restarted daemon');
  assertNoSecrets(steps.env.tool, 'git and npm');
  assert.equal(steps.env.child.FAI_HOME, env.FAI_HOME, 'the updater keeps its directories');
  await steps.npmCi();
  await steps.finish();
  assertNoSecrets(await dumpedEnv(join(r.dir, 'npm.env')), 'npm');
  assertNoSecrets(await dumpedEnv(join(r.dir, 'node.env')), 'update --finish');
  const git = gitRunner({ cwd: r.checkout, env });
  assert.equal(await git(['rev-parse', 'HEAD']), r.v4, 'a GIT_DIR from the environment is not followed');
  assertNoSecrets(await dumpedEnv(join(r.dir, 'git.env')), 'git');
});

// --- S1: ssh -------------------------------------------------------------------------------------------------------

test('S1: ssh batch mode only when the user configured no ssh command for git', async t => {
  const r = await repos(t);
  assert.equal((await gitRunner({ cwd: r.checkout, env: r.env }).env()).GIT_SSH_COMMAND, 'ssh -o BatchMode=yes');
  r.git(r.checkout, 'config', 'core.sshCommand', 'ssh -i ~/.ssh/work_key');
  assert.equal((await gitRunner({ cwd: r.checkout, env: r.env }).env()).GIT_SSH_COMMAND, undefined, 'core.sshCommand stands');
  assert.equal((await gitRunner({ cwd: r.checkout, env: { ...r.env, GIT_SSH_COMMAND: 'my-ssh' } }).env()).GIT_SSH_COMMAND, 'my-ssh');
  assert.equal((await gitRunner({ cwd: r.checkout, env: r.env }).env()).GIT_TERMINAL_PROMPT, '0');
});

// --- API 404: git ls-remote fallback --------------------------------------------------------------------------------

test('API 404 fallback: git ls-remote finds the highest plain tag with its peeled commit, on the verified remote only', async t => {
  const r = await repos(t);
  r.git(r.source, 'tag', 'v0.10.0-rc.1');
  r.git(r.source, 'tag', 'nightly');
  r.git(r.source, 'tag', 'v0.4.9', 'v0.4.0^{commit}');
  r.git(r.source, 'push', '-q', 'origin', '--tags');
  assert.deepEqual(await lsRemoteLatest({ git: r.run, remote: 'origin' }), { tag: 'v0.5.0', version: '0.5.0', commit: r.v5 },
    'an annotated tag gives its peeled commit');
  assert.notEqual(r.git(r.source, 'rev-parse', 'v0.5.0'), r.v5, 'the tag object differs from the commit');
  r.git(r.source, 'tag', 'v0.10.0', 'v0.5.0^{commit}');
  r.git(r.source, 'push', '-q', 'origin', 'v0.10.0');
  assert.deepEqual(await gitReleaseSource({ root: r.checkout, env: r.env, remoteOk: r.remoteOk })(),
    { tag: 'v0.10.0', version: '0.10.0', commit: r.v5 }, 'numeric order; a lightweight tag');
  await assert.rejects(gitReleaseSource({ root: r.checkout, env: r.env })(), error => error.code === 'git_remote',
    'a remote that is not github.com/<repo> is never asked');
});

test('API 404 fallback: a 404 falls back to git, records source git, and the install checks that commit', async t => {
  const r = await repos(t);
  const { home, env, paths } = await faiHome(r);
  const fetch = mockFetch(() => json(404, { message: 'Not Found' }));
  const options = { home, env, fetch, root: r.checkout, git: r.run, remoteOk: r.remoteOk, steps: fakeSteps(), requests: [],
    gitSource: gitReleaseSource({ root: r.checkout, env: r.env, remoteOk: r.remoteOk }) };
  const check = await updateCommand({ check: true }, options);
  assert.equal(check.value.update.source, 'git');
  assert.equal(check.value.update.latest, '0.5.0');
  assert.equal(check.value.update.notesUrl, `https://github.com/${UPDATE_REPO}/releases/tag/v0.5.0`);
  assert.equal(fetch.calls.length, 1, 'the API is asked once, then git');
  const done = await updateCommand({}, options);
  assert.equal(done.value.state, 'succeeded', JSON.stringify(done.value));
  assert.equal(r.git(r.checkout, 'rev-parse', 'HEAD'), r.v5);
  assert.equal(readInstallState(paths).state, 'succeeded');
  const other = await stateHome(t);
  const failing = await runCheck({ paths: other, currentVersion: '0.4.0', fetch, now: clock(),
    gitSource: async () => { throw new Error('Permission denied (publickey)'); } });
  assert.equal(failing.status, 'error');
  assert.equal(failing.error, 'git_failed');
});

// --- install outcomes ------------------------------------------------------------------------------------------------

test('S2: npm failure after the move is a warning, never a rollback; a rollback runs no npm', async t => {
  const r = await repos(t, { lockChange: true });
  await mkdir(join(r.checkout, 'node_modules'));
  const steps = fakeSteps({ failAt: 'npm' });
  const result = await install(r, { steps });
  assert.equal(result.state, 'succeeded');
  assert.equal(result.npm, 'failed');
  assert.match(result.warnings[0], /^npm_failed: npm ERR! network/);
  assert.deepEqual(steps.calls, ['npm', 'finish', 'restart:0.5.0']);
  assert.equal(r.git(r.checkout, 'rev-parse', 'HEAD'), r.v5);

  const back = await repos(t, { lockChange: true });
  await mkdir(join(back.checkout, 'node_modules'));
  await writeFile(join(back.checkout, 'node_modules', 'keep.txt'), 'kept\n');
  const failing = fakeSteps({ failAt: 'restart' });
  await assert.rejects(install(back, { steps: failing }), error => error.rolledBack === true && error.moved === true);
  assert.deepEqual(failing.calls, ['npm', 'finish', 'restart:0.5.0', 'finish', 'restart:0.4.0'], 'no npm in the rollback');
  assert.equal(await readFile(join(back.checkout, 'node_modules', 'keep.txt'), 'utf8'), 'kept\n');
});

test('rollback of a detached checkout; a release already checked out is not installed again', async t => {
  const r = await repos(t);
  r.git(r.checkout, 'checkout', '-q', '--detach', 'v0.4.0');
  await assert.rejects(install(r, { steps: fakeSteps({ failAt: 'restart' }) }), error => error.rolledBack === true);
  assert.equal(r.git(r.checkout, 'rev-parse', 'HEAD'), r.v4);
  assert.throws(() => r.git(r.checkout, 'symbolic-ref', '-q', 'HEAD'), 'still detached');
  r.git(r.checkout, 'checkout', '-q', '--detach', 'v0.5.0');
  const again = fakeSteps();
  const result = await install(r, { steps: again });
  assert.equal(result.moved, 'none');
  assert.deepEqual(again.calls, [], 'no npm, refresh or restart');
});

test('move_failed: an untracked file in the way stops git before anything moves', async t => {
  const r = await repos(t);
  await writeFile(join(r.source, 'added.txt'), 'from the release\n');
  r.git(r.source, 'add', 'added.txt');
  r.git(r.source, 'commit', '-q', '-m', 'Add a file');
  r.git(r.source, 'tag', '-f', '-a', 'v0.5.0', '-m', 'v0.5.0');
  r.git(r.source, 'push', '-q', '-f', 'origin', 'main', '--tags');
  const commit = r.git(r.source, 'rev-parse', 'v0.5.0^{commit}');
  await writeFile(join(r.checkout, 'added.txt'), 'mine, untracked\n');
  await refused(install(r, { target: { ...r.target, commit } }), 'move_failed');
  assert.equal(r.git(r.checkout, 'rev-parse', 'HEAD'), r.v4);
  assert.equal(await readFile(join(r.checkout, 'added.txt'), 'utf8'), 'mine, untracked\n');
});

test('M2: a tab approved during the update undoes it without stopping the daemon', async t => {
  const r = await repos(t);
  const steps = fakeSteps();
  steps.restart = async version => {
    steps.calls.push(`restart:${version}`);
    throw new LeaseHeld([{ requestId: 'req_late', state: 'active' }]);
  };
  await assert.rejects(install(r, { steps }), error => {
    assert.equal(error.rolledBack, true);
    assert.match(error.message, /approved while the update ran/);
    return true;
  });
  assert.deepEqual(steps.calls, ['finish', 'restart:0.5.0', 'finish'], 'the old daemon was never stopped, so no restart');
  assert.equal(r.git(r.checkout, 'rev-parse', 'HEAD'), r.v4);
});

test('S3: an error before the move is reported with its reason, not as a failed rollback', async t => {
  const r = await repos(t);
  const { home, env, paths } = await faiHome(r);
  const broken = async (args, options) => {
    if (args[0] === 'status') throw Object.assign(new Error('git status failed'), { stderr: 'fatal: index file corrupt' });
    return r.run(args, options);
  };
  const result = await updateCommand({}, { home, env, fetch: releases(release('v0.5.0'), { commit: r.v5 }), root: r.checkout,
    git: broken, remoteOk: r.remoteOk, steps: fakeSteps(), requests: [] });
  assert.equal(result.value.state, 'failed');
  assert.match(result.value.message, /index file corrupt\. Nothing was changed\./);
  assert.doesNotMatch(result.value.message, /Rollback/);
  assert.equal(readInstallState(paths).state, 'failed');
});

test('S4/S5: early exits leave a record; an interrupted update is finished by the next run', async t => {
  const r = await repos(t);
  const { home, env, paths } = await faiHome(r);
  const base = { home, env, root: r.checkout, git: r.run, remoteOk: r.remoteOk, requests: [] };
  const bad = await updateCommand({ tag: 'v1' }, { ...base, fetch: releases(release('v0.5.0')) });
  assert.equal(bad.value.code, 'bad_release');
  assert.equal(readInstallState(paths).error, 'bad_release');
  // The checkout moved to 0.5.0, then the updater died before the refresh and the restart.
  r.git(r.checkout, 'fetch', '-q', 'origin');
  r.git(r.checkout, 'merge', '-q', '--ff-only', r.v5);
  writeInstallState(paths, { pid: 2 ** 22 + 4321, state: 'running', from: '0.4.0', to: '0.5.0', step: 'finish',
    commit: r.v5, previous: r.v4 });
  const steps = fakeSteps();
  const resumed = await updateCommand({}, { ...base, steps, fetch: releases(release('v0.5.0'), { commit: r.v5 }) });
  assert.equal(resumed.value.state, 'succeeded', JSON.stringify(resumed.value));
  assert.equal(resumed.value.resumed, true);
  assert.deepEqual(steps.calls, ['finish', 'restart:0.5.0']);
  assert.equal(readInstallState(paths).state, 'succeeded');
  const quiet = fakeSteps();
  const current = await updateCommand({}, { ...base, steps: quiet, fetch: releases(release('v0.5.0')) });
  assert.equal(current.value.state, 'up_to_date');
  assert.deepEqual(quiet.calls, []);
  assert.equal(readInstallState(paths).state, 'up_to_date');
});

// --- the check -------------------------------------------------------------------------------------------------------

test('S6: a 403 without rate-limit headers is an error; retry times are capped; the clock moving back is due', async t => {
  const paths = await stateHome(t);
  const now = clock();
  const plain = await runCheck({ paths, currentVersion: '0.4.0', now, fetch: mockFetch(() => json(403, { message: 'Forbidden' })) });
  assert.equal(plain.status, 'error');
  assert.equal(plain.error, 'http_403');
  const far = Math.floor(now() / 1000) + 10 * 24 * 3600;
  now.advance(2 * HOUR);
  const limited = await runCheck({ paths, currentVersion: '0.4.0', now, fetch: mockFetch(() => json(403, {},
    { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(far) })) });
  assert.equal(limited.status, 'rate_limited');
  assert.ok(Date.parse(limited.retryAt) <= now() + DAY, 'never trusted beyond a day');
  assert.equal(checkDue({ attemptAt: new Date(now() + 5 * DAY).toISOString(), status: 'ok' }, { now }), true);
});

test('the commit always comes from the tag; a 304 fetches a missing commit; a stopped check records nothing', async t => {
  const paths = await stateHome(t);
  const now = clock();
  const state = await runCheck({ paths, currentVersion: '0.4.0', now,
    fetch: releases(release('v0.5.0', { target_commitish: 'b'.repeat(40) })) });
  assert.equal(state.latest.commit, SHA5, 'target_commitish is ignored');
  assert.equal(state.source, 'api');
  const raw = JSON.parse(await readFile(updatePaths(paths).check, 'utf8'));
  await writeFile(updatePaths(paths).check, JSON.stringify({ ...raw, latest: { ...raw.latest, commit: null } }));
  now.advance(DAY);
  const refetch = mockFetch(url => (url === RELEASES_API ? new Response(null, { status: 304 }) : new Response(SHA5, { status: 200 })));
  const after = await runCheck({ paths, currentVersion: '0.4.0', fetch: refetch, now });
  assert.equal(after.latest.commit, SHA5);
  assert.equal(refetch.calls.length, 2);

  const stopped = await stateHome(t);
  const hanging = mockFetch((url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  }));
  const logged = [];
  const checker = createUpdateChecker({ paths: stopped, currentVersion: '0.4.0', fetch: hanging, enabled: () => true,
    log: (event, fields) => logged.push(fields) });
  const pending = checker.check();
  await new Promise(resolve => setTimeout(resolve, 10));
  checker.stop();
  await pending;
  assert.equal(existsSync(updatePaths(stopped).check), false, 'nothing written');
  assert.deepEqual(logged, [], 'nothing logged');
  assert.equal(updateView({ paths: stopped, currentVersion: '0.4.0', installable: false }).installable, false);
});

// --- update --finish -------------------------------------------------------------------------------------------------

test('update --finish refreshes only fai-browser skills and existing pairing, and writes no settings', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'fai-update-finish-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ours = join(dir, '.claude', 'skills', 'fai-browser');
  const foreign = join(dir, '.agents', 'skills', 'fai-browser');
  await mkdir(ours, { recursive: true });
  await mkdir(foreign, { recursive: true });
  await writeFile(join(ours, 'SKILL.md'), '---\nname: fai-browser\n---\n<!-- fai-browser 0.0.1: re-run "fai-browser install" to update -->\nold\n');
  await writeFile(join(foreign, 'SKILL.md'), 'someone else\'s skill\n');
  const result = await finishInstall({ env: { HOME: dir, FAI_HOME: join(dir, 'fai-home'), PATH: process.env.PATH } });
  assert.equal(result.state, 'finished');
  assert.deepEqual(result.native, [], 'no launcher was installed, so no pairing is written');
  assert.deepEqual(result.skills.map(item => item.path), [ours]);
  assert.ok(result.skills[0].writes > 0);
  assert.doesNotMatch(await readFile(join(ours, 'SKILL.md'), 'utf8'), /fai-browser 0\.0\.1/);
  assert.equal(await readFile(join(foreign, 'SKILL.md'), 'utf8'), 'someone else\'s skill\n');
  assert.equal(existsSync(join(dir, 'fai-home', '.env.local')), false, 'no settings written');
});
