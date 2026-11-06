// "FAI Browser" in the Linux applications menu: $XDG_DATA_HOME/applications/fai-browser.desktop (default
// ~/.local/share/applications), which runs `fai-browser launch` with the Node and checkout that created it. The
// icon is the add-on's own (extension/icons/icon-128.png), copied into the launcher's data directory so the entry
// keeps working if the checkout moves. It declares no MIME types or URL schemes, so it never becomes a default
// browser or a link handler. Removed by `fai-browser uninstall-launcher` (only a file carrying MARKER).
// macOS and Windows: no shortcut is written; docs/guide/install.md shows how to make one.
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { PACKAGE_ROOT } from '../paths.js';

export const DESKTOP_FILE = 'fai-browser.desktop';
export const MARKER = 'X-FAI-Browser-Launcher=true';
export const ICON_SOURCE = join(PACKAGE_ROOT, 'extension', 'icons', 'icon-128.png');
export const CLI_ENTRY = join(PACKAGE_ROOT, 'src', 'cli.js');

export function desktopEntryPath({ env = process.env, home }) {
  const data = env.XDG_DATA_HOME?.startsWith('/') ? resolve(env.XDG_DATA_HOME) : join(home, '.local', 'share');
  return join(data, 'applications', DESKTOP_FILE);
}

// Desktop Entry Specification quoting for Exec: arguments in double quotes, with ", `, $ and \ escaped; % doubled.
function quoteArg(value) {
  const text = String(value).replaceAll('%', '%%');
  return /^[\w/.:=+-]+$/.test(text) ? text : `"${text.replace(/(["`$\\])/g, '\\$1')}"`;
}

/** The .desktop file text. */
export function desktopEntry({ execPath = process.execPath, cli = CLI_ENTRY, icon }) {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    'Name=FAI Browser',
    'GenericName=Agent browser',
    'Comment=Firefox with a separate FAI profile for your coding agent',
    `Exec=${[execPath, cli, 'launch', '--from-desktop'].map(quoteArg).join(' ')}`,
    `Icon=${icon}`,
    'Terminal=false',
    'Categories=Network;',
    'Keywords=agent;browser;firefox;mcp;',
    'StartupNotify=true',
    MARKER,
    '',
  ].join('\n');
}

/** Writes the entry and its icon. Resolves `{ path, icon }`. */
export async function installDesktopEntry({ env = process.env, home, dataDir, execPath = process.execPath, cli = CLI_ENTRY }) {
  const icon = join(dataDir, 'fai-browser.png');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await copyFile(ICON_SOURCE, icon);
  const path = desktopEntryPath({ env, home });
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, desktopEntry({ execPath, cli, icon }), { mode: 0o644 });
  return { path, icon };
}

/** Removes the entry when it is ours. Resolves the removed path or null. */
export async function removeDesktopEntry({ env = process.env, home }) {
  const path = desktopEntryPath({ env, home });
  try {
    if (!(await readFile(path, 'utf8')).includes(MARKER)) return null;
  } catch {
    return null;
  }
  await rm(path, { force: true });
  return path;
}
