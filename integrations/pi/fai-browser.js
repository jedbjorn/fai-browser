// The FAI Browser extension for pi (@earendil-works/pi-coding-agent 1.2.0+). It runs inside pi's own process, loaded by
// the small loader `fai-browser install --host pi` writes (.pi/extensions/fai-browser.js or
// ~/.pi/agent/extensions/fai-browser.js), which passes the MCP server's command. Per pi session it:
//
// - registers the fai-browser MCP server (exposure direct) with a wake socket, token and session id in that server's
//   env only: not in pi's process.env, so bash-tool commands never see them;
// - listens on an authenticated unix socket `<runtime dir>/fai-pi-XXXXXX/<pi pid>.sock` (0700) and turns one FAI wake
//   (src/pi-wake.js) into pi.sendUserMessage: a new turn when idle, a follow-up when busy;
// - copies the server's instructions into the system prompt (pi does not show MCP server instructions to the model).
//
// Fail closed: an old pi, a listen failure, an unsafe value or an mcp.json fai-browser entry means no wake (FAI then shows
// the user the copy line). It never writes to stdout (that would corrupt pi's TUI and RPC output) and never logs or
// shows the token, page text or URLs. Node builtins and src/pi-wake.js only.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import {
  ENV, MAX_LINE, PI_SERVER_NAME, PI_TOOL_PREFIX, checkWakeText, safeConfigValue, socketPathOk,
} from '../../src/pi-wake.js';

export const MIN_PI_VERSION = '1.2.0';
export const WAKES_PER_MINUTE = 12;
const SOCKET_IDLE_MS = 2_000;
const MAX_INSTRUCTIONS = 4_096;
// FAI's calls may wait for the user's approval (up to about 105 s by default); pi's own default is 60 s.
const TOOL_TIMEOUT_S = 130;
const DESCRIPTION = 'FAI Browser: drive a browser tab the user approves';
const SECTION = 'fai-browser';
const MAPPING = `pi: FAI's tools are named ${PI_TOOL_PREFIX}<tool> here; where FAI says fai_browser_open (or any `
  + `fai_browser_<tool>), call ${PI_TOOL_PREFIX}fai_browser_open (${PI_TOOL_PREFIX}fai_browser_<tool>).`;

