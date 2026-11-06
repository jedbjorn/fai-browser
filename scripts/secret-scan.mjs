#!/usr/bin/env node
// Offline publication audit. Never reads ignored files or follows symlinks.
import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const ROOT = resolve(import.meta.dirname, '..');

// The root .gitignore uses comments, !, / anchoring, directory suffixes, *, **
// and ?. Fail closed for other syntax rather than silently misreading a rule.
export function compileIgnore(source) {
  const rules = source.split(/\r?\n/).flatMap((line, index) => {
    if (!line || line.startsWith('#')) return [];
    if (/[\\\[\]]/.test(line) || line.trim() !== line) {
      throw new Error(`Unsupported ignore syntax at line ${index + 1}`);
    }
    const negate = line.startsWith('!');
    let pattern = negate ? line.slice(1) : line;
    const directory = pattern.endsWith('/');
    if (directory) pattern = pattern.slice(0, -1);
    const anchored = pattern.startsWith('/') || pattern.includes('/');
    pattern = pattern.replace(/^\//, '');
    let regex = '';
    for (let i = 0; i < pattern.length; i++) {
      const ch = pattern[i];
      if (ch === '*' && pattern[i + 1] === '*') {
        i++;
        if (pattern[i + 1] === '/') { regex += '(?:.*/)?'; i++; }
        else regex += '.*';
      } else if (ch === '*') regex += '[^/]*';
      else if (ch === '?') regex += '[^/]';
      else regex += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    return [{ negate, directory, regex: new RegExp(`${anchored ? '^' : '(?:^|/)'}${regex}$`) }];
  });
  return (path, directory = false) => {
    let ignored = false;
    for (const rule of rules) {
      if ((!rule.directory || directory) && rule.regex.test(path)) ignored = !rule.negate;
    }
    return ignored;
  };
}

// No credential lookup: pairing secrets are detected by shape or assignment.
// Detect the current publisher's home without embedding a maintainer's private path in the source.
const privateHome = homedir();
export function scanLine(line) {
  const rules = [];
  if (/\b(?:typesafe|jev|ts|sk)[_-](?:(?:live|test)[_-])?[A-Za-z0-9_-]{16,}\b/i.test(line)) rules.push('typesafe-jev-key');
  if (/\bbearer\s+[A-Za-z0-9._~+\/-]+=*/i.test(line)) rules.push('bearer-token');
  if (/(?<![A-Za-z0-9])[a-f0-9]{32,}(?![A-Za-z0-9])/i.test(line)) rules.push('long-hex');
  const chunks = [
    ...(line.match(/(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{32,}={0,2}(?![A-Za-z0-9+/=])/g) ?? []),
    ...(line.match(/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])/g) ?? [])
      .filter(chunk => (chunk.match(/[A-Z]/g)?.length ?? 0) >= 3 && (chunk.match(/[a-z]/g)?.length ?? 0) >= 3),
  ];
  if (chunks.some(chunk => {
    const counts = new Map();
    for (const c of chunk) counts.set(c, (counts.get(c) ?? 0) + 1);
    const entropy = [...counts.values()].reduce((s, n) => s - n / chunk.length * Math.log2(n / chunk.length), 0);
    return /[A-Z]/.test(chunk) && /[a-z]/.test(chunk)
      && (/[0-9+=]/.test(chunk) || entropy >= 4.5) && entropy >= 3.5;
  })) rules.push('long-base64-candidate');
  if (/\b(?:FAI_BRIDGE_SECRET|pairing[_-]?secret|bridge[_-]?secret)\b["'`]?\s*[:=]\s*["'`][^"'`\r\n]+["'`]/i.test(line)) rules.push('pairing-secret-literal');
  if (line.includes(privateHome)) rules.push('absolute-home-path');
  if (/\b[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}\b/.test(line)) rules.push('email');
  return rules;
}

const protectedPath = path => path.split('/').some(part =>
  part.startsWith('.env') || ['client-token', 'daemon.json', 'logs', 'artifacts'].includes(part));

export function publicationFiles(root = ROOT) {
  const ignored = compileIgnore(readFileSync(join(root, '.gitignore'), 'utf8'));
  const files = [];
  const findings = [];
  const walk = (dir = '') => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      if (ignored(path, entry.isDirectory())) continue;
      // Includes an allowed .env.example: flag for manual review, never open it.
      if (protectedPath(path)) {
        findings.push({ file: path, line: 1, rule: 'protected-file-review-required' });
        continue;
      }
      if (entry.isDirectory()) walk(path);
      else {
        const stat = lstatSync(join(root, path));
        files.push({ path, bytes: stat.size, symlink: entry.isSymbolicLink() });
        if (entry.name === '.gitignore' && dir) findings.push({ file: path, line: 1, rule: 'nested-ignore-review-required' });
      }
    }
  };
  walk();
  return { files, findings, bytes: files.reduce((sum, file) => sum + file.bytes, 0) };
}

export function audit(root = ROOT, { list = false } = {}) {
  const listing = publicationFiles(root);
  const findings = [...listing.findings];
  let binary = 0;
  for (const file of listing.files) {
    if (file.symlink) {
      findings.push({ file: file.path, line: 1, rule: 'symlink-review-required' });
      continue;
    }
    if (/^bench\/results\/[^/]+\/runs\.jsonl$/.test(file.path) && file.bytes >= 2_000_000) {
      findings.push({ file: file.path, line: 1, rule: 'runs-jsonl-at-least-2MB' });
    }
    if (list) continue;
    const data = readFileSync(join(root, file.path));
    // PNGs and other binaries require visual/manual review; do not decode them.
    if (data.includes(0) || data.subarray(0, 4).equals(Buffer.from([137, 80, 78, 71]))) { binary++; continue; }
    data.toString('utf8').split(/\r?\n/).forEach((line, index) => {
      for (const rule of scanLine(line)) findings.push({ file: file.path, line: index + 1, rule });
    });
  }
  return { ...listing, findings, binary };
}

function main() {
  if (process.argv.slice(2).some(arg => arg !== '--list')) throw new Error('Usage: node scripts/secret-scan.mjs [--list]');
  const list = process.argv.includes('--list');
  const result = audit(ROOT, { list });
  if (list) for (const file of result.files) console.log(`${file.path}\t${file.bytes} bytes`);
  for (const item of result.findings) console.log(`${item.file}:${item.line}: ${item.rule}`);
  console.log(`Would track: ${result.files.length} files, ${result.bytes} bytes (${(result.bytes / 1048576).toFixed(2)} MiB).`);
  console.log(`${result.findings.length} findings; ${result.binary} binary files require manual review. Ignored files were not opened.`);
  process.exitCode = result.findings.length ? 1 : 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); } catch { console.error('Publication scan failed; review the ignore rules and file access. No file contents printed.'); process.exitCode = 2; }
}
