// FAI chats' attachments (spec #84 "Attachments", acceptance 10, the daemon part): 10 files a message and 25 MB each,
// with an 11th file and a 26 MB file refused; any type within the limits is kept; a name cannot leave the chat's
// files folder, never takes a name a program loads as instructions, and never writes through an existing file or
// link. Browserless.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_FILE_BYTES, WAITING_LIMIT, WAITING_MS, cleanFileName, createChatUploads } from '../src/chat-files.js';

const b64 = value => Buffer.from(value).toString('base64');

async function setup(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'fai-chat-files-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, uploads: createChatUploads({ dir: join(dir, 'waiting'), ...options }), filesDir: join(dir, 'files') };
}

test('file names: the last path component, cleaned for every OS, never empty, never a program\'s own file', () => {
  const cases = [
    ['../../etc/passwd', 'passwd'], ['C:\\Users\\me\\a.png', 'a.png'], ['..', 'file'], ['', 'file'], [null, 'file'],
    ['  .hidden  ', 'hidden'], ['trailing. . ', 'trailing'], ['CON', 'attached-CON'], ['lpt1.txt', 'attached-lpt1.txt'],
    ['AGENTS.md', 'attached-AGENTS.md'], ['claude.md', 'attached-claude.md'], ['CLAUDE.local.md', 'attached-CLAUDE.local.md'],
    ['opencode.jsonc', 'attached-opencode.jsonc'], ['a,b<c>:d|e?f*g".pdf', 'a_b_c__d_e_f_g_.pdf'],
    ['evil\u202egnp.exe', 'evilgnp.exe'], ['tab\there\nnew', 'tabherenew'], ['café.txt', 'café.txt'],

    // A device name followed by spaces or dots before the extension is still the device on Windows.
    ['con .txt', 'attached-con .txt'], ['CON  .txt', 'attached-CON .txt'], ['lpt1 .x', 'attached-lpt1 .x'],
    ['nul. .txt', 'attached-nul. .txt'], ['aux . .md', 'attached-aux . .md'], ['com\u00b9 .log', 'attached-com\u00b9 .log'],
    ['prn ', 'attached-prn'],
    // Near misses stay as they are.
    ['console.txt', 'console.txt'], ['con-x.txt', 'con-x.txt'], ['icon .txt', 'icon .txt'], ['con x.txt', 'con x.txt'],
    ['com10 .txt', 'com10 .txt'], ['nully .txt', 'nully .txt'],
  ];
  for (const [name, expected] of cases) assert.equal(cleanFileName(name), expected, JSON.stringify(name));
  const long = cleanFileName(`${'x'.repeat(300)}.png`);
  assert.equal(long.length, 100);
  assert.ok(long.endsWith('.png'), 'the extension is kept');
});

test('limits: 25 MB a file (26 MB refused), 10 a message (an 11th refused), any type kept as is', async t => {
  const ctx = await setup(t);
  const big = await ctx.uploads.add({ name: 'big.bin', data: Buffer.alloc(MAX_FILE_BYTES, 1).toString('base64') });
  await assert.rejects(ctx.uploads.add({ name: 'huge.bin', data: Buffer.alloc(26 * 1024 * 1024).toString('base64') }),
    { code: 'file_too_large' });
  await assert.rejects(ctx.uploads.add({ name: 'x', data: 'not base64!' }), { code: 'bad_request' });
  await assert.rejects(ctx.uploads.add({ name: '', data: b64('x') }), { code: 'bad_request' });
  const ids = [big.fileId];
  for (const name of ['a.exe', 'b.docx', 'c', 'd.sh', 'e.png', 'f.pdf', 'g.zip', 'h.txt', 'i.gif']) {
    ids.push((await ctx.uploads.add({ name, mime: 'application/x-anything', data: b64(name) })).fileId);
  }
  const extra = await ctx.uploads.add({ name: 'eleventh.txt', data: b64('11') });
  assert.throws(() => ctx.uploads.check([...ids, extra.fileId]), { code: 'too_many_files' });
  const ten = ctx.uploads.check(ids);
  assert.equal(ten.length, 10);
  const moved = await ctx.uploads.commit(ten, ctx.filesDir);
  assert.equal(moved[0].size, MAX_FILE_BYTES);
  assert.deepEqual((await readdir(ctx.filesDir)).sort(), ['a.exe', 'b.docx', 'big.bin', 'c', 'd.sh', 'e.png', 'f.pdf', 'g.zip',
    'h.txt', 'i.gif'], 'no type is checked or converted');
  assert.equal(await readFile(join(ctx.filesDir, 'd.sh'), 'utf8'), 'd.sh');
  assert.equal(moved[1].type, 'application/x-anything');
});

