import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createDaemon } from '../src/daemon.js';
import { DEFAULT_DRIVER, homePaths, loadConfig, readDriver, saveDriver } from '../src/home.js';
import { ALWAYS_LOAD_META, INSTRUCTIONS, JEV_INSTRUCTIONS, directText } from '../src/mcp.js';
import { call, createFakeHub } from './helpers/fake-hub.js';
import { spawnMcp } from './helpers/mcp-harness.js';
import { mcpData } from './helpers/mcp-result.js';
import { ORIGIN, PAGES, link, clickProvider } from './runtime-fixtures.js';

async function setup(t, { driver = 'agent', pages = PAGES, providerFactory,
  env = { TYPESAFE_API_KEY: 'dummy-key-for-isolated-test' } } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'fai-direct-'));
  const paths = homePaths({ home, env: {} });
  if (driver) saveDriver(driver, paths);
  const hub = createFakeHub({ bridgeOptions: { pages } });
  let providers = 0;
  const daemon = createDaemon({ home, env, port: 0, hub,
    providerFactory: (...args) => {
      providers++;
      if (providerFactory) return providerFactory(...args);
      throw new Error('Agent direct must never construct a provider');
    } });
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
  return { home, paths, daemon, hub, mcp, initialized, api, providers: () => providers };
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

