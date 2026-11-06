// Machinery pass, item 2: refusal receipts. A task whose instruction asks to buy, order, pay, delete, remove, send,
// submit or log in, on a page whose controls for it are refused, ends needs_user / refused_action before any provider
// decision: verdict failed, oversight user, next stop with the fixed text, never a rerun; CLI exit code 2.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { BrowserRuntime, blockedControls } from '../src/runtime.js';
import { commitIntent, labelIntents } from '../src/oversight.js';
import { agentResult, applyBudget, buildVerdict, createResult, setOutcome } from '../src/result.js';
import { FakeBridge, clickProvider, link } from './runtime-fixtures.js';

// Purchases below testing stop with this text; refusals a higher level would lift relay a level request instead.
const STOP_TEXT = 'FAI never purchases outside testing mode. Tell the user what to do in the tab.';

test('commitIntent classifies imperative clauses conservatively', () => {
  const cases = {
    'Place my order for the items in the cart.': 'purchase',
    'Buy everything in my cart.': 'purchase',
    'Please check out and pay for the lamp.': 'purchase',
    'Delete this workspace.': 'delete',
    'Open Settings, then remove the old API key.': 'delete',
    'Cancel my subscription.': 'delete',
    'Send the report to Priya.': 'send',
    'Submit the contact form.': 'submit',
    'Log in to my account.': 'login',
    'Sign in and read my invoices.': 'login',
    // Click phrasing names the control; "save" and "confirm" are submit verbs (levels-e2e, 2026-10-05).
    'Click Proceed to checkout to start the checkout for the items in the cart.': 'purchase',
    'Proceed to checkout.': 'purchase',
    'Click the Save button to save the account settings as they are.': 'submit',
    'Save the settings.': 'submit',
    'Press Confirm.': 'submit',
    'Click Sign in.': 'login',
  };
  for (const [instruction, kind] of Object.entries(cases)) assert.equal(commitIntent(instruction), kind, instruction);
  for (const instruction of [
    'Read the cart and report the order total.',
    'From the Dashboard, open Monthly report. Read the total revenue. Do not type into or submit forms.',
    'Click Rename next to the workspace name. Read the maximum length and stop there. Do not save anything.',
    'Finish whatever the account page asks for.',
    'Visit Order history and read the last order date.',
    'Find the page about how to delete an account.',
    'Open the Size menu and choose L.',
    'Click Continue to go on to the next step.',
    'Click the Cart link and read the total.',
    'Save the search for brass lamps.',
  ]) assert.equal(commitIntent(instruction), null, instruction);
});

test('labelIntents maps refused control labels to the intent they would carry out', () => {
  assert.ok(labelIntents('Place order').has('purchase'));
  assert.ok(labelIntents('Proceed to checkout').has('purchase'));
  assert.ok(labelIntents('Delete workspace').has('delete'));
  assert.ok(labelIntents('Sign in').has('login'));
  assert.equal(labelIntents('Continue shopping').size, 0);
});

const CART = {
  '/cart': {
    title: 'Your cart',
    text: 'Total $142.80',
    controls: [
      { id: '1', role: 'button', label: 'Remove', enabled: true, risk: 'destructive' },
      { id: '2', role: 'button', label: 'Place order', enabled: true, risk: 'destructive' },
      { id: '3', role: 'button', label: 'Buy now', enabled: true, risk: 'destructive' },
      link('4', 'Proceed to checkout', '/checkout'),
      link('5', 'Continue shopping', '/shop'),
    ],
  },
  '/shop': { title: 'Shop', text: 'Tide clock $64.00', controls: [link('1', 'Cart', '/cart')] },
};

test('blockedControls lists refused buttons and action links, not navigation', () => {
  const bridge = new FakeBridge({ pages: CART, path: '/cart' });
  const labels = blockedControls(bridge.observation).map(control => control.label);
  assert.deepEqual(labels, ['Remove', 'Place order', 'Buy now', 'Proceed to checkout']);
});

for (const [instruction, mode] of [['Place my order for the items in the cart.', 'reversible'],
  ['Buy everything in my cart.', 'read-only']]) {
  test(`refused_action receipt before any decision: "${instruction}" (${mode})`, async () => {
    const bridge = new FakeBridge({ pages: CART, path: '/cart' });
    const provider = clickProvider(['Continue shopping']);
    const result = await new BrowserRuntime({ bridge, provider }).run(instruction, {
      mode, maxActions: 4, expectation: { textIncludes: 'Order confirmed' },
    });
    assert.equal(result.status, 'needs_user');
    assert.equal(result.code, 'refused_action');
    assert.equal(provider.calls.length, 0, 'no provider decision');
    assert.equal(bridge.executions.length, 0, 'nothing clicked');
    assert.equal(result.verdict.kind, 'failed');
    assert.equal(result.verdict.oversight, 'user');
    assert.equal(result.verdict.suggested, null);
    assert.ok(result.verdict.why.includes('refused:purchase'));
    assert.deepEqual(result.next, { kind: 'stop', text: STOP_TEXT });
    assert.equal(result.needs.message, STOP_TEXT);
    assert.equal(result.needs.level, undefined, 'a purchase is never relayed as a level request below testing');
    const lean = agentResult(result);
    assert.deepEqual(lean.next, { kind: 'stop', text: STOP_TEXT });
    // The MCP budget never turns it into a rerun.
    applyBudget(lean, { callsUsed: 1, callsLeft: 5, msUsed: 10 }, { requestId: 'req_x' });
    assert.equal(lean.next.kind, 'stop');
  });
}

