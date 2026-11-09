// Git and child-process environment for the updater (src/update.js, src/update-install.js).
//
// Every child the updater starts gets an environment without FAI's secrets: scrubbedEnv() for the updater process,
// its `update --finish` and the restarted daemon (they need FAI_HOME and the user's directories), toolEnv() for git
// and npm (an allowlist: PATH, home and locale, ssh agent, credential-helper session, proxies and CA files). Neither
// carries TYPESAFE_API_KEY, FAI_BRIDGE_SECRET, FAI_CLIENT_TOKEN or anything named like a key, token, secret or
// password, so a key removed from .env.local stays removed after an update.
//
// git never prompts: GIT_TERMINAL_PROMPT=0, no askpass, and ssh in batch mode unless the user configured ssh for git
// (GIT_SSH_COMMAND, GIT_SSH or core.sshCommand), which is then left as it is. Every call is execFile with argv.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
export const GIT_TIMEOUT_MS = 120_000;
export const LS_REMOTE_TIMEOUT_MS = 30_000;
export const UPDATE_REPO_PATH = 'jedbjorn/fai-browser';
const TAG = /^v((?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5}))$/;
const SHA = /^[0-9a-f]{40}$/;

const SECRET_NAMES = new Set(['TYPESAFE_API_KEY', 'FAI_BRIDGE_SECRET', 'FAI_CLIENT_TOKEN']);
// Anything ending in KEY (OPENAI_KEY, JEV_KEY, AWS_SECRET_KEY, SSH_PRIVATE_KEY, an APIKEY), TOKEN, SECRET, a password
// or credentials.
const SECRET_LIKE = /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIALS?)$/i;
// Git's own location variables would point git at another repository.
const GIT_LOCATION = /^GIT_(?:DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|CEILING_DIRECTORIES|PREFIX)$/;
const TOOL_NAMES = new Set(['PATH', 'Path', 'PATHEXT', 'HOME', 'USERPROFILE', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP',
  'SystemRoot', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS',
  'SSH_AUTH_SOCK', 'SSH_AGENT_PID', 'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_SSH_VARIANT', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM',
  'GIT_CONFIG_SYSTEM', 'GIT_SSL_CAINFO', 'GIT_SSL_CAPATH', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy', 'GH_CONFIG_DIR']);
// Git Credential Manager's settings (GCM_CREDENTIAL_STORE, GCM_INTERACTIVE, ...); a secret-like name is still dropped.
const TOOL_PREFIXES = ['GCM_'];

function secretName(name) {
  return SECRET_NAMES.has(name) || SECRET_LIKE.test(name);
}

/** The environment without FAI's secrets (and git location overrides), for the updater and the processes it starts. */
export function scrubbedEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([name, value]) => typeof value === 'string'
    && !secretName(name) && !GIT_LOCATION.test(name)));
}

/** The minimal environment git and npm need (allowlist), without prompts; no secret can be in it. */
export function toolEnv(env = process.env) {
  const out = Object.fromEntries(Object.entries(env).filter(([name, value]) => typeof value === 'string'
    && (TOOL_NAMES.has(name) || TOOL_PREFIXES.some(prefix => name.startsWith(prefix))) && !secretName(name)));
  return { ...out, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '', LC_ALL: 'C', LANG: 'C' };
}

/** True for an https, ssh or scp-style URL of github.com/<repo> (case-insensitive, optional .git and slash). */
export function remoteMatches(url, repo = UPDATE_REPO_PATH) {
  if (typeof url !== 'string') return false;
  const escaped = repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const forms = [
    `https://(?:[^@/]+@)?github\\.com/${escaped}`,
    `ssh://git@github\\.com(?::22)?/${escaped}`,
    `git@github\\.com:${escaped}`,
  ];
  return new RegExp(`^(?:${forms.join('|')})(?:\\.git)?/?$`, 'i').test(url.trim());
}

/**
 * A git runner for `cwd`: `git(args)` resolves trimmed stdout, rejects with the git error. Runs with toolEnv(env);
 * ssh batch mode is added on the first call only when the user configured no ssh command for git. `git.env()`
 * resolves the environment it uses (tests).
 */
