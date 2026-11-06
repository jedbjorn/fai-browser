// The MCP capability round over the real MCP server, daemon and a fake hub (no browser): fills with the agent's own
// text (one, a batch, then Enter), URL and history navigation, revision-free acts, keys and hover, the Approve-gate
// wait wording, and that nothing a host driving the tab reads names fai_browser_run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createDaemon } from '../src/daemon.js';
import { homePaths, saveDriver } from '../src/home.js';
import { GATE_MAX_WAIT_MS, MAX_BATCH_FILLS, MAX_TYPED_CHARS, TOOLS } from '../src/mcp.js';
import { MAX_BATCH_FILLS as RUNTIME_BATCH, MAX_TYPED_CHARS as RUNTIME_CHARS, pressKey } from '../src/runtime.js';
import { directMessage, directNext } from '../src/result.js';
import { levelRefusalText } from '../src/oversight.js';
import { createFakeHub } from './helpers/fake-hub.js';
import { spawnMcp } from './helpers/mcp-harness.js';
import { mcpData, mcpDirect } from './helpers/mcp-result.js';
import { ORIGIN, link } from './runtime-fixtures.js';
import { leakNeedles, leaks, loadFakes } from './helpers/secret-fakes.js';

const field = (id, label, extra = {}) => ({ id, role: 'textbox', label, type: 'text', enabled: true, ...extra });
const button = (id, label, extra = {}) => ({ id, role: 'button', label, enabled: true, ...extra });

export const FORM_PAGES = {
  '/': { title: 'Shop', text: 'Find things', controls: [
    field('1', 'Search', { enter: 'submit_safe', submitHref: `${ORIGIN}/results` }),
    link('2', 'Contact', '/contact'),
    link('3', 'Partner', 'https://partner.example/offers'),
    button('4', 'Menu', { revealsOnHover: [link('9', 'Hidden settings', '/settings')] }),
  ] },
  '/results': { title: 'Results', text: 'Result one: the blue kettle', controls: [link('1', 'Home', '/')] },
  '/contact': { title: 'Contact', text: 'Write to us', controls: [
    field('1', 'Name'), field('2', 'Email', { type: 'email' }), field('3', 'Subject'),
    { id: '4', role: 'textbox', label: 'Message', type: 'textarea', enabled: true, enter: 'submit', submitHref: `${ORIGIN}/sent` },
    { id: '5', role: 'textbox', label: 'Password', type: 'password', enabled: true },
    field('6', 'Card number', { autocomplete: 'cc-number' }),
  ] },
  '/sent': { title: 'Sent', text: 'Thanks, message sent', controls: [link('1', 'Home', '/')] },
  '/settings': { title: 'Settings', text: 'Settings page', controls: [link('1', 'Home', '/')] },
};

export async function setup(t, { pages = FORM_PAGES, env = {} } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'fai-capability-'));
  saveDriver('agent', homePaths({ home, env: {} }));
  const hub = createFakeHub({ bridgeOptions: { pages } });
  const daemon = createDaemon({ home, env: {}, port: 0, hub,
    providerFactory: () => { throw new Error('Agent direct must never construct a provider'); } });
  await daemon.listen();
  const mcp = spawnMcp({ FAI_HOME: home, FAI_DAEMON_PORT: String(daemon.port), FAI_MCP_APPROVAL_WAIT_MS: '1000', ...env });
  t.after(async () => {
    await mcp.close();
    await daemon.close();
    await rm(home, { recursive: true, force: true });
  });
  await mcp.initialize();
  return { home, daemon, hub, mcp, bridge: () => hub.bridgeForTab(1) };
}

async function pendingRequest(hub) {
  for (let i = 0; i < 400; i++) {
    const request = hub.published.at(-1)?.find(item => item.state === 'pending');
    if (request) return request;
    await delay(5);
  }
  throw new Error('No pending request');
}

export async function opened(ctx, level = 'reversible', args = {}) {
  const opening = ctx.mcp.callTool('fai_browser_open', { origins: [ORIGIN], reason: 'Test task', mode: level, ...args });
  const pending = await pendingRequest(ctx.hub);
  await ctx.hub.approve(pending.requestId, { level });
  const result = await opening;
  return mcpDirect(result);
}

