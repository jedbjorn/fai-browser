#!/usr/bin/env node
// Copies the <secret-rules> block of src/secrets.js into extension/background.js (as is) and extension/page.js
// (indented two spaces inside its closure). test/secrets.test.js fails when the copies drift; run this after editing
// the rules in src/secrets.js.
import { readFileSync, writeFileSync } from 'node:fs';

const root = new URL('..', import.meta.url);
const START = '// <secret-rules>';
const END = '// </secret-rules>';

function block(text) {
  const start = text.indexOf(START);
  const end = text.indexOf(END);
  if (start < 0 || end < start) return null;
  return { start, end: end + END.length };
}

const source = readFileSync(new URL('src/secrets.js', root), 'utf8');
const span = block(source);
if (!span) throw new Error('src/secrets.js has no <secret-rules> block');
const rules = source.slice(span.start, span.end);

for (const [file, indent] of [['extension/background.js', ''], ['extension/page.js', '  ']]) {
  const path = new URL(file, root);
  const text = readFileSync(path, 'utf8');
  // The block in page.js starts after its two-space indent: the marker itself is matched without it.
  const target = block(text);
  if (!target) throw new Error(`${file} has no <secret-rules> block; add the two marker lines first`);
  const copy = rules.split('\n').map((line, i) => (i === 0 || !line ? line : indent + line)).join('\n');
  writeFileSync(path, text.slice(0, target.start) + copy + text.slice(target.end));
  console.log(`${file}: rules synced`);
}
