// Issues #30 and #31, the daemon's and the MCP server's side (real daemon, fake hub; no browser): an agent that needs
// more on a request it holds (a higher level, another origin) asks on that request, which keeps its id, tab, page and
// tab mode; nothing is granted before the user's Approve. And a lease code from the browser (stopped, paused, ...) is
// checked against the request itself: "the user stopped the tab" only when the request was really stopped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createDaemon } from '../src/daemon.js';
import { bridgeError, directNext } from '../src/result.js';
import { call, createFakeHub } from './helpers/fake-hub.js';
import { spawnMcp } from './helpers/mcp-harness.js';
import { ORIGIN, link } from './runtime-fixtures.js';

const PARTNER = 'https://partner.example.org';
const PAGES = {
  '/': { title: 'Home', text: 'Welcome home', controls: [link('1', 'About', '/about')] },
  '/about': { title: 'About', text: 'About us', controls: [link('1', 'Home', '/')] },
};

async function setup(t) {
  const home = await mkdtemp(join(tmpdir(), 'fai-continuity-'));
  const hub = createFakeHub({ bridgeOptions: { pages: PAGES } });
  const daemon = createDaemon({ home, env: {}, port: 0, hub, sweepIntervalMs: 60_000 });
  await daemon.listen();
  t.after(async () => {
    await daemon.close();
    await rm(home, { recursive: true, force: true });
  });
  const api = (method, path, body, extra = {}) => call(daemon.port, method, path, body, { token: daemon.token, ...extra });
  return { home, hub, daemon, api };
}

