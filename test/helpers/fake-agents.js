// Throwaway stand-ins for a coding agent's wake channels (test/wake.test.js, test/invite-mcp.test.js): a fake Claude
// Code messaging socket (auth line + user line, in a temp dir) and a fake `codex` binary that records its argv. No real
// session's socket or binary is ever used.
import net from 'node:net';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const TOKEN = 'fake-messaging-token-0123456789ab';

/**
 * A fake Claude Code messaging socket: reads newline-delimited JSON, checks the auth line, records the user lines.
 * `mode`: accept (default), refuse (answers an error line and closes), silent (accepts, never reads or closes).
 */
// `pid`: the socket is named `<pid>.sock`, as Claude Code names it after its own pid; an MCP server accepts it only when
// that pid is its parent (src/wake.js claudeSocket).
export async function startFakeClaudeSocket(t, { mode = 'accept', token = TOKEN, pid = process.pid } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'fai-fake-cc-'));
  const path = join(dir, `${pid}.sock`);
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

/**
 * A fake FAI pi extension socket (src/pi-wake.js protocol), `<pid>.sock` in a short temp dir under /tmp (unix socket
 * paths are limited to about 104 bytes). `mode`: accept (answers ok, delivery turn or `delivery`), refuse (an error
 * line, code `code`), silent (reads, never answers), no-ack (reads both lines, closes without a line), echo-token (an
 * error line that repeats the token, which FAI must scrub).
 */
export async function startFakePiSocket(t, { mode = 'accept', token = TOKEN, pid = process.pid, delivery = 'turn',
  code = 'busy_limit' } = {}) {
  const dir = await mkdtemp(join('/tmp', 'fai-fpi-'));
  const path = join(dir, `${pid}.sock`);
  const received = [];
  const connections = [];
  const server = net.createServer(socket => {
    connections.push(socket);
    let buffer = '';
    let authed = false;
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    socket.on('data', chunk => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        const message = JSON.parse(line);
        if (!authed) {
          if (mode === 'echo-token') {
            socket.end(`${JSON.stringify({ type: 'error', code: `unauthorized ${message.token}` })}\n`);
            return;
          }
          authed = message.type === 'auth' && message.v === 1 && message.token === token;
          if (!authed) {
            socket.end(`${JSON.stringify({ type: 'error', code: 'unauthorized' })}\n`);
            return;
          }
          continue;
        }
        received.push(message);
        if (mode === 'silent') return;
        if (mode === 'no-ack') {
          socket.end();
          return;
        }
        if (mode === 'refuse') {
          socket.end(`${JSON.stringify({ type: 'error', code })}\n`);
          return;
        }
        socket.end(`${JSON.stringify({ type: 'ok', delivery })}\n`);
      }
    });
  });
  await new Promise(resolve => server.listen(path, resolve));
  t.after(async () => {
    for (const socket of connections) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  return { path, token, received, dir };
}
