// The Approve gate (docs/REFERENCE.md "Approve gate"), runtime and MCP side: which controls a host-driven offer marks
// `needsApproval` (purchase pages, commit dialogs, credential actions, submits and deletes above the level), what an
// act on one does for each extension answer (approved, denied, pending, off, refused), that an approved click carries
// the extension's id and nothing else, and that the next step reads `approve` with the label and the way back.
// The extension's own side (minting, binding, forged ids, the page script's recheck) is in
// test/approve-gate-extension.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDaemon } from '../src/daemon.js';
import { createFakeHub } from './helpers/fake-hub.js';
import { spawnMcp } from './helpers/mcp-harness.js';
import { mcpData } from './helpers/mcp-result.js';
import { BrowserRuntime, legalActions } from '../src/runtime.js';
import { directNext, directResult } from '../src/result.js';
import { purchasePage, secretAction } from '../src/guardrails.js';
import { FakeBridge, ORIGIN, link } from './runtime-fixtures.js';

const button = (id, label, extra = {}) => ({ id, role: 'button', label, enabled: true, visible: true, risk: 'reversible', ...extra });

// Synthetic, site-neutral markups (as observations): a checkout page by path, a page with a payment field, a page
// with a total line, a settings page with a commit dialog, a credentials page.
const PAGES = {
  '/': { title: 'Home', text: 'Welcome', controls: [link('1', 'Shop', '/shop/cart/checkout')] },
  '/shop/cart/checkout': { title: 'Checkout', text: 'Shipping\nTotal $41.99', controls: [
    button('1', 'Place order', { risk: 'purchase' }),
    button('2', 'Apply coupon'),
    button('3', '+', {}),
    button('4', 'Back'),
    link('5', 'Help', '/help'),
    button('6', 'Pay', { region: 'checkout' }),
    button('7', 'Continue to payment'),
    button('8', 'Search', { region: 'navigation', label: 'Search' }),
  ] },
  '/account/billing.html': { title: 'Billing', text: 'Invoices', controls: [
    button('1', 'Save address'),
    button('2', 'Publish profile'),
    button('3', 'Confirm'),
  ] },
  '/cart': { title: 'Cart', text: 'Your cart\nOrder summary\nItems (2)  €19,90', controls: [
    button('1', 'Continue'),
    button('2', 'Increase quantity'),
  ] },
  '/donate': { title: 'Give', text: 'Support us', controls: [
    { id: '1', role: 'textbox', label: 'Card number', type: 'text', enabled: true, visible: true, risk: 'reversible', autocomplete: 'cc-number' },
    button('2', 'Next'),
  ] },
  '/settings': { title: 'Settings', text: 'Workspace', controls: [
    button('1', 'Yes', { dialog: true, risk: 'delete', gate: 'delete' }),
    button('2', 'Cancel', { dialog: true }),
    button('3', 'Save changes', { risk: 'submit' }),
    button('4', 'Remove member', { risk: 'delete' }),
  ] },
  // A settings page on another origin, after a key was read (the worker's vault: handles and placeholders, no value).
  '/deploy': { title: 'Deploy', text: 'Project settings', secrets: [
    { handle: '3', kind: 'openai', origin: 'https://platform.example', label: '[secret:3 openai sk-proj-…Ab12 len 64]' },
    { handle: '4', kind: 'generic', origin: 'https://platform.example', label: '[secret:4]' },
  ], controls: [
    { id: '1', role: 'textbox', label: 'API key', type: 'text', enabled: true, visible: true, risk: 'reversible', secretTarget: true },
    { id: '2', role: 'textbox', label: 'Notes', type: 'text', enabled: true, visible: true, risk: 'reversible' },
    { id: '3', role: 'textbox', label: 'Database password', type: 'password', enabled: true, visible: true, risk: 'sign_in', secretTarget: true },
    button('4', 'Save', { bounds: { x: 0, y: 0, width: 50, height: 20 } }),
  ] },
  '/keys': { title: 'API keys', text: 'Keys', controls: [
    button('1', 'Create API key', { gate: 'secret' }),
    button('2', 'Show password', { gate: 'secret' }),
    button('3', 'Refresh'),
    button('4', 'Delete token', { risk: 'delete', gate: 'secret' }),
  ] },
};

function runtimeOn(path, { approve, asks } = {}) {
  const bridge = new FakeBridge({ pages: Object.fromEntries(Object.entries(PAGES).map(([key, page]) => [key, { ...page, url: ORIGIN + key }])), path });
  if (approve) bridge.approve = approve;
  return { bridge, runtime: new BrowserRuntime({ bridge, ...(asks ? { asks: () => asks } : {}) }) };
}

