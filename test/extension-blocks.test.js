// Structured page content from extension/page.js, run in headless Chromium: the block shape, document order,
// visible-before-offscreen ordering, refs to offered controls, the 200-block and 300-character caps, and the
// elements that never become blocks. CHROMIUM_PATH overrides the browser binary.
import test from 'node:test';
import { headlessEnv } from '../scripts/headless-env.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const PAGE_SCRIPT = new URL('../extension/page.js', import.meta.url).pathname;
const BLOCKS_FIXTURE = await readFile(new URL('../fixtures/blocks.html', import.meta.url), 'utf8');
const TYPES = new Set(['h1', 'h2', 'h3', 'h4', 'p', 'li', 'tr', 'dt', 'label', 'a', 'button', 'alert', 'select']);

let browser;
test.before(async () => {
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    headless: true, env: headlessEnv(),
    args: ['--no-sandbox'],
  });
});
test.after(() => browser?.close());

// Loads `html` at https://example.com/ in a 1280x800 viewport and installs page.js.
async function load(t, html) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  t.after(() => page.close());
  await page.route('https://example.com/**', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('https://example.com/');
  await page.addScriptTag({ path: PAGE_SCRIPT });
  return page;
}

const observe = page => page.evaluate(() => __faiPage.observe());
const doc = body => `<!doctype html><html><head><meta charset="utf-8"><title>T</title></head><body>${body}</body></html>`;

function assertShape(observation) {
  assert.ok(Array.isArray(observation.blocks));
  assert.equal(typeof observation.blocksTruncated, 'boolean');
  assert.ok(observation.blocks.length <= 200);
  for (const block of observation.blocks) {
    assert.ok(TYPES.has(block.t), `unknown block type ${block.t}`);
    assert.equal(typeof block.text, 'string');
    assert.ok(block.text.length > 0 && block.text.length <= 300);
    assert.equal(block.text, block.text.trim());
    for (const key of Object.keys(block)) assert.ok(['t', 'text', 'ref', 'offscreen'].includes(key), key);
    if ('ref' in block) assert.ok(observation.controls.some(c => c.id === block.ref), `ref ${block.ref} is offered`);
    if ('offscreen' in block) assert.equal(block.offscreen, true);
  }
}

test('the blocks fixture yields typed blocks in document order, refs, and offscreen blocks last', async t => {
  const page = await load(t, BLOCKS_FIXTURE);
  const observation = await observe(page);
  assertShape(observation);
  const id = label => observation.controls.find(c => c.label === label).id;
  assert.deepEqual(observation.blocks, [
    { t: 'a', text: 'Home', ref: id('Home') },
    { t: 'a', text: 'About', ref: id('About') },
    { t: 'p', text: 'We use cookies to improve the handbook.' },
    { t: 'button', text: 'Reject all', ref: id('Reject all') },
    { t: 'button', text: 'Accept all', ref: id('Accept all') },
    { t: 'button', text: 'Manage settings', ref: id('Manage settings') },
    { t: 'h1', text: 'Team handbook' },
    { t: 'p', text: 'Read the member list before the meeting.', ref: id('member list') },
    { t: 'alert', text: 'Two seats left' },
    { t: 'h2', text: 'Checklist' },
    { t: 'li', text: 'Bring a laptop' },
    { t: 'li', text: 'Install node 22' },
    { t: 'h3', text: 'Members' },
    { t: 'tr', text: 'Name | Role' },
    { t: 'tr', text: 'Ada | Engineer' },
    { t: 'tr', text: 'Grace | Admiral' },
    { t: 'dt', text: 'Room' },
    { t: 'p', text: '4B, second floor' },
    { t: 'label', text: 'Display name', ref: id('Display name') },
    { t: 'label', text: 'Plan', ref: id('Plan') },
    { t: 'select', text: 'Plan: Basic | Pro', ref: id('Plan') },
    { t: 'button', text: 'Show plan', ref: id('Show plan') },
    // Open shadow root content: new blocks follow the light-DOM blocks of the same visibility group.
    { t: 'p', text: 'Shadow note' },
    { t: 'a', text: 'Shadow link', ref: id('Shadow link') },
    { t: 'h4', text: 'Appendix', offscreen: true },
    { t: 'p', text: 'Below the fold', offscreen: true },
    { t: 'h2', text: 'Sign in', offscreen: true },
    { t: 'label', text: 'Email', ref: id('Email'), offscreen: true },
    { t: 'label', text: 'Password', offscreen: true },
  ]);
  assert.equal(observation.blocksTruncated, false);
  // The visible-region text and its flag are unchanged by blocks.
  assert.equal(observation.textTruncated, false);
  assert.match(observation.text, /Team handbook/);
  assert.doesNotMatch(observation.text, /Below the fold/);
});

