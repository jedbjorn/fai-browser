// Condition R, "real install": FAI Browser as a user's Claude Code has it after `fai-browser install --host claude`.
// Condition B inlines the loop guidance in the prompt and runs `claude -p --tools ""`, so Claude Code never defers the
// FAI tools behind ToolSearch and never loads the skill; R keeps both, so those host turns show up in the numbers.
//
// The workspace gets the installer's own files (.mcp.json and .claude/skills/fai-browser/), and the server entry
// passed with --mcp-config is the installer's Claude entry plus the bench's per-run env. `tools` picks how the
// entry loads the tools:
//   run       what `install --host claude` writes (the default): no key; the server's _meta keeps only
//             fai_browser_run eager, the other six stay behind ToolSearch
//   eager     what `install --host claude --always-load` writes: "alwaysLoad": true, every FAI tool in the first
//             request
//   deferred  "alwaysLoad": false: every FAI tool behind ToolSearch, as for an install made before alwaysLoad
import { applyPlan, hostEntry, planInstall, SERVER_NAME } from '../../src/install.js';

export const REAL_TOOLS = Object.freeze(['run', 'eager', 'deferred']);
export const REAL_SERVER_NAME = SERVER_NAME;

/** The --mcp-config document for condition R. `server` is {command, args, env}. */
export function realInstallMcpConfig(server, { tools = 'run' } = {}) {
  if (!REAL_TOOLS.includes(tools)) {
    throw new Error(`--real-tools must be one of ${REAL_TOOLS.join(', ')}`);
  }
  const env = server.env && Object.keys(server.env).length ? server.env : undefined;
  const entry = hostEntry('claude', { command: server.command, args: server.args ?? [], env },
    { alwaysLoad: tools === 'eager' });
  if (tools === 'deferred') {
    entry.alwaysLoad = false;
  }
  return { mcpServers: { [SERVER_NAME]: entry } };
}

/** Runs the real installer (project scope) in `workdir`. Resolves the applied writes. */
export async function installIntoWorkspace(workdir, { tools = 'run', execPath = process.execPath } = {}) {
  const plan = planInstall({
    host: 'claude', scope: 'project', cwd: workdir, alwaysLoad: tools === 'eager', env: {}, home: workdir, execPath,
  });
  return applyPlan(plan);
}
