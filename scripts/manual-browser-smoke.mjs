// Real toolbar permission check against your own FAI service and the extension as shipped (activeTab, no test
// manifest). It serves a local fixture site, asks the FAI service for a Read tab on it, waits while you approve it in
// the browser with one click on the FAI Browser icon, then observes the page, clicks "About project" through act and
// checks the landing page on its own. No model, key or pairing secret is involved: the extension is paired already.
//   npm run manual-smoke             (FAI_DAEMON_PORT / FAI_HOME select another service, as for every client)
// Exit code 0 on PASS, 1 on FAIL.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { FaiBrowserClient } from '../src/client.js';

const root = resolve(import.meta.dirname, '..');
const APPROVAL_MS = Number(process.env.FAI_MANUAL_SMOKE_APPROVAL_MS) || 180_000;
const FIXTURES = ['index.html', 'about.html', 'child.html'];
const site = http.createServer(async (req, res) => {
  try {
    const name = req.url === '/' ? 'index.html' : req.url.slice(1);
    if (!FIXTURES.includes(name)) {
      res.writeHead(404);
      return res.end();
    }
    res.setHeader('Content-Type', 'text/html');
    res.end(await readFile(join(root, 'fixtures', name)));
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
    if (client && requestId) await client.release(requestId, 'manual smoke finished').catch(() => {});
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
  client = await FaiBrowserClient.connect({ autoStart: true, clientName: 'manual-smoke' });
  const created = await client.requestTab({ origins: [origin], mode: 'read-only', url: `${origin}/`,
    reason: 'Manual smoke check: open About project on a local fixture' });
  requestId = created.requestId;
  console.log(`\nProduction activeTab smoke check (no model, key or secret needed)

Fixture: ${origin}/
1. The page opens in a new window by itself (or click Open in the FAI Browser window).
2. Click the FAI Browser toolbar icon on that page to approve it at Read (pin the icon first if needed).

Waiting up to ${Math.round(APPROVAL_MS / 1000)} s for your approval…`);
  const waited = await client.waitForTab(requestId, { timeoutMs: APPROVAL_MS });
  if (waited.state !== 'active') throw new Error(`The request was not approved (state: ${waited.state}).`);

  const observed = await client.observe({ requestId, capture: true });
  if (observed.state !== 'ok') throw new Error(`Observe failed: ${observed.result?.code ?? observed.state}`);
  const link = observed.page.controls?.find(control => control.label === 'About project');
  const action = observed.actions.find(item => item.type === 'click' && item.target === link?.id);
  if (!action) throw new Error('The safe "About project" link is not offered.');
  const acted = await client.act({ requestId, actionId: action.id, revision: observed.revision,
    expectation: { urlIncludes: '/about.html', textIncludes: 'Ada, Grace, Linus' } });
  const result = acted.result ?? acted;
  // Independent check: the landing page itself, not only the expectation the service verified.
  const landed = await client.observe({ requestId });
  const passed = result.status === 'completed' && result.verification?.passed === true
    && landed.page?.url === `${origin}/about.html` && String(landed.page?.text ?? '').includes('Ada, Grace, Linus');
  if (!passed) throw new Error(`Permission smoke failed: ${result.status}/${result.code ?? ''} at ${landed.page?.url}`);
  const transport = (await client.status()).extension?.transport ?? 'unknown';
  console.log(`
PASS: the shipped activeTab permission ran one safe navigation, verified by the FAI service and checked again here.
Transport: ${transport}.
Screenshot: ${observed.screenshot ?? 'none (capture unavailable)'}
Trace: ${result.trace ?? observed.trace ?? 'none'}

The tab request is released now. The fixture stops; close its window.`);
} catch (error) {
  console.error(`\nFAIL: ${error.message}`);
  process.exitCode = 1;
} finally {
  await cleanup();
}
