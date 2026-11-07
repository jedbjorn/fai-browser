import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  assertProfileAvailable,
  createRebuilder,
  firefoxProcessesInPs,
  parseDevArgs,
  runDevFirefox,
  webExtArgs,
} from '../scripts/dev-firefox.mjs';
import { assertDetectionReceipt } from '../scripts/detection-matrix.mjs';

const sleep = ms => new Promise(done => setTimeout(done, ms));

test('dev:firefox arguments default to the worktree profile and FIREFOX_PATH', () => {
  const root = resolve('/worktree');
  assert.deepEqual(parseDevArgs([], { root, cwd: '/elsewhere', env: { FIREFOX_PATH: '/opt/firefox/firefox' } }), {
    help: false,
    profile: join(root, 'profiles', 'fai-firefox-dev'),
    firefox: '/opt/firefox/firefox',
    debounceMs: 250,
  });
  assert.deepEqual(parseDevArgs(['--profile', 'relative/profile', '--firefox', '/usr/bin/firefox', '--debounce', '75'], {
    root, cwd: '/chosen', env: { FIREFOX_PATH: '/ignored' },
  }), {
    help: false,
    profile: resolve('/chosen', 'relative/profile'),
    firefox: '/usr/bin/firefox',
    debounceMs: 75,
  });
  assert.throws(() => parseDevArgs(['--debounce=-1']), /non-negative integer/);
  assert.throws(() => parseDevArgs(['--debounce', 'soon']), /non-negative integer/);
  assert.throws(() => parseDevArgs(['unexpected']), /Unexpected argument/);
});

test('dev:firefox web-ext uses the selected profile in place and auto-reloads the built add-on', () => {
  const args = webExtArgs({ profile: '/profiles/signed-in', firefox: '/opt/firefox' }, '/build/firefox');
  assert.equal(args[2], 'run');
  assert.deepEqual(args.slice(0, 4), ['--yes', 'web-ext@8', 'run', '--source-dir']);
  for (const option of ['--keep-profile-changes', '--profile-create-if-missing', '--reload', '--no-config-discovery']) {
    assert.ok(args.includes(option), option);
  }
  assert.equal(args[args.indexOf('--source-dir') + 1], '/build/firefox');
  assert.equal(args[args.indexOf('--firefox-profile') + 1], '/profiles/signed-in');
  assert.equal(args[args.indexOf('--firefox') + 1], '/opt/firefox');
  assert.equal(args.includes('--no-reload'), false);
});

test('dev:firefox process inspection distinguishes explicit profiles and keeps ambiguous launches conservative', () => {
  const selected = 'firefox /usr/lib/firefox/firefox -no-remote -profile /tmp/selected';
  const other = 'firefox /usr/lib/firefox/firefox -no-remote -profile /tmp/other';
  const output = `${selected}\n${other}\nWeb Content /usr/lib/firefox/firefox -contentproc\nnode scripts/dev-firefox.mjs`;
  assert.deepEqual(firefoxProcessesInPs(output, '/tmp/selected'), [selected.slice('firefox '.length)]);
  assert.deepEqual(firefoxProcessesInPs(output, '/tmp/other'), [other.slice('firefox '.length)]);
  const ambiguous = 'firefox /usr/lib/firefox/firefox\nfirefox /usr/lib/firefox/firefox -profile relative';
  assert.equal(firefoxProcessesInPs(ambiguous, '/tmp/stale').length, 2, 'default and relative-profile launches may use the selected profile');
  const macSelected = '/Applications/Firefox.app/Contents/MacOS/firefox /Applications/Firefox.app/Contents/MacOS/firefox -profile /tmp/selected';
  const macOther = '/Applications/Firefox.app/Contents/MacOS/firefox /Applications/Firefox.app/Contents/MacOS/firefox -profile /tmp/other';
  assert.deepEqual(firefoxProcessesInPs(`${macSelected}\n${macOther}`, '/tmp/selected'), [macSelected.split(' ').slice(1).join(' ')]);
});

