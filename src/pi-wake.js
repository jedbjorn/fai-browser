// The pi wake protocol, shared by both ends: the MCP server (src/wake.js deliverPiSocket) and the FAI extension that
// runs inside pi's own process (integrations/pi/fai-browser.js). Node builtins only, so pi can load it with no deps.
//
// One wake per connection, two JSON lines from FAI: {"type":"auth","v":1,"token":…} then {"type":"wake","text":…}.
// pi answers one line, {"type":"ok","delivery":"turn"|"followUp"} or {"type":"error","code":…}, and closes.

export const PI_WAKE_PROTOCOL = 1;
/** The longest line either side accepts. */
export const MAX_LINE = 8192;
/** The longest wake text the extension passes to pi (FAI's own texts stay far below). */
export const MAX_WAKE_TEXT = 4000;
export const WAKE_PREFIX = '[FAI Browser] ';
/** The variables the extension puts in the fai-browser MCP server's env (and nowhere else). */
export const ENV = Object.freeze({ socket: 'FAI_PI_WAKE_SOCKET', token: 'FAI_PI_WAKE_TOKEN', session: 'FAI_PI_SESSION_ID' });
/** The MCP server's name in pi, and the prefix pi puts on its tools (`mcp__fai_browser__fai_browser_open`). */
export const PI_SERVER_NAME = 'fai-browser';
export const PI_TOOL_PREFIX = 'mcp__fai_browser__';
/** Unix socket paths are limited to about 104-108 bytes; stay under every platform's limit. */
export const MAX_SOCKET_PATH = 100;

/** The two lines FAI writes for one wake. */
export function encodeWake(token, text) {
  return `${JSON.stringify({ type: 'auth', v: PI_WAKE_PROTOCOL, token: String(token) })}\n`
    + `${JSON.stringify({ type: 'wake', text: String(text) })}\n`;
}

/**
 * A wake text the extension passes on: FAI's prefix, at most MAX_WAKE_TEXT characters, no NUL and no control character
 * except a newline (the invite template has one before the user's words). So even a token holder cannot use the socket
 * to inject arbitrary input into pi.
 */
export function checkWakeText(text) {
  if (typeof text !== 'string' || !text.startsWith(WAKE_PREFIX) || text.length > MAX_WAKE_TEXT) return false;
  return !CONTROL.test(text);
}

// Control characters other than a newline, and the line and paragraph separators (U+2028, U+2029).
// eslint-disable-next-line no-control-regex
const CONTROL = new RegExp('[\\u0000-\\u0009\\u000b-\\u001f\\u007f-\\u009f\\u2028\\u2029]');

/**
 * A value pi may get in an MCP server config: pi expands `${VAR}` and runs a value that starts with `!` as a shell
 * command, and a leading `~/` names the home directory. Paths and tokens FAI passes must never trigger any of that.
 */
export function safeConfigValue(value) {
  return typeof value === 'string' && value.length > 0 && !value.includes('$') && !value.startsWith('!')
    && !value.startsWith('~') && !/[\u0000\n\r]/.test(value);
}

/** An absolute unix socket path short enough to bind everywhere. */
export function socketPathOk(path) {
  return typeof path === 'string' && path.startsWith('/') && Buffer.byteLength(path) <= MAX_SOCKET_PATH;
}

/** A tool's name as pi shows it to the model (`fai_browser_open` -> `mcp__fai_browser__fai_browser_open`). */
export function piToolName(tool) {
  return `${PI_TOOL_PREFIX}${tool}`;
}
