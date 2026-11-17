// FAI chats, binding and wakes (spec #84 "Approvals and wakes" and "The page beside the chat"; acceptance 5, 6 and the
// daemon half of 11): the MCP server inside a turn registers with the turn token once, only while its turn runs; tab
// requests belong to the chat and move to the next turn's session; a wake addressed to the chat (all five kinds)
// starts one turn whose text is the wake's template, in order, after a running turn ends; the tab beside the panel
// gets a pending invite named in the turn's text (its id only), unlisted until the agent joins. Stand-in providers,
// fake hub. Browserless.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDaemon } from '../src/daemon.js';
import { chatInviteText, wakeText } from '../src/wake.js';
import { controlText } from '../src/mcp.js';
import { faiMessage } from '../src/chat.js';
import { call, createFakeHub } from './helpers/fake-hub.js';
import { ORIGIN } from './runtime-fixtures.js';

const STANDIN = join(import.meta.dirname, 'helpers', 'chat-standin.js');
const ENTRY = '0b8e5c1a-6f0d-4b6a-9c2e-1f3a5b7c9d0e';
const OTHER_ENTRY = '1c9f6d2b-7a1e-4c7b-8d3f-2a4b6c8d0e1f';
const BROWSER = 'browser-1';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const programs = Object.fromEntries(['claude', 'codex', 'opencode']
  .map(provider => [provider, { file: process.execPath, prefix: [STANDIN, provider] }]));
const PAGES = {
  '/settings': { url: `${ORIGIN}/settings`, title: 'Settings', text: 'Workspace', controls: [
    { id: '3', role: 'button', label: 'Save changes', enabled: true, visible: true, risk: 'submit' }] },
};

async function setup(t, { hold = true, ...daemonOptions } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'fai-chat-binding-'));
  await writeFile(join(home, 'control.json'), JSON.stringify({ claude: { hold } }));
  const hub = createFakeHub({ bridgeOptions: { pages: PAGES, path: '/settings' } });
  // Every stand-in pid counts as alive: a session's process is the test's to end (DELETE), as an MCP server's stdio.
  const daemon = createDaemon({ home, env: { ...process.env, STANDIN_DIR: home }, port: 0, hub, chatPrograms: programs,
    isAlive: () => true, sweepIntervalMs: 60_000, ...daemonOptions });
  await daemon.listen();
  const api = (method, path, body, extra = {}) => call(daemon.port, method, path, body, { token: daemon.token, ...extra });
  const chat = (op, args = {}) => hub.emit({ type: `chat_${op}`, args, browserId: BROWSER });
  // One cleanup, in this order (t.after hooks run in the order they were added): the test's own MCP servers stop, every
  // turn ends by itself (a held one is released; a wake's turn after it too), the daemon closes, and only then the
  // folder goes. Windows refuses to remove a folder a live process works in.
  const beforeClose = [];
  t.after(async () => {
    for (const stop of beforeClose.reverse()) await stop();
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      await writeFile(join(home, 'release'), '').catch(() => {});
      const listed = await chat('list', {}).catch(() => null);
      if (!listed?.chats?.some(item => item.running)) break;
      await delay(25);
    }
    await daemon.close();
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  const calls = async () => (await readFile(join(home, 'calls.jsonl'), 'utf8').catch(() => '')).split('\n')
    .filter(Boolean).map(line => JSON.parse(line)).filter(entry => entry.args);
  const until = async (predicate, what) => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const value = await predicate();
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await delay(20);
    }
  };
  // The n-th turn's process (1-based), once it started.
  const turn = n => until(async () => (await calls())[n - 1], `turn ${n}`);
  const history = async chatId => (await chat('history', { chatId }));
  const idle = chatId => until(async () => {
    const got = await history(chatId);
    return got.chat.running ? null : got;
  }, 'the turn to end');
  const release = async () => {
    await writeFile(join(home, 'release'), '');
    await until(async () => !(await readFile(join(home, 'release')).then(() => true, () => false)), 'the release');
  };
  // A pid of its own per registration, as each turn's MCP server has (at most two entries per pid).
  let pid = 4000;
  const register = (token, extra = {}) => api('POST', '/v1/sessions', { host: 'claude', repo: 'ignored', pid: ++pid,
    startedAt: new Date().toISOString(), wake: 'claude-socket', ...(token === undefined ? {} : { chatTurnToken: token }),
    ...extra });
  const sessionOf = response => ({ sessionId: response.body.sessionId,
    headers: { 'X-Fai-Session': `${response.body.sessionId}:${response.body.key}` } });
  const turnText = entry => entry.args[entry.args.indexOf('-p') + 1];
  // The user's Use or Act in this browser (BROWSER).
  const lease = (requestId, { tabId = 1, level = 'read-only' } = {}) => hub.emit({ type: 'lease', requestId, tabId,
    origin: ORIGIN, title: 'Home', level, browserId: BROWSER });
  return { home, hub, daemon, api, chat, calls, turn, history, idle, release, register, sessionOf, turnText, lease,
    beforeClose: stop => beforeClose.push(stop),
    control: value => writeFile(join(home, 'control.json'), JSON.stringify({ claude: value })) };
}

