// Finds an official Firefox the launcher can start with the FAI profile. Nothing here starts a process: the version
// comes from the installation's application.ini, so detection never touches a running Firefox.
//
// Where it looks, in order (the first usable one wins):
//   --firefox <path> (or FIREFOX_PATH), then the Firefox a previous launch used (launcher.json), then the private
//   copy the launcher downloaded (<launcher data>/firefox), then the system:
//   Linux:   firefox and firefox-esr on PATH, /usr/lib{,64}/firefox{,-esr}, /opt/firefox{,-esr}
//   macOS:   /Applications and ~/Applications: Firefox.app, Firefox ESR.app, Firefox Developer Edition.app,
//            Firefox Nightly.app
//   Windows: %ProgramFiles%, %ProgramFiles(x86)% and %LOCALAPPDATA% \Mozilla Firefox\firefox.exe
// Snap (/snap/bin/firefox, or a /usr/bin/firefox script that runs it) and Flatpak (org.mozilla.firefox) builds are
// reported as sandboxed and not used: they start native messaging hosts only through the WebExtensions portal, which
// many desktops lack, so the add-on could not pair. The launcher offers the official tarball instead.
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';

/** The oldest Firefox the add-on supports (scripts/build-firefox.mjs FIREFOX_MIN_VERSION). */
export const MIN_FIREFOX_MAJOR = 140;

/** Real filesystem access; tests pass their own. */
export const realFs = {
  isFile(path) {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  },
  exists: path => existsSync(path),
  realpath(path) {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  },
  readText(path, max = 64 * 1024) {
    try {
      const text = readFileSync(path);
      return text.subarray(0, max).toString('utf8');
    } catch {
      return null;
    }
  },
};

/** The private copy's executable inside `dir` (<launcher data>/firefox). */
export function privateBinary(dir, platform = process.platform) {
  if (platform === 'darwin') return join(dir, 'Firefox.app', 'Contents', 'MacOS', 'firefox');
  if (platform === 'win32') return join(dir, 'firefox.exe');
  return join(dir, 'firefox');
}

/** The system places to look, in order: [{ path, source }]. */
export function systemCandidates({ platform = process.platform, env = process.env, home } = {}) {
  const list = [];
  if (platform === 'darwin') {
    for (const root of ['/Applications', join(home, 'Applications')]) {
      for (const app of ['Firefox.app', 'Firefox ESR.app', 'Firefox Developer Edition.app', 'Firefox Nightly.app']) {
        list.push({ path: join(root, app, 'Contents', 'MacOS', 'firefox'), source: 'applications' });
      }
    }
    return list;
  }
  if (platform === 'win32') {
    const roots = [env.ProgramFiles || 'C:\\Program Files', env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
      env.LOCALAPPDATA || join(home, 'AppData', 'Local')];
    for (const root of roots) list.push({ path: join(root, 'Mozilla Firefox', 'firefox.exe'), source: 'program-files' });
    return list;
  }
  for (const dir of String(env.PATH ?? '').split(delimiter).filter(dir => isAbsolute(dir))) {
    for (const name of ['firefox', 'firefox-esr']) list.push({ path: join(dir, name), source: 'path' });
  }
  for (const path of ['/usr/lib/firefox/firefox', '/usr/lib64/firefox/firefox', '/usr/lib/firefox-esr/firefox-esr',
    '/opt/firefox/firefox', '/opt/firefox-esr/firefox']) list.push({ path, source: 'system' });
  // Sandboxed builds, listed so the launcher can say why it does not use them.
  list.push({ path: '/snap/bin/firefox', source: 'snap' },
    { path: '/var/lib/flatpak/exports/bin/org.mozilla.firefox', source: 'flatpak' },
    { path: join(home, '.local', 'share', 'flatpak', 'exports', 'bin', 'org.mozilla.firefox'), source: 'flatpak' });
  return list;
}

