// fai_browser_guide and the onboarding lines of issue #33: every topic answers, stays short and names what the code
// does (next kinds, statuses, outcome codes, levels, tools), the first page of a request carries its notice, and a url
// act to an address no page showed says so once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createDaemon } from '../src/daemon.js';
import { legalActions } from '../src/runtime.js';
import { GUIDE_CODES, GUIDE_CODE_GROUPS, GUIDE_NEXT_KINDS, GUIDE_TOPICS, guideCode, guideText } from '../src/guide.js';
import { LEVELS } from '../src/guardrails.js';
import { INSTRUCTIONS, ONE_TAB_NOTICE, TOOLS, TOOL_NAMES, VERSION, controlText, guideResult, versionNote } from '../src/mcp.js';
import { NEXT_KINDS, ONE_TAB_TEXT, OUTCOME_CODES, STATUSES, directNext } from '../src/result.js';
import { call, createFakeHub } from './helpers/fake-hub.js';
import { spawnMcp } from './helpers/mcp-harness.js';
import { mcpData } from './helpers/mcp-result.js';
import { ORIGIN, PAGES, link } from './runtime-fixtures.js';

const words = text => text.split(/\s+/).filter(Boolean).length;

test('every guide topic answers, the index names them all, and each stays under 300 words', () => {
  assert.equal(GUIDE_TOPICS[0], 'index');
  assert.equal(guideText(), guideText('index'));
  assert.equal(guideText('no-such-topic'), guideText('index'), 'an unknown topic gives the index');
  for (const topic of GUIDE_TOPICS) {
    const text = guideText(topic);
    assert.ok(words(text) < 300, `${topic}: ${words(text)} words`);
    assert.ok(text.length <= 2200, `${topic}: ${text.length} chars`);
    if (topic !== 'index') assert.match(guideText('index'), new RegExp(`\\b${topic}\\b`), `index names ${topic}`);
    assert.doesNotMatch(text, /undefined|\[object Object\]|NaN/, `${topic} renders every line`);
  }
  // The index alone carries the rules that matter most (a host may call the guide once, without a topic).
  const index = guideText('index');
  for (const rule of [/page\.digest answers the task/, /Never a guessed address \(url, allowedUrls or origins\)/,
    /focus/, /child_tab/, /Resume/, /same requestId/, /Never log in/, /Do not release/]) assert.match(index, rule);
  // The tool's own schema offers exactly these topics.
  const tool = TOOLS.find(item => item.name === 'fai_browser_guide');
  assert.deepEqual(tool.inputSchema.properties.topic.enum, GUIDE_TOPICS);
  assert.equal(tool._meta, undefined, 'the guide stays behind tool search (the instructions name it)');
});

test('the states topic names every next kind, status and outcome code the code can return', () => {
  const states = guideText('states');
  assert.deepEqual(GUIDE_NEXT_KINDS, [...NEXT_KINDS, 'wait']);
  // A new next kind or status without a line would render "undefined" and must fail here.
  for (const kind of GUIDE_NEXT_KINDS) assert.match(states, new RegExp(`^- ${kind}: (?!undefined)\\S`, 'm'), `next.kind ${kind}`);
  for (const status of ['observed', 'acted', ...STATUSES]) assert.match(states, new RegExp(`\\b${status} \\((?!undefined)[^)]`), status);
  assert.doesNotMatch(states, /undefined/);
  const grouped = GUIDE_CODE_GROUPS.flatMap(group => group.codes);
  assert.equal(new Set(grouped).size, grouped.length, 'each code in one group');
  assert.deepEqual([...grouped].sort(), [...OUTCOME_CODES].sort(), 'every outcome code (src/result.js) has a group');
  for (const code of OUTCOME_CODES) assert.match(states, new RegExp(`\\b${code}\\b`), code);
});

test('guideCode explains every code it lists in one or two lines, with who acts', () => {
  for (const code of GUIDE_CODES) {
    const line = guideCode(code);
    assert.ok(line?.startsWith(`${code}`), code);
    assert.ok(line.length < 600, `${code}: ${line.length}`);
  }
  for (const code of ['child_tab', 'tab_changed', 'cross_origin', 'ask_pending', 'denied', 'replaced', 'not_approved',
    'tab_not_ready', 'ask_declined', 'ask_root', 'stopped']) {
    assert.ok(GUIDE_CODES.includes(code), code);
  }
  assert.match(guideCode('child_tab'), /the user acts.*Resume.*Multiple task tabs/s);
  assert.match(guideCode('tab_changed'), /came to the front.*Resume/);
  assert.match(guideCode('cross_origin'), /same|requestId/);
  assert.match(guideCode('cross_origin'), /Never guess/);
  assert.equal(guideCode('no_such_code'), null);
});