test('binding: a turn token registers once, only while its turn runs; the session is the chat\'s (fai-chat)', async t => {
  const ctx = await setup(t);
  const sent = await ctx.chat('send', { provider: 'claude', text: 'hello' });
  const first = await ctx.turn(1);
  assert.match(first.token, /^[A-Za-z0-9_-]{40,}$/);
  for (const token of ['', 'not-a-token', first.token.slice(0, -2) + 'xx']) {
    const refused = await ctx.register(token);
    assert.deepEqual([refused.status, refused.body.error.code], [403, 'chat_token_refused'], `unknown token ${token}`);
  }
  const bound = await ctx.register(first.token);
  assert.equal(bound.status, 201, JSON.stringify(bound.body));
  assert.equal(bound.body.chat, true);
  const reused = await ctx.register(first.token);
  assert.deepEqual([reused.status, reused.body.error.code], [403, 'chat_token_refused'], 'a token works once');
  const plain = await ctx.register(undefined, { wake: 'fai-chat' });
  assert.equal(plain.status, 201);
  assert.equal(plain.body.chat, undefined);
  const views = (await ctx.api('GET', '/v1/sessions')).body.sessions;
  const mine = views.find(view => view.sessionId === bound.body.sessionId);
  assert.deepEqual([mine.wake, mine.wakeReason, mine.repo, mine.ready], ['fai-chat', 'ok', 'FAI chat', true]);
  assert.equal(views.find(view => view.sessionId === plain.body.sessionId).wake, 'none', 'fai-chat is never self-declared');
  // The server cannot talk its capability away from fai-chat.
  const session = ctx.sessionOf(bound);
  await ctx.api('POST', `/v1/sessions/${session.sessionId}/update`, { wake: 'claude-socket', wakeReason: 'unknown_host' },
    { headers: session.headers });
  assert.equal((await ctx.api('GET', '/v1/sessions')).body.sessions.find(view => view.sessionId === session.sessionId).wake, 'fai-chat');
  await ctx.release();
  await ctx.idle(sent.chatId);

  // Turn 2's token, never presented, is refused once its turn has ended.
  await ctx.chat('send', { chatId: sent.chatId, text: 'again' });
  const second = await ctx.turn(2);
  await ctx.release();
  await ctx.idle(sent.chatId);
  const late = await ctx.register(second.token);
  assert.deepEqual([late.status, late.body.error.code], [403, 'chat_token_refused'], 'after its turn ended');
  // A stopped turn's token too.
  await ctx.chat('send', { chatId: sent.chatId, text: 'third' });
  const third = await ctx.turn(3);
  await ctx.chat('stop', { chatId: sent.chatId });
  assert.equal((await ctx.register(third.token)).status, 403, 'after Stop');
});

test('ownership: a request opened in turn 1 is the chat\'s and usable in turn 2; the invited tab only by the chat', async t => {
  const ctx = await setup(t);
  const sent = await ctx.chat('send', { provider: 'claude', text: 'look at this page',
    currentTab: { tabId: 7, origin: ORIGIN } });
  assert.equal(sent.invite.tabId, 7);
  const one = ctx.sessionOf(await ctx.register((await ctx.turn(1)).token));
  const created = await ctx.api('POST', '/v1/requests', { origins: [ORIGIN], reason: 'Read the report', mode: 'read-only' },
    { headers: one.headers });
  assert.equal(created.status, 201);
  const joined = await ctx.api('POST', `/v1/invites/${sent.invite.inviteId}/join`, {}, { headers: one.headers });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  // Turn 1 ends and its MCP server goes; nothing it owned ends with it.
  await ctx.release();
  await ctx.idle(sent.chatId);
  await ctx.api('DELETE', `/v1/sessions/${one.sessionId}`, {}, { headers: one.headers });
  for (const requestId of [created.body.requestId, joined.body.requestId]) {
    assert.equal((await ctx.api('GET', `/v1/requests/${requestId}`)).body.state, 'pending');
  }

  await ctx.chat('send', { chatId: sent.chatId, text: 'go on' });
  const two = ctx.sessionOf(await ctx.register((await ctx.turn(2)).token));
  const owned = await ctx.api('GET', `/v1/requests/${created.body.requestId}`, undefined, { headers: two.headers });
  assert.equal(owned.body.owner.sessionId, two.sessionId, 'the request moved to the next turn\'s session');
  const invited = await ctx.api('GET', `/v1/requests/${joined.body.requestId}`, undefined, { headers: two.headers });
  assert.equal(invited.body.owner.sessionId, two.sessionId);
  assert.deepEqual([invited.body.state, 'origins' in invited.body], ['pending', false],
    'the invited tab for the chat, without its origin before the grant (flag #22)');
  const other = ctx.sessionOf(await ctx.register(undefined, { repo: 'other' }));
  const hidden = await ctx.api('GET', `/v1/requests/${joined.body.requestId}`, undefined, { headers: other.headers });
  assert.equal(hidden.body.invited, true, 'another agent sees only that it is an invited tab');
  // The approval binds the invited tab and wakes the chat, not the session that joined.
  await ctx.release();
  await ctx.idle(sent.chatId);
  await ctx.control({});
  await ctx.lease(joined.body.requestId, { tabId: 7, level: 'read-only' });
  const woken = await ctx.turn(3);
  assert.equal(ctx.turnText(woken), wakeText({ kind: 'approved', requestId: joined.body.requestId, level: 'read-only' }));
});

