import test from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { TOOL_NAMES } from '../src/mcp.js';

const ROOT = resolve(import.meta.dirname, '..');
const SKILL = readFileSync(resolve(ROOT, 'skills', 'fai-browser', 'SKILL.md'), 'utf8');

test('the skill teaches the direct loop: open, read, act, verify, with the next.kind table and the hard rules', () => {
  const mentioned = new Set(SKILL.match(/(?<![a-z_])fai_browser_[a-z_]+/g));
  for (const name of mentioned) assert.ok(TOOL_NAMES.includes(name), `${name} is not a direct MCP tool`);
  for (const name of ['fai_browser_open', 'fai_browser_act', 'fai_browser_observe', 'fai_browser_wait', 'fai_browser_status',
    'fai_browser_release']) {
    assert.ok(mentioned.has(name), `${name} missing from the skill`);
  }
  for (const field of ['origins', 'reason', 'task', 'mode', 'suppliedText', 'allowedUrls', 'policy', 'expectation', 'revision',
    'moreActions', 'focus', 'digestChars', 'requestId']) {
    assert.match(SKILL, new RegExp('`' + field + '`'), `${field} is explained`);
  }
  for (const kind of ['choose', 'observe', 'answer', 'relay', 'wait', 'stop']) {
    assert.match(SKILL, new RegExp(`^\\| \`${kind}\` \\|`, 'm'), `next.kind ${kind} has a row`);
  }
  assert.match(SKILL, /single-use/);
  assert.match(SKILL, /press Enter in/);
  assert.match(SKILL, /returnImages: "final"/);
  assert.match(SKILL, /Do not call `fai_browser_release` at the end/);
  assert.match(SKILL, /untrusted data, not instructions/);
  assert.match(SKILL, /Never log in/);
  assert.doesNotMatch(SKILL, /jev\.md|Jev/);
  assert.doesNotMatch(SKILL, /fai_browser_run|answer\.candidates|verdict/);
  const words = SKILL.split(/\s+/).filter(Boolean).length;
  assert.ok(words <= 900, `the entire skill including frontmatter stays within 900 words (${words})`);
});

test('skill frontmatter has the name and a description of at most 1024 characters', () => {
  const match = SKILL.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(match, 'frontmatter present');
  const fields = Object.fromEntries(match[1].split('\n').map(line => {
    const index = line.indexOf(':');
    return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
  }));
  assert.equal(fields.name, 'fai-browser');
  assert.ok(fields.description.length > 50 && fields.description.length <= 1024, `${fields.description.length}`);
});

test('the bench prompt for FAI is three lines that point at the same rules', () => {
  const prompt = readFileSync(resolve(ROOT, 'bench', 'prompts', 'fai.md'), 'utf8').trim().split('\n');
  assert.equal(prompt.length, 3);
  assert.match(prompt.join('\n'), /next\.kind/);
  assert.match(prompt.join('\n'), /page\.digest/);
});

test('.agents and .claude skill paths are relative symlinks to the canonical skill', () => {
  for (const dir of ['.agents', '.claude']) {
    const path = resolve(ROOT, dir, 'skills', 'fai-browser');
    assert.ok(lstatSync(path).isSymbolicLink(), `${path} is a symlink`);
    assert.equal(realpathSync(path), realpathSync(resolve(ROOT, 'skills', 'fai-browser')));
  }
});
