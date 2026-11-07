import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { finished } from 'node:stream/promises';

// Only this segment's process group is signalled; the existing browser daemon is never targeted.
export async function runPilotProcess({ command = 'codex', args, prompt, dir, timeoutMs, signal, onEvent }) {
  if (signal?.aborted) return { exitCode: null, signal: null, events: [], cancelled: true, timedOut: false, spawnError: null, wallMs: 0 };
  const output = createWriteStream(dir + '/events.jsonl', { mode: 0o600 });
  const errors = createWriteStream(dir + '/stderr.txt', { mode: 0o600 });
  const timed = createWriteStream(dir + '/timed-events.jsonl', { mode: 0o600 });
  const started = performance.now();
  const events = [];
  let cancelled = false, timedOut = false, buffer = '', killTimer, spawnError = null;
  const child = spawn(command, args, { detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const stop = () => {
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    killTimer ??= setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 3000);
  };
  const abort = () => { cancelled = true; stop(); };
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
  const line = text => {
    if (!text.trim()) return;
    output.write(text + '\n');
    timed.write(JSON.stringify({ atMs: performance.now() - started, text }) + '\n');
    try { const event = JSON.parse(text); events.push(event); onEvent?.(event); } catch {}
  };
  child.stdout.setEncoding('utf8').on('data', chunk => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) { line(buffer.slice(0, i)); buffer = buffer.slice(i + 1); }
  });
  child.stderr.pipe(errors, { end: false });
  child.stdin.on('error', () => {});
  child.stdin.end(prompt);
  child.on('error', error => { spawnError = error.message; });
  if (signal?.aborted) abort();
  const result = await new Promise(resolve => child.on('close', (exitCode, childSignal) => resolve({ exitCode, signal: childSignal })));
  clearTimeout(timer); clearTimeout(killTimer);
  signal?.removeEventListener('abort', abort);
  if (buffer) line(buffer);
  output.end(); errors.end(); timed.end();
  await Promise.all([finished(output), finished(errors), finished(timed)]);
  return { ...result, events, cancelled, timedOut, spawnError, wallMs: performance.now() - started };
}
