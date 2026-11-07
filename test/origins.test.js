// Domain roots ("https://*.example.com" in `origins`): the one matcher in src/origins.js (exact vs root, the embedded
// public-suffix handling, invalid roots), its copies in the extension (drift check), link admission, cross_origin for a
// sibling subdomain vs another registrable domain, the daemon's lease scope (`domain` vs `origin`) and receipts'
// `permissions.scope`, allowedUrls, and site-profile attachment through a root.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkOriginEntry, describeEntry, entryCovered, exactOrigin, isSiteEntry, leaseOrigins, originCovered,
  registrableDomain, sameSite, siteEntryFor, sitePattern, sitePatterns, siteRoot, urlCovered,
} from '../src/origins.js';
import * as popupSide from '../extension/permissions.js';
import { PSL_RULES, PSL_VERSION } from '../src/psl-data.js';
import { VENDORED, parsePsl, renderModule, renderScript } from '../scripts/update-psl.mjs';
import { BrowserRuntime, legalActions } from '../src/runtime.js';
import { createDaemon } from '../src/daemon.js';
import { createCompanion } from '../bench/companion.js';
import { createDomainStore } from '../src/domains.js';
import { createLogger, homePaths } from '../src/home.js';
import { FakeBridge, clickProvider } from './runtime-fixtures.js';
import { call, createFakeHub } from './helpers/fake-hub.js';

const ROOT = 'https://*.example.org';
const DEV = 'https://developer.example.org';
const WWW = 'https://www.example.org';

// --- the matcher ---------------------------------------------------------------------------------------------------

test('a domain root covers the registrable domain and every https subdomain on the default port, nothing else', () => {
  const entries = [ROOT];
  for (const origin of [DEV, WWW, 'https://example.org', 'https://a.b.c.example.org']) {
    assert.equal(originCovered(origin, entries), true, origin);
  }
  for (const origin of ['http://developer.example.org', 'https://developer.example.org:8443', 'https://evilexample.org',
    'https://example.org.evil.test', 'https://example.net', 'https://developer.example.org.', 'https://*.example.org',
    'https://xn--example-org.test', '', null, 42]) {
    assert.equal(originCovered(origin, entries), false, String(origin));
  }
  assert.equal(urlCovered('https://www.example.org/team?x=1#y', entries), true);
  assert.equal(urlCovered('not a url', entries), false);
});

test('exact entries keep exact semantics: scheme, host and port must match', () => {
  const entries = [DEV, 'http://localhost:3000'];
  assert.equal(originCovered(DEV, entries), true);
  assert.equal(originCovered(WWW, entries), false, 'a sibling subdomain is not covered by an exact origin');
  assert.equal(originCovered('https://example.org', entries), false);
  assert.equal(originCovered('http://localhost:3000', entries), true);
  assert.equal(originCovered('http://localhost:3001', entries), false);
  assert.equal(siteRoot(DEV), null);
  assert.equal(isSiteEntry(DEV), false);
  assert.equal(exactOrigin('https://*.example.org'), null, 'a wildcard is never an exact origin');
});