test('hidden, decorative, script, option and out-of-body text never becomes a block (a select is one block)', async t => {
  const page = await load(t, doc(`
    <p>Shown</p>
    <p hidden>Hidden attribute</p>
    <p style="display:none">Display none</p>
    <div style="visibility:hidden"><p>Visibility hidden</p></div>
    <p aria-hidden="true">Aria hidden</p>
    <select aria-label="Pick"><option>Option text</option></select>
    <textarea aria-label="Notes">Textarea text</textarea>
    <style>p { color: black; }</style>
    <script>void 'Script text';</script>
    <template><p>Template text</p></template>`));
  await page.evaluate(() => {
    const outside = document.createElement('div');
    outside.textContent = 'Outside body';
    document.documentElement.appendChild(outside);
  });
  const observation = await observe(page);
  assertShape(observation);
  assert.deepEqual(observation.blocks.map(b => b.text), ['Shown', 'Pick: Option text']);
  assert.equal(observation.blocks[1].t, 'select');
});

test('refs: labels point at their control, text blocks at the first control they wrap, links stand alone', async t => {
  const page = await load(t, doc(`
    <label><input type="checkbox"> I accept the <a href="/terms">terms</a></label>
    <ul><li><a href="/one">Only link</a></li></ul>
    <div><a href="/a">Loose A</a> <button type="button">Loose B</button></div>
    <h2><a href="/heading">Linked heading</a></h2>
    <div role="navigation"><p>Go to <a href="/x">X</a> or <a href="/y">Y</a></p></div>
    <a href="/card"><h3>Card title</h3><p>Card body</p></a>
    <div role="button" tabindex="0">Role button</div>
    <p>No controls here</p>`));
  const observation = await observe(page);
  assertShape(observation);
  const id = label => observation.controls.find(c => c.label === label).id;
  const checkbox = observation.controls.find(c => c.role === 'checkbox').id;
  assert.deepEqual(observation.blocks, [
    { t: 'label', text: 'I accept the terms', ref: checkbox },
    { t: 'li', text: 'Only link', ref: id('Only link') },
    { t: 'a', text: 'Loose A', ref: id('Loose A') },
    { t: 'button', text: 'Loose B', ref: id('Loose B') },
    { t: 'h2', text: 'Linked heading', ref: id('Linked heading') },
    { t: 'p', text: 'Go to or' },
    { t: 'a', text: 'X', ref: id('X') },
    { t: 'a', text: 'Y', ref: id('Y') },
    { t: 'a', text: 'Card title Card body', ref: observation.controls.find(c => c.href?.endsWith('/card')).id },
    { t: 'button', text: 'Role button', ref: id('Role button') },
    { t: 'p', text: 'No controls here' },
  ]);
});

