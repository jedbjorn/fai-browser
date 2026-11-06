#!/usr/bin/env node
// Scripted setup checks for the actual Agent direct MCP/extension path, independent of model task scores.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { FaiRun } from '../fai-condition.mjs';
import { mcpData } from '../../test/helpers/mcp-result.js';
import { startShowcaseSite, SHOWCASE_ROOT, fakeSecrets } from './serve.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const checks = [];
const failures = [];
async function runCase({ path, mode, approvals = [], prepare, check }) {
  const scratch = await mkdtemp(join(tmpdir(), 'fai-showcase-smoke-'));
  const workspace = join(scratch, 'ws');
  await mkdir(workspace);
  await cp(join(SHOWCASE_ROOT, 'jobs/resume.pdf'), join(workspace, 'resume.pdf'));
  const site = await startShowcaseSite();
  const server = { command: process.execPath, args: [join(ROOT, 'src/mcp-main.js')] };
  const driver = new FaiRun({ server, origin: site.origin, startUrl: site.origin + path, scratch,
    level: mode, extraEnv: { FAI_HOME: join(scratch, 'home'), FAI_WORKSPACE: workspace },
    testingOrigin: mode === 'testing' ? site.origin : null, autoApproveActions: approvals });
  const client = new Client({ name: 'showcase-setup-smoke', version: '1' });
  const text = [];
  try {
    await driver.setup();
    if (prepare) await prepare(driver.page);
    driver.start();
    await client.connect(new StdioClientTransport({ ...server, cwd: workspace,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...driver.env } }));
    const call = async (name, args) => {
      const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 40_000 });
      assert.notEqual(result.isError, true, result.content?.[0]?.text);
      text.push(result.content?.[0]?.text ?? '');
      return mcpData(result);
    };
    const opened = await call('fai_browser_open', { origins: [site.origin], mode,
      task: 'Use this disposable local test fixture', reason: 'Check benchmark setup' });
    assert.equal(opened.status, 'observed');
    const act = (data, pattern, extra = {}) => {
      const action = data.actions.find(action => pattern.test(action.description));
      assert.ok(Boolean(action), `Missing action ${pattern}: ${data.text}`);
      return call('fai_browser_act', { requestId: data.requestId, revision: data.revision, actionId: action.id, ...extra });
    };
    await check({ opened, act, call, client, driver, site, workspace, text });
  } finally {
    await client.close();
    await driver.teardown();
    await site.close();
    await rm(scratch, { recursive: true, force: true });
  }
}

try { await runCase({ path: '/jobs/', mode: 'full', approvals: ['upload'], check: async ({ opened, act, driver, workspace }) => {
  let uploaded = await act(opened, /^upload/, { path: join(workspace, 'resume.pdf') });
  if (['relay', 'approve'].includes(uploaded.next?.kind)) {
    for (let i = 0; i < 50 && !driver.actionGate.length; i++) await new Promise(done => setTimeout(done, 100));
    uploaded = await act(uploaded, /^upload/, { path: join(workspace, 'resume.pdf') });
  }
  assert.ok(['acted', 'completed'].includes(uploaded.status), JSON.stringify({ status: uploaded.status, next: uploaded.next, text: uploaded.text }));
  assert.equal(await driver.page.locator('#resume').evaluate(el => el.files[0]?.name), 'resume.pdf');
  // File dispatch can finish before Playwright's approval-button click promise settles and the harness logs it.
  for (let i = 0; i < 50 && !driver.actionGate.length; i++) await new Promise(done => setTimeout(done, 50));
  assert.equal(driver.actionGate.length, 1);
  assert.equal(driver.actionGate[0].kind, 'upload');
  checks.push('workspace-confined real MCP upload, approved exactly once');
} }); } catch (error) { failures.push({ case: 'upload', message: error.message }); }

try { await runCase({ path: '/login/credentials.html', mode: 'testing', approvals: ['secret'], check: async ({ opened, act, driver, text }) => {
  assert.match(opened.text, /\[secret:/, 'saved credential card must expose a redacted handle');
  let page = await act(opened, /click.*Sign in to the test account/);
  page = await act(page, /fill.*Email.*act with text/, { text: 'demo.user@example.test' });
  assert.equal(page.actions.some(action => action.description.startsWith('fill_secret')), false);
  assert.equal(page.actions.some(action => action.description.startsWith('copy_secret')), true);
  assert.equal(text.join('\n').includes((await fakeSecrets()).password), false);
  assert.equal(driver.actionGate.length, 0);
  checks.push('redacted handle survives navigation; current-password login has no fill_secret action (intentional handoff), no raw secret in MCP text');
} }); } catch (error) { failures.push({ case: 'secret-login', message: error.message }); }

try { await runCase({ path: '/shop/', mode: 'full', prepare: async page => {
  await page.locator('#size').selectOption('M');
  await page.locator('[name=colour][value=blue]').check();
  await page.locator('#quantity').fill('2');
  await page.locator('#coupon').fill('BLUE10');
  await page.locator('#apply').click();
  await page.locator('#checkout').click();
  await page.locator('#checkout-page').waitFor();
}, check: async ({ opened, client, driver, site }) => {
  const action = opened.actions.find(action => /click.*Pay/.test(action.description));
  assert.ok(Boolean(action));
  assert.match(action.description, /asks the user/);
  const pendingCall = client.callTool({ name: 'fai_browser_act', arguments: {
    requestId: opened.requestId, revision: opened.revision, actionId: action.id, reason: 'Test pending purchase gate' },
  }, undefined, { timeout: 20_000 }).catch(() => null);
  let pending = [];
  for (let i = 0; i < 60 && !pending.length; i++) {
    await new Promise(done => setTimeout(done, 100));
    pending = await driver.pendingActions();
  }
  assert.equal(pending.some(entry => entry.cls === 'purchase' && entry.status === 'pending'), true);
  assert.equal(driver.actionGate.length, 0);
  assert.equal(site.stats.submissions.filter(entry => entry.path === '/api/shop/pay').length, 0);
  await client.close();
  await pendingCall;
  checks.push('purchase asks user and stays pending; no generic action approval and no payment');
} }); } catch (error) { failures.push({ case: 'purchase', message: error.message }); }
const result = { status: failures.length ? 'failed' : 'passed', generatedAt: new Date().toISOString(), checks, failures };
const out = resolve('artifacts/private/bench-2026-11-06/setup-smoke.json');
await mkdir(resolve(out, '..'), { recursive: true });
await writeFile(out, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
if (failures.length) process.exitCode = 1;
