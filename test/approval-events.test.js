// Issue #36 item 1, the daemon's side: every approval surface the extension shows and every approval attempt that
// fails reaches daemon.log as an `approval` event with a reason code (never a URL, page text or anything secret), and a
// failed attempt on the page request modal or the toolbar turns the agent's approval steps to the toolbar icon.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APPROVAL_STEPS, APPROVAL_SURFACES, approvalEvent } from '../src/bridge.js';
import { createDaemon } from '../src/daemon.js';
import { createLogger, homePaths } from '../src/home.js';
import { FaiBrowserClient } from '../src/client.js';
import { approvalSteps, selectTabMessage } from '../src/result.js';
import { EXTENSION_ID, FakeExtension, SECRET } from './helpers/fake-extension.js';

const sleep = ms => new Promise(done => setTimeout(done, ms));
const ORIGIN = 'https://portal.example.com';

test('approvalEvent keeps codes and an origin only', () => {
  assert.deepEqual(approvalEvent({ requestId: 'req_abc-1', surface: 'page_modal', step: 'failed',
    reason: 'site_access_timeout', origin: ORIGIN }),
  { requestId: 'req_abc-1', surface: 'page_modal', step: 'failed', reason: 'site_access_timeout', origin: ORIGIN });
  // A URL with a path, free text as the reason and a request id with spaces are dropped, not passed on.
  assert.deepEqual(approvalEvent({ requestId: 'req 1; rm', surface: 'toolbar', step: 'attempt',
    reason: 'The page at https://x.example/secret?token=abc failed', origin: `${ORIGIN}/#view/deep?code=123` }),
  { requestId: null, surface: 'toolbar', step: 'attempt', reason: null, origin: null });
  assert.equal(approvalEvent({ requestId: 'req_1', origin: 'javascript:alert(1)', surface: 'popup', step: 'shown' }).origin, null);
  assert.equal(approvalEvent({ surface: 'sidebar', step: 'shown' }), null);
  assert.equal(approvalEvent({ surface: 'popup', step: 'clicked' }), null);
  assert.equal(approvalEvent(null), null);
  assert.deepEqual([...APPROVAL_SURFACES], ['page_modal', 'toolbar', 'popup', 'window']);
  assert.ok(APPROVAL_STEPS.includes('failed') && APPROVAL_STEPS.includes('denied'));
});

test('approval steps: a failed approval on the page says to use the toolbar icon on the task tab', () => {
  assert.match(approvalSteps('toolbar'), /page request modal did not work/);
  assert.match(approvalSteps('toolbar'), /FAI Browser toolbar icon on its task tab/);
  assert.match(selectTabMessage('page'), /page request modal/);
  assert.doesNotMatch(approvalSteps('page'), /did not work/);
});

test('the extension\'s approval events land in daemon.log and a modal failure rewords the pending request', async t => {
  const home = await mkdtemp(join(tmpdir(), 'fai-approval-events-'));
  const env = { FAI_BRIDGE_SECRET: SECRET, FAI_EXTENSION_ID: EXTENSION_ID };
  const paths = homePaths({ home, env });
  const log = createLogger(paths);
  const daemon = createDaemon({ home, env, port: 0, log, sweepIntervalMs: 60_000 });
  await daemon.listen();
  const ext = await FakeExtension.connect({ port: daemon.port });
  t.after(async () => {
    ext.close();
    await daemon.close();
    log.close();
    await rm(home, { recursive: true, force: true });
  });
  // An extension with "Open requested pages right away" on: a request for Use with a start page opens by itself.
  assert.equal((await ext.hello(null, { settings: { budget: null, openRightAway: true } })).ok, true);
  const client = new FaiBrowserClient({ port: daemon.port, token: daemon.token, clientName: 'approval-events' });
  const created = await client.requestTab({ origins: [ORIGIN, 'https://*.example.net'], mode: 'interactive',
    reason: 'Check the portal', url: `${ORIGIN}/#view/deep/link` });
  const view = async () => (await client.status()).requests.find(item => item.requestId === created.requestId);
  assert.equal((await view()).approval, 'page');

  const report = body => ext.send('approval', { requestId: created.requestId, ...body });
  report({ surface: 'page_modal', step: 'shown', origin: ORIGIN });
  report({ surface: 'page_modal', step: 'attempt', origin: ORIGIN });
  report({ surface: 'page_modal', step: 'waiting', reason: 'site_access_pending', origin: ORIGIN });
  report({ surface: 'page_modal', step: 'failed', reason: 'site_access_timeout', origin: `${ORIGIN}/#view/deep/link` });
  let pending;
  for (let i = 0; i < 100 && (pending = await view()).approval !== 'toolbar'; i++) await sleep(20);
  assert.equal(pending.approval, 'toolbar', 'a failed modal approval points the agent at the toolbar icon');
  assert.equal(pending.approvalIssue.reason, 'site_access_timeout');
  assert.equal(pending.approvalIssue.surface, 'page_modal');

  // The agent's open/observe result says the same.
  const blocked = (await client.observe({ requestId: created.requestId })).result;
  assert.equal(blocked.code, 'select_tab', JSON.stringify(blocked).slice(0, 300));
  assert.match(blocked.needs.message, /page request modal did not work.*toolbar icon on its task tab/);

  const lines = (await readFile(paths.logFile, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  const events = lines.filter(line => line.event === 'approval');
  assert.deepEqual(events.map(line => [line.surface, line.step, line.reason]), [
    ['page_modal', 'shown', null], ['page_modal', 'attempt', null], ['page_modal', 'waiting', 'site_access_pending'],
    ['page_modal', 'failed', 'site_access_timeout'],
  ]);
  assert.ok(events.every(line => line.requestId === created.requestId));
  // The failed event's origin had a path: it is dropped, never logged.
  assert.equal(events[3].origin, null);
  assert.equal(events[0].origin, ORIGIN);
  assert.doesNotMatch(JSON.stringify(events), /deep\/link|#view/);

  // An approval reported afterwards clears the issue (the lease itself makes the request active).
  report({ surface: 'toolbar', step: 'approved', origin: ORIGIN });
  for (let i = 0; i < 100 && (await view()).approvalIssue; i++) await sleep(20);
  assert.equal((await view()).approvalIssue, undefined);
});