async function active(ctx, { level = 'read-only', tabMode = 'single', mode = level } = {}) {
  const created = await ctx.api('POST', '/v1/requests', { origins: [ORIGIN], mode, reason: 'Read the page' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const { requestId } = created.body;
  const reply = await ctx.hub.approve(requestId, { level, tabMode });
  assert.ok(reply.leaseId, JSON.stringify(reply));
  return { requestId, leaseId: reply.leaseId };
}

const approveAsk = (ctx, requestId, { level, origin = ORIGIN, tabId = 1, tabMode = 'single' } = {}) => ctx.hub.emit({
  type: 'lease', requestId, tabId, origin, title: 'Home', level, tabMode, ask: true });

test('ask: a higher level on an active request keeps its id, lease, tab and tab mode; nothing before the Approve', async t => {
  const ctx = await setup(t);
  const { requestId, leaseId } = await active(ctx, { tabMode: 'multiple' });
  const asked = await ctx.api('POST', `/v1/requests/${requestId}/ask`, { mode: 'reversible' });
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  assert.equal(asked.body.asked, true);
  assert.equal(asked.body.request.ask.level, 'reversible');
  // Nothing is granted yet; the request stays active at its level, and no second request exists.
  assert.equal(ctx.daemon.request(requestId).grant.level, 'read-only');
  assert.equal((await ctx.api('GET', '/v1/requests')).body.requests.length, 1);
  // The extension lists the ask with the request, so the popup can show it.
  assert.equal(ctx.hub.published.at(-1).find(view => view.requestId === requestId).ask.level, 'reversible');
  const reply = await approveAsk(ctx, requestId, { level: 'reversible', tabMode: 'multiple' });
  assert.equal(reply.leaseId, leaseId, 'the same lease');
  assert.equal(reply.requestId, requestId);
  const record = ctx.daemon.request(requestId);
  assert.deepEqual([record.state, record.grant.level, record.grant.tabMode, record.mode], ['active', 'reversible', 'multiple', 'reversible']);
  assert.equal(record.ask, undefined);
  assert.equal(ctx.hub.lease(leaseId).level, 'reversible');
});

test('ask: an added origin joins the request and its lease only on Approve; Decline keeps the task as it was', async t => {
  const ctx = await setup(t);
  const { requestId, leaseId } = await active(ctx, { level: 'reversible' });
  const refused = await ctx.api('POST', `/v1/requests/${requestId}/ask`, { origins: ['https://*.com'] });
  assert.equal(refused.status, 400, 'origins are validated as for a new request');
  await ctx.api('POST', `/v1/requests/${requestId}/ask`, { origins: [PARTNER] });
  assert.deepEqual(ctx.daemon.request(requestId).ask.origins, [PARTNER]);
  assert.deepEqual(ctx.daemon.request(requestId).origins, [ORIGIN], 'not added before the Approve');
  // Decline: the ask goes, the request is not released, and the next open after the ask says so once.
  const declined = await ctx.hub.emit({ type: 'deny', requestId, ask: true });
  assert.equal(declined.state, 'active');
  assert.equal(ctx.daemon.request(requestId).ask, undefined);
  const after = await ctx.api('POST', '/v1/observe', { requestId, afterAsk: true });
  assert.equal(after.body.result.code, 'ask_declined');
  assert.equal(after.body.result.status, 'needs_user');
  const plain = await ctx.api('POST', '/v1/observe', { requestId, afterAsk: true });
  assert.ok(plain.body.actions, 'reported once; the page reads as usual afterwards');
  // Asked again and approved: the origin joins the request and the lease (same lease id).
  await ctx.api('POST', `/v1/requests/${requestId}/ask`, { origins: [PARTNER] });
  const pending = await ctx.api('POST', '/v1/observe', { requestId, afterAsk: true });
  assert.equal(pending.body.result.code, 'ask_pending', 'an open that waited in vain says the ask still waits');
  const reply = await approveAsk(ctx, requestId, { level: 'reversible' });
  assert.equal(reply.leaseId, leaseId);
  assert.ok(reply.origins.includes(PARTNER), JSON.stringify(reply));
  assert.deepEqual(ctx.daemon.request(requestId).origins, [ORIGIN, PARTNER]);
  assert.ok(ctx.hub.lease(leaseId).allowedOrigins.includes(PARTNER));
  // An approval without `ask` (an ordinary click) never adds what an ask names.
  await ctx.api('POST', `/v1/requests/${requestId}/ask`, { origins: ['https://third.example.org'] });
  await ctx.hub.approve(requestId, { level: 'reversible' });
  assert.ok(!ctx.daemon.request(requestId).origins.includes('https://third.example.org'));
});

test('ask: a paused request (the tab left for an unlisted origin) resumes there on the same request id', async t => {
  const ctx = await setup(t);
  const { requestId, leaseId } = await active(ctx, { level: 'reversible' });
  await ctx.hub.emit({ type: 'status', leaseId, status: 'paused', reason: 'origin_changed', origin: PARTNER });
  const blocked = await ctx.api('POST', '/v1/observe', { requestId });
  assert.equal(blocked.body.result.code, 'origin_changed');
  assert.equal(blocked.body.result.leftOrigin, PARTNER);
  assert.match(blocked.body.result.needs.message, /fai_browser_open with this requestId and it in origins/);
  assert.doesNotMatch(blocked.body.result.needs.message, /stopped|released/);
  // Without the ask the partner tab cannot be resumed (its origin is not requested).
  const early = await ctx.hub.approve(requestId, { level: 'reversible', origin: PARTNER });
  assert.equal(early.error.code, 'origin_not_requested');
  await ctx.api('POST', `/v1/requests/${requestId}/ask`, { origins: [PARTNER] });
  const resumed = await approveAsk(ctx, requestId, { level: 'reversible', origin: PARTNER });
  assert.equal(resumed.requestId, requestId);
  assert.ok(resumed.leaseId);
  assert.equal(ctx.daemon.request(requestId).state, 'active');
  assert.equal(ctx.daemon.request(requestId).lease.tabId, 1, 'the same tab');
});

test('ask on a pending request asks for it all at once; a closed request cannot ask', async t => {
  const ctx = await setup(t);
  const created = await ctx.api('POST', '/v1/requests', { origins: [ORIGIN], reason: 'Read' });
  const { requestId } = created.body;
  const asked = await ctx.api('POST', `/v1/requests/${requestId}/ask`, { mode: 'interactive', origins: [PARTNER] });
  assert.equal(asked.body.asked, false);
  assert.deepEqual([asked.body.request.mode, asked.body.request.origins], ['interactive', [ORIGIN, PARTNER]]);
  assert.equal((await ctx.api('GET', '/v1/requests')).body.requests.length, 1, 'no second request');
  await ctx.api('DELETE', `/v1/requests/${requestId}`, {});
  const closed = await ctx.api('POST', `/v1/requests/${requestId}/ask`, { mode: 'full' });
  assert.equal(closed.status, 409);
});

test('wait {ask: true} returns once the user answered the ask', async t => {
  const ctx = await setup(t);
  const { requestId } = await active(ctx);
  await ctx.api('POST', `/v1/requests/${requestId}/ask`, { mode: 'reversible' });
  const quick = await ctx.api('POST', '/v1/wait', { requestId, maxMs: 200, ask: true });
  assert.equal(quick.body.request.ask.level, 'reversible', 'still asking after the wait');
  const waiting = ctx.api('POST', '/v1/wait', { requestId, maxMs: 5000, ask: true });
  await delay(100);
  await approveAsk(ctx, requestId, { level: 'reversible' });
  const answered = await waiting;
  assert.equal(answered.body.state, 'active');
  assert.equal(answered.body.request.ask, undefined);
  assert.ok(answered.body.waitedMs < 4000);
});

test('#31: an approval the extension gives back (not_approved) is not a stop: the request waits again, same id', async t => {
  const ctx = await setup(t);
  const created = await ctx.api('POST', '/v1/requests', { origins: [ORIGIN], reason: 'Read' });
  const { requestId } = created.body;
  const { leaseId } = await ctx.hub.approve(requestId, { level: 'read-only' });
  await ctx.hub.emit({ type: 'status', leaseId, status: 'stopped', reason: 'not_approved' });
  assert.deepEqual([ctx.daemon.request(requestId).state, ctx.daemon.request(requestId).lease], ['pending', null]);
  const blocked = await ctx.api('POST', '/v1/observe', { requestId });
  assert.equal(blocked.body.result.code, 'select_tab');
  // A re-approval of an active lease given back keeps the lease at its earlier grant.
  const again = await ctx.hub.approve(requestId, { level: 'read-only' });
  await ctx.api('POST', `/v1/requests/${requestId}/ask`, { mode: 'reversible' });
  await approveAsk(ctx, requestId, { level: 'reversible' });
  await ctx.hub.emit({ type: 'status', leaseId: again.leaseId, status: 'stopped', reason: 'not_approved' });
  const record = ctx.daemon.request(requestId);
  assert.deepEqual([record.state, record.grant.level, record.lease.leaseId], ['active', 'read-only', again.leaseId]);
  assert.equal(record.ask.level, 'reversible', 'the ask waits again');
  assert.equal(ctx.hub.lease(again.leaseId).state, 'active');
});

test('#31: "stopped" only for the user\'s Stop; another stop reason ends the request without blaming the user', async t => {
  const ctx = await setup(t);
  const first = await active(ctx);
  await ctx.hub.emit({ type: 'status', leaseId: first.leaseId, status: 'stopped', reason: 'stopped' });
  const stopped = await ctx.api('POST', '/v1/observe', { requestId: first.requestId });
  assert.equal(stopped.body.result.code, 'stopped');
  assert.match(stopped.body.result.needs.message, /^The user pressed Stop/);
  const second = await active(ctx);
  await ctx.hub.emit({ type: 'status', leaseId: second.leaseId, status: 'stopped', reason: 'session_ended' });
  const closed = await ctx.api('POST', '/v1/observe', { requestId: second.requestId });
  assert.equal(closed.body.result.code, 'request_closed');
  // Superseded by another approval in the same browser: said so, never "stopped".
  const third = await active(ctx);
  const fourth = await active(ctx);
  const superseded = await ctx.api('POST', '/v1/observe', { requestId: third.requestId });
  assert.equal(superseded.body.result.code, 'request_closed');
  assert.match(superseded.body.result.needs.message, /replaced this one/);
  assert.ok(fourth.requestId);
});

test('#31: a lease code from the browser while the request is active is checked against the request', async t => {
  const ctx = await setup(t);
  const { requestId, leaseId } = await active(ctx);
  const bridge = ctx.hub.bridgeForTab(1);
  const real = bridge.observe.bind(bridge);
  // The browser answers one command with an older session's state ("stopped") while the request is active: nothing
  // ran, and the agent is told to observe again, never that the user stopped the tab.
  bridge.observe = async () => {
    bridge.observe = real;
    throw bridgeError('stopped', 'Browser session is stopped', false);
  };
  const started = Date.now();
  const first = await ctx.api('POST', '/v1/observe', { requestId });
  assert.equal(first.body.result.code, 'tab_not_ready');
  assert.equal(first.body.result.status, 'needs_host');
  assert.ok(Date.now() - started >= 1000, 'it waited for a status report first');
  assert.equal(directNext(first.body.result, { requestId }).kind, 'observe');
  assert.ok((await ctx.api('POST', '/v1/observe', { requestId })).body.actions, 'the next observe reads the page');
  // A pause the extension reports right after its failed command: the request's own pause, with its reason.
  bridge.observe = async () => {
    bridge.observe = real;
    setTimeout(() => ctx.hub.emit({ type: 'status', leaseId, status: 'paused', reason: 'child_tab', origin: PARTNER }), 100);
    throw bridgeError('paused', 'Browser session is paused', false);
  };
  const paused = await ctx.api('POST', '/v1/observe', { requestId });
  assert.equal(paused.body.result.code, 'child_tab');
  assert.equal(paused.body.result.childOrigin, PARTNER);
  assert.match(paused.body.result.needs.message, /^Paused: the page opened a tab or window/);
});

// --- issue #36: the order of hub events from a live Firefox session (daemon and extension 0.7.0) -------------------

async function agentSession(ctx) {
  const response = await ctx.api('POST', '/v1/sessions', { host: 'claude', repo: 'repo', pid: process.pid, wake: 'none' });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  const { sessionId, key } = response.body;
  return { sessionId, headers: { 'X-Fai-Session': `${sessionId}:${key}` } };
}

// The issue's timeline, replayed: a pending request whose Approve did not get through (tpk), an invite the agent
// joins (e_8), then either a successor request (0.7.0's MCP server) or an ask on the invited request.
async function issue36(ctx) {
  const session = await agentSession(ctx);
  const ask = (body, headers = session.headers) => ctx.api('POST', '/v1/requests', body, { headers });
  const stale = (await ask({ origins: [ORIGIN, PARTNER], mode: 'interactive', reason: 'Portal task' })).body.requestId;
  const invited = await ctx.hub.emit({ type: 'invite', tabId: 7, origin: ORIGIN, title: 'Portal', level: 'full',
    sessionId: session.sessionId, text: '', browserId: 'b1' });
  assert.ok(invited.leaseId, JSON.stringify(invited));
  const joined = await ctx.api('POST', `/v1/invites/${invited.invite.inviteId}/join`, {}, { headers: session.headers });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  return { session, stale, invited: invited.requestId, inviteLease: invited.leaseId, ask };
}

test('#36 item 3: a request whose approval superseded the browser\'s older session is never reported "stopped"', async t => {
  const ctx = await setup(t);
  const { session, invited, ask } = await issue36(ctx);
  // 0.7.0's MCP server minted a successor for the invited request's extra origins (still possible without requestId).
  const successor = (await ask({ origins: [ORIGIN, PARTNER], mode: 'full', reason: 'Portal with its frames' })).body.requestId;
  const bridge = ctx.hub.bridgeForTab(7);
  const real = bridge.observe.bind(bridge);
  // The worker still holds the invited tab's session, which the approval just superseded (stopped), when the
  // successor's first command arrives.
  bridge.observe = async () => {
    bridge.observe = real;
    throw bridgeError('stopped', 'Browser session is stopped', false);
  };
  const lease = await ctx.hub.emit({ type: 'lease', requestId: successor, tabId: 7, origin: ORIGIN, title: 'Portal',
    level: 'full', browserId: 'b1' });
  assert.ok(lease.leaseId, JSON.stringify(lease));
  assert.deepEqual([ctx.daemon.request(invited).state, ctx.daemon.request(invited).stateReason], ['released', 'superseded']);
  const first = await ctx.api('POST', '/v1/observe', { requestId: successor }, { headers: session.headers });
  assert.equal(first.body.result.code, 'tab_not_ready', JSON.stringify(first.body.result));
  assert.doesNotMatch(JSON.stringify(first.body.result), /stopped|released/i);
  assert.ok((await ctx.api('POST', '/v1/observe', { requestId: successor }, { headers: session.headers })).body.actions);
  // The superseded invited request says it was replaced, not stopped.
  const old = await ctx.api('POST', '/v1/observe', { requestId: invited }, { headers: session.headers });
  assert.equal(old.body.result.code, 'request_closed');
  assert.match(old.body.result.needs.message, /replaced this one/);
});

test('#36 items 4 and 5: an ask on an invited request keeps its id; the older pending request expires, its late click refused', async t => {
  const ctx = await setup(t);
  const { session, stale, invited, inviteLease } = await issue36(ctx);
  // Item 5: more origins on the invited request are asked on that request (the same id), not a new request.
  const asked = await ctx.api('POST', `/v1/requests/${invited}/ask`, { origins: [PARTNER] }, { headers: session.headers });
  assert.equal(asked.body.asked, true, JSON.stringify(asked.body));
  assert.equal((await ctx.api('GET', '/v1/requests', undefined, { headers: session.headers })).body.requests.length, 2,
    'the invited request and the older pending one: no third');
  const reply = await ctx.hub.emit({ type: 'lease', requestId: invited, tabId: 7, origin: ORIGIN, title: 'Portal',
    level: 'full', browserId: 'b1', ask: true });
  assert.equal(reply.leaseId, inviteLease, 'the invited lease, approved again in place');
  // Item 4: the agent's older pending request is replaced by this approval, so it expires now...
  assert.deepEqual([ctx.daemon.request(stale).state, ctx.daemon.request(stale).stateReason], ['expired', 'replaced']);
  // ...and the click on it that arrives late (a site-access prompt that answered after the fact) approves nothing.
  const late = await ctx.hub.emit({ type: 'lease', requestId: stale, tabId: 9, origin: ORIGIN, title: 'Blank', level: 'interactive',
    browserId: 'b1' });
  assert.equal(late.error.code, 'request_not_pending');
  assert.equal(ctx.daemon.request(invited).state, 'active', 'the approved request stays');
  const waited = await ctx.api('POST', '/v1/observe', { requestId: stale }, { headers: session.headers });
  assert.match(waited.body.result.needs.message, /newer request of yours was approved/);
});

test('#36: a request the agent made after the approved one is left alone; another session\'s is too', async t => {
  const ctx = await setup(t);
  const mine = await agentSession(ctx);
  const theirs = await agentSession(ctx);
  const make = headers => ctx.api('POST', '/v1/requests', { origins: [ORIGIN], reason: 'Read' }, { headers })
    .then(response => response.body.requestId);
  const first = await make(mine.headers);
  const other = await make(theirs.headers);
  const second = await make(mine.headers);
  const older = await make(mine.headers);
  await ctx.hub.approve(second, { level: 'read-only' });
  assert.equal(ctx.daemon.request(first).state, 'expired', 'an older one of the same session');
  assert.equal(ctx.daemon.request(older).state, 'pending', 'asked for after the approved one');
  assert.equal(ctx.daemon.request(other).state, 'pending', 'another agent session');
});

test('#36 item 2: a request the user denied is reported as denied, with a stop that says not to ask again', async t => {
  const ctx = await setup(t);
  const created = await ctx.api('POST', '/v1/requests', { origins: [ORIGIN], reason: 'Read' });
  const { requestId } = created.body;
  await ctx.hub.emit({ type: 'deny', requestId });
  const blocked = await ctx.api('POST', '/v1/observe', { requestId });
  assert.deepEqual([blocked.body.result.status, blocked.body.result.code], ['stopped', 'denied']);
  assert.match(blocked.body.result.needs.message, /The user denied this tab request/);
  const next = directNext(blocked.body.result, { requestId });
  assert.equal(next.kind, 'stop');
  assert.match(next.text, /denied.*only if the user asks/);
});

// --- through the spawned MCP server -----------------------------------------------------------------------------

async function mcpSetup(t) {
  const ctx = await setup(t);
  const mcp = spawnMcp({ PATH: process.env.PATH, HOME: ctx.home, FAI_HOME: ctx.home, FAI_DAEMON_PORT: String(ctx.daemon.port),
    FAI_MCP_APPROVAL_WAIT_MS: '4000', FAI_WAKE: 'off' });
  t.after(() => mcp.close());
  await mcp.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: 'test' } });
  mcp.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return { ...ctx, mcp };
}
const text = result => result.content.map(block => block.text ?? '').join('\n');
async function until(predicate, what, ms = 8000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(20);
  }
}