export const act = async (ctx, args) => {
  const result = await ctx.mcp.callTool('fai_browser_act', args);
  return mcpDirect(result);
};
const find = (result, pattern) => result.actions.find(action => pattern.test(action.description));

test('constants agree between the MCP server and the runtime; the act schema has short descriptions', () => {
  assert.equal(MAX_TYPED_CHARS, RUNTIME_CHARS);
  assert.equal(MAX_BATCH_FILLS, RUNTIME_BATCH);
  const schema = TOOLS.find(tool => tool.name === 'fai_browser_act').inputSchema;
  assert.equal(schema.required, undefined, 'revision is optional');
  assert.match(schema.properties.revision.description, /needsApproval/);
  assert.match(schema.properties.actionId.description, /actions\[\]\.id/);
  assert.ok(GATE_MAX_WAIT_MS <= 90_000, 'one act never waits past a 120 s host timeout');
  assert.deepEqual(pressKey('ctrl+a'), { wire: 'Ctrl+A', key: 'a', modifier: true });
  assert.equal(pressKey('Shift+Tab').wire, 'Shift+Tab');
  assert.equal(pressKey('F12'), null);
  assert.equal(pressKey('Alt+F4'), null);
});

test('agent text: fill with text and submit in one act; the echo carries the length, never the value', async t => {
  const ctx = await setup(t);
  const page = await opened(ctx, 'interactive');
  const search = find(page, /^fill textbox "Search" \(act with text\)$/);
  assert.ok(search, page.text);
  const typed = 'blue kettle!';
  const done = await act(ctx, { actionId: search.id, text: typed, submit: true, expectation: { urlIncludes: '/results' } });
  assert.equal(done.status, 'completed', done.text);
  assert.equal(done.verification.passed, true);
  assert.deepEqual(done.did, ['fill "Search" (12 chars)', 'press Enter in "Search"']);
  assert.ok(!JSON.stringify(done).includes(typed), 'the typed value is never echoed');
  assert.match(done.text, /did: fill "Search" \(12 chars\)/);
  const executions = ctx.bridge().executions.map(entry => entry.action);
  assert.equal(executions[0].type, 'fill_supplied_text');
  assert.equal(executions[0].typed, true);
  assert.equal(executions[0].text, typed);
  assert.equal(executions[1].type, 'submit_field');
  // The trace keeps the length only.
  const trace = await ctx.mcp.callTool('fai_browser_evidence', { runId: done.runId, kind: 'trace' });
  assert.ok(!trace.content.map(block => block.text ?? '').join('').includes(typed), 'the trace never holds the typed text');
});

test('agent text: submit needs the level its form submit needs; text is refused outside a fill', async t => {
  const ctx = await setup(t);
  const page = await opened(ctx, 'reversible');
  const search = find(page, /^fill textbox "Search"/);
  const refused = await act(ctx, { actionId: search.id, text: 'kettle', submit: true });
  assert.equal(refused.code, 'refused_action', refused.text);
  assert.equal(refused.needs.level, 'interactive');
  assert.equal(refused.next.kind, 'relay');
  const contact = find(refused, /click "Contact"/);
  const bad = await act(ctx, { actionId: contact.id, text: 'x' });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /text goes with a fill/);
  const missing = await act(ctx, { actionId: find(refused, /^fill textbox "Search"/).id });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /give the text/);
});

