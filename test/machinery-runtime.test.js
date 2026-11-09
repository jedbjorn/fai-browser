// Machinery pass in the runtime and MCP: error pages end failed / error_page before any further decision (item 6),
// custom dropdown options are reversible-only controls (item 5), a suggestion never repeats an instruction already
// tried (runtime and MCP, item 5), and the page script's cross_origin_frame warning reaches the receipt (item 4).
import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserRuntime, legalActions } from '../src/runtime.js';
import { errorPageOf } from '../src/oversight.js';
import { agentResult, directNext } from '../src/result.js';
import { instructionFingerprint } from '../src/mcp.js';
import { FakeBridge, ORIGIN, clickProvider, link } from './runtime-fixtures.js';
import { startStubDaemon } from './helpers/stub-daemon.js';
import { spawnMcp } from './helpers/mcp-harness.js';
import { mcpData } from './helpers/mcp-result.js';

test('errorPageOf: HTTP status, title, heading and tiny body; ordinary pages are not error pages', () => {
  assert.deepEqual(errorPageOf({ httpStatus: 503, title: 'Shop' }), { status: 503, source: 'http' });
  assert.deepEqual(errorPageOf({ httpStatus: 404, title: 'x' }), { status: 404, source: 'http' });
  assert.deepEqual(errorPageOf({ title: 'Page not found' }), { status: 404, source: 'title' });
  assert.deepEqual(errorPageOf({ title: '404 - Not Found | Acme' }), { status: 404, source: 'title' });
  assert.deepEqual(errorPageOf({ title: 'Internal Server Error' }), { status: 500, source: 'title' });
  assert.deepEqual(errorPageOf({ title: 'Acme · Service Unavailable' }), { status: 503, source: 'title' });
  assert.deepEqual(errorPageOf({ title: 'Acme', blocks: [{ t: 'h1', text: '404: Page not found' }] }),
    { status: 404, source: 'heading' });
  assert.deepEqual(errorPageOf({ title: 'Oops', text: 'Error 500. Something broke.' }), { status: 500, source: 'body' });
  for (const observation of [
    { title: '500 Startups', text: 'Investors' },
    { title: 'Troubleshooting Internal Server Error responses', text: 'A long guide '.repeat(50) },
    { title: 'Order 404 shipped', text: 'Your order 404 has shipped.' + ' x'.repeat(300) },
    { title: 'Not found? Try search', blocks: [{ t: 'h1', text: 'Search the docs' }] },
    { httpStatus: 403, title: 'Bot or Not?' },
    { httpStatus: 200, title: 'Home' },
  ]) assert.equal(errorPageOf(observation), null, JSON.stringify(observation).slice(0, 60));
});

const DASHBOARD = {
  '/dashboard': {
    title: 'Dashboard',
    text: 'Reports',
    controls: [link('1', 'Monthly report', '/monthly'), link('2', 'Billing', '/billing')],
  },
  '/monthly': {
    title: 'Page not found',
    text: '404: Page not found. The page you asked for does not exist.',
    controls: [link('1', 'Back to the dashboard', '/dashboard')],
  },
  '/billing': {
    title: 'Billing unavailable',
    text: 'Something went wrong. Reference: ERR-500-7Y',
    httpStatus: 500,
    controls: [link('1', 'Dashboard', '/dashboard')],
  },
};

class StatusBridge extends FakeBridge {
  get observation() {
    const observation = super.observation;
    const status = this.pages[this.path].httpStatus;
    if (status) observation.httpStatus = status;
    return observation;
  }
}

test('a link that lands on a 404 page ends failed / error_page before another decision; next stop names 404', async () => {
  const bridge = new StatusBridge({ pages: DASHBOARD, path: '/dashboard' });
  const provider = clickProvider(['Monthly report', 'Back to the dashboard']);
  const result = await new BrowserRuntime({ bridge, provider }).run(
    'From the Dashboard, open Monthly report. Read the total revenue and stop there.',
    { expectation: { textIncludes: 'Total revenue' }, maxActions: 4 },
  );
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'error_page');
  assert.equal(result.reason, 'The page is an HTTP error page: HTTP 404');
  assert.equal(provider.calls.length, 1, 'no decision on the error page');
  assert.equal(result.steps.length, 1);
  assert.equal(result.verdict.kind, 'failed');
  assert.ok(result.verdict.why.includes('http:404'));
  assert.ok(result.verdict.why.includes('error_source:title'));
  assert.equal(result.verdict.suggested, null);
  const lean = agentResult(result);
  assert.equal(lean.next.kind, 'stop');
  assert.match(lean.next.text, /HTTP 404 error page \(Not Found\)/);
});