test('text joining: table cells, inline elements, line breaks and nested containers', async t => {
  const page = await load(t, doc(`
    <table><thead><tr><th>Item</th><th></th><th>Price</th></tr></thead>
      <tbody><tr><td><p>Tea</p><p>green</p></td><td>-</td><td><b>$</b>4</td></tr></tbody></table>
    <p>foo<b>bar</b> baz<br>next</p>
    <ul><li><div>Outer</div><div>item</div><ul><li>Inner item</li></ul></li></ul>
    <section>Loose text <span>in a section</span><p>Own paragraph</p></section>
    <h5>Small heading</h5>`));
  const observation = await observe(page);
  assertShape(observation);
  assert.deepEqual(observation.blocks, [
    { t: 'tr', text: 'Item | Price' },
    { t: 'tr', text: 'Tea green | - | $4' },
    { t: 'p', text: 'foobar baz next' },
    { t: 'li', text: 'Outer · item' },
    { t: 'li', text: 'Inner item' },
    { t: 'p', text: 'Loose text in a section' },
    { t: 'p', text: 'Own paragraph' },
    { t: 'h4', text: 'Small heading' },
  ]);
});

test('caps: at most 200 blocks with blocksTruncated, and 300 characters per block', async t => {
  const paragraphs = Array.from({ length: 250 }, (_, i) => `<p>Paragraph ${i}</p>`).join('');
  const page = await load(t, doc(`<p>${'word '.repeat(200)}</p>${paragraphs}`));
  const observation = await observe(page);
  assertShape(observation);
  assert.equal(observation.blocks.length, 200);
  assert.equal(observation.blocksTruncated, true);
  assert.equal(observation.blocks[0].text.length, 300 - 1, 'cut at 300 characters, then trimmed');
  assert.ok(observation.blocks[0].text.startsWith('word word'));
  // Document order within each group.
  const numbers = observation.blocks.slice(1).map(b => Number(b.text.split(' ')[1]));
  assert.deepEqual(numbers, [...numbers].sort((a, b) => a - b));
});

test('scrolled page: in-viewport blocks come first, off-screen blocks follow in document order', async t => {
  const rows = Array.from({ length: 40 }, (_, i) => `<p style="height:100px;margin:0">Row ${i}</p>`).join('');
  const page = await load(t, doc(rows));
  await page.evaluate(() => scrollTo(0, 2000));
  const observation = await observe(page);
  assertShape(observation);
  const visible = observation.blocks.filter(b => !b.offscreen).map(b => b.text);
  const offscreen = observation.blocks.filter(b => b.offscreen).map(b => b.text);
  assert.deepEqual(visible, Array.from({ length: 8 }, (_, i) => `Row ${20 + i}`));
  assert.deepEqual(offscreen, [
    ...Array.from({ length: 20 }, (_, i) => `Row ${i}`),
    ...Array.from({ length: 12 }, (_, i) => `Row ${28 + i}`),
  ]);
  assert.deepEqual(observation.blocks.slice(0, 8).map(b => b.text), visible, 'visible blocks lead the list');
});

test('truncation keeps the visible region: a page scrolled to the bottom keeps its on-screen blocks', async t => {
  const rows = Array.from({ length: 400 }, (_, i) => `<p style="height:40px;margin:0">Row ${i}</p>`).join('');
  const page = await load(t, doc(rows));
  await page.evaluate(() => scrollTo(0, document.body.scrollHeight));
  const observation = await observe(page);
  assertShape(observation);
  assert.equal(observation.blocks.length, 200);
  assert.equal(observation.blocksTruncated, true);
  const visible = observation.blocks.filter(b => !b.offscreen).map(b => b.text);
  assert.deepEqual(visible, Array.from({ length: 20 }, (_, i) => `Row ${380 + i}`));
  assert.equal(observation.blocks[20].text, 'Row 0');
  assert.equal(observation.blocks[199].text, 'Row 179');
});

test('blocks do not feed the revision; actions still validate and return blocks afterwards', async t => {
  const page = await load(t, doc(`<button type="button" onclick="document.querySelector('#out').textContent='Clicked'">Go</button>
    <p id="out">Waiting</p><div style="height:3000px"></div><p id="far">Far away</p>`));
  const before = await observe(page);
  await page.evaluate(() => { document.querySelector('#far').textContent = 'Far away, edited'; });
  const unchanged = await observe(page);
  assert.equal(unchanged.revision, before.revision, 'off-screen block text does not change the revision');
  assert.deepEqual(unchanged.blocks.at(-1), { t: 'p', text: 'Far away, edited', offscreen: true });
  const result = await page.evaluate(revision =>
    __faiPage.execute({ type: 'click', target: '1' }, revision, { quietMs: 0, capMs: 100 }), unchanged.revision);
  assert.notEqual(result.observation.revision, before.revision);
  assert.deepEqual(result.observation.blocks.slice(0, 2), [{ t: 'button', text: 'Go', ref: '1' }, { t: 'p', text: 'Clicked' }]);
});