test('the default driver is the agent; a saved choice is kept and validated', async t => {
  assert.equal(DEFAULT_DRIVER, 'agent');
  const home = await mkdtemp(join(tmpdir(), 'fai-driver-config-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const paths = homePaths({ home, env: {} });
  assert.equal(loadConfig(paths).driver, 'agent', 'no config.json: your agent drives');
  await writeFile(paths.config, JSON.stringify({ budget: { maxCalls: 7 }, outputDir: 'relative-artifacts' }));
  assert.equal(loadConfig(paths).driver, 'agent', 'a config without a driver: your agent drives');
  saveDriver('jev', paths);
  assert.deepEqual(JSON.parse(await readFile(paths.config, 'utf8')),
    { budget: { maxCalls: 7 }, outputDir: 'relative-artifacts', driver: 'jev' });
  assert.equal((await stat(paths.config)).mode & 0o777, 0o600);
  assert.equal(loadConfig(paths).driver, 'jev');
  assert.throws(() => saveDriver('testing', paths), /driver must be/);
  await writeFile(paths.config, '{bad');
  assert.throws(() => saveDriver('agent', paths), /not valid JSON/);
  assert.equal(await readFile(paths.config, 'utf8'), '{bad');
  assert.deepEqual(readDriver(paths).driver, 'agent', 'readDriver never throws: the default');
  assert.match(readDriver(paths).error, /not valid JSON/);
});

test('direct MCP: open waits for approval and observes; acts are host-chosen, lean and verified without a provider', async t => {
  const ctx = await setup(t);
  assert.equal(ctx.initialized.result.instructions, INSTRUCTIONS);
  const tools = (await ctx.mcp.request('tools/list', {})).result.tools;
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
  assert.equal(ctx.providers(), 0, 'not even startup/approval warm-up or the act guard constructed Jev');
  const status = (await ctx.api('GET', '/v1/status')).body;
  assert.equal(status.driver, 'agent');
  assert.equal(status.provider.default, null);
  assert.equal(status.provider.keyConfigured, true, 'a saved key cannot re-enable the provider');
  const mcpStatus = mcpData(await ctx.mcp.callTool('fai_browser_status', {}));
  assert.equal(mcpStatus.driver, 'agent');
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
  assert.match(result.next.text, /fai_browser_open again/);
  assert.equal(ctx.hub.bridges.size, 0);
  assert.equal(ctx.providers(), 0);
});

test('direct control keeps the user grant, policy restrictions and refusal of unoffered actions', async t => {
  const pages = { '/': { title: 'Home', text: 'Welcome', controls: [link('1', 'About', '/about'),
    { id: '2', role: 'button', label: 'Settings', enabled: true, risk: 'reversible' },
    { id: '3', role: 'button', label: 'Buy now', enabled: true, risk: 'reversible' }] } };
  const ctx = await setup(t, { pages });
  const { structured: page, text, requestId } = await opened(ctx, { task: 'Read the home page', mode: 'full',
    policy: { forbid: ['About'] } });
  assert.ok(!page.actions.some(action => /About|Settings|Buy now/.test(action.description)));
  assert.deepEqual(page.granted, { level: 'read-only', asked: 'full' });
  assert.match(text, /^granted: read-only \(asked full\)$/m);
  const refused = await ctx.mcp.callTool('fai_browser_act', { actionId: 'forged', revision: page.revision });
  assert.equal(refused.isError, true);
  assert.equal(ctx.hub.bridgeForTab(1).executions.length, 0);
  const run = await ctx.api('POST', '/v1/runs', { requestId, instruction: 'Open About', provider: 'typesafe' });
  assert.equal(run.status, 409);
  assert.equal(run.body.error.code, 'agent_direct');
  assert.match(run.body.error.message, /experimental Jev driver/);
  assert.equal(ctx.providers(), 0);
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
  assert.match(text, /actions delta from revision rev:1/);
  assert.match(text, /a0: unchanged\na1  press Enter/);
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

test('switching to direct clears a retained provider; switching back restores delegation', async t => {
  let decisions = 0;
  const pages = { '/': { title: 'Home', text: 'Welcome', controls: [
    { id: '1', role: 'button', label: 'Settings', enabled: true, risk: 'reversible' },
  ] } };
  const provider = { async decide(page, actions) {
    decisions++;
    return { actionId: actions.find(action => action.label === 'Settings')?.id ?? 'done', confidence: 1 };
  } };
  const ctx = await setup(t, { driver: 'jev', pages, providerFactory: () => provider });
  const requestId = (await ctx.api('POST', '/v1/requests', {
    origins: [ORIGIN], reason: 'Open settings', mode: 'reversible',
  })).body.requestId;
  await ctx.hub.approve(requestId, { level: 'reversible' });
  const act = async () => {
    const page = (await ctx.api('POST', '/v1/observe', { requestId, mode: 'reversible', capture: false })).body;
    const settings = page.actions.find(action => action.label === 'Settings');
    assert.ok(settings);
    return ctx.api('POST', '/v1/act', { requestId, actionId: settings.id,
      revision: page.revision, expectation: { titleEquals: 'Home' }, capture: 'none' });
  };
  await act();
  assert.ok(decisions > 0);
  saveDriver('agent', ctx.paths);
  const reloaded = await ctx.api('POST', '/v1/daemon/reload', {});
  assert.equal(reloaded.status, 200);
  assert.equal(reloaded.headers['x-fai-driver'], 'agent', 'every authenticated answer names the driver');
  const before = decisions;
  const made = ctx.providers();
  assert.equal((await act()).body.result.status, 'completed');
  assert.equal(decisions, before);
  assert.equal(ctx.providers(), made);
  saveDriver('jev', ctx.paths);
  assert.equal((await ctx.api('POST', '/v1/daemon/reload', {})).status, 200);
  await act();
  assert.ok(decisions > before);
});

test('switching to direct interrupts an active Jev run without waiting for it', async t => {
  let entered;
  const deciding = new Promise(resolve => { entered = resolve; });
  let aborted = false;
  const ctx = await setup(t, { driver: 'jev', providerFactory: () => ({
    decide(page, actions, context, signal) {
      entered();
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          reject(signal.reason);
        }, { once: true });
      });
    },
  }) });
  const requestId = (await ctx.api('POST', '/v1/requests', { origins: [ORIGIN], reason: 'Read About' })).body.requestId;
  await ctx.hub.approve(requestId);
  const started = await ctx.api('POST', '/v1/runs', { requestId, instruction: 'Open About', waitMs: 0 });
  await deciding;
  saveDriver('agent', ctx.paths);
  assert.equal((await ctx.api('POST', '/v1/daemon/reload', {})).status, 200);
  assert.equal(aborted, true, 'the provider request is aborted at once');
  const ended = await ctx.api('POST', '/v1/wait', { runId: started.body.runId, maxMs: 3000 });
  assert.equal(ended.body.state, 'done');
  assert.equal(ctx.hub.bridgeForTab(1).executions.length, 0);
});