test('the guide names only real tools, every level, and the rules agents missed', () => {
  const all = GUIDE_TOPICS.map(topic => guideText(topic)).join('\n');
  for (const name of new Set(all.match(/fai_browser_[a-z_]+/g))) assert.ok(TOOL_NAMES.includes(name), name);
  const tools = guideText('tools');
  for (const name of TOOL_NAMES.filter(name => !['fai_browser_open', 'fai_browser_act'].includes(name))) {
    assert.match(tools, new RegExp(name), `tools topic covers ${name}`);
  }
  const levels = guideText('levels');
  for (const level of LEVELS) assert.match(levels, new RegExp(`^- ${level} \\(`, 'm'), level);
  assert.match(levels, /same tab and page/i);
  assert.match(guideText('finding'), /Never construct or guess an address/);
  assert.match(guideText('finding'), /focus/);
  assert.match(guideText('finding'), /"…"/, 'a cut block is marked');
  assert.match(guideText('tabs'), /child_tab[\s\S]*tab_changed[\s\S]*Multiple task tabs[\s\S]*openTab/);
  assert.match(guideText('origins'), /same request[\s\S]*other site/);
  assert.match(guideText('troubleshooting'), /daemon logs[\s\S]*Version mismatch|Version mismatch[\s\S]*daemon logs/);
  assert.match(guideText('troubleshooting'), /bug report/i);
  assert.doesNotMatch(all, /approve the new FAI Browser request|fai_browser_run|Jev/);
});

test('guideResult: a topic, a code, both, or the index; never a daemon call', () => {
  const text = result => result.content[0].text;
  assert.equal(text(guideResult({})), guideText('index'));
  assert.equal(text(guideResult({ topic: 'tabs' })), guideText('tabs'));
  assert.equal(text(guideResult({ code: 'child_tab' })), guideCode('child_tab'));
  assert.equal(text(guideResult({ code: 'child_tab', topic: 'tabs' })), `${guideCode('child_tab')}\n\n${guideText('tabs')}`);
  assert.match(text(guideResult({ code: 'zzz_unknown' })), /not a code FAI Browser uses/);
});

test('the MCP server answers fai_browser_guide without a daemon', async t => {
  const home = await mkdtemp(join(tmpdir(), 'fai-guide-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  // Port 1: nothing listens and no daemon may start in time; the guide never needs one.
  const mcp = spawnMcp({ PATH: process.env.PATH, HOME: home, FAI_HOME: home, FAI_DAEMON_PORT: '1',
    FAI_DAEMON_START_TIMEOUT_MS: '500' });
  t.after(() => mcp.close());
  const initialized = await mcp.initialize();
  assert.equal(initialized.result.instructions, INSTRUCTIONS);
  assert.match(INSTRUCTIONS, /fai_browser_guide/);
  const started = Date.now();
  const result = await mcp.callTool('fai_browser_guide', { topic: 'states' });
  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].text, guideText('states'));
  assert.ok(Date.now() - started < 2000);
  const bad = await mcp.callTool('fai_browser_guide', { topic: 'nope' });
  assert.equal(bad.isError, true, 'a topic outside the enum is invalid_params');
});

test('versionNote: only when plain versions differ', () => {
  assert.equal(versionNote({ daemon: { version: VERSION }, extension: { version: VERSION } }), null);
  assert.equal(versionNote({ daemon: { version: VERSION } }), null);
  assert.equal(versionNote({ daemon: { version: VERSION }, extension: { version: 'test' } }), null);
  const note = versionNote({ daemon: { version: '0.6.1' }, extension: { version: '0.7.0' } }, '0.7.0');
  assert.match(note, /versions differ \(MCP server 0\.7\.0, daemon 0\.6\.1, extension 0\.7\.0\)/);
  assert.match(note, /Never update it yourself/);
});

test('refusals of one-tab acts stop with their own remedy, never the purchase line', () => {
  const next = directNext({ status: 'needs_user', code: 'refused_action', needs: { who: 'user', message: ONE_TAB_TEXT } });
  assert.equal(next.kind, 'stop');
  assert.match(next.text, /Multiple task tabs/);
  assert.doesNotMatch(next.text, /purchases/);
  const cross = directNext({ status: 'needs_user', code: 'cross_origin', needs: { who: 'user', message: 'x' } }, { requestId: 'req_abcd' });
  assert.equal(cross.kind, 'relay');
  assert.match(cross.text, /fai_browser_open with requestId req_abcd/);
  const paused = directNext({ status: 'needs_user', code: 'child_tab', needs: { who: 'user', message: 'x' } }, { requestId: 'req_abcd' });
  assert.match(paused.text, /fai_browser_guide topic tabs/);
});