async function offer(path, level, approve = async () => ({ decision: 'pending' }), asks = undefined) {
  const { bridge, runtime } = runtimeOn(path, { approve, asks });
  const observed = await runtime.observe({ mode: level, grant: { level }, allowedOrigins: [ORIGIN] });
  return { bridge, runtime, observed, byLabel: label => observed.actions.find(action => action.label === label) };
}

test('guardrails: purchase pages, totals and credential actions are recognised on distinct markups', () => {
  assert.equal(purchasePage({ path: '/shop/cart/checkout' }), true);
  assert.equal(purchasePage({ path: '/account/billing' }), true);
  assert.equal(purchasePage({ path: '/account/billing.html' }), true, 'a segment stem counts');
  assert.equal(purchasePage({ path: '/checkout.php?step=2' }), true);
  assert.equal(purchasePage({ path: '/billingual/notes' }), false);
  assert.equal(purchasePage({ path: '/orders.html' }), false, 'order history is no purchase page, as a file either');
  assert.equal(purchasePage({ path: '/orders' }), false, 'order history is no purchase page');
  assert.equal(purchasePage({ text: 'Order summary\nItems (2)  €19,90' }), true);
  assert.equal(purchasePage({ text: 'Order 112-1, total $41.99.' }), false, 'a total inside a sentence is not a summary');
  assert.equal(purchasePage({ payment: true }), true);
  for (const label of ['Show password', 'Create API key', 'Regenerate recovery codes', 'Roll secret', 'Copy token']) assert.ok(secretAction(label), label);
  for (const label of ['Show more', 'View keyboard shortcuts', 'Copy', 'Key features']) assert.ok(!secretAction(label), label);
});

test('offers: on a purchase page commit-like or checkout-region buttons are purchases, approvable once from full; others stay', async () => {
  const full = await offer('/shop/cart/checkout', 'full');
  assert.equal(full.byLabel('Place order').needsApproval, 'purchase');
  assert.match(full.byLabel('Place order').description, /\(asks the user\)$/);
  assert.equal(full.byLabel('Apply coupon').needsApproval, undefined, 'not commit-like, outside the checkout region');
  assert.equal(full.byLabel('Pay').needsApproval, 'purchase', 'in the checkout region (the page script\'s mark)');
  assert.equal(full.byLabel('Continue to payment').needsApproval, 'purchase');
  assert.equal(full.byLabel('Search').needsApproval, undefined, 'navigation and search forms stay as they were');
  assert.equal(full.byLabel('+').needsApproval, undefined, 'a quantity stepper is no purchase');
  assert.equal(full.byLabel('Back').needsApproval, undefined, 'a back-out is no purchase');
  assert.equal(full.byLabel('Help').needsApproval, undefined, 'a link stays navigation');
  // Below full a purchase is never approvable: refused as before; the rest is offered at its own level.
  const reversible = await offer('/shop/cart/checkout', 'reversible');
  assert.equal(reversible.byLabel('Place order'), undefined);
  assert.equal(reversible.byLabel('Pay'), undefined);
  assert.ok(reversible.byLabel('Apply coupon'));
  // A total line and a payment field make purchase pages too.
  assert.equal((await offer('/cart', 'full')).byLabel('Continue').needsApproval, 'purchase');
  assert.equal((await offer('/cart', 'full')).byLabel('Increase quantity').needsApproval, undefined);
  assert.equal((await offer('/donate', 'full')).byLabel('Next').needsApproval, 'purchase');
  // A purchase page by its path stem: only the commit-like label asks; a save or a publish keeps its own class.
  const billing = await offer('/account/billing.html', 'full');
  assert.equal(billing.byLabel('Confirm').needsApproval, 'purchase');
  assert.equal(billing.byLabel('Save address').needsApproval, undefined);
  assert.equal(billing.byLabel('Publish profile').needsApproval, undefined);
  // At testing purchases run without asking.
  assert.equal((await offer('/shop/cart/checkout', 'testing')).byLabel('Place order').needsApproval, undefined);
});

