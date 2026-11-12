// No merge conflict markers left in the docs, the skill or the sources.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

async function files(dir, ext) {
  const out = [];
  for (const entry of await readdir(join(ROOT, dir), { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await files(path, ext));
    else if (ext.some(e => entry.name.endsWith(e))) out.push(path);
  }
  return out;
}

test('docs, skills and sources carry no merge conflict markers', async () => {
  const paths = [...await files('docs', ['.md']), ...await files('skills', ['.md']), ...await files('src', ['.js', '.ts']),
    'README.md', 'AGENTS.md'];
  for (const path of paths) {
    const text = await readFile(join(ROOT, path), 'utf8');
    assert.doesNotMatch(text, /^(<{7}|>{7}|={7})( |$)/m, path);
  }
});
