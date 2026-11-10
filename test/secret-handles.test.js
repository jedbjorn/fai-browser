// Secret handles end to end (docs/REFERENCE.md "Secret handles"): an agent reads a key on one origin and pastes it
// into a field on another without ever seeing it. Headless Chromium with extension/page.js on two fixture origins,
// the real daemon and MCP server, test/helpers/vault-bridge.js in the extension worker's part. Checks the offer
// (`fill_secret "API key" ← secret:N`, never into a textarea, search box or comment field; `copy_secret`), Deny, an
// approved cross-origin fill and copy, and that no fake secret appears in any MCP message, trace, daemon file or
// screenshot (the leak scanner and the pixel check of test/secrets-e2e.test.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { headlessEnv } from '../scripts/headless-env.mjs';
import { createDaemon } from '../src/daemon.js';
import { createFakeHub } from './helpers/fake-hub.js';
import { spawnMcp } from './helpers/mcp-harness.js';
import { mcpData } from './helpers/mcp-result.js';
import { VaultBridge } from './helpers/vault-bridge.js';
import { leaks, loadFakes } from './helpers/secret-fakes.js';
import { startStaticSite } from './helpers/static-site.js';
import { pixelReport, startOffscreen } from './helpers/redacted-capture.js';

const F = loadFakes();
const ROOT = new URL('../fixtures/secrets/', import.meta.url).pathname;
let source;
let target;
let browser;
let offscreen;
test.before(async () => {
  source = await startStaticSite(ROOT);
  target = await startStaticSite(ROOT);
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true,
    env: headlessEnv(), args: ['--no-sandbox'] });
  offscreen = await startOffscreen(browser);
});
test.after(async () => {
  await offscreen?.close();
  await browser?.close();
  await source?.close();
  await target?.close();
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

async function pendingRequest(hub, seen = new Set()) {
  for (let i = 0; i < 400; i++) {
    const request = hub.published.at(-1)?.find(item => item.state === 'pending' && !seen.has(item.requestId));
    if (request) return request;
    await delay(5);
  }
  throw new Error('No pending request');
}

test('fill_secret across two origins: offered only into fields that take a secret, Deny stops, Approve pastes; nothing leaks', async t => {
  const home = await mkdtemp(join(tmpdir(), 'fai-handles-'));
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`${source.origin}/api-keys/`);
  const bridge = new VaultBridge(page, { level: 'reversible', offscreen });
  const hub = createFakeHub();
  hub.bridgeForTab = () => bridge;
  const daemon = createDaemon({ home, env: {}, port: 0, hub });
  await daemon.listen();
  const mcp = spawnMcp({ FAI_HOME: home, FAI_DAEMON_PORT: String(daemon.port), FAI_MCP_APPROVAL_WAIT_MS: '1000' });
  t.after(async () => {
    await mcp.close();
    await daemon.close();
    await page.close();
    await rm(home, { recursive: true, force: true });
  });
  await mcp.initialize();

  // Origin A: the key is read, redacted, and kept as a handle.
  const opening = mcp.callTool('fai_browser_open', { origins: [source.origin], reason: 'Read the OpenAI key name',
    task: 'Find the OpenAI key', mode: 'reversible' });
  const first = await pendingRequest(hub);
  await hub.approve(first.requestId, { level: 'reversible', origin: source.origin });
  const opened = mcpData(await opening);
  assert.equal(opened.status, 'observed', JSON.stringify(opened).slice(0, 500));
  const handle = JSON.stringify(opened).match(/\[secret:(\d+) openai sk-proj-…Yz56 len 64\]/)?.[1];
  assert.ok(handle, 'the key has a handle');
  assert.ok(opened.actions.some(action => action.description.startsWith(`copy_secret secret:${handle} (openai key from `)),
    JSON.stringify(opened.actions.map(action => action.description)));

  // Origin B: a second request; the handle carries over.
  await page.goto(`${target.origin}/deploy.html`);
  const second = mcp.callTool('fai_browser_open', { origins: [target.origin], reason: 'Paste the key into the project settings',
    task: 'Fill the API key field with the OpenAI key', mode: 'reversible' });
  const request = await pendingRequest(hub, new Set([first.requestId]));
  await hub.approve(request.requestId, { level: 'reversible', origin: target.origin });
  const deploy = mcpData(await second);
  assert.equal(deploy.status, 'observed', JSON.stringify(deploy).slice(0, 500));
  assert.match(deploy.revision, /^[0-9a-f-]+:\d+$/, deploy.text);
  const fills = deploy.actions.filter(action => action.description.startsWith('fill_secret'));
  const sourceHost = new URL(source.origin).host;
  const fill = fills.find(action => action.description === `fill_secret "API key" ← secret:${handle} (openai key from ${sourceHost}) (asks the user)`);
  assert.ok(fill, JSON.stringify(fills.map(action => action.description)));
  assert.equal(fill.needsApproval, 'secret');
  for (const label of ['Notes', 'Search projects', 'Comment', 'Key description', 'Contact email', 'Secret memo']) {
    assert.ok(!fills.some(action => action.description.includes(`"${label}"`)), `never into ${label}`);
  }

  // Deny: refused, stop; nothing filled.
  bridge.decide = 'denied';
  const denied = mcpData(await mcp.callTool('fai_browser_act', { requestId: request.requestId, actionId: fill.id, revision: deploy.revision,
    reason: 'The user asked me to paste their OpenAI key' }));
  assert.equal(denied.code, 'refused_action', JSON.stringify(denied).slice(0, 600));
  assert.equal(denied.next.kind, 'stop');
  assert.equal(await page.evaluate(() => document.getElementById('api').value), '');
  const asked = bridge.asked.at(-1);
  assert.deepEqual({ ...asked, target: undefined }, { target: undefined, revision: deploy.revision, cls: 'secret', kind: 'fill_secret', handle });

  // Approve: the value goes into the field; the agent sees the handle only.
  bridge.decide = 'approved';
  const again = mcpData(await mcp.callTool('fai_browser_observe', { requestId: request.requestId }));
  const fillAgain = again.actions.find(action => action.description === fill.description);
  const acted = mcpData(await mcp.callTool('fai_browser_act', { requestId: request.requestId, actionId: fillAgain.id, revision: again.revision,
    reason: 'The user asked me to paste their OpenAI key', returnImages: 'final' }));
  assert.equal(acted.status, 'acted', JSON.stringify(acted).slice(0, 800));
  assert.match(acted.page.digest.join('\n'), new RegExp(`Preview: \\[secret:${handle} openai`), 'the page echo shows the handle');
  assert.equal(await page.evaluate(() => document.getElementById('api').value), F.openai, 'the field holds the key');
  assert.ok(!acted.actions.some(action => action.description.includes('"API key" ←')), 'a filled field is not offered again');

  // Copy: onto the clipboard, approved.
  const copy = acted.actions.find(action => action.description.startsWith(`copy_secret secret:${handle} `));
  assert.ok(copy, JSON.stringify(acted.actions.map(action => action.description)));
  const copied = mcpData(await mcp.callTool('fai_browser_act', { requestId: request.requestId, actionId: copy.id, revision: acted.revision }));
  assert.notEqual(copied.status, 'failed', JSON.stringify(copied).slice(0, 600));
  assert.deepEqual(bridge.clipboard, [F.openai]);

  const runId = acted.runId ?? acted.evidence?.runId;
  if (runId) await mcp.callTool('fai_browser_evidence', { runId, kind: 'trace' });
  await mcp.callTool('fai_browser_release', { requestId: request.requestId });
  await mcp.callTool('fai_browser_release', { requestId: first.requestId });

  const messages = JSON.stringify(mcp.messages);
  assert.deepEqual(leaks(messages), [], 'MCP messages');
  assert.match(messages, new RegExp(`secret:${handle}`));
  assert.doesNotMatch(messages, /__faiVault/);
  const images = [...messages.matchAll(/"type":"image","data":"([A-Za-z0-9+/=]+)","mimeType":"(image\/(?:jpeg|png))"/g)];
  assert.ok(images.length >= 1, 'the host received a screenshot after the fill');
  for (const [, data, mime] of images) {
    const report = await pixelReport(offscreen, `data:${mime};base64,${data}`);
    assert.ok(report.green < 25, `${report.green} green pixels on a screenshot after the fill`);
  }
  for (const file of await files(home)) {
    if (/\.(?:jpe?g|png)$/.test(file)) continue;
    assert.deepEqual(leaks(await readFile(file, 'utf8')), [], file);
  }
  assert.deepEqual(leaks(mcp.stderr), [], 'MCP stderr');
});
