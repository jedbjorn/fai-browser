// Host models for the benchmark matrix: `codex:<slug>[:effort]` and `claude:<slug>[:effort]`, the price table and the
// per-condition labels. Pure except loadPrices (reads bench/prices.json).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const VENDORS = Object.freeze(['codex', 'claude']);
export const EFFORTS = Object.freeze({
  codex: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
});
// Medium keeps Codex labels equal to the results recorded before hosts existed (gpt-6.1-sol, medium).
export const DEFAULT_EFFORT = Object.freeze({ codex: 'medium', claude: 'medium' });
export const ALIASES = Object.freeze({
  astra: ['codex', 'gpt-6-astra'],
  sol: ['codex', 'gpt-6.1-sol'],
  luna: ['codex', 'gpt-6-luna'],
  terra: ['codex', 'gpt-5.6-terra'],
  opus: ['claude', 'claude-opus-5-5'],
  sonnet: ['claude', 'claude-sonnet-5-5'],
});
// Host of every record written before the --host option (runs.jsonl rows without a `host` field).
export const LEGACY_HOST = 'codex:gpt-6.1-sol:medium';

// "codex:gpt-6.1-sol:medium" | "claude:claude-sonnet-5-5" | "sonnet:low" | "codex:sol" -> {vendor, model, effort, id}.
// The spec splits at the first two colons; throws with a readable message on anything else.
export function parseHost(spec) {
  const text = String(spec ?? '').trim();
  if (!text) {
    throw new Error('empty --host value');
  }
  const parts = text.split(':');
  let vendor;
  let model;
  let effort;
  if (VENDORS.includes(parts[0])) {
    [vendor, model, effort] = [parts[0], parts[1], parts.slice(2).join(':')];
    if (!model) {
      throw new Error(`--host ${text}: missing model slug (expected ${vendor}:<slug>[:effort])`);
    }
    if (ALIASES[model]) {
      const [aliasVendor, slug] = ALIASES[model];
      if (aliasVendor !== vendor) {
        throw new Error(`--host ${text}: ${model} is a ${aliasVendor} model`);
      }
      model = slug;
    }
  } else if (ALIASES[parts[0]]) {
    [vendor, model] = ALIASES[parts[0]];
    effort = parts.slice(1).join(':');
  } else {
    throw new Error(`--host ${text}: expected codex:<slug>[:effort] or claude:<slug>[:effort] (aliases: ${Object.keys(ALIASES).join(', ')})`);
  }
  effort = effort || DEFAULT_EFFORT[vendor];
  if (!EFFORTS[vendor].includes(effort)) {
    throw new Error(`--host ${text}: effort must be one of ${EFFORTS[vendor].join(', ')} for ${vendor}`);
  }
  return { vendor, model, effort, id: `${vendor}:${model}:${effort}` };
}

// --host values (repeatable, each may be a comma list). Without any, --model/--effort describe one Codex host.
export function parseHosts(values, { model = 'gpt-6.1-sol', effort = 'medium' } = {}) {
  const specs = (Array.isArray(values) ? values : values ? [values] : [])
    .flatMap(value => String(value).split(','))
    .map(value => value.trim())
    .filter(Boolean);
  const hosts = specs.length ? specs.map(parseHost) : [parseHost(`codex:${model}:${effort}`)];
  const seen = new Set();
  return hosts.filter(host => !seen.has(host.id) && seen.add(host.id));
}

// Condition key used in aggregation: "b/codex:gpt-6.1-sol:medium". Records without a host are legacy Codex runs.
export function conditionKey(condition, host) {
  return `${condition}/${host || LEGACY_HOST}`;
}

export function splitConditionKey(key) {
  const slash = String(key).indexOf('/');
  return slash < 0 ? { base: String(key), host: null } : { base: key.slice(0, slash), host: key.slice(slash + 1) };
}

// Conditions: A = Playwright MCP, B = FAI with the guidance inlined and no built-in tools, R = FAI as a real Claude
// Code install (deferred tools, skill, no inlined guidance; lib/real-install.mjs).
export const CONDITIONS = Object.freeze(['a', 'b', 'r']);
const CONDITION_SETS = Object.freeze({ both: ['a', 'b'], all: ['a', 'b', 'r'] });

// --condition value: a | b | r | both | all | a comma list ("b,r"). Returns the conditions in A, B, R order, or null.
export function parseConditions(value = 'both') {
  const list = CONDITION_SETS[value] ?? String(value).split(',').map(item => item.trim()).filter(Boolean);
  if (!list.length || list.some(item => !CONDITIONS.includes(item))) {
    return null;
  }
  return CONDITIONS.filter(item => list.includes(item));
}

const BASE_LABEL = { a: 'A', b: 'B', r: 'R', 'a-baseline': 'A-baseline', 'b-baseline': 'B-baseline' };
// "b/codex:gpt-6.1-sol:medium" -> "B/codex:gpt-6.1-sol:medium".
export function conditionLabel(key) {
  const { base, host } = splitConditionKey(key);
  const name = BASE_LABEL[base] ?? base;
  return host ? `${name}/${host}` : name;
}

// Directory-safe tag for a host id.
export const hostTag = id => String(id).replace(/[^A-Za-z0-9._-]+/g, '_');

export function loadPrices(path = join(import.meta.dirname, '..', 'prices.json')) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// Price row for a model slug ({in, cached, cache_write, cache_write_1h, out, basis} in $/MTok), or null.
export function priceFor(slug, prices) {
  if (!slug || !prices?.models) {
    return null;
  }
  return prices.models[slug] ?? prices.models[String(slug).replace(/\[.*\]$/, '')] ?? null;
}

// Model slug of a host id ("codex:gpt-6-luna:low" -> "gpt-6-luna").
export function hostModel(id) {
  return String(id || LEGACY_HOST).split(':')[1] ?? null;
}
