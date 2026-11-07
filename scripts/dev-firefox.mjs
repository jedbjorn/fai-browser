#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { buildFirefox } from './build-firefox.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const DEFAULT_PROFILE = join('profiles', 'fai-firefox-dev');
const sleep = ms => new Promise(done => setTimeout(done, ms));

export function parseDevArgs(argv = process.argv.slice(2), { root = ROOT, cwd = process.cwd(), env = process.env } = {}) {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      profile: { type: 'string' },
      firefox: { type: 'string' },
      debounce: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const debounceMs = values.debounce === undefined ? 250 : Number(values.debounce);
  if (!Number.isInteger(debounceMs) || debounceMs < 0) throw new Error('--debounce must be a non-negative integer in milliseconds');
  return {
    help: values.help ?? false,
    profile: values.profile ? resolve(cwd, values.profile) : join(root, DEFAULT_PROFILE),
    firefox: values.firefox ?? env.FIREFOX_PATH,
    debounceMs,
  };
}

export function webExtArgs({ profile, firefox }, sourceDir = join(ROOT, 'dist', 'firefox')) {
  return [
    '--yes', 'web-ext@8', 'run',
    '--source-dir', sourceDir,
    '--firefox-profile', profile,
    '--keep-profile-changes',
    '--profile-create-if-missing',
    '--no-config-discovery',
    '--no-input',
    '--reload',
    '--start-url', 'about:blank',
    ...(firefox ? ['--firefox', firefox] : []),
  ];
}

export async function profileLock(profile) {
  for (const name of ['.parentlock', 'parent.lock']) {
    const path = join(profile, name);
    try {
      await lstat(path);
      return path;
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    }
  }
  return null;
}

export function firefoxProcessesInPs(stdout, profile) {
  return stdout.split('\n').flatMap(line => {
    const match = line.trim().match(/^(\S+)\s+(.+)$/);
    if (!match || !/^firefox/i.test(basename(match[1]))) return [];
    const args = match[2];
    if (args.includes(profile)) return [args];
    const hasProfile = /(?:^|\s)--?profile(?:=|\s+)/.test(args);
    const hasAbsoluteProfile = /(?:^|\s)--?profile(?:=|\s+)\//.test(args);
    if (hasProfile && hasAbsoluteProfile) return [];
    return [args];
  });
}

export async function firefoxProcesses(profile) {
  const stdout = await new Promise((resolveOutput, rejectOutput) => {
    execFile('ps', ['-eo', 'comm=,args='], { encoding: 'utf8' }, (error, output) => error ? rejectOutput(error) : resolveOutput(output));
  });
  return firefoxProcessesInPs(stdout, profile);
}

export async function assertProfileAvailable(profile, { listFirefox = firefoxProcesses } = {}) {
  const lock = await profileLock(profile);
  if (!lock) return;
  let running = null;
  try {
    running = (await listFirefox(profile)).length > 0;
  } catch {
    // A lock with no reliable process listing stays refused.
  }
  if (running === false) return;
  throw new Error([
    running
      ? `Firefox is running and the selected profile is locked: ${profile}`
      : `Firefox profile is locked and its running state could not be verified: ${profile}`,
    `Found profile lock: ${lock}`,
    'Close every Firefox window/process using this profile, then rerun npm run dev:firefox.',
    'Alternatively, choose a different profile with --profile /absolute/path/to/profile.',
    'A stale lock is accepted once no running or ambiguous Firefox process could use this profile; Firefox will handle it on startup.',
    'The profile and its lock were left untouched.',
  ].join('\n'));
}

export function createRebuilder({ build, debounceMs, onBuilt = () => {}, onError = error => console.error(error) }) {
  let timer = null;
  let running = false;
  let queued = false;
  let closed = false;
  let idle = null;
  let resolveIdle = null;

  function changed() {
    if (idle && !running && !timer && !queued) {
      idle = null;
      resolveIdle?.();
    }
  }

  async function run() {
    timer = null;
    if (closed || running) return;
    running = true;
    queued = false;
    try {
      await build();
      onBuilt();
    } catch (error) {
      onError(error);
    }
    running = false;
    if (queued && !closed) schedule();
    else changed();
  }

  function schedule() {
    if (closed) return;
    queued = true;
    if (running) return;
    clearTimeout(timer);
    timer = setTimeout(run, debounceMs);
  }

  return {
    notify: schedule,
    async close() {
      closed = true;
      clearTimeout(timer);
      timer = null;
      queued = false;
      while (running) await sleep(5);
      changed();
    },
    whenIdle() {
      if (!running && !timer && !queued) return Promise.resolve();
      return new Promise(resolve => {
        const previous = resolveIdle;
        resolveIdle = () => { previous?.(); resolve(); };
        idle = resolveIdle;
      });
    },
  };
}

function usage() {
  return `Usage: npm run dev:firefox -- [options]

Build dist/firefox, watch extension/, rebuild after changes, and let web-ext reload the add-on.

Options:
  --profile <dir>    Firefox profile (default: profiles/fai-firefox-dev)
  --firefox <path>   Firefox executable (default: FIREFOX_PATH or web-ext's choice)
  --debounce <ms>    Rebuild debounce in milliseconds (default: 250)
  -h, --help         Show this help

The profile is used directly and keeps its changes and sign-ins. Close Firefox before
starting this command on that profile. This web-ext session is remote-controlled;
do not use it for the no-remote-protocol npm run detect:firefox measurement.`;
}

export async function runDevFirefox({ argv, root = ROOT, env = process.env, spawnProcess = spawn, listFirefox } = {}) {
  const options = parseDevArgs(argv, { root, env });
  if (options.help) {
    console.log(usage());
    return;
  }
  const sourceDir = join(root, 'dist', 'firefox');
  await assertProfileAvailable(options.profile, { listFirefox });
  await buildFirefox({ root, out: sourceDir });
  await assertProfileAvailable(options.profile, { listFirefox });
  console.log(`Firefox add-on built in ${sourceDir}`);
  console.log(`Using persistent profile ${options.profile}; web-ext will reload after each rebuild.`);

  const npm = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const child = spawnProcess(npm, webExtArgs(options, sourceDir), { stdio: 'inherit', env });
  const rebuilder = createRebuilder({
    debounceMs: options.debounceMs,
    build: () => buildFirefox({ root, out: sourceDir }),
    onBuilt: () => console.log('Rebuilt dist/firefox; web-ext is reloading the add-on.'),
    onError: error => console.error(`Firefox rebuild failed: ${error.message}`),
  });
  const watcher = watch(join(root, 'extension'), { recursive: true }, rebuilder.notify);
  let stopping = false;
  const stop = signal => {
    stopping = true;
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  };
  const onSigint = () => stop('SIGINT');
  const onSigterm = () => stop('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  try {
    const { code, signal } = await new Promise((resolveExit, rejectExit) => {
      child.once('error', rejectExit);
      child.once('exit', (exitCode, exitSignal) => resolveExit({ code: exitCode, signal: exitSignal }));
    });
    if (code && !stopping) {
      const lock = await profileLock(options.profile);
      if (lock) console.error(`Firefox may still be running with ${options.profile}. Close it before retrying; the lock was left untouched (${lock}).`);
      throw new Error(`web-ext exited with code ${code}`);
    }
    if (stopping) console.log('Development loop stopped.');
    else if (signal) console.log(`web-ext stopped by ${signal}`);
  } finally {
    watcher.close();
    await rebuilder.close();
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    await runDevFirefox();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
