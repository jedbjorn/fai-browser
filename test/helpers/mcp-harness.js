// Spawns the real `fai-browser-mcp` entrypoint over stdio pipes and speaks newline-delimited JSON-RPC to it.
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

export const MCP_MAIN = resolve(import.meta.dirname, '..', '..', 'src', 'mcp-main.js');

export function spawnMcp(env) {
  const child = spawn(process.execPath, [MCP_MAIN], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const messages = [];
  const waiters = [];
  let buffer = '';
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', chunk => {
    stderr += chunk;
  });
  child.stdout.setEncoding('utf8').on('data', chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const message = JSON.parse(line); // Throws (fails the test) on any non-JSON stdout.
      messages.push(message);
      for (const waiter of [...waiters]) {
        if (waiter.match(message)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(message);
        }
      }
    }
  });
  const exited = new Promise(resolveExit => child.on('exit', code => resolveExit(code)));
  let nextId = 0;

  function waitFor(match, timeoutMs = 10_000) {
    const existing = messages.find(match);
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise((resolveWait, reject) => {
      const waiter = { match, resolve: resolveWait };
      waiters.push(waiter);
      setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) {
          waiters.splice(index, 1);
          reject(new Error(`no matching MCP message within ${timeoutMs} ms; stderr: ${stderr}`));
        }
      }, timeoutMs).unref();
    });
  }

  function send(message) {
    child.stdin.write(`${typeof message === 'string' ? message : JSON.stringify(message)}\n`);
  }

  function request(method, params, { id = ++nextId, timeoutMs } = {}) {
    send({ jsonrpc: '2.0', id, method, params });
    return waitFor(message => message.id === id && !message.method, timeoutMs);
  }

  async function initialize(protocolVersion = '2025-11-25') {
    const response = await request('initialize', {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: 'test-host', version: '1' },
    });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return response;
  }

  async function callTool(name, args = {}, { meta, id, timeoutMs } = {}) {
    const params = { name, arguments: args };
    if (meta) {
      params._meta = meta;
    }
    const response = await request('tools/call', params, { id, timeoutMs });
    return response.result ?? response;
  }

  async function close() {
    child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
    const code = await exited;
    clearTimeout(timer);
    return code;
  }

  return {
    child, messages, send, request, initialize, callTool, waitFor, close, exited,
    get stderr() {
      return stderr;
    },
    nextId: () => ++nextId,
  };
}