test('the page beside the chat: a pending invite named in the turn, unlisted until joined, then the approval window', async t => {
  const ctx = await setup(t);
  const sent = await ctx.chat('send', { provider: 'claude', text: 'what is on this page?',
    currentTab: { tabId: 7, origin: ORIGIN } });
  assert.deepEqual(Object.keys(sent).sort(), ['chatId', 'invite', 'turnId']);
  const first = await ctx.turn(1);
  const text = ctx.turnText(first);
  assert.ok(text.endsWith(`\n${chatInviteText(sent.invite.inviteId)}`), text);
  assert.ok(!text.includes(ORIGIN) && !text.includes('example'), 'the turn names the invite id only, never the page');
  // Nothing is granted and nothing is listed: no window opens until the agent joins.
  const listed = () => ctx.hub.published.at(-1) ?? [];
  assert.ok(!listed().some(view => view.invite?.inviteId === sent.invite.inviteId));
  assert.equal((await ctx.api('GET', '/v1/requests')).body.requests.length, 0);
  assert.deepEqual((await ctx.hub.emit({ type: 'agents', browserId: BROWSER })).invites, [], 'not the popup\'s invite card');
  // Only the chat's own session may join it, and only that session sees it in its status.
  const stranger = ctx.sessionOf(await ctx.register(undefined, { repo: 'stranger' }));
  const refused = await ctx.api('POST', `/v1/invites/${sent.invite.inviteId}/join`, {}, { headers: stranger.headers });
  assert.deepEqual([refused.status, refused.body.error.code], [403, 'invite_for_another_session']);
  assert.deepEqual((await ctx.api('GET', '/v1/status', undefined, { headers: stranger.headers })).body.invites, []);
  const mine = ctx.sessionOf(await ctx.register(first.token));
  assert.deepEqual((await ctx.api('GET', '/v1/status', undefined, { headers: mine.headers })).body.invites
    .map(invite => [invite.inviteId, invite.automatic, invite.tabId]), [[sent.invite.inviteId, true, 7]]);
  const joined = await ctx.api('POST', `/v1/invites/${sent.invite.inviteId}/join`, {}, { headers: mine.headers });
  assert.equal(joined.status, 200);
  assert.deepEqual([joined.body.state, joined.body.level], ['pending', null], 'joining grants nothing');
  const view = listed().find(item => item.requestId === joined.body.requestId);
  assert.ok(view, 'listed once joined: the existing approval window opens for it');
  assert.deepEqual([view.state, view.origins, view.grant, view.invite.automatic, view.invite.tabId, view.browser.id],
    ['pending', [ORIGIN], null, true, 7, BROWSER]);
  // Deny refuses.
  await ctx.hub.emit({ type: 'deny', requestId: joined.body.requestId, browserId: BROWSER });
  assert.equal((await ctx.api('GET', `/v1/requests/${joined.body.requestId}`, undefined, { headers: mine.headers })).body.state, 'denied');
  await ctx.release();
  await ctx.idle(sent.chatId);

  // The next turn on a tab the chat holds carries no invite; a browser page (no currentTab) none either.
  await ctx.chat('send', { chatId: sent.chatId, text: 'and now?', currentTab: { tabId: 7, origin: ORIGIN } });
  const two = ctx.sessionOf(await ctx.register((await ctx.turn(2)).token));
  const again = ctx.turnText(await ctx.turn(2));
  const inviteId = /invite (inv-[a-z0-9]+)\)/.exec(again)?.[1];
  assert.ok(inviteId, 'a fresh invite for a later turn');
  await ctx.api('POST', `/v1/invites/${inviteId}/join`, {}, { headers: two.headers });
  const requestId = listed().find(item => item.invite?.inviteId === inviteId).requestId;
  await ctx.lease(requestId, { tabId: 7, level: 'read-only' });
  await ctx.control({});
  await ctx.release();
  await ctx.turn(3);
  await ctx.idle(sent.chatId);
  const held = await ctx.chat('send', { chatId: sent.chatId, text: 'more', currentTab: { tabId: 7, origin: ORIGIN } });
  assert.equal(held.invite, undefined, 'the chat already holds this tab');
  for (const currentTab of [{ tabId: 8, origin: 'chrome://settings' }, { tabId: 8, origin: 'https://*.example.com' }, null]) {
    await ctx.idle(sent.chatId);
    const plain = await ctx.chat('send', { chatId: sent.chatId, text: 'x', currentTab });
    assert.equal(plain.invite, undefined, JSON.stringify(currentTab));
  }
  for (const entry of await ctx.calls()) assert.ok(!ctx.turnText(entry).includes(ORIGIN));
});