test('an expectation that passes on the error page (the host asked for it) is not stopped', async () => {
  const bridge = new StatusBridge({ pages: DASHBOARD, path: '/dashboard' });
  const provider = {
    calls: 0,
    async decide(observation, actions) {
      this.calls++;
      const billing = actions.find(action => action.label === 'Billing');
      if (billing && observation.url.endsWith('/dashboard')) return { actionId: billing.id, confidence: 0.9, done: { probability: 0.05 } };
      return { actionId: 'done', confidence: 0.9, done: { probability: 0.95 } };
    },
  };
  const result = await new BrowserRuntime({ bridge, provider }).run(
    'From the Dashboard, open Billing. Read the error reference the page shows and stop there.',
    { expectation: { urlIncludes: '/billing' }, maxActions: 4 },
  );
  assert.equal(result.status, 'completed');
  assert.equal(result.code, 'expectation_passed');
  assert.ok(result.verdict.why.includes('http:500'));
});

test('a start page with an HTTP 503 status ends error_page without a provider call', async () => {
  const pages = { '/': { title: 'Shop', text: 'Back soon', httpStatus: 503, controls: [link('1', 'Home', '/')] } };
  const bridge = new StatusBridge({ pages, path: '/' });
  const provider = clickProvider(['Home']);
  const result = await new BrowserRuntime({ bridge, provider }).run('Read the opening hours.', {
    expectation: { textIncludes: 'Opening hours' },
  });
  assert.equal(result.code, 'error_page');
  assert.equal(provider.calls.length, 0);
  assert.match(agentResult(result).next.text, /HTTP 503 error page \(Service Unavailable\)/);
});

// The browser's own error page (chrome-error://chromewebdata/ for an HTTP error without a page body or a network
// failure) as the extension reports it: no controls, a fixed text, browserErrorPage and the warning, no status.
const BROWSER_ERROR = {
  title: 'www.example.com',
  text: 'The browser shows its own error page for this address.',
  browserErrorPage: true,
  warnings: ['browser_error_page'],
  controls: [],
};

class BrowserErrorBridge extends StatusBridge {
  get observation() {
    const observation = super.observation;
    if (this.pages[this.path].browserErrorPage) observation.browserErrorPage = true;
    return observation;
  }
}

test('errorPageOf: the browser\'s own error page is an error page of unknown status', () => {
  assert.deepEqual(errorPageOf({ browserErrorPage: true, title: 'www.example.com' }), { status: null, source: 'browser' });
  assert.deepEqual(errorPageOf({ browserErrorPage: true, httpStatus: 503 }), { status: 503, source: 'http' });
  assert.equal(errorPageOf({ browserErrorPage: false, title: 'Home' }), null);
});

test('a link that lands on the browser\'s own error page ends error_page; next stop says the tab can be reloaded later', async () => {
  const pages = { ...DASHBOARD, '/monthly': BROWSER_ERROR };
  const bridge = new BrowserErrorBridge({ pages, path: '/dashboard' });
  const provider = clickProvider(['Monthly report']);
  const result = await new BrowserRuntime({ bridge, provider }).run(
    'From the Dashboard, open Monthly report. Read the total revenue and stop there.',
    { expectation: { textIncludes: 'Total revenue' }, maxActions: 4 },
  );
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'error_page');
  assert.equal(provider.calls.length, 1, 'no decision on the error page');
  assert.ok(result.verdict.why.includes('http:error'));
  assert.ok(result.verdict.why.includes('error_source:browser'));
  const lean = agentResult(result);
  assert.equal(lean.next.kind, 'stop');
  assert.match(lean.next.text, /browser showed its own error page/);
  assert.match(lean.next.text, /can be reloaded later/);
});

