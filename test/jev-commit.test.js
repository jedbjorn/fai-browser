// Commit actions (orders, bookings, payments, subscriptions, applications, transfers) are caught in code, in the
// runtime's legal actions and in the page script's risk class, not only by the Jev policy ("Place order" on the
// jev-eval cart page was stopped only by the policy). The two regexes are kept identical (drift check).
import test from 'node:test';
import { headlessEnv } from '../scripts/headless-env.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { COMMIT_ACTION, legalActions } from '../src/runtime.js';
import { consentRejectActions, isRejectLabel } from '../src/oversight.js';

const PAGE_SCRIPT = new URL('../extension/page.js', import.meta.url).pathname;

const POSITIVES = [
  'Order', 'Order now', 'Place order', 'Place your order', 'Checkout', 'Proceed to checkout', 'Check out',
  'Proceed to check out', 'Book', 'Book now', 'Book this room', 'Reserve', 'Reserve now', 'Reserve a table',
  'Pay', 'Pay now', 'Pay €45.00', 'Buy it now', 'Subscribe', 'Subscribe to the newsletter', 'Upgrade plan',
  'Upgrade your plan', 'Start trial', 'Start free trial', 'Start your free trial', 'Apply now', 'Apply for this job',
  'Apply changes', 'Transfer', 'Transfer funds', 'Transfer money', 'Withdraw', 'Withdraw funds', 'Send money',
  'ORDER NOW!',
];
const NEGATIVES = [
  'Bookmarks', 'Book list', 'Books', 'Order history', 'Orders', 'Sort order', 'Apply', 'Apply filters',
  'Reserved seats', 'Transfer history', 'Withdrawal history', 'Payments', 'PayPal help', 'Buyer guide',
  'Unsubscribe', 'Subscriber list', 'Checklist', 'Show plans', 'Next page', 'Upgrade guide', 'Trial terms',
];

test('PURCHASE and COMMIT_OTHER in extension/page.js match the runtime constants, which compose COMMIT_ACTION (drift check)', async () => {
  const { PURCHASE, COMMIT_OTHER } = await import('../src/guardrails.js');
  const page = await readFile(PAGE_SCRIPT, 'utf8');
  for (const [name, regex] of Object.entries({ PURCHASE, COMMIT_OTHER })) {
    const match = page.match(new RegExp(`const ${name} = (\\/.+\\/[a-z]*);`));
    assert.ok(match, `extension/page.js defines ${name}`);
    assert.equal(match[1], String(regex), name);
  }
  assert.equal(COMMIT_ACTION.source, `${PURCHASE.source}|${COMMIT_OTHER.source}`);
});

test('commit labels are caught; bookmarks, lists, history and filter buttons are not', () => {
  for (const label of POSITIVES) assert.ok(COMMIT_ACTION.test(label), `should catch "${label}"`);
  for (const label of NEGATIVES) assert.ok(!COMMIT_ACTION.test(label), `should not catch "${label}"`);
});

test('legalActions never offers a commit button or commit link in reversible mode; ordinary links and buttons stay', () => {
  const controls = [...POSITIVES, ...NEGATIVES].map((label, index) => ({
    id: String(index), role: 'button', label, visible: true, enabled: true, risk: 'reversible',
  }));
  controls.push({ id: 'l1', role: 'link', label: 'Checkout', href: 'https://shop.test/checkout', risk: 'navigation' });
  controls.push({ id: 'l2', role: 'link', label: 'Order history', href: 'https://shop.test/orders', risk: 'navigation' });
  const offered = legalActions({ url: 'https://shop.test/cart', controls }, { mode: 'reversible' });
  const labels = new Set(offered.filter(action => action.role === 'button').map(action => action.label));
  for (const label of POSITIVES) assert.ok(!labels.has(label), `offered "${label}"`);
  for (const label of NEGATIVES) assert.ok(labels.has(label), `missing "${label}"`);
  // Machinery pass: a short link label that is a commit action (destructiveLink) is never offered.
  assert.ok(!offered.some(action => action.target === 'l1'), 'a Checkout link is a commit and is not offered');
  assert.ok(offered.some(action => action.target === 'l2'), 'Order history is navigation and stays offered');
});

