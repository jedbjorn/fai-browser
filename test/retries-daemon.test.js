// In-call retries through the daemon, config.json, MCP and CLI: the `retry` run field and config key are validated,
// the default is on, both turn it off, the trace records the switches, the first attempt and every retry, and the MCP
// server never suggests an instruction a self-rerun already ran.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDaemon } from '../src/daemon.js';
import { createLogger, homePaths, loadConfig } from '../src/home.js';
import { ORIGIN } from './runtime-fixtures.js';
import { call, createFakeHub } from './helpers/fake-hub.js';
import { startStubDaemon } from './helpers/stub-daemon.js';
import { spawnMcp } from './helpers/mcp-harness.js';
import { mcpData } from './helpers/mcp-result.js';

const INSTRUCTION = 'Visit About, then Members, then read the member names.';

/** Clicks About on Home; hands off on About unless the instruction is the suggested rerun. */
function rerunProvider() {
  const calls = [];
  return {
    calls,
    model: 'rec',
    async decide(observation, actions, context) {
      calls.push({ context });
      const path = new URL(observation.url).pathname;
      const id = label => actions.find(action => action.label === label)?.id;
      if (path === '/') return { actionId: id('About'), confidence: 0.9, done: { probability: 0.05 } };
      if (path === '/about') {
        const rerun = context.instruction.startsWith('From the current page');
        return { actionId: rerun ? id('Members') : 'handoff', confidence: 0.9, done: { probability: 0.05 } };
      }
      return { actionId: 'done', confidence: 0.9, done: { probability: 0.9 } };
    },
  };
}

async function setup(t, { config } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'fai-retries-'));
  if (config) await writeFile(join(home, 'config.json'), JSON.stringify(config));
  const hub = createFakeHub({ bridgeOptions: { path: '/' } });
  const env = { TYPESAFE_API_KEY: 'k-test' };
  const log = createLogger(homePaths({ home, env }));
  const provider = rerunProvider();
  const daemon = createDaemon({ driver: 'jev', home, env, port: 0, hub, log, sweepIntervalMs: 60_000, providerFactory: () => provider,
    warm: false });
  await daemon.listen();
  t.after(async () => {
    await daemon.close();
    log.close();
    await rm(home, { recursive: true, force: true });
  });
  const api = (method, path, body) => call(daemon.port, method, path, body, { token: daemon.token });
  const created = await api('POST', '/v1/requests', { origins: [ORIGIN], reason: 'Check' });
  const requestId = created.body.requestId;
  await hub.approve(requestId);
  const run = extra => api('POST', '/v1/runs', {
    requestId, instruction: INSTRUCTION, expectation: { urlIncludes: '/members' }, answerQuestion: 'Who are the members?',
    maxActions: 6, ...extra,
  });
  return { api, provider, requestId, run };
}

test('daemon: retries are on by default; the receipt and the trace show the rerun and the first attempt', async t => {
  const ctx = await setup(t);
  const response = await ctx.run();
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const result = response.body.result;
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.retries.map(retry => [retry.kind, retry.why, retry.outcome]), [['rerun', 'handoff', 'expectation_passed']]);
  assert.ok(result.verdict.why.includes('retry:rerun'));
  const trace = JSON.parse(await readFile(result.trace, 'utf8'));
  assert.deepEqual(trace.options.retry, { secondOpinion: true, backOut: true, rerun: true });
  assert.equal(trace.attempts[0].code, 'handoff');
  assert.deepEqual(trace.cost.requests.map(entry => entry.attempt), [1, 1, 2, 2]);
  assert.equal(ctx.provider.calls.length, 4);
});

test('daemon: retry false in the body, or in config.json, hands the first outcome back; the body wins', async t => {
  const off = await setup(t);
  const plain = (await off.run({ retry: false })).body.result;
  assert.equal(plain.code, 'handoff');
  assert.equal(plain.retries, undefined);
  assert.equal(plain.next.kind, 'rerun');

  const configured = await setup(t, { config: { retry: false } });
  const viaConfig = (await configured.run()).body.result;
  assert.equal(viaConfig.code, 'handoff');
  const trace = JSON.parse(await readFile(viaConfig.trace, 'utf8'));
  assert.deepEqual(trace.options.retry, { secondOpinion: false, backOut: false, rerun: false });
  const override = (await configured.run({ retry: { rerun: true } })).body.result;
  assert.equal(override.status, 'completed');
});

test('daemon: an invalid retry value is a 400 before any provider call', async t => {
  const ctx = await setup(t);
  for (const retry of ['off', 1, [], { all: false }, { rerun: 'no' }]) {
    const bad = await ctx.run({ retry });
    assert.equal(bad.status, 400, JSON.stringify(retry));
    assert.equal(bad.body.error.code, 'invalid_options');
  }
  assert.equal(ctx.provider.calls.length, 0);
});

test('config.json retry is validated at load', async () => {
  const home = await mkdtemp(join(tmpdir(), 'fai-retries-config-'));
  try {
    const paths = homePaths({ home, env: {} });
    await writeFile(paths.config, JSON.stringify({ retry: { backOut: false } }));
    assert.deepEqual(loadConfig(paths).retry, { backOut: false });
    await writeFile(paths.config, JSON.stringify({ retry: 'never' }));
    assert.throws(() => loadConfig(paths), /config\.json retry must be a boolean or an object/);
    await writeFile(paths.config, JSON.stringify({ retry: { again: true } }));
    assert.throws(() => loadConfig(paths), /Unknown retry switch "again"/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('MCP: a self-rerun instruction counts as tried, and the text block lists the retries as trusted lines', async t => {
  const tried = 'From the current page, visit Members, in that order. Stop there.';
  const stub = await startStubDaemon({
    autoGrant: true,
    finalStatus: 'needs_host',
    finalCode: 'handoff',
    finalExtra: () => ({
      v: 2,
      retries: [{ kind: 'rerun', why: 'handoff', outcome: 'handoff', status: 'needs_host', instruction: tried, maxActions: 3 }],
      verdict: { kind: 'needs_decision', oversight: 'instruct', answer: null, why: ['handoff', 'retry:rerun'], decide: null,
        suggested: { instruction: tried, maxActions: 3 }, budget: null },
      next: { kind: 'rerun', text: 'x' },
    }),
  });
  const mcp = spawnMcp(stub.env({}));
  t.after(async () => {
    mcp.child.kill('SIGKILL');
    await stub.close();
  });
  await mcp.initialize();
  const run = await mcp.callTool('fai_browser_run', { origins: [ORIGIN], reason: 'Check', instruction: 'Open Members' });
  const structured = mcpData(run);
  assert.equal(structured.verdict.suggested, null, 'the instruction the rerun already ran is not suggested again');
  assert.ok(structured.verdict.why.includes('suggested_repeated'));
  assert.match(run.content[0].text, /^retries \(in this call\): rerun handoff -> handoff$/m);
  const lines = run.content[0].text.split('\n');
  assert.ok(lines.findIndex(line => line.startsWith('retries')) < lines.findIndex(line => /untrusted/i.test(line)),
    'retries are trusted lines, above the page text');
});