export function gitRunner({ cwd, env = process.env, timeoutMs = GIT_TIMEOUT_MS } = {}) {
  const base = toolEnv(env);
  let ready = null;
  const resolveEnv = () => {
    ready ??= (async () => {
      if (base.GIT_SSH_COMMAND || base.GIT_SSH) return base;
      let configured = '';
      try {
        ({ stdout: configured } = await execFileAsync('git', ['config', '--get', 'core.sshCommand'],
          { cwd, env: base, timeout: 10_000, windowsHide: true }));
      } catch {
        // Not set (git exits 1).
      }
      return configured.trim() ? base : { ...base, GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' };
    })();
    return ready;
  };
  const git = async (args, options = {}) => {
    const stdout = await runGrouped('git', args, { cwd, env: await resolveEnv(), timeoutMs: options.timeoutMs ?? timeoutMs });
    return stdout.trim();
  };
  git.env = resolveEnv;
  return git;
}

const MAX_OUTPUT = 4 * 1024 * 1024;

/**
 * Run `file args` in a process group of its own (POSIX) and resolve its stdout; on the timeout the whole group is
 * killed, so the ssh or credential helper git started is not left behind. Rejects with `stderr`, `code` (the exit
 * code or 'timeout'). Windows: execFile with its timeout.
 */
export function runGrouped(file, args, { cwd, env, timeoutMs = GIT_TIMEOUT_MS } = {}) {
  if (process.platform === 'win32') {
    return execFileAsync(file, args, { cwd, env, timeout: timeoutMs, maxBuffer: MAX_OUTPUT, windowsHide: true })
      .then(({ stdout }) => stdout);
  }
  return new Promise((resolveRun, rejectRun) => {
    let child;
    try {
      child = spawn(file, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      rejectRun(error);
      return;
    }
    const out = [];
    const err = [];
    let size = 0;
    let timedOut = false;
    const killGroup = () => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);
    const collect = list => chunk => {
      size += chunk.length;
      if (size > MAX_OUTPUT) killGroup();
      else list.push(chunk);
    };
    child.stdout.on('data', collect(out));
    child.stderr.on('data', collect(err));
    child.on('error', error => {
      clearTimeout(timer);
      rejectRun(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out).toString('utf8');
      const stderr = Buffer.concat(err).toString('utf8');
      if (code === 0 && !timedOut) return resolveRun(stdout);
      const reason = timedOut ? `timed out after ${timeoutMs} ms` : `exited with ${code ?? signal}`;
      rejectRun(Object.assign(new Error(`${file} ${args[0] ?? ''} ${reason}`), { code: timedOut ? 'timeout' : code, stderr, stdout }));
    });
  });
}

async function gitOrNull(git, args) {
  try {
    return await git(args);
  } catch {
    return null;
  }
}

/** The name of the clone's remote that is github.com/<repo> (the branch's remote, then origin, then any), or null. */
export async function findVerifiedRemote({ git, branch = null, remoteOk = url => remoteMatches(url) }) {
  const remotes = (await gitOrNull(git, ['remote']))?.split('\n').filter(Boolean) ?? [];
  const tracked = branch ? await gitOrNull(git, ['config', '--get', `branch.${branch}.remote`]) : null;
  for (const name of [...new Set([tracked, 'origin', ...remotes].filter(item => item && remotes.includes(item)))]) {
    if (remoteOk(await gitOrNull(git, ['remote', 'get-url', name]))) return name;
  }
  return null;
}

/**
 * The highest plain vX.Y.Z tag on `remote` by `git ls-remote --tags` (the user's own git credentials; FAI stores and
 * reads no token): `{ tag, version, commit }` with the peeled commit of an annotated tag, or null.
 */
export async function lsRemoteLatest({ git, remote }) {
  const out = await git(['ls-remote', '--tags', remote], { timeoutMs: LS_REMOTE_TIMEOUT_MS });
  const tags = new Map();
  for (const line of out.split('\n')) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (!SHA.test(sha ?? '') || !ref?.startsWith('refs/tags/')) continue;
    const name = ref.slice('refs/tags/'.length);
    const peeled = name.endsWith('^{}');
    const tag = peeled ? name.slice(0, -3) : name;
    const match = TAG.exec(tag);
    if (!match) continue;
    const entry = tags.get(tag) ?? { tag, version: match[1], commit: null };
    // The peeled line (an annotated tag's commit) wins over the tag object's own SHA, in either order.
    if (peeled) {
      entry.commit = sha;
      entry.peeled = true;
    } else if (!entry.peeled) {
      entry.commit = sha;
    }
    tags.set(tag, entry);
  }
  let best = null;
  for (const entry of tags.values()) {
    const [a, b] = [entry.version, best?.version].map(text => text?.split('.').map(Number));
    if (!best || a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] > b[2])))) best = entry;
  }
  return best ? { tag: best.tag, version: best.version, commit: best.commit } : null;
}

/**
 * The check's fallback for a repository the anonymous API cannot see (404): ls-remote on the verified remote of the
 * clone at `root`. Resolves a release, null (no tag), or throws (not a clone, no verified remote, git failed).
 */
export function gitReleaseSource({ root, env = process.env, remoteOk } = {}) {
  return async () => {
    const git = gitRunner({ cwd: root, env, timeoutMs: LS_REMOTE_TIMEOUT_MS });
    const remote = await findVerifiedRemote({ git, branch: await gitOrNull(git, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
      ...(remoteOk ? { remoteOk } : {}) });
    if (!remote) throw Object.assign(new Error('no verified remote'), { code: 'git_remote' });
    return lsRemoteLatest({ git, remote });
  };
}
