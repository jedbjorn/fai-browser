// fai-browser-opencode-plugin v1
// FAI Browser's OpenCode plugin (OpenCode 1.19+, below 2): lets FAI wake an idle OpenCode session when the user
// approves or resumes its browser tab, or invites it to one (docs/REFERENCE.md "Invites and wakes").
// Installed by `fai-browser install --host opencode`; re-run that command to update it. Self-contained on purpose
// (Node/Bun builtins only): it is copied into .opencode/plugins/ and runs inside OpenCode with OpenCode's rights.
//
// - At init it listens on a private unix socket, <runtime dir>/fai-browser/oc-<OpenCode's pid>.sock (directory 0700,
//   socket 0600), and puts the socket path and a fresh random token in process.env, where the fai-browser MCP server
//   OpenCode starts next finds them (FAI_OPENCODE_WAKE_SOCKET, FAI_OPENCODE_WAKE_TOKEN).
// - Before each FAI tool call it finds the calling session's root (a subagent's task session belongs to the
//   conversation that started it) and adds that id as `_faiHostSession` to the call's arguments (the MCP server removes
//   it before anything else reads them), so FAI knows which conversation asked for which tab.
// - A connection that presents the token may ask it to prompt one of those sessions with a text that matches one of
//   FAI's three wake templates exactly. The turn runs with the agent and model of the session's last user message
//   (without them OpenCode would use its default agent: a session in `plan` must stay in `plan`); a session without
//   one is refused. It answers {"ok":true} once OpenCode accepted the prompt and reported no error before the turn
//   started (waiting at most 2 s; a busy session queues it and is not watched): accepted, not answered.
// - The socket is removed on a clean exit. It installs no signal handlers (that would change OpenCode's own exit on
//   SIGTERM or SIGINT): a socket left by a killed OpenCode is swept at the next plugin start.
// It never logs arguments, texts or the token, and never throws out of a hook. FAI_WAKE=0 or opencode --pure: off.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FAI_TOOL = /_fai_browser_(open|act|observe|wait|status|release|evidence|run|stop)$/;
const SESSION = /^ses_[A-Za-z0-9]{10,60}$/;
// FAI's wake texts (src/wake.js wakeText), matched whole: ids as FAI writes them, a level name, the tool, and for an
// invite the user's own words as one JSON string of at most 500 characters.
const ID = String.raw`([A-Za-z0-9][A-Za-z0-9._:-]{0,127})`;
const LEVEL = String.raw`(?:Read|Use|Act|Test site)`;
const NEXT_TOOL = String.raw`(?:fai_browser_observe|fai_browser_run)`;
const PREFIX = String.raw`^\[FAI Browser\] `;
const APPROVED = new RegExp(String.raw`${PREFIX}The user approved tab request ${ID} at level ${LEVEL}\. Call ${NEXT_TOOL} with requestId ${ID} and continue the task\.$`);
const RESUMED = new RegExp(String.raw`${PREFIX}The user resumed tab request ${ID}: the tab is active again\. Call ${NEXT_TOOL} with requestId ${ID} and continue the task\.$`);
const INVITED = new RegExp(String.raw`${PREFIX}The user invited you to work in a browser tab they have open \(invite ${ID}, level ${LEVEL}\)\. `
  + String.raw`Call (?:fai_browser_open with \{"inviteId": "${ID}"\}|fai_browser_run with \{"inviteId": "${ID}"\}, an instruction and an expectation) `
  + String.raw`to get the page, then follow its next\.\n(?:The user typed no task: read the page, then ask them what to do\.|`
  + String.raw`What the user typed in the FAI popup \(the user's own words\): ("(?:[^"\\\u0000-\u001f]|\\.)*"))$`);
const MAX_TEXT = 2000;
const MAX_WORDS = 500;
const MAX_READ = 8 * 1024;
const IDLE_MS = 3_000;
// How long an accepted prompt is watched for OpenCode's own error before the answer.
const SETTLE_MS = 2_000;
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

// Sockets left by an OpenCode that was killed (no exit handler ran): removed when their pid is gone.
function sweep(dir) {
  for (const name of readdirSync(dir)) {
    const pid = Number(/^oc-(\d+)\.sock$/.exec(name)?.[1]);
    if (!pid || pid === process.pid) continue;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === 'ESRCH') removeStale(join(dir, name));
    }
  }
}

