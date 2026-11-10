// Secret redaction rules (src/secrets.js): the known formats, the generic and context rules, URL parameters, the
// secret-page signal and the placeholders; the daemon's scrub pass; the byte-identical rule block in the extension
// (drift check); and a false-positive sweep over the text of every other fixture page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import vm from 'node:vm';
import {
  findSecrets, redactText, redactUrl, scrubSecrets, scrubString, secretIds, secretPage, secretCard, secretKeyShaped,
} from '../src/secrets.js';
import { INSTRUCTIONS, TOOLS } from '../src/mcp.js';
import { leaks, loadFakes } from './helpers/secret-fakes.js';

const F = loadFakes();
const numbered = () => {
  let n = 0;
  const ids = new Map();
  return value => {
    if (!ids.has(value)) ids.set(value, ++n);
    return ids.get(value);
  };
};
const redact = (text, options = {}) => redactText(text, { id: numbered(), ...options });

test('every known format is redacted with its public prefix, last four and length', () => {
  const cases = [
    ['openai', F.openai, '[secret:1 openai sk-proj-…Yz56 len 64]'],
    ['openai legacy', F.openaiLegacy, '[secret:1 openai sk-…0123 len 39]'],
    ['anthropic', F.anthropic, /^\[secret:1 anthropic sk-ant-api03-…B6a5 len \d+\]$/],
    ['github', F.github, '[secret:1 github ghp_…IJkl len 40]'],
    ['github pat', F.githubPat, /^\[secret:1 github github_pat_…/],
    ['slack', F.slack, /^\[secret:1 slack xoxb-…uvwx len \d+\]$/],
    ['slack webhook', F.slackWebhook, /^\[secret:1 slack-webhook https:\/\/hooks\.slack\.com\/services\/…wxyz len \d+\]$/],
    ['aws id', F.awsId, '[secret:1 aws AKIA…7EXA len 20]'],
    ['google', F.google, '[secret:1 google AIza…pqrs len 39]'],
    ['google oauth', F.googleOauth, /^\[secret:1 google-oauth ya29\.…/],
    ['stripe', F.stripe, '[secret:1 stripe sk_live_…1234 len 36]'],
    ['stripe webhook', F.stripeWebhook, /^\[secret:1 stripe-webhook whsec_…/],
    ['npm', F.npm, '[secret:1 npm npm_…IJkl len 40]'],
    ['huggingface', F.huggingface, /^\[secret:1 huggingface hf_…/],
    ['xai', F.xai, /^\[secret:1 xai xai-…/],
    ['gitlab', F.gitlab, /^\[secret:1 gitlab glpat-…/],
    ['jwt', F.jwt, /^\[secret:1 jwt eyJ…efgh len \d+\]$/],
    ['card', F.card, '[secret:1 card …4242 len 16]'],
    ['pem', F.pem, '[secret:1 private-key]'],
  ];
  for (const [name, value, expected] of cases) {
    const out = redact(value);
    if (expected instanceof RegExp) assert.match(out, expected, name);
    else assert.equal(out, expected, name);
    assert.deepEqual(leaks(out), [], name);
  }
  // More formats, built from parts so no complete key-shaped literal sits in the repository.
  const more = {
    'gh oauth': ['gho', '_', 'FAKE0123456789abcdefghijABCDEFGHIJkl'],
    'xoxp': ['xox', 'p-', '1234-FAKE-5678abcdef90'],
    'asia': ['AS', 'IA', 'FAKE1234567890AB'],
    'gocspx': ['GOC', 'SPX-', 'FAKE0123456789abcdefghij'],
    'glptt': ['glp', 'tt-', 'FAKE0123456789abcdefgh'],
    'rk_test': ['rk_', 'test_', 'FAKE0123456789abcdef'],
    'pypi': ['pypi', '-AgEI', 'FAKE0123456789abcdefghij0123456789abcdefghij0123456789'],
    'groq': ['gsk', '_', 'FAKE0123456789abcdefghij0123456789abcdefgh'],
    'replicate': ['r8', '_', 'FAKE0123456789abcdefghij012345'],
    'sendgrid': ['SG', '.', 'FAKE0123456789ab', '.', 'cdefghij0123456789AB'],
    'digitalocean': ['dop', '_v1_', '0123456789abcdef'.repeat(4)],
    'shopify': ['shp', 'at_', '0123456789abcdef'.repeat(2)],
    'linear': ['lin', '_api_', 'FAKE0123456789', 'abcdefghij0123456789abcdef'],
    'postman': ['PMAK', '-', '0123456789abcdef01234567', '-', '0123456789abcdef0123456789abcdef01'],
    'supabase': ['sbp', '_', '0123456789abcdef0123456789abcdef01234567'],
    'atlassian': ['ATA', 'TT', 'FAKE0123456789abcdefghij0123456789abcdefghij0123456789'],
    'admin key': ['sk-', 'admin-', 'FAKE0123456789abcdefghij'],
    'svcacct': ['sk-', 'svcacct-', 'FAKE0123456789abcdefghij'],
    'discord': ['https://discord.com/api/', 'webhooks/', '123456789012345678/', 'FAKE0123456789abcdefghij0123456789'],
  };
  for (const [name, parts] of Object.entries(more)) {
    const value = parts.join('');
    const out = redact(`value ${value} end`);
    assert.ok(!out.includes(value) && out.includes('[secret:1'), `${name}: ${out}`);
  }
  // An AWS secret access key right after its key id.
  assert.equal(redact(`${F.awsId},${F.awsSecret}`), '[secret:1 aws AKIA…7EXA len 20],[secret:2 aws-secret …0KEY len 40]');
  // A connection string keeps its scheme, user and host.
  assert.equal(redact(F.dbUrl), 'postgres://app:[secret:1 password]@db.example.internal:5432/app');
});

test('context rules: generic keys, TOTP seeds, recovery codes, environment rows and passwords', () => {
  assert.equal(redact(`API key: ${F.genericKey}`), 'API key: [secret:1]');
  assert.equal(redact(`Authorization: Bearer ${F.genericKey}`), 'Authorization: Bearer [secret:1]');
  assert.equal(redact(F.genericKey), F.genericKey, 'no context: kept');
  assert.equal(redact(F.genericKey, { context: 'Secret key' }), '[secret:1]', 'a label passed by the caller counts');
  assert.equal(redact(F.genericKey, { strict: true }), '[secret:1]', 'strict needs no context');
  assert.equal(redact(`API key: ${F.genericKey}`, { relaxed: true }), `API key: ${F.genericKey}`, 'relaxed: known formats only');
  assert.equal(redact(`Enter this setup key: ${F.totp}`), 'Enter this setup key: [secret:1 totp]');
  assert.equal(redact(`Seats: ${F.totp}`), `Seats: ${F.totp}`, 'base32 without authenticator wording is kept');
  assert.equal(redact(`Recovery codes\n${F.recovery.join('\n')}`),
    'Recovery codes\n[secret:1 recovery-code]\n[secret:2 recovery-code]\n[secret:3 recovery-code]\n[secret:4 recovery-code]');
  assert.equal(redact('Backup codes: 1234 5678, 2345 6789'), 'Backup codes: [secret:1 recovery-code], [secret:2 recovery-code]');
  assert.equal(redact(`SESSION_SECRET=${F.sessionSecret}`), 'SESSION_SECRET=[secret:1]');
  assert.equal(redact(`SESSION_SECRET | ${F.sessionSecret} | Production`), 'SESSION_SECRET | [secret:1] | Production');
  assert.equal(redact('DATABASE_URL | Production, Preview'), 'DATABASE_URL | Production, Preview', 'a word is no value');
  assert.equal(redact('API_KEY ••••••••'), 'API_KEY ••••••••');
  assert.equal(redact('NEXT_PUBLIC_SITE_NAME=acme-store-2024'), 'NEXT_PUBLIC_SITE_NAME=acme-store-2024');
  assert.equal(redact(`Temporary password: ${F.password}`), 'Temporary password: [secret:1 password]');
  assert.equal(redact('Password: ••••••••'), 'Password: ••••••••');
  assert.equal(redact('Forgot password? Reset it'), 'Forgot password? Reset it');
});

test('URLs: signed and secret parameters lose their values, origin, path and other parameters stay', () => {
  const url = `https://app.example.com/cb?state=xyz&code=4%2F0AfJohXnFAKE123abc&page=2#access_token=${F.googleOauth}&id_token=${F.jwt}`;
  const out = redactUrl(url, { id: numbered() });
  assert.equal(new URL(out).origin, 'https://app.example.com');
  assert.equal(new URL(out).pathname, '/cb');
  assert.match(out, /\?state=xyz&code=\[secret:1 param\]&page=2#access_token=\[secret:2 google-oauth ya29\.…/);
  assert.deepEqual(leaks(out), []);
  const signed = redactUrl('https://bucket.s3.amazonaws.com/f.pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=FAKE1234%2F20261106&X-Amz-Signature=0123456789abcdef0123456789abcdef', { id: numbered() });
  assert.equal(signed, 'https://bucket.s3.amazonaws.com/f.pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=[secret:1 param]&X-Amz-Signature=[secret:2 param]');
  assert.equal(redactUrl('https://shop.example/search?q=tents&sort=price&page=3'), 'https://shop.example/search?q=tents&sort=price&page=3');
  assert.equal(redactUrl('https://user:hunter2FAKE@host.example/x', { id: numbered() }), 'https://user:[secret:1 password]@host.example/x');
  assert.equal(redactUrl('https://shop.example/a?key=ab'), 'https://shop.example/a?key=ab', 'a short value is no secret');
});

test('false positives: hashes, ids, order and tracking numbers, images, CSS hashes and paths stay outside secret context', () => {
  const kept = [
    'commit 3f2a9c1d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39 deployed',
    'sha 9c8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f3e2d1c0b',
    'Request 123e4567-e89b-12d3-a456-426614174000',
    'Order #112-1234567-1234567 shipped',
    'Order 1234567890123456 total $41.99',
    'Invoice 4111 1111 1111 1112',
    'Tracking 1Z999AA10123456784',
    'Phone +1 415 555 0134, ISBN 978-3-16-148410-0',
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'integrity sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=',
    'class css-1q2w3e4r5t6y7u8i9o0p and MuiButton-root-123abc',
    'screenshot-2024-01-01-at-10-30-00.png',
    '/docs/guides/deployment/step-2-configure-the-cluster',
    'https://shop.example/catalog/tents/ultralight-2-person-tent-2024?ref=home',
    'sk-learn-tutorial-intro-guide and sk-',
    'Timestamp 1730851200000, build 20261106.3',
    'Press any key to continue',
    'The token count is 12345 for model gpt-4o-2024-08-06',
  ];
  for (const text of kept) assert.equal(redact(text), text, text);
  // With context, the same shapes are redacted (they may be keys).
  assert.match(redact('API key: 123e4567-e89b-12d3-a456-426614174000'), /\[secret:1\]/);
  assert.equal(secretCard('4242 4242 4242 4242'), true);
  assert.equal(secretCard('4242-4242-4242-4241'), false, 'Luhn');
  assert.equal(secretCard('1234 5678 9012 3452'), false, 'no card network');
  assert.equal(secretCard('42424 24242 424242'), false, 'not card grouping');
  assert.equal(secretKeyShaped('aaaaaaaaaaaaaaaaaaaa1'), false, 'low entropy');
});

test('secret pages: paths and top headings', () => {
  for (const path of ['/settings/tokens', '/settings/tokens/new', '/api-keys/', '/account/apikeys', '/org/credentials',
    '/settings/security', '/2fa', '/mfa/setup', '/totp', '/recovery', '/settings/personal_access_tokens',
    '/iam/service-accounts', '/repo/settings/webhooks']) assert.equal(secretPage(path), true, path);
  for (const path of ['/', '/tokens-of-appreciation', '/blog/security-tips-2024', '/catalog/keys', '/settings/profile']) {
    assert.equal(secretPage(path), false, path);
  }
  assert.equal(secretPage('/x', ['Welcome', 'API keys']), true);
  assert.equal(secretPage('/x', ['Environment Variables']), true);
  assert.equal(secretPage('/x', ['Recovery codes']), true);
  assert.equal(secretPage('/x', ['Our keyboard collection']), false);
});

test('placeholders are idempotent: a second pass leaves them as they are', () => {
  const once = redact(`${F.openai} API key: ${F.genericKey} ${F.card} ${F.dbUrl} ?token=${F.jwt}`);
  assert.equal(redact(once), once);
  assert.equal(redact(once, { strict: true }), once);
  assert.deepEqual(leaks(once), []);
});

test('scrubSecrets: numbers page tags per runtime, leaves images and protocol fields alone, never mutates', () => {
  const ids = secretIds();
  const input = {
    revision: 'doc:1',
    documentId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    text: `Key [secret:~k1 openai sk-proj-…Yz56 len 64] and ${F.github}`,
    controls: [{ id: '1', label: `Copy [secret:~k2]` }],
    content: [{ type: 'image', data: Buffer.from(F.awsId).toString('base64'), mimeType: 'image/jpeg' }],
    dataUrl: 'data:image/jpeg;base64,AAAA',
    nested: { list: [F.stripe, 7, null, true] },
  };
  const frozen = structuredClone(input);
  const out = scrubSecrets(input, ids);
  assert.deepEqual(input, frozen, 'input unchanged');
  assert.equal(out.revision, 'doc:1');
  assert.equal(out.text, 'Key [secret:1 openai sk-proj-…Yz56 len 64] and [secret:d1 github ghp_…IJkl len 40]');
  assert.equal(out.controls[0].label, 'Copy [secret:2]');
  assert.equal(out.content, input.content, 'image block untouched');
  assert.equal(out.nested.list[0], '[secret:d2 stripe sk_live_…1234 len 36]');
  assert.equal(scrubSecrets({ text: 'tag [secret:~k2]' }, ids).text, 'tag [secret:2]', 'stable per runtime');
  const plain = { a: 'nothing here', b: [1, 2] };
  assert.equal(scrubSecrets(plain, ids), plain, 'unchanged values keep their reference');
  assert.equal(scrubString(`x ${F.github}`, ids), 'x [secret:d1 github ghp_…IJkl len 40]');
});

test('the leak scanner finds a fake raw, URL-encoded, base64-encoded and by a chunk of its middle', () => {
  assert.deepEqual(leaks(`x ${F.openai} y`), ['openai']);
  assert.deepEqual(leaks(encodeURIComponent(F.awsSecret)), ['awsSecret']);
  assert.deepEqual(leaks(Buffer.from(F.stripe).toString('base64')), ['stripe']);
  assert.ok(leaks(F.github.slice(10, 30)).includes('github'), 'fakes share pieces: a chunk may name several');
  assert.deepEqual(leaks({ nested: [F.recovery[2]] }), ['recovery[2]']);
  assert.deepEqual(leaks('4242424242424242'), ['card']);
});

test('the MCP instructions and tool definitions pass the scrub unchanged', () => {
  assert.equal(scrubSecrets(TOOLS), TOOLS);
  assert.equal(scrubSecrets(INSTRUCTIONS), INSTRUCTIONS);
});

// ---------------------------------------------------------------------------------------------------------------
// Drift check: the rule block is byte-identical in the extension.
// ---------------------------------------------------------------------------------------------------------------

const readText = path => readFileSync(new URL(path, import.meta.url), 'utf8');
function ruleBlock(text, indent = '') {
  const start = text.indexOf(`${indent}// <secret-rules>`);
  const end = text.indexOf('// </secret-rules>');
  assert.ok(start >= 0 && end > start, 'the file carries the <secret-rules> block');
  return text.slice(start, end).split('\n').map(line => (line.startsWith(indent) ? line.slice(indent.length) : line)).join('\n');
}

test('the secret rule block is identical in src/secrets.js, extension/background.js and extension/page.js', () => {
  const canonical = ruleBlock(readText('../src/secrets.js'));
  assert.equal(ruleBlock(readText('../extension/background.js')), canonical);
  assert.equal(ruleBlock(readText('../extension/page.js'), '  '), canonical);
  // Behavioural check on the copy, evaluated on its own as a classic script (the worker's form).
  const copy = vm.runInNewContext(`${canonical}; ({ secretRedactText, secretPageSignal })`);
  const sample = `API key: ${F.genericKey} ${F.openai} ${F.card} https://x.example/a?token=${F.jwt}`;
  assert.equal(copy.secretRedactText(sample, { salt: 's' }), redactText(sample, { salt: 's' }));
  assert.match(copy.secretRedactText(F.github, { salt: 's' }), /^\[secret:~[0-9a-z]+ github ghp_…IJkl len 40\]$/);
});

// ---------------------------------------------------------------------------------------------------------------
// False-positive sweep: the text of every other fixture page, as the generic rules see it.
// ---------------------------------------------------------------------------------------------------------------

const FIXTURES = new URL('../fixtures/', import.meta.url).pathname;
function htmlFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (relative(FIXTURES, path) !== 'secrets') out.push(...htmlFiles(path));
    } else if (name.endsWith('.html')) out.push(path);
  }
  return out;
}
const pageText = html => html.replace(/<(script|style|template)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, '\n')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\n\s*\n+/g, '\n');

test('false-positive sweep: no redaction in the text and links of the other fixture pages', () => {
  const hits = [];
  const files = htmlFiles(FIXTURES);
  assert.ok(files.length > 150, `${files.length} fixture pages`);
  for (const file of files) {
    const html = readFileSync(file, 'utf8');
    const path = `/${relative(FIXTURES, file)}`;
    const headings = [...html.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)].map(match => match[1].replace(/<[^>]+>/g, '').trim());
    const strict = secretPage(path, headings);
    const strings = [pageText(html), ...[...html.matchAll(/href="([^"]+)"/g)].map(match => match[1])];
    for (const text of strings) {
      for (const span of findSecrets(text, { strict })) {
        hits.push(`${path}${strict ? ' (secret page)' : ''}: ${span.kind} ${JSON.stringify(text.slice(span.start, span.end))}`);
      }
    }
  }
  assert.deepEqual(hits, []);
});
