// Reading the connected host's own conversation for the FAI chat panel (spec #80, docs/REFERENCE.md "Chat panel").
// Runs inside the MCP server, which alone knows its host, its session and the host's settings folder, and reads only
// a session it can name itself: Claude Code's own CLAUDE_CODE_SESSION_ID, a Codex thread id seen in its own tool
// calls, an OpenCode root session FAI's plugin tagged on its own calls. It reads only while the daemon asks (a panel
// watches) and only what is new since the cursor. Messages only: the user's own words and the agent's text. Tool calls,
// tool results, thinking, subagents and host-injected text are never returned; a record it does not recognise is
// skipped. None of these formats is documented by its host (checked on Claude Code 2.1.325, Codex 0.169.0 and
// OpenCode 1.19.5; fixtures in test/fixtures/chat).
//
// - Claude Code: <CLAUDE_CONFIG_DIR or ~/.claude>/projects/<slug>/<sessionId>.jsonl, one JSON record per line.
// - Codex: <CODEX_HOME or ~/.codex>/sessions/YYYY/MM/DD/rollout-<timestamp>-<threadId>.jsonl.
// - OpenCode: FAI's plugin answers a `read` request on its private socket (src/opencode-plugin.js).
import { connect } from 'node:net';
import { open, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { OPENCODE_SESSION } from './wake.js';

// The newest messages the daemon keeps per watched session, and the longest text it shows of one.
export const CHAT_KEEP = 200;
export const MAX_MESSAGE_TEXT = 8_000;
export const CLIPPED = '… (clipped)';
// A first read starts this far from the end of a long file; one read takes at most READ_BYTES of it.
export const TAIL_BYTES = 4 * 1024 * 1024;
const READ_BYTES = 8 * 1024 * 1024;
// What one post to the daemon may carry in UTF-8 bytes (its request bodies stop at 1 MB): the newest messages that fit.
const POST_BYTES = 900_000;
const OPENCODE_READ_TIMEOUT_MS = 5_000;
const OPENCODE_ANSWER_MAX = 4 * 1024 * 1024;
const FAI_PREFIX = '[FAI Browser] ';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID = String.raw`([A-Za-z0-9][A-Za-z0-9._:-]{0,127})`;
// The chat template (src/wake.js wakeText kind chat): the user's own words come back as a user message. No end anchor:
// a host may add its own text after FAI's (Claude Code's peer-message trailer, "\n\nThis came from another Claude
// session — …"); the JSON string ends at its first unescaped quote.
const CHAT_TEXT = new RegExp(String.raw`^\[FAI Browser\] The user sent you a message from the FAI chat panel \(the user's own words\): ("(?:[^"\\]|\\.)*")`);
// FAI's other wake texts become one short FAI-written line naming the event and its ids.
const FAI_LINES = [
  [new RegExp(String.raw`^\[FAI Browser\] The user approved action ${ID} on tab request ${ID}\.`), m => `FAI: approved action ${m[1]} on tab request ${m[2]}`],
  [new RegExp(String.raw`^\[FAI Browser\] The user denied action ${ID} on tab request ${ID}\.`), m => `FAI: denied action ${m[1]} on tab request ${m[2]}`],
  [new RegExp(String.raw`^\[FAI Browser\] The user approved tab request ${ID} `), m => `FAI: approved tab request ${m[1]}`],
  [new RegExp(String.raw`^\[FAI Browser\] The user resumed tab request ${ID}:`), m => `FAI: resumed tab request ${m[1]}`],
  [new RegExp(String.raw`^\[FAI Browser\] The user invited you to work in a browser tab they have open \(invite ${ID},`), m => `FAI: invited you to a browser tab (invite ${m[1]})`],
];
// Claude Code wraps what it injects into the user's turn in these tags (local commands, hooks, reminders, background
// task notifications); a user record that starts with one is not the user's own words.
const CLAUDE_INJECTED = /^\s*<(?:system-reminder|command-name|command-message|command-args|local-command-[a-z-]+|task-notification|bash-input|bash-stdout|bash-stderr|user-prompt-submit-hook)\b/;
// Claude Code's line for a message another process wrote to the session's messaging socket (FAI's wakes).
const CLAUDE_PEER = /^Another Claude session sent a message:\n/;
// Codex: injected user items, recognised by their text when a record carries no content_item_kinds.
const CODEX_INJECTED = /^\s*(?:<(?:environment_context|user_instructions|permissions instructions|skills_instructions|collaboration_mode|turn_aborted|user_shell_command)\b|# AGENTS\.md instructions for )/;

export class ChatReadError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** One message, its text clipped to MAX_MESSAGE_TEXT (a clipped text says so). */
export function clipText(text) {
  const value = String(text ?? '');
  return value.length > MAX_MESSAGE_TEXT ? value.slice(0, MAX_MESSAGE_TEXT - CLIPPED.length) + CLIPPED : value;
}

/** A FAI wake text as the panel shows it: the chat template is the user's own words, any other a short FAI line. */
export function faiMessage(text) {
  const chat = CHAT_TEXT.exec(text);
  if (chat) {
    try {
      const words = JSON.parse(chat[1]);
      if (typeof words === 'string') return { role: 'user', text: words };
    } catch {
      // Not the template after all: a FAI line below.
    }
  }
  for (const [pattern, line] of FAI_LINES) {
    const match = pattern.exec(text);
    if (match) return { role: 'fai', text: line(match) };
  }
  return { role: 'fai', text: 'FAI: a FAI Browser message' };
}

// The shape every reader returns: user, agent or fai, the text clipped, FAI's own texts as FAI lines.
function shaped(id, role, text, at) {
  const value = String(text ?? '').trim();
  if (!value) return null;
  const message = role === 'user' && value.startsWith(FAI_PREFIX) ? faiMessage(value) : { role, text: value };
  return { id: String(id), role: message.role, text: clipText(message.text), at: isoOrNull(at) };
}

function isoOrNull(value) {
  const ms = typeof value === 'number' ? value : Date.parse(String(value ?? ''));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function textBlocks(content, type) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(block => block?.type === type && typeof block.text === 'string').map(block => block.text).join('\n\n');
}

/**
 * One Claude Code record: {message?, busy?}. busy turns true when a turn runs (a user prompt, a tool result, an agent
 * step that asks for a tool) and false when it ends (an assistant stop other than a tool call, the turn's duration
 * record, an interruption).
 */
export function claudeRecord(entry) {
  if (!entry || typeof entry !== 'object' || entry.isSidechain) return {};
  if (entry.type === 'system') return entry.subtype === 'turn_duration' ? { busy: false } : {};
  if (entry.type === 'assistant') {
    const stop = entry.message?.stop_reason;
    const text = textBlocks(entry.message?.content, 'text');
    const ended = typeof stop === 'string' && stop !== 'tool_use' && stop !== 'pause_turn';
    return { message: text ? { role: 'agent', text } : null, busy: !ended };
  }
  if (entry.type !== 'user' || entry.isCompactSummary || entry.isVisibleInTranscriptOnly) return {};
  const content = entry.message?.content;
  if (Array.isArray(content) && content.some(block => block?.type === 'tool_result')) return { busy: true };
  const text = textBlocks(content, 'text');
  if (entry.isMeta) {
    // Another process's message on the session's messaging socket: only FAI's own are shown (as FAI lines, or the
    // user's words for a chat message); any of them starts a turn.
    if (entry.origin?.kind !== 'peer' || !CLAUDE_PEER.test(text)) return {};
    const body = text.replace(CLAUDE_PEER, '');
    return body.startsWith(FAI_PREFIX) ? { message: { role: 'user', text: body }, busy: true } : { busy: true };
  }
  if (/^\[Request interrupted by user/.test(text)) return { busy: false };
  if (!text.trim() || CLAUDE_INJECTED.test(text)) return {};
  return { message: { role: 'user', text }, busy: true };
}

/** One Codex rollout record: {message?, busy?}. A turn runs from task_started to task_complete or turn_aborted. */
export function codexRecord(entry) {
  const payload = entry?.payload;
  if (!payload || typeof payload !== 'object') return {};
  if (entry.type === 'event_msg') {
    if (payload.type === 'task_started') return { busy: true };
    if (payload.type === 'task_complete' || payload.type === 'turn_aborted') return { busy: false };
    return {};
  }
  if (entry.type !== 'response_item' || payload.type !== 'message') return {};
  const parts = Array.isArray(payload.content) ? payload.content : [];
  if (payload.role === 'assistant') {
    const text = textBlocks(parts, 'output_text');
    return text ? { message: { role: 'agent', text } } : {};
  }
  if (payload.role !== 'user') return {};
  // Codex names what each part is: the user's text, or the AGENTS.md and environment it injects.
  const kinds = payload.internal_chat_message_metadata_passthrough?.content_item_kinds;
  const text = parts.filter((part, index) => part?.type === 'input_text' && typeof part.text === 'string'
    && (Array.isArray(kinds) && kinds.length === parts.length ? kinds[index] === 'user.text' : true)
    && !CODEX_INJECTED.test(part.text))
    .map(part => part.text).join('\n\n');
  return text.trim() ? { message: { role: 'user', text } } : {};
}

// The cursor of a file reader: "<offset>.<busy 0|1>[.s]" (s: inside a line too long to read, skipped to its end).
function parseCursor(cursor) {
  const match = /^(\d{1,15})\.([01])(\.s)?$/.exec(String(cursor ?? ''));
  return match ? { offset: Number(match[1]), busy: match[2] === '1', skip: Boolean(match[3]) } : null;
}

const formatCursor = ({ offset, busy, skip }) => `${offset}.${busy ? 1 : 0}${skip ? '.s' : ''}`;

/**
 * Read the JSON lines of `path` after `cursor` through `record` (claudeRecord or codexRecord): {messages, busy,
 * cursor}. Only complete lines count (a line the host is still writing waits for the next read); a line that does not
 * parse is skipped. Without a cursor (or one past the end: the file was replaced) it starts TAIL_BYTES from the end.
 * Message ids are the line's byte offset, so the same line keeps its id across reads.
 */
export async function readJsonLines(path, cursor, record, { tailBytes = TAIL_BYTES, readBytes = READ_BYTES } = {}) {
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    let state = parseCursor(cursor);
    if (!state || state.offset > size) {
      const offset = Math.max(0, size - tailBytes);
      state = { offset, busy: false, skip: offset > 0 };
    }
    let { offset, busy, skip } = state;
    const messages = [];
    while (offset < size) {
      const length = Math.min(readBytes, size - offset);
      const chunk = Buffer.alloc(length);
      const { bytesRead } = await handle.read(chunk, 0, length, offset);
      if (!bytesRead) break;
      const data = chunk.subarray(0, bytesRead);
      let start = 0;
      if (skip) {
        const newline = data.indexOf(10);
        if (newline < 0) {
          offset += bytesRead;
          continue;
        }
        start = newline + 1;
        skip = false;
      }
      const last = data.lastIndexOf(10);
      if (last < start) {
        // No complete line here: one too long to read is skipped to its end; a short one is still being written.
        if (bytesRead - start >= readBytes) {
          skip = true;
          offset += bytesRead;
          continue;
        }
        offset += start;
        break;
      }
      let at = start;
      while (at <= last) {
        const end = data.indexOf(10, at);
        const line = data.toString('utf8', at, end);
        let entry = null;
        try {
          entry = JSON.parse(line);
        } catch {
          // Not a record: skipped, never shown.
        }
        const found = entry ? record(entry) : {};
        if (typeof found.busy === 'boolean') busy = found.busy;
        if (found.message) {
          const message = shaped(offset + at, found.message.role, found.message.text, entry.timestamp);
          if (message) messages.push(message);
        }
        at = end + 1;
      }
      offset += last + 1;
    }
    return { messages: messages.slice(-CHAT_KEEP), busy, cursor: formatCursor({ offset, busy, skip }) };
  } finally {
    await handle.close();
  }
}

async function exists(path) {
  try {
    await (await open(path, 'r')).close();
    return true;
  } catch {
    return false;
  }
}

async function dirNames(path) {
  try {
    return (await readdir(path, { withFileTypes: true })).filter(item => item.isDirectory()).map(item => item.name);
  } catch {
    return [];
  }
}

/** Claude Code's file for session `sessionId`, or null. Its project slug is not needed: every project is checked. */
export async function findClaudeConversation(sessionId, { env = process.env, home = homedir() } = {}) {
  if (!UUID.test(String(sessionId ?? ''))) return null;
  const root = join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'projects');
  for (const dir of await dirNames(root)) {
    const path = join(root, dir, `${sessionId}.jsonl`);
    if (await exists(path)) return path;
  }
  return null;
}

/** Codex's rollout file for thread `threadId`, newest day first, or null. */
export async function findCodexRollout(threadId, { env = process.env, home = homedir() } = {}) {
  if (!UUID.test(String(threadId ?? ''))) return null;
  const root = join(env.CODEX_HOME || join(home, '.codex'), 'sessions');
  const suffix = `-${threadId.toLowerCase()}.jsonl`;
  const newest = names => names.filter(name => /^\d+$/.test(name)).sort((a, b) => Number(b) - Number(a));
  for (const year of newest(await dirNames(root))) {
    for (const month of newest(await dirNames(join(root, year)))) {
      for (const day of newest(await dirNames(join(root, year, month)))) {
        let names = [];
        try {
          names = await readdir(join(root, year, month, day));
        } catch {
          continue;
        }
        const name = names.find(item => item.startsWith('rollout-') && item.toLowerCase().endsWith(suffix));
        if (name) return join(root, year, month, day, name);
      }
    }
  }
  return null;
}

/**
 * Ask FAI's OpenCode plugin for session `sessionID`'s messages after message id `after`: one connection, the lines
 * `{"type":"auth","token":…}` and `{"type":"read","sessionID":…,"after":…}`, one answer line. Resolves the plugin's
 * {messages, busy, cursor}; rejects with a ChatReadError (an older plugin answers bad_text: it cannot read).
 */
export function readOpencodePlugin({ path, token, sessionID, after = null, timeoutMs = OPENCODE_READ_TIMEOUT_MS }) {
  return new Promise((resolveRead, rejectRead) => {
    let settled = false;
    let answer = '';
    const socket = connect({ path });
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) rejectRead(error);
      else resolveRead(value);
    };
    const judge = () => {
      const newline = answer.indexOf('\n');
      if (newline < 0) return finish(new ChatReadError('unreadable', 'The FAI plugin gave no answer.'));
      let parsed = null;
      try {
        parsed = JSON.parse(answer.slice(0, newline));
      } catch {
        // Judged below.
      }
      if (parsed?.ok !== true || !Array.isArray(parsed.messages)) {
        return finish(new ChatReadError('unreadable', 'The FAI plugin could not read this session.'));
      }
      return finish(null, parsed);
    };
    const timer = setTimeout(() => finish(new ChatReadError('unreadable', 'The FAI plugin did not answer in time.')), timeoutMs);
    timer.unref?.();
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      answer += chunk;
      if (answer.length > OPENCODE_ANSWER_MAX) return finish(new ChatReadError('unreadable', 'The FAI plugin answered too much.'));
      if (answer.includes('\n')) judge();
      return undefined;
    });
    socket.on('error', () => (answer ? judge() : finish(new ChatReadError('unreadable', 'Could not reach the FAI plugin.'))));
    socket.on('close', () => judge());
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ type: 'auth', token })}\n${JSON.stringify({ type: 'read', sessionID,
        ...(after ? { after } : {}) })}\n`);
    });
  });
}

/**
 * The reader of one MCP server's own conversation. `read({target, cursor})`: target is the host's session id
 * (Claude Code's session, a Codex thread, an OpenCode root session), cursor the one the daemon handed back. Resolves
 * {messages, busy, cursor} or {error: {code, host, version}}: not_ready (no session to read yet), unreadable (the
 * source is missing or not understood; sending still works). `opencode()`: the plugin channel {path, token} or null.
 */
export function createChatReader({ host, env = process.env, home = homedir(), version = null, opencode = () => null,
  readPlugin = readOpencodePlugin }) {
  const paths = new Map();
  const failure = code => ({ error: { code, host, version: cleanVersion(version) } });

  async function fromFile(target, cursor, find, record) {
    let path = paths.get(target) ?? null;
    if (!path) {
      path = await find(target, { env, home });
      if (!path) return failure('unreadable');
      paths.set(target, path);
    }
    try {
      return await readJsonLines(path, cursor, record);
    } catch {
      paths.delete(target);
      return failure('unreadable');
    }
  }

  return {
    async read({ target, cursor = null }) {
      if (!target) return failure('not_ready');
      if (host === 'claude') return fromFile(target, cursor, findClaudeConversation, claudeRecord);
      if (host === 'codex') return fromFile(target, cursor, findCodexRollout, codexRecord);
      if (host !== 'opencode' || !OPENCODE_SESSION.test(String(target))) return failure('unreadable');
      const channel = opencode();
      if (!channel) return failure('unreadable');
      try {
        const answer = await readPlugin({ ...channel, sessionID: target, after: cursor });
        const messages = answer.messages.map(item => (['user', 'agent'].includes(item?.role) && typeof item.id === 'string'
          ? shaped(item.id, item.role, item.text, item.at) : null)).filter(Boolean);
        const next = typeof answer.cursor === 'string' && answer.cursor.length <= 128 ? answer.cursor : cursor;
        return { messages: messages.slice(-CHAT_KEEP), busy: answer.busy === true, cursor: next };
      } catch {
        return failure('unreadable');
      }
    },
  };
}

/**
 * The newest messages that fit one post to the daemon, measured as the serialized UTF-8 bytes the daemon counts (its
 * request bodies stop at 1 MB; text in a non-Latin script takes 2-3 bytes a character).
 */
export function fitPost(messages) {
  let total = 0;
  const kept = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    total += Buffer.byteLength(JSON.stringify(messages[index])) + 1;
    if (total > POST_BYTES) break;
    kept.unshift(messages[index]);
  }
  return kept;
}

function cleanVersion(value) {
  const text = typeof value === 'string' ? value.replace(/[^0-9A-Za-z.+-]/g, '').slice(0, 32) : '';
  return text || 'unknown version';
}
