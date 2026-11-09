// Opt-in: the FAI pi extension inside a real pi (@earendil-works/pi-coding-agent 1.2.0+) in RPC mode with pi's built-in
// faux model (no API key, no network), against a real FAI daemon with a fake browser hub. Skipped unless FAI_PI_CLI names
// pi's cli.js, for example:
//
//   npm install --prefix /tmp/pi-test --ignore-scripts @earendil-works/pi-coding-agent
//   FAI_PI_CLI=/tmp/pi-test/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js \
//     node --test test/pi-host.test.js
//
// pi runs with HOME, PI_CODING_AGENT_DIR and XDG_RUNTIME_DIR all inside one temp dir: ~/.pi is never read or written.
// One pi process; run it alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createDaemon } from '../src/daemon.js';
import { homePaths, saveDriver } from '../src/home.js';
import { MCP_ENTRY, piLoader } from '../src/install.js';
import { call, createFakeHub } from './helpers/fake-hub.js';
import { ORIGIN, link } from './runtime-fixtures.js';

const PI_CLI = process.env.FAI_PI_CLI;
const FAUX = resolve(import.meta.dirname, 'helpers', 'pi-faux.js');
const PAGES = { '/': { title: 'Home', text: 'Hello', controls: [link('1', 'About', '/about')] } };

async function until(predicate, what, ms = 20_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(50);
  }
}