/** Major and full version from an installation's application.ini, or null. */
export function readVersion(binary, { platform = process.platform, fs = realFs } = {}) {
  const dir = dirname(binary);
  const ini = platform === 'darwin' ? join(dir, '..', 'Resources', 'application.ini') : join(dir, 'application.ini');
  const text = fs.readText(ini);
  const match = text && /^Version=(\d+)(\.[\w.]*)?\s*$/m.exec(text);
  if (!match) return null;
  return { major: Number(match[1]), version: `${match[1]}${match[2] ?? ''}`, name: /^Name=(.*)$/m.exec(text)?.[1]?.trim() ?? null };
}

/**
 * What one candidate path is: `{ path, binary, kind, version?, reason? }`. kind: 'firefox' (usable), 'snap',
 * 'flatpak' (sandboxed) or 'unknown' (a script or binary whose version could not be read: usable, version unknown).
 */
export function inspectCandidate(path, { platform = process.platform, fs = realFs, source } = {}) {
  const real = fs.realpath(path);
  if (source === 'snap' || real.startsWith('/snap/') || path.startsWith('/snap/')) {
    return { path, binary: real, kind: 'snap', reason: 'Snap Firefox' };
  }
  if (source === 'flatpak' || /\/flatpak\/(exports|app)\//.test(real) || /org\.mozilla\.firefox$/.test(real)) {
    return { path, binary: real, kind: 'flatpak', reason: 'Flatpak Firefox' };
  }
  let binary = real;
  if (platform !== 'win32') {
    const head = fs.readText(real, 4096);
    if (head?.startsWith('#!')) {
      // A wrapper script: Ubuntu's transitional package runs the snap, distributions exec the real binary.
      if (/\/snap\/bin\/firefox|\bsnap\s+run\b|requires the firefox snap/.test(head)) {
        return { path, binary: real, kind: 'snap', reason: 'a wrapper that runs Snap Firefox' };
      }
      if (/\bflatpak\s+run\b/.test(head)) return { path, binary: real, kind: 'flatpak', reason: 'a wrapper that runs Flatpak Firefox' };
      const target = /\bexec\s+(?:"([^"]+)"|'([^']+)'|(\/\S+))/.exec(head);
      const exec = target && (target[1] ?? target[2] ?? target[3]);
      if (exec && isAbsolute(exec) && exec !== real && fs.isFile(exec)) binary = fs.realpath(exec);
    }
  }
  const version = readVersion(binary, { platform, fs });
  return { path, binary, kind: version ? 'firefox' : 'unknown', ...(version ? { version } : {}) };
}

/**
 * Every Firefox found, in preference order, and the one to use: `{ chosen, usable, sandboxed, tooOld }`. `explicit`
 * is --firefox (or FIREFOX_PATH); `saved` the binary a previous launch used; `privateDir` the launcher's copy.
 */
export function findFirefox({ platform = process.platform, env = process.env, home, explicit, saved, privateDir,
  fs = realFs } = {}) {
  const candidates = [];
  const named = explicit ?? env.FIREFOX_PATH;
  if (named) candidates.push({ path: named, source: 'explicit' });
  if (saved) candidates.push({ path: saved, source: 'saved' });
  if (privateDir) candidates.push({ path: privateBinary(privateDir, platform), source: 'private' });
  candidates.push(...systemCandidates({ platform, env, home }));
  const seen = new Set();
  const usable = [];
  const sandboxed = [];
  const tooOld = [];
  for (const candidate of candidates) {
    if (!fs.isFile(candidate.path)) {
      if (candidate.source === 'explicit') throw Object.assign(new Error(`No Firefox at ${candidate.path}`), { code: 'no_firefox' });
      continue;
    }
    const found = { ...inspectCandidate(candidate.path, { platform, fs, source: candidate.source }), source: candidate.source };
    if (seen.has(found.binary)) continue;
    seen.add(found.binary);
    if (found.kind === 'snap' || found.kind === 'flatpak') sandboxed.push(found);
    else if (found.version && found.version.major < MIN_FIREFOX_MAJOR) tooOld.push(found);
    else usable.push(found);
  }
  return { chosen: usable[0] ?? null, usable, sandboxed, tooOld };
}