test('roots must be registrable: bare TLDs, multi-label public suffixes and shared hosting suffixes are refused', () => {
  for (const entry of ['https://*.com', 'https://*.uk', 'https://*.co.uk', 'https://*.org.uk', 'https://*.ltd.uk',
    'https://*.com.au', 'https://*.co.jp', 'https://*.ne.jp', 'https://*.or.kr', 'https://*.gob.mx', 'https://*.co.nz',
    'https://*.github.io', 'https://*.pages.dev', 'https://*.vercel.app', 'https://*.herokuapp.com',
    'https://*.blogspot.com', 'https://*.s3.amazonaws.com', 'https://*.amazonaws.com', 'https://*.appspot.com',
    // Security review: private and wildcard suffixes, multi-tenant providers, unknown TLDs.
    'https://*.us-east-1.amazonaws.com', 'https://*.s3.us-east-1.amazonaws.com', 'https://*.elb.amazonaws.com',
    'https://*.r.appspot.com', 'https://*.on.aws', 'https://*.windows.net', 'https://*.blob.core.windows.net',
    'https://*.azure.com', 'https://*.cloudapp.azure.com', 'https://*.azureedge.net', 'https://*.blogspot.de',
    'https://*.eu.org', 'https://*.us.com', 'https://*.uk.com', 'https://*.app.github.dev', 'https://*.hf.space',
    'https://*.streamlit.app', 'https://*.ondigitalocean.app', 'https://*.amplifyapp.com', 'https://*.gitpod.io',
    'https://*.ddns.net', 'https://*.tokyo.jp', 'https://*.ny.us', 'https://*.blog.br', 'https://*.foo.localhost',
    'https://*.localhost', 'https://*.example', 'https://*.site.test', 'https://*.kawasaki.jp', 'https://*.x.kawasaki.jp',
    'https://*.x.ck', 'https://*.gov.uk', 'https://*.service.gov.uk',
    // Multi-tenant hosts the list does not cover (fail-closed overlay).
    'https://*.wordpress.com', 'https://*.glitch.me', 'https://*.firebaseio.com', 'https://*.neocities.org',
    'https://*.loca.lt', 'https://*.stackblitz.io', 'https://*.sourceforge.io', 'https://*.tumblr.com',
    'https://*.substack.com', 'https://*.weebly.com', 'https://*.000webhostapp.com', 'https://*.codesandbox.io',
    'https://*.foo.wordpress.com']) {
    assert.equal(siteRoot(entry), null, entry);
    assert.match(checkOriginEntry(entry).error, /Not a registrable domain/, entry);
  }
  for (const [entry, root] of [['https://*.bbc.co.uk', 'bbc.co.uk'], ['https://*.example.com.au', 'example.com.au'],
    ['https://*.alice.github.io', 'alice.github.io'], ['https://*.docs.example.org', 'docs.example.org'],
    ['https://*.xn--bcher-kva.de', 'xn--bcher-kva.de'], ['https://*.web.de', 'web.de'],
    // Under a private suffix, one tenant; an exception rule; a deeper name under a registrable domain.
    ['https://*.myapp.vercel.app', 'myapp.vercel.app'], ['https://*.city.kawasaki.jp', 'city.kawasaki.jp'],
    ['https://*.www.ck', 'www.ck'], ['https://*.foo.alice.github.io', 'foo.alice.github.io']]) {
    assert.equal(siteRoot(entry), root, entry);
    assert.deepEqual(checkOriginEntry(entry), { entry, root });
  }
});

test('malformed roots are refused with plain words; exact origins are validated as before', () => {
  assert.match(checkOriginEntry('http://*.example.org').error, /https only.*https:\/\/\*\.example\.org/);
  for (const entry of ['https://*.Example.org', 'https://*.example.org/', 'https://*.example.org:443',
    'https://*.example.org/*', 'https://*', 'https://*.', 'https://**.example.org', 'https://a.*.example.org',
    'https://*example.org', '*.example.org', 'https://*.1.2.3.4', 'https://*.[::1]', 'https://*.exa mple.org',
    'https://*.-bad.org', 'https://*.example.org.']) {
    assert.ok(checkOriginEntry(entry).error, entry);
    assert.equal(siteRoot(entry), null, entry);
  }
  assert.deepEqual(checkOriginEntry(DEV), { entry: DEV });
  assert.match(checkOriginEntry('https://example.org/path').error, /Not an exact http\(s\) origin/);
  assert.match(checkOriginEntry(42).error, /Not an exact/);
});