test('the page beside the chat: the agent learns no origin, URL or level before the Use/Act grant (flag #22)', async t => {
  const ctx = await setup(t);
  const sent = await ctx.chat('send', { provider: 'claude', text: 'what is on this page?',
    currentTab: { tabId: 7, origin: ORIGIN } });
  const first = await ctx.turn(1);
  const mine = ctx.sessionOf(await ctx.register(first.token));
  const as = { headers: mine.headers };
  const leaks = value => JSON.stringify(value).includes(ORIGIN);
  // Before the join: status names the invite (id, automatic, tab id) and nothing about the page.
  const pre = (await ctx.api('GET', '/v1/status', undefined, as)).body;
  assert.deepEqual(pre.invites.map(invite => [invite.inviteId, invite.automatic, 'origin' in invite]),
    [[sent.invite.inviteId, true, false]]);
  assert.ok(!leaks(pre.invites), JSON.stringify(pre.invites));
  const line = controlText({ invites: pre.invites });
  assert.equal(line, `invite: ${sent.invite.inviteId} for this FAI chat, the tab beside its panel (the user chooses Use `
    + `or Act after you join), expires ${pre.invites[0].expiresAt}`);
  // The join reply: pending, no level, no origin, and its request without origins or URL.
  const joined = await ctx.api('POST', `/v1/invites/${sent.invite.inviteId}/join`, {}, as);
  assert.equal(joined.status, 200);
  assert.deepEqual([joined.body.state, joined.body.level, 'origin' in joined.body, 'origins' in joined.body.request,
    'url' in joined.body.request], ['pending', null, false, false, false]);
  assert.ok(!leaks(joined.body), JSON.stringify(joined.body));
  const requestId = joined.body.requestId;
  // After the join, before the click: every view the agent can read (status, list, get, wait) leaves the page out.
  const post = (await ctx.api('GET', '/v1/status', undefined, as)).body;
  assert.deepEqual(post.requests.map(view => [view.requestId, view.state]), [[requestId, 'pending']]);
  assert.ok(!leaks(post.requests), JSON.stringify(post.requests));
  assert.ok(!controlText({ requests: post.requests }).includes(ORIGIN));
  assert.ok(!leaks((await ctx.api('GET', '/v1/requests', undefined, as)).body));
  assert.ok(!leaks((await ctx.api('GET', `/v1/requests/${requestId}`, undefined, as)).body));
  const waited = await ctx.api('POST', '/v1/wait', { requestId, maxMs: 50 }, as);
  assert.deepEqual([waited.body.state, leaks(waited.body)], ['pending', false]);
  // Asking for more before the grant would make a successor carrying the origin: refused.
  const asked = await ctx.api('POST', `/v1/requests/${requestId}/ask`, { origins: [ORIGIN] }, as);
  assert.deepEqual([asked.status, asked.body.error.code], [409, 'invite_not_granted']);
  // The extension's approval window still shows the site.
  assert.deepEqual(ctx.hub.published.at(-1).find(view => view.requestId === requestId).origins, [ORIGIN]);
  // Granted: the agent sees the tab's origin.
  await ctx.lease(requestId, { tabId: 7, level: 'read-only' });
  assert.deepEqual((await ctx.api('GET', `/v1/requests/${requestId}`, undefined, as)).body.origins, [ORIGIN]);

  // A popup invite keeps today's view: its level and origin, in status, its line and the join reply.
  const popup = await ctx.hub.emit({ type: 'invite', tabId: 9, origin: ORIGIN, level: 'read-only', tabMode: 'single',
    text: '', sessionId: mine.sessionId, browserId: BROWSER });
  const listed = (await ctx.api('GET', '/v1/status', undefined, as)).body.invites;
  const invite = listed.find(item => item.inviteId === popup.invite.inviteId);
  assert.deepEqual([invite.origin, invite.automatic], [ORIGIN, undefined]);
  assert.ok(controlText({ invites: [invite] }).includes(`for this session, level read-only, ${ORIGIN}, expires`));
  const joinedPopup = await ctx.api('POST', `/v1/invites/${popup.invite.inviteId}/join`, {}, as);
  assert.deepEqual([joinedPopup.body.origin, joinedPopup.body.request.origins], [ORIGIN, [ORIGIN]]);
  await ctx.release();
  await ctx.idle(sent.chatId);
});

// Simulated time for the sweep: `clock.skew` minutes ahead, one minute at a time; each session polls each minute, as a
// live MCP server does (a silent one goes stale after 90 s).
const MIN = 60_000;
async function stepClock(ctx, clock, minutes, sessions) {
  for (let m = Math.round(clock.skew / MIN) + 1; m <= minutes; m += 1) {
    clock.skew = m * MIN;
    for (const session of sessions) {
      const polled = await ctx.api('POST', `/v1/sessions/${session.sessionId}/poll`, { maxMs: 0 },
        { headers: session.headers });
      assert.equal(polled.status, 200, JSON.stringify(polled.body));
    }
    await delay(30);
  }
}

