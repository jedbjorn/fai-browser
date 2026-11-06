// Condition R ("real install") in the host bench: the Claude argv a user's install implies, the installer's server
// entry and skill in the workspace, the --condition values, and ToolSearch / Skill turns counted as host overhead
// rather than violations.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { claudeArgs, parseClaudeEvents } from '../bench/lib/claude.mjs';
import { conditionLabel, parseConditions } from '../bench/lib/hosts.mjs';
import { aggregate, markdownTable } from '../bench/lib/metrics.mjs';
import { installIntoWorkspace, REAL_SERVER_NAME, realInstallMcpConfig } from '../bench/lib/real-install.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const ev = value => JSON.stringify(value);
const asLines = lines => lines.map((text, i) => ({ at: i * 1000, text }));
const SERVER = { command: '/usr/bin/node', args: ['/x/src/mcp-main.js'], env: { FAI_BRIDGE_PORT: '1', FAI_DAEMON_DIR: '/d' } };

test('--condition: a, b, r, both, all and comma lists in A, B, R order; anything else is null', () => {
  assert.deepEqual(parseConditions(), ['a', 'b']);
  assert.deepEqual(parseConditions('both'), ['a', 'b']);
  assert.deepEqual(parseConditions('all'), ['a', 'b', 'r']);
  assert.deepEqual(parseConditions('r'), ['r']);
  assert.deepEqual(parseConditions('r, b'), ['b', 'r']);
  assert.equal(parseConditions('c'), null);
  assert.equal(parseConditions('b,x'), null);
  assert.equal(parseConditions(''), null);
  assert.equal(conditionLabel('r/claude:claude-sonnet-5-5:low'), 'R/claude:claude-sonnet-5-5:low');
});

test('R argv: default tools (no --tools ""), project settings for the skill, skills on, ToolSearch and Skill allowed', () => {
  const b = claudeArgs({ prompt: 'P', model: 'm', mcpConfigPath: '/x/mcp.json', serverName: 'fai' });
  const r = claudeArgs({ prompt: 'P', model: 'm', mcpConfigPath: '/x/mcp.json', serverName: REAL_SERVER_NAME,
    realInstall: true });
  const after = (argv, flag) => argv[argv.indexOf(flag) + 1];
  assert.equal(after(b, '--tools'), '');
  assert.ok(b.includes('--disable-slash-commands'));
  assert.ok(!r.includes('--tools'), 'R keeps Claude Code\'s default tools, ToolSearch included');
  assert.ok(!r.includes('--disable-slash-commands'), 'R keeps skills');
  assert.equal(after(r, '--setting-sources'), 'project', 'project skills load; user and local settings stay off');
  assert.equal(after(r, '--allowedTools'), 'mcp__fai-browser__*,ToolSearch,Skill');
  assert.equal(after(r, '--disallowedTools'), 'Bash,WebSearch,WebFetch');
  assert.equal(JSON.parse(after(r, '--settings')).autoMemoryEnabled, false);
  for (const flag of ['--strict-mcp-config', '--no-session-persistence', '--no-chrome']) {
    assert.ok(r.includes(flag), flag);
  }
  assert.deepEqual(r.slice(0, 2), ['-p', 'P']);
});

test('R server entry is the installer\'s Claude entry plus the run env, per --real-tools', () => {
  // Default "run": what install --host claude writes, no server-wide key (fai_browser_run is eager through _meta).
  assert.deepEqual(realInstallMcpConfig(SERVER).mcpServers[REAL_SERVER_NAME], { type: 'stdio', ...SERVER });
  assert.deepEqual(realInstallMcpConfig(SERVER, { tools: 'eager' }).mcpServers[REAL_SERVER_NAME],
    { type: 'stdio', ...SERVER, alwaysLoad: true });
  assert.equal(realInstallMcpConfig(SERVER, { tools: 'deferred' }).mcpServers[REAL_SERVER_NAME].alwaysLoad, false);
  assert.equal(realInstallMcpConfig({ command: 'c' }).mcpServers[REAL_SERVER_NAME].env, undefined);
  assert.throws(() => realInstallMcpConfig(SERVER, { tools: 'lazy' }), /--real-tools/);
});

