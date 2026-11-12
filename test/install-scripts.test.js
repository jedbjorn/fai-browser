// The installers: scripts/install.sh (macOS and Linux) run for real in its safe modes (check-only, reusing a checkout,
// refusing a directory that is not one, bad options), and scripts/install.ps1 (Windows) checked statically and for its
// refusal of an elevated window. No test here clones or downloads from the network, installs a package or runs setup.
// The Windows and macOS CI jobs run this file on those systems; the Windows job also runs install.ps1 end to end
// (.github/workflows/ci.yml, "Installer (windows-latest)").
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
function ps(args, { env = cleanEnv() } = {}) {
  const result = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args],
    { env, encoding: 'utf8', timeout: 120_000 });
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
  // The Node.js .pkg signature check fails closed (no pkgutil on Linux; no such file on macOS).
  const verify = sh(['--verify-node-pkg', '/nonexistent/node.pkg']);
  assert.equal(verify.status, 1, verify.out);
  assert.match(verify.out, /the signature check of \/nonexistent\/node\.pkg failed/);
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
    // Exit 0 (the checkout is done), and the last line says plainly that setup did not run.
    assert.equal(run.out.trim().split('\n').at(-1), `SETUP NOT RUN (no terminal). Run it yourself in a terminal: cd '${dir}' && npm run setup`);
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

// Review round 1 (PR #48): each of these failed on fc32596.

test('install.sh accepts a tag of one line only: a second line is refused, not matched line by line', { skip: POSIX_SKIP }, t => {
  const dir = join(scratch(t), 'fai-browser');
  for (const tag of ['v0.8.0\nevil', 'v0.8.0\n', '\nv0.8.0', 'v0.8.0 ', 'V0.8.0', 'v0.8.0\r']) {
    const run = sh(['--check', '--dir', dir, '--tag', tag]);
    assert.equal(run.status, 1, `${JSON.stringify(tag)}: ${run.out}`);
    assert.match(run.out, /--tag must be a release tag such as v0\.8\.0/);
    assert.doesNotMatch(run.out, /Plan:/);
  }
  assert.equal(existsSync(dir), false);
  // The checkout names the tag's commit, detached, with -- after it.
  assert.match(readFileSync(SH, 'utf8'), /checkout --quiet --detach "refs\/tags\/\$TAG\^\{commit\}" --/);
});

