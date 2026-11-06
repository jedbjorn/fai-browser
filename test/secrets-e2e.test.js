// Secret redaction end to end, on the fixtures/secrets pages in headless Chromium with extension/page.js:
// 1. Agent direct through the real MCP server and daemon: every MCP message (open, observe, act, evidence screenshot
//    and trace), every trace.json and the daemon log are scanned for every fake secret (raw, URL-encoded, base64 and
//    a chunk of it); none may appear, and the placeholders keep their numbers across observations and pages.
// 2. Jev delegation: the TypeSafe provider's request bodies (what would leave the machine), the run result and its
//    trace are scanned the same way.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { headlessEnv } from '../scripts/headless-env.mjs';
import { createDaemon } from '../src/daemon.js';
import { homePaths, saveDriver } from '../src/home.js';
import { BrowserRuntime } from '../src/runtime.js';
import { TypeSafeProvider } from '../src/typesafe.js';
import { writeRun } from '../src/trace.js';
import { createFakeHub } from './helpers/fake-hub.js';
import { ORIGIN, link } from './runtime-fixtures.js';
import { spawnMcp } from './helpers/mcp-harness.js';
import { mcpData } from './helpers/mcp-result.js';
import { SecretBridge } from './helpers/secret-bridge.js';
import { leaks, loadFakes } from './helpers/secret-fakes.js';
import { startStaticSite } from './helpers/static-site.js';
import { pixelReport, startOffscreen } from './helpers/redacted-capture.js';

const F = loadFakes();
let site;
let browser;
let offscreen;
test.before(async () => {
  site = await startStaticSite(new URL('../fixtures/secrets/', import.meta.url).pathname);
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true,
    env: headlessEnv(), args: ['--no-sandbox'] });
  offscreen = await startOffscreen(browser);
});
test.after(async () => {
  await offscreen?.close();
  await browser?.close();
  await site?.close();
});

async function files(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await files(path));
    else out.push(path);
  }
  return out;
}

async function pendingRequest(hub) {
  for (let i = 0; i < 400; i++) {
    const request = hub.published.at(-1)?.find(item => item.state === 'pending');
    if (request) return request;
    await delay(5);
  }
  throw new Error('No pending request');
}

