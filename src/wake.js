// Waking an idle coding agent: who the MCP server's host is, how that host can be woken, the FAI-authored wake texts,
// and the two delivery channels phase 1 supports. Everything here runs inside the MCP server process, the host's own
// child, and only ever writes to that host's own channel (docs/guide/safety-model.md "Invites and wakes").
//
// - Claude Code (2.1.224+, the token since 2.1.228) gives every stdio MCP child CLAUDE_CODE_MESSAGING_SOCKET (a unix
//   socket) and CLAUDE_CODE_MESSAGING_TOKEN. One auth line and one user line make an idle session take a new turn.
//   The format is the one the binary's own debug hint prints; it is undocumented and may change. The user setting
//   crossSessionInbound (accept, hold, refuse) can hold or drop the message on the host's side.
// - Codex (0.149+) queues a message for a thread: `codex queue --thread <id> --message <text>`. The thread id arrives on
//   every tools/call as _meta["x-codex-turn-metadata"].thread_id (also _meta.threadId).
// - pi (1.2.0+, with the FAI pi extension, integrations/pi/fai-browser.js): the extension registers this server with
//   FAI_PI_WAKE_SOCKET (its own unix socket, <pi pid>.sock), FAI_PI_WAKE_TOKEN and FAI_PI_SESSION_ID in this server's env
//   only. An auth line and a wake line (src/pi-wake.js) make pi take a new turn (idle) or queue a follow-up (busy), and
//   pi answers ok: delivered means acknowledged.
// - Anything else (OpenCode for now, an unknown host, a session without the env) cannot be woken: the popup shows the
//   copy-text fallback ("Tell your agent: join FAI invite <id>").
import { execFile } from 'node:child_process';
import { connect } from 'node:net';
import { accessSync, constants as fsConstants } from 'node:fs';
import { basename, delimiter, isAbsolute, join } from 'node:path';
import { ENV as PI_ENV, checkWakeText, encodeWake, piToolName, socketPathOk } from './pi-wake.js';

export const WAKE_CAPABILITIES = Object.freeze(['claude-socket', 'codex-queue', 'pi-socket', 'none']);
export const HOSTS = Object.freeze(['claude', 'codex', 'opencode', 'pi', 'unknown']);
export const SOCKET_TIMEOUT_MS = 3_000;
export const CODEX_TIMEOUT_MS = 15_000;
// The longest user text an invite carries (the popup's "What should it do?").
export const MAX_INVITE_TEXT = 500;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
// Codex thread ids are UUIDs (v7 today: 01a1c03e-9e28-72a2-8cdb-bb6ca9545521).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LEVEL_NAMES = { 'read-only': 'Read', reversible: 'Use', interactive: 'Use', full: 'Act', testing: 'Test site' };

/**
 * The host this MCP server runs under: the MCP client's own name from initialize first (an OpenCode started from a
 * Claude Code shell inherits CLAUDE_* variables, so the environment alone would misname it), then the environment.
 */
export function detectHost(clientInfo, env = process.env) {
  const name = String(clientInfo?.name ?? '').toLowerCase();
  if (name === 'claude-code' || name.startsWith('claude-code')) return 'claude';
  if (name === 'codex-mcp-client' || name.startsWith('codex')) return 'codex';
  if (name === 'opencode' || name.startsWith('opencode')) return 'opencode';
  if (name === 'pi' || name.startsWith('pi-')) return 'pi';
  if (name) return 'unknown';
  if (env.OPENCODE || env.OPENCODE_PID) return 'opencode';
  // AI_AGENT=pi alone proves nothing: every bash-tool command pi runs inherits it. The socket variable is set only in the
  // env of the server the FAI pi extension registered.
  if (env.PI_CODING_AGENT === 'true' && env[PI_ENV.socket]) return 'pi';
  if (env.CLAUDECODE === '1' && env.CLAUDE_CODE_SESSION_ID) return 'claude';
  return 'unknown';
}

/** The repository's folder name only (never the path): CLAUDE_PROJECT_DIR, else the working directory. */
export function repoName(env = process.env, cwd = process.cwd()) {
  const dir = typeof env.CLAUDE_PROJECT_DIR === 'string' && env.CLAUDE_PROJECT_DIR ? env.CLAUDE_PROJECT_DIR : cwd;
  const name = basename(String(dir ?? '').replace(/[\\/]+$/, '')) || 'unknown';
  return name.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 60) || 'unknown';
}

