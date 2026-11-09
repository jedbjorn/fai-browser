// fai-browser-opencode-plugin v1
// FAI Browser's OpenCode plugin (OpenCode 1.19+, below 2): lets FAI wake an idle OpenCode session when the user
// approves or resumes its browser tab, or invites it to one (docs/REFERENCE.md "Invites and wakes").
// Installed by `fai-browser install --host opencode`; re-run that command to update it. Self-contained on purpose
// (Node/Bun builtins only): it is copied into .opencode/plugins/ and runs inside OpenCode with OpenCode's rights.
//
// - At init it listens on a private unix socket, <runtime dir>/fai-browser/oc-<OpenCode's pid>.sock (directory 0700,
//   socket 0600), and puts the socket path and a fresh random token in process.env, where the fai-browser MCP server
//   OpenCode starts next finds them (FAI_OPENCODE_WAKE_SOCKET, FAI_OPENCODE_WAKE_TOKEN).
// - Before each FAI tool call it notes the calling session and adds its id as `_faiHostSession` to the call's arguments
//   (the MCP server removes it before anything else reads them), so FAI knows which session asked for which tab.
// - A connection that presents the token may ask it to prompt one of those sessions with one FAI-authored text
//   ("[FAI Browser] The user approved / resumed / invited …"). Sessions that never called a FAI tool, other texts,
//   models, agents or tools: refused. It answers {"ok":true} once OpenCode has queued the turn.
// It never logs arguments, texts or the token, and never throws out of a hook. FAI_WAKE=0 or opencode --pure: off.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FAI_TOOL = /_fai_browser_(open|act|observe|wait|status|release|evidence|run|stop)$/;
const SESSION = /^ses_[A-Za-z0-9]{10,60}$/;
const TEXT = /^\[FAI Browser\] The user (invited|resumed|approved) /;
const MAX_TEXT = 2000;
const MAX_READ = 8 * 1024;
const IDLE_MS = 3_000;
const MAX_SESSIONS = 64;
// Unix socket paths longer than this fail to connect from Node (EINVAL; the limit is about 107 bytes).
const MAX_PATH = 100;
// One state per OpenCode process: a project plugin and a user plugin (or several project instances in one
// `opencode serve`) share the socket, the token and the sessions seen.
const STATE = Symbol.for('fai-browser.opencode-wake.v1');

function socketDir() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const runtime = process.env.XDG_RUNTIME_DIR;
  const dir = runtime && runtime.startsWith('/') ? join(runtime, 'fai-browser') : join(tmpdir(), `fai-browser-${uid ?? 'user'}`);
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const info = lstatSync(dir);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('socket directory is not a plain directory');
  if (uid !== null && info.uid !== uid) throw new Error('socket directory belongs to another user');
  if ((info.mode & 0o077) !== 0) chmodSync(dir, 0o700);
  return dir;
}

function removeStale(path) {
  let info;
  try {
    info = lstatSync(path);
  } catch {
    return;
  }
  if (!info.isSocket()) throw new Error('socket path is taken by something else');
  unlinkSync(path);
}

function sameToken(given, token) {
  if (typeof given !== 'string' || !/^[0-9a-f]{64}$/.test(given)) return false;
  return timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(token, 'hex'));
}

// OpenCode's SDK answers {data, error, response} (it does not throw), but a thrown error is handled the same way.
function promptOutcome(result, thrown) {
  const status = Number(result?.response?.status ?? thrown?.status ?? thrown?.response?.status ?? 0);
  const name = String(result?.error?.name ?? result?.error?.data?.name ?? thrown?.name ?? '');
  if (!thrown && !result?.error && (status === 0 || (status >= 200 && status < 300))) return { ok: true };
  if (status === 404 || /NotFound/.test(name)) return { ok: false, code: 'unknown_session', message: 'OpenCode does not know this session.' };
  return { ok: false, code: 'prompt_failed', message: `OpenCode did not queue the turn${status ? ` (HTTP ${status})` : ''}.` };
}