test('the extension toggle persists the choice and an already-running MCP server follows the daemon both ways', async t => {
  const ctx = await setup(t, { driver: 'jev', providerFactory: () => clickProvider(['About']) });
  assert.equal(ctx.initialized.result.instructions, JEV_INSTRUCTIONS);
  const hello = await ctx.hub.emit({ type: 'hello', session: null });
  assert.deepEqual(hello.control, { driver: 'jev', jevAvailable: true });
  const direct = await ctx.hub.emit({ type: 'driver', driver: 'agent' });
  assert.equal(direct.control.driver, 'agent');
  assert.equal(loadConfig(ctx.paths).driver, 'agent');
  const before = ctx.providers();
  // The host still holds the Jev tool list: its run opens the task instead.
  const opening = ctx.mcp.callTool('fai_browser_run', {
    origins: [ORIGIN], reason: 'Read About', instruction: 'Open About',
  });
  await ctx.hub.approve((await pendingRequest(ctx.hub)).requestId);
  const observed = await opening;
  assert.equal(mcpData(observed).status, 'observed');
  assert.equal(ctx.providers(), before);
  assert.equal(ctx.hub.bridgeForTab(1).executions.length, 0);
  assert.match(observed.content[0].text, /switched FAI Browser to "Your agent"/);
  // The first result after the switch summarizes the new mode's instructions in one line.
  assert.match(observed.content[0].text, /fai_browser_act \(actionId; text for fills/);
  assert.match(observed.content[0].text, /Approve once/);
  assert.doesNotMatch(observed.content[0].text, /\n/);
  assert.ok(ctx.mcp.messages.some(message => message.method === 'notifications/tools/list_changed'));
  const listed = (await ctx.mcp.request('tools/list', {})).result.tools.map(tool => tool.name);
  assert.ok(listed.includes('fai_browser_open') && !listed.includes('fai_browser_run'));
  const back = await ctx.hub.emit({ type: 'driver', driver: 'jev' });
  assert.equal(back.control.driver, 'jev');
  const delegated = await ctx.mcp.callTool('fai_browser_run', {
    instruction: 'Open About', expectation: { urlIncludes: '/about' },
  });
  assert.equal(mcpData(delegated).status, 'completed');
  assert.match(delegated.content[0].text, /experimental Jev autopilot/);
  assert.match(delegated.content[0].text, /one fai_browser_run .*expectation.*Purchases are refused/);
  assert.ok(ctx.providers() > before);
});

test('MCP takes the driver from the daemon, not from config.json on its own', async t => {
  const ctx = await setup(t, { driver: 'agent' });
  // config.json now says jev, but the daemon has not reloaded it: the daemon's agent wins.
  saveDriver('jev', ctx.paths);
  const mcp = spawnMcp({ FAI_HOME: ctx.home, FAI_DAEMON_PORT: String(ctx.daemon.port) });
  t.after(() => mcp.close());
  await mcp.initialize();
  const status = await mcp.callTool('fai_browser_status', {});
  assert.equal(mcpData(status).driver, 'agent');
  const listed = (await mcp.request('tools/list', {})).result.tools.map(tool => tool.name);
  assert.ok(listed.includes('fai_browser_open'), listed.join(', '));
  assert.ok(!listed.includes('fai_browser_run'));
});

test('a malformed config.json never crashes or hangs the MCP server: the default driver, logged', async t => {
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
  assert.match(mcp.stderr, /config\.json unreadable, using the agent driver/);
  const result = await mcp.callTool('fai_browser_status', {}, { timeoutMs: 20_000 });
  assert.equal(result.isError, true, 'a tool call answers with an error');
});

test('a missing Jev key or invalid driver leaves the saved choice unchanged; reconnect never overrides it', async t => {
  const ctx = await setup(t, { env: {} });
  const unavailable = await ctx.hub.emit({ type: 'driver', driver: 'jev' });
  assert.equal(unavailable.error.code, 'key_missing');
  const invalid = await ctx.hub.emit({ type: 'driver', driver: 'testing' });
  assert.equal(invalid.error.code, 'invalid_driver');
  assert.equal(loadConfig(ctx.paths).driver, 'agent');
  const reconnected = await ctx.hub.emit({ type: 'hello', session: null, settings: { driver: 'jev' } });
  assert.deepEqual(reconnected.control, { driver: 'agent', jevAvailable: false });
  assert.equal(ctx.providers(), 0);
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
