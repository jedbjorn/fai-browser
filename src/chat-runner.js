// FAI chats (spec #84, "A turn"): the daemon's chat runner. One turn is one provider process, started with no shell
// and no window in the chat's own files folder, and nothing runs between turns. The runner checks the provider is
// available, mints a single-use turn token, reads the program's output into the transcript, and enforces the limits:
// one running turn per chat, three across all chats, Stop, and 30 minutes.
//
// Failures FAI can name are fixed codes with one FAI-written line (CHAT_CODES). A turn the program itself fails is
// chat_turn_failed with the exit status and the program's own error, clipped plain text (decision #28).
import { execFile, spawn as spawnProcess } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { newChatId } from './chat-store.js';
import { PROVIDERS, PROVIDER_NAMES, MIN_VERSIONS, TURN_TOKEN_ENV, createOutputParser, findProgram, parseVersion,
  signedIn, statusArgs, turnCommand, versionSupported } from './chat-providers.js';

export const MAX_RUNNING = 3;
export const TURN_LIMIT_MS = 30 * 60_000;
export const CHAT_TEXT_LIMIT = 4000;
export const PROVIDER_ERROR_LIMIT = 1000;
const CHECK_TIMEOUT_MS = 15_000;
const KILL_GRACE_MS = 5_000;
const CLOSE_WAIT_MS = 5_000;
const STDERR_KEEP = 8192;

const FIX_INSTALL = {
  claude: 'Install Claude Code (the claude command line), then try again.',
  codex: 'Install the Codex command line (codex), then try again.',
  opencode: 'Install the OpenCode command line (opencode, version 1), then try again.',
};
const FIX_SIGN_IN = {
  claude: 'Sign in to the Claude command line once: run "claude auth login" in a terminal.',
  codex: 'Sign in to the Codex command line once: run "codex login" in a terminal.',
};

/** FAI's own reasons: one fixed line each (spec #84 "Availability"). */
export const CHAT_CODES = Object.freeze({
  chat_not_installed: provider => `${PROVIDER_NAMES[provider]} is not installed. ${FIX_INSTALL[provider]}`,
  chat_signed_out: provider => `${PROVIDER_NAMES[provider]} is not signed in. ${FIX_SIGN_IN[provider] ?? ''}`.trim(),
  chat_unsupported_version: provider => `This version of ${PROVIDER_NAMES[provider]} is not supported. Update it to `
    + `${MIN_VERSIONS[provider]} or newer${provider === 'opencode' ? ' (version 1; OpenCode 2 is not supported yet)' : ''}.`,
  chat_no_model: () => 'Choose an OpenCode model in Browser Chat settings first.',
  chat_start_failed: provider => `${PROVIDER_NAMES[provider]} could not be started.`,
  chat_stopped: () => 'Stopped.',
  chat_timed_out: () => 'The turn ran for 30 minutes and was stopped.',
  // One running turn per chat, MAX_RUNNING across all chats.
  chat_too_many: (provider, inThisChat) => (inThisChat ? 'This chat is already running a turn. Wait for it, or stop it.'
    : `${MAX_RUNNING} chats are already running. Wait for one to finish, or stop one.`),
  chat_turn_failed: (provider, status) => `${PROVIDER_NAMES[provider]} ended the turn with exit status ${status}.`,
});

export class ChatError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const fail = (code, provider, detail) => new ChatError(code, CHAT_CODES[code](provider, detail));

/**
 * The user's words for spec #80's `chat` template: cleaned like an invite's text, except that line breaks are kept
 * and the limit is 4,000 characters.
 */
export function cleanChatText(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .trim().slice(0, CHAT_TEXT_LIMIT);
}

/** Spec #80's chat template: the text a provider gets for the user's message. */
export function chatTurnText(words) {
  return `[FAI Browser] The user sent you a message from the FAI chat panel (the user's own words): ${JSON.stringify(words)}`;
}

/** The program's own error as shown to the user: plain text, one block, clipped to 1,000 characters. */
export function clipProviderError(text) {
  return String(text ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, PROVIDER_ERROR_LIMIT);
}

// The child's environment: the daemon's, without FAI's own variables (FAI_HOME stays: the MCP server needs it) and
// without the markers of a host session that may have started this daemon (its MCP server auto-starts it).
export function childEnv(env) {
  const out = {};
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== 'string') continue;
    if (/^FAI_/.test(name) && name !== 'FAI_HOME') continue;
    if (name === 'CLAUDECODE' || /^CLAUDE_CODE_MESSAGING_/.test(name)) continue;
    out[name] = value;
  }
  return out;
}