test('sameSite: a link stays on the site when it is the same origin or shares an approved root', () => {
  assert.equal(sameSite(`${DEV}/a`, `${WWW}/b`, [ROOT]), true);
  assert.equal(sameSite(`${DEV}/a`, `${DEV}/b`, [DEV]), true);
  assert.equal(sameSite(`${DEV}/a`, `${WWW}/b`, [DEV, WWW]), false, 'two exact origins never link to each other');
  assert.equal(sameSite(`${DEV}/a`, 'https://example.net/', [ROOT, 'https://example.net']), false);
  assert.equal(sameSite('https://app.example.net/', `${WWW}/`, ['https://app.example.net', ROOT]), false,
    'an exact origin does not link into a root it is not under');
  assert.equal(sameSite(`${DEV}/a`, 'http://www.example.org/', [ROOT]), false);
});

test('lease origins: domain scope keeps the roots; origin scope narrows a root to the tab origin', () => {
  const entries = [ROOT, 'https://app.example.net'];
  assert.deepEqual(leaseOrigins(entries, DEV, 'domain'), entries);
  assert.deepEqual(leaseOrigins(entries, DEV, 'origin'), ['https://app.example.net', DEV]);
  assert.deepEqual(leaseOrigins(entries, 'https://app.example.net', 'origin'), ['https://app.example.net']);
  assert.deepEqual(leaseOrigins([DEV], DEV, 'domain'), [DEV], 'no root: nothing to widen');
  assert.deepEqual(leaseOrigins([ROOT], 'https://example.net', 'origin'), [], 'an uncovered tab origin is never added');
});

test('entryCovered (request reuse), registrable domains, suggestions and plain words', () => {
  assert.equal(entryCovered(DEV, [ROOT]), true);
  assert.equal(entryCovered('https://*.docs.example.org', [ROOT]), true, 'a narrower root');
  assert.equal(entryCovered(ROOT, ['https://*.docs.example.org']), false, 'a broader root is a new request');
  assert.equal(entryCovered(ROOT, [DEV]), false);
  assert.equal(registrableDomain('developer.example.org'), 'example.org');
  assert.equal(registrableDomain('news.bbc.co.uk'), 'bbc.co.uk');
  assert.equal(registrableDomain('x.alice.github.io'), 'alice.github.io');
  assert.equal(registrableDomain('a.b.city.kawasaki.jp'), 'city.kawasaki.jp', 'exception rule');
  assert.equal(registrableDomain('a.b.x.kawasaki.jp'), 'b.x.kawasaki.jp', 'wildcard rule');
  for (const host of ['co.uk', 'localhost', '127.0.0.1', 'github.io', 'Example.org', 'example.org.', 'bucket.s3.amazonaws.com',
    'vm1.westeurope.cloudapp.azure.com', 'x.blogspot.de', 'a.foo.localhost', 'workspace-1.app.github.dev']) {
    assert.equal(registrableDomain(host), null, host);
  }
  assert.equal(siteEntryFor(DEV), ROOT);
  for (const origin of ['https://foo.wordpress.com', 'https://me.substack.com', 'https://x.tumblr.com', 'https://a.glitch.me']) {
    assert.equal(siteEntryFor(origin), null, `${origin}: the exact origin is suggested, never a root`);
  }
  assert.equal(siteEntryFor('http://developer.example.org'), null, 'roots are https only');
  assert.equal(sitePattern('example.org'), 'https://*.example.org/*');
  assert.deepEqual(sitePatterns([DEV, ROOT]), ['https://*.example.org/*']);
  assert.equal(describeEntry(ROOT), 'all of example.org');
  assert.equal(describeEntry(DEV), DEV);
});

// --- drift: one block, three copies ---------------------------------------------------------------------------------

const block = text => {
  const start = text.indexOf('// <site-match>');
  const end = text.indexOf('// </site-match>');
  assert.ok(start >= 0 && end > start, 'the file carries the <site-match> block');
  return text.slice(start, end);
};

