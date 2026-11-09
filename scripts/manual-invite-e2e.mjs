#!/usr/bin/env node
// Manual end-to-end check of "Invite agent" against a real Claude Code (not in CI, not in npm test; it costs a few
// model calls). It starts a private FAI daemon (temp FAI_HOME, any free port) with the fake hub standing in for the
// extension, and a throwaway `claude -p --input-format stream-json` session (haiku by default) in a temp directory with
// only this repository's MCP server, no session persistence and an environment built from scratch (no CLAUDE_* or
// FAI_* variable of the shell that runs it, so no real session's socket is ever reachable). It waits for that MCP server
// to register with the wake capability `claude-socket`, makes an invite for it, and passes when the idle session takes a
// new turn and calls fai_browser_open with the invite id. A second, tiny MCP server in the same throwaway session
// probes what its socket answers (a wrong token; the auth line alone) and writes that to the temp dir, so a delivered
// message can be told from a held or refused one if the socket says anything at all.
//
//   node scripts/manual-invite-e2e.mjs [--model haiku] [--timeout 120]
//
// Needs `claude` (CLAUDE_BIN overrides) logged in, and about 1 GB of free memory.
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createDaemon } from '../src/daemon.js';
import { homePaths, saveDriver } from '../src/home.js';
import { createFakeHub, call } from '../test/helpers/fake-hub.js';

const ROOT = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const model = option('--model', 'haiku');
const timeoutMs = Number(option('--timeout', '120')) * 1000;
const ORIGIN = 'https://example.com';
const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms));

const home = await mkdtemp(join(tmpdir(), 'fai-invite-e2e-home-'));
const work = await mkdtemp(join(tmpdir(), 'fai-invite-e2e-work-'));
saveDriver('agent', homePaths({ home, env: {} }));
const hub = createFakeHub();
const daemon = createDaemon({ home, env: {}, port: 0, hub, providerFactory: () => { throw new Error('no provider'); } });
await daemon.listen();
const api = (method, path, body) => call(daemon.port, method, path, body, { token: daemon.token });

const mcpConfig = join(work, 'mcp.json');
const probeFile = join(work, 'probe.json');
const probeScript = join(work, 'probe.cjs');
// The probe: an MCP server with no tools that, once started, connects to its own session's socket twice (a wrong
// token; the right token with no message) and records the bytes the session writes back. It sends no user message.
await writeFile(probeScript, `const net = require('net'); const fs = require('fs');
const out = ${JSON.stringify(probeFile)}; const results = {};
let buf = ''; process.stdin.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1);
  let m; try { m = JSON.parse(line); } catch { continue; }
  const send = r => process.stdout.write(JSON.stringify(Object.assign({ jsonrpc: '2.0', id: m.id }, r)) + '\\n');
  if (m.method === 'initialize') send({ result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'probe', version: '0' } } });
  else if (m.method === 'tools/list') send({ result: { tools: [] } }); else if (m.id !== undefined && m.method) send({ result: {} }); } });
function attempt(name, lines) { return new Promise(done => { const path = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
  if (!path) { results[name] = 'no socket'; return done(); } let got = ''; const s = net.connect({ path });
  s.setEncoding('utf8'); s.on('data', c => { got += c; }); s.on('error', e => { results[name] = 'error ' + e.code; done(); });
  s.on('connect', () => { s.write(lines.map(l => JSON.stringify(l)).join('\\n') + '\\n'); s.end(); });
  s.on('close', () => { if (!(name in results)) results[name] = got.slice(0, 300) || '(nothing, closed)'; done(); });
  setTimeout(() => { if (!(name in results)) { results[name] = got.slice(0, 300) || '(nothing, still open after 3 s)'; s.destroy(); done(); } }, 3000); }); }
setTimeout(async () => { await attempt('wrongToken', [{ type: 'auth', token: 'not-the-token' }]);
  await attempt('authOnly', [{ type: 'auth', token: process.env.CLAUDE_CODE_MESSAGING_TOKEN || '' }]);
  fs.writeFileSync(out, JSON.stringify(results)); }, 3000);
`);
await writeFile(mcpConfig, JSON.stringify({ mcpServers: {
  fai: { type: 'stdio', command: process.execPath, args: [join(ROOT, 'src', 'mcp-main.js')],
    env: { FAI_HOME: home, FAI_DAEMON_PORT: String(daemon.port) } },
  probe: { type: 'stdio', command: process.execPath, args: [probeScript] },
} }));

// From scratch: what claude needs to run and find its login, nothing of this shell's session.
const env = {};
for (const key of ['PATH', 'HOME', 'USER', 'LANG', 'TERM', 'XDG_CONFIG_HOME', 'XDG_RUNTIME_DIR']) {
  if (process.env[key]) env[key] = process.env[key];
}
const claude = spawn(process.env.CLAUDE_BIN || 'claude', ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json',
  '--verbose', '--model', model, '--mcp-config', mcpConfig, '--strict-mcp-config', '--no-session-persistence',
  '--allowedTools', 'mcp__fai__fai_browser_open', 'mcp__fai__fai_browser_status'], { cwd: work, env, stdio: ['pipe', 'pipe', 'pipe'] });
const events = [];
let buffer = '';
claude.stdout.setEncoding('utf8').on('data', chunk => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    try {
      events.push(JSON.parse(line));
    } catch {
      // Not JSON.
    }
  }
});
claude.stderr.resume();
const say = text => claude.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`);

async function until(predicate, what) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline || claude.exitCode !== null) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}

let passed = false;
try {
  say('Reply with the word READY and nothing else.');
  await until(() => events.some(event => event.type === 'result'), 'the first turn');
  const session = await until(async () => (await api('GET', '/v1/status')).body.sessions
    ?.find(item => item.host === 'claude'), 'the MCP server to register');
  console.log(`session ${session.sessionId}: host ${session.host}, wake ${session.wake}`);
  if (session.wake !== 'claude-socket') throw new Error('this Claude Code gives its MCP servers no messaging socket');
  const reply = await hub.emit({ type: 'invite', tabId: 7, origin: ORIGIN, title: 'Manual e2e', level: 'read-only',
    sessionId: session.sessionId, text: 'Tell me the page title.' });
  const inviteId = reply.invite.inviteId;
  console.log(`invite ${inviteId} made; waiting for the session to wake and join it`);
  const used = await until(() => events.find(event => event.type === 'assistant' && event.message?.content?.some?.(part =>
    part.type === 'tool_use' && /fai_browser_open$/.test(part.name) && part.input?.inviteId === inviteId)), 'fai_browser_open with the invite');
  passed = Boolean(used);
  const wake = (await api('GET', `/v1/requests/${reply.requestId}`)).body.invite;
  console.log(`wake ${wake.wake.state}${wake.wake.detail ? ` (the socket answered: ${wake.wake.detail})` : ' (the socket answered nothing)'}; invite ${wake.state}`);
  try {
    const { readFile } = await import('node:fs/promises');
    console.log(`socket probe: ${await readFile(probeFile, 'utf8')}`);
  } catch {
    console.log('socket probe: no result');
  }
} catch (error) {
  console.error(`FAIL: ${error.message}`);
} finally {
  claude.stdin.end();
  claude.kill('SIGTERM');
  await daemon.close();
  await rm(home, { recursive: true, force: true });
  await rm(work, { recursive: true, force: true });
}
console.log(passed ? 'PASS: the invite woke the idle session and it joined' : 'FAIL');
process.exit(passed ? 0 : 1);
