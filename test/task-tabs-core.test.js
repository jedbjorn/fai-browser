import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserRuntime, checkActChoice } from '../src/runtime.js';
import { createHub } from '../src/bridge.js';
import { grantFor } from '../src/daemon.js';
import { TOOLS, validateSchema } from '../src/mcp.js';
import { pageExtras } from '../src/result.js';
import { FakeBridge, ORIGIN } from './runtime-fixtures.js';

class TabsBridge extends FakeBridge {
  async execute(action, revision, options, signal) {
    this.tabActions ??= [];
    if (['open_tab', 'switch_tab'].includes(action.type) && revision === this.observation.revision) this.tabActions.push(action);
    return super.execute(action.type === 'open_tab' ? { ...action, type: 'navigate_allowed_url' } : action,
      revision, options, signal);
  }
}

test('task tab grants default single and reject unknown modes', () => {
  assert.equal(grantFor('interactive', {}, 'now').tabMode, 'single');
  assert.equal(grantFor('interactive', {}, 'now', 'origin', 'multiple').tabMode, 'multiple');
  assert.equal(grantFor('interactive', {}, 'now', 'origin', 'unlimited'), null);
  assert.match(checkActChoice({ actions: [] }, { openTab: ORIGIN, url: ORIGIN }), /not both/);
  const schema = TOOLS.find(tool => tool.name === 'fai_browser_act').inputSchema;
  assert.equal(validateSchema(schema, { requestId: 'req_tabs', openTab: ORIGIN }), null);
  assert.ok(validateSchema(schema, { requestId: 'req_tabs', openTab: ORIGIN, tabMode: 'multiple' }));
});

test('tab ids take up to five digits (a 10000-call session can open more than 999 tabs over its life)', () => {
  const schema = TOOLS.find(tool => tool.name === 'fai_browser_act').inputSchema;
  assert.equal(validateSchema(schema, { tab: 't1000' }), null);
  assert.equal(validateSchema(schema, { tab: 't99999' }), null);
  assert.ok(validateSchema(schema, { tab: 't100000' }));
  const offer = { revision: 'r1', actions: [] };
  assert.equal(checkActChoice(offer, { tab: 't10000' }), null);
  assert.match(checkActChoice(offer, { tab: 't100000' }), /tab must be a tab id/);
  const tabs = [{ id: 't0', url: ORIGIN, title: 'Home' }, { id: 't1000', url: `${ORIGIN}/a`, title: 'A', current: true },
    { id: 't100000', url: `${ORIGIN}/b`, title: 'B' }];
  assert.deepEqual(pageExtras({ tabs }).tabs.map(tab => tab.id), ['t0', 't1000']);
});

test('single mode cannot open or switch even when act options try to elevate the observed grant', async () => {
  for (const choice of [{ openTab: `${ORIGIN}/about` }, { tab: 't1' }]) {
    const bridge = new TabsBridge();
    const runtime = new BrowserRuntime({ bridge });
    await runtime.observe({ mode: 'interactive', grant: { level: 'interactive' }, allowedOrigins: [ORIGIN] });
    const result = await runtime.act(choice, { grant: { level: 'interactive', tabMode: 'multiple' } });
    assert.equal(result.code, 'refused_action');
    assert.equal(bridge.executions.length, 0);
  }
});

test('multiple task tabs share URL origin and destructive-hop guards; stale explicit revision executes nothing', async () => {
  for (const [url, code] of [['https://unapproved.example/about', 'cross_origin'],
    ['file:///tmp/local', 'refused_action'], [`${ORIGIN}/delete`, 'refused_action']]) {
    const bridge = new TabsBridge();
    const runtime = new BrowserRuntime({ bridge });
    await runtime.observe({ mode: 'interactive', grant: { level: 'interactive', tabMode: 'multiple' }, allowedOrigins: [ORIGIN] });
    assert.equal((await runtime.act({ openTab: url })).code, code);
    assert.equal(bridge.executions.length, 0);
  }
  const bridge = new TabsBridge();
  const runtime = new BrowserRuntime({ bridge });
  const observed = await runtime.observe({ mode: 'read-only', grant: { level: 'read-only', tabMode: 'multiple' }, allowedOrigins: [ORIGIN] });
  bridge.version++;
  const stale = await runtime.act({ openTab: `${ORIGIN}/about` }, { revision: observed.observation.revision });
  assert.equal(stale.code, 'stale');
  assert.equal(bridge.tabActions?.length ?? 0, 0);
  await runtime.observe({ mode: 'read-only', grant: { level: 'read-only', tabMode: 'multiple' }, allowedOrigins: [ORIGIN] });
  const result = await runtime.act({ openTab: `${ORIGIN}/about` }, { expectation: { urlIncludes: '/about' } });
  assert.equal(result.status, 'completed');
  assert.equal(result.verification.passed, true);
  assert.equal(bridge.tabActions.length, 1);
  assert.equal(result.permissions.tabMode, 'multiple');
});

test('bridge refuses extra-tab commands after a live grant downgrade', async t => {
  const hub = createHub({ secret: 'test-tab-grant-secret-123456789', extensionId: 'a'.repeat(32) });
  t.after(() => hub.close());
  hub.bindLease({ leaseId: 'tab-test', tabId: 1, origin: ORIGIN, allowedOrigins: [ORIGIN], tabMode: 'multiple' });
  hub.setLeaseTabMode('tab-test', 'single');
  for (const action of [{ type: 'open_tab', url: ORIGIN }, { type: 'switch_tab', tab: 't1' }]) {
    await assert.rejects(hub.bridgeFor('tab-test').execute(action, 'r1'), error => error.code === 'blocked_risky');
  }
});
