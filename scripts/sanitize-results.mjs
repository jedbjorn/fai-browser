#!/usr/bin/env node
// Rewrites the user's home directory to "~" inside the compact benchmark records that get published
// (bench/results/*/{config.json,runs.jsonl,summary.json,summary.md}). Raw run directories are not tracked, so they
// are left alone. Usage: node scripts/sanitize-results.mjs [--dry-run] [--root bench/results]
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const rootIndex = args.indexOf('--root');
const root = rootIndex >= 0 ? args[rootIndex + 1] : 'bench/results';
const home = homedir();
const files = ['config.json', 'runs.jsonl', 'summary.json', 'summary.md'];

let changed = 0;
let occurrences = 0;
for (const entry of readdirSync(root)) {
  const dir = join(root, entry);
  if (!statSync(dir).isDirectory()) continue;
  for (const name of files) {
    const path = join(dir, name);
    let text;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    const count = text.split(home).length - 1;
    if (!count) continue;
    occurrences += count;
    changed += 1;
    console.log(`${path}: ${count}`);
    if (!dryRun) writeFileSync(path, text.replaceAll(home, '~'));
  }
}
console.log(`${dryRun ? 'would rewrite' : 'rewrote'} ${occurrences} occurrence(s) in ${changed} file(s)`);
