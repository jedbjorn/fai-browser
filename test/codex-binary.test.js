import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { codexBinary, codexSupportsQueue, deliverCodexQueue, wakeReason } from '../src/wake.js';

const windows = { platform: 'win32', arch: 'x64' };
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'fai-codex lookup '));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = async (...parts) => {
    const path = join(dir, ...parts);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '');
    return path;
  };
  return { dir, file };
}

test('Windows Codex lookup: explicit .exe, then PATH with only .EXE, never relative or script commands', async t => {
  const { dir, file } = await fixture(t);
  const exe = await file('PATH', 'codex.EXE');
  const explicit = await file('custom.EXE');
  const env = { Path: dirname(exe), PATHEXT: '.CMD;.BAT;.PS1' };
  assert.equal(codexBinary(env, windows), exe, 'uses Path casing and overrides PATHEXT');
  assert.equal(codexBinary({ ...env, FAI_CODEX_BIN: explicit }, windows), explicit);
  assert.equal(codexBinary({ PATH: '.;bin' }, windows), null);
  for (const name of ['codex', 'codex.cmd', 'codex.bat', 'codex.ps1', 'codex.exe.cmd']) {
    const script = await file('scripts', name);
    assert.equal(codexBinary({ FAI_CODEX_BIN: script, PATH: '' }, windows), null);
  }
  assert.equal(codexBinary({ PATH: join(dir, 'scripts') }, windows), null);
  assert.equal(codexBinary({ FAI_CODEX_BIN: 'codex.exe', PATH: dirname(exe) }, windows), null,
    'an invalid explicit override fails closed instead of choosing another binary');
  assert.equal(codexBinary({ FAI_CODEX_BIN: join(dir, 'missing.exe') }, windows), null);
  const directory = join(dir, 'directory.exe');
  await mkdir(directory);
  assert.equal(codexBinary({ FAI_CODEX_BIN: directory }, windows), null);
  const privateExe = await file('WindowsApps', 'OpenAI.Codex', 'codex.exe');
  assert.equal(codexBinary({ FAI_CODEX_BIN: privateExe }, windows), null);
  assert.equal(codexBinary({ PATH: dirname(privateExe) }, windows), null);
});

test('Windows Codex lookup: global and local npm, hoisted and nested platform packages', async t => {
  for (const local of [false, true]) {
    for (const nested of [false, true]) {
      const { dir, file } = await fixture(t);
      const modules = join('prefix', 'node_modules');
      const shimDir = local ? join(modules, '.bin') : 'prefix';
      await file(shimDir, 'codex.cmd');
      const root = nested ? join(modules, '@openai', 'codex', 'node_modules') : modules;
      const exe = await file(root, '@openai', 'codex-win32-x64', 'vendor',
        'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
      const env = { PATH: join(dir, shimDir) };
      assert.equal(codexBinary(env, windows), exe, `local=${local}, nested=${nested}`);
      const onPath = await file('standalone', 'codex.EXE');
      assert.equal(codexBinary({ PATH: `${env.PATH};${dirname(onPath)}` }, windows), onPath,
        'PATH executable takes precedence over npm package');
    }
  }
});

test('Codex with only command shims reports codex_not_found and never executes the shim', async t => {
  const { dir, file } = await fixture(t);
  for (const name of ['codex.cmd', 'codex.bat', 'codex.ps1']) await file(name);
  const env = { PATH: dir };
  assert.equal(codexBinary(env, windows), null);
  assert.equal(wakeReason({ host: 'codex', env }), 'codex_not_found');
  assert.equal(await codexSupportsQueue(env), false);
  assert.equal((await deliverCodexQueue({ env, threadId: '01a1c03e-9e28-72a2-8cdb-bb6ca9545521', text: '100% & "x"' })).code,
    'no_codex');
});