test('the site-match block is identical in src/origins.js, extension/permissions.js and extension/background.js', async () => {
  const read = path => readFile(new URL(path, import.meta.url), 'utf8');
  const canonical = block(await read('../src/origins.js'));
  assert.equal(block(await read('../extension/permissions.js')), canonical);
  assert.equal(block(await read('../extension/background.js')), canonical);
  // Behavioural check on the worker's copy, evaluated on its own as a classic script with the extension's data file.
  const data = await read('../extension/psl-data.js');
  const worker = vm.runInNewContext(`${data}; const PSL_RULES = globalThis.FAI_PSL_RULES; ${canonical};
    ({ siteRoot, originCovered, sitePattern })`);
  for (const entry of [ROOT, 'https://*.co.uk', 'http://*.example.org', 'https://*.alice.github.io', DEV,
    'https://*.azure.com', 'https://*.city.kawasaki.jp', 'https://*.x.kawasaki.jp', 'https://*.foo.localhost']) {
    assert.equal(worker.siteRoot(entry), siteRoot(entry), entry);
    assert.equal(popupSide.siteRoot(entry), siteRoot(entry), entry);
  }
  for (const origin of [DEV, 'https://example.net', 'http://www.example.org', 'https://evilexample.org']) {
    assert.equal(worker.originCovered(origin, [ROOT]), originCovered(origin, [ROOT]), origin);
    assert.equal(popupSide.originCovered(origin, [ROOT]), originCovered(origin, [ROOT]), origin);
  }
  assert.equal(worker.sitePattern('example.org'), 'https://*.example.org/*');
});

test('the embedded Public Suffix List: both generated files carry the vendored list, unedited', async () => {
  const vendored = parsePsl(await readFile(VENDORED, 'utf8'));
  assert.equal(PSL_VERSION, vendored.version);
  assert.equal(PSL_RULES, vendored.rules.join('\n'));
  assert.ok(vendored.rules.length > 9000, `${vendored.rules.length} rules`);
  assert.equal(await readFile(new URL('../src/psl-data.js', import.meta.url), 'utf8'), renderModule(vendored));
  assert.equal(await readFile(new URL('../extension/psl-data.js', import.meta.url), 'utf8'), renderScript(vendored));
  for (const rule of ['com', 'co.uk', 'github.io', '*.kawasaki.jp', '!city.kawasaki.jp', '*.ck', '!www.ck']) {
    assert.ok(vendored.rules.includes(rule), rule);
  }
  assert.throws(() => parsePsl('com\nnet\n'), /ICANN and PRIVATE/);
});

// --- runtime: link admission and cross_origin ----------------------------------------------------------------------

const link = (id, label, href) => ({ id, role: 'link', label, href, enabled: true, risk: 'navigation' });
const SITE = {
  '/': {
    url: `${DEV}/`, title: 'Developer docs', text: 'Docs home',
    controls: [link('1', 'Team', `${WWW}/team`), link('2', 'Elsewhere', 'https://example.net/x'),
      link('3', 'Plain http', 'http://www.example.org/old'), link('4', 'Guide', `${DEV}/guide`)],
  },
  '/team': { url: `${WWW}/team`, title: 'Team', text: 'Ada and Grace run the team', controls: [] },
  '/guide': { url: `${DEV}/guide`, title: 'Guide', text: 'Guide', controls: [] },
  '/x': { url: 'https://example.net/x', title: 'Elsewhere', text: 'Another site', controls: [] },
};
const observation = path => new FakeBridge({ pages: SITE, path }).observation;
const labels = (obs, options) => legalActions(obs, options).filter(action => action.type === 'click').map(action => action.label);

test('legalActions offers a sibling-subdomain link only under an approved root; never another domain or http', () => {
  assert.deepEqual(labels(observation('/'), { allowedOrigins: [ROOT] }), ['Team', 'Guide']);
  assert.deepEqual(labels(observation('/'), { allowedOrigins: [DEV] }), ['Guide']);
  assert.deepEqual(labels(observation('/'), { allowedOrigins: [DEV, WWW] }), ['Guide'], 'exact origins stay separate');
  assert.deepEqual(labels(observation('/'), { allowedOrigins: [ROOT, 'https://example.net'] }), ['Team', 'Guide']);
  const urls = legalActions(observation('/'), { allowedOrigins: [ROOT], allowedUrls: [`${WWW}/team`, 'https://example.net/x'] })
    .filter(action => action.type === 'navigate_allowed_url').map(action => action.url);
  assert.deepEqual(urls, [`${WWW}/team`]);
});