test('fills batch: four fields in one call, then submit at full; password and payment fields are never offered for text', async t => {
  const ctx = await setup(t);
  await opened(ctx, 'full');
  const contact = await act(ctx, { url: `${ORIGIN}/contact` });
  assert.equal(contact.status, 'acted', contact.text);
  assert.deepEqual(contact.did, [`open ${ORIGIN}/contact`]);
  const ids = Object.fromEntries(['Name', 'Email', 'Subject', 'Message']
    .map(label => [label, find(contact, new RegExp(`^fill textbox "${label}" \\(act with text\\)$`))?.id]));
  for (const [label, id] of Object.entries(ids)) assert.ok(id, `${label} is offered for text`);
  assert.equal(find(contact, /"Password" \(act with text\)/), undefined, 'never a password field');
  assert.equal(find(contact, /"Card number" \(act with text\)/), undefined, 'never a payment field');
  const sent = await act(ctx, {
    fills: [{ actionId: ids.Name, text: 'Ada' }, { actionId: ids.Email, text: 'ada@example.com' },
      { actionId: ids.Subject, text: 'Hello' }, { actionId: ids.Message, text: 'A short note' }],
    submit: true, revision: contact.revision, expectation: { textIncludes: 'message sent' },
  });
  assert.equal(sent.status, 'completed', sent.text);
  assert.equal(sent.did.length, 5);
  assert.equal(sent.did.at(-1), 'press Enter in "Message"');
  assert.deepEqual(ctx.bridge().typed.map(entry => entry.text), ['Ada', 'ada@example.com', 'Hello', 'A short note']);
  const passwordFill = await act(ctx, { fills: [{ actionId: 'a99', text: 'x' }] });
  assert.equal(passwordFill.isError, true);
});

test('navigation: url on the granted origins, back, forward; another origin is cross_origin with the open hint', async t => {
  const ctx = await setup(t);
  await opened(ctx, 'read-only');
  const contact = await act(ctx, { url: '/contact' });
  assert.equal(contact.page.url, `${ORIGIN}/contact`, contact.text);
  const back = await act(ctx, { nav: 'back', expectation: { urlEquals: `${ORIGIN}/` } });
  assert.equal(back.status, 'completed', back.text);
  assert.deepEqual(back.did, ['go back']);
  const forward = await act(ctx, { nav: 'forward' });
  assert.equal(forward.page.url, `${ORIGIN}/contact`);
  const outside = await act(ctx, { url: 'https://partner.example/offers' });
  assert.equal(outside.code, 'cross_origin', outside.text);
  assert.equal(outside.next.kind, 'relay');
  assert.match(outside.needs.message, /https:\/\/partner\.example/);
  assert.doesNotMatch(outside.text, /fai_browser_run/);
  const scheme = await act(ctx, { url: 'javascript:alert(1)' });
  assert.equal(scheme.code, 'refused_action');
  const logout = await act(ctx, { url: '/logout' });
  assert.equal(logout.code, 'refused_action', logout.text);
  assert.equal(ctx.bridge().path, '/contact', 'nothing outside or action-like was opened');
});

test('revision is optional for plain acts and required for approvals, secrets and points', async t => {
  const ctx = await setup(t);
  const page = await opened(ctx, 'reversible');
  // A late page update since the host's result: the same link still resolves without a revision.
  ctx.bridge().version++;
  const contact = await act(ctx, { actionId: find(page, /click "Contact"/).id });
  assert.equal(contact.status, 'acted', contact.text);
  assert.equal(contact.page.url, `${ORIGIN}/contact`);
  const name = find(contact, /^fill textbox "Name"/);
  ctx.bridge().version++;
  const filled = await act(ctx, { actionId: name.id, text: 'Ada' });
  assert.equal(filled.status, 'acted', filled.text);
  assert.ok(filled.warnings?.includes('act_reresolved'));
  const point = await act(ctx, { point: { x: 5, y: 5 } });
  assert.equal(point.isError, true);
  assert.match(point.text, /revision is required with point/);
});

test('revision-free acts never re-resolve a changed wizard step or a class-named button', async t => {
  const pages = { '/': { title: 'Wizard', text: 'Step 1', controls: [button('1', 'Next'), button('2', 'Delete draft')] } };
  const ctx = await setup(t, { pages });
  const page = await opened(ctx, 'full');
  ctx.bridge().version++;
  ctx.bridge().pages['/'].text = 'Step 2: payment';
  const next = await act(ctx, { actionId: find(page, /click button "Next"/).id });
  assert.equal(next.code, 'stale', next.text);
  assert.equal(next.next.kind, 'observe');
});

