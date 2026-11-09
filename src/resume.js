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
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

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
 * The trusted sentences appended to "tell the user to click Resume (or approve), then call X": start the wait in the
 * background when the host is notified on exit, else ask the user to say when they are done.
 */
export function resumeWaitText(requestId, options = {}) {
  // Only a daemon-issued id goes into a command (a result without one names no command).
  if (!REQUEST_ID.test(String(requestId ?? ''))) return '';
  return 'If you can run a background command that notifies you when it exits (for example Claude Code\'s Bash '
    + `run_in_background), start \`${resumeWaitCommand(requestId, options)}\` that way now and end your turn: it exits 0 `
    + 'once the tab is ready (on another exit code follow next.text in its JSON line). Otherwise ask the user to tell '
    + 'you when they have done it.';
}

/** `text` followed by the resume wait sentences for `requestId` (unchanged when there is no usable id). */
export function withResumeWait(text, requestId, options = {}) {
  const wait = resumeWaitText(requestId, options);
  return wait ? `${text} ${wait}` : text;
}
