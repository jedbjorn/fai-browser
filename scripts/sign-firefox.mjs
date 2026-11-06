#!/usr/bin/env node
// Signs the Firefox add-on on addons.mozilla.org as an unlisted (self-distributed) add-on and puts the signed .xpi in
// dist/fai-browser-firefox-<version>.xpi. Release Firefox installs only Mozilla-signed add-ons; an unlisted signature
// is automatic (no listing, no public page) and lets the FAI Firefox launcher and any user install the file.
//   WEB_EXT_API_KEY=... WEB_EXT_API_SECRET=... npm run sign:firefox
//   npm run sign:firefox -- --dry-run      print what would run, sign nothing
//
// The credentials (AMO, Developer Hub, Manage API Keys: the "JWT issuer" is WEB_EXT_API_KEY, the "JWT secret" is
// WEB_EXT_API_SECRET; docs/PUBLISHING.md) come from the environment, else from amo.env in the FAI
// settings directory (src/paths.js: FAI_HOME, else $XDG_CONFIG_HOME/fai-browser or ~/.config/fai-browser, macOS
// ~/Library/Application Support/fai-browser): two lines WEB_EXT_API_KEY=... and WEB_EXT_API_SECRET=..., mode 0600. A
// file group or others can read is refused. The values are never printed, logged or put on a command line: they go
// to web-ext only through its environment (web-ext reads the same two variables). In GitHub Actions they are
// repository secrets of the same names (.github/workflows/release.yml).
// AMO signs each version once: bump package.json and extension/manifest.json before signing again.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';
import { faiHome } from '../src/paths.js';
import { createInterface } from 'node:readline/promises';
import { buildFirefox, GECKO_ID } from './build-firefox.mjs';
import { releaseVersion, ROOT } from './package.mjs';
import { inspectXpi } from '../src/launcher/addon.js';

export const WEB_EXT = 'web-ext@8';
export const CREDENTIAL_NAMES = ['WEB_EXT_API_KEY', 'WEB_EXT_API_SECRET'];
export const KEY_HELP = `Missing AMO API credentials. Sign in at https://addons.mozilla.org/developers/addon/api/key/ with
the Firefox account that owns FAI Browser and generate them; then either export WEB_EXT_API_KEY (the JWT issuer) and
WEB_EXT_API_SECRET (the JWT secret) in this shell, or put those two lines in amo.env in the FAI settings directory
with mode 0600 (chmod 600). Never commit them.`;

/** The credentials file: amo.env in the FAI settings directory. */
export function amoEnvPath(env = process.env, platform = process.platform) {
  return join(faiHome(env, platform), 'amo.env');
}

/**
 * The environment for web-ext: `env` itself when it has both credentials, else `env` plus the two values from
 * amo.env (only those two names are taken). `source` says where they came from ('env', 'file' or null when missing);
 * the values are never returned anywhere else. Throws when amo.env is readable by group or others.
 */
export async function credentialEnv(env = process.env, { platform = process.platform, path = amoEnvPath(env, platform) } = {}) {
  if (hasCredentials(env)) return { env, source: 'env', path };
  let info;
  try {
    info = await stat(path);
  } catch {
    return { env, source: null, path };
  }
  if (platform !== 'win32' && (info.mode & 0o077)) {
    throw Object.assign(new Error(`${path} is readable by other users (mode ${(info.mode & 0o777).toString(8)}); run chmod 600 on it`),
      { code: 'unsafe_credentials_file' });
  }
  if (platform !== 'win32' && typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    throw Object.assign(new Error(`${path} belongs to another user; refusing to read it`), { code: 'unsafe_credentials_file' });
  }
  const values = parseEnv(await readFile(path, 'utf8'));
  const merged = { ...env };
  for (const name of CREDENTIAL_NAMES) if (!merged[name]?.trim() && values[name]?.trim()) merged[name] = values[name].trim();
  return { env: merged, source: hasCredentials(merged) ? 'file' : null, path };
}