/** Whether `text` is one of FAI's wake texts, exactly. */
function wakeTextOk(text) {
  if (typeof text !== 'string' || text.length > MAX_TEXT) return false;
  let match = APPROVED.exec(text) ?? RESUMED.exec(text);
  if (match) return match[1] === match[2];
  match = INVITED.exec(text);
  if (!match || match[1] !== (match[2] ?? match[3])) return false;
  if (match[4] === undefined) return true;
  try {
    const words = JSON.parse(match[4]);
    return typeof words === 'string' && words.length > 0 && words.length <= MAX_WORDS
      && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(words);
  } catch {
    return false;
  }
}

// The agent and model of the session's last user message: a wake continues the session as the user left it. null when
// there is none (OpenCode would pick its default agent, which may have more rights than the session's).
// Only the newest messages are read (20, then 200 when a long run of steps hides the last user turn).
async function sessionTurnSettings(client, id) {
  for (const limit of [20, 200]) {
    const result = await client.session.messages({ path: { id }, query: { limit } });
    if (result?.error) return null;
    const list = Array.isArray(result?.data) ? result.data : [];
    // The newest user message, whatever order the page comes in.
    let info = null;
    for (const item of list) {
      if (item?.info?.role !== 'user') continue;
      if (!info || Number(item.info.time?.created ?? 0) >= Number(info.time?.created ?? 0)) info = item.info;
    }
    if (info) return turnSettings(info);
    if (list.length < limit) return null;
  }
  return null;
}

function turnSettings(info) {
  const model = info.model;
  if (typeof info.agent !== 'string' || !info.agent || typeof model?.providerID !== 'string' || !model.providerID
    || typeof model.modelID !== 'string' || !model.modelID) return null;
  return { agent: info.agent, model: { providerID: model.providerID, modelID: model.modelID },
    ...(typeof model.variant === 'string' && model.variant ? { variant: model.variant } : {}) };
}

// The root session of `id` (a subagent's task session has a parentID), from OpenCode and cached; null when unknown.
async function rootSession(state, client, id) {
  let current = id;
  for (let depth = 0; depth < 8; depth += 1) {
    let parent = state.parents.get(current);
    if (parent === undefined) {
      const result = await client.session.get({ path: { id: current } });
      const info = result?.data;
      if (result?.error || !info || typeof info !== 'object') return null;
      parent = SESSION.test(String(info.parentID ?? '')) ? info.parentID : null;
      state.parents.set(current, parent);
      if (state.parents.size > 512) state.parents.delete(state.parents.keys().next().value);
    }
    if (!parent) return current;
    current = parent;
  }
  return null;
}

// Wait up to SETTLE_MS for OpenCode's events about `sessionID`: session.error fails the wake; busy or a new user
// message ends the wait early; silence (a busy session queues the prompt) is accepted.
function settle(state, sessionID) {
  return new Promise(resolveSettle => {
    const waiter = {
      sessionID,
      done: outcome => {
        clearTimeout(timer);
        state.waiters.delete(waiter);
        resolveSettle(outcome);
      },
    };
    const timer = setTimeout(() => waiter.done('quiet'), SETTLE_MS);
    timer.unref?.();
    state.waiters.add(waiter);
  });
}

function onEvent(state, event) {
  const type = event?.type;
  const properties = event?.properties ?? {};
  const sessionID = properties.sessionID ?? properties.info?.sessionID;
  // Which sessions are running a turn now (a wake to one of them is queued behind it).
  if (type === 'session.status' && SESSION.test(String(sessionID ?? ''))) {
    state.busy.delete(sessionID);
    if (properties.status?.type && properties.status.type !== 'idle') state.busy.add(sessionID);
    if (state.busy.size > 512) state.busy.delete(state.busy.values().next().value);
  } else if (type === 'session.idle') state.busy.delete(sessionID);
  if (!state.waiters.size) return;
  for (const waiter of [...state.waiters]) {
    if (!sessionID || waiter.sessionID !== sessionID) continue;
    if (type === 'session.error') waiter.done('error');
    else if (type === 'session.status' && properties.status?.type === 'busy') waiter.done('started');
    else if (type === 'message.updated' && properties.info?.role === 'user') waiter.done('started');
  }
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
  return { ok: false, code: 'prompt_failed', message: `OpenCode did not take the prompt${status ? ` (HTTP ${status})` : ''}.` };
}