test('a commit instruction on a page without the refused control still runs (then refuses where it appears)', async () => {
  const pages = {
    '/': { title: 'Home', text: 'Workspace home', controls: [link('1', 'Settings', '/settings')] },
    '/settings': {
      title: 'Workspace settings',
      text: 'Danger zone',
      controls: [{ id: '1', role: 'button', label: 'Delete workspace', enabled: true, risk: 'destructive' }],
    },
  };
  const bridge = new FakeBridge({ pages, path: '/' });
  const provider = clickProvider(['Settings']);
  const result = await new BrowserRuntime({ bridge, provider }).run('Open Settings, then delete this workspace.', {
    mode: 'reversible', maxActions: 4,
  });
  assert.equal(provider.calls.length, 1);
  assert.equal(result.code, 'refused_action');
  assert.ok(result.verdict.why.includes('refused:delete'));
  assert.equal(result.steps.length, 1);
});

test('an ordinary read task on the same cart is not refused', async () => {
  const bridge = new FakeBridge({ pages: CART, path: '/cart' });
  const provider = clickProvider([], { fallback: 'done' });
  const result = await new BrowserRuntime({ bridge, provider }).run('Read the cart and report the order total.', {
    expectation: { textIncludes: 'Total' },
  });
  assert.equal(result.status, 'completed');
});

test('blocked_risky from the page script on a commit instruction becomes refused_action', async () => {
  const pages = {
    '/': {
      title: 'Newsletter', text: 'Newsletter',
      controls: [{ id: '1', role: 'button', label: 'Go', enabled: true, risk: 'reversible' }],
    },
  };
  const bridge = new FakeBridge({ pages, path: '/' });
  const error = Object.assign(new Error('Submission requires user action'), { code: 'blocked_risky' });
  bridge.failNext.push(error);
  const provider = clickProvider(['Go']);
  const result = await new BrowserRuntime({ bridge, provider }).run('Submit the signup form.', { mode: 'reversible', grant: { level: 'reversible' } });
  assert.equal(result.code, 'refused_action');
  // A submission is allowed at Full: the user is asked to re-approve the tab at that level.
  assert.equal(result.next.kind, 'relay');
  assert.equal(result.needs.level, 'full');
  assert.equal(result.needs.who, 'user');
  assert.match(result.needs.message, /this task needs Act/);
  // Without a grant (an SDK caller with its own bridge) the ceiling is full: the host reruns with mode full itself.
  const sdk = new FakeBridge({ pages, path: '/' });
  sdk.failNext.push(Object.assign(new Error('Submission requires user action'), { code: 'blocked_risky' }));
  const rerun = await new BrowserRuntime({ bridge: sdk, provider: clickProvider(['Go']) }).run('Submit the signup form.', { mode: 'reversible' });
  assert.equal(rerun.next.kind, 'rerun');
  assert.equal(rerun.needs.level, 'full');
  // A purchase the page script refuses still stops.
  const buy = new FakeBridge({ pages, path: '/' });
  buy.failNext.push(Object.assign(new Error('Purchase requires user action'), { code: 'blocked_risky' }));
  const stopped = await new BrowserRuntime({ bridge: buy, provider: clickProvider(['Go']) }).run('Buy the lamp.', { mode: 'full' });
  assert.equal(stopped.code, 'refused_action');
  assert.equal(stopped.next.kind, 'stop');
  assert.equal(stopped.needs.message, STOP_TEXT);
});

test('the code is in the taxonomy: verdict from the code alone, CLI exit code 2, docs list it', async () => {
  const result = createResult({ runId: 'r1' });
  setOutcome(result, 'refused_action');
  const verdict = buildVerdict(result);
  assert.equal(verdict.kind, 'failed');
  assert.equal(verdict.oversight, 'user');
  assert.equal(verdict.nextKind, 'stop');
  const cli = await readFile(new URL('../src/cli.js', import.meta.url), 'utf8');
  assert.match(cli, /\['needs_user', 'needs_host', 'budget_exhausted', 'stopped'\]\.includes\(status\)\) \{\s*return 2;/);
  const readme = await readFile(new URL('../docs/REFERENCE.md', import.meta.url), 'utf8');
  assert.match(readme, /`refused_action`/);
  const skill = await readFile(new URL('../skills/fai-browser/SKILL.md', import.meta.url), 'utf8');
  assert.match(skill, /refused_action/);
  const types = await readFile(new URL('../src/index.d.ts', import.meta.url), 'utf8');
  assert.match(types, /'refused_action'/);
  assert.match(types, /'error_page'/);
});

