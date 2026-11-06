// Site profiles through the daemon (experimental, opt-in): FAI_HOME/domains is matched by the lease origin only when the
// `profiles` run field or config.json key turns them on (body wins), the receipt and the trace show the profile, and the
// counters go to FAI_HOME/domain-stats, never next to the profile.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDaemon } from '../src/daemon.js';
import { createLogger, homePaths } from '../src/home.js';
import { ORIGIN } from './runtime-fixtures.js';
import { call, createFakeHub } from './helpers/fake-hub.js';

const INSTRUCTION = 'Visit About, then Members, then read the member names.';
const PROFILE = {
  schema: 1, id: 'example.com', version: 1, origins: [ORIGIN],
  pageTypes: {
    home: { label: 'home page', url: '/', checks: [{ heading: 'Home' }] },
    about: { label: 'about page', url: '/about', checks: [{ heading: 'About' }] },
    members: { label: 'member list', url: '/members', checks: [{ heading: 'Members' }], expect: ['/members'] },
  },
  edges: [
    { id: 'home->about', from: 'home', to: 'about', link: { label: 'About', href: '/about', hint: 'About' } },
    { id: 'about->members', from: 'about', to: 'members', link: { label: 'Members', href: '/members', hint: 'Members' } },
  ],
};

function clickingProvider() {
  const calls = [];
  return {
    calls,
    model: 'rec',
    async decide(observation, actions, context) {
      calls.push({ path: new URL(observation.url).pathname, context });
      const id = label => actions.find(action => action.label === label)?.id;
      const path = new URL(observation.url).pathname;
      if (path === '/') return { actionId: id('About'), confidence: 0.9, done: { probability: 0.05 } };
      if (path === '/about') return { actionId: id('Members'), confidence: 0.9, done: { probability: 0.05 } };
      return { actionId: 'handoff', confidence: 0.9, done: { probability: 0.95 } };
    },
    // The slim done-and-guards request the fast path sends for each page it leaves.
    async confirm() {
      return { done: { probability: 0.05 }, guards: { blocked: 0.05, injection: 0.05 } };
    },
  };
}

async function setup(t, { config, profile = PROFILE } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'fai-domains-daemon-'));
  if (config) await writeFile(join(home, 'config.json'), JSON.stringify(config));
  if (profile) {
    await mkdir(join(home, 'domains', 'example.com'), { recursive: true });
    await writeFile(join(home, 'domains', 'example.com', 'profile.json'), JSON.stringify(profile));
  }
  const hub = createFakeHub({ bridgeOptions: { path: '/' } });
  const env = { TYPESAFE_API_KEY: 'k-test' };
  const log = createLogger(homePaths({ home, env }));
  const provider = clickingProvider();
  const daemon = createDaemon({ driver: 'jev', home, env, port: 0, hub, log, sweepIntervalMs: 60_000, providerFactory: () => provider, warm: false });
  await daemon.listen();
  t.after(async () => {
    await daemon.close();
    log.close();
    await rm(home, { recursive: true, force: true });
  });
  const api = (method, path, body) => call(daemon.port, method, path, body, { token: daemon.token });
  const created = await api('POST', '/v1/requests', { origins: [ORIGIN], reason: 'Check' });
  await hub.approve(created.body.requestId);
  const run = extra => api('POST', '/v1/runs', {
    requestId: created.body.requestId, instruction: INSTRUCTION, expectation: { urlIncludes: '/members' }, maxActions: 6, ...extra,
  });
  return { home, provider, run };
}

test('daemon: profiles on applies FAI_HOME/domains; receipt, trace and stats show it; off by default', async t => {
  const plain = await setup(t);
  const unset = (await plain.run()).body.result;
  assert.equal(unset.site, undefined, 'experimental, opt-in: off unless turned on');
  // A bounded imperative (two named pages): the Members click passes, so no terminal decide (end-of-step guards).
  assert.equal(unset.cost.decisions, 2);
  const ctx = await setup(t);
  const response = await ctx.run({ profiles: 'on' });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const result = response.body.result;
  assert.equal(result.status, 'completed');
  assert.equal(result.cost.decisions, 1);
  assert.deepEqual(ctx.provider.calls.map(entry => entry.path), ['/members']);
  assert.deepEqual(result.site, { profile: 'example.com@1', fastSteps: 2, path: ['home->about', 'about->members'] });
  const trace = JSON.parse(await readFile(result.trace, 'utf8'));
  assert.deepEqual(trace.options.profiles, { fastPath: true, hints: true });
  assert.deepEqual(trace.steps.map(step => step.decision.by), ['profile', 'profile']);
  const stats = JSON.parse(await readFile(join(ctx.home, 'domain-stats', 'example.com.json'), 'utf8'));
  assert.equal(stats.fastSteps, 2);
  assert.equal(existsSync(join(ctx.home, 'domains', 'example.com', 'stats.json')), false);
});

test('daemon: profiles on in config.json applies; off in the body wins; bad values fail', async t => {
  const body = await setup(t);
  const off = (await body.run({ profiles: 'off' })).body.result;
  assert.equal(off.cost.decisions, 2);
  assert.equal(off.site, undefined);

  const configured = await setup(t, { config: { profiles: 'on' } });
  assert.equal((await configured.run()).body.result.site.fastSteps, 2);
  // Each run starts where the tab is: a fresh tab on the home page for the body's switch.
  const overridden = await setup(t, { config: { profiles: 'on' } });
  const no = (await overridden.run({ profiles: 'off' })).body.result;
  assert.equal(no.site, undefined);

  for (const bad of ['maybe', 1, { level: true }, { fastPath: 'yes' }]) {
    const response = await body.run({ profiles: bad });
    assert.equal(response.status, 400, JSON.stringify(bad));
  }
  // No profile for the origin: nothing changes.
  const none = await setup(t, { profile: null });
  const nothing = (await none.run({ profiles: 'on' })).body.result;
  assert.equal(nothing.cost.decisions, 2);
  assert.equal(nothing.site, undefined);
});