for (const ending of ['expired', 'denied']) {
  test(`the page beside the chat: a never-granted tab (${ending}) stays withheld after the invite's keep time (flag #22)`,
    async t => {
      const clock = { skew: 0 };
      const ctx = await setup(t, { sweepIntervalMs: 10, now: () => Date.now() + clock.skew });
      const sent = await ctx.chat('send', { provider: 'claude', text: 'what is on this page?',
        currentTab: { tabId: 7, origin: ORIGIN } });
      const mine = ctx.sessionOf(await ctx.register((await ctx.turn(1)).token));
      const as = { headers: mine.headers };
      const leaks = value => JSON.stringify(value).includes(ORIGIN);
      const joined = await ctx.api('POST', `/v1/invites/${sent.invite.inviteId}/join`, {}, as);
      const requestId = joined.body.requestId;
      if (ending === 'denied') {
        await stepClock(ctx, clock, 5, [mine]);
        await ctx.hub.emit({ type: 'deny', requestId, browserId: BROWSER });
      }
      // Past the pending request's 10 min, then past INVITE_KEEP_MS (60 min) from the join; the record is kept 60 min
      // from its end, so it still answers.
      await stepClock(ctx, clock, 61, [mine]);
      await delay(50);
      const got = await ctx.api('GET', `/v1/requests/${requestId}`, undefined, as);
      assert.deepEqual([got.status, got.body.state, got.body.lease], [200, ending, null]);
      assert.ok(!leaks(got.body), JSON.stringify(got.body));
      assert.ok(!leaks((await ctx.api('POST', '/v1/wait', { requestId, maxMs: 0 }, as)).body));
      assert.ok(!leaks((await ctx.api('GET', '/v1/requests', undefined, as)).body));
      const other = ctx.sessionOf(await ctx.register(undefined, { repo: 'other' }));
      const hidden = await ctx.api('GET', `/v1/requests/${requestId}`, undefined, { headers: other.headers });
      assert.deepEqual([hidden.body.invited, leaks(hidden.body)], [true, false], 'another agent: only an invited tab');
      await ctx.release();
      await ctx.idle(sent.chatId);
    });
}

test('invites: an invited tab stays its owner\'s after the invite\'s keep time while the lease is in use (flag #23)',
  async t => {
    const clock = { skew: 0 };
    const ctx = await setup(t, { sweepIntervalMs: 10, now: () => Date.now() + clock.skew });
    const owner = ctx.sessionOf(await ctx.register(undefined, { repo: 'owner' }));
    const other = ctx.sessionOf(await ctx.register(undefined, { repo: 'other' }));
    const popup = await ctx.hub.emit({ type: 'invite', tabId: 9, origin: ORIGIN, level: 'read-only', tabMode: 'single',
      text: '', sessionId: owner.sessionId, browserId: BROWSER });
    const requestId = (await ctx.api('POST', `/v1/invites/${popup.invite.inviteId}/join`, {}, { headers: owner.headers }))
      .body.requestId;
    // The owner uses the tab every 5 min (under the lease's idle expiry) up to 65 min after the join.
    for (let minute = 5; minute <= 65; minute += 5) {
      await stepClock(ctx, clock, minute, [owner, other]);
      const kept = await ctx.api('POST', '/v1/wait', { requestId, maxMs: 0 }, { headers: owner.headers });
      assert.equal(kept.body.state, 'active', `the owner's lease at +${minute} min`);
    }
    await delay(50);
    const seen = await ctx.api('GET', `/v1/requests/${requestId}`, undefined, { headers: other.headers });
    assert.deepEqual([seen.body.invited, 'origins' in seen.body], [true, false], 'another agent: only an invited tab');
    const used = await ctx.api('POST', '/v1/observe', { requestId }, { headers: other.headers });
    assert.deepEqual([used.status, used.body.error?.code], [403, 'not_owner']);
  });