test('Agent direct: an act that lands on the browser\'s own error page is error_page with the page\'s offer kept', async () => {
  const pages = { ...DASHBOARD, '/monthly': BROWSER_ERROR };
  const bridge = new BrowserErrorBridge({ pages, path: '/dashboard' });
  const runtime = new BrowserRuntime({ bridge });
  const observed = await runtime.observe({ mode: 'read-only', grant: { level: 'read-only' }, allowedOrigins: [ORIGIN] });
  const monthly = observed.actions.find(action => action.label === 'Monthly report');
  const result = await runtime.act(monthly.id, { revision: observed.observation.revision });
  assert.equal(result.code, 'error_page');
  assert.ok(result.verdict.why.includes('error_source:browser'));
  assert.equal(result.observation.browserErrorPage, true);
  assert.ok(result.offer?.revision, 'the error page has an offer: the host can reload from it');
  const next = directNext(result, { requestId: 'req_1' });
  assert.equal(next.kind, 'stop');
  assert.match(next.text, /browser showed its own error page.*; do not retry the same link\. The tab stays approved/);
  // A reload from that offer runs (a history move needs no page script).
  bridge.pages['/monthly'] = DASHBOARD['/dashboard'];
  const reloaded = await runtime.act({ nav: 'reload' }, { revision: result.offer.revision });
  assert.equal(reloaded.code, 'step_complete');
  assert.equal(bridge.executions.at(-1).action.type, 'history');
  // An ordinary HTTP error page with a body is still read by the host in Agent direct (unchanged).
  const plain = new BrowserRuntime({ bridge: new StatusBridge({ pages: DASHBOARD, path: '/dashboard' }) });
  const first = await plain.observe({ mode: 'read-only', grant: { level: 'read-only' }, allowedOrigins: [ORIGIN] });
  const landed = await plain.act(first.actions.find(action => action.label === 'Billing').id, { revision: first.observation.revision });
  assert.equal(landed.code, 'step_complete');
});

const SIZES = {
  '/sizes': {
    title: 'Canvas tool roll',
    text: 'Choose a size',
    controls: [
      { id: '1', role: 'button', label: 'Size: choose', enabled: true, risk: 'reversible' },
      { id: '2', role: 'option', label: 'S', enabled: true, risk: 'reversible' },
      { id: '3', role: 'option', label: 'L', enabled: true, risk: 'reversible' },
      { id: '4', role: 'option', label: 'Delete', enabled: true, risk: 'reversible' },
    ],
  },
};

test('custom dropdown options are clickable controls in reversible mode only; a dangerous option label is not', () => {
  const observation = new FakeBridge({ pages: SIZES, path: '/sizes' }).observation;
  const reversible = legalActions(observation, { mode: 'reversible' });
  const options = reversible.filter(action => action.role === 'option');
  assert.deepEqual(options.map(action => action.label), ['S', 'L']);
  assert.equal(options[0].type, 'click');
  assert.match(options[1].description, /^Click option 3: L$/);
  const readOnly = legalActions(observation, { mode: 'read-only' });
  assert.ok(!readOnly.some(action => action.role === 'option'));
});

test('a run that acted but reached none of the named pages suggests no instruction (it would repeat the task)', async () => {
  const bridge = new FakeBridge({ pages: SIZES, path: '/sizes' });
  // Keeps clicking the trigger (the fake page only bumps its revision), so the action budget runs out on /sizes.
  const provider = clickProvider(['Size: choose']);
  const instruction = 'Open the Size menu and choose L. Read how many are left in stock and stop there.';
  const result = await new BrowserRuntime({ bridge, provider }).run(instruction, {
    mode: 'reversible', maxActions: 3, expectation: { textIncludes: 'Size L:' },
    answerQuestion: 'How many size L tool rolls are left in stock?',
  });
  assert.equal(result.code, 'action_budget');
  assert.equal(result.steps.length, 3);
  assert.ok(!result.verdict.suggested?.instruction, JSON.stringify(result.verdict.suggested));
});

test('the page script cross_origin_frame warning reaches the receipt warnings', async () => {
  const pages = { '/': { title: 'Embed', text: 'Embedded map', warnings: ['cross_origin_frame'], controls: [] } };
  const bridge = new FakeBridge({ pages, path: '/' });
  const result = await new BrowserRuntime({ bridge, provider: clickProvider([], { fallback: 'done' }) })
    .run('Read the embedded map caption.', { expectation: { textIncludes: 'Embedded' } });
  assert.ok(result.warnings.includes('cross_origin_frame'));
  assert.ok(agentResult(result).warnings.includes('cross_origin_frame'));
});