function siteRun(allowedOrigins, labelsToClick, path = '/') {
  const bridge = new FakeBridge({ pages: SITE, path });
  const runtime = new BrowserRuntime({ bridge, provider: clickProvider(labelsToClick, { fallback: 'done' }) });
  return { bridge, run: (instruction, options) => runtime.run(instruction, { allowedOrigins, ...options }) };
}

test('a run under a root follows a link to another subdomain and reports permissions.scope domain', async () => {
  const { run } = siteRun([ROOT], ['Team']);
  const result = await run('Open Team. Read who runs the team.', { expectation: { urlIncludes: '/team' } });
  assert.equal(result.status, 'completed', JSON.stringify(result.needs ?? result.code));
  assert.equal(result.page.url, `${WWW}/team`);
  assert.equal(result.permissions.scope, 'domain');
});

test('a sibling subdomain is cross_origin under an exact origin, with the root suggested; another domain always is', async () => {
  const exact = await siteRun([DEV], [], '/team').run('Read the team', {});
  assert.equal(exact.code, 'cross_origin');
  assert.match(exact.needs.message, /https:\/\/\*\.example\.org in origins/);
  assert.ok(exact.verdict.why.includes(`origin:${WWW}`), JSON.stringify(exact.verdict.why));
  assert.equal(exact.permissions.scope, 'origin');

  // A provider suffix the list does not cover: the exact origin is suggested, never a root over every tenant.
  const AZURE = { '/': { url: 'https://vm2.westeurope.cloudapp.azure.com/', title: 'VM', text: 'x', controls: [] } };
  const azure = await new BrowserRuntime({ bridge: new FakeBridge({ pages: AZURE }), provider: clickProvider([]) })
    .run('Read it', { allowedOrigins: ['https://vm1.westeurope.cloudapp.azure.com'] });
  assert.equal(azure.code, 'cross_origin');
  assert.match(azure.needs.message, /https:\/\/vm2\.westeurope\.cloudapp\.azure\.com added to origins/);
  assert.doesNotMatch(azure.needs.message, /\*\./);

  const other = await siteRun([ROOT], [], '/x').run('Read it', {});
  assert.equal(other.code, 'cross_origin');
  assert.match(other.needs.message, /https:\/\/example\.net added to origins/);
  assert.doesNotMatch(other.needs.message, /\*\.example\.org/);
});

// --- daemon: requests, lease scope, receipts ----------------------------------------------------------------------

async function daemonSetup(t) {
  const home = await mkdtemp(join(tmpdir(), 'fai-origins-daemon-'));
  const hub = createFakeHub({ bridgeOptions: { pages: SITE, path: '/' } });
  const env = { TYPESAFE_API_KEY: 'jev-test-key' };
  const log = createLogger(homePaths({ home, env }));
  const daemon = createDaemon({ driver: 'jev', home, env, port: 0, hub, log, sweepIntervalMs: 60_000, warm: false,
    providerFactory: () => clickProvider(['Team'], { fallback: 'done' }) });
  await daemon.listen();
  t.after(async () => {
    await daemon.close();
    log.close();
    await rm(home, { recursive: true, force: true });
  });
  const api = (method, path, body) => call(daemon.port, method, path, body, { token: daemon.token });
  const request = async (origins, extra = {}) => {
    const response = await api('POST', '/v1/requests', { origins, reason: 'Domain roots', ...extra });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body.requestId;
  };
  return { hub, daemon, api, request };
}