test('wakes as turns: all five kinds, one turn each, in order, after the running turn; the text is the template', async t => {
  const ctx = await setup(t);
  const sent = await ctx.chat('send', { provider: 'claude', text: 'tidy my workspace' });
  const session = ctx.sessionOf(await ctx.register((await ctx.turn(1)).token));
  const created = await ctx.api('POST', '/v1/requests', { origins: [ORIGIN], reason: 'Tidy', mode: 'reversible' },
    { headers: session.headers });
  const requestId = created.body.requestId;
  // Two wakes while turn 1 runs: the popup's invite to this chat's session, then the Approve. They wait, in order.
  const invite = await ctx.hub.emit({ type: 'invite', tabId: 9, origin: ORIGIN, level: 'read-only', tabMode: 'single',
    text: 'Look at the cart', sessionId: session.sessionId, browserId: 'browser-2' });
  assert.equal(invite.invite.wake.state, 'queued');
  const lease = await ctx.lease(requestId, { tabId: 1, level: 'reversible' });
  assert.ok(lease.leaseId);
  await delay(100);
  assert.equal((await ctx.calls()).length, 1, 'no turn starts while one runs');
  await ctx.control({});
  await ctx.release();
  const invited = await ctx.turn(2);
  const approved = await ctx.turn(3);
  assert.equal(ctx.turnText(invited), wakeText({ kind: 'invite', inviteId: invite.invite.inviteId, requestId: invite.requestId,
    level: 'read-only', userText: 'Look at the cart' }));
  assert.equal(ctx.turnText(approved), wakeText({ kind: 'approved', requestId, level: 'reversible' }));
  await ctx.idle(sent.chatId);

  // Approve once and Deny given late (spec #79): action_approved and action_denied turns.
  const answers = [];
  ctx.hub.bridgeForTab(1).approve = async () => answers.shift() ?? { decision: 'pending', entryId: ENTRY };
  const offer = (await ctx.api('POST', '/v1/observe', { requestId })).body;
  const save = offer.actions.find(action => /Save changes/.test(action.description));
  const act = () => ctx.api('POST', '/v1/act', { requestId, actionId: save.id, revision: offer.revision });
  assert.equal((await act()).body.result.code, 'approval_pending');
  await ctx.hub.emit({ type: 'action_decision', entryId: ENTRY, decision: 'approved', browserId: BROWSER });
  const yes = await ctx.turn(4);
  assert.equal(ctx.turnText(yes), wakeText({ kind: 'action_approved', requestId, actionId: save.id, revision: offer.revision }));
  await ctx.idle(sent.chatId);
  answers.push({ decision: 'pending', entryId: OTHER_ENTRY });
  assert.equal((await act()).body.result.code, 'approval_pending');
  await ctx.hub.emit({ type: 'action_decision', entryId: OTHER_ENTRY, decision: 'denied', browserId: BROWSER });
  const no = await ctx.turn(5);
  assert.equal(ctx.turnText(no), wakeText({ kind: 'action_denied', requestId, actionId: save.id, revision: offer.revision }));
  await ctx.idle(sent.chatId);

  // Pause and Resume: a resume turn.
  await ctx.hub.emit({ type: 'status', leaseId: lease.leaseId, status: 'paused', reason: 'paused' });
  await ctx.lease(requestId, { tabId: 1, level: 'reversible' });
  const resumed = await ctx.turn(6);
  assert.equal(ctx.turnText(resumed), wakeText({ kind: 'resume', requestId, level: 'reversible' }));
  const done = await ctx.idle(sent.chatId);
  // The transcript shows each wake as one short FAI line.
  assert.deepEqual(done.messages.filter(message => message.role === 'fai').map(message => message.text), [
    `FAI: invited you to a browser tab (invite ${invite.invite.inviteId})`,
    `FAI: approved tab request ${requestId}`,
    `FAI: approved action ${save.id} on tab request ${requestId}`,
    `FAI: denied action ${save.id} on tab request ${requestId}`,
    `FAI: resumed tab request ${requestId}`,
  ]);
  // The popup reads the owner's last wake as usual.
  const view = (await ctx.api('GET', `/v1/requests/${requestId}`)).body;
  assert.deepEqual([view.ownerWake.kind, view.ownerWake.state], ['resume', 'delivered']);
});

test('wakes as turns (spec #87): a combined approval\'s one wake and a declined ask are turns with their templates', async t => {
  const ctx = await setup(t);
  const sent = await ctx.chat('send', { provider: 'claude', text: 'tidy my workspace' });
  const session = ctx.sessionOf(await ctx.register((await ctx.turn(1)).token));
  const created = await ctx.api('POST', '/v1/requests', { origins: [ORIGIN], reason: 'Tidy', mode: 'reversible' },
    { headers: session.headers });
  const requestId = created.body.requestId;
  await ctx.lease(requestId, { tabId: 1, level: 'reversible' });
  await ctx.control({});
  await ctx.release();
  await ctx.turn(2);
  await ctx.idle(sent.chatId);
  ctx.hub.bridgeForTab(1).approve = async () => ({ decision: 'pending', entryId: ENTRY });
  const offer = (await ctx.api('POST', '/v1/observe', { requestId }, { headers: session.headers })).body;
  const save = offer.actions.find(action => /Save changes/.test(action.description));
  assert.equal((await ctx.api('POST', '/v1/act', { requestId, actionId: save.id, revision: offer.revision },
    { headers: session.headers })).body.result.code, 'approval_pending');
  await ctx.api('POST', `/v1/requests/${requestId}/ask`, { mode: 'full' }, { headers: session.headers });
  let askId = (await ctx.api('GET', `/v1/requests/${requestId}`)).body.ask.id;
  const bundle = { browserId: BROWSER, requestId, tabId: 1, bundleId: 'b1', version: 1, askId, entryIds: [ENTRY] };
  await ctx.hub.emit({ type: 'bundle_open', ...bundle });
  await ctx.hub.emit({ type: 'deny', requestId, ask: true, bundled: true, browserId: BROWSER });
  await ctx.hub.emit({ type: 'bundle_decision', ...bundle, decision: 'denied' });
  const denied = await ctx.turn(3);
  assert.equal(ctx.turnText(denied), wakeText({ kind: 'bundle_denied', requestId, items: [{ type: 'level', level: 'full' },
    { type: 'action', actionId: save.id, revision: offer.revision }] }));
  await ctx.idle(sent.chatId);
  // A bundle of one: the ask declined on its own wakes with ask_declined.
  await ctx.api('POST', `/v1/requests/${requestId}/ask`, { mode: 'full' }, { headers: session.headers });
  askId = (await ctx.api('GET', `/v1/requests/${requestId}`)).body.ask.id;
  await ctx.hub.emit({ type: 'bundle_open', ...bundle, bundleId: 'b2', askId, entryIds: [] });
  await ctx.hub.emit({ type: 'deny', requestId, ask: true, browserId: BROWSER });
  const declined = await ctx.turn(4);
  assert.equal(ctx.turnText(declined), wakeText({ kind: 'ask_declined', requestId }));
  const done = await ctx.idle(sent.chatId);
  assert.deepEqual(done.messages.filter(message => message.role === 'fai').map(message => message.text).slice(-2), [
    `FAI: denied all 2 items on tab request ${requestId}`,
    `FAI: declined your ask on tab request ${requestId}`,
  ]);
  assert.deepEqual(faiMessage(wakeText({ kind: 'bundle_approved', requestId: 'r1', items: [{ type: 'sites', count: 1 },
    { type: 'action', actionId: 'a1', revision: 'v1' }] })), { role: 'fai', text: 'FAI: approved all 2 items on tab request r1' });
  assert.deepEqual(faiMessage(wakeText({ kind: 'bundle_expired', requestId: 'r1', items: [{ type: 'sites', count: 1 }] })),
    { role: 'fai', text: 'FAI: the approval on tab request r1 expired' });
});

