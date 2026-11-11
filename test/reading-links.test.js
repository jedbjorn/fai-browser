// Reading links (issue #32), the pure parts, without a browser: links to other sites listed with their destination and
// never clicked (offeredActions other_site, the listing quota in capOffer, the refusal of an act on one), a focus that
// reaches the page script's control order and the listing, links the page script's cap left out counted in
// moreActions (leanObserve, offerOf), and long blocks shown whole when the host asks for more and marked when cut
// (buildDigest). The browser-backed half is test/extension-links.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserRuntime, OTHER_SITE_TEXT, legalActions, offeredActions } from '../src/runtime.js';
import { capOffer, OTHER_SITE_LISTED, offerCap } from '../src/relevance.js';
import { buildDigest } from '../src/digest.js';
import { leanObserve, offerOf } from '../src/result.js';
import { FakeBridge, ORIGIN, link } from './runtime-fixtures.js';

const FAKE_TOKEN = ['FAKE', 'tok0123456789', 'abcdefABCDEF'].join('');

// --- links to other sites ---------------------------------------------------------------------------------------

test('a link to another site is offered at every level as other_site with its destination, never as a click', () => {
  const controls = [
    link('1', 'About', '/about'),
    link('2', 'Our marketing site', 'https://jane.example.org/site/'),
    link('3', 'Docs in a new tab', 'https://docs.other.example/start', { linkTarget: '_blank' }),
    link('4', 'Email us', '/x', { href: 'mailto:team@example.com' }),
    link('5', 'Run script', '/x', { href: 'javascript:void(0)' }),
    link('6', 'FTP mirror', '/x', { href: 'ftp://files.example.net/pub' }),
  ];
  for (const mode of ['read-only', 'reversible', 'interactive', 'full']) {
    const actions = legalActions({ url: `${ORIGIN}/`, controls }, { mode });
    const other = actions.filter(action => action.type === 'other_site');
    assert.deepEqual(other.map(action => action.target), ['2', '3'], mode);
    assert.equal(other[0].href, 'https://jane.example.org/site/');
    assert.equal(other[0].origin, 'https://jane.example.org');
    assert.equal(other[0].description,
      'Link 2: Our marketing site → https://jane.example.org/site/ (other site: request its origin)');
    assert.ok(!actions.some(action => action.type === 'click' && ['2', '3', '4', '6'].includes(action.target)), mode);
    // mailto:, javascript: and ftp: links are no page another site serves: never listed as one.
    assert.ok(!actions.some(action => ['4', '6'].includes(action.target)), mode);
  }
});

test('a domain root the user approved keeps its subdomains as ordinary links; other roots are other sites', () => {
  const controls = [link('1', 'Shop', 'https://shop.example.com/'), link('2', 'Elsewhere', 'https://example.net/')];
  const actions = legalActions({ url: `${ORIGIN}/`, controls }, { mode: 'read-only', allowedOrigins: ['https://*.example.com'] });
  assert.equal(actions.find(action => action.target === '1').type, 'click');
  assert.equal(actions.find(action => action.target === '2').type, 'other_site');
});

test('an other_site line stays one short line: a long label and a long destination are clipped and marked', () => {
  const href = `https://jane.example.org/${'deep/'.repeat(40)}page`;
  const [action] = legalActions({ url: `${ORIGIN}/`, controls: [link('1', 'L'.repeat(150), href)] }, { mode: 'read-only' })
    .filter(entry => entry.type === 'other_site');
  assert.equal(action.href, href, 'the whole destination stays on the action');
  assert.ok(action.description.length <= 200, `${action.description.length}: the MCP action line keeps it whole`);
  assert.match(action.description, /^Link 1: L{49}… → https:\/\/jane\.example\.org\/deep\/[^ ]{60,}… \(other site: request its origin\)$/);
});

test('a destination link a guardrail refuses (sign-out, a forbidden label) is not listed as another site either', () => {
  const controls = [link('1', 'Sign out', 'https://id.other.example/logout'), link('2', 'Upgrade', 'https://billing.other.example/')];
  const actions = legalActions({ url: `${ORIGIN}/`, controls }, { mode: 'read-only', policy: { forbid: ['Upgrade'] } });
  assert.deepEqual(actions.filter(action => action.type === 'other_site'), []);
});