// --- risk classes and capabilities (configurable-guardrails.md §3.1, §3.6) -----------------------------------------

const CAPS = {
  'read-only': ['navigate'],
  reversible: ['navigate', 'controls'],
  interactive: ['navigate', 'controls', 'submit_safe'],
  full: ['navigate', 'controls', 'submit_safe', 'submit', 'delete', 'consent_accept'],
  testing: ['navigate', 'controls', 'submit_safe', 'submit', 'delete', 'consent_accept', 'sign_in', 'purchase'],
};
const SETTLE = { quietMs: 10, capMs: 200 };

// Observes with `allow`, then dispatches `action` (target named by label) with the same set: 'ran' or the error code.
async function attempt(page, level, label, action = { type: 'click' }) {
  return page.evaluate(async ([allow, label, action, settle]) => {
    const observation = __faiPage.observe({ allow });
    const control = observation.controls.find(item => item.label === label);
    if (!control) return 'missing';
    try {
      await __faiPage.execute({ ...action, target: control.id }, observation.revision, settle, [], undefined, allow);
      return 'ran';
    } catch (error) {
      return error.code;
    }
  }, [CAPS[level], label, action, SETTLE]);
}

const classes = observation => Object.fromEntries(observation.controls.map(c => [c.label, c.risk]));

const ACTIONS = doc(`
  <button type="button">Show details</button>
  <button type="button">Save</button>
  <button type="button">Delete</button>
  <button type="button">Apply now</button>
  <button type="button">Cancel subscription</button>
  <button type="button">Pay now</button>
  <button type="button">Sign in</button>
  <a href="#section">Section</a>
  <form onsubmit="event.preventDefault()"><input aria-label="Query" name="q"><button type="submit">Search</button></form>
  <form onsubmit="event.preventDefault()"><input aria-label="Nickname" name="nick"><button type="submit">Continue</button></form>
  <label>Gift <select name="gift"><option value="none">No gift</option><option value="del">Delete my list</option><option value="buy">Buy now</option></select></label>`);

test('every control carries its risk class, whatever the capability set; without one page.js blocks as before', async t => {
  const page = await load(t, ACTIONS);
  const expected = {
    'Show details': 'reversible', Save: 'submit', Delete: 'delete', 'Apply now': 'submit',
    'Cancel subscription': 'delete', 'Pay now': 'purchase', 'Sign in': 'sign_in', Section: 'navigation',
    // A SAFE_SUBMIT label on a page without password/payment fields is a safe submit; it reads 'submit' on the wire
    // (the runtime decides submit_safe itself) and page.js dispatches it with submit_safe.
    Search: 'submit',
    Continue: 'submit',
  };
  for (const allow of [undefined, CAPS['read-only'], CAPS.full, CAPS.testing]) {
    const c = classes(await page.evaluate(allow => __faiPage.observe({ allow }), allow));
    for (const [label, risk] of Object.entries(expected)) assert.equal(c[label], risk, `${label} with ${allow}`);
  }
  // Without a capability set (an older worker) page.js blocks exactly what it always blocked.
  const fresh = await load(t, ACTIONS);
  assert.equal(await attempt(fresh, undefined, 'Show details'), 'ran');
  for (const label of ['Save', 'Pay now', 'Search', 'Delete', 'Sign in']) {
    assert.equal(await attempt(fresh, undefined, label), 'blocked_risky', label);
  }
});