async function answerWake(state, auth, wake) {
  if (auth?.type !== 'auth' || !sameToken(auth.token, state.token)) return { ok: false, code: 'bad_token', message: 'Wrong token.' };
  if (wake?.type !== 'wake') return { ok: false, code: 'bad_text', message: 'Expected a wake line.' };
  const sessionID = wake.sessionID;
  const seen = typeof sessionID === 'string' && SESSION.test(sessionID) ? state.sessions.get(sessionID) : undefined;
  if (!seen) return { ok: false, code: 'not_fai_session', message: 'That session has not used FAI Browser.' };
  if (!wakeTextOk(wake.text)) return { ok: false, code: 'bad_text', message: 'Only FAI Browser wake texts are accepted.' };
  // The client of the instance that saw the session, as it is now (an instance reloaded in `opencode serve` has a new one).
  const client = state.clients.get(seen.directory) ?? seen.client;
  const settings = await sessionTurnSettings(client, sessionID).catch(() => null);
  if (!settings) {
    return { ok: false, code: 'prompt_failed', message: 'The session has no earlier turn to take its agent and model from.' };
  }
  // A session already running a turn queues the prompt: an error then belongs to the turn that is running, not to the
  // wake, so it is not watched for.
  const busyBefore = state.busy.has(sessionID);
  const settled = busyBefore ? Promise.resolve('queued') : settle(state, sessionID);
  let result;
  let thrown = null;
  try {
    // One text part, with the session's own agent and model named, so the turn runs as the user's last one did.
    result = await client.session.promptAsync({ path: { id: sessionID }, body: { agent: settings.agent,
      model: settings.model, ...(settings.variant ? { variant: settings.variant } : {}), parts: [{ type: 'text', text: wake.text }] } });
  } catch (error) {
    thrown = error ?? new Error('failed');
  }
  const outcome = promptOutcome(result, thrown);
  const after = await settled;
  if (!outcome.ok) return outcome;
  if (after === 'error') return { ok: false, code: 'prompt_failed', message: 'OpenCode reported an error for the woken turn.' };
  return outcome;
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
      .catch(() => ({ ok: false, code: 'prompt_failed', message: 'OpenCode did not take the prompt.' }))
      .then(finish);
  });
}

function start() {
  const dir = socketDir();
  const path = join(dir, `oc-${process.pid}.sock`);
  if (Buffer.byteLength(path) > MAX_PATH) throw new Error('socket path too long');
  removeStale(path);
  try {
    sweep(dir);
  } catch {
    // Best effort.
  }
  const state = { token: randomBytes(32).toString('hex'), path, sessions: new Map(), parents: new Map(),
    clients: new Map(), waiters: new Set(), busy: new Set(), server: null };
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
    if (!['promptAsync', 'messages', 'get'].every(name => typeof client?.session?.[name] === 'function')) return {};
    let state = globalThis[STATE];
    if (!state) {
      state = start();
      globalThis[STATE] = state;
    }
    const directory = typeof input.directory === 'string' ? input.directory : '';
    // The newest client for this instance's directory (a reloaded instance replaces it).
    state.clients.set(directory, client);
    return {
      'tool.execute.before': async (call, output) => {
        try {
          if (!FAI_TOOL.test(String(call?.tool ?? ''))) return;
          const args = output && output.args && typeof output.args === 'object' ? output.args : null;
          // Whatever the model wrote there is never passed on.
          if (args) delete args._faiHostSession;
          if (!SESSION.test(String(call?.sessionID ?? ''))) return;
          // A subagent's task session: the wake goes to the conversation the user is in. Unknown: no tag, so no wake.
          const id = await rootSession(state, client, call.sessionID).catch(() => null);
          if (!id) return;
          state.sessions.delete(id);
          state.sessions.set(id, { at: Date.now(), client, directory });
          if (state.sessions.size > MAX_SESSIONS) state.sessions.delete(state.sessions.keys().next().value);
          if (args) args._faiHostSession = id;
        } catch {
          // Never break a tool call because of FAI.
        }
      },
      event: async ({ event } = {}) => {
        try {
          onEvent(state, event);
        } catch {
          // Never.
        }
      },
    };
  } catch {
    console.error('fai-browser: the OpenCode wake plugin is off (could not open its private socket).');
    return {};
  }
};