test('daemon: origins accept a domain root; public suffixes, http roots and paths are refused before any request', async t => {
  const ctx = await daemonSetup(t);
  const id = await ctx.request([ROOT, 'https://app.example.net']);
  assert.deepEqual(ctx.daemon.request(id).origins, [ROOT, 'https://app.example.net']);
  for (const [origins, pattern] of [[['https://*.co.uk'], /public suffix/], [['http://*.example.org'], /https only/],
    [['https://*.example.org/'], /Not a domain root/], [['https://*.github.io'], /public suffix/]]) {
    const response = await ctx.api('POST', '/v1/requests', { origins, reason: 'x' });
    assert.equal(response.status, 400, JSON.stringify(origins));
    assert.match(JSON.stringify(response.body), pattern);
  }
});

test('daemon: a domain-scope lease keeps the root; a run crosses subdomains; the receipt says scope domain', async t => {
  const ctx = await daemonSetup(t);
  const id = await ctx.request([ROOT]);
  const reply = await ctx.hub.approve(id, { origin: DEV, level: 'read-only', scope: 'domain', tabMode: 'single' });
  assert.deepEqual(reply.origins, [ROOT]);
  assert.equal(reply.grant.scope, 'domain');
  assert.deepEqual(ctx.hub.bound.at(-1).allowedOrigins, [ROOT]);
  const view = (await ctx.api('GET', `/v1/requests/${id}`)).body;
  assert.deepEqual((view.request ?? view).lease.origins, [ROOT]);
  const run = await ctx.api('POST', '/v1/runs', { requestId: id, instruction: 'Open Team. Read who runs the team.',
    expectation: { urlIncludes: '/team' }, waitMs: 5000 });
  const result = run.body.result;
  assert.equal(result.status, 'completed', JSON.stringify(result.needs ?? result.code));
  assert.deepEqual(result.permissions, { requested: 'read-only', granted: 'read-only', effective: 'read-only',
    testing: false, scope: 'domain', tabMode: 'single' });
  // allowedUrls on another subdomain of the root are accepted with domain scope.
  const urls = await ctx.api('POST', '/v1/runs', { requestId: id, instruction: 'Open the team page',
    allowedUrls: [`${WWW}/team`], waitMs: 5000 });
  assert.notEqual(urls.status, 422, JSON.stringify(urls.body));
});

test('daemon: an origin-scope lease narrows the root to the tab origin; a sibling subdomain is then cross_origin', async t => {
  const ctx = await daemonSetup(t);
  const id = await ctx.request([ROOT]);
  // The user picked "Only <origin>" or declined Chrome's prompt; an older extension sends no scope at all.
  for (const scope of ['origin', undefined]) {
    const reply = await ctx.hub.approve(scope ? id : await ctx.request([ROOT]), { origin: DEV, level: 'read-only', scope });
    assert.deepEqual(reply.origins, [DEV]);
    assert.equal(reply.grant.scope, 'origin');
  }
  assert.deepEqual(ctx.hub.bound.at(-1).allowedOrigins, [DEV]);
  const latest = ctx.hub.bound.at(-1).requestId;
  const refused = await ctx.api('POST', '/v1/runs', { requestId: latest, instruction: 'Open the team page',
    allowedUrls: [`${WWW}/team`], waitMs: 5000 });
  assert.equal(refused.status, 422);
  assert.equal(refused.body.code ?? refused.body.error?.code, 'origin_not_granted');
  const run = await ctx.api('POST', '/v1/runs', { requestId: latest, instruction: 'Open Team. Read who runs the team.',
    expectation: { urlIncludes: '/team' }, waitMs: 5000 });
  assert.notEqual(run.body.result.status, 'completed', 'the Team link is not offered under origin scope');
  assert.equal(run.body.result.permissions.scope, 'origin');
});

