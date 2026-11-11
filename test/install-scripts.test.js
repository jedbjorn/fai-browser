// The bootstrap installers (scripts/install.sh for macOS and Linux, scripts/install.ps1 for Windows), run for real in
// their safe modes: check-only, reusing a checkout, refusing a directory that is not one, bad options. No test here
// clones from the network, installs a package or runs setup (setup refuses without a terminal, and the installers
// say so). The Windows and macOS CI jobs run this file on those systems; each script is tested on its own platform.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { findOnPath } from '../src/install.js';

const ROOT = resolve(import.meta.dirname, '..');
const SH = join(ROOT, 'scripts', 'install.sh');
const PS1 = join(ROOT, 'scripts', 'install.ps1');
const WINDOWS = process.platform === 'win32';
const POSIX_SKIP = WINDOWS ? 'install.sh is the macOS and Linux installer' : false;
const PS_SKIP = WINDOWS ? false : 'install.ps1 is the Windows installer (it uses Windows-only APIs)';

function scratch(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'fai install-scripts ')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

/** A directory that looks like a FAI Browser clone: package.json, scripts/setup.mjs and a git origin. */
function fakeCheckout(dir, origin = 'https://github.com/jedbjorn/fai-browser.git') {
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'fai-browser', version: '9.9.9' }, null, 2)}\n`);
  writeFileSync(join(dir, 'scripts', 'setup.mjs'), 'throw new Error("a test must never run setup");\n');
  git(dir, 'init', '--quiet');
  git(dir, 'remote', 'add', 'origin', origin);
  return dir;
}

// The environment of a run: no FAI_ variables from the caller, and never the user's real install directory.
function cleanEnv(extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('FAI_')));
  return { ...env, ...extra };
}

function sh(args, { env = cleanEnv(), input = '' } = {}) {
  const result = spawnSync('/bin/sh', [SH, ...args], { env, input, encoding: 'utf8', timeout: 60_000 });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

const POWERSHELL = WINDOWS ? (findOnPath('powershell') ?? 'powershell.exe') : null;
// GitHub's Windows runners run as an administrator; the installer refuses that unless -AllowAdministrator.
function ps(args, { env = cleanEnv(), admin = true } = {}) {
  const result = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS1,
    ...(admin ? ['-AllowAdministrator'] : []), ...args], { env, encoding: 'utf8', timeout: 120_000 });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

// --- scripts/install.sh (macOS, Linux) -------------------------------------------------------------------------------

test('install.sh --check reports git and Node, plans a clone and changes nothing', { skip: POSIX_SKIP }, t => {
  const dir = join(scratch(t), 'fai-browser');
  const run = sh(['--check', '--dir', dir]);
  assert.equal(run.status, 0, run.out);
  assert.match(run.out, /git: +git version/);
  assert.match(run.out, new RegExp(`Node\\.js: v${process.versions.node.replaceAll('.', '\\.')}`));
  assert.match(run.out, /Clone FAI Browser at its latest release tag into/);
  assert.match(run.out, /Check only \(--check\): nothing was changed\./);
  assert.equal(existsSync(dir), false);
  // FAI_INSTALL_DIR is the default directory; --tag names the release.
  const viaEnv = sh(['--check', '--tag', 'v1.2.3'], { env: cleanEnv({ FAI_INSTALL_DIR: dir }) });
  assert.equal(viaEnv.status, 0, viaEnv.out);
  assert.ok(viaEnv.out.includes(`Clone FAI Browser v1.2.3 into ${dir}`), viaEnv.out);
});

test('install.sh refuses bad options with a readable message', { skip: POSIX_SKIP }, () => {
  for (const [args, said] of [[['--tag', 'main'], /--tag must be a release tag such as v0\.8\.0, not 'main'/],
    [['--tag', 'v1.2.3;rm'], /--tag must be a release tag/], [['--bogus'], /unknown option --bogus/], [['--dir'], /--dir needs a directory/]]) {
    const run = sh(args);
    assert.equal(run.status, 1, run.out);
    assert.match(run.out, /FAI Browser install stopped: /);
    assert.match(run.out, said);
  }
  const help = sh(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.out, /--check +check only/);
  assert.doesNotMatch(help.out, /^#/m);
});

test('install.sh reuses a FAI Browser checkout twice without cloning; setup waits for a terminal', { skip: POSIX_SKIP }, t => {
  const dir = fakeCheckout(join(scratch(t), 'checkout'));
  for (let round = 0; round < 2; round++) {
    const run = sh(['--yes', '--dir', dir]);
    assert.equal(run.status, 0, run.out);
    assert.match(run.out, /a checkout already at .* \(reused\)/);
    assert.match(run.out, /Using the existing checkout at /);
    assert.match(run.out, /Setup must run in a terminal/);
    assert.ok(run.out.includes(`cd "${dir}" && npm run setup`), run.out);
    assert.doesNotMatch(run.out, /Cloning/);
  }
  const noSetup = sh(['--yes', '--no-setup', '--dir', dir]);
  assert.equal(noSetup.status, 0, noSetup.out);
  assert.match(noSetup.out, /Done \(--no-setup\)/);
});

test('install.sh stops at a directory that is not a FAI Browser clone and leaves it alone', { skip: POSIX_SKIP }, t => {
  const base = scratch(t);
  const other = join(base, 'other');
  mkdirSync(other);
  writeFileSync(join(other, 'notes.txt'), 'mine\n');
  const run = sh(['--yes', '--dir', other]);
  assert.equal(run.status, 1, run.out);
  assert.match(run.out, /exists and is not a FAI Browser checkout\. Choose another directory with --dir\./);
  assert.equal(readFileSync(join(other, 'notes.txt'), 'utf8'), 'mine\n');
  // A clone of another repository is not reused either.
  const fork = fakeCheckout(join(base, 'fork'), 'https://example.com/someone/fai-browser.git');
  const forked = sh(['--yes', '--dir', fork]);
  assert.equal(forked.status, 1, forked.out);
  assert.match(forked.out, /exists and is not a FAI Browser checkout/);
});

// A PATH with only the tools the script needs, a fake `node` and no git: what a fresh machine reports.
function barePath(base, nodeVersion) {
  const bin = join(base, 'bin');
  mkdirSync(bin);
  for (const tool of ['uname', 'id', 'sed', 'grep', 'ls', 'dirname', 'head', 'cut', 'sort', 'tail', 'mkdir', 'rm', 'mktemp', 'cat']) {
    const real = findOnPath(tool);
    if (real) symlinkSync(real, join(bin, tool));
  }
  if (nodeVersion) {
    writeFileSync(join(bin, 'node'), `#!/bin/sh\necho ${nodeVersion}\n`);
    chmodSync(join(bin, 'node'), 0o755);
  }
  return bin;
}