test('a message\'s files: no repeats, only ids still waiting and meant for this chat', async t => {
  const ctx = await setup(t);
  const a = await ctx.uploads.add({ chatId: 'c1', name: 'a.txt', data: b64('a') });
  assert.deepEqual(ctx.uploads.check(undefined), []);
  assert.throws(() => ctx.uploads.check('f1'), { code: 'bad_request' });
  assert.throws(() => ctx.uploads.check([a.fileId, a.fileId], 'c1'), { code: 'bad_request' });
  assert.throws(() => ctx.uploads.check([a.fileId], 'c2'), { code: 'unknown_file' });
  assert.throws(() => ctx.uploads.check(['f00000000000000000000'], 'c1'), { code: 'unknown_file' });
  assert.throws(() => ctx.uploads.check(['../x'], 'c1'), { code: 'unknown_file' });
  const [entry] = ctx.uploads.check([a.fileId], 'c1');
  await ctx.uploads.commit([entry], ctx.filesDir);
  assert.throws(() => ctx.uploads.check([a.fileId], 'c1'), { code: 'unknown_file' }, 'sent once');
  await assert.rejects(ctx.uploads.commit([entry], ctx.filesDir), { code: 'unknown_file' });
});

test('waiting files: at most 30, each for an hour; a new daemon starts with none', async t => {
  let clock = 1_000;
  const ctx = await setup(t, { now: () => clock });
  const first = await ctx.uploads.add({ name: 'a', data: b64('a') });
  for (let i = 1; i < WAITING_LIMIT; i++) await ctx.uploads.add({ name: `f${i}`, data: b64('x') });
  await assert.rejects(ctx.uploads.add({ name: 'one more', data: b64('x') }), { code: 'too_many_files' });
  clock += WAITING_MS + 1;
  assert.throws(() => ctx.uploads.check([first.fileId]), { code: 'unknown_file' }, 'expired');
  await ctx.uploads.add({ name: 'after', data: b64('x') });
  assert.equal(ctx.uploads.waiting(), 1, 'the expired ones are removed, from memory and disk');
  assert.equal((await readdir(join(ctx.dir, 'waiting'))).length, 1);
  const fresh = createChatUploads({ dir: join(ctx.dir, 'waiting') });
  await fresh.add({ name: 'b', data: b64('b') });
  assert.equal((await readdir(join(ctx.dir, 'waiting'))).length, 1, 'the previous daemon\'s waiting files are gone');
});

test('commit never writes through an existing file or link: the name is numbered instead', async t => {
  const ctx = await setup(t);
  await mkdir(ctx.filesDir, { recursive: true });
  const outside = join(ctx.dir, 'outside.txt');
  await writeFile(outside, 'keep me');
  try {
    await symlink(outside, join(ctx.filesDir, 'note.txt'));
  } catch (error) {
    if (error.code !== 'EPERM') throw error;
    t.skip('symlinks need privileges here');
    return;
  }
  await writeFile(join(ctx.filesDir, 'note (2).txt'), 'taken');
  const file = await ctx.uploads.add({ name: 'note.txt', data: b64('new') });
  const [moved] = await ctx.uploads.commit(ctx.uploads.check([file.fileId]), ctx.filesDir);
  assert.equal(moved.name, 'note (3).txt');
  assert.equal(await readFile(outside, 'utf8'), 'keep me');
  assert.equal(await readFile(join(ctx.filesDir, 'note (2).txt'), 'utf8'), 'taken');
  assert.equal(await readFile(join(ctx.filesDir, 'note (3).txt'), 'utf8'), 'new');
});