test('keys and hover: reversible presses Escape and Tab; a shortcut needs full; Enter only in a filled field; hover reveals a menu', async t => {
  const ctx = await setup(t);
  const page = await opened(ctx, 'reversible');
  const escape = await act(ctx, { key: 'Escape' });
  assert.equal(escape.status, 'acted', escape.text);
  assert.deepEqual(escape.did, ['press Escape']);
  const tab = await act(ctx, { key: 'shift+tab', actionId: find(escape, /^fill textbox "Search"/).id });
  assert.equal(tab.status, 'acted', tab.text);
  assert.deepEqual(ctx.bridge().keys.map(entry => entry.key), ['Escape', 'Shift+Tab']);
  assert.equal(ctx.bridge().keys[1].target, '1');
  const shortcut = await act(ctx, { key: 'Ctrl+A' });
  assert.equal(shortcut.code, 'refused_action');
  assert.equal(shortcut.needs.level, 'full');
  const enter = await act(ctx, { key: 'Enter' });
  assert.equal(enter.isError, true);
  assert.match(enter.text, /Enter is pressed in a filled field/);
  const bad = await act(ctx, { key: 'F12' });
  assert.equal(bad.isError, true);
  const menu = find(tab, /click button "Menu"/);
  const hovered = await act(ctx, { actionId: menu.id, hover: true });
  assert.equal(hovered.status, 'acted', hovered.text);
  assert.deepEqual(hovered.did, ['hover "Menu"']);
  assert.ok(find(hovered, /click "Hidden settings"/), 'the hover revealed the menu item');
  assert.deepEqual(ctx.bridge().hovers, ['4']);
  void page;
});

test('read-only: keys, hover and typed text relay the level; URL and history navigation run', async t => {
  const ctx = await setup(t);
  const page = await opened(ctx, 'read-only');
  assert.equal(find(page, /act with text/), undefined, 'no fills below reversible');
  const key = await act(ctx, { key: 'Escape' });
  assert.equal(key.code, 'refused_action');
  assert.equal(key.needs.level, 'reversible');
  const hover = await act(ctx, { actionId: find(key, /click "Contact"/).id, hover: true });
  assert.equal(hover.code, 'refused_action');
  assert.equal(hover.needs.level, 'reversible');
});

test('forbid applies to composed acts: a forbidden field is never offered for text', async t => {
  const ctx = await setup(t);
  const page = await opened(ctx, 'reversible', { policy: { forbid: ['Search'] } });
  assert.equal(find(page, /"Search"/), undefined, page.text);
});

test('approve-gate wording states the real wait and how to resume; no direct text names fai_browser_run', () => {
  const pending = { status: 'needs_user', code: 'approval_pending',
    needs: { control: { label: 'Buy now' }, approval: { actionId: 'a4', revision: 'r9', expiresInMs: 300000 } } };
  const next = directNext(pending, { requestId: 'req-1', gateWaitMs: 60_000 });
  assert.equal(next.kind, 'approve');
  assert.match(next.text, /waits up to 60 s/);
  assert.match(next.text, /returns at once if they already approved/);
  assert.match(next.text, /actionId a4 and revision "r9"/);
  assert.doesNotMatch(next.text, /waits up to 5 minutes/);
  const level = directMessage(levelRefusalText({ granted: 'full', needed: 'interactive' }), 'req-1');
  assert.match(level, /fai_browser_observe with mode "interactive"/);
  const origin = directMessage('The tab is on https://b.example, which this request does not cover. If https://b.example is a '
    + 'consent or redirect page the task needs, call fai_browser_run again with https://b.example added to origins.', 'req-1');
  assert.match(origin, /call fai_browser_open with requestId req-1 and https:\/\/b\.example added to origins/);
  assert.doesNotMatch(origin + level, /fai_browser_run/);
});

test('no direct-mode output names fai_browser_run: results, needs, next, errors', async t => {
  const pages = { ...FORM_PAGES, '/': { ...FORM_PAGES['/'], controls: [...FORM_PAGES['/'].controls, button('7', 'Delete account')] } };
  const ctx = await setup(t, { pages });
  const outputs = [];
  const page = await opened(ctx, 'read-only');
  outputs.push(page.text, JSON.stringify(page));
  for (const args of [{ url: 'https://partner.example/' }, { key: 'Escape' }, { actionId: 'a77' }, {},
    { nav: 'back' }, { requestId: 'nope', actionId: 'a1' }]) {
    const result = await act(ctx, args);
    outputs.push(result.text, JSON.stringify(result));
  }
  const status = await ctx.mcp.callTool('fai_browser_status', {});
  outputs.push(JSON.stringify(status));
  const observe = await ctx.mcp.callTool('fai_browser_observe', { mode: 'full' });
  outputs.push(JSON.stringify(observe));
  for (const output of outputs) assert.doesNotMatch(output, /fai_browser_run/, output.slice(0, 300));
});

