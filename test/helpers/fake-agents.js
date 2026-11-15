// Throwaway stand-ins for a coding agent's wake channels (test/wake.test.js, test/invite-mcp.test.js): a fake Claude
// Code messaging socket (auth line + user line, in a temp dir) and a fake `codex` binary that records its argv. No real
// session's socket or binary is ever used.
import net from 'node:net';
import { chmod, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeOrSocket } from './pipe-or-socket.js';
import { MCP_MAIN, spawnMcp } from './mcp-harness.js';

export const TOKEN = 'fake-messaging-token-0123456789ab';

/** Windows MCP integration tests use a real parent image, a private copy of Node named claude.exe. */
export async function spawnClaudeMcp(t, env, { bound = true } = {}) {
  if (process.platform !== 'win32') return spawnMcp(env);
  const dir = await mkdtemp(join(tmpdir(), 'fai-claude-parent-'));
  const bin = join(dir, bound ? 'claude.exe' : 'other.exe');
  const script = join(dir, 'parent.mjs');
  await copyFile(process.execPath, bin);
  await writeFile(script, `import { spawn } from 'node:child_process';
const child = spawn(${JSON.stringify(process.execPath)}, [${JSON.stringify(MCP_MAIN)}], { stdio: 'inherit' });
child.on('error', error => { console.error(error); process.exit(1); });
child.on('exit', code => process.exit(code ?? 1));
`);
  const mcp = spawnMcp(env, { bin, args: [script] });
  t.after(async () => {
    await mcp.close();
    await rm(dir, { recursive: true, force: true });
  });
  return mcp;
}

/**
 * A fake Claude Code messaging socket: reads newline-delimited JSON, checks the auth line, records the user lines.
 * `mode`: accept (default), refuse (answers an error line and closes), silent (accepts, never reads or closes).
 */
// `pid`: the socket is named `<pid>.sock`, as Claude Code names it after its own pid; an MCP server accepts it only when
// that pid is its parent (src/wake.js claudeSocket).
export async function startFakeClaudeSocket(t, { mode = 'accept', token = TOKEN, pid = process.pid } = {}) {
  const { path, dir } = await pipeOrSocket(t, `${pid}.sock`);
  const received = [];
  const connections = [];
  const server = net.createServer(socket => {
    connections.push(socket);
    if (mode === 'silent') {
      socket.pause();
      return;
    }
    let buffer = '';
    let authed = false;
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        const message = JSON.parse(line);
        if (!authed) {
          authed = message.type === 'auth' && message.token === token;
          // `echo`, `echo-refuse`: a session that repeats the token back (FAI must never pass it on).
          if (mode === 'echo') socket.write(`${JSON.stringify({ type: 'note', got: message.token })}\n`);
          if (mode === 'echo-refuse') {
            socket.end(`${JSON.stringify({ type: 'error', message: `bad token ${message.token}` })}\n`);
            return;
          }
          if (!authed || mode === 'refuse') {
            socket.end(`${JSON.stringify({ type: 'error', message: mode === 'refuse' ? 'crossSessionInbound is refuse' : 'unauthorized' })}\n`);
            return;
          }
          continue;
        }
        received.push(message);
      }
    });
    socket.on('end', () => socket.end());
    socket.on('error', () => {});
  });
  await new Promise(resolve => server.listen(path, resolve));
  t.after(async () => {
    for (const socket of connections) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  return { path, token, received, dir };
}

/** A fake `codex` that records its argv (one JSON line per call) and answers per FAKE_CODEX_MODE. */
export async function fakeCodex(t, { mode = 'ok' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'fai-fake-codex-'));
  const bin = join(dir, 'codex');
  const log = join(dir, 'argv.log');
  await writeFile(bin, `#!${process.execPath}
const fs = require('fs');
fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ argv: process.argv.slice(2), fai: Object.keys(process.env).filter(k => k.startsWith('FAI_')) }) + '\\n');
const args = process.argv.slice(2);
if (args[0] === 'queue' && args[1] === '--help') { console.log('Usage: codex queue [OPTIONS] --thread <THREAD> --message <TEXT>'); process.exit(0); }
const mode = process.env.FAKE_CODEX_MODE || 'ok';
if (mode === 'unknown') { console.error('Error: no rollout found for thread ' + args[2]); process.exit(1); }
if (mode === 'crash') { console.error('boom'); process.exit(3); }
process.exit(0);
`);
  await chmod(bin, 0o755);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { PATH: '/usr/bin:/bin', FAI_CODEX_BIN: bin, FAKE_CODEX_LOG: log, FAKE_CODEX_MODE: mode, FAI_CLIENT_TOKEN: 'never-passed' };
  const calls = async () => {
    try {
      return (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    } catch {
      return [];
    }
  };
  return { bin, env, calls, dir };
}
