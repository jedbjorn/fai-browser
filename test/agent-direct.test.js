import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createDaemon } from '../src/daemon.js';
import { ALWAYS_LOAD_META, INSTRUCTIONS, TOOLS, directText } from '../src/mcp.js';
import { call, createFakeHub } from './helpers/fake-hub.js';
import { spawnMcp } from './helpers/mcp-harness.js';
import { mcpData } from './helpers/mcp-result.js';
import { ORIGIN, PAGES, link } from './runtime-fixtures.js';

async function setup(t, { pages = PAGES } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'fai-direct-'));
  const hub = createFakeHub({ bridgeOptions: { pages } });
  const daemon = createDaemon({ home, env: {}, port: 0, hub });
  await daemon.listen();
  const mcp = spawnMcp({ FAI_HOME: home, FAI_DAEMON_PORT: String(daemon.port),
    FAI_MCP_APPROVAL_WAIT_MS: '1000' });
  t.after(async () => {
    await mcp.close();
    await daemon.close();
    await rm(home, { recursive: true, force: true });
  });
  const initialized = await mcp.initialize();
  const api = (method, path, body) => call(daemon.port, method, path, body, { token: daemon.token });
  return { home, daemon, hub, mcp, initialized, api };
}

async function pendingRequest(hub) {
  for (let i = 0; i < 400; i++) {
    const request = hub.published.at(-1)?.find(item => item.state === 'pending');
    if (request) return request;
    await delay(5);
  }
  throw new Error('No pending request');
}

/** Open a task and approve it at `level`; returns the opening result. */
async function opened(ctx, args, level = 'read-only') {
  const opening = ctx.mcp.callTool('fai_browser_open', { origins: [ORIGIN], reason: 'Test task', ...args });
  const pending = await pendingRequest(ctx.hub);
  await ctx.hub.approve(pending.requestId, { level });
  const result = await opening;
  return { result, structured: mcpData(result), text: result.content[0].text, requestId: pending.requestId };
}

test('direct MCP: open waits for approval and observes; acts are host-chosen, lean and verified without a provider', async t => {
  const ctx = await setup(t);
  assert.equal(ctx.initialized.result.instructions, INSTRUCTIONS);
  assert.equal(createHash('sha256').update(JSON.stringify(INSTRUCTIONS)).digest('hex'),
    'f789313d37e2fe0555bc137163374a014da3133b99372b009c8b3478f1202efb', 'instruction prefix bytes stay stable');
  const tools = (await ctx.mcp.request('tools/list', {})).result.tools;
  const serialized = JSON.stringify(tools);
  assert.equal(serialized, JSON.stringify(TOOLS), 'wire serialization preserves the exported schema prefix and order');
  assert.equal(createHash('sha256').update(serialized).digest('hex'),
    '82fef5f39dd3ea77a2165f5bfaca9fa21688c9c33ff50741747fb1b74d5304b9', 'tool schema bytes stay stable');
  const repeated = await ctx.mcp.request('tools/list', {});
  assert.equal(JSON.stringify(repeated.result.tools), serialized, 'repeated tools/list reads are byte-identical');
  assert.deepEqual(tools.map(tool => tool.name), ['fai_browser_open', 'fai_browser_act', 'fai_browser_observe',
    'fai_browser_wait', 'fai_browser_status', 'fai_browser_release', 'fai_browser_evidence']);
  assert.deepEqual(tools.filter(tool => tool._meta?.[ALWAYS_LOAD_META]).map(tool => tool.name),
    ['fai_browser_open', 'fai_browser_act', 'fai_browser_observe']);
  const open = tools.find(tool => tool.name === 'fai_browser_open').inputSchema.properties;
  for (const jevOnly of ['steps', 'capture', 'maxCalls', 'maxMs', 'answerQuestion', 'instruction', 'minConfidence']) {
    assert.equal(open[jevOnly], undefined, `open has no ${jevOnly}`);
  }
  assert.equal(tools.find(tool => tool.name === 'fai_browser_act').inputSchema.properties.capture, undefined);
  const opening = ctx.mcp.callTool('fai_browser_open', {
    origins: [ORIGIN], reason: 'Read Members', task: 'Who are the members?',
  });
  const pending = await pendingRequest(ctx.hub);
  assert.equal(ctx.hub.bridges.size, 0, 'no page is accessed before approval');
  await ctx.hub.approve(pending.requestId, { level: 'read-only' });
  const observed = mcpData(await opening);
  assert.equal(observed.status, 'observed');
  assert.equal(observed.next.kind, 'choose');
  assert.equal(ctx.hub.bridgeForTab(1).executions.length, 0, 'the task is not delegated');
  const about = observed.actions.find(action => action.description === 'click "About"');
  assert.ok(about);
  const first = await ctx.mcp.callTool('fai_browser_act', { actionId: about.id, revision: observed.revision });
  assert.equal(first.structuredContent, undefined);
  const acted = mcpData(first);
  assert.equal(acted.status, 'acted');
  assert.equal(acted.next.kind, 'choose');
  assert.ok(acted.next.text.length < 160, 'the per-act next is short');
  assert.doesNotMatch(first.content[0].text, /verdict|oversight|fai_browser_run/);
  const members = acted.actions.find(action => action.description === 'click "Members"');
  const final = mcpData(await ctx.mcp.callTool('fai_browser_act', {
    actionId: members.id, revision: acted.revision, expectation: { urlIncludes: '/members' },
  }));
  assert.equal(final.status, 'completed');
  assert.equal(final.verification.passed, true);
  assert.equal(final.next.kind, 'answer');
  const status = (await ctx.api('GET', '/v1/status')).body;
  assert.equal(status.driver, undefined);
  assert.equal(status.provider, undefined);
  assert.equal(mcpData(await ctx.mcp.callTool('fai_browser_status', {})).state, 'ok');
});