/**
 * Claude Code's messaging socket for this session, or null (a --bare session, an older Claude Code, another host).
 * The variables are inherited by everything Claude Code starts, a Bash command's children included, so they prove
 * nothing on their own: the socket is `<dir>/<claude pid>.sock`, and it counts only when that pid is this process's
 * parent (`ppid`), i.e. Claude Code started this MCP server itself. A wrapper in between (npx, a shell script) fails
 * closed: no socket, the copy-line fallback. `install --host claude` writes the node command directly.
 */
export function claudeSocket(env = process.env, { ppid = process.ppid } = {}) {
  const path = env.CLAUDE_CODE_MESSAGING_SOCKET;
  const token = env.CLAUDE_CODE_MESSAGING_TOKEN ?? env.CLAUDE_CODE_MESSAGING_SOCKET_TOKEN;
  if (typeof path !== 'string' || !path || typeof token !== 'string' || !token) return null;
  if (!Number.isInteger(ppid) || ppid <= 1 || basename(path) !== `${ppid}.sock`) return null;
  return { path, token };
}

/**
 * The FAI pi extension's wake socket for this session, or null. Same rule as claudeSocket: the socket is
 * `<dir>/<pi pid>.sock` and counts only when that pid is this process's parent (pi started this server itself), so a
 * wrapper in between or a server reparented after pi died fails closed.
 */
export function piSocket(env = process.env, { ppid = process.ppid } = {}) {
  const path = env[PI_ENV.socket];
  const token = env[PI_ENV.token];
  if (typeof path !== 'string' || !path || typeof token !== 'string' || !token) return null;
  if (!Number.isInteger(ppid) || ppid <= 1 || basename(path) !== `${ppid}.sock` || !socketPathOk(path)) return null;
  return { path, token };
}

/**
 * The host's own session id when it states one (Claude Code's CLAUDE_CODE_SESSION_ID, pi's FAI_PI_SESSION_ID from the
 * FAI extension); a Codex thread id comes later.
 */
export function hostSessionId(host, env = process.env) {
  if (host === 'claude' && ID.test(String(env.CLAUDE_CODE_SESSION_ID ?? ''))) return env.CLAUDE_CODE_SESSION_ID;
  if (host === 'pi' && ID.test(String(env[PI_ENV.session] ?? ''))) return env[PI_ENV.session];
  return null;
}

/** The Codex thread id a tools/call names in its _meta, or null. */
export function codexThreadId(meta) {
  if (!meta || typeof meta !== 'object') return null;
  const turn = meta['x-codex-turn-metadata'];
  const id = (turn && typeof turn === 'object' ? turn.thread_id : null) ?? meta.threadId;
  return typeof id === 'string' && UUID.test(id) ? id : null;
}

/** The codex binary: FAI_CODEX_BIN, else `codex` found on PATH; null when there is none. */
export function codexBinary(env = process.env) {
  if (typeof env.FAI_CODEX_BIN === 'string' && env.FAI_CODEX_BIN) return env.FAI_CODEX_BIN;
  for (const dir of String(env.PATH ?? '').split(delimiter)) {
    // A relative PATH entry would resolve against whatever directory the MCP server runs in: never.
    if (!dir || !isAbsolute(dir)) continue;
    const candidate = join(dir, 'codex');
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Not here.
    }
  }
  return null;
}

// Runs `bin args` (argv, no shell) with a timeout and a scrubbed environment; resolves {code, stdout, stderr, error}.
function run(bin, args, { env, timeoutMs }) {
  return new Promise(resolveRun => {
    execFile(bin, args, { env, timeout: timeoutMs, maxBuffer: 256 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      resolveRun({
        code: error ? (typeof error.code === 'number' ? error.code : null) : 0,
        error: error && typeof error.code !== 'number' ? String(error.code ?? error.message ?? error) : null,
        killed: Boolean(error?.killed),
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
      });
    });
  });
}

// The environment a codex child gets: the MCP server's (Codex's own, so CODEX_HOME and the like hold), without FAI's
// own variables (FAI_CLIENT_TOKEN and friends never reach another program).
function codexEnv(env) {
  const out = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (!/^FAI_/.test(key)) out[key] = value;
  }
  return out;
}

/**
 * Whether this codex binary has `queue` (checked once per binary and cached): resolves true or false, never throws.
 */
