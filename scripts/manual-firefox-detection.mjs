// Local detection-matrix check in the Firefox window the user approves. No Marionette, remote protocol, model, key,
// credential or third-party site is involved. Use a dedicated development/test profile with the Firefox add-on loaded
// and paired, then run `npm run detect:firefox`. FAI_HOME / FAI_DAEMON_PORT select the service as for every client.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { FaiBrowserClient } from '../src/client.js';
import { evaluateDetection, runDetectionMatrix } from './detection-matrix.mjs';

const root = resolve(import.meta.dirname, '..');
const approvalMs = Number(process.env.FAI_MANUAL_SMOKE_APPROVAL_MS) || 180_000;
const detector = await readFile(join(root, 'fixtures', 'detection', 'detector.html'), 'utf8');
let report = null;
const site = http.createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/report') {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 100_000) throw new Error('Detection report too large');
      }
      report = JSON.parse(body);
      res.writeHead(204);
      return res.end();
    }
    if (req.method === 'GET' && (req.url === '/' || req.url === '/detector.html')) {
      res.setHeader('Content-Type', 'text/html');
      return res.end(detector);
    }
    res.writeHead(404);
    res.end();
  } catch {
    res.writeHead(500);
    res.end();
  }
});
await new Promise(done => site.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${site.address().port}`;

let client = null;
let requestId = null;
let cleanupPromise;
function cleanup() {
  return cleanupPromise ??= (async () => {
    if (client && requestId) await client.release(requestId, 'manual Firefox detection finished').catch(() => {});
    await new Promise(done => {
      site.close(done);
      site.closeAllConnections();
    });
  })();
}
process.once('SIGINT', () => {
  cleanup().finally(() => process.exit(130));
});

try {
  client = await FaiBrowserClient.connect({ autoStart: true, clientName: 'manual-firefox-detection' });
  const created = await client.requestTab({ origins: [origin], mode: 'interactive', url: `${origin}/detector.html`,
    reason: 'Local Firefox compatibility check: click, fill, search, select and scroll on a detection fixture' });
  requestId = created.requestId;
  console.log(`\nFirefox detection fixture (loopback only; no Marionette or remote protocol)

Fixture: ${origin}/detector.html
1. Use the dedicated Firefox development/test profile, with this checkout's add-on loaded and paired.
2. Approve the request on the fixture tab at Act (interactive), using the FAI Browser icon.

Waiting up to ${Math.round(approvalMs / 1000)} s for your approval…`);
  const waited = await client.waitForTab(requestId, { timeoutMs: approvalMs });
  if (waited.state !== 'active') throw new Error(`The request was not approved (state: ${waited.state}).`);

  await runDetectionMatrix(client, requestId, origin);
  const deadline = Date.now() + 5_000;
  while (!report && Date.now() < deadline) await new Promise(done => setTimeout(done, 50));
  if (!report) throw new Error('The fixture did not post its report to the loopback server.');
  const matrix = evaluateDetection(report, { webdriver: false, persistentProfile: true });
  console.log(`\n${JSON.stringify(matrix, null, 2)}\n`);
  console.log('PASS: the normal Firefox profile has no avoidable detector flags, no FAI page-world globals or DOM mutations, and navigator.webdriver is false. Content-script events remain untrusted and have no manufactured user activation.');
} catch (error) {
  console.error(`\nFAIL: ${error.message}`);
  process.exitCode = 1;
} finally {
  await cleanup();
}