/** The web-ext command line (no credentials: web-ext reads WEB_EXT_API_KEY and WEB_EXT_API_SECRET itself). */
export function signCommand({ sourceDir, artifactsDir }) {
  return ['npx', '--yes', WEB_EXT, 'sign', '--channel', 'unlisted', '--source-dir', sourceDir,
    '--artifacts-dir', artifactsDir, '--no-input'];
}

/** True when both credentials are in `env`. */
export function hasCredentials(env = process.env) {
  return Boolean(env.WEB_EXT_API_KEY?.trim() && env.WEB_EXT_API_SECRET?.trim());
}

async function newestXpi(dir, since) {
  const names = (await readdir(dir).catch(() => [])).filter(name => name.endsWith('.xpi'));
  let best = null;
  for (const name of names) {
    const info = await stat(join(dir, name));
    if (info.mtimeMs >= since && (!best || info.mtimeMs > best.mtimeMs)) best = { path: join(dir, name), mtimeMs: info.mtimeMs };
  }
  return best?.path ?? null;
}

export async function signFirefox({ root = ROOT, env = process.env, dryRun = false, run = runCommand } = {}) {
  const version = await releaseVersion(root);
  const dist = join(root, 'dist');
  const sourceDir = join(dist, 'firefox-release');
  const artifactsDir = join(dist, 'web-ext-artifacts');
  const target = join(dist, `fai-browser-firefox-${version}.xpi`);
  const command = signCommand({ sourceDir, artifactsDir });
  const credentials = await credentialEnv(env);
  if (dryRun) return { version, command, target, credentials: credentials.source, credentialsFile: credentials.path };
  if (!credentials.source) throw Object.assign(new Error(KEY_HELP), { code: 'no_credentials' });
  env = credentials.env;
  await rm(sourceDir, { recursive: true, force: true });
  await buildFirefox({ root, out: sourceDir });
  await mkdir(artifactsDir, { recursive: true });
  const started = Date.now() - 1000;
  await run(command, { env });
  const signed = await newestXpi(artifactsDir, started);
  if (!signed) throw new Error(`web-ext finished without a signed .xpi in ${artifactsDir}`);
  const data = await readFile(signed);
  const info = inspectXpi(data);
  if (!info.signed || info.id !== GECKO_ID || info.version !== version) {
    throw new Error(`${signed} is not the signed FAI Browser ${version} (id ${info.id}, version ${info.version}, signed ${info.signed})`);
  }
  await copyFile(signed, target);
  const sha256 = createHash('sha256').update(data).digest('hex');
  return { version, path: target, sha256 };
}

function runCommand([program, ...args], { env }) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(program, args, { env, stdio: 'inherit', shell: process.platform === 'win32' });
    child.on('error', reject);
    child.on('exit', code => (code === 0 ? resolveRun() : reject(new Error(`web-ext sign exited with ${code}`))));
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { values } = parseArgs({ options: { 'dry-run': { type: 'boolean' }, yes: { type: 'boolean', short: 'y' } } });
  try {
    // The first signature binds the add-on ID to the AMO account for good: confirm it at a terminal.
    if (!values['dry-run'] && !values.yes && process.stdin.isTTY) {
      const prompt = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await prompt.question(`Sign FAI Browser on AMO as ${GECKO_ID} (unlisted)? This ID is permanent. [y/N]: `);
      prompt.close();
      if (!/^y(es)?$/i.test(answer.trim())) throw new Error('Not signed.');
    }
    const result = await signFirefox({ dryRun: values['dry-run'] });
    if (values['dry-run']) {
      console.log(`Would run: ${result.command.join(' ')}`);
      const from = { env: 'from the environment', file: `from ${result.credentialsFile}` }[result.credentials]
        ?? `missing (environment or ${result.credentialsFile})`;
      console.log(`Signed add-on would go to ${result.target}; AMO credentials ${from}.`);
    } else {
      console.log(`Signed: ${resolve(result.path)}\n  sha256 ${result.sha256}`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