test('dev:firefox refuses either Firefox profile lock while Firefox runs without building, spawning, or changing preferences', async t => {
  for (const lockName of ['.parentlock', 'parent.lock']) {
    const root = await mkdtemp(join(tmpdir(), 'fai-ff-dev-lock-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const profile = join(root, 'profile');
    await mkdir(profile);
    const lock = join(profile, lockName);
    const preferences = join(profile, 'user.js');
    await writeFile(lock, '1234/firefox');
    await writeFile(preferences, 'user_pref("signed.in", true);\n');
    let spawned = false;
    await assert.rejects(runDevFirefox({
      argv: ['--profile', profile],
      root,
      env: {},
      listFirefox: async () => ['firefox'],
      spawnProcess: () => { spawned = true; },
    }), error => {
      assert.match(error.message, /Firefox is running and the selected profile is locked/);
      assert.match(error.message, /Close every Firefox window\/process/);
      assert.match(error.message, /--profile/);
      assert.match(error.message, /left untouched/);
      return true;
    });
    assert.equal(spawned, false);
    assert.equal(existsSync(join(root, 'dist')), false);
    assert.equal(await readFile(preferences, 'utf8'), 'user_pref("signed.in", true);\n');
    assert.equal(await readFile(lock, 'utf8'), '1234/firefox');
  }
});

test('dev:firefox accepts a stale lock only with a reliable empty Firefox process list', async t => {
  const root = await mkdtemp(join(tmpdir(), 'fai-ff-dev-stale-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profile = join(root, 'profile');
  await mkdir(profile);
  const lock = join(profile, '.parentlock');
  await writeFile(lock, '');
  await assertProfileAvailable(profile, { listFirefox: async () => [] });
  await assert.rejects(assertProfileAvailable(profile, { listFirefox: async () => { throw new Error('ps unavailable'); } }), /could not be verified/);
  assert.equal(await readFile(lock, 'utf8'), '');
});

test('dev:firefox profile preflight accepts a missing or unlocked profile without creating it', async t => {
  const root = await mkdtemp(join(tmpdir(), 'fai-ff-dev-profile-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const missing = join(root, 'missing');
  await assertProfileAvailable(missing);
  assert.equal(existsSync(missing), false);
  await mkdir(missing);
  await assertProfileAvailable(missing);
  assert.deepEqual(await readFile(join(ROOT_PACKAGE), 'utf8').then(text => JSON.parse(text).scripts['dev:firefox']), 'node scripts/dev-firefox.mjs');
});

const ROOT_PACKAGE = resolve(import.meta.dirname, '..', 'package.json');

test('dev:firefox rebuilds once per debounced burst and queues a change made during a build', async t => {
  let builds = 0;
  let releaseFirst;
  const firstBuild = new Promise(resolve => { releaseFirst = resolve; });
  const rebuilder = createRebuilder({
    debounceMs: 10,
    build: async () => {
      builds += 1;
      if (builds === 1) await firstBuild;
    },
  });
  t.after(() => rebuilder.close());
  rebuilder.notify();
  rebuilder.notify();
  rebuilder.notify();
  await sleep(30);
  assert.equal(builds, 1);
  rebuilder.notify();
  rebuilder.notify();
  releaseFirst();
  await rebuilder.whenIdle();
  assert.equal(builds, 2, 'the burst during the first build causes exactly one more build');
});

test('dev:firefox rebuild errors are reported and later changes still rebuild', async t => {
  let builds = 0;
  const errors = [];
  const rebuilder = createRebuilder({
    debounceMs: 5,
    build: async () => {
      builds += 1;
      if (builds === 1) throw new Error('fixture build failure');
    },
    onError: error => errors.push(error.message),
  });
  t.after(() => rebuilder.close());
  rebuilder.notify();
  await rebuilder.whenIdle();
  rebuilder.notify();
  await rebuilder.whenIdle();
  assert.equal(builds, 2);
  assert.deepEqual(errors, ['fixture build failure']);
});

test('detection receipts accept acted or completed only with the intended action', () => {
  const scroll = { description: 'scroll down' };
  for (const result of [
    { status: 'checkpoint', code: 'step_complete', did: ['scroll down'] },
    { status: 'completed', code: 'expectation_passed', did: ['scroll down'] },
  ]) {
    assert.doesNotThrow(() => assertDetectionReceipt({ state: 'done', result }, scroll));
  }
  assert.throws(() => assertDetectionReceipt({ state: 'done', result: {
    status: 'checkpoint', code: 'step_complete', did: ['click "Load more results"'],
  } }, scroll), /receipt did another action/);
});

test('detection receipts reject stale and failed scroll results', () => {
  const scroll = { description: 'scroll down' };
  assert.throws(() => assertDetectionReceipt({ state: 'done', result: {
    status: 'needs_host', code: 'stale', did: ['scroll down'],
  } }, scroll), /needs_host/);
  assert.throws(() => assertDetectionReceipt({ state: 'done', result: {
    status: 'needs_host', code: 'failed', did: ['scroll down'],
  } }, scroll), /needs_host/);
  assert.throws(() => assertDetectionReceipt({ state: 'done', result: {
    status: 'checkpoint', code: 'step_complete', did: [],
  } }, scroll), /missing or extra action receipts/);
});