/** a >= b for dotted versions ("1.5.0" >= "1.2.0"); a missing or odd version compares false. */
export function versionAtLeast(a, b) {
  const parse = value => String(value ?? '').split('-')[0].split('.').map(part => Number.parseInt(part, 10));
  const left = parse(a);
  const right = parse(b);
  if (left.length < 2 || left.some(Number.isNaN)) return false;
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const x = left[i] ?? 0;
    const y = right[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

// pi maps this import to its own copy; outside pi (or an old pi) it fails: unknown.
async function piVersion() {
  try {
    const module = await import('@earendil-works/pi-coding-agent');
    return typeof module?.VERSION === 'string' ? module.VERSION : null;
  } catch {
    return null;
  }
}

// A directory only this user can enter: owned by `uid`, no group or other bits, not a symlink.
function privateDir(path, uid) {
  try {
    const info = lstatSync(path);
    return info.isDirectory() && (uid === null || info.uid === uid) && (info.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

/** The directories a socket may live in: $XDG_RUNTIME_DIR when it is private, then the temp dir, then /tmp. */
export function socketBases(env = process.env, uid = process.getuid?.() ?? null) {
  const bases = [];
  const runtime = env.XDG_RUNTIME_DIR;
  if (typeof runtime === 'string' && isAbsolute(runtime) && privateDir(runtime, uid)) bases.push(resolve(runtime));
  for (const base of [tmpdir(), '/tmp']) if (!bases.includes(base)) bases.push(base);
  return bases;
}

/**
 * Remove `base/fai-pi-*` directories this user owns whose `<pid>.sock` names a pid that no longer runs (pi crashed or
 * was killed). Directories of live pids, of other users and without a socket are left alone.
 */
export function sweepStale(base, { uid = process.getuid?.() ?? null, pid = process.pid, alive = pidAlive } = {}) {
  let entries;
  try {
    entries = readdirSync(base);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith('fai-pi-')) continue;
    const dir = join(base, name);
    if (!privateDir(dir, uid)) continue;
    let files;
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    const socket = files.map(file => /^(\d+)\.sock$/.exec(file)).find(Boolean);
    if (!socket) continue;
    const owner = Number(socket[1]);
    if (owner === pid || owner <= 1 || alive(owner)) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort.
    }
  }
}

function listen(server, path) {
  return new Promise((resolveListen, rejectListen) => {
    const failed = error => rejectListen(error);
    server.once('error', failed);
    server.listen(path, () => {
      server.off('error', failed);
      resolveListen();
    });
  });
}

function sameToken(given, token) {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

// An mcp.json that defines fai-browser (user, or the project's when trusted) wins over this extension's registration.
function mcpJsonDefinesServer(path) {
  try {
    const text = readFileSync(path, 'utf8').replace(/^﻿/, '');
    const servers = JSON.parse(text)?.mcpServers;
    return Boolean(servers && typeof servers === 'object' && Object.hasOwn(servers, PI_SERVER_NAME));
  } catch {
    return false;
  }
}

/**
 * The extension. `options`: {command, args, env} of the MCP server (from the loader). `deps` (tests): version, env,
 * pid, uid, bases (socket base directories), agentDir, now.
 */
export default async function activate(pi, options = {}, deps = {}) {
  const env = deps.env ?? process.env;
  const pid = deps.pid ?? process.pid;
  const uid = 'uid' in deps ? deps.uid : (process.getuid?.() ?? null);
  const now = deps.now ?? Date.now;
  const version = 'version' in deps ? deps.version : await piVersion();
  const agentDir = deps.agentDir ?? (env.PI_CODING_AGENT_DIR ? resolve(env.PI_CODING_AGENT_DIR)
    : join(homedir(), '.pi', 'agent'));
  const command = options.command;
  const args = Array.isArray(options.args) ? options.args.map(String) : [];
  // The loader's own env (FAI_HOME): only values pi will not interpolate.
  const baseEnv = Object.fromEntries(Object.entries(options.env ?? {})
    .filter(([key, value]) => /^[A-Z_][A-Z0-9_]*$/.test(key) && safeConfigValue(value)));
  const supported = typeof pi?.registerMcpServer === 'function' && typeof pi?.sendUserMessage === 'function'
    && (version === null || versionAtLeast(version, MIN_PI_VERSION));
  const usable = safeConfigValue(command) && args.every(safeConfigValue);
  const notified = new Set();
  // The live socket of this instance: {server, dir, path, token, sessionId, ctx, wakes}.
  let current = null;
  let chain = Promise.resolve();

  const notify = (ctx, key, message, type = 'warning') => {
    if (notified.has(key)) return;
    notified.add(key);
    try {
      if (ctx?.hasUI !== false) ctx?.ui?.notify?.(message, type);
    } catch {
      // A notification is never worth failing the session over.
    }
  };

  const closeCurrent = () => {
    const record = current;
    current = null;
    if (!record) return;
    record.closed = true;
    try {
      record.server.close();
    } catch {
      // Already closed.
    }
    try {
      rmSync(record.dir, { recursive: true, force: true });
    } catch {
      // Best effort.
    }
  };

  const handle = (record, socket) => {
    let buffer = '';
    let authed = false;
    let done = false;
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    socket.setTimeout(SOCKET_IDLE_MS, () => socket.destroy());
    const reply = answer => {
      if (done) return;
      done = true;
      socket.end(`${JSON.stringify(answer)}\n`);
    };
    const fail = code => reply({ type: 'error', code });
    const deliver = text => {
      if (record.closed || current !== record) return fail('closed');
      const at = now();
      record.wakes = record.wakes.filter(time => at - time < 60_000);
      if (record.wakes.length >= WAKES_PER_MINUTE) return fail('busy_limit');
      record.wakes.push(at);
      try {
        // Only the ctx of this session's own session_start: after a switch it would be stale.
        const idle = record.ctx.isIdle();
        // followUp, not steer: a wake never cuts into a tool sequence already running.
        pi.sendUserMessage(text, idle ? { expandPromptTemplates: false }
          : { deliverAs: 'followUp', expandPromptTemplates: false });
        return reply({ type: 'ok', delivery: idle ? 'turn' : 'followUp' });
      } catch {
        return fail('failed');
      }
    };
    socket.on('data', chunk => {
      if (done) return;
      buffer += chunk;
      if (buffer.length > MAX_LINE * 2) return fail('too_long');
      let index;
      while (!done && (index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.length > MAX_LINE) return fail('too_long');
        let message = null;
        try {
          message = JSON.parse(line);
        } catch {
          // Judged below.
        }
        if (!authed) {
          if (message?.type !== 'auth' || message.v !== 1 || !sameToken(message.token, record.token)) {
            return fail('unauthorized');
          }
          authed = true;
          continue;
        }
        if (message?.type !== 'wake' || !checkWakeText(message.text)) return fail('bad_text');
        return deliver(message.text);
      }
    });
  };

  // A listening socket in the first base that works, or null.
  const openSocket = async (ctx, sessionId) => {
    for (const base of deps.bases ?? socketBases(env, uid)) {
      sweepStale(base, { uid, pid });
      let dir;
      try {
        dir = mkdtempSync(join(base, 'fai-pi-'));
      } catch {
        continue;
      }
      const path = join(dir, `${pid}.sock`);
      if (!privateDir(dir, uid) || !socketPathOk(path)) {
        rmSync(dir, { recursive: true, force: true });
        continue;
      }
      const record = { server: null, dir, path, token: randomBytes(32).toString('base64url'), sessionId, ctx,
        wakes: [], closed: false };
      const server = createServer(socket => handle(record, socket));
      record.server = server;
      try {
        await listen(server, path);
      } catch {
        try {
          server.close();
        } catch {
          // Never listened.
        }
        rmSync(dir, { recursive: true, force: true });
        continue;
      }
      // An unhandled 'error' on a server would crash pi.
      server.on('error', () => notify(ctx, 'socket-error', 'FAI Browser: the wake socket failed; invites need the copy line'));
      return record;
    }
    return null;
  };

  const register = (ctx, wakeEnv) => {
    if (!usable) {
      notify(ctx, 'unsafe', 'FAI Browser: the installed MCP command path cannot be passed to pi; re-run '
        + '`fai-browser install --host pi`');
      return;
    }
    try {
      pi.registerMcpServer(PI_SERVER_NAME, { command, args, env: { ...baseEnv, ...wakeEnv }, exposure: 'direct',
        description: DESCRIPTION, timeout: TOOL_TIMEOUT_S });
    } catch {
      notify(ctx, 'register', 'FAI Browser: pi refused the MCP server registration');
    }
  };

  const start = async ctx => {
    let sessionId = null;
    try {
      sessionId = String(ctx?.sessionManager?.getSessionId?.() ?? '') || null;
    } catch {
      sessionId = null;
    }
    // pi 1.5.0 fires session_start twice after RPC new_session: same instance, same session.
    if (current && current.sessionId === sessionId) return;
    closeCurrent();
    const projectTrusted = (() => {
      try {
        return Boolean(ctx?.isProjectTrusted?.());
      } catch {
        return false;
      }
    })();
    if (mcpJsonDefinesServer(join(agentDir, 'mcp.json'))
      || (projectTrusted && typeof ctx?.cwd === 'string' && mcpJsonDefinesServer(join(ctx.cwd, '.pi', 'mcp.json')))) {
      notify(ctx, 'override', 'An mcp.json fai-browser entry overrides the FAI extension; remove it to let FAI wake '
        + 'this session');
    }
    let record = null;
    if (sessionId && usable && env.FAI_WAKE !== '0') {
      try {
        record = await openSocket(ctx, sessionId);
      } catch {
        record = null;
      }
    }
    let wakeEnv = {};
    if (record) {
      wakeEnv = { [ENV.socket]: record.path, [ENV.token]: record.token, [ENV.session]: sessionId };
      if (!Object.values(wakeEnv).every(safeConfigValue)) {
        // Fail closed: the server still works, FAI shows the copy line.
        record.closed = true;
        record.server.close();
        rmSync(record.dir, { recursive: true, force: true });
        record = null;
        wakeEnv = {};
      }
    }
    current = record;
    register(ctx, wakeEnv);
  };

  pi.on('session_start', (event, ctx) => {
    if (!supported) {
      notify(ctx, 'version', `FAI Browser needs pi ${MIN_PI_VERSION} or newer`);
      return undefined;
    }
    // Serialized: a second session_start waits for the first, then finds the socket already there.
    chain = chain.then(() => start(ctx)).catch(() => {});
    return chain;
  });

  pi.on('session_shutdown', () => {
    chain = chain.then(() => closeCurrent()).catch(() => {});
    // Close now as well: pi may exit before the chain runs.
    closeCurrent();
    return chain;
  });

  pi.on('before_agent_start', event => {
    if (!supported) return undefined;
    let tools = [];
    try {
      tools = pi.getAllTools?.() ?? [];
    } catch {
      return undefined;
    }
    const tool = tools.find(item => typeof item?.name === 'string' && item.name.startsWith(PI_TOOL_PREFIX)
      && typeof item.namespace?.instructions === 'string' && item.namespace.instructions);
    const sections = event?.systemPromptOptions?.sections;
    if (!tool || !sections || typeof sections !== 'object') return undefined;
    let text = tool.namespace.instructions.slice(0, MAX_INSTRUCTIONS);
    if (!text.includes(PI_TOOL_PREFIX)) text = `${text}\n${MAPPING}`;
    if (sections[SECTION] !== text) sections[SECTION] = text;
    return undefined;
  });
}