test('daemon: a tab outside the root is not approved; a domain scope on an exact request stays origin', async t => {
  const ctx = await daemonSetup(t);
  const id = await ctx.request([ROOT]);
  const refused = await ctx.hub.approve(id, { origin: 'https://example.net', level: 'read-only', scope: 'domain', tabMode: 'single' });
  assert.equal(refused.error.code, 'origin_not_requested');
  const exact = await ctx.request([DEV]);
  const reply = await ctx.hub.approve(exact, { origin: DEV, level: 'read-only', scope: 'domain', tabMode: 'single' });
  assert.equal(reply.grant.scope, 'origin', 'nothing to widen without a root');
  assert.deepEqual(reply.origins, [DEV]);
  const pending = await ctx.request([ROOT]);
  const blocked = await ctx.api('POST', '/v1/runs', { requestId: pending, instruction: 'x', operation: 'step', waitMs: 100 });
  assert.equal(blocked.body.result.permissions.scope, undefined, 'no scope before approval');
});

test('daemon: re-approving the active lease can change its scope; the hub lease follows', async t => {
  const ctx = await daemonSetup(t);
  const id = await ctx.request([ROOT]);
  const first = await ctx.hub.approve(id, { origin: DEV, level: 'read-only', scope: 'domain', tabMode: 'single' });
  assert.deepEqual(first.origins, [ROOT]);
  const narrowed = await ctx.hub.approve(id, { origin: DEV, level: 'read-only', scope: 'origin', tabMode: 'single' });
  assert.equal(narrowed.leaseId, first.leaseId, 'the same lease');
  assert.deepEqual(narrowed.origins, [DEV]);
  assert.equal(narrowed.grant.scope, 'origin');
  assert.deepEqual(ctx.hub.lease(first.leaseId).allowedOrigins, [DEV]);
  assert.deepEqual(ctx.daemon.request(id).lease.origins, [DEV]);
  const widened = await ctx.hub.approve(id, { origin: DEV, level: 'reversible', scope: 'domain', tabMode: 'single' });
  assert.deepEqual(widened.origins, [ROOT]);
  assert.deepEqual(ctx.hub.lease(first.leaseId).allowedOrigins, [ROOT]);
  const run = await ctx.api('POST', '/v1/runs', { requestId: id, instruction: 'Open Team. Read who runs the team.',
    expectation: { urlIncludes: '/team' }, waitMs: 5000 });
  assert.equal(run.body.result.permissions.scope, 'domain');
});

test('the in-process companion takes exact origins only', () => {
  assert.throws(() => createCompanion({ secret: 'x'.repeat(30), extensionId: 'a'.repeat(32), allowedOrigins: [ROOT] }),
    /exact origins/);
});

// --- site profiles through a root ---------------------------------------------------------------------------------

