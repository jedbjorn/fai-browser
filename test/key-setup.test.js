import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { saveKey, saveSettings } from '../scripts/setup-key.mjs';
import { PACKAGE_ROOT, envFilePath } from '../src/paths.js';
import { sep } from 'node:path';

test('key setup atomically preserves config and sets 0600', async () => {
  const directory=await mkdtemp(join(tmpdir(),'fai-key-test-'));const path=join(directory,'.env.local');
  try {
    await writeFile(path,'# local\nFAI_EXTENSION_ID=example\nTYPESAFE_API_KEY="old-dummy"\n',{mode:0o644});
    await saveKey('dummy-disposable-key',path);
    assert.equal((await stat(path)).mode & 0o777,0o600);
    const content=await readFile(path,'utf8');assert.ok(content.includes('FAI_EXTENSION_ID=example'));assert.ok(content.includes('TYPESAFE_API_KEY="dummy-disposable-key"'));assert.ok(!content.includes('old-dummy'));
    assert.deepEqual(await readdir(directory),['.env.local']);
    await assert.rejects(saveKey('invalid\ninput',path));
    const child=spawnSync(process.execPath,['scripts/setup-key.mjs'],{encoding:'utf8',input:'should-not-be-accepted'});
    assert.equal(child.status,1);assert.ok(child.stderr.includes('interactive terminal'));assert.ok(!child.stdout.includes('should-not-be-accepted'));
  } finally { await rm(directory,{recursive:true,force:true}); }
});
test('setup saves extension pairing and key without losing other settings', async () => {
  const directory=await mkdtemp(join(tmpdir(),'fai-setup-test-'));const path=join(directory,'.env.local');
  try {
    await writeFile(path,'# retained\nOTHER_SETTING="yes"\nFAI_BRIDGE_SECRET="old-secret-long-enough-for-test"\n');
    await saveSettings({FAI_EXTENSION_ID:'a'.repeat(32),FAI_BRIDGE_SECRET:'b'.repeat(64),TYPESAFE_API_KEY:'dummy-key'},path);
    const content=await readFile(path,'utf8');
    assert.equal((await stat(path)).mode & 0o777,0o600);
    assert.match(content,/OTHER_SETTING="yes"/);
    assert.match(content,/FAI_EXTENSION_ID="a{32}"/);
    assert.match(content,/FAI_BRIDGE_SECRET="b{64}"/);
    assert.ok(!content.includes('old-secret-long-enough-for-test'));
    await assert.rejects(saveSettings({FAI_EXTENSION_ID:'invalid'},path));
    assert.deepEqual(await readdir(directory),['.env.local']);
  } finally { await rm(directory,{recursive:true,force:true}); }
});
test('setup and CLI share one .env.local location: the settings directory or FAI_HOME, never cwd or the checkout', () => {
  assert.equal(envFilePath({ HOME: '/home/u' }), '/home/u/.config/fai-browser/.env.local'.replace(/\//g, sep));
  assert.ok(!envFilePath({ HOME: '/home/u' }).startsWith(PACKAGE_ROOT));
  assert.equal(envFilePath({ FAI_HOME: '/tmp/fai-home' }), '/tmp/fai-home/.env.local');
});
