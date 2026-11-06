// bench/report/readme-chart.mjs: the README chart and table are generated from the checked-in all-hosts data.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const DATA = join(ROOT, 'bench', 'report', 'out', 'all-hosts', 'data.json');
const SCRIPT = join(ROOT, 'bench', 'report', 'readme-chart.mjs');
const HOSTS = ['GPT-6.1 Sol', 'GPT-6 Astra', 'Claude Opus 5.5', 'Claude Sonnet 5.5', 'GPT-6 Luna', 'GPT-5.6 Terra'];

test('readme chart: light/dark SVGs and Markdown table from data.json', { skip: !existsSync(DATA) && 'data.json absent' }, () => {
  const out = mkdtempSync(join(tmpdir(), 'fai-readme-chart-'));
  try {
    execFileSync(process.execPath, [SCRIPT, DATA, '--out', out], { stdio: 'pipe' });
    for (const theme of ['light', 'dark']) {
      const svg = readFileSync(join(out, `benchmark-${theme}.svg`), 'utf8');
      assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"[^>]*viewBox="0 0 1200 \d+"/);
      assert.match(svg, /<\/svg>\s*$/);
      assert.match(svg, /<title id="[^"]+">[^<]+<\/title>/);
      // Balanced elements: every opened text/tspan closes.
      for (const tag of ['text', 'tspan']) {
        assert.equal((svg.match(new RegExp(`<${tag}[ >]`, 'g')) ?? []).length, (svg.match(new RegExp(`</${tag}>`, 'g')) ?? []).length, tag);
      }
      for (const host of HOSTS) assert.ok(svg.includes(`>${host}<`), `${theme}: ${host}`);
      assert.ok(svg.includes('1.73×'), 'Terra wall ratio');
      assert.ok(svg.includes('2.28×'), 'Sonnet cost ratio');
      assert.ok(svg.includes('$0.00195') && svg.includes('$0.00140'), 'Luna dollar values printed');
      // README SVGs must not load anything external (the namespace URI is the only URL).
      assert.equal(svg.match(/https?:\/\//g).length, 1);
      assert.doesNotMatch(svg, /<image|@import|href=/);
    }
    assert.notEqual(readFileSync(join(out, 'benchmark-light.svg'), 'utf8'), readFileSync(join(out, 'benchmark-dark.svg'), 'utf8'));
    assert.ok(readFileSync(join(out, 'benchmark-dark.svg'), 'utf8').includes('#0d1117'));

    const table = readFileSync(join(out, 'benchmark-table.md'), 'utf8');
    const rows = table.split('\n').filter(line => line.startsWith('| ') && !line.startsWith('| Host') && !line.startsWith('| ---'));
    assert.equal(rows.length, 6);
    HOSTS.forEach((host, i) => assert.ok(rows[i].startsWith(`| ${host} |`), host));
    assert.ok(rows[5].includes('22.1 → 12.8') && rows[5].includes('1.73×'));
    assert.ok(rows[4].includes('23/24 → 24/24'));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