test('the listing shows a few other-site links unless the task names more; the rest count as dropped', () => {
  const social = Array.from({ length: 12 }, (_, i) => link(String(i + 1), `Social ${i + 1}`, `https://social${i}.example.net/`));
  const controls = [...social, link('13', 'Contact form', 'https://jane.example.org/contact/')];
  const actions = offeredActions({ url: `${ORIGIN}/`, controls }, { mode: 'read-only' }).actions;
  const plain = capOffer(actions, 'read-only', null);
  const listedOther = plain.actions.filter(action => action.type === 'other_site');
  assert.equal(listedOther.length, OTHER_SITE_LISTED);
  assert.equal(plain.dropped, 13 - OTHER_SITE_LISTED);
  assert.ok(!listedOther.some(action => action.target === '13'), 'the footer link is the 13th: parked without a hint');
  // A task that names the contact page brings the footer link in (its label and its path both hold the word).
  const hints = { terms: ['contact'], hops: [], urlIncludes: [], urlEquals: [], urlMatches: [], texts: [] };
  const named = capOffer(actions, 'read-only', hints);
  assert.ok(named.actions.some(action => action.target === '13'));
  assert.equal(offerCap('read-only'), 40, 'the quota is inside the ordinary cap');
});

test('act on an other_site entry refuses as cross_origin with how to follow it; nothing runs and the page stays offered', async () => {
  const pages = {
    '/': { title: 'Profile', text: 'Find the site', controls: [
      link('1', 'Repositories', '/repos'), link('2', 'jane.example.org', `https://jane.example.org/?ref=${FAKE_TOKEN}`),
    ] },
  };
  const bridge = new FakeBridge({ pages });
  const runtime = new BrowserRuntime({ bridge });
  const { observation, actions } = await runtime.observe({ mode: 'read-only', allowedOrigins: [ORIGIN] });
  const other = actions.find(action => action.type === 'other_site');
  assert.ok(other, JSON.stringify(actions));
  const result = await runtime.act(other.id, { revision: observation.revision });
  assert.equal(result.code, 'cross_origin');
  assert.equal(result.needs.message, OTHER_SITE_TEXT);
  assert.ok(!result.needs.message.includes('jane.example.org'), 'page data stays out of the trusted text');
  assert.ok(result.verdict.why.includes('link:other_site'));
  assert.equal(bridge.executions.length, 0);
  assert.equal(result.offer?.revision, observation.revision, 'the same page is offered again');
});

test('a destination with a token in its query is redacted before it reaches the action line', async () => {
  const pages = {
    '/': { title: 'Home', text: 'Links', controls: [link('1', 'Partner portal', `https://partner.example.net/sso?token=${FAKE_TOKEN}&x=1`)] },
  };
  const runtime = new BrowserRuntime({ bridge: new FakeBridge({ pages }) });
  const { actions } = await runtime.observe({ mode: 'read-only', allowedOrigins: [ORIGIN] });
  const other = actions.find(action => action.type === 'other_site');
  assert.ok(other);
  for (const value of [other.description, other.href]) {
    assert.ok(!value.includes(FAKE_TOKEN), value);
    assert.match(value, /token=\[secret:[^\]]+\]/);
  }
});

// --- focus ------------------------------------------------------------------------------------------------------

test('a focus reaches the page script as terms (the phrase first) and ranks the listing, for that observe only', async () => {
  const controls = Array.from({ length: 60 }, (_, i) => link(String(i + 1), `Section ${i + 1}`, `/nav/${i + 1}`));
  controls.push(link('61', 'go here', '/status'));
  const pages = { '/': { title: 'Settings', text: 'Status: pending, go here to fix it.', controls } };
  const bridge = new FakeBridge({ pages });
  const runtime = new BrowserRuntime({ bridge });
  const plain = await runtime.observe({ mode: 'read-only', allowedOrigins: [ORIGIN], instruction: 'Check the settings' });
  const listed = ids => new Set(ids);
  const plainListed = listed(plain.offer.listed);
  assert.ok(!plainListed.has(plain.actions.find(action => action.label === 'go here').id), 'the 61st link is past the cap of 40');

  const focused = await runtime.observe({ mode: 'read-only', allowedOrigins: [ORIGIN], instruction: 'Check the settings', focus: 'go here' });
  const terms = bridge.observeOptions.at(-1).terms;
  assert.equal(terms[0], 'go here', JSON.stringify(terms));
  assert.ok(terms.includes('settings'), 'the task terms stay');
  const focusedListed = listed(focused.offer.listed);
  assert.ok(focusedListed.has(focused.actions.find(action => action.label === 'go here').id), 'the focus brings it in');
  assert.ok(focused.offer.listed.length < focused.actions.length);

  const section = await runtime.observe({ mode: 'read-only', allowedOrigins: [ORIGIN], focus: 'Section 55' });
  assert.ok(new Set(section.offer.listed).has(section.actions.find(action => action.label === 'Section 55').id));
});

