// Guardrail pass, extension side: the page script compiles guardrail additions with a byte-identical copy of
// src/guardrails.js forbidPattern (drift check), refuses matching controls in every role (risk + dispatch) on top of
// its hard-coded core block, and the hub carries the phrases (strings, never regex source) in observe and execute
// commands. The worker's phrase filter admits exactly what normalizeAdditions admits.
import test from 'node:test';
import { headlessEnv } from '../scripts/headless-env.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { chromium } from 'playwright-core';
import * as guardrails from '../src/guardrails.js';
import { GUARDRAIL_LIMITS, forbidPattern, normalizeAdditions, normalizeLabel, labelSpellings, labelClasses } from '../src/guardrails.js';
import { createHub } from '../src/bridge.js';
import { EXTENSION_ID, FakeExtension, SECRET } from './helpers/fake-extension.js';

const PAGE_SCRIPT = new URL('../extension/page.js', import.meta.url).pathname;
const WORKER = new URL('../extension/background.js', import.meta.url).pathname;
const squash = text => text.replace(/\s+/g, ' ').trim();

test('page.js forbidPattern is identical to src/guardrails.js (drift check on the sources)', async () => {
  const page = await readFile(PAGE_SCRIPT, 'utf8');
  const match = page.match(/ {2}function forbidPattern\(phrases\) \{[\s\S]*?\n {2}\}\n/);
  assert.ok(match, 'extension/page.js defines forbidPattern');
  assert.equal(squash(match[0]), squash(forbidPattern.toString()));
  // Byte-identical once the page script's two-space closure indent is removed.
  assert.equal(match[0].split('\n').map(line => line.replace(/^ {2}/, '')).join('\n').trimEnd(), forbidPattern.toString());
  // The page script still keeps its own core block (label classes), applied whatever the additions are.
  assert.match(page, /function labelClass\(label\) \{[\s\S]*?for \(const text of labelSpellings\(label\)\)/);
  const normalizer = page.match(/ {2}function normalizeLabel\(label\) \{[\s\S]*?\n {2}\}\n/);
  assert.ok(normalizer);
  assert.equal(normalizer[0].split('\n').map(line => line.replace(/^ {2}/, '')).join('\n').trimEnd(), normalizeLabel.toString());
  assert.match(page, /if \(forbidden\(label\)\) return \{ cls: 'forbid' \};/);
  const spellings = page.match(/ {2}function labelSpellings\(label\) \{[\s\S]*?\n {2}\}\n/);
  assert.ok(spellings);
  assert.equal(spellings[0].split('\n').map(line => line.replace(/^ {2}/, '')).join('\n').trimEnd(), labelSpellings.toString());
  // The same caps on both sides: 40 phrases (config + request, 2 x 20) of at most 60 characters.
  assert.match(page, new RegExp(`const MAX_FORBID = ${GUARDRAIL_LIMITS.maxForbid * 2};`));
  assert.match(page, new RegExp(`const MAX_FORBID_LENGTH = ${GUARDRAIL_LIMITS.maxPhraseLength};`));
  const worker = await readFile(WORKER, 'utf8');
  assert.match(worker, new RegExp(`const MAX_FORBID = ${GUARDRAIL_LIMITS.maxForbid * 2};`));
  assert.match(worker, new RegExp(`\\{0,${GUARDRAIL_LIMITS.maxPhraseLength - 1}\\}\\$/u;`));
  // The compiled patterns agree on a sample of labels (behavioural drift check on top of the source comparison).
  const pageForbid = new Function('normalizeLabel', `return (${match[0].trim()})`)(normalizeLabel);
  const phrases = ['Gift wrap', 'Save 20%', 'Ändern', "Don't sell", 'Add-ons & extras'];
  for (const label of ['Add gift  wrap', 'gift-wrap', 'SAVE 20%', 'Save 200%', 'ändern', 'Veränderung', "don't sell my data", 'Add-ons & extras', 'Upgrade']) {
    assert.equal(pageForbid(phrases).test(label), forbidPattern(phrases).test(label), label);
  }
});

// Label and field classes split by capability (configurable-guardrails.md §3.2): page.js keeps byte copies.
const MIRRORED = ['PURCHASE', 'COMMIT_OTHER', 'SUBMIT_WORDS', 'DELETE_WORDS', 'SIGN_IN_WORDS', 'SAFE_SUBMIT',
  'PAYMENT_AUTOCOMPLETE', 'PAYMENT_FIELD', 'AMBIGUOUS_SUBMIT', 'AMBIGUOUS_PURCHASE',
  // The Approve gate's rules.
  'SECRET_ACTION', 'COMMIT_DIALOG', 'BACK_OUT', 'STEPPER', 'PURCHASE_PATH', 'PURCHASE_TOTAL', 'COMMIT_LIKE'];

test('page.js mirrors the split label and field classes of src/guardrails.js byte for byte', async () => {
  const page = await readFile(PAGE_SCRIPT, 'utf8');
  for (const name of MIRRORED) {
    assert.ok(guardrails[name] instanceof RegExp, `src/guardrails.js exports ${name}`);
    const literal = page.match(new RegExp(`\\n {2}const ${name} = (\\/.+\\/[a-z]*);\\n`))?.[1];
    assert.ok(literal, `extension/page.js defines ${name}`);
    assert.equal(literal, String(guardrails[name]), name);
  }
  // The old single patterns are gone from the page script: every check goes through the split sets.
  assert.doesNotMatch(page, /const (?:COMMIT_ACTION|DESTRUCTIVE) =/);
});

test('page.js labelClass ranks a label like the runtime labelClasses (behavioural drift check)', async () => {
  const page = await readFile(PAGE_SCRIPT, 'utf8');
  const body = name => page.match(new RegExp(`\\n {2}function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n {2}\\}\\n`))?.[0];
  const order = page.match(/const CLASS_ORDER = (\[[^\]]+\]);/)?.[1];
  assert.ok(body('severer') && body('labelClass') && order);
  const names = ['labelSpellings', 'CLASS_ORDER', ...MIRRORED];
  // eslint-disable-next-line no-new-func
  const pageClass = new Function(...names, `${body('severer')}\n${body('labelClass')}\nreturn labelClass;`)(
    labelSpellings, JSON.parse(order.replace(/'/g, '"')), ...MIRRORED.map(name => guardrails[name]));
  const labels = ['Place order', 'Pay now', 'Buy', 'Purchase', 'Subscribe', 'Donate', 'Start free trial', 'Check out',
    'Add payment method', 'Apply now', 'Apply changes', 'Cancel subscription', 'Cancel my order', 'Save', 'Send message',
    'Confirm', 'Publish', 'Invite', 'Delete', 'Remove item', 'Sign in', 'Log in', 'Login', 'S a v e', 'Sa\u200bve',
    'Sign in to buy', 'Delete and pay', 'Save and remove', 'Bookmarks', 'Order history', 'Apply', 'Apply filters',
    'Add to cart', 'Show more', 'Payments', 'Savings', 'Resend code', 'Cancel',
    // Discount and plan-picker wording (cleared) next to real saves and payments (still flagged).
    'Save 30%', 'Save €20', 'save up to 40%', 'Two years (save 30%)', 'Save 20 percent', '€9/month', 'Billed yearly',
    'Save changes', 'Save card', 'Save 2 files', 'Subscribe for €9/month', 'Pay €9', 'Subscribe and save 20%'];
  for (const label of labels) {
    assert.equal(pageClass(label), labelClasses(label)[0] ?? null, label);
  }
});

test('the worker phrase filter admits what normalizeAdditions admits and drops regex source', async () => {
  const worker = await readFile(WORKER, 'utf8');
  const source = worker.match(/const FORBID_PHRASE = (\/.+\/u);/);
  assert.ok(source, 'background.js defines FORBID_PHRASE');
  // eslint-disable-next-line no-eval
  const FORBID_PHRASE = (0, eval)(source[1]);
  for (const phrase of ['Upgrade', 'Gift wrap', 'Add-ons & extras', 'Save 20%', 'Ändern', "Don't sell", 'x'.repeat(60)]) {
    assert.deepEqual(normalizeAdditions([phrase]).forbid, [phrase]);
    assert.ok(FORBID_PHRASE.test(phrase), phrase);
  }
  for (const phrase of ['Pay.*', '(Buy)', 'a|b', '<b>', '', ' lead', 'x'.repeat(61)]) {
    assert.ok(!FORBID_PHRASE.test(phrase), phrase);
  }
});

test('page.js refuses controls matching the additions in every role; an empty list clears them; core always applies', async t => {
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
  const html = '<!doctype html><html><head><title>Shop</title></head><body>'
    + '<button type="button" id="gift">Add gift wrap</button><button type="button" id="go">Continue</button>'
    + '<a href="/upgrade" id="up">Upgrade</a><a href="/upgrades">Upgrades</a><button type="button">Place order</button>'
    + '<label for="plan">Plan</label><select id="plan"><option value="free">Free</option><option value="pro">Upgrade to Pro</option><option value="team">Team</option></select>'
    + '</body></html>';
  await page.route('https://shop.test/**', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('https://shop.test/');
  await page.addScriptTag({ path: PAGE_SCRIPT });
  const risks = observation => Object.fromEntries(observation.controls.map(control => [control.label, control.risk]));

  const plain = await page.evaluate(() => __faiPage.observe());
  assert.equal(risks(plain)['Add gift wrap'], 'reversible');
  assert.equal(risks(plain)['Place order'], 'purchase', 'core block without additions');

  const guarded = await page.evaluate(() => __faiPage.observe({ forbid: ['Gift wrap', 'Upgrade', 'Pay.*'] }));
  const r = risks(guarded);
  assert.equal(r['Add gift wrap'], 'destructive');
  assert.equal(r.Upgrade, 'destructive', 'a link is refused too');
  assert.equal(r.Upgrades, 'navigation', 'word-bounded');
  assert.equal(r.Continue, 'reversible');
  assert.equal(r['Place order'], 'purchase');
  const gift = guarded.controls.find(control => control.label === 'Add gift wrap');
  const refused = await page.evaluate(([id, revision]) => __faiPage.execute({ type: 'click', target: id }, revision, {}, [], ['Gift wrap'])
    .then(() => null, error => error.code), [gift.id, guarded.revision]);
  assert.equal(refused, 'blocked_risky');
  // A select option with a forbidden label is refused at dispatch; another option is fine.
  const fresh = await page.evaluate(() => __faiPage.observe({ forbid: ['Upgrade'] }));
  const plan = fresh.controls.find(control => control.role === 'combobox');
  const selected = await page.evaluate(([id, revision]) => __faiPage.execute({ type: 'select', target: id, value: 'pro' }, revision, { quietMs: 10, capMs: 200 }, [], ['Upgrade'])
    .then(() => 'ran', error => error.code), [plan.id, fresh.revision]);
  assert.equal(selected, 'blocked_risky');
  const team = await page.evaluate(() => __faiPage.observe({ forbid: ['Upgrade'] }));
  const ok = await page.evaluate(([id, revision]) => __faiPage.execute({ type: 'select', target: id, value: 'team' }, revision, { quietMs: 10, capMs: 200 }, [], ['Upgrade'])
    .then(() => 'ran', error => error.code), [team.controls.find(control => control.role === 'combobox').id, team.revision]);
  assert.equal(ok, 'ran');
  // An empty list clears the additions for this document; the core block stays.
  const cleared = await page.evaluate(() => __faiPage.observe({ forbid: [] }));
  assert.equal(risks(cleared)['Add gift wrap'], 'reversible');
  assert.equal(risks(cleared)['Place order'], 'purchase');
  // Regex source sent by mistake is matched literally, never as a pattern.
  const literal = await page.evaluate(() => __faiPage.observe({ forbid: ['Contin.*'] }));
  assert.equal(risks(literal).Continue, 'reversible');
  // An observe that does not name the list (the screenshot re-observe) keeps this document's list; it is the worker
  // that clears it per run (test/extension-worker.test.js).
  await page.evaluate(() => __faiPage.observe({ forbid: ['Gift wrap'] }));
  assert.equal(risks(await page.evaluate(() => __faiPage.observe()))['Add gift wrap'], 'destructive');
});

test('page.js applies the additions to custom listbox options, shadow roots and same-origin frames', async t => {
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
  const html = '<!doctype html><html><head><title>Shop</title></head><body>'
    + '<div role="listbox" aria-label="Extras"><div role="option" tabindex="0">Gift wrap</div><div role="option" tabindex="0">No extras</div></div>'
    + '<div id="host"></div>'
    + '<iframe id="frame" src="/frame" width="600" height="200"></iframe>'
    + '<script>document.getElementById("host").attachShadow({mode:"open"}).innerHTML = \'<button type="button">Add gift wrap</button><button type="button">Close</button>\';</script>'
    + '</body></html>';
  const frame = '<!doctype html><html><body><button type="button">Gift wrap in frame</button><button type="button">Frame help</button></body></html>';
  await page.route('https://shop.test/**', route => route.fulfill({
    contentType: 'text/html', body: new URL(route.request().url()).pathname === '/frame' ? frame : html,
  }));
  await page.goto('https://shop.test/');
  await page.frameLocator('#frame').locator('button').first().waitFor();
  await page.addScriptTag({ path: PAGE_SCRIPT });
  const observation = await page.evaluate(() => __faiPage.observe({ forbid: ['Gift wrap'] }));
  const byLabel = Object.fromEntries(observation.controls.map(control => [control.label, control]));
  for (const label of ['Gift wrap', 'Add gift wrap', 'Gift wrap in frame']) {
    assert.ok(byLabel[label], `${label} observed (${Object.keys(byLabel).join(' | ')})`);
    assert.equal(byLabel[label].risk, 'destructive', label);
  }
  assert.equal(byLabel['Gift wrap'].role, 'option');
  for (const label of ['No extras', 'Close', 'Frame help']) assert.notEqual(byLabel[label]?.risk, 'destructive', label);
  for (const label of ['Gift wrap', 'Add gift wrap', 'Gift wrap in frame']) {
    const code = await page.evaluate(([id, revision]) => __faiPage.execute({ type: 'click', target: id }, revision, {}, [], ['Gift wrap'])
      .then(() => 'ran', error => error.code), [byLabel[label].id, observation.revision]);
    assert.equal(code, 'blocked_risky', label);
  }
});

test('the hub sends the phrases in observe and execute commands, and nothing extra without them', async t => {
  const hub = createHub({ secret: SECRET, extensionId: EXTENSION_ID, mode: 'daemon' });
  const server = http.createServer((req, res) => {
    if (hub.handleHttp(req, res)) return;
    res.writeHead(404);
    res.end();
  });
  server.on('upgrade', (req, socket, head) => {
    if (!hub.handleUpgrade(req, socket, head)) socket.destroy();
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  hub.onEvent(event => {
    if (event.type === 'hello') event.reply({ mode: 'daemon', daemonVersion: '0.2.0', endSession: false });
    else if (event.type === 'lease') {
      hub.bindLease({ leaseId: 'lease-1', requestId: 'req_1', tabId: 7, origin: event.origin, allowedOrigins: [event.origin] });
      event.reply({ leaseId: 'lease-1', requestId: 'req_1' });
    }
  });
  const ext = await FakeExtension.connect({ port: server.address().port });
  t.after(async () => {
    ext.close();
    hub.close();
    server.closeAllConnections();
    await new Promise(done => server.close(done));
  });
  await ext.hello();
  await ext.lease({ requestId: 'req_1', tabId: 7, origin: 'https://example.com' });
  const bridge = hub.bridgeFor('lease-1');

  const observe = bridge.observe(undefined, { terms: ['plan'], forbid: ['Gift wrap', 7, 'Upgrade'] });
  const command = await ext.command();
  assert.deepEqual(command.args, { terms: ['plan'], forbid: ['Gift wrap', 'Upgrade'] });
  ext.result(command.id, { revision: 'doc:1' });
  await observe;

  const execution = bridge.execute({ type: 'click', target: '1' }, 'doc:1', { capture: false, forbid: ['Gift wrap'] });
  const execute = await ext.command();
  assert.deepEqual(execute.args, { action: { type: 'click', target: '1' }, expectedRevision: 'doc:1', capture: false, forbid: ['Gift wrap'] });
  ext.result(execute.id, { observation: { revision: 'doc:2' }, settle: { reason: 'quiet', ms: 5 } });
  await execution;

  const bare = bridge.observe(undefined, { forbid: [] });
  const bareCommand = await ext.command();
  assert.deepEqual(bareCommand.args, {}, 'no phrases: the command is unchanged');
  ext.result(bareCommand.id, { revision: 'doc:3' });
  await bare;
});

test('page.js labelTier is a byte copy of src/guardrails.js labelTier (the intent tiers)', async () => {
  const page = await readFile(PAGE_SCRIPT, 'utf8');
  const copy = page.match(/\n {2}function labelTier\([^)]*\) \{[\s\S]*?\n {2}\}\n/)?.[0];
  assert.ok(copy, 'extension/page.js defines labelTier');
  assert.equal(copy.trim().split('\n').map(line => line.replace(/^ {2}/, '')).join('\n'), guardrails.labelTier.toString());
});

test('page.js judges link names like src/oversight.js destructiveLinkClass (byte copies plus a behavioural check)', async () => {
  const oversight = await import('../src/oversight.js');
  const page = await readFile(PAGE_SCRIPT, 'utf8');
  const lead = page.match(/\n {2}const LINK_DANGER_LEAD = (\/.+\/[a-z]*);\n/)?.[1];
  assert.equal(lead, String(oversight.LINK_DANGER_LEAD));
  const classes = page.match(/\n {2}const LINK_LEAD_CLASSES = (\[\n[\s\S]*?\n {2}\]);\n/)?.[1];
  assert.ok(classes, 'extension/page.js defines LINK_LEAD_CLASSES');
  // eslint-disable-next-line no-new-func
  const copied = new Function(`return ${classes}`)();
  assert.deepEqual(copied.map(([kind, pattern]) => [kind, String(pattern)]),
    oversight.LINK_LEAD_CLASSES.map(([kind, pattern]) => [kind, String(pattern)]));
  assert.match(page, /\n {2}const MAX_GATED_LINK_WORDS = 4;\n/);
  const body = page.match(/\n {2}function linkActionClass\([^)]*\) \{[\s\S]*?\n {2}\}\n/)?.[0];
  assert.ok(body);
  // eslint-disable-next-line no-new-func
  const pageClass = new Function('labelSpellings', 'LINK_DANGER_LEAD', 'LINK_LEAD_CLASSES', 'MAX_GATED_LINK_WORDS', 'PURCHASE',
    'COMMIT_OTHER', `${body}\nreturn linkActionClass;`)(labelSpellings, oversight.LINK_DANGER_LEAD, oversight.LINK_LEAD_CLASSES, 4,
    guardrails.PURCHASE, guardrails.COMMIT_OTHER);
  const runtimeClass = label => labelSpellings(label).map(oversight.destructiveLinkClass).find(Boolean) ?? null;
  for (const label of ['Sign out', 'Log out', 'Logout', 'Sign in', 'Delete account', 'Remove', 'Buy now', 'Checkout',
    'Proceed to checkout', 'Place order', 'Subscribe', 'Unsubscribe', 'Cancel my subscription', 'Close my account', 'Save',
    'Send message', 'Confirm', 'Publish', 'Invite', 'Apply now', 'Delete account help', '→ Sign out', 'S i g n out',
    'Sign up', 'Order history', 'How to delete a branch', 'Where to buy', 'Account deletion policy', 'Home', 'Profile',
    'Delete your account: a step-by-step guide', 'Continue shopping', 'Subscriptions', 'Apply', 'Cancellation terms']) {
    assert.equal(pageClass(label), runtimeClass(label), label);
  }
});