test('direct MCP projects dated records and their offered open/pagination actions', async t => {
  const names = ['Northwind Office', 'City Cycle Works', 'Paper & Parcel'];
  const dates = ['30 Oct 2026', '18 Sep 2026', '2 Aug 2026'];
  const controls = names.map((name, i) => link(String(i + 1), name, `/receipts/${i}`));
  controls.push(link('4', 'Previous', '/receipts?page=1'), link('5', 'Next', '/receipts?page=3'));
  const pages = { '/': {
    title: 'Receipt archive', text: '128 results', controls,
    blocks: [{ t: 'h1', text: 'Receipt archive' }, { t: 'p', text: '128 results' },
      ...names.map((name, i) => ({ t: 'li', text: `${name} · ${dates[i]} · Receipt ${i}`, ref: String(i + 1) }))],
    records: names.map((name, i) => ({
      id: `r${i + 1}`, list: 0, title: name, fields: [dates[i], `Receipt ${i}`], ref: String(i + 1),
      href: `${ORIGIN}/receipts/${i}`, hints: { when: [dates[i]] }, blocks: [i + 2],
    })),
    recordLists: [{ list: 0, total: 3, kept: 3 }],
    recordState: { resultCount: { value: 128 }, sort: { label: 'Newest first' },
      pagination: { current: 2, total: 6, previous: '4', next: '5' } },
  } };
  const ctx = await setup(t, { pages });
  const { structured, text } = await opened(ctx, { task: 'Find the oldest receipt and open it' });
  assert.match(text, /results: 3 shown, 128 results, incomplete/);
  const first = JSON.parse(/^result r1: (.+)$/m.exec(text)[1]);
  assert.equal(first.date, '30 Oct 2026');
  assert.deepEqual(first.fields, ['Receipt 0']);
  const open = structured.actions.find(action => action.description === 'click "Northwind Office"');
  assert.equal(first.open, open.id);
  assert.equal(first.openRef, undefined);
  const previous = structured.actions.find(action => action.description === 'click "Previous"').id;
  const next = structured.actions.find(action => action.description === 'click "Next"').id;
  assert.match(text, new RegExp(`result pagination: page 2 of 6; previous ${previous}; next ${next}`));
  assert.ok(!structured.page.digest.some(line => line.includes('Northwind Office')));
});

test('a spent revision is refused with the current one; an observe takes no screenshot unless asked', async t => {
  const ctx = await setup(t);
  const { structured: page, requestId } = await opened(ctx, { task: 'Open About' });
  const about = page.actions.find(action => action.description === 'click "About"');
  const acted = mcpData(await ctx.mcp.callTool('fai_browser_act', { actionId: about.id, revision: page.revision }));
  const again = await ctx.mcp.callTool('fai_browser_act', { actionId: about.id, revision: page.revision });
  assert.equal(again.isError, true);
  assert.match(again.content[0].text, /single-use/);
  assert.ok(again.content[0].text.includes(acted.revision), 'the error names the current revision');
  const observe = await ctx.api('POST', '/v1/observe', { requestId });
  assert.equal(observe.status, 200);
  assert.equal(observe.body.screenshot, null);
  const dirs = await readdir(join(ctx.home, 'artifacts'));
  for (const dir of dirs) {
    const files = await readdir(join(ctx.home, 'artifacts', dir)).catch(() => []);
    assert.ok(!files.some(file => /^observe\.(png|jpg)$/.test(file)), `no screenshot written in ${dir}`);
  }
});

