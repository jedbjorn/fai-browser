// Local settings in FAI_HOME/.env.local (mode 0600): the pairing secret and the extension ID.
//
// The daemon is the only long-lived reader. It loads the file with util.parseEnv, generates a missing pairing secret,
// and re-reads the file when its mtime changes. Other names in the file (a key line left by an older release) are
// ignored and kept as written.
import { readFileSync, statSync } from 'node:fs';
import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { parseEnv } from 'node:util';
import { dirname, resolve } from 'node:path';
import { envFilePath, faiHome } from './paths.js';
import { PINNED_EXTENSION_ID } from './bridge.js';

const ALLOWED_NAMES = new Set(['FAI_EXTENSION_ID', 'FAI_BRIDGE_SECRET']);
const EXTENSION_ID = /^[a-p]{32}$/;
const MIN_SECRET_LENGTH = 24;

function validateSetting(name, value) {
  if (!ALLOWED_NAMES.has(name)) throw new Error('Unsupported setting');
  if (typeof value !== 'string' || !value || /[\s"'\\\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`${name} must be nonempty and contain no whitespace, quotes or backslashes`);
  }
  if (name === 'FAI_EXTENSION_ID' && !EXTENSION_ID.test(value)) throw new Error('Invalid Chrome extension ID');
  if (name === 'FAI_BRIDGE_SECRET' && value.length < MIN_SECRET_LENGTH) {
    throw new Error('Pairing secret must be at least 24 characters');
  }
}

/**
 * Atomically merge settings into .env.local with mode 0600. Existing lines for other names (and comments) are
 * kept; lines for the given names are replaced.
 */
export async function saveSettings(values, envPath = envFilePath()) {
  for (const [name, value] of Object.entries(values)) validateSetting(name, value);
  let existing = '';
  try {
    existing = await readFile(envPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const names = Object.keys(values);
  const lines = existing
    .split(/\r?\n/)
    .filter(line => !names.some(name => new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`).test(line)));
  while (lines.length && !lines.at(-1)) lines.pop();
  const content = [...lines, ...Object.entries(values).map(([name, value]) => `${name}="${value}"`), ''].join('\n');
  // The settings directory may not exist yet on a first run (src/paths.js defaults).
  await mkdir(dirname(envPath), { recursive: true, mode: 0o700 });
  const temporary = `${envPath}.${randomBytes(12).toString('hex')}.tmp`;
  let file;
  try {
    file = await open(temporary, 'wx', 0o600);
    await file.writeFile(content, 'utf8');
    await file.sync();
    await file.close();
    file = null;
    await chmod(temporary, 0o600);
    await rename(temporary, envPath);
  } finally {
    if (file) await file.close();
    await unlink(temporary).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

/** Parse .env.local; {} when it does not exist. */
export function readEnvFile(envPath) {
  try {
    return parseEnv(readFileSync(envPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error(`Could not read ${envPath}: ${error.code ?? error.message}`);
  }
}

/** mtime of .env.local in ms, or 0 when it does not exist. */
export function envFileMtime(envPath) {
  try {
    return statSync(envPath).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Load the daemon's settings. FAI_BRIDGE_SECRET in `env` overrides the file's secret. With `generateSecret`, a missing
 * pairing secret is generated and saved.
 * Returns {secret, extensionId, mtimeMs, generatedSecret}.
 */
export async function loadDaemonSettings(envPath, { env = process.env, generateSecret = true } = {}) {
  const values = readEnvFile(envPath);
  // FAI_BRIDGE_SECRET in the daemon's environment (benchmarks, tests) overrides the file and is never saved.
  const override = env.FAI_BRIDGE_SECRET || '';
  if (override && override.length < MIN_SECRET_LENGTH) {
    throw new Error('FAI_BRIDGE_SECRET must be at least 24 characters');
  }
  let secret = override || values.FAI_BRIDGE_SECRET || '';
  let generatedSecret = false;
  if (!secret && generateSecret) {
    secret = randomBytes(32).toString('hex');
    await saveSettings({ FAI_BRIDGE_SECRET: secret }, envPath);
    generatedSecret = true;
  }
  const extensionId = values.FAI_EXTENSION_ID || env.FAI_EXTENSION_ID || PINNED_EXTENSION_ID;
  return {
    secret,
    extensionId,
    mtimeMs: envFileMtime(envPath),
    generatedSecret,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Oversight settings from FAI_HOME/config.json: the per-request call budget the MCP server enforces and the gate
// thresholds the daemon passes to every run. Read synchronously and tolerantly: an unreadable or invalid file
// yields the defaults here (the daemon reports config.json errors itself).
// ---------------------------------------------------------------------------------------------------------------

// A host-driven task (many observe/act steps) needs far more than the first defaults
// (6 calls, 2 minutes): 50 calls and 20 minutes per tab request. The popup's Setup & connection section lets the user
// change both (BUDGET_LIMITS bounds every source: popup, config.json and the host's per-call maxCalls/maxMs).
export const DEFAULT_BUDGET = Object.freeze({ maxCalls: 50, maxMs: 1_200_000 });
export const BUDGET_LIMITS = Object.freeze({
  maxCalls: Object.freeze({ min: 1, max: 10_000 }),
  maxMs: Object.freeze({ min: 1000, max: 14_400_000 }), // 4 hours
});

/** Validate a `budget` object ({maxCalls 1-10000, maxMs 1000-14400000}); returns a clean copy or throws. */
export function checkBudget(budget) {
  if (budget === undefined || budget === null) return {};
  if (typeof budget !== 'object' || Array.isArray(budget)) throw new Error('budget must be an object');
  const out = {};
  for (const [key, value] of Object.entries(budget)) {
    if (key === 'maxCalls' || key === 'maxMs') {
      const { min, max } = BUDGET_LIMITS[key];
      if (!Number.isInteger(value) || value < min || value > max) throw new Error(`budget.${key} must be ${min} to ${max}`);
    } else {
      throw new Error(`Unknown budget key "${key}"`);
    }
    out[key] = value;
  }
  return out;
}

/** `{ budget: {maxCalls, maxMs}, thresholds }` from FAI_HOME/config.json, defaults when absent or invalid. */
export function loadOversightConfig(env = process.env) {
  let config = {};
  try {
    config = JSON.parse(readFileSync(resolve(faiHome(env), 'config.json'), 'utf8')) ?? {};
  } catch {
    config = {};
  }
  let budget = {};
  try {
    budget = checkBudget(config.budget);
  } catch {
    budget = {};
  }
  const thresholds = config.thresholds && typeof config.thresholds === 'object' && !Array.isArray(config.thresholds)
    ? { ...config.thresholds }
    : undefined;
  return { budget: { ...DEFAULT_BUDGET, ...budget }, thresholds };
}