test('wakes as turns: a wake that cannot start a turn fails with FAI\'s reason code; one already seen is skipped', async t => {
  const ctx = await setup(t);
  const sent = await ctx.chat('send', { provider: 'claude', text: 'hi' });
  const session = ctx.sessionOf(await ctx.register((await ctx.turn(1)).token));
  const created = await ctx.api('POST', '/v1/requests', { origins: [ORIGIN], reason: 'Read', mode: 'read-only' },
    { headers: session.headers });
  const requestId = created.body.requestId;
  // Approved while the agent still runs, and it uses the tab in that same turn: the queued wake has nothing to say.
  await ctx.lease(requestId, { tabId: 1, level: 'read-only' });
  await delay(5);
  assert.equal((await ctx.api('POST', '/v1/observe', { requestId }, { headers: session.headers })).status, 200);
  await ctx.control({ signedIn: false });
  await ctx.release();
  await ctx.idle(sent.chatId);
  let view = (await ctx.api('GET', `/v1/requests/${requestId}`)).body;
  assert.deepEqual([view.ownerWake.kind, view.ownerWake.state], ['approved', 'skipped']);
  assert.equal((await ctx.calls()).length, 1);
  // Signed out now: the Resume wake fails with chat_signed_out and FAI's line; the popup shows "Could not wake".
  const lease = view.lease;
  await ctx.hub.emit({ type: 'status', leaseId: lease.leaseId, status: 'paused', reason: 'paused' });
  await ctx.lease(requestId, { tabId: 1, level: 'read-only' });
  view = await (async () => {
    for (;;) {
      const got = (await ctx.api('GET', `/v1/requests/${requestId}`)).body;
      if (got.ownerWake.state !== 'queued') return got;
      await delay(20);
    }
  })();
  assert.deepEqual([view.ownerWake.kind, view.ownerWake.state, view.ownerWake.error.code], ['resume', 'failed', 'chat_signed_out']);
  assert.match(view.ownerWake.error.message, /^Claude is not signed in\./);
});

test('MCP server: presents the turn token once and takes fai-chat; a refused token turns its session off', async t => {
  const { AgentSession } = await import('../src/mcp-session.js');
  const { FaiBrowserClient } = await import('../src/client.js');
  const ctx = await setup(t);
  await ctx.chat('send', { provider: 'claude', text: 'hi' });
  const { token } = await ctx.turn(1);
  const agent = (env, pid) => {
    const made = new AgentSession({ env, home: ctx.home, host: 'claude', clientName: 'test', pollMs: 300, pid,
      connect: async () => new FaiBrowserClient({ port: ctx.daemon.port, token: ctx.daemon.token, clientName: 'test' }) });
    ctx.beforeClose(() => made.stop());
    made.start();
    return made;
  };
  const bound = agent({ FAI_CHAT_TURN_TOKEN: token }, 5001);
  assert.equal(await bound.ready(3_000), true);
  assert.deepEqual([bound.capability, bound.wakeReason, bound.chatToken], ['fai-chat', 'ok', null]);
  const views = (await ctx.api('GET', '/v1/sessions')).body.sessions;
  assert.equal(views.find(view => view.sessionId === bound.sessionId).wake, 'fai-chat');
  // A second server with the same token (or one the daemon never minted) gets no session and promises no wakes.
  const copy = agent({ FAI_CHAT_TURN_TOKEN: token }, 5002);
  assert.equal(await copy.ready(1_000), false);
  assert.deepEqual([copy.disabled, copy.sessionId, copy.capability], [true, null, 'none']);
});