test('direct MCP cannot observe an unapproved request', async t => {
  const ctx = await setup(t);
  const result = mcpData(await ctx.mcp.callTool('fai_browser_open', {
    origins: [ORIGIN], reason: 'Read About', task: 'Open About',
  }));
  assert.equal(result.status, 'needs_user');
  assert.equal(result.next.kind, 'relay');
  assert.match(result.next.text, /Then call fai_browser_observe with requestId/);
  assert.equal(ctx.hub.bridges.size, 0);
});

test('direct control keeps the user grant, policy restrictions and refusal of unoffered actions', async t => {
  const pages = { '/': { title: 'Home', text: 'Welcome', controls: [link('1', 'About', '/about'),
    { id: '2', role: 'button', label: 'Settings', enabled: true, risk: 'reversible' },
    { id: '3', role: 'button', label: 'Buy now', enabled: true, risk: 'reversible' }] } };
  const ctx = await setup(t, { pages });
  const { structured: page, text, requestId } = await opened(ctx, { task: 'Read the home page', mode: 'full',
    policy: { forbid: ['About'] } });
  assert.ok(!page.actions.some(action => /About|Settings|Buy now/.test(action.description)));
  assert.deepEqual(page.granted, { level: 'read-only', asked: 'full', tabMode: 'single' });
  assert.match(text, /^granted: read-only \(asked full\); task tabs: single$/m);
  const refused = await ctx.mcp.callTool('fai_browser_act', { actionId: 'forged', revision: page.revision });
  assert.equal(refused.isError, true);
  assert.equal(ctx.hub.bridgeForTab(1).executions.length, 0);
  const run = await ctx.api('POST', '/v1/runs', { requestId, instruction: 'Open About' });
  assert.equal(run.status, 404, 'runs and steps are gone');
});

test('a later observe keeps the opening call\'s policy, supplied values and URLs; it can only add to them', async t => {
  const pages = { '/': { title: 'Home', text: 'Welcome', controls: [link('1', 'About', '/about'),
    { id: '2', role: 'button', label: 'Settings', enabled: true, risk: 'reversible' },
    { id: '3', role: 'button', label: 'Help', enabled: true, risk: 'reversible' },
    { id: '4', role: 'textbox', label: 'Name', type: 'text', enabled: true, risk: 'reversible' }] },
  '/about': PAGES['/about'] };
  const ctx = await setup(t, { pages });
  const { structured: page } = await opened(ctx, { task: 'Fill the name', mode: 'reversible',
    policy: { forbid: ['Settings'] }, suppliedText: { name: 'Ada' }, allowedUrls: [`${ORIGIN}/about`] }, 'reversible');
  const has = (result, pattern) => result.actions.some(action => pattern.test(action.description));
  assert.ok(!has(page, /Settings/));
  assert.ok(has(page, /fill .*"Name" with supplied name/));
  assert.ok(has(page, /open https:\/\/example\.com\/about/));
  // An observe without any of them: the restriction, the value and the URL all stay.
  const bare = mcpData(await ctx.mcp.callTool('fai_browser_observe', {}));
  assert.ok(!has(bare, /Settings/), 'an observe without policy never drops the opening restriction');
  assert.ok(has(bare, /fill .*"Name" with supplied name/));
  assert.ok(has(bare, /open https:\/\/example\.com\/about/));
  // Another observe adds a forbidden label: both are refused now.
  const more = mcpData(await ctx.mcp.callTool('fai_browser_observe', { policy: { forbid: ['Help'] } }));
  assert.ok(!has(more, /Settings/) && !has(more, /Help/));
  // The act on that offer lands on a listing under the same terms.
  const fill = more.actions.find(action => /fill/.test(action.description));
  const actedResult = await ctx.mcp.callTool('fai_browser_act', { actionId: fill.id, revision: more.revision });
  const acted = mcpData(actedResult);
  assert.ok(!has(acted, /Settings/) && !has(acted, /Help/));
  assert.doesNotMatch(actedResult.content[0].text, /delta from revision|unchanged from revision/);
  assert.match(actedResult.content[0].text, /page digest:\nHome\nWelcome/);
  assert.equal(ctx.hub.bridgeForTab(1).executions.at(-1).action.text, 'Ada');
  const fullResult = await ctx.mcp.callTool('fai_browser_observe', {});
  assert.doesNotMatch(fullResult.content[0].text, /delta from revision|unchanged from revision/);
  assert.match(fullResult.content[0].text, /page digest:\nHome\nWelcome/);
  assert.ok(has(mcpData(fullResult), /fill .*"Name" with supplied name/));
});

