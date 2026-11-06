// Artifact retention: keeps the run directory under bounded count, size and age.
// Only directories directly inside `dir` that contain a trace.json are ever considered.
import { lstat, readdir, realpath, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const DAY_MS = 24 * 60 * 60 * 1000;

export const RETENTION_DEFAULTS = Object.freeze({
  maxRuns: 50,
  maxBytes: 500 * 1024 * 1024,
  maxAgeMs: 7 * DAY_MS,
});

const ENV_NAMES = {
  maxRuns: 'FAI_RETENTION_MAX_RUNS',
  maxBytes: 'FAI_RETENTION_MAX_BYTES',
  maxAgeMs: 'FAI_RETENTION_MAX_AGE_MS',
};

function limit(name, value, source) {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`Retention ${name} from ${source} must be a non-negative integer`);
  }
  return number;
}

/**
 * Resolves limits: defaults < options.json `retention` block < FAI_RETENTION_* environment.
 * Returns null when retention is disabled with `"retention": false`.
 */
export function retentionConfig(block, env = process.env) {
  if (block === false) {
    return null;
  }
  if (block !== undefined && (block === null || typeof block !== 'object' || Array.isArray(block))) {
    throw new Error('Options "retention" must be an object or false');
  }
  const config = { ...RETENTION_DEFAULTS };
  for (const name of Object.keys(RETENTION_DEFAULTS)) {
    if (block?.[name] !== undefined) {
      config[name] = limit(name, block[name], 'options.json');
    }
    if (env[ENV_NAMES[name]] !== undefined && env[ENV_NAMES[name]] !== '') {
      config[name] = limit(name, env[ENV_NAMES[name]], ENV_NAMES[name]);
    }
  }
  const unknown = Object.keys(block || {}).filter(key => !(key in RETENTION_DEFAULTS));
  if (unknown.length) {
    throw new Error(`Unknown retention option: ${unknown.join(', ')}`);
  }
  return config;
}

async function sizeOf(path) {
  const info = await lstat(path);
  if (!info.isDirectory()) {
    return info.size;
  }
  let total = 0;
  for (const name of await readdir(path)) {
    total += await sizeOf(join(path, name));
  }
  return total;
}

async function isRunDirectory(path) {
  try {
    const info = await lstat(join(path, 'trace.json'));
    return info.isFile();
  } catch {
    return false;
  }
}

async function listRuns(root) {
  const runs = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    // Symlinks are never followed or deleted; only real directories qualify.
    if (!entry.isDirectory()) {
      continue;
    }
    const path = join(root, entry.name);
    if (!(await isRunDirectory(path))) {
      continue;
    }
    const info = await lstat(path);
    runs.push({ runId: entry.name, path, mtimeMs: info.mtimeMs, bytes: await sizeOf(path) });
  }
  return runs.sort((a, b) => a.mtimeMs - b.mtimeMs || a.runId.localeCompare(b.runId));
}

/**
 * Deletes the oldest run directories in `dir` until count, size and age limits hold.
 * Never deletes ids in `keep`, never touches anything outside `dir` (checked by realpath).
 * Returns {pruned:[{runId, bytes, reason}], remaining:{runs, bytes}}.
 */
export async function prune(dir, {
  maxRuns = RETENTION_DEFAULTS.maxRuns,
  maxBytes = RETENTION_DEFAULTS.maxBytes,
  maxAgeMs = RETENTION_DEFAULTS.maxAgeMs,
  keep = [],
  now = Date.now(),
} = {}) {
  let root;
  try {
    root = await realpath(dir);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { pruned: [], remaining: { runs: 0, bytes: 0 } };
    }
    throw error;
  }
  const kept = new Set(keep);
  const runs = await listRuns(root);
  let count = runs.length;
  let bytes = runs.reduce((sum, run) => sum + run.bytes, 0);
  const pruned = [];

  for (const run of runs) {
    if (kept.has(run.runId)) {
      continue;
    }
    const reasons = [];
    if (count > maxRuns) {
      reasons.push('count');
    }
    if (bytes > maxBytes) {
      reasons.push('size');
    }
    if (now - run.mtimeMs > maxAgeMs) {
      reasons.push('age');
    }
    if (!reasons.length) {
      // Runs are sorted oldest first, so no younger run can violate the age limit either.
      break;
    }
    const real = await realpath(run.path);
    if (dirname(real) !== root || real === root) {
      continue;
    }
    await rm(real, { recursive: true, force: true });
    count--;
    bytes -= run.bytes;
    pruned.push({ runId: run.runId, bytes: run.bytes, reason: reasons.join('+') });
  }
  return { pruned, remaining: { runs: count, bytes } };
}