test('observe waitFor polls until the redacted page meets the condition, and says when it did not', async t => {
  const pages = { ...FORM_PAGES, '/': { ...FORM_PAGES['/'], text: 'Loading results' } };
  const ctx = await setup(t, { pages });
  await opened(ctx, 'read-only');
  setTimeout(() => {
    ctx.bridge().pages['/'].text = 'Result one: the blue kettle';
    ctx.bridge().version++;
  }, 600);
  const done = await ctx.mcp.callTool('fai_browser_observe', { waitFor: { textAbsent: 'Loading' }, maxMs: 5000 });
  const result = mcpData(done);
  assert.equal(result.waited.passed, true, done.content[0].text);
  assert.ok(result.waited.ms >= 400, 'it polled');
  assert.match(done.content[0].text, /waited: condition met/);
  const missed = await ctx.mcp.callTool('fai_browser_observe', { waitFor: { textIncludes: 'never there' }, maxMs: 800 });
  assert.equal(mcpData(missed).waited.passed, false);
  assert.match(missed.content[0].text, /condition not met/);
  const bad = await ctx.mcp.callTool('fai_browser_observe', { waitFor: { titleEquals: 'x' } });
  assert.equal(bad.isError, true, 'only textIncludes, textAbsent and urlIncludes');
  // A secret on the page never matches: the condition is checked on the redacted page.
  ctx.bridge().pages['/'].text = 'Your key sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd';
  ctx.bridge().version++;
  const secret = await ctx.mcp.callTool('fai_browser_observe', { waitFor: { textIncludes: 'sk-proj-AbCdEfGh' }, maxMs: 600 });
  assert.equal(mcpData(secret).waited.passed, false);
  assert.ok(!JSON.stringify(secret).includes('AbCdEfGhIjKl'));
});

test('tabs: a popup the lease followed is listed; switch_tab moves to it; an unknown tab is refused', async t => {
  const ctx = await setup(t);
  await opened(ctx, 'read-only');
  ctx.bridge().tabs = [
    { id: 't0', path: '/', url: `${ORIGIN}/`, title: 'Shop' },
    { id: 't1', path: '/contact', url: `${ORIGIN}/contact`, title: 'Contact', current: true },
  ];
  ctx.bridge().path = '/contact';
  ctx.bridge().version++;
  const seen = await ctx.mcp.callTool('fai_browser_observe', {});
  assert.deepEqual(mcpData(seen).tabs.map(tab => tab.id), ['t0', 't1']);
  assert.equal(mcpData(seen).tabs[1].current, true);
  assert.match(seen.content[0].text, /tabs: t0 Shop \| t1\* Contact/);
  const back = await act(ctx, { tab: 't0' });
  assert.equal(back.status, 'acted', back.text);
  assert.deepEqual(back.did, ['switch to tab t0']);
  assert.equal(back.page.url, `${ORIGIN}/`);
  assert.equal(back.tabs.find(tab => tab.current).id, 't0');
  const unknown = await act(ctx, { tab: 't7' });
  assert.notEqual(unknown.status, 'acted', unknown.text);
  const bad = await act(ctx, { tab: 'window-3' });
  assert.equal(bad.isError, true);
});

