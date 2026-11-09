// The FAI pi extension (integrations/pi/fai-browser.js) against a fake `pi` and a fake session ctx: no pi installation.
// Sockets live in a test-owned runtime dir under /tmp (removed after each test); the wake side is the real
// deliverPiSocket from src/wake.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import activate, { sweepStale, versionAtLeast } from '../integrations/pi/fai-browser.js';
import { deliverPiSocket } from '../src/wake.js';

const SESSION_A = '01a1c20b-3ac0-7271-9837-9f9f0bd19838';
const SESSION_B = '01a1c20b-3ac0-7271-9837-9f9f0bd19839';
const OPTIONS = { command: '/usr/bin/node', args: ['/opt/fai-browser/src/mcp-main.js'], env: { FAI_HOME: '/opt/fai-home' } };

function runtimeDir(t) {
  const dir = mkdtempSync('/tmp/fai-pit-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakePi({ registerMcpServer = true, tools = [] } = {}) {
  const handlers = new Map();
  const pi = {
    registrations: [],
    sent: [],
    tools,
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    sendUserMessage(text, options) {
      pi.sent.push(options === undefined ? [text] : [text, options]);
    },
    getAllTools() {
      return pi.tools;
    },
    async emit(event, payload, ctx) {
      for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
    },
  };
  if (registerMcpServer) pi.registerMcpServer = (name, config) => pi.registrations.push({ name, config });
  return pi;
}

function fakeCtx({ sessionId = SESSION_A, idle = true, cwd = '/nowhere', trusted = false } = {}) {
  const ctx = {
    idle,
    notes: [],
    hasUI: true,
    cwd,
    isIdle: () => ctx.idle,
    isProjectTrusted: () => trusted,
    sessionManager: { getSessionId: () => ctx.sessionId },
    ui: { notify: (message, type) => ctx.notes.push([message, type]) },
    sessionId,
  };
  return ctx;
}

async function started(t, { deps = {}, options = OPTIONS, pi = fakePi(), ctx = fakeCtx() } = {}) {
  const runtime = deps.runtime ?? runtimeDir(t);
  const agentDir = deps.agentDir ?? join(runtime, 'agent');
  await activate(pi, options, { version: '1.5.0', env: { XDG_RUNTIME_DIR: runtime }, agentDir, ...deps });
  await pi.emit('session_start', { type: 'session_start', reason: 'startup' }, ctx);
  t.after(() => pi.emit('session_shutdown', { type: 'session_shutdown' }, ctx));
  return { pi, ctx, runtime, registration: pi.registrations.at(-1) };
}

const wake = (env, text = '[FAI Browser] The user resumed tab request req_1.') =>
  deliverPiSocket({ path: env.FAI_PI_WAKE_SOCKET, token: env.FAI_PI_WAKE_TOKEN, text });

test('session_start: a 0700 dir with <pid>.sock, and the server registered with the three wake variables', async t => {
  const { pi, runtime, registration } = await started(t);
  assert.equal(pi.registrations.length, 1);
  assert.equal(registration.name, 'fai-browser');
  const { config } = registration;
  assert.equal(config.command, '/usr/bin/node');
  assert.deepEqual(config.args, ['/opt/fai-browser/src/mcp-main.js']);
  assert.equal(config.exposure, 'direct');
  assert.ok(config.timeout >= 120, 'FAI calls may wait for approval longer than pi\'s 60 s default');
  assert.equal(config.env.FAI_HOME, '/opt/fai-home');
  assert.equal(config.env.FAI_PI_SESSION_ID, SESSION_A);
  assert.match(config.env.FAI_PI_WAKE_TOKEN, /^[A-Za-z0-9_-]{43}$/);
  const socket = config.env.FAI_PI_WAKE_SOCKET;
  assert.ok(socket.startsWith(`${runtime}/fai-pi-`));
  assert.ok(socket.endsWith(`/${process.pid}.sock`));
  const dir = lstatSync(join(socket, '..'));
  assert.equal(dir.mode & 0o777, 0o700);
  assert.ok(lstatSync(socket).isSocket());
});

test('wakes: a wrong token is refused; idle starts a turn, busy queues a follow-up', async t => {
  const { pi, ctx, registration } = await started(t);
  const env = registration.config.env;
  const wrong = await deliverPiSocket({ path: env.FAI_PI_WAKE_SOCKET, token: 'x'.repeat(43), text: '[FAI Browser] x' });
  assert.deepEqual([wrong.ok, wrong.message], [false, 'unauthorized']);
  assert.equal(pi.sent.length, 0);

  assert.deepEqual(await wake(env), { ok: true, reply: 'turn' });
  assert.deepEqual(pi.sent.at(-1), ['[FAI Browser] The user resumed tab request req_1.', { expandPromptTemplates: false }]);
  ctx.idle = false;
  assert.deepEqual(await wake(env, '[FAI Browser] busy'), { ok: true, reply: 'followUp' });
  assert.deepEqual(pi.sent.at(-1), ['[FAI Browser] busy', { deliverAs: 'followUp', expandPromptTemplates: false }]);
});

test('wakes: text without the prefix, too long or with control characters is refused; 12 a minute', async t => {
  const { pi, registration } = await started(t);
  const env = registration.config.env;
  // Raw lines, bypassing deliverPiSocket's own check, to prove the extension checks too.
  const { connect } = await import('node:net');
  const raw = text => new Promise(resolve => {
    const socket = connect({ path: env.FAI_PI_WAKE_SOCKET });
    let answer = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => { answer += chunk; });
    socket.on('close', () => resolve(answer.trim()));
    socket.on('connect', () => socket.write(`${JSON.stringify({ type: 'auth', v: 1, token: env.FAI_PI_WAKE_TOKEN })}\n`
      + `${JSON.stringify({ type: 'wake', text })}\n`));
  });
  for (const text of ['/reload please', `[FAI Browser] ${'x'.repeat(4000)}`, '[FAI Browser] a\u001b[2J', '[FAI Browser] a\rb']) {
    assert.equal(await raw(text), '{"type":"error","code":"bad_text"}');
  }
  assert.equal(pi.sent.length, 0);
  for (let i = 0; i < 12; i += 1) assert.equal((await wake(env)).ok, true);
  const limited = await wake(env);
  assert.deepEqual([limited.ok, limited.message], [false, 'busy_limit']);
  assert.equal(pi.sent.length, 12);
});