async function setup(t, pages = PAGES) {
  const home = await mkdtemp(join(tmpdir(), 'fai-guide-direct-'));
  const hub = createFakeHub({ bridgeOptions: { pages } });
  const daemon = createDaemon({ home, env: {}, port: 0, hub });
  await daemon.listen();
  const mcp = spawnMcp({ FAI_HOME: home, FAI_DAEMON_PORT: String(daemon.port), FAI_MCP_APPROVAL_WAIT_MS: '1000' });
  t.after(async () => {
    await mcp.close();
    await daemon.close();
    await rm(home, { recursive: true, force: true });
  });
  await mcp.initialize();
  return { daemon, hub, mcp, api: (method, path, body) => call(daemon.port, method, path, body, { token: daemon.token }) };
}

async function openApproved(ctx, args = {}, approve = {}) {
  const opening = ctx.mcp.callTool('fai_browser_open', { origins: [ORIGIN], reason: 'Guide test', ...args });
  let pending;
  for (let i = 0; i < 400 && !pending; i++) {
    pending = ctx.hub.published.at(-1)?.find(item => item.state === 'pending');
    if (!pending) await delay(5);
  }
  assert.ok(pending, 'a pending request');
  await ctx.hub.approve(pending.requestId, { level: 'read-only', ...approve });
  const result = await opening;
  return { text: result.content[0].text, data: mcpData(result), requestId: pending.requestId };
}

test('the first page of a request says One task tab once; later pages do not', async t => {
  const ctx = await setup(t);
  const first = await openApproved(ctx);
  assert.match(first.text, new RegExp(`^notice: .*${ONE_TAB_NOTICE.replace(/[()]/g, '\\$&')}`, 'm'));
  const again = await ctx.mcp.callTool('fai_browser_observe', { requestId: first.requestId });
  assert.doesNotMatch(again.content[0].text, /^notice:/m);
});

test('a url act to an address no page showed carries one note; a followed address does not', async t => {
  const pages = {
    ...PAGES,
    '/': { title: 'Home', text: 'Welcome home', controls: [link('1', 'About', '/about'), link('2', 'Contact', '/contact-us')] },
    '/contact-us': { title: 'Contact', text: 'Write to us', controls: [link('1', 'Home', '/')] },
    '/contact': { title: 'Contact guess', text: 'Guessed page', controls: [] },
  };
  const ctx = await setup(t, pages);
  const { requestId } = await openApproved(ctx);
  const shown = mcpData(await ctx.mcp.callTool('fai_browser_act', { requestId, url: `${ORIGIN}/contact-us` }));
  assert.doesNotMatch(shown.next.text, /not on any page/, 'a link the page listed');
  const guessed = mcpData(await ctx.mcp.callTool('fai_browser_act', { requestId, url: `${ORIGIN}/contact` }));
  assert.match(guessed.next.text, /not on any page of this task nor in allowedUrls/);
  assert.match(guessed.next.text, /do not guess addresses/);
});

test('an allowed URL is not offered again as an action while the tab is on that page', async t => {
  const ctx = await setup(t);
  const { data } = await openApproved(ctx, { allowedUrls: [`${ORIGIN}/`, `${ORIGIN}/members`] });
  const opens = data.actions.map(action => action.description).filter(text => text.startsWith('open '));
  assert.ok(opens.includes(`open ${ORIGIN}/members`), opens.join(' | '));
  assert.ok(!opens.includes(`open ${ORIGIN}/`), opens.join(' | '));
});