test('dispatch is allowed per class only when the capability set grants it, level by level', async t => {
  const page = await load(t, ACTIONS);
  const expected = {
    //                      read-only  reversible interactive full   testing
    'Show details':        [false,     true,      true,       true,  true],
    Section:               [true,      true,      true,       true,  true],
    Search:                [false,     false,     true,       true,  true],
    Continue:              [false,     false,     false,      true,  true],
    Save:                  [false,     false,     false,      true,  true],
    'Apply now':           [false,     false,     false,      true,  true],
    Delete:                [false,     false,     false,      true,  true],
    'Cancel subscription': [false,     false,     false,      true,  true],
    'Sign in':             [false,     false,     false,      false, true],
    'Pay now':             [false,     false,     false,      false, true],
  };
  const levels = Object.keys(CAPS);
  for (const [label, row] of Object.entries(expected)) {
    for (const [index, level] of levels.entries()) {
      const outcome = await attempt(page, level, label);
      assert.equal(outcome, row[index] ? 'ran' : 'blocked_risky', `${label} at ${level}`);
    }
  }
  // Targetless actions are navigation: allowed at every level.
  const scrolled = await page.evaluate(async ([allow, settle]) => {
    const observation = __faiPage.observe({ allow });
    await __faiPage.execute({ type: 'scroll', direction: 'down' }, observation.revision, settle, [], undefined, allow);
    return 'ran';
  }, [CAPS['read-only'], SETTLE]);
  assert.equal(scrolled, 'ran');
});

test('select options are re-checked by class at dispatch', async t => {
  const page = await load(t, ACTIONS);
  const label = (await observe(page)).controls.find(c => c.role === 'combobox').label;
  const choose = (level, value) => attempt(page, level, label, { type: 'select', value });
  assert.equal(await choose('reversible', 'del'), 'blocked_risky');
  assert.equal(await choose('full', 'del'), 'ran');
  assert.equal(await choose('full', 'buy'), 'blocked_risky', 'a purchase option is blocked below testing');
  assert.equal(await choose('testing', 'buy'), 'ran');
  assert.equal(await choose('read-only', 'none'), 'blocked_risky', 'a select needs controls');
});

test('payment fields are purchase: not fillable below testing, and their form submit is a purchase', async t => {
  const page = await load(t, doc(`
    <form onsubmit="event.preventDefault()">
      <input aria-label="Name on card" name="ccname" autocomplete="cc-name">
      <input aria-label="Number" name="cardNumber">
      <input aria-label="Expiry" name="exp-date">
      <input aria-label="CVC" name="security">
      <input aria-label="Coupon" name="coupon">
      <button type="submit">Continue</button>
    </form>
    <form onsubmit="event.preventDefault()"><input aria-label="Account" name="iban"><button type="submit">Next</button></form>
    <form onsubmit="event.preventDefault()"><input aria-label="Query" name="q"><button type="submit">Search</button></form>`));
  const c = classes(await page.evaluate(allow => __faiPage.observe({ allow }), CAPS.full));
  for (const label of ['Name on card', 'Number', 'Expiry', 'CVC', 'Account']) assert.equal(c[label], 'purchase', label);
  assert.equal(c.Coupon, 'reversible');
  assert.equal(c.Continue, 'purchase', 'submitting a form with payment fields');
  assert.equal(c.Next, 'purchase');
  // A payment field makes this a purchase page (the Approve gate's rule), but a search form keeps its own class: a
  // submit (never a safe one next to payment fields).
  assert.equal(c.Search, 'submit');
  assert.equal(await attempt(page, 'interactive', 'Search'), 'blocked_risky', 'no safe submit on a page with payment fields');
  const fill = { type: 'fill_supplied_text', text: '4242 4242 4242 4242' };
  assert.equal(await attempt(page, 'full', 'Number', fill), 'blocked_risky');
  assert.equal(await attempt(page, 'full', 'Coupon', fill), 'ran');
  assert.equal(await attempt(page, 'full', 'Continue'), 'blocked_risky');
  assert.equal(await attempt(page, 'testing', 'Number', fill), 'ran');
  assert.equal(await attempt(page, 'testing', 'Continue'), 'ran');
  const control = (await observe(page)).controls.find(item => item.label === 'Number');
  assert.equal(control.name, 'cardNumber', 'field identity reaches the runtime payment check');
});

