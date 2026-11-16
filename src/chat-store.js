// FAI chats on disk (spec #84, "Stored chats and resuming"): FAI-Local-Chats/chats/<chatId>/chat.jsonl and the chat's
// files folder beside it. The transcript's first line is a header {type: 'header', provider, model, reportedModel,
// conversationId, title, startedAt}; every other line is one message {id, role: user|agent|fai, text, at, files} (a
// `fai` line may add `code` and `providerText`). Writes to one chat run one after another; the header is rewritten
// by a rename, never in place.
import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const TEXT_LIMIT = 8000;
export const TITLE_LIMIT = 60;
export const PAGE_SIZE = 50;
const CLIPPED = ' [clipped at 8,000 characters]';
const CHAT_ID = /^c[a-f0-9]{20}$/;
const ROLES = new Set(['user', 'agent', 'fai']);

export const LOCAL_CHATS_NAME = 'FAI-Local-Chats';

/** FAI-Local-Chats: in the user's home directory (%USERPROFILE% on Windows), or <FAI_HOME>/FAI-Local-Chats. */
export function localChatsDir(env = process.env, platform = process.platform) {
  if (env.FAI_HOME) return join(resolve(env.FAI_HOME), LOCAL_CHATS_NAME);
  const home = platform === 'win32' ? env.USERPROFILE || homedir() : env.HOME || homedir();
  return join(home, LOCAL_CHATS_NAME);
}

/** True for an id this store makes: it is also a safe folder name. */
export function validChatId(chatId) {
  return typeof chatId === 'string' && CHAT_ID.test(chatId);
}

/** A new chat id. */
export function newChatId() {
  return `c${randomBytes(10).toString('hex')}`;
}

/** Text clipped to 8,000 characters, saying so. */
export function clipText(text) {
  const value = String(text ?? '');
  return value.length > TEXT_LIMIT ? value.slice(0, TEXT_LIMIT) + CLIPPED : value;
}

function parseLines(content) {
  const lines = [];
  for (const raw of content.split('\n')) {
    if (!raw.trim()) continue;
    try {
      const value = JSON.parse(raw);
      if (value && typeof value === 'object' && !Array.isArray(value)) lines.push(value);
    } catch {
      // A line cut short by a crash, or not FAI's: skipped.
    }
  }
  return lines;
}