test('offers: commit dialogs and submits or deletes above the level ask; credential actions ask at every level, testing too', async () => {
  const reversible = await offer('/settings', 'reversible');
  assert.equal(reversible.byLabel('Yes').needsApproval, 'delete', 'a commit dialog button is a delete');
  assert.equal(reversible.byLabel('Cancel').needsApproval, undefined);
  assert.equal(reversible.byLabel('Save changes').needsApproval, 'submit');
  assert.equal(reversible.byLabel('Remove member').needsApproval, 'delete');
  const full = await offer('/settings', 'full');
  assert.equal(full.byLabel('Yes').needsApproval, undefined, 'at full a delete runs as granted');
  assert.equal(full.byLabel('Save changes').needsApproval, undefined);
  for (const level of ['reversible', 'full', 'testing']) {
    const keys = await offer('/keys', level);
    assert.equal(keys.byLabel('Create API key').needsApproval, 'secret', level);
    assert.equal(keys.byLabel('Show password').needsApproval, 'secret', level);
    assert.equal(keys.byLabel('Delete token').needsApproval, 'secret', level);
    assert.equal(keys.byLabel('Refresh').needsApproval, undefined, level);
  }
  // Read-only offers nothing to approve.
  const readOnly = await offer('/keys', 'read-only');
  assert.ok(readOnly.observed.actions.every(action => !action.needsApproval));
  // A run (no approval path) is never offered a credential action: page.js would refuse it without an approval.
  const runOffer = legalActions({ url: `${ORIGIN}/keys`, controls: PAGES['/keys'].controls }, { mode: 'full' });
  assert.ok(!runOffer.some(action => action.label === 'Create API key' || action.label === 'Show password'));
  // A bridge that cannot ask (an SDK bridge) offers nothing to approve either.
  const plain = new BrowserRuntime({ bridge: new FakeBridge({ pages: { '/keys': { ...PAGES['/keys'], url: `${ORIGIN}/keys` } }, path: '/keys' }) });
  const observed = await plain.observe({ mode: 'full', grant: { level: 'full' }, allowedOrigins: [ORIGIN] });
  assert.ok(observed.actions.every(action => !action.needsApproval));
});

test('act approved: the extension is asked with the control, the class and the agent\'s line; the click carries its id', async () => {
  const asked = [];
  const { bridge, runtime, observed, byLabel } = await offer('/shop/cart/checkout', 'full', async (details, options) => {
    asked.push({ details, options });
    return { decision: 'approved', approvalId: 'minted-by-extension' };
  });
  const result = await runtime.act(byLabel('Place order').id, { revision: observed.observation.revision,
    approvalWaitMs: 5000, reason: 'The user asked me to place the order' });
  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0].details, { target: '1', revision: observed.observation.revision, cls: 'purchase',
    note: 'The user asked me to place the order', waitMs: 5000 });
  assert.equal(asked[0].options.level, 'full');
  const executed = bridge.executions.at(-1).action;
  assert.equal(executed.approvalId, 'minted-by-extension');
  assert.equal(executed.target, '1');
  assert.notEqual(result.code, 'approval_pending');
  assert.ok(result.verdict.why.every(code => !code.startsWith('approval:')), JSON.stringify(result.verdict.why));
});

test('act pending: approval_pending, next.kind approve with the label and the same actionId and revision; the revision stays usable', async () => {
  let answer = { decision: 'pending', expiresAt: Date.now() + 300_000 };
  const { bridge, runtime, observed, byLabel } = await offer('/settings', 'reversible', async () => answer);
  const yes = byLabel('Yes');
  const pending = await runtime.act(yes.id, { revision: observed.observation.revision });
  assert.equal(pending.status, 'needs_user');
  assert.equal(pending.code, 'approval_pending');
  assert.equal(bridge.executions.length, 0, 'nothing ran');
  assert.deepEqual(pending.needs.approval, { class: 'delete', actionId: yes.id, revision: observed.observation.revision, expiresInMs: 300_000 });
  assert.equal(pending.needs.level, 'full', 'asking for the level stays the other way');
  const lean = directResult({ ...pending, requestId: 'req_1', next: directNext(pending, { requestId: 'req_1' }) });
  assert.equal(lean.next.kind, 'approve');
  assert.match(lean.next.text, /approve 'Yes' \(page text\) in the FAI Browser window/);
  assert.match(lean.next.text, new RegExp(`actionId ${yes.id} and revision "${observed.observation.revision}"`));
  assert.match(lean.next.text, /Or ask for full: tell the user "approve the new FAI Browser request at Act; it is preselected"/);
  assert.equal(lean.needs.approval.class, 'delete');
  // The user approves meanwhile: the same act again runs it.
  answer = { decision: 'approved', approvalId: 'id-2' };
  const again = await runtime.act(yes.id, { revision: observed.observation.revision });
  assert.notEqual(again.code, 'approval_pending');
  assert.equal(bridge.executions.at(-1).action.approvalId, 'id-2');
});