test('pi: the extension registers FAI, the model sees the instructions, an invite wakes an idle session, '
  + 'a new session re-registers, nothing is left behind', { skip: PI_CLI ? false : 'set FAI_PI_CLI to run against a real pi',
  timeout: 180_000 }, async t => {
  // Short: the socket path must stay under 100 bytes.
  const root = mkdtempSync('/tmp/fai-pih-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dirs = Object.fromEntries(['home', 'agent', 'run', 'fai', 'project'].map(name => [name, join(root, name)]));
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const loader = join(root, 'fai-loader.js');
  writeFileSync(loader, piLoader({ command: process.execPath, args: [MCP_ENTRY] }));
  const fauxLog = join(root, 'faux.jsonl');
  writeFileSync(fauxLog, '');

  saveDriver('agent', homePaths({ home: dirs.fai, env: {} }));
  const hub = createFakeHub({ bridgeOptions: { pages: PAGES } });
  const daemon = createDaemon({ home: dirs.fai, env: {}, port: 0, hub, providerFactory: () => { throw new Error('no provider'); } });
  await daemon.listen();
  t.after(() => daemon.close());
  const api = (method, path, body) => call(daemon.port, method, path, body, { token: daemon.token });
  const sessions = async () => (await api('GET', '/v1/status')).body.sessions ?? [];

  // Built from scratch: no API key, no real agent's variables, no real home.
  const env = { PATH: process.env.PATH, HOME: dirs.home, PI_CODING_AGENT_DIR: dirs.agent, PI_TELEMETRY: '0', PI_OFFLINE: '1',
    XDG_RUNTIME_DIR: dirs.run, FAI_HOME: dirs.fai, FAI_DAEMON_PORT: String(daemon.port), FAI_MCP_APPROVAL_WAIT_MS: '1500',
    FAUX_LOG: fauxLog };
  const pi = spawn(process.execPath, [PI_CLI, '--mode', 'rpc', '--offline', '--no-session', '-e', loader, '-e', FAUX,
    '--provider', 'faux', '--model', 'faux-1'], { cwd: dirs.project, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const events = [];
  let stdout = '';
  let stderr = '';
  pi.stdout.setEncoding('utf8');
  pi.stdout.on('data', chunk => {
    stdout += chunk;
    let index;
    while ((index = stdout.indexOf('\n')) >= 0) {
      const line = stdout.slice(0, index);
      stdout = stdout.slice(index + 1);
      try {
        events.push(JSON.parse(line));
      } catch {
        events.push({ raw: line });
      }
    }
  });
  pi.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
  const exited = new Promise(resolveExit => pi.once('exit', resolveExit));
  t.after(async () => {
    if (pi.exitCode === null && pi.signalCode === null) pi.kill('SIGKILL');
    await exited;
  });
  const send = command => pi.stdin.write(`${JSON.stringify(command)}\n`);
  const modelCalls = () => readFileSync(fauxLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const settled = () => events.filter(event => event.type === 'agent_settled').length;
  const fail = what => `${what}; pi stderr: ${stderr}; notes: ${JSON.stringify(events.filter(e => /notify|ui/.test(e.type ?? e.method ?? '')))}`;

  // 1. The extension registered the server with its wake socket: the registry shows pi and pi-socket.
  const first = await until(async () => (await sessions()).find(item => item.host === 'pi' && item.wake === 'pi-socket'),
    fail('the pi session in the registry'));
  assert.equal(first.repo, 'project');
  const sockets = readdirSync(dirs.run).filter(name => name.startsWith('fai-pi-'));
  assert.equal(sockets.length, 1);
  assert.ok(existsSync(join(dirs.run, sockets[0], `${pi.pid}.sock`)), 'named after pi\'s pid');

  // 2. A prompt: the FAI tools are declared directly, the instructions section is in the system prompt, a call works.
  send({ id: 'p1', type: 'prompt', message: 'CALLSTATUS please' });
  await until(() => settled() >= 1, fail('the first turn'));
  const calls = modelCalls();
  assert.ok(calls[0].tools.includes('mcp__fai_browser__fai_browser_open'), JSON.stringify(calls[0].tools));
  assert.equal(calls[0].faiSection, true, 'the FAI instructions (with pi\'s tool names) reach the model');
  const toolEnd = events.find(event => event.type === 'tool_execution_end' && event.toolName === 'mcp__fai_browser__fai_browser_status');
  assert.ok(toolEnd, 'the status tool ran');
  assert.ok(!toolEnd.isError, JSON.stringify(toolEnd).slice(0, 400));

  // 3. An invite while pi is idle: the wake starts a new turn with FAI's text, and pi acknowledged it.
  const before = settled();
  const reply = await hub.emit({ type: 'invite', tabId: 7, origin: ORIGIN, title: 'Home', level: 'reversible',
    sessionId: first.sessionId, text: 'Summarise this page' });
  assert.ok(reply.invite?.inviteId, JSON.stringify(reply));
  const woken = await until(() => modelCalls().find(entry => entry.lastUser.startsWith('[FAI Browser] The user invited you')),
    fail('the wake turn'));
  assert.match(woken.lastUser, new RegExp(`mcp__fai_browser__fai_browser_open with \\{"inviteId": "${reply.invite.inviteId}"\\}`));
  assert.match(woken.lastUser, /"Summarise this page"/);
  await until(() => settled() > before, fail('the wake turn to settle'));
  const view = await until(() => hub.published.at(-1)?.find(item => item.requestId === reply.requestId)?.invite?.wake,
    'the invite view');
  assert.equal(view.state, 'delivered');
  assert.equal(view.detail, 'turn');

  // 4. A new session: pi restarts the server with the new session's socket; the old entry leaves the registry.
  send({ id: 'n1', type: 'new_session' });
  const second = await until(async () => {
    const list = await sessions();
    return list.length === 1 && list[0].sessionId !== first.sessionId && list[0].wake === 'pi-socket' ? list[0] : null;
  }, fail('the new session\'s registration'));
  assert.equal(second.host, 'pi');
  await until(() => readdirSync(dirs.run).filter(name => name.startsWith('fai-pi-')).length === 1,
    'one socket dir (the double session_start is idempotent)');

  // 5. SIGTERM: pi shuts the session down, the socket dir goes, the server leaves the registry.
  pi.kill('SIGTERM');
  await exited;
  await until(() => readdirSync(dirs.run).filter(name => name.startsWith('fai-pi-')).length === 0, 'the socket dir removed',
    5_000);
  await until(async () => (await sessions()).length === 0, 'the registry entry gone', 15_000);
});