test('password inputs are listed and fillable only with sign_in; a form with one is a sign-in', async t => {
  const page = await load(t, doc(`<h1>Members</h1>
    <form onsubmit="event.preventDefault()"><input aria-label="Email" name="email">
    <input aria-label="Password" type="password" name="pw"><button type="submit">Continue</button></form>`));
  for (const level of ['read-only', 'reversible', 'full']) {
    const observation = await page.evaluate(allow => __faiPage.observe({ allow }), CAPS[level]);
    assert.ok(!observation.controls.some(c => c.type === 'password'), level);
    assert.ok(observation.warnings.includes('password_field'), level);
  }
  assert.equal(classes(await page.evaluate(allow => __faiPage.observe({ allow }), CAPS.full)).Continue, 'sign_in');
  const testing = await page.evaluate(allow => __faiPage.observe({ allow }), CAPS.testing);
  const password = testing.controls.find(c => c.type === 'password');
  assert.deepEqual([password.label, password.risk], ['Password', 'sign_in']);
  assert.equal(password.filled, false);
  const fill = { type: 'fill_supplied_text', text: 'test-password' };
  assert.equal(await attempt(page, 'testing', 'Password', fill), 'ran');
  assert.equal(await page.evaluate(() => document.querySelector('[type=password]').value), 'test-password');
  assert.equal(await attempt(page, 'testing', 'Continue'), 'ran');
  // The control listed under testing is refused when a later call lowers the set (the id may not even resolve).
  const lowered = await page.evaluate(async ([testingAllow, fullAllow, settle]) => {
    const observation = __faiPage.observe({ allow: testingAllow });
    const id = observation.controls.find(c => c.type === 'password').id;
    try {
      await __faiPage.execute({ type: 'fill_supplied_text', target: id, text: 'x' }, observation.revision, settle, [], undefined, fullAllow);
      return 'ran';
    } catch (error) {
      return error.code;
    }
  }, [CAPS.testing, CAPS.full, SETTLE]);
  assert.notEqual(lowered, 'ran');
});

test('additions (forbid) block at every level, testing included', async t => {
  const page = await load(t, ACTIONS);
  const outcome = await page.evaluate(async ([allow, settle]) => {
    const observation = __faiPage.observe({ allow, forbid: ['Show details'] });
    const control = observation.controls.find(item => item.label === 'Show details');
    try {
      await __faiPage.execute({ type: 'click', target: control.id }, observation.revision, settle, [], ['Show details'], allow);
      return [control.risk, 'ran'];
    } catch (error) {
      return [control.risk, error.code];
    }
  }, [CAPS.testing, SETTLE]);
  assert.deepEqual(outcome, ['destructive', 'blocked_risky']);
});

test('script links (role=link without <a href>) need controls and keep their label class; real links stay navigation', async t => {
  const page = await load(t, doc(`
    <a href="/about">Buy tickets guide</a>
    <span role="link" tabindex="0" onclick="document.title='bought'">Buy now</span>
    <span role="link" tabindex="0" onclick="document.title='opened'">Open panel</span>
    <div role="link" tabindex="0" onclick="document.title='deleted'">Delete account</div>`));
  const c = classes(await page.evaluate(allow => __faiPage.observe({ allow }), CAPS.full));
  assert.equal(c['Buy tickets guide'], 'navigation');
  assert.equal(c['Buy now'], 'purchase');
  assert.equal(c['Open panel'], 'reversible');
  assert.equal(c['Delete account'], 'delete');
  assert.equal(await attempt(page, 'full', 'Buy now'), 'blocked_risky', 'a forged click on a purchase script link');
  assert.equal(await attempt(page, 'reversible', 'Delete account'), 'blocked_risky');
  assert.equal(await attempt(page, 'read-only', 'Open panel'), 'blocked_risky', 'a script link needs controls');
  assert.equal(await attempt(page, 'reversible', 'Open panel'), 'ran');
});