test('MCP #30: fai_browser_open with the requestId and a higher mode asks on the same request (no new request)', async t => {
  const ctx = await mcpSetup(t);
  const opening = ctx.mcp.callTool('fai_browser_open', { origins: [ORIGIN], reason: 'Read the page', task: 'read' });
  const pending = await until(() => ctx.hub.published.at(-1)?.find(item => item.state === 'pending'), 'the request');
  const { leaseId } = await ctx.hub.approve(pending.requestId, { level: 'read-only', tabMode: 'multiple' });
  assert.ok(!(await opening).isError);
  const raising = ctx.mcp.callTool('fai_browser_open', { requestId: pending.requestId, mode: 'reversible', task: 'read' });
  const asked = await until(() => ctx.hub.published.at(-1)?.find(item => item.requestId === pending.requestId && item.ask),
    'the ask');
  assert.equal(asked.ask.level, 'reversible');
  assert.equal(ctx.hub.published.at(-1).length, 1, 'the same request, no second one');
  await approveAsk(ctx, pending.requestId, { level: 'reversible', tabMode: 'multiple' });
  const raised = await raising;
  assert.ok(!raised.isError, text(raised));
  const body = text(raised);
  assert.match(body, new RegExp(`requestId: ${pending.requestId}`));
  assert.match(body, /granted: reversible.*task tabs: multiple/);
  assert.equal(ctx.daemon.request(pending.requestId).lease.leaseId, leaseId);
});

