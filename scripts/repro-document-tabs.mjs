// Isolated regression probe: email-style buttons opening an inline PDF or an attachment.
// Uses a disposable browser profile and test-only host access; never touches a personal browser.
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { createHub } from '../src/bridge.js';
import { headlessEnv } from './headless-env.mjs';
const root = resolve(import.meta.dirname, '..');
const scratch = await mkdtemp(join(tmpdir(), 'fai-document-tabs-'));
const extension = join(scratch, 'extension');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// A real, self-contained one-page PDF, including its byte offsets.
const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
const stream = 'BT /F1 16 Tf 20 100 Td (Email attachment fixture) Tj ET';
objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
let pdf = '%PDF-1.4\n';
const offsets = [0];
objects.forEach((object, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
const xref = pdf.length;
pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
const site = http.createServer((req, res) => {
  if (req.url.endsWith('.pdf')) {
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `${req.url.includes('attachment') ? 'attachment' : 'inline'}; filename="statement.pdf"` });
    res.end(pdf);
  } else {
    res.setHeader('Content-Type', 'text/html');
    res.end('<title>Mail fixture</title><h1>Attachments</h1><button onclick="window.open(\'/inline.pdf\')">View PDF</button><button onclick="window.open(\'/attachment.pdf\')">Download PDF</button>');
  }
});
let context, hub, server;
try {
  await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${site.address().port}`;
  await cp(join(root, 'extension'), extension, { recursive: true });
  const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
  manifest.host_permissions = ['<all_urls>'];
  await writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest));
  context = await chromium.launchPersistentContext(join(scratch, 'profile'), {
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, env: headlessEnv(),
    args: ['--no-sandbox', '--ozone-platform=x11', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = await worker.evaluate(() => chrome.runtime.id);
  const secret = 'disposable-document-fixture-secret';
  hub = createHub({ secret, extensionId, mode: 'companion' });
  let leaseId, status, reason;
  hub.onEvent(event => {
    if (event.type === 'hello') event.reply({ mode: 'companion' });
    if (event.type === 'lease') {
      leaseId = `fixture-${Date.now()}`;
      hub.bindLease({ leaseId, requestId: null, tabId: event.tabId, origin, allowedOrigins: [origin], level: event.level });
      status = 'active'; reason = null;
      event.reply({ leaseId, origins: [origin], grant: { tabMode: event.tabMode } });
    }
    if (event.type === 'status') { status = event.status; reason = event.reason; }
  });
  server = http.createServer((req, res) => { if (!hub.handleHttp(req, res)) { res.writeHead(404); res.end(); } });
  server.on('upgrade', (req, socket, head) => { if (!hub.handleUpgrade(req, socket, head)) socket.destroy(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const page = context.pages()[0];
  for (const tabMode of ['single', 'multiple']) {
    for (const label of ['View PDF', 'Download PDF']) {
      await page.goto(origin);
      await page.bringToFront();
      // Test harness stands in for the popup's explicit approval, on the disposable fixture only.
      await worker.evaluate(async ({ endpoint, secret, tabMode }) => {
        await startSession({ endpoint, secret, level: tabMode === 'multiple' ? 'full' : 'read-only' });
      }, { endpoint, secret, tabMode });
      const bridge = hub.bridgeFor(leaseId);
      const before = await bridge.observe();
      const button = before.controls.find(c => c.label === label);
      assert.ok(button, label);
      let error = null, outcome;
      try { outcome = await bridge.execute({ type: 'click', target: button.id }, before.revision); }
      catch (e) { error = { code: e.code, message: e.message }; }
      await sleep(500);
      console.log(JSON.stringify({ tabMode, label, status, reason, error, resultUrl: outcome?.observation?.url,
        tabs: await worker.evaluate(() => chrome.tabs.query({}).then(tabs => tabs.map(t => ({ url: t.url, active: t.active })))) }));
      assert.equal(status, 'active');
      if (tabMode === 'single') {
        assert.equal(error?.code, 'blocked_risky', 'Use must not click an attachment button');
        assert.equal(context.pages().length, 1, 'Use opened no extra tabs');
      }
      else {
        assert.equal(error, null);
        assert.equal(outcome.observation.url, label === 'View PDF' ? `${origin}/inline.pdf` : `${origin}/`);
      }
      await worker.evaluate(() => endSession('stopped', 'stopped'));
      for (const child of context.pages()) if (child !== page) await child.close();
    }
  }
} finally {
  await context?.close();
  await hub?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => site.close(resolve));
  await rm(scratch, { recursive: true, force: true });
}
