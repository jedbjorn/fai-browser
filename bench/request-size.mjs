#!/usr/bin/env node
// Offline replay of Jev decide requests: rebuilds the request body the runtime would send for recorded pages, with
// and without the slim switches (src/runtime.js resolveSlim), and reports its size by section. No key, no browser,
// no provider call. Quality is NOT measured here: bench/jev-eval.mjs --slim and bench/qa/run.mjs --slim are the gates.
//
//   node bench/request-size.mjs                         the jev-eval cases (test/fixtures/jev/cases.json)
//   node bench/request-size.mjs --traces DIR[,DIR]      also every trace.json under DIR with a final observation
//                                                       (bench/real/results, artifacts/, bench/results/qa-*)
//   node bench/request-size.mjs --json OUT.json         also write per-sample rows
//
// Samples: one per jev-eval case (the page and the offered actions as the runtime builds them) and one per trace
// (its final page, rebuilt with the run's mode, origins, allowedUrls, policy, history and expectation). Groups:
// jev-eval, qa, real (bench/real), artifacts (anything else). Per group and variant: mean JSON characters per section
// (requestSizes in src/typesafe.js), options offered, estimated input tokens (chars / 4 x 1.45, the ratio measured
// on live Jev requests) and estimated output tokens (117 + 6.1 per option, the live regression). For traces whose
// final decision recorded probabilities, `kept` is the share whose chosen action (and top 5) the variant still sends.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { legalActions, providerPayload, resolveSlim } from '../src/runtime.js';
import { confirmBody, decideBody, requestSizes } from '../src/typesafe.js';
import { DEFAULT_THRESHOLDS } from '../src/oversight.js';
import { DEFAULT_OPTION_CAP, capActions, relevanceHints } from '../src/relevance.js';
import { normalizeAdditions } from '../src/guardrails.js';
import { loadCases, offeredFor, payloadFor } from './jev-eval/lib.mjs';

const { values: args } = parseArgs({
  options: {
    traces: { type: 'string' },
    cases: { type: 'string' },
    'no-cases': { type: 'boolean' },
    json: { type: 'string' },
  },
});

/** The variants compared, each a `slim` value for resolveSlim. */
export const VARIANTS = [
  ['base', false],
  ['controls', { controls: true }],
  // The slim terminal request is sent only on a page where the expectation passes; its size is shown for every page
  // and the "terminal pages" lines below cover only the recorded pages where it would have been sent.
  ['terminal', { terminal: true }],
  ['cap', { cap: true }],
  ['controls+cap', { controls: true, cap: true }],
];

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (entry.name === 'trace.json') out.push(path);
  }
  return out;
}