test('install.sh on a machine without git and with an old Node: says what is missing and what it would do', { skip: POSIX_SKIP }, t => {
  const base = scratch(t);
  const bin = barePath(base, '20.11.1');
  const env = cleanEnv({ PATH: bin });
  const dir = join(base, 'fai-browser');
  const check = sh(['--check', '--dir', dir], { env });
  assert.equal(check.status, 0, check.out);
  assert.match(check.out, /Node\.js: v20\.11\.1 is too old \(.*FAI Browser needs 22 or newer\)/);
  if (process.platform === 'darwin') {
    assert.match(check.out, /git: +not (found|installed)/);
    assert.match(check.out, /Install git with Apple's Command Line Tools/);
    assert.match(check.out, /Install Node\.js (with Homebrew|24 LTS from the official nodejs\.org package)/);
  } else {
    assert.match(check.out, /git: +not found/);
    assert.match(check.out, /Install git with your package manager/);
    assert.match(check.out, /Install Node\.js 22 or newer yourself/);
    // Linux installs nothing itself: it names the package command and stops before touching the directory.
    const run = sh(['--yes', '--dir', dir], { env });
    assert.equal(run.status, 1, run.out);
    assert.match(run.out, /git is missing\. Install it with your package manager/);
    assert.equal(existsSync(dir), false);
  }
  assert.equal(existsSync(dir), false);
});

test('install.sh is plain POSIX sh: no bashisms that macOS /bin/sh or dash would reject', { skip: POSIX_SKIP }, () => {
  const source = readFileSync(SH, 'utf8');
  assert.match(source, /^#!\/bin\/sh\n/);
  for (const bashism of [/\[\[ /, /^\s*function\s/m, /^\s*(local|declare|source|typeset)\s/m, /\$\{[^}]*\/\/[^}]*\}/, /<<</, /&>/]) {
    assert.doesNotMatch(source, bashism);
  }
  assert.doesNotMatch(source, /\beval\b/);
  assert.doesNotMatch(source, /curl[^\n|]*\|\s*(sh|bash)\b/, 'never pipes a download into a shell');
  assert.doesNotMatch(source, /http:\/\//, 'https only');
  const syntax = spawnSync('/bin/sh', ['-n', SH], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
});

// --- scripts/install.ps1 (Windows) -----------------------------------------------------------------------------------

test('install.ps1 is ASCII, quotes its paths and never runs downloaded text', () => {
  // Windows PowerShell 5.1 reads a script without a byte order mark in the ANSI code page: ASCII only.
  const source = readFileSync(PS1, 'utf8');
  assert.doesNotMatch(source, /[^\x00-\x7f]/);
  assert.doesNotMatch(source, /Invoke-Expression|\biex\b/i);
  assert.doesNotMatch(source, /http:\/\//, 'https only');
  assert.doesNotMatch(source, /-Verb\s+RunAs/i, 'no elevation of its own');
  for (const text of [readFileSync(SH, 'utf8'), source]) {
    // Both installers pin the same repository and the same default directory name.
    assert.ok(text.includes('https://github.com/jedbjorn/fai-browser.git'));
    assert.ok(text.includes('fai-browser'));
  }
});

test('install.ps1 -Check reports git and Node and changes nothing; an elevated window is refused', { skip: PS_SKIP }, t => {
  const dir = join(scratch(t), 'fai-browser');
  const run = ps(['-Check', '-Dir', dir]);
  assert.equal(run.status, 0, run.out);
  assert.match(run.out, /git: +git version/);
  assert.match(run.out, new RegExp(`Node\\.js: v${process.versions.node.replaceAll('.', '\\.')}`));
  assert.match(run.out, /Clone FAI Browser at its latest release tag into/);
  assert.match(run.out, /Check only \(-Check\): nothing was changed\./);
  assert.equal(existsSync(dir), false);
  const elevated = ps(['-Check', '-Dir', dir], { admin: false });
  if (/runs as administrator/.test(elevated.out)) {
    assert.equal(elevated.status, 1, elevated.out);
    assert.match(elevated.out, /Open a normal PowerShell window/);
  } else {
    assert.equal(elevated.status, 0, elevated.out);
  }
});

test('install.ps1 refuses bad options; -Help prints the usage', { skip: PS_SKIP }, () => {
  const bad = ps(['-Tag', 'main']);
  assert.equal(bad.status, 1, bad.out);
  assert.match(bad.out, /FAI Browser install stopped: -Tag must be a release tag such as v0\.8\.0, not 'main'/);
  const help = ps(['-Help']);
  assert.equal(help.status, 0, help.out);
  assert.match(help.out, /-Check +check only/);
});

test('install.ps1 reuses a FAI Browser checkout twice; stops at any other directory', { skip: PS_SKIP }, t => {
  const base = scratch(t);
  const dir = fakeCheckout(join(base, 'checkout'));
  for (let round = 0; round < 2; round++) {
    const run = ps(['-Yes', '-Dir', dir]);
    assert.equal(run.status, 0, run.out);
    assert.match(run.out, /a checkout already at .* \(reused\)/);
    assert.match(run.out, /Using the existing checkout at /);
    assert.match(run.out, /Setup must run in a console window/);
    assert.doesNotMatch(run.out, /Cloning/);
  }
  const other = join(base, 'other');
  mkdirSync(other);
  writeFileSync(join(other, 'notes.txt'), 'mine\n');
  const refused = ps(['-Yes', '-Dir', other]);
  assert.equal(refused.status, 1, refused.out);
  assert.match(refused.out, /exists and is not a FAI Browser checkout/);
  assert.equal(readFileSync(join(other, 'notes.txt'), 'utf8'), 'mine\n');
});

test('install.ps1 without git, winget or a new Node: says what is missing and where to get it', { skip: PS_SKIP }, t => {
  const base = scratch(t);
  const bin = join(base, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'node.cmd'), '@echo 20.11.1\r\n');
  const env = cleanEnv({ PATH: bin, Path: bin });
  delete env.PATH;
  env.Path = bin;
  const dir = join(base, 'fai-browser');
  const check = ps(['-Check', '-Dir', dir], { env });
  assert.equal(check.status, 0, check.out);
  assert.match(check.out, /git: +not found/);
  assert.match(check.out, /Node\.js: v20\.11\.1 is too old/);
  assert.match(check.out, /winget: +not found/);
  assert.match(check.out, /Stop: git and Node\.js missing and winget is not installed/);
  const run = ps(['-Yes', '-Dir', dir], { env });
  assert.equal(run.status, 1, run.out);
  assert.match(run.out, /https:\/\/git-scm\.com\/download\/win/);
  assert.match(run.out, /https:\/\/nodejs\.org\/en\/download/);
  assert.equal(existsSync(dir), false);
});

test('the PATH helper used above finds programs by PATHEXT on Windows', { skip: PS_SKIP }, () => {
  assert.ok(findOnPath('node'), `node on PATH (${String(process.env.Path ?? process.env.PATH).split(delimiter).length} entries)`);
});