test('dev logs: Test site only, redacted, request URL and status without bodies; elsewhere a warning and no logs', async t => {
  const logs = [
    { kind: 'error', text: 'TypeError: x is undefined' },
    { kind: 'network', method: 'POST', url: `${ORIGIN}/api/save?…`, status: 500, text: 'Internal Server Error' },
    { kind: 'warning', text: 'token sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd leaked' },
  ];
  const pages = { ...FORM_PAGES, '/': { ...FORM_PAGES['/'], logs } };
  const ctx = await setup(t, { pages });
  await opened(ctx, 'testing');
  const seen = await ctx.mcp.callTool('fai_browser_observe', { logs: true });
  const result = mcpData(seen);
  assert.equal(result.logs.length, 3, seen.content[0].text);
  assert.deepEqual(result.logs[1], { kind: 'network', text: 'Internal Server Error', status: 500, method: 'POST', url: `${ORIGIN}/api/save?…` });
  assert.match(seen.content[0].text, /log network 500 POST https:\/\/example\.com\/api\/save\?…: Internal Server Error/);
  assert.ok(!JSON.stringify(seen).includes('AbCdEfGhIjKl'), 'a secret in a log line is redacted');
  assert.equal(ctx.bridge().observeOptions.at(-1)?.logs, true, 'the bridge was asked for logs');
  const plain = await ctx.mcp.callTool('fai_browser_observe', {});
  assert.equal(mcpData(plain).logs, undefined, 'logs only when asked for');

  const other = await setup(t, { pages });
  await opened(other, 'full');
  const refused = await other.mcp.callTool('fai_browser_observe', { logs: true });
  assert.equal(mcpData(refused).logs, undefined);
  assert.ok(mcpData(refused).warnings.includes('logs_need_testing'));
  assert.notEqual(other.bridge().observeOptions.at(-1)?.logs, true, 'never asked of the extension below testing');
});

test('JS dialogs: shown on a Test site; accept arms the next answer; a destructive confirm asks Approve; refused below testing', async t => {
  const pages = { ...FORM_PAGES, '/': { ...FORM_PAGES['/'], dialog: { kind: 'confirm', text: 'Delete this item permanently?', answered: 'dismiss' } } };
  const ctx = await setup(t, { pages });
  const page = await opened(ctx, 'testing');
  assert.deepEqual(page.dialog, { kind: 'confirm', text: 'Delete this item permanently?', answered: 'dismiss' });
  assert.match(page.text, /js dialog \(confirm, dismissed\): Delete this item permanently\?/);
  const answers = [];
  ctx.bridge().approve = async details => {
    answers.push(details);
    return { decision: 'approved', approvalId: 'appr-1' };
  };
  const accepted = await act(ctx, { dialog: 'accept', revision: page.revision, reason: 'The user asked to delete it' });
  assert.equal(accepted.status, 'acted', accepted.text);
  assert.deepEqual(accepted.did, ['accept the dialog']);
  assert.equal(answers.length, 1, 'the user approved accepting a destructive confirm');
  assert.equal(answers[0].kind, 'dialog');
  assert.equal(answers[0].cls, 'delete');
  assert.equal(ctx.bridge().dialogs.at(-1).answer, 'accept');
  assert.equal(ctx.bridge().executions.at(-1).action.approvalId, 'appr-1');
  // A plain dismiss never asks.
  ctx.bridge().pages['/'].dialog = { kind: 'confirm', text: 'Leave this page?', answered: 'dismiss' };
  ctx.bridge().version++;
  const dismissed = await act(ctx, { dialog: 'dismiss' });
  assert.equal(dismissed.status, 'acted', dismissed.text);
  assert.equal(answers.length, 1);

  const other = await setup(t, { pages });
  await opened(other, 'full');
  const refused = await act(other, { dialog: 'accept' });
  assert.equal(refused.code, 'refused_action', refused.text);
  assert.match(refused.needs.message, /Test site/);
  assert.equal(other.bridge().dialogs, undefined);
});

const UPLOAD_PAGES = {
  '/': { title: 'Profile', text: 'Upload your avatar', controls: [
    { id: '1', role: 'textbox', label: 'Avatar', type: 'file', enabled: true },
    link('2', 'Home', '/'),
  ] },
};