test('a double session_start keeps one socket and one registration; a new session id replaces the socket', async t => {
  const { pi, ctx, runtime, registration } = await started(t);
  await pi.emit('session_start', { type: 'session_start', reason: 'new' }, ctx);
  assert.equal(pi.registrations.length, 1, 'the observed double fire (pi 1.5.0 RPC new_session) is a no-op');
  assert.equal(readdirSync(runtime).filter(name => name.startsWith('fai-pi-')).length, 1);

  // Two at once (not awaited one by one): still one.
  await Promise.all([pi.emit('session_start', {}, ctx), pi.emit('session_start', {}, ctx)]);
  assert.equal(pi.registrations.length, 1);

  ctx.sessionId = SESSION_B;
  await pi.emit('session_start', { type: 'session_start', reason: 'new' }, ctx);
  assert.equal(pi.registrations.length, 2);
  const next = pi.registrations.at(-1).config.env;
  assert.equal(next.FAI_PI_SESSION_ID, SESSION_B);
  assert.notEqual(next.FAI_PI_WAKE_TOKEN, registration.config.env.FAI_PI_WAKE_TOKEN);
  assert.equal(existsSync(registration.config.env.FAI_PI_WAKE_SOCKET), false, 'the old socket is gone');
  assert.equal(readdirSync(runtime).filter(name => name.startsWith('fai-pi-')).length, 1);
  assert.equal((await wake(registration.config.env)).code, 'no_socket');
  assert.equal((await wake(next)).ok, true);
});

test('shutdown removes the dir and later wakes find nothing', async t => {
  const { pi, ctx, runtime, registration } = await started(t);
  await pi.emit('session_shutdown', { type: 'session_shutdown' }, ctx);
  assert.equal(readdirSync(runtime).filter(name => name.startsWith('fai-pi-')).length, 0);
  assert.equal((await wake(registration.config.env)).code, 'no_socket');
});

test('stale sibling dirs of dead pids are swept; live ones, foreign names and socketless dirs stay', t => {
  const base = runtimeDir(t);
  const make = (name, file) => {
    const dir = join(base, name);
    mkdirSync(dir, { mode: 0o700 });
    if (file) writeFileSync(join(dir, file), '');
    return dir;
  };
  const dead = make('fai-pi-dead01', '4000000.sock');
  const live = make('fai-pi-live01', `${process.ppid}.sock`);
  const empty = make('fai-pi-empty1');
  const other = make('other-dir', '4000000.sock');
  sweepStale(base, { pid: process.pid, alive: pid => pid !== 4000000 });
  assert.equal(existsSync(dead), false);
  assert.ok(existsSync(live) && existsSync(empty) && existsSync(other));
});

test('the stale sweep runs on session_start', async t => {
  const runtime = runtimeDir(t);
  const dead = join(runtime, 'fai-pi-dead02');
  mkdirSync(dead, { mode: 0o700 });
  // A pid above the kernel's pid_max (4194304) never runs.
  writeFileSync(join(dead, '4999999.sock'), '');
  await started(t, { deps: { runtime } });
  assert.equal(existsSync(dead), false);
});