test('R workspace holds the real installer\'s .mcp.json and skill', async t => {
  const workdir = await mkdtemp(join(tmpdir(), 'fai-bench-real-'));
  t.after(() => rm(workdir, { recursive: true, force: true }));
  await installIntoWorkspace(workdir);
  const config = JSON.parse(readFileSync(join(workdir, '.mcp.json'), 'utf8'));
  assert.equal('alwaysLoad' in config.mcpServers[REAL_SERVER_NAME], false);
  const skill = readFileSync(join(workdir, '.claude', 'skills', 'fai-browser', 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: fai-browser\n/);
  assert.ok(skill.includes(readFileSync(join(ROOT, 'skills', 'fai-browser', 'SKILL.md'), 'utf8').split('---\n')[2]));

  const eager = await mkdtemp(join(tmpdir(), 'fai-bench-real-'));
  t.after(() => rm(eager, { recursive: true, force: true }));
  await installIntoWorkspace(eager, { tools: 'eager' });
  assert.equal(JSON.parse(readFileSync(join(eager, '.mcp.json'), 'utf8')).mcpServers[REAL_SERVER_NAME].alwaysLoad, true);
  assert.ok(existsSync(join(eager, '.claude', 'skills', 'fai-browser', 'SKILL.md')));
});

test('in R, ToolSearch, the fai-browser Skill and a Read of its SKILL.md are overhead; in B they stay violations', () => {
  const usage = { input_tokens: 1, output_tokens: 1 };
  const lines = [
    ev({ type: 'system', subtype: 'init', session_id: 's', mcp_servers: [{ name: REAL_SERVER_NAME, status: 'connected' }],
      skills: ['fai-browser'] }),
    ev({ type: 'assistant', message: { id: 'm1', usage, content: [
      { type: 'tool_use', id: 't1', name: 'ToolSearch', input: { query: 'select:mcp__fai-browser__fai_browser_run' } }] } }),
    ev({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'loaded' }] } }),
    ev({ type: 'assistant', message: { id: 'm2', usage, content: [
      { type: 'tool_use', id: 't2', name: 'Skill', input: { skill: 'fai-browser' } },
      { type: 'tool_use', id: 't6', name: 'Skill', input: { skill: 'other' } }] } }),
    ev({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'skill text' },
      { type: 'tool_result', tool_use_id: 't6', content: 'other' }] } }),
    ev({ type: 'assistant', message: { id: 'm3', usage, content: [
      { type: 'tool_use', id: 't3', name: 'Read', input: { file_path: '/ws/.claude/skills/fai-browser/SKILL.md' } },
      { type: 'tool_use', id: 't4', name: 'Read', input: { file_path: '/ws/notes.txt' } }] } }),
    ev({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't3', content: 'x' },
      { type: 'tool_result', tool_use_id: 't4', content: 'y' }] } }),
    ev({ type: 'assistant', message: { id: 'm4', usage, content: [
      { type: 'tool_use', id: 't5', name: 'mcp__fai-browser__fai_browser_run', input: { instruction: 'i' } }] } }),
    ev({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't5', content: 'ok' }] } }),
    ev({ type: 'assistant', message: { id: 'm5', usage, content: [{ type: 'text', text: 'ANSWER: 1' }] } }),
    ev({ type: 'result', subtype: 'success', usage, num_turns: 5, result: 'ANSWER: 1' }),
  ];
  const serverAlias = { [REAL_SERVER_NAME]: 'fai_browser' };
  const parsed = parseClaudeEvents(asLines(lines), { serverAlias, realInstall: true });
  assert.deepEqual(parsed.hostToolUses, { ToolSearch: 1, Skill: 2 });
  assert.equal(parsed.commandExecutions, 2, 'the unrelated Read and the other skill are violations');
  assert.equal(parsed.toolCalls, 1);
  assert.deepEqual(parsed.toolCallsByName, { ToolSearch: 1, Skill: 2, Read: 2, 'fai_browser.fai_browser_run': 1 });
  // Condition B: no overhead category; every built-in tool use, ToolSearch included, is a violation as before.
  const b = parseClaudeEvents(asLines(lines), { serverAlias });
  assert.deepEqual(b.hostToolUses, {});
  assert.equal(b.commandExecutions, 5);
  assert.equal(parsed.requests, 5, 'the ToolSearch and skill turns are host requests');
  assert.deepEqual(parsed.claude.skills, ['fai-browser']);
});

test('R gets its own rows, an R/B ratio and a host-matrix block in the summary', () => {
  const host = 'claude:claude-sonnet-5-5:low';
  const record = (condition, requests) => ({
    taskId: 't', condition: `${condition}/${host}`, host, hostVendor: 'claude', rep: 1, outcome: 'ok', pass: true,
    passLoose: true, wallMs: 1000 * requests, toolCalls: 1, requests, tokens: { input: 10, cachedInput: 0, output: 1,
      total: 11 }, cost: { usd: 0.01 * requests },
  });
  const conditions = [`b/${host}`, `r/${host}`];
  const summary = aggregate([record('b', 2), record('r', 4)], ['t'], conditions, {});
  const ratio = summary.ratios.find(item => item.over === `r/${host}`);
  assert.equal(ratio.under, `b/${host}`);
  assert.equal(ratio.requests, 2, 'R needed twice the requests of B');
  const table = markdownTable(summary, ['t'], conditions);
  assert.match(table, /R FAI Browser, real Claude Code install/);
});
