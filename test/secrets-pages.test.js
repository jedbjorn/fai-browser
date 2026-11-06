// Secret redaction in the page script (extension/page.js), on the fixtures/secrets pages in headless Chromium: no fake
// secret (raw, URL-encoded, base64 or a chunk of it) in any observation or action result; placeholders stable across
// observations and documents of one lease; secret fields marked sensitive; expectation texts matched against redacted
// text only; the secret-page warning, Strict and Relaxed. The live page is never modified.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { headlessEnv } from '../scripts/headless-env.mjs';
import { scrubSecrets, secretIds } from '../src/secrets.js';
import { SecretBridge } from './helpers/secret-bridge.js';
import { leaks, loadFakes } from './helpers/secret-fakes.js';
import { startStaticSite } from './helpers/static-site.js';

const F = loadFakes();
let site;
let browser;
test.before(async () => {
  site = await startStaticSite(new URL('../fixtures/secrets/', import.meta.url).pathname);
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true,
    env: headlessEnv(), args: ['--no-sandbox'] });
});
test.after(async () => {
  await browser?.close();
  await site?.close();
});

async function open(t, path, options = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  t.after(() => page.close());
  await page.goto(site.origin + path);
  return new SecretBridge(page, options);
}

const control = (observation, label) => observation.controls.find(item => item.label === label);
const noLeaks = (value, what) => assert.deepEqual(leaks(value), [], `${what}: ${JSON.stringify(value).slice(0, 400)}`);