test('the CLI guide command prints one JSON line and starts no daemon', async t => {
  const home = await mkdtemp(join(tmpdir(), 'fai-guide-cli-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const cli = new URL('../src/cli.js', import.meta.url).pathname;
  const run = (...args) => new Promise(resolve => execFile(process.execPath, [cli, ...args],
    { env: { ...process.env, FAI_HOME: home, FAI_DAEMON_PORT: '1' } }, (error, stdout) => resolve({ code: error?.code ?? 0, stdout })));
  const tabs = await run('guide', 'tabs');
  assert.equal(tabs.code, 0);
  assert.deepEqual(JSON.parse(tabs.stdout), { topic: 'tabs', text: guideText('tabs') });
  const code = await run('guide', '--code', 'tab_changed');
  assert.deepEqual(JSON.parse(code.stdout), { code: 'tab_changed', text: guideCode('tab_changed') });
  const bad = await run('guide', 'nope');
  assert.equal(bad.code, 1);
  assert.deepEqual(await readdir(home), [], 'nothing written: no daemon started');
});

test('status names why a request is paused or ended (diagnosis)', () => {
  const text = controlText({ requests: [
    { requestId: 'req_abcd', state: 'paused', stateReason: 'child_tab', mode: 'read-only' },
    { requestId: 'req_efgh', state: 'active', stateReason: 'approved', mode: 'full' },
  ] });
  assert.match(text, /^request: req_abcd paused \(child_tab\) read-only$/m);
  assert.match(text, /^request: req_efgh active full$/m);
});

test('guideCode: who acts is true for every code; advice matches what the MCP tools offer', () => {
  assert.match(guideCode('expectation_passed'), /nobody needs to act/);
  assert.match(guideCode('stopped'), /the task ended/);
  for (const code of OUTCOME_CODES) assert.doesNotMatch(guideCode(code), /nobody can continue/, code);
  assert.doesNotMatch(guideCode('time_budget'), /timeoutMs/, 'no MCP tool takes timeoutMs');
  assert.match(guideCode('refused_action'), /Multiple task tabs/, 'some refusals without needs.level lift another way');
  assert.match(guideCode('tab_changed'), /One task tab/, 'Tab access switched back pauses as tab_changed');
  assert.match(guideCode('select_tab'), /toolbar icon/);
  assert.match(guideCode('select_tab'), /declined/);
});

test('guideCode knows every error code the FAI service sends (src/daemon.js) and the MCP server adds', async () => {
  const { readFile } = await import('node:fs/promises');
  const daemon = await readFile(new URL('../src/daemon.js', import.meta.url), 'utf8');
  const mcp = await readFile(new URL('../src/mcp.js', import.meta.url), 'utf8');
  const codes = new Set([...daemon.matchAll(/HttpError\(\d+, '([a-z_]+)'/g), ...mcp.matchAll(/ToolError\('([a-z_]+)'/g)]
    .map(match => match[1]));
  if (/function badOptions/.test(daemon)) codes.add('invalid_options');
  assert.ok(codes.size > 15, `${codes.size} codes found`);
  for (const code of codes) assert.ok(guideCode(code), `${code} is explained`);
});

test('the guide describes approval after PR #39: toolbar fallback, declined prompt, approval log lines', () => {
  const text = guideText('troubleshooting');
  assert.match(text, /toolbar icon on the task tab/);
  assert.match(text, /declined the browser's site-access prompt[^.]*do not push/);
  assert.match(text, /approval line/);
  assert.doesNotMatch(text, /node src\/cli\.js update/, 'update applies to a checkout only; the popup is the way');
  assert.doesNotMatch(text, /FAI_HOME\)/, 'never point at a directory that holds the token');
});

test('versionNote compares the extension of the browser serving the request', () => {
  const status = {
    daemon: { version: VERSION },
    extension: { version: '0.1.0', browsers: [{ id: 'b-ff', version: VERSION }, { id: 'b-cr', version: '0.1.0' }] },
    requests: [{ requestId: 'req_serving', browser: { id: 'b-ff', name: 'Firefox' } }],
  };
  assert.equal(versionNote(status, VERSION, 'req_serving'), null, 'the serving browser matches');
  assert.match(versionNote(status, VERSION, 'req_other'), /extension 0\.1\.0/, 'unknown request: the browser used last');
});

test('the same-page allowed URL filter keeps a hash-routed view (fragment included)', () => {
  const observation = { revision: 'r1', url: `${ORIGIN}/#/home`, title: 'App', text: 'App', controls: [] };
  const opens = legalActions(observation, { allowedUrls: [`${ORIGIN}/#/settings`, `${ORIGIN}/#/home`] })
    .filter(action => action.type === 'navigate_allowed_url').map(action => action.url);
  assert.deepEqual(opens, [`${ORIGIN}/#/settings`]);
});

const LINKS = {
  '/': { title: 'Home', text: 'Welcome. Our press page lives at https://example.com/printed-only.', controls: [
    link('1', 'Team', '/team'), link('2', 'Press', '/press'), link('4', 'Jobs', '/jobs/'),
    { id: '3', role: 'link', label: 'Our blog', href: 'https://blog.example.org/posts/' },
  ] },
  '/team': { title: 'Team', text: 'Ada and Grace', controls: [] },
  '/press': { title: 'Press', text: 'Press kit', controls: [] },
  '/jobs': { title: 'Jobs', text: 'Open roles', controls: [] },
  '/printed-only': { title: 'Printed', text: 'Printed address page', controls: [] },
  '/contact': { title: 'Contact guess', text: 'Guessed page', controls: [] },
};

test('seen addresses belong to the request: after a pause and Resume a shown link is no guess', async t => {
  const ctx = await setup(t, LINKS);
  const { requestId } = await openApproved(ctx);
  await ctx.mcp.callTool('fai_browser_act', { requestId, url: `${ORIGIN}/team` });
  const leaseId = ctx.daemon.request(requestId).lease.leaseId;
  await ctx.hub.emit({ type: 'status', leaseId, status: 'paused', reason: 'child_tab' });
  assert.equal(ctx.daemon.request(requestId).state, 'paused');
  await ctx.hub.approve(requestId, { level: 'read-only' });
  assert.equal(ctx.daemon.request(requestId).state, 'active');
  assert.notEqual(ctx.daemon.request(requestId).lease.leaseId, leaseId, 'a new lease and runtime');
  await ctx.mcp.callTool('fai_browser_observe', { requestId });
  const press = mcpData(await ctx.mcp.callTool('fai_browser_act', { requestId, url: `${ORIGIN}/press` }));
  assert.doesNotMatch(press.next.text, /not on any page/, 'shown before the pause');
  const jobs = mcpData(await ctx.mcp.callTool('fai_browser_act', { requestId, url: `${ORIGIN}/jobs` }));
  assert.doesNotMatch(jobs.next.text, /not on any page/, 'a trailing slash is the same address');
  const printed = mcpData(await ctx.mcp.callTool('fai_browser_act', { requestId, url: `${ORIGIN}/printed-only` }));
  assert.doesNotMatch(printed.next.text, /not on any page/, 'an address printed in the page text');
  const guessed = mcpData(await ctx.mcp.callTool('fai_browser_act', { requestId, url: `${ORIGIN}/contact` }));
  assert.match(guessed.next.text, /not on any page of this task/, 'a guessed same-origin address');
});

test('a guessed address on another site runs nothing and says to find the link; a shown one asks as before', async t => {
  const ctx = await setup(t, LINKS);
  const { requestId } = await openApproved(ctx, { task: 'Find the press contact; the user said https://news.example.net/desk is theirs' });
  const guessed = mcpData(await ctx.mcp.callTool('fai_browser_act', { requestId, url: 'https://marketing.example.org/contact' }));
  assert.equal(guessed.code, 'cross_origin');
  assert.equal(guessed.next.kind, 'observe');
  assert.match(guessed.next.text, /not on any page of this task/);
  assert.match(guessed.next.text, /only if the user gave you that address/);
  assert.doesNotMatch(guessed.next.text, /marketing\.example\.org/, 'trusted text names no address');
  const shown = mcpData(await ctx.mcp.callTool('fai_browser_act', { requestId, url: 'https://blog.example.org/posts/' }));
  assert.equal(shown.code, 'cross_origin');
  assert.equal(shown.next.kind, 'relay');
  assert.match(shown.needs.message, /https:\/\/blog\.example\.org is not covered by this request/);
  const given = mcpData(await ctx.mcp.callTool('fai_browser_act', { requestId, url: 'https://news.example.net/desk' }));
  assert.match(given.needs.message, /news\.example\.net is not covered/, 'an address the task names is the user\'s');
});

test('openTab to a guessed address says so too (Multiple task tabs)', async t => {
  const ctx = await setup(t, LINKS);
  const { requestId } = await openApproved(ctx, {}, { tabMode: 'multiple' });
  const guessed = mcpData(await ctx.mcp.callTool('fai_browser_act', { requestId, openTab: 'https://elsewhere.example.org/x' }));
  assert.equal(guessed.code, 'cross_origin');
  assert.equal(guessed.next.kind, 'observe');
  assert.match(guessed.next.text, /not on any page of this task/);
});

test('an ask for a site no page showed is not refused, and ask_pending says so; a shown site asks plainly', async t => {
  const ctx = await setup(t, LINKS);
  const { requestId } = await openApproved(ctx);
  const shown = mcpData(await ctx.mcp.callTool('fai_browser_open', { requestId, origins: ['https://blog.example.org'] }));
  assert.equal(shown.code, 'ask_pending');
  assert.doesNotMatch(shown.needs.message, /No page of this task showed/);
  const guessed = mcpData(await ctx.mcp.callTool('fai_browser_open', { requestId, origins: ['https://guess.example.org'] }));
  assert.equal(guessed.code, 'ask_pending');
  assert.match(guessed.needs.message, /No page of this task showed that site/);
});
