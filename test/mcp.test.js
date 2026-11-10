// The MCP server's protocol handling against a stub daemon: JSON-RPC errors, unknown and removed tools, argument
// validation before any daemon route, the per-call deadline and an unreachable daemon. The open/observe/act loop
// itself is covered by test/agent-direct.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStubDaemon } from './helpers/stub-daemon.js';
import { spawnMcp } from './helpers/mcp-harness.js';
import { mcpError } from './helpers/mcp-result.js';

const ORIGIN = 'https://example.com';

async function setup(t, behavior = {}, extraEnv = {}) {
  const stub = await startStubDaemon(behavior);
  const mcp = spawnMcp(stub.env(extraEnv));
  t.after(async () => {
    mcp.child.kill('SIGKILL');
    await stub.close();
  });
  await mcp.initialize();
  return { stub, mcp };
}

test('malformed JSON-RPC and removed or unknown tools are protocol errors; bad arguments are tool errors', async t => {
  const { stub, mcp } = await setup(t);
  mcp.send('{ not json');
  const parse = await mcp.waitFor(message => message.error?.code === -32700);
  assert.equal(parse.id, null);
  mcp.send({ jsonrpc: '1.0', id: 'x', method: 'ping' });
  assert.equal((await mcp.waitFor(message => message.id === 'x')).error.code, -32600);
  mcp.send([{ jsonrpc: '2.0', id: 'b', method: 'ping' }]);
  assert.equal((await mcp.waitFor(message => message.error?.code === -32600 && message.id === null)).id, null);
  assert.equal((await mcp.request('resources/list', {})).error.code, -32601);
  // The removed Jev tools are unknown like any other name.
  for (const name of ['fai_browser_nope', 'fai_browser_request_tab', 'fai_browser_step', 'fai_browser_run', 'fai_browser_stop']) {
    assert.equal((await mcp.request('tools/call', { name, arguments: {} })).error.code, -32602, name);
  }
  const tools = (await mcp.request('tools/list', {})).result.tools.map(tool => tool.name);
  assert.ok(!tools.includes('fai_browser_run') && !tools.includes('fai_browser_stop'), tools.join(', '));

  const extra = await mcp.callTool('fai_browser_status', { verbose: true });
  assert.equal(extra.isError, true);
  assert.equal(extra.structuredContent, undefined);
  assert.match(extra.content[0].text, /not a supported parameter/);
  const badOrigin = await mcp.callTool('fai_browser_open', { origins: ['https://example.com/path'], reason: 'x' });
  assert.equal(badOrigin.isError, true);
  const longReason = await mcp.callTool('fai_browser_open', { origins: [ORIGIN], reason: 'x'.repeat(201) });
  assert.match(longReason.content[0].text, /at most 200/);
  const jevShaped = await mcp.callTool('fai_browser_open', { origins: [ORIGIN], reason: 'x', instruction: 'Go' });
  assert.match(jevShaped.content[0].text, /not a supported parameter/);
  assert.equal(stub.calls.filter(call => call.path !== '/v1/health').length, 0, 'invalid calls never reach routes');
});

test('every call is bounded by FAI_MCP_MAX_CALL_MS', async t => {
  const { mcp } = await setup(t, { hang: new Set(['GET /v1/status']) }, { FAI_MCP_MAX_CALL_MS: '500' });
  const started = Date.now();
  const hung = await mcp.callTool('fai_browser_status');
  assert.ok(Date.now() - started < 2000, `status answered after ${Date.now() - started} ms`);
  assert.equal(hung.isError, true);
  assert.equal(mcpError(hung).code, 'timeout');
});

test('an unreachable daemon is a tool error', async t => {
  const sockets = new Set();
  const blocker = net.createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
  });
  await new Promise(resolveListen => blocker.listen(0, '127.0.0.1', resolveListen));
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    blocker.close();
  });
  const home = await mkdtemp(join(tmpdir(), 'fai-mcp-empty-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const lonely = spawnMcp({ PATH: process.env.PATH, HOME: home, FAI_HOME: home,
    FAI_DAEMON_PORT: String(blocker.address().port), FAI_DAEMON_START_TIMEOUT_MS: '1500' });
  t.after(() => lonely.child.kill('SIGKILL'));
  await lonely.initialize();
  const unreachable = await lonely.callTool('fai_browser_status', {}, { timeoutMs: 15_000 });
  assert.equal(unreachable.isError, true);
  assert.match(mcpError(unreachable).code, /daemon_unreachable|port_in_use|timeout/);
  await lonely.close();
});
