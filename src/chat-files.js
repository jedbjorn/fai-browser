// FAI chats' attachments (spec #84 "Attachments", decision #28). The panel sends one file per `chat_file` message; the
// daemon keeps it waiting under a random id in its own state folder until the message that names it is sent, then
// moves it into chats/<chatId>/files/ under a cleaned name. FAI keeps only its own limits: 10 files a message, 25 MB
// each, and a name that cannot leave the folder. It never checks or converts the type and never opens a file.
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const MAX_FILES = 10;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const NAME_LIMIT = 100;
// Files waiting to be sent: at most this many at once, each for at most this long.
export const WAITING_LIMIT = 30;
export const WAITING_MS = 60 * 60_000;
const FILE_ID = /^f[a-f0-9]{20}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const MIME = /^[\w.+-]{1,60}\/[\w.+-]{1,100}$/;
// Names a provider's program would load from its working folder as instructions or config (Claude's CLAUDE.md, Codex's
// and OpenCode's AGENTS.md, OpenCode's opencode.json): an attached file never takes one of them.
const PROGRAM_FILES = /^(?:agents(?:\.override)?\.md|claude(?:\.local)?\.md|opencode\.jsonc?)$/i;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(?:\..*)?$/i;

export class ChatFileError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * A file name that stays inside the chat's files folder on every OS: the last path component only, no control,
 * zero-width or bidi characters, no characters Windows refuses (or the comma Codex splits -i values on), no leading
 * dots, no trailing dots or spaces, not a Windows device name, not a name a program loads as instructions, at most
 * NAME_LIMIT characters with its extension kept. Never empty.
 */
export function cleanFileName(name) {
  let base = String(name ?? '').split(/[\\/]/).pop().normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2028\u2029\u2060-\u2069\ufeff]/g, '')
    .replace(/[<>:"|?*,]/g, '_').replace(/\s+/g, ' ').trim()
    .replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (!base) base = 'file';
  if (WINDOWS_RESERVED.test(base) || PROGRAM_FILES.test(base)) base = `attached-${base}`;
  if (base.length > NAME_LIMIT) {
    const dot = base.lastIndexOf('.');
    const extension = dot > 0 && base.length - dot <= 16 ? base.slice(dot) : '';
    base = base.slice(0, NAME_LIMIT - extension.length).trimEnd() + extension;
  }
  return base;
}

// "name.ext" -> "name (2).ext" for the second file of that name in a folder.
function numbered(name, n) {
  if (n === 1) return name;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
}

/** `dir`: the daemon's folder for files waiting to be sent. `now`: a ms clock. */
export function createChatUploads({ dir, now = Date.now }) {
  const waiting = new Map();
  let cleared = null;

  // The folder starts empty: files a previous daemon kept waiting are gone with it.
  const ready = () => {
    cleared ??= rm(dir, { recursive: true, force: true }).then(() => mkdir(dir, { recursive: true }));
    return cleared;
  };

  async function drop(entry) {
    waiting.delete(entry.fileId);
    await rm(entry.path, { force: true });
  }

  async function sweep() {
    const t = now();
    for (const entry of [...waiting.values()]) if (t - entry.at > WAITING_MS) await drop(entry);
  }

  return {
    /**
     * Keep one file until its message is sent. `chatId`: the chat it is for, or null for a new chat. `data`: the
     * file's bytes in base64. Resolves {fileId}. Throws ChatFileError: bad_request, file_too_large, too_many_files.
     */
    async add({ chatId = null, name, mime = null, data }) {
      if (typeof name !== 'string' || !name || name.length > 1000) throw new ChatFileError('bad_request', 'A file needs a name.');
      if (typeof data !== 'string' || data.length % 4 !== 0 || !BASE64.test(data)) {
        throw new ChatFileError('bad_request', 'The file\'s contents could not be read.');
      }
      if ((data.length / 4) * 3 - (data.match(/=*$/)[0].length) > MAX_FILE_BYTES) {
        throw new ChatFileError('file_too_large', 'A file can be at most 25 MB.');
      }
      await ready();
      await sweep();
      if (waiting.size >= WAITING_LIMIT) {
        throw new ChatFileError('too_many_files', 'Too many files are waiting to be sent. Send or start a new message first.');
      }
      const bytes = Buffer.from(data, 'base64');
      const fileId = `f${randomBytes(10).toString('hex')}`;
      const path = join(dir, fileId);
      await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
      waiting.set(fileId, { fileId, chatId, name: cleanFileName(name), size: bytes.length,
        type: typeof mime === 'string' && MIME.test(mime) ? mime.toLowerCase() : '', path, at: now() });
      return { fileId };
    },

    /**
     * The waiting files a message names, checked (and still waiting): at most MAX_FILES, no repeats, each for this
     * chat (`chatId`, or null for a new chat). Throws ChatFileError: bad_request, too_many_files, unknown_file.
     */
    check(fileIds, chatId = null) {
      if (fileIds === undefined || fileIds === null) return [];
      if (!Array.isArray(fileIds)) throw new ChatFileError('bad_request', 'files must be a list of file ids.');
      if (fileIds.length > MAX_FILES) throw new ChatFileError('too_many_files', `Attach at most ${MAX_FILES} files to a message.`);
      if (new Set(fileIds).size !== fileIds.length) throw new ChatFileError('bad_request', 'A file is attached twice.');
      return fileIds.map(fileId => {
        const entry = typeof fileId === 'string' && FILE_ID.test(fileId) ? waiting.get(fileId) : undefined;
        if (!entry || entry.chatId !== chatId || now() - entry.at > WAITING_MS) {
          throw new ChatFileError('unknown_file', 'A file is no longer waiting to be sent. Attach it again.');
        }
        return entry;
      });
    },

    /**
     * Move checked files into the chat's files folder, each under its cleaned name (numbered when the name is taken;
     * an existing file or link is never written through). Resolves [{name, size, type, path}].
     */
    async commit(entries, filesDir) {
      await mkdir(filesDir, { recursive: true });
      const moved = [];
      for (const entry of entries) {
        if (waiting.get(entry.fileId) !== entry) {
          throw new ChatFileError('unknown_file', 'A file is no longer waiting to be sent. Attach it again.');
        }
        waiting.delete(entry.fileId);
        for (let n = 1; ; n++) {
          const name = numbered(entry.name, n);
          const path = join(filesDir, name);
          try {
            await copyFile(entry.path, path, constants.COPYFILE_EXCL);
            moved.push({ name, size: entry.size, type: entry.type, path });
            break;
          } catch (error) {
            if (error.code !== 'EEXIST' || n >= 1000) {
              await rm(entry.path, { force: true });
              throw error;
            }
          }
        }
        await rm(entry.path, { force: true });
      }
      return moved;
    },

    /** Files still waiting (tests). */
    waiting: () => waiting.size,
  };
}