const queueSupport = new Map();
export function codexSupportsQueue(env = process.env, { timeoutMs = 5_000 } = {}) {
  const bin = codexBinary(env);
  if (!bin) return Promise.resolve(false);
  if (!queueSupport.has(bin)) {
    queueSupport.set(bin, run(bin, ['queue', '--help'], { env: codexEnv(env), timeoutMs })
      .then(result => result.code === 0 && /--thread/.test(result.stdout + result.stderr))
      .catch(() => false));
  }
  return queueSupport.get(bin);
}

/** For tests: forget the cached `codex queue --help` answers. */
export function resetCodexSupport() {
  queueSupport.clear();
}

/**
 * Queue `text` as the next user turn of Codex thread `threadId` (`codex queue --thread <id> --message <text>`).
 * Resolves {ok: true} or {ok: false, code, message}: `no_codex`, `unknown_thread` (codex says "no rollout found"),
 * `timeout`, `codex_failed`.
 */
export async function deliverCodexQueue({ threadId, text, env = process.env, timeoutMs = CODEX_TIMEOUT_MS }) {
  if (!UUID.test(String(threadId ?? ''))) return { ok: false, code: 'unknown_thread', message: 'No Codex thread id yet.' };
  const bin = codexBinary(env);
  if (!bin) return { ok: false, code: 'no_codex', message: 'The codex command was not found (set FAI_CODEX_BIN).' };
  const result = await run(bin, ['queue', '--thread', threadId, '--message', String(text)], { env: codexEnv(env), timeoutMs });
  if (result.code === 0) return { ok: true };
  const said = `${result.stderr}\n${result.stdout}`.replace(/\s+/g, ' ').trim().slice(0, 200);
  if (result.killed) return { ok: false, code: 'timeout', message: `codex queue did not finish within ${timeoutMs} ms.` };
  if (result.error === 'ENOENT') return { ok: false, code: 'no_codex', message: 'The codex command was not found.' };
  if (/no rollout found|unknown (thread|session)|not found/i.test(said)) {
    return { ok: false, code: 'unknown_thread', message: 'Codex does not know this thread.' };
  }
  return { ok: false, code: 'codex_failed', message: said || `codex queue exited ${result.code ?? result.error}.` };
}

/**
 * Write one user turn to Claude Code's messaging socket: `{"type":"auth","token":…}` then
 * `{"type":"user","message":{"role":"user","content":text}}`, one JSON object per line. Resolves {ok: true} once both
 * lines are written and the socket closed or stayed quiet without an error line, else {ok: false, code, message}:
 * `no_socket`, `connect_failed`, `refused` (the session answered with an error), `timeout`.
 * Claude Code 2.1.319 answers nothing on this socket, neither to a message it takes nor to a wrong token (it closes),
 * and a message its crossSessionInbound setting holds or refuses looks the same: ok means "sent", not "received".
 * Anything it does write back is kept as `reply`.
 */
export function deliverClaudeSocket({ path, token, text, timeoutMs = SOCKET_TIMEOUT_MS, quietMs = 300 }) {
  if (!path || !token) return Promise.resolve({ ok: false, code: 'no_socket', message: 'This session has no messaging socket.' });
  return new Promise(resolveDelivery => {
    let settled = false;
    let answer = '';
    let written = false;
    let quiet = null;
    const socket = connect({ path });
    const finish = outcome => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(quiet);
      socket.destroy();
      resolveDelivery(outcome);
    };
    // What the session wrote back, if anything (one line, clipped, the token never echoed): kept so an ack can be told
    // from silence.
    const scrub = text => (token ? String(text).split(token).join('[token]') : String(text));
    const reply = () => scrub(answer).replace(/\s+/g, ' ').trim().slice(0, 200);
    const judge = () => {
      const refusal = refusalIn(scrub(answer));
      if (refusal) return finish({ ok: false, code: 'refused', message: refusal });
      if (!written) return finish({ ok: false, code: 'connect_failed', message: 'The session closed the socket before the message was written.' });
      return finish(reply() ? { ok: true, reply: reply() } : { ok: true });
    };
    const timer = setTimeout(() => {
      if (written && !refusalIn(scrub(answer))) return finish(reply() ? { ok: true, reply: reply() } : { ok: true });
      finish({ ok: false, code: 'timeout', message: `The messaging socket did not answer within ${timeoutMs} ms.` });
    }, timeoutMs);
    timer.unref?.();
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      answer = (answer + chunk).slice(-4000);
      if (refusalIn(scrub(answer))) judge();
    });
    socket.on('error', error => {
      if (written && ['EPIPE', 'ECONNRESET'].includes(error?.code)) return judge();
      const code = ['ENOENT', 'ECONNREFUSED', 'ENOTSOCK'].includes(error?.code) ? 'no_socket' : 'connect_failed';
      finish({ ok: false, code, message: `Could not reach the session's messaging socket (${error?.code ?? 'error'}).` });
    });
    socket.on('close', () => judge());
    socket.on('connect', () => {
      const lines = `${JSON.stringify({ type: 'auth', token })}\n`
        + `${JSON.stringify({ type: 'user', message: { role: 'user', content: String(text) } })}\n`;
      socket.write(lines, error => {
        if (error) return;
        written = true;
        // Half-close: the session reads both lines; whatever it answers before closing is checked for a refusal.
        socket.end();
        quiet = setTimeout(judge, quietMs);
        quiet.unref?.();
      });
    });
  });
}

