// Resume wake-up: the exact background command a host runs to be woken when the user resumes or approves a tab.
//
// An MCP server cannot wake an idle host; a host that runs background commands and is notified when one exits (Claude
// Code's Bash run_in_background) can be. `fai-browser wait <requestId> --until active` blocks until the request's lease
// is usable again (exit 0), the request ends (exit 3) or the timeout passes (exit 2). The trusted next.text of every
// "the user acts in the extension, then we continue" relay names this command with real paths.
import { fileURLToPath } from 'node:url';

/** The CLI beside this module (absolute: the host's shell may start anywhere). */
export const CLI_PATH = fileURLToPath(new URL('./cli.js', import.meta.url));
/** The default --timeout of the resume wait: a paused lease expires after 30 minutes (src/daemon.js PAUSED_TTL_MS). */
export const RESUME_WAIT_TIMEOUT = '30m';
// What the CLI must share with this process to reach the same daemon. Never the client token: it stays in its file.
const CARRIED_ENV = ['FAI_HOME', 'FAI_DAEMON_DIR', 'FAI_DAEMON_PORT', 'FAI_BRIDGE_PORT'];

function shellQuote(value) {
  const text = String(value);
  return /^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`;
}

/**
 * The shell command that waits for `requestId` to become active: `[env FAI_HOME=…] <node> <cli.js> wait <id> --until
 * active --timeout 30m`. `execPath` is the node this process runs on (the one install registered for the MCP server);
 * `env` supplies the daemon location variables to carry.
 */
export function resumeWaitCommand(requestId, { env = process.env, execPath = process.execPath, cliPath = CLI_PATH,
  timeout = RESUME_WAIT_TIMEOUT } = {}) {
  const carried = CARRIED_ENV.filter(name => typeof env?.[name] === 'string' && env[name] !== '')
    .map(name => `${name}=${shellQuote(env[name])}`);
  const node = typeof execPath === 'string' && execPath ? execPath : 'node';
  const parts = [node, cliPath, 'wait', String(requestId), '--until', 'active', '--timeout', timeout].map(shellQuote);
  return [...(carried.length ? ['env', ...carried] : []), ...parts].join(' ');
}

/**
 * The trusted sentences that follow "tell the user to click Resume (or approve)": start the wait in the background when
 * the host can be notified on exit, else ask the user to say when. `then` is the step once the tab is ready
 * ("call fai_browser_observe with requestId r1").
 */
export function resumeWaitText(requestId, then, options = {}) {
  return 'If you can run a background command that notifies you when it exits (for example Claude Code\'s Bash '
    + `run_in_background), start \`${resumeWaitCommand(requestId, options)}\` that way now and end your turn; when it `
    + `exits 0 the tab is ready: ${then}. On another exit code follow next.text in its JSON line. Without background `
    + `commands, ask the user to tell you when they are done, then ${then}.`;
}