test('a domain root attaches the profiles of the origins it covers (same matcher); an exact origin only its own', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'fai-origins-profiles-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const profile = JSON.parse(await readFile(new URL('../domains/developer.mozilla.org/profile.json', import.meta.url), 'utf8'));
  await mkdir(join(dir, 'developer.mozilla.org'), { recursive: true });
  await writeFile(join(dir, 'developer.mozilla.org', 'profile.json'), JSON.stringify(profile));
  await mkdir(join(dir, 'evilmozilla.org'), { recursive: true });
  await writeFile(join(dir, 'evilmozilla.org', 'profile.json'), JSON.stringify({ ...profile, id: 'evil', origins: ['https://evilmozilla.org'] }));
  const store = createDomainStore({ dir, statsDir: join(dir, '..', `${dir.split('/').pop()}-stats`) });
  assert.deepEqual(store.matchSite('https://*.mozilla.org').map(item => item.id), ['developer.mozilla.org']);
  assert.deepEqual(store.matchSite('https://*.example.org'), []);
  assert.deepEqual(store.matchSite('https://*.org'), [], 'an invalid root matches nothing');
  assert.equal(store.match('https://developer.mozilla.org')?.id, 'developer.mozilla.org');
  // The runtime attaches it for a run whose approved origins hold the root (its restrict.forbid would merge here).
  const forbidding = { ...profile, restrict: { forbid: ['Newsletter'] } };
  await writeFile(join(dir, 'developer.mozilla.org', 'profile.json'), JSON.stringify(forbidding));
  const runtime = new BrowserRuntime({ bridge: new FakeBridge({ pages: SITE }), provider: clickProvider([]) });
  const offered = [];
  runtime.provider = {
    async decide(obs, list) {
      offered.push(list.map(action => action.label));
      return { actionId: 'done' };
    },
  };
  const pages = { '/': { url: 'https://developer.mozilla.org/en-US/', title: 'MDN', text: 'MDN',
    controls: [link('1', 'Newsletter', 'https://developer.mozilla.org/plus'), link('2', 'Docs', 'https://www.mozilla.org/docs')] } };
  runtime.bridge = new FakeBridge({ pages });
  await runtime.run('Read it', { allowedOrigins: ['https://*.mozilla.org'], domains: store, profiles: 'on' });
  assert.ok(offered.length, 'the provider was asked');
  assert.ok(!offered[0].includes('Newsletter'), `the root attached the profile's forbid: ${offered[0]}`);
  assert.ok(offered[0].includes('Docs'), 'a link to another mozilla.org subdomain is offered under the root');
  offered.length = 0;
  runtime.bridge = new FakeBridge({ pages });
  await runtime.run('Read it', { allowedOrigins: ['https://*.example.org', 'https://developer.mozilla.org'], domains: store, profiles: 'on' });
  assert.ok(!offered[0].includes('Newsletter'), 'an exact origin attaches its own profile as before');
  offered.length = 0;
  runtime.bridge = new FakeBridge({ pages });
  await runtime.run('Read it', { allowedOrigins: ['https://*.mozilla.org'], domains: store, profiles: 'off' });
  assert.ok(offered[0].includes('Newsletter'), 'profiles off: nothing attached');
});

// --- the popup-side helpers ---------------------------------------------------------------------------------------

test('popup helpers: scope choices only for a root, plain words, remembered domains validated and time-boxed', () => {
  assert.equal(popupSide.scopeChoices({ origins: [DEV] }, DEV), null);
  const choice = popupSide.scopeChoices({ origins: [ROOT, 'https://app.example.net'] }, DEV);
  assert.deepEqual(choice.roots, ['example.org']);
  assert.deepEqual(choice.patterns, ['https://*.example.org/*']);
  assert.equal(choice.preset, 'domain');
  assert.deepEqual(choice.options.map(option => option.label), ['All of example.org', `Only ${DEV}`]);
  assert.equal(popupSide.scopeChoices({ origins: [ROOT] }, 'https://example.net').options[1].label, 'Only this tab\'s site');
  assert.deepEqual(popupSide.describeOrigins([ROOT, DEV]), ['all of example.org', DEV]);
  assert.deepEqual(popupSide.normalizeDomainMemory(undefined), { remember: false });
  assert.deepEqual(popupSide.normalizeDomainMemory({ remember: 'yes' }), { remember: false });
  assert.deepEqual(popupSide.normalizeDomainMemory({ remember: true }), { remember: true });
  const now = 1_000_000;
  const day = popupSide.REMEMBER_MS;
  assert.equal(day, 24 * 60 * 60_000);
  assert.deepEqual(popupSide.normalizeRememberedSites([
    { root: 'example.org', until: now + 1000 }, { root: 'example.org', until: now + 2000 }, { root: 'co.uk', until: now + 1000 },
    { root: 'old.example', until: now - 1 }, { root: 'far.example', until: now + day + 1 }, null, { root: 7, until: now + 5 },
  ], now), [{ root: 'example.org', until: now + 1000 }]);
  assert.deepEqual([...popupSide.REMEMBER_LEVELS], ['read-only', 'reversible']);
  // Testing is never offered for a request with a root: testing environments are exact origins only.
  assert.ok(!popupSide.levelChoices({ mode: 'testing', origins: [ROOT] }, { testingOrigins: [ROOT] }).options
    .some(option => option.level === 'testing'));
});