test('long-list direct text deltas keep current action ids and fall back to a full page when that is smaller', () => {
  const previous = {
    requestId: 'req_delta', revision: 'rev:1',
    page: { url: 'https://example.com/form', title: 'Form',
      digest: ['Form', 'Name', 'Submit', ...Array.from({ length: 12 }, (_, i) => `Repeated line ${i}`)] },
    actions: [
      { id: 'a0', description: 'fill "Name" (act with text)' },
      { id: 'a1', description: 'click "Submit"', needsApproval: 'submit' },
      { id: 'a2', description: 'scroll down' },
      ...Array.from({ length: 37 }, (_, i) => ({ id: `a${i + 3}`, description: `open item ${i}` })),
    ],
  };
  const current = {
    ...previous, revision: 'rev:2', status: 'acted', granted: { level: 'full', asked: 'full' },
    verification: { passed: true, expectation: { textIncludes: 'Error' } },
    next: { kind: 'answer', text: 'Verified.' },
    page: { ...previous.page, digest: ['Form', 'Error', ...previous.page.digest.slice(1)], truncated: true },
    actions: [
      previous.actions[0],
      { id: 'a1', description: 'press Enter in "Name" (submits its form)' },
      ...previous.actions.slice(1).map((action, i) => ({ ...action, id: `a${i + 2}` })),
    ],
  };
  const text = directText(current, previous);
  assert.match(text, /next \(answer\): Verified\./);
  assert.match(text, /status: acted, verified: true/);
  assert.match(text, /granted: full \(asked full\)/);
  assert.match(text, /revision: rev:2/);
  assert.match(text, /url\/title: unchanged from revision rev:1/);
  assert.match(text, /page digest \(more on the page: observe with focus or digestChars\):\nForm\nError\nName\nSubmit/);
  assert.doesNotMatch(text, /page digest delta/);
  assert.match(text, /actions delta from revision rev:1 \(changes only; omitted actions keep their ids/);
  assert.match(text, /a1  press Enter/);
  assert.doesNotMatch(text, /a0(?:: unchanged| = a0)/);
  assert.match(text, /a2-a40 = a1-a39/);
  assert.doesNotMatch(text, /a2  click|a3  scroll/);
  assert.ok(text.length < directText(current).length);
  const wire = value => ({ content: [{ type: 'text', text: value }] });
  mcpData(wire(directText(previous)));
  const reconstructed = mcpData(wire(text));
  assert.equal(reconstructed.page.url, current.page.url);
  assert.equal(reconstructed.page.title, current.page.title);
  assert.deepEqual(reconstructed.page.digest, current.page.digest);
  assert.deepEqual(reconstructed.actions, current.actions);
  assert.equal(reconstructed.page.truncated, true);

  const navigated = directText({ ...current, revision: 'rev:3',
    page: { url: 'https://example.com/done', title: 'Done', digest: ['Confirmation', 'Q-123'] },
    actions: [{ id: 'a0', description: 'open https://example.com/form' }] }, current);
  assert.match(navigated, /page digest:\nConfirmation\nQ-123/);
  assert.match(navigated, /actions \(revision rev:3\):\na0  open/);
  assert.doesNotMatch(navigated, /delta from revision/);
});

test('unchanged long offers use a reference without rewriting earlier results', () => {
  const previous = {
    requestId: 'req_unchanged', revision: 'rev:1', status: 'acted',
    page: { url: 'https://example.com/list', title: 'List', digest: ['Results', 'One', 'Two'] },
    actions: Array.from({ length: 45 }, (_, i) => ({ id: `a${i}`, description: `open result ${i}` })),
  };
  const beforeSnapshot = JSON.stringify(previous);
  const beforeText = directText(previous);
  const current = { ...previous, revision: 'rev:2', next: { kind: 'choose', text: 'Choose the next action.' } };
  const text = directText(current, previous);
  assert.match(text, /url\/title: unchanged from revision rev:1/);
  assert.match(text, /page digest: unchanged from revision rev:1/);
  assert.match(text, /actions: unchanged from revision rev:1/);
  assert.doesNotMatch(text, /a\d+(?:-a\d+)?(?:: unchanged| = a\d+)/);
  assert.doesNotMatch(text, /open result 44/);
  assert.equal(JSON.stringify(previous), beforeSnapshot, 'rendering does not mutate the earlier result');
  assert.equal(directText(previous), beforeText, 'rendering a later delta does not rewrite earlier text');

  const wire = value => ({ content: [{ type: 'text', text: value }] });
  mcpData(wire(beforeText));
  const reconstructed = mcpData(wire(text));
  assert.deepEqual(reconstructed.page, { ...current.page, truncated: false });
  assert.deepEqual(reconstructed.actions, current.actions);
  const third = { ...current, revision: 'rev:3' };
  const thirdText = directText(third, current);
  assert.match(thirdText, /actions: unchanged from revision rev:2/);
  assert.deepEqual(mcpData(wire(thirdText)).actions, third.actions, 'references append across revisions');
  assert.deepEqual(mcpData(wire(text)).actions, current.actions, 'the earlier delta still reconstructs');
});

test('small offers stay complete and sparse removals preserve current id mappings', () => {
  const small = {
    requestId: 'req_small', revision: 'rev:1', page: { title: 'Small', digest: ['Small'] },
    actions: [{ id: 'a0', description: 'open "One"' }, { id: 'a1', description: 'open "Two"' }],
  };
  const smallText = directText({ ...small, revision: 'rev:2' }, small);
  assert.match(smallText, /actions \(revision rev:2\):\na0  open "One"\na1  open "Two"/);
  assert.doesNotMatch(smallText, /unchanged from revision|actions delta/);

  const previous = {
    requestId: 'req_removed', revision: 'rev:1', page: { title: 'Large', digest: ['Large'] },
    actions: Array.from({ length: 41 }, (_, i) => ({ id: `a${i}`, description: `open result ${i}` })),
  };
  const current = { ...previous, revision: 'rev:2',
    actions: previous.actions.filter((_, i) => i !== 20).map((action, i) => ({ ...action, id: `a${i}` })) };
  const text = directText(current, previous);
  assert.match(text, /removed: a20/);
  assert.match(text, /a20-a39 = a21-a40/);
  assert.doesNotMatch(text, /a0(?:: unchanged| = a0)/);
  const wire = value => ({ content: [{ type: 'text', text: value }] });
  mcpData(wire(directText(previous)));
  assert.deepEqual(mcpData(wire(text)).actions, current.actions);
});

test('structured result deltas cover records to none, none to records, and neither to neither', () => {
  const results = { list: 0, shown: 3, total: 3, complete: true,
    records: [1, 2, 3].map(i => ({ id: `r${i}`, title: `Result ${i}` })) };
  const previous = {
    requestId: 'req_result_transitions', revision: 'rev:1', status: 'acted',
    page: { url: 'https://example.com/list', title: 'List', digest: ['Results'], results },
    actions: Array.from({ length: 45 }, (_, i) => ({ id: `a${i}`, description: `open result ${i}` })),
  };
  const noResultsPage = { ...previous.page, results: undefined };
  const removed = directText({ ...previous, revision: 'rev:2', page: noResultsPage }, previous);
  assert.match(removed, /^results: none \(all revision rev:1 results removed\)$/m);
  assert.doesNotMatch(removed, /^result r1:/m);

  const empty = { ...previous, revision: 'rev:0', page: noResultsPage };
  const added = directText(previous, empty);
  assert.match(added, /^results: 3 shown, complete$/m);
  assert.match(added, /^result r1: \{"title":"Result 1"\}$/m);
  assert.doesNotMatch(added, /^results: none/m);

  const neither = directText({ ...empty, revision: 'rev:2' }, empty);
  assert.doesNotMatch(neither, /^results:/m);
  assert.doesNotMatch(neither, /^result r\d:/m);
});

test('combined long offers preserve result deltas, sparse action ids, and compact stale errors', () => {
  const results = { list: 0, shown: 3, total: 3, complete: true,
    records: [1, 2, 3].map(i => ({ id: `r${i}`, title: `Result ${i}` })) };
  const previous = {
    requestId: 'req_combined_delta', revision: 'rev:1', status: 'acted',
    page: { url: 'https://example.com/list', title: 'List', digest: ['Results'], results },
    actions: Array.from({ length: 45 }, (_, i) => ({ id: `a${i}`, description: `open result ${i}` })),
  };
  const fullText = directText(previous);
  assert.match(fullText, /^result r3: \{"title":"Result 3"\}$/m);
  const unchanged = { ...previous, revision: 'rev:2' };
  const unchangedText = directText(unchanged, previous);
  assert.match(unchangedText, /^results: unchanged from revision rev:1$/m);
  assert.match(unchangedText, /^actions: unchanged from revision rev:1$/m);

  const wire = value => ({ content: [{ type: 'text', text: value }] });
  mcpData(wire(fullText));
  assert.deepEqual(mcpData(wire(unchangedText)).actions, unchanged.actions);

  const reduced = {
    ...unchanged,
    page: { ...unchanged.page, results: undefined },
    actions: previous.actions.filter((_, i) => i !== 20).map((action, i) => ({ ...action, id: `a${i}` })),
  };
  const removedText = directText(reduced, previous);
  assert.match(removedText, /^results: none \(all revision rev:1 results removed\)$/m);
  assert.match(removedText, /^removed: a20$/m);
  assert.match(removedText, /^a20-a43 = a21-a44$/m);
  assert.deepEqual(mcpData(wire(removedText)).actions, reduced.actions);

  const stale = {
    ...reduced, revision: 'rev:3', status: 'needs_host', code: 'stale',
    next: { kind: 'observe', text: 'Observe again (fai_browser_observe), then choose.' },
    page: { ...reduced.page, results },
  };
  const staleText = directText(stale, previous);
  assert.match(staleText, /^next \(observe\): Observe again/m);
  assert.match(staleText, /^status: needs_host \(stale\)$/m);
  assert.match(staleText, /^revision: rev:3$/m);
  assert.doesNotMatch(staleText, /untrusted|^results:|^result r\d:|^actions|Result 1|removed: a20/m);
});

test('simple pre-dispatch error receipts keep trusted recovery metadata but omit page state', () => {
  const error = {
    requestId: 'req_error', revision: 'rev:2', status: 'needs_host', code: 'stale',
    next: { kind: 'observe', text: 'Observe again (fai_browser_observe), then choose.' },
    verification: { passed: false, expectation: { textIncludes: 'Done' }, hint: 'Not checked: nothing ran.' },
    granted: { level: 'reversible', asked: 'reversible' }, warnings: ['capture_changed'], callsLeft: 3,
    page: { url: 'https://example.com/form', title: 'Form', digest: ['Sensitive page state', 'Submit'] },
    actions: [{ id: 'a0', description: 'click "Submit"', needsApproval: 'submit' }],
  };
  const text = directText(error);
  assert.match(text, /^next \(observe\): Observe again/m);
  assert.match(text, /^status: needs_host \(stale\), verified: false$/m);
  assert.match(text, /^expectation: \{"textIncludes":"Done"\}$/m);
  assert.match(text, /^verification: Not checked: nothing ran\.$/m);
  assert.match(text, /^granted: reversible \(asked reversible\)$/m);
  assert.match(text, /^warning: capture_changed$/m);
  assert.match(text, /^calls left on this request: 3$/m);
  assert.match(text, /^revision: rev:2$/m);
  assert.doesNotMatch(text, /untrusted|Sensitive page state|click|url:|actions/);
  assert.match(directText({ ...error, revision: undefined }), /Sensitive page state/,
    'without a current revision the page state stays available');

  const afterDispatch = directText({ ...error, did: ['click "Submit"'] });
  assert.match(afterDispatch, /did: click "Submit"/);
  assert.match(afterDispatch, /Sensitive page state/);
  const refusal = directText({ ...error, status: 'needs_user', code: 'refused_action',
    next: { kind: 'stop', text: 'Do not retry.' }, needs: { message: 'Ask the user.', control: { label: 'Submit' } } });
  assert.match(refusal, /^needs: Ask the user\.$/m);
  assert.match(refusal, /refused control: Submit/);
  assert.match(refusal, /Sensitive page state/);
});

test('Enter in a filled search field is offered as a search at interactive, never below it', async t => {
  const pages = {
    '/': { title: 'Search', text: 'Find things', controls: [
      { id: '1', role: 'textbox', label: 'Search', type: 'search', enabled: true, risk: 'reversible',
        enter: 'submit_safe', submitHref: `${ORIGIN}/results` },
    ] },
    '/results': { title: 'Results', text: '3 results for cats', controls: [link('1', 'Home', '/')] },
  };
  const ctx = await setup(t, { pages });
  const { structured: page } = await opened(ctx, { task: 'Search for cats', mode: 'interactive',
    suppliedText: { query: 'cats' } }, 'interactive');
  assert.ok(!page.actions.some(action => /press Enter/.test(action.description)), 'an empty field submits nothing');
  const fill = page.actions.find(action => /fill .*"Search"/.test(action.description));
  const filled = mcpData(await ctx.mcp.callTool('fai_browser_act', { actionId: fill.id, revision: page.revision }));
  const enter = filled.actions.find(action => action.description === 'press Enter in textbox "Search" (search)');
  assert.ok(enter, JSON.stringify(filled.actions));
  const done = mcpData(await ctx.mcp.callTool('fai_browser_act', {
    actionId: enter.id, revision: filled.revision, expectation: { urlIncludes: '/results' },
  }));
  assert.equal(done.status, 'completed');
  assert.equal(done.verification.passed, true);
  assert.equal(ctx.hub.bridgeForTab(1).executions.at(-1).action.type, 'submit_field');

  // At reversible a search submit needs a higher level: not offered.
  const low = await setup(t, { pages });
  const { structured: start } = await opened(low, { task: 'Search for cats', mode: 'interactive',
    suppliedText: { query: 'cats' } }, 'reversible');
  const lowFill = start.actions.find(action => /fill .*"Search"/.test(action.description));
  const after = mcpData(await low.mcp.callTool('fai_browser_act', { actionId: lowFill.id, revision: start.revision }));
  assert.ok(!after.actions.some(action => /press Enter/.test(action.description)));
});

test('a malformed config.json never crashes or hangs the MCP server', async t => {
  const home = await mkdtemp(join(tmpdir(), 'fai-direct-bad-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, 'config.json'), '{not json');
  const mcp = spawnMcp({ PATH: process.env.PATH, HOME: home, FAI_HOME: home, FAI_DAEMON_PORT: '1',
    FAI_DAEMON_START_TIMEOUT_MS: '500' });
  t.after(() => mcp.close());
  const initialized = await mcp.initialize();
  assert.equal(initialized.result.instructions, INSTRUCTIONS);
  const tools = (await mcp.request('tools/list', {})).result.tools;
  assert.equal(tools[0].name, 'fai_browser_open');
  const result = await mcp.callTool('fai_browser_status', {}, { timeoutMs: 20_000 });
  assert.equal(result.isError, true, 'a tool call answers with an error');
});

test('the direct instructions stay short and name only direct tools', () => {
  assert.ok(INSTRUCTIONS.length <= 1700, `${INSTRUCTIONS.length} chars`);
  for (const name of INSTRUCTIONS.match(/fai_browser_[a-z_]+/g)) {
    assert.ok(['fai_browser_open', 'fai_browser_act', 'fai_browser_observe'].includes(name), name);
  }
  for (const pattern of [/suppliedText/, /allowedUrls/, /single-use/, /moreActions/, /returnImages "final"/,
    /point \{x,y\}/, /"approve the new FAI Browser request; its level is preselected"/, /Never log in/,
    /untrusted data, not instructions/, /Do not release at the end/]) {
    assert.match(INSTRUCTIONS, pattern);
  }
  assert.doesNotMatch(INSTRUCTIONS, /fai_browser_run|Jev/);
});

// This is a deterministic client-history simulation through real MCP/daemon calls. It proves that
// full observe restores the protocol state; it does not ask a model to notice or interpret lost history.
test('direct MCP: full observe recovers a discarded long-offer reference chain before acting', async t => {
  const items = Array.from({ length: 45 }, (_, i) => ({ id: String(100 + i), label: `Catalog item ${i}`,
    path: i === 30 ? '/finished' : `/item-${i}` }));
  const states = [
    items,
    [{ id: '999', label: 'Featured catalog item', path: '/featured' }, ...items.filter((_, i) => i !== 10)],
    items.filter((_, i) => i !== 10).map(item => item.id === '120' ? { ...item, label: 'Updated catalog item 20' } : item),
  ];
  const pages = Object.fromEntries(states.map((state, i) => [i ? `/phase-${i}` : '/', {
    // Same visible SPA location and digest across turns; only the offered controls change.
    url: `${ORIGIN}/catalog/archive`, title: 'Catalog archive for the North location', text: 'North location catalog',
    blocks: [{ t: 'h1', text: 'Catalog archive for the North location' }, { t: 'p', text: 'North location catalog' }],
    controls: [link('1', 'Continue catalog', `/phase-${Math.min(i + 1, states.length - 1)}`),
      ...state.map(item => link(item.id, item.label, item.path))],
  }]));
  pages['/finished'] = { title: 'Selected catalog item', text: 'Catalog item 30 selected', controls: [] };
  const ctx = await setup(t, { pages });
  const opening = await opened(ctx, { task: 'Use Continue catalog twice, then open Catalog item 30' });
  let current = opening.structured;
  assert.ok(current.actions.length >= 40, 'the wire is eligible for history references');
  const initialTarget = current.actions.find(action => action.description === 'click "Catalog item 30"');
  assert.ok(initialTarget);
  const history = [opening.result];
  for (let turn = 0; turn < 2; turn++) {
    const advance = current.actions.find(action => action.description === 'click "Continue catalog"');
    assert.ok(advance, JSON.stringify(current.actions));
    const previousRevision = current.revision;
    const result = await ctx.mcp.callTool('fai_browser_act', { actionId: advance.id, revision: previousRevision });
    history.push(result);
    const text = result.content[0].text;
    assert.ok(text.includes(`actions delta from revision ${previousRevision}`), 'changed offers reference the preceding turn');
    assert.ok(text.includes(`page digest: unchanged from revision ${previousRevision}`));
    current = mcpData(result);
    assert.equal(current.status, 'acted');
    assert.ok(current.actions.some(action => action.description === 'click "Catalog item 30"'));
  }
  const latest = history.at(-1);
  const currentTarget = current.actions.find(action => action.description === 'click "Catalog item 30"');
  assert.notEqual(currentTarget.id, initialTarget.id, 'discarded ids would identify a different current action');
  assert.ok(current.actions.some(action => action.description === 'click "Updated catalog item 20"'));
  assert.ok(!current.actions.some(action => action.description === 'click "Catalog item 10"'));

  // Discard every reference base. A separately loaded helper has no module-level revision cache;
  // giving it only the latest wire result cannot silently reuse the warm parser's earlier snapshots.
  history.splice(0, history.length - 1);
  const { mcpData: truncatedHost } = await import(`./helpers/mcp-result.js?truncated-history=${opening.requestId}`);
  const incomplete = truncatedHost(latest);
  assert.equal(incomplete.revision, current.revision, 'the trusted current revision survives truncation');
  assert.notDeepEqual(incomplete.actions, current.actions, 'a delta alone does not reconstruct omitted actions');
  assert.notDeepEqual(incomplete.page?.digest, current.page.digest, 'the missing digest base is not manufactured');
  const bridge = ctx.hub.bridgeForTab(1);
  const executions = bridge.executions.length;

  // The recovery call uses the active request, not any missing action or revision. It is read-only,
  // self-contained, and becomes the server's next reference base without constructing a provider.
  const recoveredWire = await ctx.mcp.callTool('fai_browser_observe', {});
  assert.doesNotMatch(recoveredWire.content[0].text, /unchanged from revision|delta from revision/);
  const recovered = truncatedHost(recoveredWire);
  assert.equal(bridge.executions.length, executions, 'recovery observes without executing an action');
  assert.equal(recovered.requestId, opening.requestId);
  assert.equal(recovered.page.url, `${ORIGIN}/catalog/archive`);
  assert.equal(recovered.page.title, 'Catalog archive for the North location');
  assert.deepEqual(recovered.page.digest, current.page.digest);
  assert.deepEqual(recovered.actions, current.actions, 'all current ids and descriptions are restored');
  const continueAction = recovered.actions.find(action => action.description === 'click "Continue catalog"');
  const resumedWire = await ctx.mcp.callTool('fai_browser_act', {
    actionId: continueAction.id, revision: recovered.revision,
  });
  assert.ok(resumedWire.content[0].text.includes(`actions: unchanged from revision ${recovered.revision}`),
    'the next compact response can use the recovered full snapshot');
  const resumed = truncatedHost(resumedWire);
  assert.deepEqual(resumed.actions, recovered.actions);
  const target = resumed.actions.find(action => action.description === 'click "Catalog item 30"');
  assert.equal(target.id, currentTarget.id);
  const finished = truncatedHost(await ctx.mcp.callTool('fai_browser_act', {
    actionId: target.id, revision: resumed.revision, expectation: { urlIncludes: '/finished' },
  }));
  assert.equal(bridge.executions.at(-1).action.target, '130', 'the restored id dispatches the intended current control');
  assert.equal(finished.status, 'completed');
  assert.equal(finished.verification.passed, true);
  assert.equal(finished.page.url, `${ORIGIN}/finished`);
});

test('the wire-test decoder maps sparse old action ids before applying overlapping additions and removals', () => {
  const previous = {
    requestId: 'req_sparse_history', revision: 'old', status: 'acted',
    page: { url: `${ORIGIN}/catalog/archive`, title: 'Catalog archive', digest: ['Catalog archive'] },
    actions: Array.from({ length: 45 }, (_, i) => ({ id: `a${i < 20 ? i : i + 5}`, description: `open catalog entry ${i}` })),
  };
  const current = {
    ...previous, revision: 'new',
    actions: [{ description: 'open newly inserted catalog entry' }, ...previous.actions.filter((_, i) => i !== 10)]
      .map((action, i) => ({ ...action, id: `a${i < 30 ? i : i + 7}` })),
  };
  const wire = text => ({ content: [{ type: 'text', text }] });
  const oldText = directText(previous);
  const deltaText = directText(current, previous);
  assert.match(deltaText, /actions delta from revision old/);
  assert.match(deltaText, /removed: a10/);
  mcpData(wire(oldText));
  assert.deepEqual(mcpData(wire(deltaText)).actions, current.actions);
  assert.deepEqual(mcpData(wire(oldText)).actions, previous.actions, 'the source snapshot stays unchanged');
});