// --- moreActions ------------------------------------------------------------------------------------------------

test('moreActions counts the links the page script\'s cap left out, in observe and act results', () => {
  const actions = [
    { id: 'a0', type: 'click', target: '1', role: 'link', label: 'Home', description: 'Click link 1: Home' },
    { id: 'a1', type: 'scroll', direction: 'down', description: 'Scroll down to see more of the page' },
  ];
  const page = { url: `${ORIGIN}/`, title: 'Nav', warnings: ['controls_capped:30'], linksDropped: 25 };
  const lean = leanObserve({ revision: 'r1', page, actions, offer: { listed: ['a0', 'a1'] }, digest: [] });
  assert.equal(lean.moreActions, 25);
  assert.ok(lean.warnings.includes('controls_capped:30'));
  const none = leanObserve({ revision: 'r1', page: { ...page, linksDropped: undefined }, actions, offer: { listed: ['a0', 'a1'] }, digest: [] });
  assert.equal(none.moreActions, undefined);
  const after = offerOf({ offer: { revision: 'r2', actions, listed: ['a0'], linksDropped: 7 } });
  assert.equal(after.moreActions, 1 + 7);
});

// --- long blocks in the digest ----------------------------------------------------------------------------------

const BANNER = `Your account is not verified. ${'Partners in this program must keep their contacts current. '.repeat(8)}`
  + 'You must add the Primary Contact in Account Settings, then User Management.';

function bannerPage({ cut = false, text = BANNER } = {}) {
  return {
    url: `${ORIGIN}/legal`, title: 'Legal info',
    blocks: [
      { t: 'h1', text: 'Legal info' },
      { t: 'alert', text, ...(cut ? { cut: true } : {}) },
      { t: 'p', text: 'Company name: Example Ltd' },
    ],
    controls: [],
  };
}

test('a long block ends in "…" in a default digest, and the digest says more is on the page', () => {
  const { digest, truncated } = buildDigest(bannerPage(), 'Read the legal info');
  const banner = digest.find(entry => entry.t === 'alert');
  assert.equal(banner.text.length, 301);
  assert.ok(banner.text.endsWith('…'));
  assert.equal(truncated, true);
  // A short block is never marked.
  assert.equal(digest.find(entry => entry.t === 'p').text, 'Company name: Example Ltd');
});

test('a focus shows the matching long block whole; a larger digestChars shows every long block whole', () => {
  const matched = buildDigest(bannerPage(), 'primary contact', { fullBlocks: 'matched' });
  assert.equal(matched.digest.find(entry => entry.t === 'alert').text, BANNER);
  const unmatched = buildDigest(bannerPage(), 'company name', { fullBlocks: 'matched' });
  assert.ok(unmatched.digest.find(entry => entry.t === 'alert').text.endsWith('…'), 'a block without the focus words stays short');
  const all = buildDigest(bannerPage(), 'company name', { fullBlocks: 'all', maxChars: 6000, maxBlocks: 100 });
  assert.equal(all.digest.find(entry => entry.t === 'alert').text, BANNER);
});

test('a block the page script cut is marked even when shown at its full length', () => {
  const page = bannerPage({ cut: true });
  const { digest, truncated } = buildDigest(page, 'primary contact', { fullBlocks: 'all', maxChars: 6000, maxBlocks: 100 });
  assert.equal(digest.find(entry => entry.t === 'alert').text, `${BANNER}…`);
  assert.equal(truncated, true);
  // Longer than the page script's own cap (1500): kept to 1500 characters and marked.
  const long = 'word '.repeat(500).trim();
  const huge = buildDigest(bannerPage({ text: long }), 'word', { fullBlocks: 'all', maxChars: 6000, maxBlocks: 100 });
  const text = huge.digest.find(entry => entry.t === 'alert').text;
  assert.equal(text.length, 1501);
  assert.ok(text.endsWith('…'));
});

test('a block clipped into the remaining budget is marked and counts as truncated', () => {
  const page = bannerPage();
  const { digest, truncated } = buildDigest(page, 'primary contact', { fullBlocks: 'matched', maxChars: 200 });
  const banner = digest.find(entry => entry.t === 'alert');
  assert.ok(banner.text.endsWith('…'));
  assert.ok(banner.text.length <= 200);
  assert.equal(truncated, true);
});