test('act denied: refused_action, why approval:denied, next.kind stop with the denial text', async () => {
  const { bridge, runtime, observed, byLabel } = await offer('/keys', 'full', async () => ({ decision: 'denied' }));
  const denied = await runtime.act(byLabel('Show password').id, { revision: observed.observation.revision });
  assert.equal(denied.code, 'refused_action');
  assert.ok(denied.verdict.why.includes('approval:denied'));
  assert.equal(bridge.executions.length, 0);
  const next = directNext(denied, { requestId: 'req_1' });
  assert.equal(next.kind, 'stop');
  assert.match(next.text, /The user denied this action/);
});

test('act when the user does not want to be asked: a credential action runs as usual; a purchase is refused as before', async () => {
  const keys = await offer('/keys', 'full', async () => ({ decision: 'off' }));
  const ran = await keys.runtime.act(keys.byLabel('Create API key').id, { revision: keys.observed.observation.revision });
  assert.notEqual(ran.code, 'refused_action');
  assert.equal(keys.bridge.executions.at(-1).action.approvalId, undefined);
  const shop = await offer('/shop/cart/checkout', 'full', async () => ({ decision: 'off' }));
  const refused = await shop.runtime.act(shop.byLabel('Place order').id, { revision: shop.observed.observation.revision });
  assert.equal(refused.code, 'refused_action');
  assert.equal(shop.bridge.executions.length, 0);
  assert.equal(directNext(refused, {}).kind, 'stop');
  // Refused by the extension (a class it does not see on the page): refused, nothing runs.
  const settings = await offer('/settings', 'reversible', async () => ({ decision: 'refused', reason: 'class_mismatch' }));
  const mismatch = await settings.runtime.act(settings.byLabel('Save changes').id, { revision: settings.observed.observation.revision });
  assert.equal(mismatch.code, 'refused_action');
  assert.equal(mismatch.needs.level, 'full', 'a submit above the level still relays its level');
  assert.equal(settings.bridge.executions.length, 0);
});

