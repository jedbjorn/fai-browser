// FAI-Local-Chats (spec #84, "The folder"): where FAI chats run and are kept. Setup creates it with FAI's three files,
// README.txt, AGENTS.md and CLAUDE.md; the chat runner calls writeLocalChats again before a turn, which recreates a
// missing folder and restores a changed guidance file. Only those three files are FAI's: `chats/` (each chat's
// transcript and attached files) is never read, written or removed here, and uninstall leaves the whole folder.
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { renameRetrying } from './chat-store.js';

/**
 * The fixed guidance each provider's program loads from FAI-Local-Chats, above a chat's working folder `chats/<id>/files`
 * (Codex and OpenCode read AGENTS.md, Claude Code reads CLAUDE.md; spec #84 discovery, D6). The same text in both.
 */
export const GUIDANCE = `# FAI chat

<!-- Written by FAI Browser. Setup rewrites this file and FAI restores it before each chat turn: edits do not last. -->

You were started from the chat panel of FAI Browser, in the user's browser. The user reads your replies there.

- Work only through FAI Browser's tools (fai_browser_*). You have no shell and no other tools for this chat.
- Besides those tools you may read only the files the user attached to this chat. The message names each by its path.
- Answer in plain text. The panel shows text only: no markdown formatting, tables or code blocks.
`;

/** README.txt: what the folder is, and what deleting a chat's folder does. `sep` is the platform's path separator. */
export function readmeText(sep = '/') {
  const path = (...parts) => parts.join(sep);
  return `FAI-Local-Chats

This folder holds your FAI chats: the chats you start from the Chat panel of FAI Browser.

  ${path('chats', '<chat>', 'chat.jsonl')}   the chat's messages
  ${path('chats', '<chat>', 'files')}        the files you attached in that chat

Deleting a chat's folder deletes FAI's copy of that chat. The provider's program (Claude, Codex or OpenCode) keeps
its own copy of the conversation in its own store; FAI does not manage or remove that copy.

AGENTS.md and CLAUDE.md are FAI's instructions for the agents it starts here. FAI rewrites them, so edits do not last.

Uninstalling FAI Browser leaves this folder in place. Delete it yourself to remove your chats.
`;
}

/** FAI's files in the folder, name to content. */
export function localChatsFiles(platform = process.platform) {
  return { 'README.txt': readmeText(platform === 'win32' ? '\\' : '/'), 'AGENTS.md': GUIDANCE, 'CLAUDE.md': GUIDANCE };
}

// A regular file's text; null when nothing is there; '' for anything else (a symlink, a directory), so it is replaced.
async function currentText(path) {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  return info.isFile() ? readFile(path, 'utf8') : '';
}

/**
 * Create `dir` if it is missing and write FAI's three files where they are missing or differ. A file is replaced by a
 * rename, never written through, so a symlink planted in its place is replaced rather than followed. A directory in
 * a file's place makes it throw. Resolves
 * `{ dir, files: [{ name, action: 'create' | 'update' | 'unchanged' }] }`.
 */
export async function writeLocalChats(dir, { platform = process.platform } = {}) {
  await mkdir(dir, { recursive: true });
  const files = [];
  for (const [name, content] of Object.entries(localChatsFiles(platform))) {
    const path = join(dir, name);
    const current = await currentText(path);
    if (current === content) {
      files.push({ name, action: 'unchanged' });
      continue;
    }
    // A fresh name created exclusively: nothing planted there is written through, and the chat runner's turns (up to
    // three at once) never share one. The rename is retried while Windows has the file open (a provider reading it).
    const temporary = `${path}.fai-${randomBytes(8).toString('hex')}.tmp`;
    try {
      await writeFile(temporary, content, { flag: 'wx' });
      await renameRetrying(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
    files.push({ name, action: current === null ? 'create' : 'update' });
  }
  return { dir, files };
}
