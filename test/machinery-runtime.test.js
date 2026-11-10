// Machinery pass in the runtime and MCP: error pages end failed / error_page before any further decision (item 6),
// custom dropdown options are reversible-only controls (item 5), a suggestion never repeats an instruction already
// tried (runtime and MCP, item 5), and the page script's cross_origin_frame warning reaches the receipt (item 4).
import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserRuntime, legalActions } from '../src/runtime.js';
import { errorPageOf } from '../src/oversight.js';
import { directNext } from '../src/result.js';
import { FakeBridge, ORIGIN, link } from './runtime-fixtures.js';

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

test('Agent direct: an observe of the browser\'s own error page carries the warning and offers no scroll', async () => {
  const bridge = new BrowserErrorBridge({ pages: { '/monthly': BROWSER_ERROR }, path: '/monthly' });
  const observed = await new BrowserRuntime({ bridge }).observe({ mode: 'read-only', grant: { level: 'read-only' }, allowedOrigins: [ORIGIN] });
  assert.ok(observed.observation.warnings.includes('browser_error_page'));
  assert.deepEqual(observed.actions.map(action => action.type), ['wait']);
  // An ordinary page still offers both scrolls.
  const plain = await new BrowserRuntime({ bridge: new StatusBridge({ pages: DASHBOARD, path: '/dashboard' }) })
    .observe({ mode: 'read-only', grant: { level: 'read-only' }, allowedOrigins: [ORIGIN] });
  assert.equal(plain.actions.filter(action => action.type === 'scroll').length, 2);
});

// The stand-in keeps the URL the tab tried and a fixed text: an expectation must never pass there (a false verified
// completion). A URL expectation and a textAbsent expectation would both match it.
for (const expectation of [{ urlIncludes: '/monthly' }, { textAbsent: 'Reports' }]) {
  test(`Agent direct: an act onto the browser's own error page never verifies ${JSON.stringify(expectation)}`, async () => {
    const bridge = new BrowserErrorBridge({ pages: { ...DASHBOARD, '/monthly': BROWSER_ERROR }, path: '/dashboard' });
    const runtime = new BrowserRuntime({ bridge });
    const observed = await runtime.observe({ mode: 'read-only', grant: { level: 'read-only' }, allowedOrigins: [ORIGIN] });
    const monthly = observed.actions.find(action => action.label === 'Monthly report');
    const result = await runtime.act(monthly.id, { revision: observed.observation.revision, expectation });
    assert.equal(result.code, 'error_page');
    assert.notEqual(result.status, 'completed');
    assert.notEqual(result.verification.passed, true);
    assert.equal(directNext(result, { requestId: 'req_1' }).kind, 'stop');
  });
}

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
