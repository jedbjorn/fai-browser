#!/usr/bin/env node
// `fai-browser-mcp`: the FAI Browser MCP server on stdio. Hosts start it; see `fai-browser install --host ...`.
import { startMcpServer } from './mcp.js';

const server = startMcpServer({ stdin: process.stdin, stdout: process.stdout, env: process.env });
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    server.close();
  });
}
process.stdout.on('error', () => {
  server.close();
});
await server.done;
await new Promise(resolveWrite => process.stdout.write('', resolveWrite));
process.exit(0);
