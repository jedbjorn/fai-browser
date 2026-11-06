// Shared helpers for bench/jev-eval.mjs and scripts/jev-order-check.mjs.
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { legalActions, providerPayload } from '../../src/runtime.js';
import { consentOf, consentRejectActions } from '../../src/oversight.js';
import { normalizeAdditions } from '../../src/guardrails.js';

export const ROOT = resolve(import.meta.dirname, '..', '..');
export const CASES_FILE = join(ROOT, 'test', 'fixtures', 'jev', 'cases.json');

export async function loadCases(file = CASES_FILE) {
  return JSON.parse(await readFile(file, 'utf8')).cases;
}

/**
 * The offered actions for a case, as the runtime builds them: a consent dialog with two or more reject buttons is
 * offered alone (plus done/handoff); otherwise the ordinary legal actions (consentBypass forces this).
 */
export function offeredFor(entry) {
  const observation = entry.observation;
  const consent = consentOf(observation);
  if (consent && !entry.consentBypass) {
    const rejects = consentRejectActions(consent);
    if (rejects.length >= 2) {
      const terminal = legalActions({ url: observation.url, controls: [] }).filter(a => a.type === 'done' || a.type === 'handoff');
      return [...rejects.map((action, index) => ({ id: `c${index}`, ...action })), ...terminal];
    }
  }
  const options = { mode: entry.mode, suppliedText: entry.suppliedText ?? {}, allowedUrls: entry.allowedUrls ?? [] };
  if (entry.guardrails) options.policy = entry.guardrails;
  return legalActions(observation, options);
}

/** The payload a provider receives for a case (the runtime's single provider boundary). */
export function payloadFor(entry, offered = offeredFor(entry)) {
  const observation = { revision: 'r', ...entry.observation };
  const payload = providerPayload(observation, offered, entry.history ?? [], entry.suppliedText ?? {});
  // The mode goes to the provider as the runtime sends it: it renders the policy's mode line and, in reversible
  // mode, asks the commit guard (guardrail pass).
  const context = { instruction: entry.instruction, history: payload.history, mode: entry.mode ?? 'read-only' };
  // Guardrail additions (a case's `guardrails`), normalized as the runtime does before they reach state.policy.
  if (entry.guardrails) {
    const { forbid, note } = normalizeAdditions(entry.guardrails);
    if (forbid.length || note) context.guardrails = { forbid, note };
  }
  return { observation: payload.observation, actions: payload.actions, context };
}

const norm = text => String(text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

/** Ids of the offered actions that count as correct for the case. */
export function goldIds(entry, offered) {
  const gold = new Set(entry.gold.map(norm));
  return new Set(offered.filter(action => gold.has(norm(action.type)) || gold.has(norm(action.label))
    || (action.optionLabel !== undefined && gold.has(norm(action.optionLabel)))).map(action => action.id));
}

export const expectsHandoff = entry => entry.gold.length === 1 && entry.gold[0] === 'handoff';

export function percentile(values, p) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

/**
 * Load the Jev key the way the daemon does (src/settings.js loadDaemonSettings reads FAI_HOME/.env.local into this
 * process's environment). The key is never printed, logged or written anywhere by these scripts.
 */
export async function loadDaemonKey() {
  const { loadDaemonSettings } = await import('../../src/settings.js');
  const { envFilePath } = await import('../../src/paths.js');
  const settings = await loadDaemonSettings(envFilePath(), { generateSecret: false });
  if (!settings.keyConfigured) throw new Error('No Jev key configured; run npm run setup');
}

/** loadDaemonKey for the CLI scripts: a missing key prints one line to stderr and exits 1, no stack trace. */
export async function requireDaemonKey(script) {
  try {
    await loadDaemonKey();
  } catch (error) {
    process.stderr.write(`${script}: ${error?.message ?? error}\n`);
    process.exit(1);
  }
}

/** A --guidance / --configs name: base (all off), all (all on), or switches joined with "+". Unknown names throw. */
export function guidanceFor(name, keys) {
  if (name === 'base') return false;
  if (name === 'all') return true;
  const parts = name.split('+');
  for (const part of parts) if (!keys.includes(part)) throw new Error(`Unknown guidance config ${name}`);
  return Object.fromEntries(keys.map(key => [key, parts.includes(key)]));
}

/** Run `fn` over `items` with at most `limit` in flight. */
export async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  }));
  return results;
}

/** Deterministic PRNG (mulberry32) so a run can be repeated exactly. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A shuffled copy of the offered actions; handoff (and done) stay last unless shuffleHandoff. */
export function shuffled(offered, random, shuffleHandoff = false) {
  const fixed = offered.filter(action => action.type === 'done' || (!shuffleHandoff && action.type === 'handoff'));
  const moving = offered.filter(action => !fixed.includes(action));
  for (let i = moving.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [moving[i], moving[j]] = [moving[j], moving[i]];
  }
  return [...moving, ...fixed];
}