function groupOf(path) {
  if (/bench\/real\//.test(path)) return 'real';
  if (/\/qa-[^/]*\//.test(path)) return 'qa';
  return 'artifacts';
}

/** A sample from a jev-eval case. */
function caseSample(entry) {
  const offered = offeredFor(entry);
  const { observation, actions, context } = payloadFor(entry, offered);
  return {
    id: entry.id, group: 'jev-eval', observation, offered: actions, context,
    hints: relevanceHints({ instruction: entry.instruction }), decision: null, gold: entry.gold,
  };
}

/** A sample from a trace's final page, or null when it has none. */
function traceSample(path) {
  let trace;
  try {
    trace = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  const final = trace.finalObservation;
  if (!final?.controls || !trace.instruction) return null;
  const options = trace.options ?? {};
  const mode = options.mode ?? 'read-only';
  const observation = { revision: final.revision ?? 'r', ...final };
  let offered;
  try {
    const legal = { mode, allowedOrigins: options.allowedOrigins, allowedUrls: options.allowedUrls ?? [] };
    if (options.policy) legal.policy = options.policy;
    offered = legalActions(observation, legal);
  } catch {
    return null;
  }
  const history = (trace.steps ?? []).map(step => ({
    i: step.i, type: step.action?.type, label: step.action?.label, fromUrl: step.action?.fromUrl,
    toUrl: step.action?.toUrl, changed: step.changed,
  }));
  const payload = providerPayload(observation, offered, history, {});
  const context = { instruction: trace.instruction, history: payload.history, mode };
  if (options.policy) {
    try {
      const { forbid, note } = normalizeAdditions(options.policy);
      if (forbid.length || note) context.guardrails = { forbid, note };
    } catch {
      // An older trace's policy: send none.
    }
  }
  return {
    id: path, group: groupOf(path), observation: payload.observation, offered: payload.actions, context,
    hints: relevanceHints({ instruction: trace.instruction, answerQuestion: options.answerQuestion, expectation: options.expectation }),
    decision: trace.finalDecision ?? null,
    terminal: trace.verification?.passed === true && Number.isFinite(trace.finalDecision?.done),
  };
}

/** The decide body a variant sends for a sample, and the offered actions it sent. */
export function bodyFor(sample, slimValue) {
  const slim = resolveSlim(slimValue);
  let offered = sample.offered.filter(action => action.type !== 'done');
  if (slim.cap) offered = capActions(offered, DEFAULT_OPTION_CAP, sample.hints).actions;
  const context = { ...sample.context };
  if (slim.controls) {
    context.compact = true;
    context.hints = sample.hints;
  }
  if (slim.terminal) return { body: confirmBody({ model: 'jev-latest', observation: sample.observation, context }), sent: [] };
  return { body: decideBody({ model: 'jev-latest', observation: sample.observation, offered, context }), sent: offered };
}

const samples = [];
if (!args['no-cases']) for (const entry of await loadCases(args.cases)) samples.push(caseSample(entry));
for (const dir of (args.traces ?? '').split(',').filter(Boolean)) {
  for (const path of walk(dir)) {
    const sample = traceSample(path);
    if (sample) samples.push(sample);
  }
}

const rows = [];
for (const sample of samples) {
  for (const [variant, value] of VARIANTS) {
    const { body, sent } = bodyFor(sample, value);
    const sizes = requestSizes(body);
    const row = { id: sample.id, group: sample.group, variant, ...sizes };
    // Recorded ids are positions in the offered list at recording time; a trace counts only when every recorded id
    // still exists in the rebuilt list (necessary, not sufficient, for the ids to name the same actions).
    const decision = sample.decision;
    const recorded = [decision?.actionId, ...Object.keys(decision?.probabilities ?? {})].filter(Boolean);
    const aligned = recorded.length && recorded.every(id => sample.offered.some(action => action.id === id));
    if (variant !== 'terminal' && aligned) {
      const ids = new Set(sent.map(action => action.id));
      row.keptChoice = ids.has(decision.actionId);
      const top = Object.keys(decision.probabilities ?? {});
      if (top.length) row.keptTop = top.every(id => ids.has(id));
    }
    rows.push(row);
  }
}

const SECTIONS = ['total', 'instruction', 'policy', 'page', 'text', 'controls', 'history', 'options', 'questions'];
const mean = list => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : 0);
const groups = [...new Set(rows.map(row => row.group))];
const lines = [];
for (const group of groups) {
  const base = rows.filter(row => row.group === group && row.variant === 'base');
  const busy = base.filter(row => row.options > 41).length;
  lines.push(`\n## ${group} (${base.length} pages, ${busy} offering more than 40 options)\n`);
  lines.push(`| variant | ${SECTIONS.join(' | ')} | options | est. tokens in | est. tokens out | vs base (chars) | kept choice | kept top 5 |`);
  lines.push(`|${'---|'.repeat(SECTIONS.length + 7)}`);
  const baseTotal = mean(base.map(row => row.chars.total));
  for (const [variant] of VARIANTS) {
    const list = rows.filter(row => row.group === group && row.variant === variant);
    if (!list.length) continue;
    const cells = SECTIONS.map(key => Math.round(mean(list.map(row => row.chars[key] ?? 0))));
    const options = mean(list.map(row => row.options));
    const total = mean(list.map(row => row.chars.total));
    const kept = list.filter(row => row.keptChoice !== undefined);
    const keptTop = list.filter(row => row.keptTop !== undefined);
    lines.push(`| ${variant} | ${cells.join(' | ')} | ${options.toFixed(1)} | ${Math.round(total / 4 * 1.45)} | ${Math.round(117 + 6.1 * options)} | `
      + `${variant === 'base' ? '-' : `${((total / baseTotal - 1) * 100).toFixed(1)}%`} | `
      + `${kept.length ? `${kept.filter(row => row.keptChoice).length}/${kept.length}` : '-'} | `
      + `${keptTop.length ? `${keptTop.filter(row => row.keptTop).length}/${keptTop.length}` : '-'} |`);
  }
}
// Terminal pages: recorded runs whose final page passed the expectation (the slim terminal request would have been
// sent there). The recorded full decide's done is the proxy for whether the slim request would confirm (done at
// doneThreshold) or fall back to the full decide.
const terminalPages = samples.filter(sample => sample.terminal);
if (terminalPages.length) {
  const threshold = DEFAULT_THRESHOLDS.doneThreshold;
  lines.push(`\n## terminal pages (${terminalPages.length} recorded final pages where the expectation passed)\n`);
  lines.push('| group | pages | full decide chars | slim terminal chars | change | est. tokens out full / slim | recorded done < threshold (fallback proxy) |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const group of [...new Set(terminalPages.map(sample => sample.group))]) {
    const ids = new Set(terminalPages.filter(sample => sample.group === group).map(sample => sample.id));
    const pick = variant => rows.filter(row => row.variant === variant && ids.has(row.id));
    const full = mean(pick('base').map(row => row.chars.total));
    const slim = mean(pick('terminal').map(row => row.chars.total));
    const fullOut = Math.round(117 + 6.1 * mean(pick('base').map(row => row.options)));
    const low = terminalPages.filter(sample => ids.has(sample.id) && sample.decision.done < threshold).length;
    lines.push(`| ${group} | ${ids.size} | ${Math.round(full)} | ${Math.round(slim)} | ${((slim / full - 1) * 100).toFixed(1)}% | ${fullOut} / 117 | ${low}/${ids.size} |`);
  }
}
process.stdout.write(`Request size by section (mean JSON characters per decide request)\n${lines.join('\n')}\n`);
if (args.json) writeFileSync(args.json, `${JSON.stringify(rows, null, 1)}\n`);
