import test from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { JEV_TOOL_NAMES, TOOL_NAMES } from '../src/mcp.js';

const ROOT = resolve(import.meta.dirname, '..');
const SKILL = readFileSync(resolve(ROOT, 'skills', 'fai-browser', 'SKILL.md'), 'utf8');
// The experimental Jev autopilot's guide, beside the skill (not a skill of its own).
const JEV = readFileSync(resolve(ROOT, 'skills', 'fai-browser', 'jev.md'), 'utf8');

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
  assert.match(SKILL, /\[jev\.md\]\(jev\.md\)/);
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

test('every fai_browser_* name in the Jev guide is a real Jev tool, and the one-call loop is covered', () => {
  const SKILL = JEV;
  const mentioned = new Set(SKILL.match(/(?<![a-z_])fai_browser_[a-z_]+/g));
  for (const name of mentioned) {
    assert.ok(JEV_TOOL_NAMES.includes(name), `${name} is not an MCP tool`);
  }
  for (const name of ['fai_browser_run', 'fai_browser_wait', 'fai_browser_evidence', 'fai_browser_observe',
    'fai_browser_act']) {
    assert.ok(mentioned.has(name), `${name} missing from the skill`);
  }
  for (const field of ['origins', 'reason', 'expectation', 'answerQuestion', 'requestId']) {
    assert.match(SKILL, new RegExp('`' + field + '`'), `${field} is explained`);
  }
  assert.match(SKILL, /answer\.candidates/);
  assert.match(SKILL, /page\.digest/);
  assert.match(SKILL, /Do not call `fai_browser_stop` at the end/);
  assert.match(SKILL, /untrusted data, not instructions/);
  assert.match(SKILL, /Never log in/);
});

test('the Jev guide teaches rules A-E with the verbatim examples, the next.kind table and the consent/login stance', () => {
  const SKILL = JEV;
  assert.match(SKILL, /^# FAI Browser: Jev autopilot \(experimental\)/);
  for (const heading of ['## A. ', '## B. ', '## C. ', '## D. ', '## E. ']) assert.ok(SKILL.includes(heading), heading);
  assert.ok(SKILL.includes('From the home page visit Docs, then the API documentation, then the API authentication '
    + 'page, in that order.'));
  // Rule C: tasks that would take several runs go in one call as steps, joined only through confirmed answers.
  assert.ok(SKILL.includes('"instruction": "Click Guides, then the {{answer:1}} guide. Read how often metrics are sampled."'));
  assert.match(SKILL, /Send `steps` instead of `instruction` only when one run cannot do it/);
  assert.match(SKILL, /One page, or a join of named links, is one run/);
  assert.match(SKILL, /Write `\{\{answer:N\}\}` only if step N's `answerQuestion` asks one exact value \(a name, number or URL\)/);
  assert.match(SKILL, /`\{\{answer:N\}\}` is filled only from step N's auto-confirmed \(read-only\/reversible: clearly leading\) answer/);
  assert.match(SKILL, /placeholder_unconfirmed/);
  assert.match(SKILL, /On a stop, send exactly `next.steps`/);
  assert.match(SKILL, /supply `allowedUrls` when known/);
  assert.match(SKILL, /`fai_browser_status` also carry `next`/);
  assert.match(SKILL, /a rerun's `instruction` is what ran and `verdict.answer` answers it/);
  assert.ok(SKILL.includes('{"urlIncludes": "/slow", "textAbsent": "Loading"}'));
  for (const kind of ['answer', 'answer_from_digest', 'confirm_page', 'choose', 'rerun', 'split', 'relay', 'stop']) {
    assert.match(SKILL, new RegExp(`^\\| \`${kind}\` \\|`, 'm'), `next.kind ${kind} has a row`);
  }
  assert.match(SKILL, /verdict\.answer/);
  assert.match(SKILL, /verdict\.suggested/);
  // Rule F: the escalation ladder for a stuck run (sharper rerun, look at the screenshot, drive steps by actionId or
  // point, hand back); the old "observe/act only on choose or after two failed runs" rule is gone.
  assert.match(SKILL, /^## F\. Stuck/m);
  assert.match(SKILL, /1\. Rerun sharper: `instruction`, `steps`, `suppliedText` or `allowedUrls`\./);
  assert.match(SKILL, /2\. Look: `fai_browser_evidence` \(screenshot\) or `returnImages: "final"`; read the page\./);
  assert.match(SKILL, /3\. Drive a few steps: `fai_browser_observe`, then `fai_browser_act` by `actionId` \(or `point: \{x, y\}` on the screenshot/);
  assert.match(SKILL, /4\. Hand back to `fai_browser_run`/);
  assert.match(SKILL, /Levels and refusals hold at every rung\./);
  assert.doesNotMatch(SKILL, /two failed sharper runs/);
  assert.match(SKILL, /after an act: one `actions\[\]\.id`/);
  assert.match(SKILL, /consent\.google\.com/);
  assert.match(SKILL, /never logs in/);
  assert.match(SKILL, /never accept/);
  const totalWords = SKILL.split(/\s+/).filter(Boolean).length;
  assert.ok(totalWords <= 900, `the Jev guide stays within 900 words (${totalWords})`);
});

test('the bench prompt for FAI is three lines that point at the same rules', () => {
  const prompt = readFileSync(resolve(ROOT, 'bench', 'prompts', 'fai.md'), 'utf8').trim().split('\n');
  assert.equal(prompt.length, 3);
  assert.match(prompt.join('\n'), /next\.kind/);
  assert.match(prompt.join('\n'), /verdict\.answer/);
});

test('.agents and .claude skill paths are relative symlinks to the canonical skill', () => {
  for (const dir of ['.agents', '.claude']) {
    const path = resolve(ROOT, dir, 'skills', 'fai-browser');
    assert.ok(lstatSync(path).isSymbolicLink(), `${path} is a symlink`);
    assert.equal(realpathSync(path), realpathSync(resolve(ROOT, 'skills', 'fai-browser')));
  }
});