const digest = value => createHash('sha256').update(String(value)).digest();

/**
 * `store`: src/chat-store.js. `root`: FAI-Local-Chats. `prepare()`: run before every turn (recreates the folder and
 * restores FAI's guidance files). `server`: FAI's MCP server {command, args}. `tools`: FAI's tool names.
 * `opencodeConfigDir`: an empty folder FAI owns. `programs`: tests' stand-ins, {provider: {file, prefix}}, used instead
 * of finding the program. `turnLimitMs`, `maxRunning`: test overrides.
 */
export function createChatRunner({ store, root, prepare = async () => {}, server, tools, opencodeConfigDir,
  env = process.env, platform = process.platform, arch = process.arch, programs = {}, log = () => {},
  turnLimitMs = TURN_LIMIT_MS, maxRunning = MAX_RUNNING, spawn = spawnProcess }) {
  const baseEnv = childEnv(env);
  const turns = new Map();
  let closing = false;

  function programFor(provider) {
    if (programs[provider]) return { file: programs[provider].file, prefix: programs[provider].prefix ?? [] };
    const file = findProgram(provider, { env, platform, arch });
    return file ? { file, prefix: [] } : null;
  }

  function run(program, args) {
    return new Promise(resolveRun => {
      execFile(program.file, [...program.prefix, ...args], { env: baseEnv, timeout: CHECK_TIMEOUT_MS, windowsHide: true,
        maxBuffer: 256 * 1024 }, (error, stdout, stderr) => {
        resolveRun({ code: error ? (typeof error.code === 'number' ? error.code : null) : 0,
          missing: ['ENOENT', 'EACCES', 'ENOTDIR'].includes(error?.code), stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      });
    });
  }

  /**
   * Whether `provider` can run a turn now: found, a supported version, and (Claude, Codex) signed in by its own
   * status command. Resolves {provider, name, available: true, code: null, version} or, when not, {..., code, line}.
   */
  async function availability(provider) {
    const answer = { provider, name: PROVIDER_NAMES[provider], available: false, code: null, version: null };
    const refused = code => ({ ...answer, code, line: CHAT_CODES[code](provider) });
    const program = programFor(provider);
    if (!program) return refused('chat_not_installed');
    const versionRun = await run(program, ['--version']);
    if (versionRun.missing) return refused('chat_not_installed');
    const version = versionRun.code === 0 ? parseVersion(versionRun.stdout) : null;
    if (version) answer.version = version.join('.');
    if (!versionSupported(provider, version)) return refused('chat_unsupported_version');
    const args = statusArgs(provider);
    if (args && !signedIn(provider, await run(program, args))) return refused('chat_signed_out');
    return { ...answer, available: true };
  }

  const runningCount = () => turns.size;

  function checkLimits(chatId) {
    if (closing) throw new ChatError('chat_start_failed', 'FAI Browser is shutting down.');
    if (chatId && turns.has(chatId)) throw fail('chat_too_many', null, true);
    if (runningCount() >= maxRunning) throw fail('chat_too_many');
  }

  function signalGroup(pid, signal) {
    try {
      process.kill(-pid, signal);
    } catch {
      // The group is gone.
    }
  }

  // Ends the turn's whole process tree (D8): the process group on macOS and Linux, taskkill /T on Windows.
  function killTree(turn, reason) {
    if (turn.stopReason) return;
    turn.stopReason = reason;
    // Not started yet: launch() sees the reason and starts nothing.
    const pid = turn.child?.pid;
    if (!pid) return;
    if (platform === 'win32') {
      const taskkill = join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32', 'taskkill.exe');
      execFile(taskkill, ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
      return;
    }
    signalGroup(pid, 'SIGTERM');
    turn.killTimer = setTimeout(() => signalGroup(pid, 'SIGKILL'), KILL_GRACE_MS);
    turn.killTimer.unref?.();
  }

  async function finish(turn, { code, startError }) {
    clearTimeout(turn.limitTimer);
    clearTimeout(turn.killTimer);
    const { chatId, provider } = turn;
    let line = null;
    if (turn.stopReason === 'timed_out') line = { code: 'chat_timed_out' };
    else if (turn.stopReason) line = { code: 'chat_stopped' };
    else if (startError) line = { code: 'chat_start_failed' };
    else if (code !== 0 || turn.ended === false) {
      const status = code ?? 'unknown';
      line = { code: 'chat_turn_failed', status,
        providerText: clipProviderError(turn.providerText || turn.stderr) || null };
    }
    try {
      await turn.writes;
      if (line) {
        await store.append(chatId, { role: 'fai', text: CHAT_CODES[line.code](provider, line.status), code: line.code,
          ...(line.providerText ? { providerText: line.providerText } : {}) });
      }
    } catch (error) {
      log('chat_transcript_error', { chatId, message: String(error?.message ?? error).slice(0, 200) });
    }
    turns.delete(chatId);
    log('chat_turn_end', { chatId, turnId: turn.turnId, provider, code: line?.code ?? 'ok' });
    turn.resolveDone({ chatId, turnId: turn.turnId, code: line?.code ?? null });
  }

  function onEvents(turn, events) {
    for (const event of events) {
      if (event.type === 'message') {
        turn.writes = turn.writes.then(() => store.append(turn.chatId, { role: 'agent', text: event.text }));
      } else if (event.type === 'conversation') {
        turn.writes = turn.writes.then(() => store.updateHeader(turn.chatId, { conversationId: event.id }));
      } else if (event.type === 'model') {
        turn.writes = turn.writes.then(() => store.updateHeader(turn.chatId, { reportedModel: event.name }));
      } else if (event.type === 'error') {
        turn.providerText = event.message;
      } else if (event.type === 'end') {
        turn.ended = event.ok;
      }
    }
    turn.writes = turn.writes.catch(error => log('chat_transcript_error', { chatId: turn.chatId,
      message: String(error?.message ?? error).slice(0, 200) }));
  }

  // Starts the provider's process for a turn already reserved in `turns`.
  async function launch(turn, header, text) {
    const { chatId, provider } = turn;
    const program = programFor(provider);
    const filesDir = store.filesDir(chatId);
    let child;
    try {
      if (!program) throw new Error('not found');
      await prepare();
      await mkdir(filesDir, { recursive: true });
      if (opencodeConfigDir) await mkdir(opencodeConfigDir, { recursive: true });
      if (turn.stopReason) return finish(turn, {});
      const command = turnCommand(provider, { text, model: header.model, conversationId: header.conversationId,
        filesDir, root, server, tools, opencodeConfigDir, env: baseEnv, platform });
      child = spawn(program.file, [...program.prefix, ...command.args], {
        cwd: filesDir, env: { ...baseEnv, ...command.env, [TURN_TOKEN_ENV]: turn.token }, shell: false,
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: platform !== 'win32' });
    } catch (error) {
      log('chat_start_error', { chatId, provider, message: String(error?.message ?? error).slice(0, 200) });
      return finish(turn, { startError: true });
    }
    turn.child = child;
    let startError = false;
    child.on('error', error => {
      startError = true;
      log('chat_start_error', { chatId, provider, message: String(error?.code ?? error?.message ?? error).slice(0, 200) });
    });
    const parser = createOutputParser(provider);
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', raw => onEvents(turn, parser.line(raw)));
    child.stderr.on('data', chunk => {
      turn.stderr = (turn.stderr + chunk.toString('utf8')).slice(-STDERR_KEEP);
    });
    child.on('exit', () => {
      // Anything left of the tree after a Stop or the time limit goes now.
      if (turn.stopReason && platform !== 'win32' && child.pid) signalGroup(child.pid, 'SIGKILL');
    });
    child.on('close', code => finish(turn, { code, startError: startError && !turn.stopReason }));
    turn.limitTimer = setTimeout(() => killTree(turn, 'timed_out'), turnLimitMs);
    turn.limitTimer.unref?.();
    log('chat_turn_start', { chatId, turnId: turn.turnId, provider, resumed: Boolean(header.conversationId) });
    return undefined;
  }

  function reserve(chatId, provider) {
    const token = randomBytes(32).toString('base64url');
    let resolveDone;
    const done = new Promise(resolve => {
      resolveDone = resolve;
    });
    const turn = { chatId, provider, turnId: randomBytes(8).toString('hex'), token, tokenDigest: digest(token),
      claimed: false, child: null, stopReason: null, ended: null, providerText: '', stderr: '',
      writes: Promise.resolve(), done, resolveDone };
    turns.set(chatId, turn);
    return turn;
  }

  // Checks and reserves the chat's slot (unless `turn` is already reserved), writes `record`, starts the process.
  async function begin(header, text, record, turn = null) {
    const { chatId, provider } = header;
    if (!turn) {
      checkLimits(chatId);
      if (provider === 'opencode' && !header.model) throw fail('chat_no_model', provider);
      const available = await availability(provider);
      if (!available.available) throw new ChatError(available.code, available.line);
      checkLimits(chatId);
      turn = reserve(chatId, provider);
    }
    try {
      await store.append(chatId, record);
    } catch (error) {
      turns.delete(chatId);
      throw error;
    }
    await launch(turn, header, text);
    return { chatId, turnId: turn.turnId, done: turn.done };
  }

  /**
   * Start a turn in an existing chat with `text` as the provider's text (a FAI template), after appending `record`
   * ({role, text, ...}) to the transcript. Resolves {chatId, turnId, done}; `done` resolves when the turn has ended
   * and its last line is written ({chatId, turnId, code}: a CHAT_CODES code, or null when it succeeded).
   * Rejects with a ChatError: unknown_chat, chat_too_many, chat_no_model, or an availability code.
   */
  async function startTurn({ chatId, text, record }) {
    const header = await store.header(chatId);
    if (!header) throw new ChatError('unknown_chat', 'No such chat.');
    return begin(header, text, record);
  }

  /**
   * The panel's message: `{provider, model, text}` starts a new chat, `{chatId, text}` continues one. The user's words
   * travel inside the chat template. Resolves {chatId, turnId, done}; rejects with a ChatError (bad_request too).
   */
  async function send({ chatId: existing = null, provider = null, model = null, text }) {
    const words = cleanChatText(text);
    if (!words) throw new ChatError('bad_request', 'Type a message first.');
    const record = { role: 'user', text: words, files: [] };
    if (existing) return startTurn({ chatId: existing, text: chatTurnText(words), record });
    if (!PROVIDERS.includes(provider)) throw new ChatError('bad_request', 'Choose a provider.');
    if (model !== null && (typeof model !== 'string' || !model.trim() || model.length > 200)) {
      throw new ChatError('bad_request', 'The model must be a name.');
    }
    checkLimits(null);
    if (provider === 'opencode' && !model) throw fail('chat_no_model', provider);
    const available = await availability(provider);
    if (!available.available) throw new ChatError(available.code, available.line);
    checkLimits(null);
    const chatId = newChatId();
    const turn = reserve(chatId, provider);
    let header;
    try {
      header = await store.create({ chatId, provider, model: model?.trim() ?? null, title: words });
    } catch (error) {
      turns.delete(chatId);
      throw error;
    }
    return begin(header, chatTurnText(words), record, turn);
  }

  /** Stop the chat's running turn and wait for it to end. Resolves true when one was running. */
  async function stop(chatId) {
    const turn = turns.get(chatId);
    if (!turn) return false;
    killTree(turn, 'stopped');
    await turn.done;
    return true;
  }

  /**
   * A turn token presented by an MCP server started inside a turn: accepted once, only while that turn's process
   * runs. Resolves {chatId, turnId}, or null for a token that is unknown, used, or whose turn has ended.
   */
  function claimToken(token) {
    if (typeof token !== 'string' || !token) return null;
    const presented = digest(token);
    for (const turn of turns.values()) {
      if (!turn.child || turn.child.exitCode !== null || turn.child.signalCode !== null || turn.stopReason) continue;
      if (!timingSafeEqual(presented, turn.tokenDigest)) continue;
      if (turn.claimed) return null;
      turn.claimed = true;
      return { chatId: turn.chatId, turnId: turn.turnId };
    }
    return null;
  }

  /** Stop every running turn (daemon shutdown); waits up to a few seconds for them to end. */
  async function close() {
    closing = true;
    const running = [...turns.values()];
    for (const turn of running) killTree(turn, 'stopped');
    let timer;
    await Promise.race([Promise.allSettled(running.map(turn => turn.done)),
      new Promise(resolveWait => {
        timer = setTimeout(resolveWait, CLOSE_WAIT_MS);
      })]);
    clearTimeout(timer);
  }

  return {
    availability,
    /** Every provider's availability, in the default order (Codex, Claude, OpenCode). */
    providers: () => Promise.all(PROVIDERS.map(availability)),
    send,
    startTurn,
    stop,
    claimToken,
    running: chatId => turns.has(chatId),
    busy: () => turns.size > 0,
    close,
  };
}