/**
 * One wake to the FAI pi extension's socket (src/pi-wake.js): resolves {ok: true, reply: 'turn'|'followUp'} only on
 * pi's {"type":"ok"} line, else {ok: false, code, message}: `bad_text` (checked before connecting), `no_socket`,
 * `connect_failed`, `refused` (an error line: unauthorized, busy_limit, bad_text, closed, failed), `no_ack` (closed
 * without ok), `timeout`. The token is never echoed in a result.
 */
export function deliverPiSocket({ path, token, text, timeoutMs = SOCKET_TIMEOUT_MS }) {
  if (!checkWakeText(text)) return Promise.resolve({ ok: false, code: 'bad_text', message: 'Not a FAI wake text.' });
  if (!path || !token) return Promise.resolve({ ok: false, code: 'no_socket', message: 'This session has no wake socket.' });
  return new Promise(resolveDelivery => {
    let settled = false;
    let answer = '';
    const socket = connect({ path });
    const scrub = value => String(value).split(token).join('[token]').replace(/\s+/g, ' ').trim().slice(0, 200);
    const finish = outcome => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolveDelivery(outcome);
    };
    const judge = () => {
      const line = answer.split('\n').find(item => item.trim());
      let parsed = null;
      try {
        parsed = line ? JSON.parse(line) : null;
      } catch {
        // Not pi's answer.
      }
      if (parsed?.type === 'ok') {
        return finish({ ok: true, reply: parsed.delivery === 'followUp' ? 'followUp' : 'turn' });
      }
      if (parsed?.type === 'error' || (line && !parsed)) {
        return finish({ ok: false, code: 'refused', message: scrub(parsed?.code ?? parsed?.message ?? line) });
      }
      return finish({ ok: false, code: 'no_ack', message: 'The pi session closed the socket without taking the wake.' });
    };
    const timer = setTimeout(() => finish({ ok: false, code: 'timeout',
      message: `The pi session did not answer within ${timeoutMs} ms.` }), timeoutMs);
    timer.unref?.();
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      answer = (answer + chunk).slice(0, 8192);
      if (answer.includes('\n')) judge();
    });
    socket.on('error', error => {
      if (answer) return judge();
      const code = ['ENOENT', 'ECONNREFUSED', 'ENOTSOCK'].includes(error?.code) ? 'no_socket' : 'connect_failed';
      finish({ ok: false, code, message: `Could not reach the pi session's wake socket (${error?.code ?? 'error'}).` });
    });
    socket.on('close', () => judge());
    socket.on('connect', () => socket.write(encodeWake(token, text)));
  });
}

// A line the session wrote back that says it did not take the message ({"type":"error",…}, "refused", "unauthorized").
function refusalIn(text) {
  for (const line of String(text).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed = null;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Not JSON: judged by its words below.
    }
    const type = String(parsed?.type ?? '').toLowerCase();
    const words = parsed ? `${type} ${parsed.error ?? ''} ${parsed.message ?? ''} ${parsed.reason ?? ''}` : trimmed;
    if (['error', 'refused', 'rejected', 'denied'].includes(type) || /refus|reject|unauthori[sz]ed|denied|invalid token/i.test(words)) {
      return String(parsed?.message ?? parsed?.error ?? parsed?.reason ?? trimmed).replace(/\s+/g, ' ').slice(0, 200);
    }
  }
  return null;
}