// Review B: a verb in its harmless sense, next to ordinary view controls, is never a refusal.
const SEARCH_PAGE = {
  '/results': {
    title: 'Results',
    text: 'Showing 24 results for lamps. Filters: Brass, Under $50, Last 30 days.',
    controls: [
      { id: '1', role: 'button', label: 'Remove filter Brass', enabled: true, risk: 'destructive' },
      { id: '2', role: 'button', label: 'Remove date restriction', enabled: true, risk: 'destructive' },
      { id: '3', role: 'button', label: 'Submit search', enabled: true, risk: 'submit', type: 'submit' },
      { id: '4', role: 'button', label: 'Search', enabled: true, risk: 'submit', type: 'submit' },
      { id: '5', role: 'button', label: 'Send', enabled: true, risk: 'submit', type: 'submit' },
      link('6', 'Brass lamp', '/lamp'),
    ],
  },
};

for (const instruction of ['Remove the filter and read the result count.', 'Remove the date restriction.',
  'Submit a search for brass lamps.', 'Send me the list of lamp names.']) {
  test(`review B: "${instruction}" is not a refusal on ordinary view controls`, async () => {
    assert.equal(commitIntent(instruction), null);
    const bridge = new FakeBridge({ pages: SEARCH_PAGE, path: '/results' });
    const provider = clickProvider([], { fallback: 'done' });
    const result = await new BrowserRuntime({ bridge, provider }).run(instruction, {
      mode: 'reversible', maxActions: 2, expectation: { textIncludes: 'results' },
    });
    assert.notEqual(result.code, 'refused_action');
    assert.ok(provider.calls.length >= 1, 'the provider decided');
  });
}

test('review B: a dangerous verb whose only page controls are harmless view controls is not refused', async () => {
  // commitIntent says delete, but the only refused controls are filter chips: no refusal receipt.
  assert.equal(commitIntent('Remove Brass.'), 'delete');
  const bridge = new FakeBridge({ pages: SEARCH_PAGE, path: '/results' });
  const provider = clickProvider([], { fallback: 'done' });
  const result = await new BrowserRuntime({ bridge, provider }).run('Remove Brass.', { mode: 'reversible', maxActions: 2 });
  assert.notEqual(result.code, 'refused_action');
});

test('review B: the dangerous sense still refuses ("remove the item from my cart", "send the report")', async () => {
  assert.equal(commitIntent('Remove the item from my cart.'), 'delete');
  assert.equal(commitIntent('Remove the old API key.'), 'delete');
  assert.equal(commitIntent('Send the report to Priya.'), 'send');
  assert.equal(commitIntent('Delete the saved search filter account.'), 'delete');
  const bridge = new FakeBridge({ pages: CART, path: '/cart' });
  const provider = clickProvider([]);
  const result = await new BrowserRuntime({ bridge, provider }).run('Remove the item from my cart.', { mode: 'reversible' });
  assert.equal(result.code, 'refused_action');
  assert.equal(provider.calls.length, 0);
});

// levels-e2e (2026-10-05): with live Jev, "Click the Save button" at Reversible and "Click Proceed to checkout" at
// Full ended as a provider handoff (next.kind rerun) because commitIntent missed click phrasing and "save".
test('click phrasing: a Save that the grant refuses relays Full; Proceed to checkout at full stops', async () => {
  const pages = {
    '/settings': {
      title: 'Account settings', text: 'Settings not saved yet.',
      controls: [{ id: '1', role: 'button', label: 'Save', enabled: true, risk: 'submit', type: 'submit' }],
    },
  };
  const bridge = new FakeBridge({ pages, path: '/settings' });
  const provider = clickProvider([], { fallback: 'done' });
  const result = await new BrowserRuntime({ bridge, provider }).run(
    'Click the Save button to save the account settings as they are.',
    { mode: 'full', grant: { level: 'reversible' }, expectation: { textIncludes: 'Settings saved.' } });
  assert.equal(result.code, 'refused_action');
  assert.equal(result.next.kind, 'relay');
  assert.equal(result.needs.level, 'full');
  assert.match(result.needs.message, /Use \(no submit\)/);
  assert.equal(bridge.executions.length, 0);

  const cart = new FakeBridge({ pages: CART, path: '/cart' });
  const stopped = await new BrowserRuntime({ bridge: cart, provider: clickProvider([], { fallback: 'done' }) }).run(
    'Click Proceed to checkout to start the checkout.', { mode: 'full', grant: { level: 'full' } });
  assert.equal(stopped.code, 'refused_action');
  assert.equal(stopped.next.kind, 'stop');
  assert.equal(stopped.needs.message, STOP_TEXT);
  assert.equal(cart.executions.length, 0);
});