test('API keys table: keys, a labelled copy button and signed links are redacted; secret page; stable placeholders', async t => {
  const bridge = await open(t, '/api-keys/?token=' + F.jwt);
  const first = await bridge.observe();
  noLeaks(first, 'observation');
  assert.ok(first.warnings.includes('secret_page'), JSON.stringify(first.warnings));
  assert.match(first.url, /^http:\/\/127\.0\.0\.1:\d+\/api-keys\/\?token=\[secret:~[0-9a-z]+ jwt eyJ…efgh len \d+\]$/);
  assert.equal(new URL(first.url).origin, site.origin, 'origin checks still work');
  assert.match(first.text, /\[secret:~[0-9a-z]+ openai sk-proj-…Yz56 len 64\]/);
  const copy = first.controls.find(item => item.role === 'button' && /^Copy /.test(item.label));
  assert.match(copy.label, /^Copy \[secret:~/);
  const download = control(first, 'Download usage report');
  assert.match(download.href, /\/api-keys\/report\?format=csv&token=\[secret:~/);
  assert.match(control(first, 'Continue to console').href, /\/console\/#access_token=\[secret:~[0-9a-z]+ google-oauth/);
  // The page itself is untouched (no detectable change), and a second observation reads the same placeholders.
  assert.equal(await bridge.page.evaluate(() => document.getElementById('k1').textContent), F.openai);
  const second = await bridge.observe();
  assert.equal(second.text, first.text);
  assert.equal(second.revision, first.revision);
  // The daemon numbers the tags per lease: [secret:1 ...], [secret:2], ...
  const numbered = scrubSecrets(first, secretIds());
  assert.match(numbered.text, /\[secret:\d+ openai sk-proj-…Yz56 len 64\]/);
  assert.doesNotMatch(JSON.stringify(numbered), /\[secret:~/);
});

test('a new token page (GitHub style): the shown token, the fine-grained ones and code runs', async t => {
  const bridge = await open(t, '/settings/tokens/new.html');
  const observation = await bridge.observe();
  noLeaks(observation, 'observation');
  assert.ok(observation.warnings.includes('secret_page'));
  assert.match(observation.text, /\[secret:~[0-9a-z]+ github ghp_…IJkl len 40\]/);
  assert.doesNotMatch(observation.text, /BUILD7f3a9c2e1d0b8a6f/, 'Strict on a secret page: a long code run goes');
  assert.match(observation.text, /Make sure to copy your personal access token now/);
});

// "Reveal live key" and "Show password" are credential actions the Approve gate asks the user about
// (test/approve-gate*.test.js); these pages test redaction after the click, so the ask is off here.
const NO_ASK = { gates: { purchase: true, secret: false, level: true } };

test('a read-only key field with a reveal button: the field is sensitive, the revealed key redacted', async t => {
  const bridge = await open(t, '/billing.html', NO_ASK);
  const before = await bridge.observe();
  noLeaks(before, 'observation');
  assert.ok(!before.warnings.includes('secret_page'), 'an ordinary page');
  const field = before.controls.find(item => item.inputId === 'live-key');
  assert.equal(field.sensitive, true);
  assert.match(before.text, /Invoice 4111 1111 1111 1112 \(not a card\)\. Order 1234567890123456\./, 'look-alikes stay');
  assert.match(before.text, /Card on file: \[secret:~[0-9a-z]+ card …4242 len 16\]/);
  assert.match(before.text, /Signing secret: \[secret:~[0-9a-z]+ stripe-webhook whsec_…/);
  const reveal = control(before, 'Reveal live key');
  const after = await bridge.execute({ type: 'click', target: reveal.id }, before.revision);
  noLeaks(after, 'execute result');
  assert.match(after.observation.text, /\[secret:~[0-9a-z]+ stripe sk_live_…1234 len 36\]/);
  // Expectation texts are matched against the redacted text: a guessed key is never "found".
  const probe = await bridge.observe(undefined, { expectText: [F.stripe.toLowerCase(), F.stripe.slice(0, 20).toLowerCase(), 'developers'] });
  assert.deepEqual(probe.textFound, ['developers']);
});

test('keys in pre, textarea and per-line elements: AWS, a private key, connection string and more', async t => {
  const bridge = await open(t, '/keys.html');
  const observation = await bridge.observe();
  noLeaks(observation, 'observation');
  assert.match(observation.text, /\[secret:~[0-9a-z]+ aws AKIA…7EXA len 20\],\[secret:~[0-9a-z]+ aws-secret …0KEY len 40\]/);
  assert.match(observation.text, /\[secret:~[0-9a-z]+ private-key\]/);
  assert.match(observation.text, /postgres:\/\/app:\[secret:~[0-9a-z]+ password\]@db\.example\.internal:5432\/app/);
  const textarea = observation.controls.find(item => item.inputId === 'pem');
  assert.equal(textarea?.sensitive, true, 'the textarea holding a private key is sensitive');
  for (const line of F.pemLines) assert.ok(!JSON.stringify(observation).includes(line.slice(10, 30)), 'no PEM line fragment');
});

test('an environment variable table: values go, names and non-secret values stay; Relaxed keeps known formats only', async t => {
  const bridge = await open(t, '/env/');
  const observation = await bridge.observe();
  noLeaks(observation, 'observation');
  assert.ok(observation.warnings.includes('secret_page'));
  for (const name of ['OPENAI_API_KEY', 'DATABASE_URL', 'SESSION_SECRET', 'SLACK_BOT_TOKEN', 'NEXT_PUBLIC_SITE_NAME', 'Acme Store']) {
    assert.ok(observation.text.includes(name), name);
  }
  const relaxed = await open(t, '/env/', { secrets: { relaxed: [site.origin] } });
  const loose = await relaxed.observe();
  assert.ok(!loose.warnings.includes('secret_page'), 'no secret page on a Relaxed origin');
  assert.deepEqual(leaks(loose).sort(), ['sessionSecret'], 'Relaxed: only the value without a known format shows');
});

test('account page: TOTP seed, recovery codes, a temporary password; a toggled password field stays a password field', async t => {
  const bridge = await open(t, '/account.html', NO_ASK);
  const before = await bridge.observe();
  noLeaks(before, 'observation');
  assert.ok(before.warnings.includes('secret_page'));
  assert.match(before.text, /setup key into your app: \[secret:~[0-9a-z]+ totp\]/);
  assert.equal((before.text.match(/recovery-code\]/g) ?? []).length, F.recovery.length);
  const toggle = control(before, 'Show password');
  const after = (await bridge.execute({ type: 'click', target: toggle.id }, before.revision)).observation;
  noLeaks(after, 'after the toggle');
  const field = after.controls.find(item => item.inputId === 'pw');
  assert.equal(await bridge.page.evaluate(() => document.getElementById('pw').type), 'text');
  assert.equal(field.type, 'password', 'reported as a password field');
  assert.equal(field.sensitive, true);
});

test('a same-origin frame, a shadow root and a key inserted after load; placeholders stable across documents', async t => {
  const bridge = await open(t, '/embedded.html');
  await bridge.page.waitForTimeout(200);
  const observation = await bridge.observe(undefined, { expectText: [F.xai.toLowerCase(), 'connected apps'] });
  noLeaks(observation, 'observation');
  assert.match(observation.text, /Your new key: \[secret:~[0-9a-z]+ xai xai-…/);
  assert.match(observation.text, /Shadow widget token: \[secret:~[0-9a-z]+ github ghp_…MNOP/);
  assert.match(observation.text, /API key: \[secret:~[0-9a-z]+ openai sk-…0123 len 39\]/, 'frame text');
  assert.deepEqual(observation.textFound, ['connected apps'], 'a guessed key is not found');
  // The same value on another document of the same lease gets the same tag.
  const tag = observation.text.match(/\[secret:~([0-9a-z]+) openai sk-…0123/)[1];
  const other = await open(t, '/api-keys/');
  const keys = await other.observe();
  assert.equal(keys.text.match(/\[secret:~([0-9a-z]+) openai sk-…0123/)[1], tag);
  // Another lease (another salt) tags it differently, so tags carry nothing across leases.
  const fresh = await open(t, '/api-keys/', { secrets: { salt: 'another-lease' } });
  assert.notEqual((await fresh.observe()).text.match(/\[secret:~([0-9a-z]+) openai sk-…0123/)[1], tag);
});

test('Strict mode redacts key-shaped values without context on an ordinary page', async t => {
  const standard = await (await open(t, '/billing.html')).observe();
  assert.ok(!standard.text.includes('[secret:~') || !/Order \[secret/.test(standard.text));
  const strict = await (await open(t, '/keys.html', { secrets: { mode: 'strict' } })).observe();
  noLeaks(strict, 'strict observation');
  assert.ok(!strict.warnings.includes('secret_page'), 'Strict is the user mode, not a page signal');
});