// --- wake texts (FAI-authored, fixed templates; never page text, a URL or a title) ----------------------------------

const safeId = value => (ID.test(String(value ?? '')) ? String(value) : 'unknown');
const levelName = level => LEVEL_NAMES[level] ?? 'Read';

/** The user's own words from the popup's "What should it do?", one line, clipped; '' when none. */
export function cleanInviteText(text) {
  if (typeof text !== 'string') return '';
  return text
    // Zero-width characters and bidi controls (U+200B-200F, U+202A-202E, U+2060-2069, U+FEFF) vanish: they could make
    // the text read differently from what it says.
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, '')
    // C0 and C1 controls and line or paragraph separators become spaces: the user's words stay one line.
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, MAX_INVITE_TEXT);
}

/**
 * The wake text for each event. `kind`: invite (the user invited this session to a tab: join with inviteId), resume
 * (the user resumed a paused tab it holds), approved (the user approved its pending request). `driver` names the tool
 * (agent: fai_browser_open / observe; jev: fai_browser_run).
 */
export function wakeText({ kind, inviteId, requestId, level, userText, driver = 'agent', host = 'unknown' }) {
  const prefix = '[FAI Browser] ';
  // pi names MCP tools mcp__<server>__<tool>: the text names the tool the way this host shows it.
  const named = tool => (host === 'pi' ? piToolName(tool) : tool);
  if (kind === 'invite') {
    const words = cleanInviteText(userText);
    const tool = named(driver === 'jev' ? 'fai_browser_run' : 'fai_browser_open');
    return `${prefix}The user invited you to work in a browser tab they have open (invite ${safeId(inviteId)}, level `
      + `${levelName(level)}). Call ${tool} with {"inviteId": "${safeId(inviteId)}"}${driver === 'jev'
        ? ', an instruction and an expectation' : ''} to get the page, then follow its next.`
      + (words ? `\nWhat the user typed in the FAI popup (the user's own words): ${JSON.stringify(words)}`
        : '\nThe user typed no task: read the page, then ask them what to do.');
  }
  const tool = named(driver === 'jev' ? 'fai_browser_run' : 'fai_browser_observe');
  if (kind === 'resume') {
    return `${prefix}The user resumed tab request ${safeId(requestId)}: the tab is active again. Call ${tool} with `
      + `requestId ${safeId(requestId)} and continue the task.`;
  }
  return `${prefix}The user approved tab request ${safeId(requestId)} at level ${levelName(level)}. Call ${tool} with `
    + `requestId ${safeId(requestId)} and continue the task.`;
}

/**
 * The wake capability of a session: claude-socket (Claude Code with its socket), codex-queue (Codex with a known
 * thread and a `codex queue`), pi-socket (pi with the FAI extension's socket), else none. `codexReady` is the cached `codex queue --help` answer.
 */
export function wakeCapability({ host, env = process.env, threadId = null, codexReady = false, ppid = process.ppid }) {
  if (env.FAI_WAKE === '0') return 'none';
  if (host === 'claude' && claudeSocket(env, { ppid })) return 'claude-socket';
  if (host === 'codex' && threadId && codexReady) return 'codex-queue';
  if (host === 'pi' && piSocket(env, { ppid })) return 'pi-socket';
  return 'none';
}

/** Deliver one wake through `capability`; resolves {ok} or {ok: false, code, message}, never throws. */
export async function deliverWake({ capability, text, env = process.env, threadId = null, ppid = process.ppid }) {
  try {
    if (env.FAI_WAKE === '0') return { ok: false, code: 'disabled', message: 'Waking is off (FAI_WAKE=0).' };
    if (capability === 'claude-socket') {
      const socket = claudeSocket(env, { ppid });
      if (!socket) return { ok: false, code: 'no_socket', message: 'This session has no messaging socket.' };
      return await deliverClaudeSocket({ ...socket, text });
    }
    if (capability === 'codex-queue') return await deliverCodexQueue({ threadId, text, env });
    if (capability === 'pi-socket') {
      const socket = piSocket(env, { ppid });
      if (!socket) return { ok: false, code: 'no_socket', message: 'This session has no wake socket.' };
      return await deliverPiSocket({ ...socket, text });
    }
    return { ok: false, code: 'no_wake', message: 'This session cannot be woken.' };
  } catch (error) {
    return { ok: false, code: 'wake_failed', message: String(error?.message ?? error).slice(0, 200) };
  }
}
