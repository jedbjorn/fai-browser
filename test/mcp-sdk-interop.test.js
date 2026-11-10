// Drives fai-browser-mcp through the official MCP SDK client. Skipped when the optional devDependency is absent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startStubDaemon } from './helpers/stub-daemon.js';
import { MCP_MAIN } from './helpers/mcp-harness.js';
import { mcpData } from './helpers/mcp-result.js';

let sdk = null;
try {
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/stdio.js'),
  ]);
  sdk = { Client, StdioClientTransport };
} catch {
  sdk = null;
}

test('the MCP SDK client can list and call every core tool', { skip: !sdk && 'no @modelcontextprotocol/sdk' }, async t => {
  const stub = await startStubDaemon({ autoGrant: true });
  t.after(() => stub.close());
  const transport = new sdk.StdioClientTransport({ command: process.execPath, args: [MCP_MAIN], env: stub.env(),
    stderr: 'pipe' });
  const client = new sdk.Client({ name: 'sdk-interop', version: '1.0.0' });
  await client.connect(transport);
  t.after(() => client.close());
  assert.equal(client.getServerVersion().name, 'fai-browser');
  assert.match(client.getInstructions(), /tab the user approves/);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 7);
  // The per-tool eager-load hint survives the wire and the SDK's schema parsing, on the loop's tools only.
  const eager = tools.filter(tool => tool._meta?.['anthropic/alwaysLoad'] === true).map(tool => tool.name);
  assert.deepEqual(eager, ['fai_browser_open', 'fai_browser_act', 'fai_browser_observe']);

  const opened = await client.callTool({ name: 'fai_browser_open', arguments: {
    origins: ['https://example.com'], reason: 'Interop check', task: 'Open About',
  } });
  const page = mcpData(opened);
  assert.equal(page.status, 'observed');
  assert.equal(opened.structuredContent, undefined);
  const acted = await client.callTool({ name: 'fai_browser_act', arguments: { actionId: 'a0', revision: page.revision } });
  assert.notEqual(acted.isError, true, JSON.stringify(acted.content));
  const waited = await client.callTool({ name: 'fai_browser_wait', arguments: { maxMs: 2000 } });
  assert.equal(mcpData(waited).state, 'active');
  const bad = await client.callTool({ name: 'fai_browser_open', arguments: { origins: [] } });
  assert.equal(bad.isError, true);
  const released = await client.callTool({ name: 'fai_browser_release', arguments: { requestId: page.requestId } });
  assert.equal(mcpData(released).state, 'released');
});