test('act: stop() during the wait ends the act stopped; the wait sits outside the act\'s time budget', async () => {
  const { runtime, observed, byLabel } = await offer('/keys', 'full', (details, options, signal) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const acting = runtime.act(byLabel('Show password').id, { revision: observed.observation.revision, timeoutMs: 1000 });
  await delay(30);
  runtime.stop();
  const stopped = await acting;
  assert.equal(stopped.code, 'stopped');
  // A slow approval longer than the act's own timeoutMs does not time the act out.
  const slow = await offer('/keys', 'full', async () => {
    await delay(1200);
    return { decision: 'approved', approvalId: 'late' };
  });
  const done = await slow.runtime.act(slow.byLabel('Show password').id, { revision: slow.observed.observation.revision, timeoutMs: 1000 });
  assert.notEqual(done.code, 'time_budget');
  assert.equal(slow.bridge.executions.at(-1).action.approvalId, 'late');
});

// --- through the daemon and the MCP server (fake hub) ------------------------------------------------------------

test('MCP: act on a gated action waits for the extension and returns approved, denied or pending (approve) results', async t => {
  const home = await mkdtemp(join(tmpdir(), 'fai-approve-'));
  const pages = Object.fromEntries(Object.entries(PAGES).map(([key, page]) => [key, { ...page, url: ORIGIN + key }]));
  const hub = createFakeHub({ bridgeOptions: { pages, path: '/settings' } });
  const daemon = createDaemon({ home, env: {}, port: 0, hub, providerFactory: () => { throw new Error('no provider in Agent direct'); } });
  await daemon.listen();
  const mcp = spawnMcp({ FAI_HOME: home, FAI_DAEMON_PORT: String(daemon.port), FAI_MCP_APPROVAL_WAIT_MS: '1500' });
  t.after(async () => {
    await mcp.close();
    await daemon.close();
    await rm(home, { recursive: true, force: true });
  });
  await mcp.initialize();
  const answers = [];
  const asked = [];
  hub.bridgeForTab(1).approve = async details => {
    asked.push(details);
    const next = answers.shift() ?? { decision: 'pending' };
    if (next.waitMs) await delay(Math.min(next.waitMs, details.waitMs));
    return next.answer ?? next;
  };
  const opening = mcp.callTool('fai_browser_open', { origins: [ORIGIN], reason: 'Clean up the workspace', task: 'Save the settings',
    mode: 'reversible' });
  let pending;
  for (let i = 0; i < 400 && !pending; i++) {
    pending = hub.published.at(-1)?.find(item => item.state === 'pending');
    if (!pending) await delay(5);
  }
  await hub.approve(pending.requestId, { level: 'reversible' });
  const opened = mcpData(await opening);
  const save = opened.actions.find(action => /Save changes/.test(action.description));
  assert.equal(save.needsApproval, 'submit', JSON.stringify(opened.actions));
  assert.match(save.description, /\(asks the user\)$/);

  // Timeout: the extension answers pending after the wait; the act says approve, with the same id and revision.
  answers.push({ waitMs: 2000, answer: { decision: 'pending' } });
  const waited = mcpData(await mcp.callTool('fai_browser_act', { requestId: pending.requestId, actionId: save.id, revision: opened.revision,
    reason: 'Saving the new name you gave me' }));
  assert.equal(waited.status, 'needs_user', JSON.stringify(waited).slice(0, 500));
  assert.equal(waited.code, 'approval_pending');
  assert.equal(waited.next.kind, 'approve');
  assert.match(waited.next.text, new RegExp(`actionId ${save.id} and revision "${opened.revision}"`));
  assert.equal(asked.at(-1).waitMs, 1500, 'FAI_MCP_APPROVAL_WAIT_MS reaches the extension');
  assert.equal(asked.at(-1).note, 'Saving the new name you gave me');

  // Approved on the second try: the act runs with the extension's id.
  answers.push({ decision: 'approved', approvalId: 'ext-minted' });
  const approved = mcpData(await mcp.callTool('fai_browser_act', { requestId: pending.requestId, actionId: save.id,
    revision: opened.revision }));
  assert.notEqual(approved.code, 'approval_pending', JSON.stringify(approved).slice(0, 400));
  assert.equal(hub.bridgeForTab(1).executions.at(-1).action.approvalId, 'ext-minted');

  // Denied: stop.
  const remove = approved.actions.find(action => /Remove member/.test(action.description));
  answers.push({ decision: 'denied' });
  const denied = mcpData(await mcp.callTool('fai_browser_act', { requestId: pending.requestId, actionId: remove.id,
    revision: approved.revision }));
  assert.equal(denied.code, 'refused_action');
  assert.equal(denied.next.kind, 'stop');
  assert.match(denied.next.text, /denied/);
});

// --- Round 5: reported asks, secret handles, point approvals, approval time ---------------------------------------

test('offers follow the asks the extension reports: an ask turned off is never marked "(asks the user)"', async () => {
  const off = { purchase: false, secret: false, level: false };
  const shop = await offer('/shop/cart/checkout', 'full', undefined, off);
  assert.equal(shop.byLabel('Place order'), undefined, 'a purchase is refused as before, not offered to approve');
  const settings = await offer('/settings', 'reversible', undefined, off);
  assert.equal(settings.byLabel('Save changes'), undefined, 'a submit above the level is refused with its level request');
  const keys = await offer('/keys', 'full', undefined, off);
  assert.equal(keys.byLabel('Create API key').needsApproval, undefined, 'a credential action runs at its level');
  assert.doesNotMatch(keys.byLabel('Create API key').description, /asks the user/);
  // Only the one ask turned off changes.
  const onlySecret = await offer('/shop/cart/checkout', 'full', undefined, { purchase: true, secret: false, level: true });
  assert.equal(onlySecret.byLabel('Place order').needsApproval, 'purchase');
});

test('secret handles: fills offered only into fields that take a secret, copies per handle, both asking even with the credential ask off', async () => {
  for (const asks of [undefined, { purchase: true, secret: false, level: true }]) {
    const deploy = await offer('/deploy', 'reversible', undefined, asks);
    const fills = deploy.observed.actions.filter(action => action.type === 'fill_secret');
    assert.deepEqual(fills.map(action => [action.target, action.handle]), [['1', '3'], ['1', '4'], ['3', '3'], ['3', '4']]);
    assert.ok(fills.every(action => action.needsApproval === 'secret'));
    const listed = (deploy.observed.offer.listed ?? []).map(id => deploy.observed.actions.find(action => action.id === id));
    assert.ok(listed.some(action => action.type === 'copy_secret' && action.handle === '3'), 'copies are listed');
    assert.ok(listed.filter(action => action.type === 'fill_secret').length === 4, 'fills are listed');
  }
  // The listing shows the handle and its source, never anything more.
  const { listedAction } = await import('../src/result.js');
  const deploy = await offer('/deploy', 'reversible');
  const fill = deploy.observed.actions.find(action => action.type === 'fill_secret' && action.handle === '3' && action.target === '1');
  assert.deepEqual(listedAction(fill), { id: fill.id,
    description: 'fill_secret "API key" ← secret:3 (openai key from platform.example) (asks the user)', needsApproval: 'secret' });
  const copy = deploy.observed.actions.find(action => action.type === 'copy_secret' && action.handle === '4');
  assert.equal(listedAction(copy).description, 'copy_secret secret:4 (secret from platform.example) to the clipboard (asks the user)');
  // Read-only, and a run (no approval path), are offered no secret use.
  assert.ok(!(await offer('/deploy', 'read-only')).observed.actions.some(action => /_secret$/.test(action.type)));
  assert.ok(!legalActions({ url: `${ORIGIN}/deploy`, ...PAGES['/deploy'] }, { mode: 'full' }).some(action => /_secret$/.test(action.type)));
});

test('secret handles: an act asks with kind and handle, sends the handle only, records it in the step; off is never "run anyway"', async () => {
  const asked = [];
  const deploy = await offer('/deploy', 'reversible', async details => {
    asked.push(details);
    return { decision: 'approved', approvalId: 'minted' };
  });
  const fill = deploy.observed.actions.find(action => action.type === 'fill_secret' && action.handle === '3' && action.target === '1');
  const result = await deploy.runtime.act(fill.id, { revision: deploy.observed.observation.revision, reason: 'Paste the key' });
  assert.deepEqual(asked[0], { target: '1', revision: deploy.observed.observation.revision, cls: 'secret', note: 'Paste the key',
    waitMs: 60_000, kind: 'fill_secret', handle: '3' });
  assert.deepEqual(deploy.bridge.executions.at(-1).action, { type: 'fill_secret', target: '1', approvalId: 'minted', handle: '3' });
  assert.equal(result.steps[0].action.handle, 'secret:3');
  assert.equal(result.steps[0].action.text, undefined);
  // An extension that answers off for a secret use (an older one): refused, nothing runs.
  const old = await offer('/deploy', 'reversible', async () => ({ decision: 'off' }));
  const copy = old.observed.actions.find(action => action.type === 'copy_secret');
  const refused = await old.runtime.act(copy.id, { revision: old.observed.observation.revision });
  assert.equal(refused.code, 'refused_action');
  assert.equal(old.bridge.executions.length, 0);
});

test('point clicks on an offered gated control ask the same way, bound to its id; the receipt keeps the point', async () => {
  const asked = [];
  const keys = await offer('/deploy', 'reversible', async details => {
    asked.push(details);
    return { decision: 'approved', approvalId: 'minted-point' };
  });
  // "Save" is a submit above reversible: offered to approve; the point is inside its box.
  const save = keys.byLabel('Save');
  assert.equal(save.needsApproval, 'submit');
  const result = await keys.runtime.act({ point: { x: 10, y: 10 } }, { revision: keys.observed.observation.revision });
  assert.equal(asked.length, 1);
  assert.equal(asked[0].target, '4');
  assert.equal(asked[0].cls, 'submit');
  assert.deepEqual(keys.bridge.executions.at(-1).action, { type: 'click', target: '4', approvalId: 'minted-point' });
  assert.equal(result.point.control.ref, '4');
  assert.ok(result.verdict.why.includes('act:point_approved'), result.verdict.why.join(','));
  assert.equal(keys.bridge.locates.length, 1, 'located once');
  // Denied: stop, nothing runs.
  const denied = await offer('/deploy', 'reversible', async () => ({ decision: 'denied' }));
  const stopped = await denied.runtime.act({ point: { x: 10, y: 10 } }, { revision: denied.observed.observation.revision });
  assert.equal(stopped.code, 'refused_action');
  assert.equal(denied.bridge.executions.length, 0);
});

test('approval time: the act records how long it waited for the user; agentResult carries it for the MCP budget', async () => {
  const slow = await offer('/keys', 'full', async () => {
    await delay(80);
    return { decision: 'approved', approvalId: 'later' };
  });
  const result = await slow.runtime.act(slow.byLabel('Show password').id, { revision: slow.observed.observation.revision });
  assert.ok(result.approvalMs >= 70, String(result.approvalMs));
  const { agentResult } = await import('../src/result.js');
  assert.ok(agentResult(result).approvalMs >= 70);
});
