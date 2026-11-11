// Real Chromium, the real extension and a private daemon (issue #36 item 1): the request modal (arm.html) reports what
// happens to an approval to daemon.log: the modal shown, the click, and either the approval or why it failed. When the
// browser's site-access prompt does not answer, the click is not left waiting silently: the modal says where else to
// approve, gives the click up after a bound, and a late answer approves nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright-core';
import { headlessEnv } from '../scripts/headless-env.mjs';
import { createDaemon } from '../src/daemon.js';
import { createLogger, homePaths } from '../src/home.js';
import { FaiBrowserClient } from '../src/client.js';

const ROOT = resolve(import.meta.dirname, '..');
const sleep = ms => new Promise(done => setTimeout(done, ms));
const WAIT_MS = 6000;

async function until(predicate, ms = 10_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await sleep(50);
  }
}

// The extension in headless Chromium with a private daemon. `grant`: the manifest already holds http://127.0.0.1/*
// (as an allowed site-access prompt would), so permissions.request answers at once.
async function setup(t, { grant }) {
  const scratch = await mkdtemp(join(tmpdir(), 'fai-arm-events-'));
  const cleanup = [];
  t.after(async () => {
    for (const step of cleanup.reverse()) await step().catch(() => {});
    await rm(scratch, { recursive: true, force: true });
  });
  const site = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>Task</title><h1>Task page</h1>');
  });
  await new Promise(done => site.listen(0, '127.0.0.1', done));
  cleanup.push(() => new Promise(done => { site.closeAllConnections?.(); site.close(done); }));
  const origin = `http://127.0.0.1:${site.address().port}`;

  const extension = join(scratch, 'extension');
  await cp(join(ROOT, 'extension'), extension, { recursive: true });
  const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
  manifest.host_permissions = grant ? ['http://127.0.0.1/*'] : [];
  await writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest));
  const context = await chromium.launchPersistentContext(join(scratch, 'profile'), {
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    headless: true, env: headlessEnv(),
    args: ['--no-sandbox', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  cleanup.push(() => context.close());
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = await worker.evaluate(() => chrome.runtime.id);

  const home = join(scratch, 'home');
  const secret = randomBytes(24).toString('hex');
  const env = { FAI_BRIDGE_SECRET: secret, FAI_EXTENSION_ID: extensionId };
  const paths = homePaths({ home, env });
  const log = createLogger(paths);
  const daemon = createDaemon({ home, env, port: 0, log });
  await daemon.listen();
  cleanup.push(async () => { await daemon.close(); log.close(); });
  // The daemon is on 127.0.0.1 too: without the grant the worker reaches it over its own host permission only.
  // The site-access wait shortened for the test (storage.local siteAccessWaitMs; 45 s otherwise).
  await worker.evaluate(pairing => chrome.storage.local.set(pairing),
    { endpoint: `http://127.0.0.1:${daemon.port}`, secret, siteAccessWaitMs: WAIT_MS });
  assert.ok(await until(() => worker.evaluate(async () => (await chrome.storage.session.get('connection')).connection?.connected), 15_000),
    'the extension connects to the private daemon');
  const client = new FaiBrowserClient({ port: daemon.port, token: daemon.token, clientName: 'arm-events-test' });
  const created = await client.requestTab({ origins: [origin], mode: 'interactive', reason: 'Check the task page',
    url: `${origin}/task` });
  const prompt = await until(() => context.pages().find(page => page.url().includes('/arm.html')), 10_000);
  assert.ok(prompt, 'the request modal opened next to the page');
  await prompt.waitForSelector('#approve:not([disabled])', { timeout: 10_000 });
  const approvals = async () => (await readFile(paths.logFile, 'utf8')).split('\n').filter(Boolean)
    .map(line => JSON.parse(line)).filter(line => line.event === 'approval' && line.requestId === created.requestId);
  return { origin, worker, client, created, prompt, approvals };
}

test('arm.html: the modal shown, the click and the approval are logged to daemon.log', async t => {
  const { origin, client, created, prompt, approvals } = await setup(t, { grant: true });
  await prompt.click('#approve');
  const outcome = await client.wait({ requestId: created.requestId, maxMs: 10_000 });
  assert.equal(outcome.state, 'active');
  const steps = await until(async () => {
    const list = await approvals();
    return list.some(line => line.step === 'approved') ? list : null;
  }, 5000);
  assert.ok(steps, `approval events in daemon.log: ${JSON.stringify(await approvals())}`);
  assert.deepEqual(steps.map(line => `${line.surface}:${line.step}`), ['page_modal:shown', 'page_modal:attempt', 'page_modal:approved']);
  assert.ok(steps.every(line => line.origin === origin), 'only the origin, never the page URL');
});

test('arm.html: a site-access prompt that never answers is bounded, logged, and its late answer approves nothing', { timeout: 60_000 }, async t => {
  const { client, created, prompt, approvals } = await setup(t, { grant: false });
  // The browser's prompt stays unanswered (as an unseen Firefox prompt does): this page's request never settles, and
  // the test answers it late by hand.
  await prompt.evaluate(() => {
    globalThis.lateAnswer = null;
    chrome.permissions.request = () => new Promise(done => { globalThis.lateAnswer = done; });
  });
  await prompt.click('#approve');
  const status = () => prompt.evaluate(() => document.querySelector('#status').textContent);
  const hint = await until(async () => (/click the FAI Browser icon on the 127\.0\.0\.1:\d+ tab instead/.test(await status()) ? await status() : null), WAIT_MS);
  assert.ok(hint, `the modal says where else to approve while it waits: ${await status()}`);
  const gaveUp = await until(async () => (/nothing\s+was approved/.test(await status()) ? await status() : null), WAIT_MS + 5000);
  assert.ok(gaveUp, `the click is given up after the bound: ${await status()}`);
  assert.match(gaveUp, /FAI Browser icon on the 127\.0\.0\.1:\d+ tab/);
  assert.equal(await prompt.evaluate(() => document.querySelector('#approve').disabled), false, 'Approve can be clicked again');
  const steps = (await approvals()).map(line => `${line.step}:${line.reason}`);
  assert.deepEqual(steps, ['shown:null', 'attempt:null', 'waiting:site_access_pending', 'failed:site_access_timeout']);
  const view = (await client.status()).requests.find(item => item.requestId === created.requestId);
  assert.equal(view.state, 'pending');
  assert.equal(view.approval, 'toolbar', 'the agent is told to use the toolbar icon');

  // The prompt answers now ("Allow"): the given-up click approves nothing.
  await prompt.evaluate(() => globalThis.lateAnswer(true));
  await sleep(1500);
  assert.equal((await client.status()).requests.find(item => item.requestId === created.requestId).state, 'pending',
    'a late answer to a given-up click approves nothing');
});