test('upload: Act and Test site only, a workspace file the user approves (name, size); no path or symlink out; never the bytes in results', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'fai-workspace-'));
  const outside = await mkdtemp(join(tmpdir(), 'fai-outside-'));
  t.after(() => Promise.all([rm(workspace, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  await writeFile(join(workspace, 'avatar.png'), Buffer.from('PNGDATA-1234567890'));
  await writeFile(join(outside, 'secret.txt'), 'top secret');
  await symlink(join(outside, 'secret.txt'), join(workspace, 'link.txt'));
  const ctx = await setup(t, { pages: UPLOAD_PAGES, env: { FAI_WORKSPACE: workspace } });
  const page = await opened(ctx, 'full');
  const upload = find(page, /^upload a file to "Avatar" \(act with path\) \(asks the user\)$/);
  assert.ok(upload, page.text);
  const asked = [];
  ctx.bridge().approve = async details => {
    asked.push(details);
    return { decision: 'approved', approvalId: 'appr-up' };
  };
  for (const path of ['../' + outside.split('/').pop() + '/secret.txt', join(outside, 'secret.txt'), 'link.txt', 'missing.png', '.']) {
    const refused = await act(ctx, { actionId: upload.id, path, revision: page.revision });
    assert.equal(refused.isError, true, `${path}: ${refused.text}`);
  }
  const noRevision = await act(ctx, { actionId: upload.id, path: 'avatar.png' });
  assert.equal(noRevision.isError, true, 'an upload the user approves needs the revision');
  const done = await act(ctx, { actionId: upload.id, path: 'avatar.png', revision: page.revision, reason: 'The user asked for this avatar' });
  assert.equal(done.status, 'acted', done.text);
  assert.deepEqual(done.did, ['upload "avatar.png" (18 bytes) to "Avatar"']);
  assert.equal(asked.length, 1);
  assert.deepEqual({ kind: asked[0].kind, cls: asked[0].cls, file: asked[0].file }, { kind: 'upload', cls: 'submit', file: { name: 'avatar.png', size: 18 } });
  const sent = ctx.bridge().uploads.at(-1);
  assert.equal(Buffer.from(sent.file.data, 'base64').toString(), 'PNGDATA-1234567890');
  assert.equal(sent.file.type, 'image/png');
  assert.equal(sent.approvalId, 'appr-up');
  assert.ok(!JSON.stringify(done).includes(sent.file.data), 'the bytes never come back');
  const trace = await ctx.mcp.callTool('fai_browser_evidence', { runId: done.runId, kind: 'trace' });
  assert.ok(!trace.content.map(block => block.text ?? '').join('').includes(sent.file.data), 'nor go into the trace');

  const lower = await setup(t, { pages: UPLOAD_PAGES, env: { FAI_WORKSPACE: workspace } });
  const interactive = await opened(lower, 'interactive');
  assert.equal(find(interactive, /upload a file/), undefined, 'no upload below Act');
});

test('leak scan: tabs, dialogs, logs, waitFor and did lines over the fixture fake secrets carry none of them', async t => {
  const fakes = loadFakes();
  const needles = leakNeedles(fakes);
  const pages = { ...FORM_PAGES, '/': { ...FORM_PAGES['/'],
    text: `Loading ${fakes.github}`,
    dialog: { kind: 'confirm', text: `Rotate ${fakes.openai}?`, answered: 'dismiss' },
    logs: [{ kind: 'error', text: `auth failed for ${fakes.stripe}` },
      { kind: 'network', method: 'GET', url: `${ORIGIN}/api/${fakes.anthropic}`, status: 401, text: 'Unauthorized' }],
  } };
  const ctx = await setup(t, { pages });
  const outputs = [];
  const page = await opened(ctx, 'testing');
  outputs.push(page.text, JSON.stringify(page));
  ctx.bridge().tabs = [
    { id: 't0', path: '/', url: `${ORIGIN}/`, title: `Shop ${fakes.slack}` },
    { id: 't1', path: '/contact', url: `${ORIGIN}/contact?token=${fakes.npm}`, title: 'Contact', current: true },
  ];
  ctx.bridge().version++;
  const observed = await ctx.mcp.callTool('fai_browser_observe', { logs: true, waitFor: { textIncludes: 'never' }, maxMs: 600 });
  outputs.push(observed.content.map(block => block.text ?? '').join('\n'));
  assert.ok(mcpData(observed).logs.length >= 2, observed.content[0].text);
  const typed = await act(ctx, { actionId: find(page, /^fill textbox "Search"/).id, text: fakes.google });
  outputs.push(typed.text, JSON.stringify(typed));
  for (const output of outputs) {
    const found = leaks(output, needles);
    assert.deepEqual(found, [], `${found.join(', ')} in ${output.slice(0, 200)}`);
  }
});