test('install.sh reuses a checkout only when its origin is one line naming this repository', { skip: POSIX_SKIP }, t => {
  const dir = fakeCheckout(join(scratch(t), 'two-line'));
  git(dir, 'config', 'remote.origin.url', 'https://example.com/evil.git\nhttps://github.com/jedbjorn/fai-browser.git');
  const url = spawnSync('git', ['-C', dir, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).stdout;
  assert.equal(url.trim().split('\n').length, 2, 'the fixture really has a two-line URL');
  const run = sh(['--yes', '--dir', dir]);
  assert.equal(run.status, 1, run.out);
  assert.match(run.out, /exists and is not a FAI Browser checkout/);
  assert.doesNotMatch(run.out, /reused|Using the existing checkout|SETUP/);
});

test('install.sh: FAI_NODE_LINE must be a Node major of 22 or newer', { skip: POSIX_SKIP }, t => {
  const dir = join(scratch(t), 'fai-browser');
  for (const line of ['abc', '20', '24; rm -rf x', '2.4', '-1']) {
    const run = sh(['--check', '--dir', dir], { env: cleanEnv({ FAI_NODE_LINE: line }) });
    assert.equal(run.status, 1, `${line}: ${run.out}`);
    assert.match(run.out, /FAI_NODE_LINE must be/);
  }
  const ok = sh(['--check', '--dir', dir], { env: cleanEnv({ FAI_NODE_LINE: '26' }) });
  assert.equal(ok.status, 0, ok.out);
});

test('install.sh: empty --tag= or --dir= is refused; without --yes it asks before it changes anything', { skip: POSIX_SKIP }, t => {
  const base = scratch(t);
  for (const [args, said] of [[['--check', '--tag=', '--dir', join(base, 'x')], /--tag must be a release tag/],
    [['--check', '--tag', '', '--dir', join(base, 'x')], /--tag must be a release tag/],
    [['--check', '--dir='], /--dir needs a directory, not an empty value/],
    [['--check', '--dir', ''], /--dir needs a directory, not an empty value/]]) {
    const run = sh(args);
    assert.equal(run.status, 1, `${JSON.stringify(args)}: ${run.out}`);
    assert.match(run.out, said);
  }
  assert.equal(existsSync(join(base, 'x')), false);
  // A plain run (no --yes) with no terminal to ask in stops after the plan, before reusing or cloning anything.
  const dir = fakeCheckout(join(base, 'checkout'));
  const plain = sh(['--dir', dir]);
  assert.equal(plain.status, 1, plain.out);
  assert.match(plain.out, /Plan:/);
  assert.match(plain.out, /Go ahead with this plan\? needs an answer, but there is no terminal to ask in/);
  assert.doesNotMatch(plain.out, /Using the existing checkout|Cloning/);
  const fresh = join(base, 'fresh');
  const none = sh(['--dir', fresh]);
  assert.equal(none.status, 1, none.out);
  assert.equal(existsSync(fresh), false, 'nothing written without a yes');
});

test('install.sh prints cd hints single-quoted: a pasted line expands no $, backtick or quote', { skip: POSIX_SKIP }, t => {
  const dir = fakeCheckout(join(scratch(t), "it's $HOME `id` dir"));
  const run = sh(['--yes', '--dir', dir]);
  assert.equal(run.status, 0, run.out);
  const line = run.out.trim().split('\n').at(-1);
  const quoted = /cd ('.*') && npm run setup$/.exec(line)?.[1];
  assert.ok(quoted, line);
  assert.equal(quoted, `'${dir.replaceAll("'", "'\\''")}'`);
  // The shell reads it back as the exact directory.
  const echoed = spawnSync('/bin/sh', ['-c', `printf %s ${quoted}`], { encoding: 'utf8' }).stdout;
  assert.equal(echoed, dir);
  const noSetup = sh(['--yes', '--no-setup', '--dir', dir]);
  assert.ok(noSetup.out.includes(`Next: cd ${quoted} && npm run setup`), noSetup.out);
});

// A PATH with only the tools the script needs, a fake `node` and no git: what a fresh machine reports.
function barePath(base, nodeVersion) {
  const bin = join(base, 'bin');
  mkdirSync(bin);
  for (const tool of ['uname', 'id', 'sed', 'grep', 'ls', 'dirname', 'head', 'cut', 'sort', 'tail', 'mkdir', 'rm', 'mktemp', 'cat',
    'date']) {
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

const UNINSTALL_PS1 = join(ROOT, 'scripts', 'uninstall.ps1');

test('install.ps1 and uninstall.ps1 are ASCII, https only, never elevate and check the Node.js download', () => {
  for (const file of [PS1, UNINSTALL_PS1]) {
    // Windows PowerShell 5.1 reads a script without a byte order mark in the ANSI code page: ASCII only.
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /[^\x00-\x7f]/, file);
    assert.doesNotMatch(source, /http:\/\//, `${file}: https only`);
    assert.doesNotMatch(source, /-Verb\s+RunAs/i, `${file}: no elevation of its own`);
    // `irm ... | iex` is how a user runs install.ps1; the script itself never runs downloaded text.
    const code = source.split('\n').filter(line => !line.trimStart().startsWith('#'));
    assert.equal(code.filter(line => /Invoke-Expression|\biex\b/i.test(line)).length, 0, file);
  }
  const source = readFileSync(PS1, 'utf8');
  assert.match(source, /SHASUMS256\.txt/);
  assert.match(source, /Get-FileHash \$zip -Algorithm SHA256/);
  assert.match(source, /IsInRole\(\[Security\.Principal\.WindowsBuiltInRole\]::Administrator\)/);
  assert.match(source, /--yes --download-firefox/);
  for (const text of [readFileSync(SH, 'utf8'), source]) assert.ok(text.includes('jedbjorn/fai-browser'));
});

function elevated() {
  const run = ps(['-Command', '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)']);
  return run.out.trim() === 'True';
}

test('install.ps1 refuses an elevated window before it changes anything', { skip: PS_SKIP }, t => {
  // GitHub's Windows runners run elevated; on a normal window the installer would go on to download Node.js.
  if (!elevated()) return t.skip('this PowerShell is not elevated');
  const root = join(scratch(t), 'fai-browser');
  const run = ps(['-File', PS1], { env: cleanEnv({ FAI_INSTALL_ROOT: root }) });
  assert.match(run.out, /FAI Browser install failed: this PowerShell window runs as administrator\./);
  assert.match(run.out, /Open a normal PowerShell window/);
  assert.equal(existsSync(root), false);
});

test('the PATH helper used above finds programs by PATHEXT on Windows', { skip: PS_SKIP }, () => {
  assert.ok(findOnPath('node'), `node on PATH (${String(process.env.Path ?? process.env.PATH).split(delimiter).length} entries)`);
});
