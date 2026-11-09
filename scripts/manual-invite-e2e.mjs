#!/usr/bin/env node
// Manual end-to-end check of "Invite agent" against a real Claude Code (not in CI, not in npm test; it costs a few
// model calls). It starts a private FAI daemon (temp FAI_HOME, any free port) with the fake hub standing in for the
// extension, and a throwaway `claude -p --input-format stream-json` session (haiku by default) in a temp directory with
// only this repository's MCP server, no session persistence and an environment built from scratch (no CLAUDE_* or
// FAI_* variable of the shell that runs it, so no real session's socket is ever reachable). It waits for that MCP server
// to register with the wake capability `claude-socket`, makes an invite for it, and passes when the idle session takes a
// new turn and calls fai_browser_open with the invite id.
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
await writeFile(mcpConfig, JSON.stringify({ mcpServers: { fai: { type: 'stdio', command: process.execPath,
  args: [join(ROOT, 'src', 'mcp-main.js')], env: { FAI_HOME: home, FAI_DAEMON_PORT: String(daemon.port) } } } }));

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
  console.log(`wake ${wake.wake.state}; invite ${wake.state}`);
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