test('instructionFingerprint ignores case, punctuation and the runtime framing', () => {
  assert.equal(instructionFingerprint('From the current page, visit Size menu, in that order. Stop there.'),
    instructionFingerprint('visit size menu stop there'));
  assert.notEqual(instructionFingerprint('Visit Pricing'), instructionFingerprint('Visit Team'));
});

test('MCP drops a suggested instruction that was already run on the request, keeping the expectation', async t => {
  const tried = 'Open the Size menu and choose L. Read how many are left in stock and stop there.';
  const suggestions = [
    // The original instruction, reworded only by case and punctuation.
    { instruction: 'open the size menu and choose l; read how many are left in stock, and stop there', expectation: { textIncludes: 'Size L:' }, maxActions: 3 },
    { instruction: 'From the current page, visit Size menu. Stop there.', maxActions: 3 },
    // The suggestion the host just followed, now with a different expectation (a new object, the same instruction).
    { instruction: 'From the current page, visit Size menu. Stop there.', expectation: { urlIncludes: '/sizes' }, maxActions: 3 },
  ];
  let n = 0;
  const stub = await startStubDaemon({
    autoGrant: true,
    finalStatus: 'needs_host',
    finalCode: 'no_progress',
    finalExtra: () => ({
      v: 2,
      verdict: { kind: 'needs_decision', oversight: 'instruct', answer: null, why: ['no_progress'], decide: null,
        suggested: suggestions[n++], budget: null },
      next: { kind: 'rerun', text: 'x' },
    }),
  });
  const mcp = spawnMcp(stub.env());
  t.after(async () => {
    mcp.child.kill('SIGKILL');
    await stub.close();
  });
  await mcp.initialize();
  const first = await mcp.callTool('fai_browser_run', {
    origins: [ORIGIN], reason: 'Check stock', instruction: tried, mode: 'reversible', maxCalls: 6,
  });
  assert.deepEqual(mcpData(first).verdict.suggested, { expectation: { textIncludes: 'Size L:' } });
  assert.ok(mcpData(first).verdict.why.includes('suggested_repeated'));
  assert.doesNotMatch(mcpData(first).next.text, /verdict\.suggested\.instruction/);
  const second = await mcp.callTool('fai_browser_run', { instruction: 'Click Size: choose, then click L.', maxActions: 4 });
  assert.equal(mcpData(second).verdict.suggested.instruction, suggestions[1].instruction);
  const third = await mcp.callTool('fai_browser_run', { instruction: suggestions[1].instruction, maxActions: 3 });
  assert.deepEqual(mcpData(third).verdict.suggested, { expectation: { urlIncludes: '/sizes' } });
  assert.ok(mcpData(third).verdict.why.includes('suggested_repeated'));
});

test('review: errorPageOf never fires on body text alone or on an article about HTTP errors', () => {
  for (const observation of [
    { httpStatus: 200, title: 'HTTP 404 - Wikipedia', blocks: [{ t: 'h1', text: 'HTTP 404' }],
      text: 'HTTP 404 is a standard response code. 404 error means the page was not found.' },
    { httpStatus: 200, title: 'Oops', text: 'Error 500. Something broke.' },
    { httpStatus: 200, title: 'Status codes', text: '404 not found and 500 errors explained briefly.' },
    { title: 'Glossary', text: '404 error means not found.' },
    { title: 'Glossary', blocks: [{ t: 'p', text: 'A 404 error is shown when a page is missing.' }],
      text: 'A 404 error is shown when a page is missing.' },
  ]) assert.equal(errorPageOf(observation), null, JSON.stringify(observation).slice(0, 70));
  // A soft 404 (HTTP 200) still counts by its title or heading.
  assert.deepEqual(errorPageOf({ httpStatus: 200, title: 'Page not found | Acme' }), { status: 404, source: 'title' });
  assert.deepEqual(errorPageOf({ httpStatus: 200, title: 'Acme', blocks: [{ t: 'h1', text: '404' }] }),
    { status: 404, source: 'heading' });
});