/** `root`: the FAI-Local-Chats folder. `now`: a ms clock. */
export function createChatStore({ root, now = Date.now }) {
  const chatsDir = join(root, 'chats');
  const queues = new Map();
  const nextIds = new Map();
  const at = () => new Date(now()).toISOString();

  const dirOf = chatId => {
    if (!validChatId(chatId)) throw new Error('Not a chat id');
    return join(chatsDir, chatId);
  };
  const fileOf = chatId => join(dirOf(chatId), 'chat.jsonl');

  // One write at a time per chat; a failed write does not block the next.
  function serial(chatId, task) {
    const run = (queues.get(chatId) ?? Promise.resolve()).then(task);
    const tail = run.catch(() => {});
    queues.set(chatId, tail);
    tail.then(() => {
      if (queues.get(chatId) === tail) queues.delete(chatId);
    });
    return run;
  }

  async function readChat(chatId) {
    let content;
    try {
      content = await readFile(fileOf(chatId), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    const [header, ...records] = parseLines(content);
    if (header?.type !== 'header') return null;
    return { header, records: records.filter(record => Number.isInteger(record.id) && ROLES.has(record.role)) };
  }

  const headerView = (chatId, header) => ({ chatId, provider: header.provider, model: header.model ?? null,
    reportedModel: header.reportedModel ?? null, conversationId: header.conversationId ?? null,
    title: header.title ?? '', startedAt: header.startedAt ?? null });

  return {
    root,
    filesDir: chatId => join(dirOf(chatId), 'files'),

    /** A new chat's folder, files folder and header. Resolves the header view. */
    async create({ chatId = newChatId(), provider, model = null, title }) {
      const header = { type: 'header', v: 1, provider, model, reportedModel: null, conversationId: null,
        title: String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, TITLE_LIMIT), startedAt: at() };
      await mkdir(join(dirOf(chatId), 'files'), { recursive: true });
      await writeFile(fileOf(chatId), `${JSON.stringify(header)}\n`, { flag: 'wx' });
      nextIds.set(chatId, 1);
      return headerView(chatId, header);
    },

    /** The header view, or null when there is no such chat. */
    async header(chatId) {
      if (!validChatId(chatId)) return null;
      const chat = await readChat(chatId);
      return chat ? headerView(chatId, chat.header) : null;
    },

    /** Change header fields (model, reportedModel, conversationId). */
    updateHeader(chatId, patch) {
      return serial(chatId, async () => {
        const file = fileOf(chatId);
        const content = await readFile(file, 'utf8');
        const split = content.indexOf('\n');
        const header = { ...JSON.parse(content.slice(0, split)), ...patch, type: 'header' };
        const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
        await writeFile(temporary, `${JSON.stringify(header)}${content.slice(split)}`);
        await rename(temporary, file);
        return headerView(chatId, header);
      });
    },

    /** Append one message; resolves the record. `extra`: code and providerText on a `fai` line. */
    append(chatId, { role, text, files = [], ...extra }) {
      if (!ROLES.has(role)) throw new Error(`Unknown role ${role}`);
      return serial(chatId, async () => {
        if (!nextIds.has(chatId)) {
          const chat = await readChat(chatId);
          if (!chat) throw new Error('No such chat');
          nextIds.set(chatId, chat.records.reduce((max, record) => Math.max(max, record.id), 0) + 1);
        }
        const id = nextIds.get(chatId);
        const record = { id, role, text: clipText(text), at: at(), files, ...extra };
        await appendFile(fileOf(chatId), `${JSON.stringify(record)}\n`);
        nextIds.set(chatId, id + 1);
        return record;
      });
    },

    /** The header view and the messages after id `after` (0: all), or null when there is no such chat. */
    async read(chatId, { after = 0 } = {}) {
      if (!validChatId(chatId)) return null;
      const chat = await readChat(chatId);
      if (!chat) return null;
      return { chat: headerView(chatId, chat.header), records: chat.records.filter(record => record.id > after) };
    },

    /**
     * Every chat on disk, most recently active first (the transcript's modification time), `limit` at a time from
     * `offset`. Resolves { chats: [header view + lastActiveAt], total }.
     */
    async list({ offset = 0, limit = PAGE_SIZE } = {}) {
      let names;
      try {
        names = (await readdir(chatsDir)).filter(validChatId);
      } catch (error) {
        if (error.code === 'ENOENT') return { chats: [], total: 0 };
        throw error;
      }
      const dated = [];
      for (const chatId of names) {
        try {
          dated.push({ chatId, mtimeMs: (await stat(fileOf(chatId))).mtimeMs });
        } catch {
          // A folder without a transcript is not a chat.
        }
      }
      dated.sort((a, b) => b.mtimeMs - a.mtimeMs || a.chatId.localeCompare(b.chatId));
      const chats = [];
      for (const { chatId, mtimeMs } of dated.slice(offset, offset + limit)) {
        const chat = await readChat(chatId);
        if (chat) chats.push({ ...headerView(chatId, chat.header), lastActiveAt: new Date(mtimeMs).toISOString() });
      }
      return { chats, total: dated.length };
    },

    /** Remove the chat's folder (transcript and files). Resolves true when it existed. */
    remove(chatId) {
      return serial(chatId, async () => {
        const dir = dirOf(chatId);
        const existed = await stat(dir).then(() => true, () => false);
        await rm(dir, { recursive: true, force: true });
        nextIds.delete(chatId);
        return existed;
      });
    },
  };
}