test('page.js classifies purchase buttons as purchase (refused below testing); Apply filters stays reversible', async t => {
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, env: headlessEnv(), args: ['--no-sandbox'],
    });
  } catch (error) {
    t.skip(`no Chromium: ${error.message}`);
    return;
  }
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const html = '<!doctype html><html><head><title>Cart</title></head><body>'
    + '<button type="button">Place order</button><button type="button">Book now</button>'
    + '<div role="button" tabindex="0">Start free trial</div><button type="button">Apply filters</button>'
    + '<button type="button">Bookmarks</button><a href="/checkout">Checkout</a></body></html>';
  await page.route('https://shop.test/**', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('https://shop.test/cart');
  await page.addScriptTag({ path: PAGE_SCRIPT });
  const observation = await page.evaluate(() => __faiPage.observe());
  const risk = label => observation.controls.find(control => control.label === label)?.risk;
  // Risk classes (configurable-guardrails.md section 3.6): purchases are their own class.
  assert.equal(risk('Place order'), 'purchase');
  assert.equal(risk('Book now'), 'purchase');
  assert.equal(risk('Start free trial'), 'purchase');
  assert.equal(risk('Apply filters'), 'reversible');
  assert.equal(risk('Bookmarks'), 'reversible');
  assert.equal(risk('Checkout'), 'navigation');
  const target = observation.controls.find(control => control.label === 'Place order');
  const code = await page.evaluate(async ({ id, revision }) => {
    try {
      await __faiPage.execute({ type: 'click', target: id }, revision);
      return 'executed';
    } catch (error) {
      return error.code;
    }
  }, { id: target.id, revision: observation.revision });
  assert.equal(code, 'blocked_risky');
});

test('a pay-or-consent "Reject and subscribe" button is never a consent reject button', () => {
  assert.equal(isRejectLabel('Reject and subscribe'), false);
  assert.equal(isRejectLabel('Reject all'), true);
  const actions = consentRejectActions({ text: 'Cookies', buttons: [
    { id: '1', label: 'Reject and subscribe', kind: 'reject' }, { id: '2', label: 'Reject all', kind: 'reject' },
  ] });
  assert.deepEqual(actions.map(action => action.label), ['Reject all']);
});

test('page.js: in a consent dialog "Reject and subscribe" is not a reject button and is refused', async t => {
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, env: headlessEnv(), args: ['--no-sandbox'],
    });
  } catch (error) {
    t.skip(`no Chromium: ${error.message}`);
    return;
  }
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const html = '<!doctype html><html><head><title>News</title></head><body><p>Article</p>'
    + '<div id="cmp-banner" style="position:fixed;bottom:0;left:0;right:0;background:#fff">We use cookies.'
    + '<button type="button">Accept all</button><button type="button">Reject and subscribe</button></div></body></html>';
  await page.route('https://news.test/**', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('https://news.test/');
  await page.addScriptTag({ path: PAGE_SCRIPT });
  const observation = await page.evaluate(() => __faiPage.observe());
  assert.ok(observation.consent, 'the banner is detected');
  const kind = label => observation.consent.buttons.find(button => button.label === label)?.kind;
  assert.equal(kind('Accept all'), 'accept');
  assert.notEqual(kind('Reject and subscribe'), 'reject');
  const risk = observation.controls.find(control => control.label === 'Reject and subscribe')?.risk;
  assert.equal(risk, 'purchase');
});

test('page.js submit, delete and sign-in words are all in the runtime DANGEROUS regex (drift check on the sources)', async () => {
  const { DANGEROUS } = await import('../src/oversight.js');
  const page = await readFile(PAGE_SCRIPT, 'utf8');
  // The words of a \b(...)\b list without their lookaheads ("save" before a discount amount; byte drift checks them).
  const words = source => {
    let group = /^\\b\((.+)\)\\b$/.exec(source)[1];
    for (let previous; previous !== group;) {
      previous = group;
      group = group.replace(/\(\?!(?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)/g, '');
    }
    return group.split('|');
  };
  const runtimeWords = new Set(words(DANGEROUS.source));
  for (const name of ['SUBMIT_WORDS', 'DELETE_WORDS', 'SIGN_IN_WORDS']) {
    const match = page.match(new RegExp(`const ${name} = \\/(.+)\\/i;`));
    assert.ok(match, `extension/page.js defines ${name} as a word list`);
    for (const word of words(match[1])) assert.ok(runtimeWords.has(word), `runtime DANGEROUS lacks "${word}"`);
  }
});