test('one cleaner, one template: a FAI chat turn and an open agent\'s chat wake carry the same text; too long is refused', async t => {
  // agent_send answers at once (the test reports each wake after reading it).
  const ctx = await setup(t, { hold: false, chatSendWaitMs: 50 });
  const open = ctx.sessionOf(await ctx.register(undefined, { repo: 'open-agent' }));
  const inputs = [
    '  Pay the bill\r\nnow  ',
    'two   spaces\tand a tab ‮evil‬ "quoted" \\ back',
    'zero​width﻿\u0085next\u009bline\n\n\nend',
  ];
  for (const [index, input] of inputs.entries()) {
    const sent = await ctx.chat('send', { provider: 'claude', text: input });
    const turn = await ctx.turn(index + 1);
    await ctx.idle(sent.chatId);
    const relayed = await ctx.hub.emit({ type: 'agent_send', sessionId: open.sessionId, text: input, browserId: BROWSER });
    const polled = await ctx.api('POST', `/v1/sessions/${open.sessionId}/poll`, { maxMs: 0 }, { headers: open.headers });
    const [wake] = polled.body.wakes;
    assert.ok(wake, JSON.stringify(relayed));
    // The MCP server writes a wake's text from its fields with the same template (src/wake.js wakeText).
    assert.equal(ctx.turnText(turn), wakeText(wake), JSON.stringify(input));
    await ctx.api('POST', `/v1/sessions/${open.sessionId}/wakes/${wake.wakeId}`, { outcome: 'delivered' }, { headers: open.headers });
  }
  const long = 'y'.repeat(4001);
  assert.equal((await ctx.chat('send', { provider: 'claude', text: long })).error.code, 'too_long');
  assert.equal((await ctx.hub.emit({ type: 'agent_send', sessionId: open.sessionId, text: long, browserId: BROWSER })).error.code,
    'too_long');
  assert.equal((await ctx.chat('send', { provider: 'claude', text: 'z'.repeat(25_000) })).error.code, 'too_long',
    'never a transport-sized cut or another code');
  assert.equal((await ctx.calls()).length, inputs.length, 'no turn for a refused message');
});

// The worker's own reports cross the real bridge (src/bridge.js) with their reason: the invited tab leaving its site
// revokes the chat's invite as origin_changed, the tab closing as tab_closed; neither reads as the user's cancel.
for (const reason of ['origin_changed', 'tab_closed']) {
  test(`the page beside the chat, real bridge: the worker's ${reason} revokes the invite; the join is refused as revoked`, async t => {
    const { EXTENSION_ID, FakeExtension, SECRET } = await import('./helpers/fake-extension.js');
    const home = await mkdtemp(join(tmpdir(), 'fai-chat-binding-'));
    await writeFile(join(home, 'control.json'), JSON.stringify({ claude: { hold: true } }));
    const daemon = createDaemon({ home, env: { ...process.env, STANDIN_DIR: home, FAI_BRIDGE_SECRET: SECRET,
      FAI_EXTENSION_ID: EXTENSION_ID }, port: 0, chatPrograms: programs, isAlive: () => true, sweepIntervalMs: 60_000 });
    await daemon.listen();
    const ext = await FakeExtension.connect({ port: daemon.port });
    // One ordered cleanup: the held turn ends, the extension and daemon close, then the folder goes.
    t.after(async () => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        await writeFile(join(home, 'release'), '').catch(() => {});
        const listed = await ext.request('chat_list', {}).catch(() => null);
        if (!listed?.data?.chats?.some(item => item.running)) break;
        await delay(25);
      }
      ext.close();
      await daemon.close();
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    });
    assert.equal((await ext.hello()).ok, true);
    const api = (method, path, body, extra = {}) => call(daemon.port, method, path, body, { token: daemon.token, ...extra });
    const sent = await ext.request('chat_send', { provider: 'claude', text: 'what is this page?', currentTab: { tabId: 7, origin: ORIGIN } });
    assert.equal(sent.ok, true, JSON.stringify(sent));
    const { inviteId } = sent.data.invite;
    let entry;
    for (const deadline = Date.now() + 10_000; !entry && Date.now() < deadline; await delay(20)) {
      entry = (await readFile(join(home, 'calls.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean)
        .map(line => JSON.parse(line)).find(item => item.args && item.token);
    }
    const registered = await api('POST', '/v1/sessions', { host: 'claude', repo: 'ignored', pid: 4999,
      startedAt: new Date().toISOString(), wake: 'claude-socket', chatTurnToken: entry.token });
    assert.equal(registered.status, 201, JSON.stringify(registered.body));
    const cancel = await ext.request('invite_cancel', { inviteId, reason });
    assert.deepEqual([cancel.data.invite.state, cancel.data.invite.endReason], ['revoked', reason], JSON.stringify(cancel));
    const joined = await api('POST', `/v1/invites/${inviteId}/join`, {},
      { headers: { 'X-Fai-Session': `${registered.body.sessionId}:${registered.body.key}` } });
    assert.equal(joined.body.error?.code, 'invite_revoked', JSON.stringify(joined.body));
  });
}