test('a listen failure registers the server without wake variables and does not throw', async t => {
  const long = mkdtempSync(join('/tmp', `fai-pil-${'x'.repeat(90)}-`));
  t.after(() => rmSync(long, { recursive: true, force: true }));
  const { registration } = await started(t, { deps: { bases: [long] } });
  assert.deepEqual(Object.keys(registration.config.env), ['FAI_HOME']);
  assert.deepEqual(readdirSync(long), [], 'no directory left behind');
});

test('an env value pi would interpolate is dropped; an unsafe command registers nothing', async t => {
  const { registration } = await started(t, { options: { ...OPTIONS, env: { FAI_HOME: '$HOME/x', OTHER: '!cmd' } } });
  assert.equal(registration.config.env.FAI_HOME, undefined);
  assert.equal(registration.config.env.OTHER, undefined);
  assert.ok(registration.config.env.FAI_PI_WAKE_TOKEN, 'the wake still works');

  const pi = fakePi();
  const ctx = fakeCtx();
  await started(t, { pi, ctx, options: { command: '!touch /tmp/pwned', args: [] } });
  assert.equal(pi.registrations.length, 0);
  assert.match(ctx.notes[0][0], /re-run `fai-browser install --host pi`/);
});

test('an old pi (no registerMcpServer, or below 1.2.0) is told once and nothing starts', async t => {
  for (const [pi, version] of [[fakePi({ registerMcpServer: false }), '1.5.0'], [fakePi(), '1.1.9']]) {
    const runtime = runtimeDir(t);
    const ctx = fakeCtx();
    await activate(pi, OPTIONS, { version, env: { XDG_RUNTIME_DIR: runtime }, agentDir: join(runtime, 'agent') });
    await pi.emit('session_start', {}, ctx);
    await pi.emit('session_start', {}, ctx);
    assert.deepEqual(ctx.notes, [['FAI Browser needs pi 1.2.0 or newer', 'warning']]);
    assert.equal(pi.registrations.length, 0);
    assert.deepEqual(readdirSync(runtime), []);
  }
  assert.equal(versionAtLeast('1.5.0', '1.2.0'), true);
  assert.equal(versionAtLeast('1.2.0', '1.2.0'), true);
  assert.equal(versionAtLeast('0.99.0', '1.2.0'), false);
  assert.equal(versionAtLeast('garbage', '1.2.0'), false);
});

test('before_agent_start copies the server instructions into a prompt section, with the tool-name line', async t => {
  const pi = fakePi({ tools: [
    { name: 'read', namespace: undefined },
    { name: 'mcp__fai_browser__fai_browser_open', namespace: { name: 'mcp__fai_browser', instructions: 'Use FAI like so.' } },
  ] });
  await started(t, { pi });
  const event = { systemPromptOptions: { sections: {} } };
  await pi.emit('before_agent_start', event);
  assert.match(event.systemPromptOptions.sections['fai-browser'], /^Use FAI like so\.\npi: FAI's tools are named mcp__fai_browser__/);
  // A server that already names pi's tool names is copied as it is.
  pi.tools[1].namespace.instructions = `mcp__fai_browser__ ${'y'.repeat(5000)}`;
  await pi.emit('before_agent_start', event);
  assert.equal(event.systemPromptOptions.sections['fai-browser'].length, 4096);
  const none = { systemPromptOptions: { sections: {} } };
  pi.tools = [];
  await pi.emit('before_agent_start', none);
  assert.deepEqual(none.systemPromptOptions.sections, {});
});

test('an mcp.json fai-browser entry is reported once (user file, and the project file only when trusted)', async t => {
  const runtime = runtimeDir(t);
  const agentDir = join(runtime, 'agent');
  mkdirSync(agentDir);
  writeFileSync(join(agentDir, 'mcp.json'), `﻿${JSON.stringify({ mcpServers: { 'fai-browser': { command: 'x' } } })}`);
  const { ctx } = await started(t, { deps: { runtime, agentDir } });
  assert.match(ctx.notes[0][0], /mcp\.json fai-browser entry overrides the FAI extension/);

  const project = runtimeDir(t);
  mkdirSync(join(project, '.pi'));
  writeFileSync(join(project, '.pi', 'mcp.json'), JSON.stringify({ mcpServers: { 'fai-browser': { command: 'x' } } }));
  const untrusted = await started(t, { ctx: fakeCtx({ cwd: project, trusted: false }) });
  assert.deepEqual(untrusted.ctx.notes, []);
  const trusted = await started(t, { ctx: fakeCtx({ cwd: project, trusted: true }) });
  assert.equal(trusted.ctx.notes.length, 1);
});