async function answerWake(state, auth, wake) {
  if (auth?.type !== 'auth' || !sameToken(auth.token, state.token)) return { ok: false, code: 'bad_token', message: 'Wrong token.' };
  if (wake?.type !== 'wake') return { ok: false, code: 'bad_text', message: 'Expected a wake line.' };
  const sessionID = wake.sessionID;
  const seen = typeof sessionID === 'string' && SESSION.test(sessionID) ? state.sessions.get(sessionID) : undefined;
  if (!seen) return { ok: false, code: 'not_fai_session', message: 'That session has not used FAI Browser.' };
  const text = wake.text;
  if (typeof text !== 'string' || text.length > MAX_TEXT || !TEXT.test(text)) {
    return { ok: false, code: 'bad_text', message: 'Only FAI Browser wake texts are accepted.' };
  }
  let result;
  let thrown = null;
  try {
    // Text parts only: the session keeps its own model, agent and tools.
    result = await seen.client.session.promptAsync({ path: { id: sessionID }, body: { parts: [{ type: 'text', text }] } });
  } catch (error) {
    thrown = error ?? new Error('failed');
  }
  return promptOutcome(result, thrown);
}

function serve(state, connection) {
  let buffer = '';
  let done = false;
  let busy = false;
  const lines = [];
  const finish = reply => {
    if (done) return;
    done = true;
    try {
      connection.end(`${JSON.stringify(reply)}\n`);
    } catch {
      connection.destroy();
    }
  };
  connection.setEncoding('utf8');
  connection.setTimeout(IDLE_MS, () => connection.destroy());
  connection.on('error', () => {});
  connection.on('data', chunk => {
    if (done || busy) return;
    buffer += chunk;
    if (buffer.length > MAX_READ) {
      finish({ ok: false, code: 'bad_text', message: 'Too long.' });
      return;
    }
    let at;
    while (lines.length < 2 && (at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      try {
        lines.push(JSON.parse(line));
      } catch {
        lines.push(null);
      }
    }
    if (lines.length === 1 && !(lines[0]?.type === 'auth' && sameToken(lines[0].token, state.token))) {
      finish({ ok: false, code: 'bad_token', message: 'Wrong token.' });
      return;
    }
    if (lines.length < 2) return;
    busy = true;
    connection.setTimeout(0);
    answerWake(state, lines[0], lines[1])
      .catch(() => ({ ok: false, code: 'prompt_failed', message: 'OpenCode did not queue the turn.' }))
      .then(finish);
  });
}

function start() {
  const dir = socketDir();
  const path = join(dir, `oc-${process.pid}.sock`);
  if (Buffer.byteLength(path) > MAX_PATH) throw new Error('socket path too long');
  removeStale(path);
  const state = { token: randomBytes(32).toString('hex'), path, sessions: new Map(), server: null };
  state.server = createServer(connection => serve(state, connection));
  state.server.on('error', () => {});
  state.server.listen(path, () => {
    try {
      chmodSync(path, 0o600);
    } catch {
      // The directory is private anyway.
    }
  });
  state.server.unref?.();
  process.on('exit', () => {
    try {
      unlinkSync(path);
    } catch {
      // Already gone.
    }
  });
  // The fai-browser MCP server OpenCode starts after this reads them (and checks that OpenCode is its parent).
  process.env.FAI_OPENCODE_WAKE_SOCKET = path;
  process.env.FAI_OPENCODE_WAKE_TOKEN = state.token;
  return state;
}

export const FaiBrowserWake = async input => {
  try {
    if (process.env.FAI_WAKE === '0') return {};
    const client = input?.client;
    if (!client?.session || typeof client.session.promptAsync !== 'function') return {};
    let state = globalThis[STATE];
    if (!state) {
      state = start();
      globalThis[STATE] = state;
    }
    return {
      'tool.execute.before': async (call, output) => {
        try {
          if (!FAI_TOOL.test(String(call?.tool ?? '')) || !SESSION.test(String(call?.sessionID ?? ''))) return;
          const id = call.sessionID;
          state.sessions.delete(id);
          state.sessions.set(id, { at: Date.now(), client });
          if (state.sessions.size > MAX_SESSIONS) state.sessions.delete(state.sessions.keys().next().value);
          if (output && output.args && typeof output.args === 'object') output.args._faiHostSession = id;
        } catch {
          // Never break a tool call because of FAI.
        }
      },
    };
  } catch {
    console.error('fai-browser: the OpenCode wake plugin is off (could not open its private socket).');
    return {};
  }
};