test('Agent direct over MCP: no fake secret in any MCP message, trace or daemon log; stable placeholders', async t => {
  const home = await mkdtemp(join(tmpdir(), 'fai-secrets-'));
  const paths = homePaths({ home, env: {} });
  saveDriver('agent', paths);
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`${site.origin}/api-keys/?token=${F.jwt}`);
  // Real screenshots: every fake painted pure green, boxed by page.js, filled by extension/offscreen.js.
  const bridge = new SecretBridge(page, { level: 'reversible', offscreen });
  const hub = createFakeHub();
  hub.bridgeForTab = () => bridge;
  const daemon = createDaemon({ home, env: {}, port: 0, hub,
    providerFactory: () => { throw new Error('Agent direct never constructs a provider'); } });
  await daemon.listen();
  const mcp = spawnMcp({ FAI_HOME: home, FAI_DAEMON_PORT: String(daemon.port), FAI_MCP_APPROVAL_WAIT_MS: '1000' });
  t.after(async () => {
    await mcp.close();
    await daemon.close();
    await page.close();
    await rm(home, { recursive: true, force: true });
  });
  await mcp.initialize();

  const opening = mcp.callTool('fai_browser_open', {
    origins: [site.origin], reason: 'Check the API keys page', task: 'Open the environment page', mode: 'reversible',
  });
  const pending = await pendingRequest(hub);
  await hub.approve(pending.requestId, { level: 'reversible', origin: site.origin });
  const opened = mcpData(await opening);
  assert.equal(opened.status, 'observed', JSON.stringify(opened).slice(0, 500));
  const digest = JSON.stringify(opened);
  const key = digest.match(/\[secret:(\d+) openai sk-proj-…Yz56 len 64\]/);
  assert.ok(key, `a numbered placeholder in the result: ${digest.slice(0, 600)}`);
  assert.match(digest, /\?token=\[secret:\d+ jwt eyJ…/, 'the page URL is redacted');

  // A focused, larger digest (the new observe options) is scrubbed too, with the same numbers.
  const observed = mcpData(await mcp.callTool('fai_browser_observe', { requestId: pending.requestId, focus: 'secret key',
    digestChars: 6000 }));
  assert.ok(JSON.stringify(observed).includes(key[0]), 'the same number on the next observation');
  const copy = observed.actions.find(action => /Copy/.test(action.description));
  assert.match(copy.description, /\[secret:\d+ openai/, 'a control label is redacted');

  const env = observed.actions.find(action => action.description === 'click "Environment"');
  assert.ok(env, JSON.stringify(observed.actions.map(action => action.description)));
  const acted = mcpData(await mcp.callTool('fai_browser_act', { actionId: env.id, revision: observed.revision,
    requestId: pending.requestId, expectation: { urlIncludes: '/env/' }, returnImages: 'final' }));
  assert.equal(acted.status, 'completed', JSON.stringify(acted).slice(0, 800));
  assert.ok(JSON.stringify(acted).includes('[secret:'), JSON.stringify(acted).slice(0, 800));
  const runId = acted.runId ?? acted.evidence?.runId;
  assert.ok(runId, `the act names its run: ${Object.keys(acted)}`);
  await mcp.callTool('fai_browser_evidence', { runId });
  await mcp.callTool('fai_browser_evidence', { runId, kind: 'trace' });
  await mcp.callTool('fai_browser_status', {});
  await mcp.callTool('fai_browser_release', { requestId: pending.requestId });

  const messages = JSON.stringify(mcp.messages);
  assert.deepEqual(leaks(messages), [], 'MCP messages');
  assert.ok(messages.includes('[secret:'), 'placeholders reached the host');
  // Every evidence screenshot the host received passes the pixel check: no painted (green) secret survives.
  const images = [...messages.matchAll(/"type":"image","data":"([A-Za-z0-9+/=]+)","mimeType":"(image\/(?:jpeg|png))"/g)];
  assert.ok(images.length >= 1, 'the host received a screenshot');
  assert.ok(bridge.images.some(image => image.redactions > 0), 'the env page screenshot boxes secrets');
  assert.match(messages, /black box(?:es)? hide secrets on purpose/, 'the image caption says the boxes are deliberate');
  for (const [, data, mime] of images) {
    const report = await pixelReport(offscreen, `data:${mime};base64,${data}`);
    assert.ok(report.green < 25, `${report.green} green pixels on an evidence screenshot`);
  }
  assert.doesNotMatch(messages, /\[secret:~/, 'every tag numbered');
  for (const file of await files(home)) {
    if (/\.(?:jpe?g|png)$/.test(file)) continue;
    assert.deepEqual(leaks(await readFile(file, 'utf8')), [], file);
  }
  assert.deepEqual(leaks(mcp.stderr), [], 'MCP stderr');
});

test('Jev delegation: provider request bodies, the result and the trace carry no fake secret', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'fai-secrets-jev-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bodies = [];
  const provider = new TypeSafeProvider({ requireKey: false, keyEnv: 'FAI_UNUSED_TEST_KEY', endpoint: 'http://127.0.0.1:9/v1',
    fetchImpl: async (url, { body }) => {
      bodies.push(body);
      return new Response(JSON.stringify({ answers: {
        action: { choice: 'handoff' }, done: { noul: 0.9 }, blocked: { noul: 0.01 }, injection: { noul: 0.01 },
        commit: { noul: 0.01 }, answer: { choice: 'none' },
      } }));
    } });
  for (const path of ['/keys.html', '/env/', '/account.html', '/embedded.html', `/api-keys/?token=${F.jwt}`]) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    t.after(() => page.close());
    await page.goto(site.origin + path);
    await page.waitForTimeout(120);
    const bridge = new SecretBridge(page, { level: 'read-only' });
    const runtime = new BrowserRuntime({ bridge, provider });
    const raw = await runtime.run('Read the key names on this page', {
      mode: 'read-only', capture: 'none', allowedOrigins: [site.origin], answerQuestion: 'Which keys are listed?',
    });
    const written = await writeRun(raw, { dir, instruction: 'Read the key names on this page', operation: 'run' });
    assert.deepEqual(leaks(written.result), [], `${path}: result`);
    assert.deepEqual(leaks(await readFile(written.trace, 'utf8')), [], `${path}: trace`);
  }
  assert.ok(bodies.length >= 5, `${bodies.length} provider requests`);
  assert.deepEqual(leaks(bodies.join('\n')), [], 'provider request bodies');
  assert.ok(bodies.some(body => body.includes('[secret:')), 'the provider saw placeholders');
});

test('defense in depth: an extension that sent raw secrets (an older page script) still yields redacted MCP results', async t => {
  const pages = { '/': { title: `Keys ${F.github}`, text: `API key: ${F.genericKey}\nToken ${F.openai}\nCard ${F.card}`,
    controls: [link('1', `Copy ${F.stripe}`, `/copy?token=${F.jwt}`)] } };
  const home = await mkdtemp(join(tmpdir(), 'fai-secrets-raw-'));
  saveDriver('agent', homePaths({ home, env: {} }));
  const hub = createFakeHub({ bridgeOptions: { pages } });
  const daemon = createDaemon({ home, env: {}, port: 0, hub,
    providerFactory: () => { throw new Error('Agent direct never constructs a provider'); } });
  await daemon.listen();
  const mcp = spawnMcp({ FAI_HOME: home, FAI_DAEMON_PORT: String(daemon.port), FAI_MCP_APPROVAL_WAIT_MS: '1000' });
  t.after(async () => {
    await mcp.close();
    await daemon.close();
    await rm(home, { recursive: true, force: true });
  });
  await mcp.initialize();
  const opening = mcp.callTool('fai_browser_open', { origins: [ORIGIN], reason: 'Read keys', task: 'Read the page' });
  const pending = await pendingRequest(hub);
  await hub.approve(pending.requestId, { level: 'read-only' });
  assert.equal(mcpData(await opening).status, 'observed');
  await mcp.callTool('fai_browser_observe', { requestId: pending.requestId });
  const messages = JSON.stringify(mcp.messages);
  assert.deepEqual(leaks(messages), [], 'known formats, context keys, cards and signed links are redacted daemon-side');
  assert.match(messages, /\[secret:d\d+ github ghp_…IJkl len 40\]/);
  for (const file of await files(home)) assert.deepEqual(leaks(await readFile(file, 'utf8')), [], file);
});
