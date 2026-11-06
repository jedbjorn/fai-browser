// Regression guard: no test, script or bench browser may reach the user's desktop session. Every Chromium launch is
// headless and passes headlessEnv() (scripts/headless-env.mjs), which drops DISPLAY, WAYLAND_DISPLAY and
// DBUS_SESSION_BUS_ADDRESS; with them, headless Chromium 153's browser process still connects to the Wayland compositor
// and the session bus. A stdio server that starts a headless browser itself (Playwright MCP in bench condition A) goes
// through headlessCommand(). The runtime case checks the property itself on Linux: after a popup-style fill, no process
// of the launched browser holds a Wayland, X11 or session bus connection.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { SESSION_VARIABLES, headlessCommand, headlessEnv } from '../scripts/headless-env.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HEADLESS = [/headless: true\b/, /headless: !args\.headed\b/];
const VISIBLE = new RegExp('headless: ' + 'false'); // Built from parts so this file does not match itself.
const ENV = [/env: headlessEnv\(\)/, /env: args\.headed \? process\.env : headlessEnv\(\)/];

function sources(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'results', 'fixtures', '.git'].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(path));
    else if (/\.(m?js)$/.test(entry.name)) out.push(path);
  }
  return out;
}

// The argument text of each `chromium.launch(...)`, `.launchPersistentContext(...)` and `.launchServer(...)` call.
function launchCalls(source) {
  const calls = [];
  const pattern = /chromium\.launch(?:PersistentContext|Server)?\(/g;
  for (let match; (match = pattern.exec(source));) {
    let depth = 1, i = match.index + match[0].length;
    for (; i < source.length && depth; i++) depth += source[i] === '(' ? 1 : source[i] === ')' ? -1 : 0;
    calls.push({ index: match.index, text: source.slice(match.index, i) });
  }
  return calls;
}

test('headlessEnv drops the session variables and leaves the input untouched', () => {
  const input = { DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0', WAYLAND_SOCKET: '5',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus', HOME: '/home/x', PATH: '/bin' };
  const env = headlessEnv(input);
  for (const name of SESSION_VARIABLES) assert.equal(name in env, false, name);
  assert.deepEqual(env, { HOME: '/home/x', PATH: '/bin' });
  assert.equal(input.DISPLAY, ':0');
});

test('headlessCommand unsets the session variables in the child only', () => {
  const server = headlessCommand('playwright-mcp', ['--headless']);
  assert.equal(server.command, 'env');
  assert.deepEqual(server.args, [...SESSION_VARIABLES.flatMap(name => ['-u', name]), 'playwright-mcp', '--headless']);
  if (process.platform === 'linux') {
    const out = execFileSync(server.command, [...server.args.slice(0, -2), 'sh', '-c', 'echo "${DISPLAY-unset}|${DBUS_SESSION_BUS_ADDRESS-unset}"'],
      { encoding: 'utf8', env: { ...process.env, DISPLAY: ':9', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/x' } });
    assert.equal(out.trim(), 'unset|unset');
  }
});

test('every stdio server that passes --headless to a browser goes through headlessCommand()', () => {
  let count = 0;
  for (const file of ['test', 'scripts', 'bench'].flatMap(dir => sources(join(ROOT, dir)))) {
    if (file === fileURLToPath(import.meta.url)) continue;
    const source = readFileSync(file, 'utf8');
    if (!source.includes("'--headless'")) continue;
    const name = relative(ROOT, file);
    const servers = source.split('\n').map((text, index) => ({ text, line: index + 1 }))
      .filter(({ text }) => (/Server = /.test(text) && /serverArgs/.test(text))
        || /headlessCommand\(.*'--headless'/.test(text));
    assert.ok(servers.length, `${name} passes --headless but has no recognized headlessCommand server; update this guard`);
    for (const { text, line } of servers) {
      count++;
      assert.match(text, /headlessCommand\(/, `${name}:${line} starts a headless browser server without headlessCommand()`);
    }
  }
  assert.ok(count >= 2, `found only ${count} headless servers; the scan no longer matches bench/compare.mjs`);
});

test('every Chromium launch in test/, scripts/ and bench/ is headless and passes headlessEnv()', () => {
  let count = 0;
  for (const file of ['test', 'scripts', 'bench'].flatMap(dir => sources(join(ROOT, dir)))) {
    const source = readFileSync(file, 'utf8');
    const name = relative(ROOT, file);
    assert.doesNotMatch(source, VISIBLE, `${name} launches a visible browser`);
    for (const call of launchCalls(source)) {
      if (file === fileURLToPath(import.meta.url) && !call.text.includes('executablePath')) continue;
      count++;
      const line = source.slice(0, call.index).split('\n').length;
      assert.ok(HEADLESS.some(re => re.test(call.text)), `${name}:${line} launches Chromium without headless: true`);
      assert.ok(ENV.some(re => re.test(call.text)), `${name}:${line} launches Chromium without env: headlessEnv()`);
    }
  }
  assert.ok(count >= 20, `found only ${count} launches; the scan pattern no longer matches the launch sites`);
});

// Socket inodes held by `pid` and its descendants.
function treeSockets(pid) {
  const children = new Map();
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const ppid = Number(readFileSync(`/proc/${entry}/stat`, 'utf8').split(') ')[1].split(' ')[1]);
      if (!children.has(ppid)) children.set(ppid, []);
      children.get(ppid).push(Number(entry));
    } catch { /* The process exited while scanning. */ }
  }
  const sockets = new Set();
  for (const stack = [pid]; stack.length;) {
    const current = stack.pop();
    stack.push(...(children.get(current) || []));
    try {
      for (const fd of readdirSync(`/proc/${current}/fd`)) {
        const match = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${current}/fd/${fd}`));
        if (match) sockets.add(match[1]);
      }
    } catch { /* The process exited while scanning. */ }
  }
  return sockets;
}

// Session sockets (Wayland, X11 or the session bus) whose peer is one of `sockets`. `ss -xa` lists the server end with
// its path and the client's inode as the peer.
const sessionBus = [/^unix:path=([^,;]+)/.exec(process.env.DBUS_SESSION_BUS_ADDRESS || '')?.[1],
  process.env.XDG_RUNTIME_DIR && join(process.env.XDG_RUNTIME_DIR, 'bus')].filter(Boolean);
function sessionPeers(sockets) {
  return execFileSync('ss', ['-xa'], { encoding: 'utf8' }).split('\n').map(line => line.trim().split(/\s+/))
    .filter(cols => cols.length >= 8 && (/wayland|X11-unix/.test(cols[4]) || sessionBus.includes(cols[4]))
      && sockets.has(cols[7])).map(cols => cols[4]);
}

const executablePath = process.env.CHROMIUM_PATH || '/usr/bin/chromium';
const hasSs = (() => { try { execFileSync('ss', ['-V'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const runtimeSkip = process.platform !== 'linux' ? 'Linux only'
  : !existsSync(executablePath) ? `Chromium not found at ${executablePath}`
  : !hasSs ? 'ss (iproute2) not available'
  : !SESSION_VARIABLES.some(name => process.env[name]) ? 'no desktop session in the environment' : false;

test('a test browser holds no Wayland, X11 or session bus connection after a popup-style fill', { skip: runtimeSkip }, async () => {
  const server = await chromium.launchServer({ executablePath, headless: true, env: headlessEnv(), args: ['--no-sandbox'] });
  const browser = await chromium.connect(server.wsEndpoint());
  try {
    const page = await browser.newPage();
    await page.setContent('<input id="testing-origin">');
    await page.fill('#testing-origin', 'http://headless-guard.invalid');
    await page.fill('#testing-origin', 'http://headless-guard.invalid/2');
    const sockets = treeSockets(server.process().pid);
    assert.ok(sockets.size > 0, 'could not read the browser process tree');
    assert.deepEqual(sessionPeers(sockets), [], 'the test browser is connected to the desktop session');
  } finally {
    await browser.close();
    await server.close();
  }
});