test('MCP #30: fai_browser_open with the requestId and an extra origin adds it after the user\'s Approve', async t => {
  const ctx = await mcpSetup(t);
  const opening = ctx.mcp.callTool('fai_browser_open', { origins: [ORIGIN], reason: 'Read the page', task: 'read' });
  const pending = await until(() => ctx.hub.published.at(-1)?.find(item => item.state === 'pending'), 'the request');
  await ctx.hub.approve(pending.requestId, { level: 'read-only' });
  assert.ok(!(await opening).isError);
  // Not answered within the call: the agent is told the ask still waits, on the same request.
  const waiting = await ctx.mcp.callTool('fai_browser_open', { requestId: pending.requestId, origins: [PARTNER], task: 'read' });
  assert.match(text(waiting), /ask_pending/);
  assert.match(text(waiting), /next \(relay\)/);
  assert.deepEqual(ctx.daemon.request(pending.requestId).ask.origins, [PARTNER]);
  const adding = ctx.mcp.callTool('fai_browser_open', { requestId: pending.requestId, origins: [PARTNER], task: 'read' });
  await delay(200);
  await approveAsk(ctx, pending.requestId, { level: 'read-only' });
  const added = await adding;
  assert.ok(!added.isError, text(added));
  assert.match(text(added), /status: observed/);
  assert.deepEqual(ctx.daemon.request(pending.requestId).origins, [ORIGIN, PARTNER]);
  assert.equal(ctx.hub.published.at(-1).length, 1, 'still one request');
});
