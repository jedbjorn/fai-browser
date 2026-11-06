#!/usr/bin/env node
// Replay one recorded decision against live Jev with controlled variations, one factor at a time.
//   node bench/jev-replay.mjs --trace artifacts/<run>/trace.json [--step N|final] --instruction "..." \
//        [--target "Date grid"] [--variations base,policy-off,...|all] [--repeat 3] [--mode interactive] [--dry-run]
// The page is the trace's observe page (an observe trace), finalObservation (--step final, the default for a run
// trace) or steps[N].observation when it carries controls. The offered actions are rebuilt as a run builds them
// (legalActions with the trace's mode, allowedUrls and policy; no option cap, as DEFAULT_SLIM), the body with
// decideBody as TypeSafeProvider.decide sends it, so `base` is the request the runtime would send for that
// instruction. Traces do not record the instruction text, hence --instruction.
// Per variation: the top-5 action probabilities (mean over repeats), the target's probability and rank, handoff,
// done and the guards, plus a short body hash (variations that do not change the body share it).
// The key is loaded the way the daemon loads it (FAI_HOME/.env.local) and is never printed. --dry-run prints the
// body hashes and sizes only and needs no key.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { legalActions, providerPayload } from '../src/runtime.js';
import { DEFAULT_GUIDANCE, TypeSafeProvider, decideBody, requestSizes } from '../src/typesafe.js';
import { normalizeAdditions } from '../src/guardrails.js';
import { capActions, relevanceHints } from '../src/relevance.js';
import { requireDaemonKey } from './jev-eval/lib.mjs';

/** Load a trace's page, offered actions and context for one step. */
export function loadSample(path, { step = null, mode: modeOverride, instruction, suppliedText: supplied } = {}) {
  const trace = JSON.parse(readFileSync(path, 'utf8'));
  // Traces record supplied values as [redacted]: `suppliedText` (the task's real values) redacts the page as the run did.
  const options = supplied ? { ...(trace.options ?? {}), suppliedText: supplied } : (trace.options ?? {});
  let page;
  let steps = trace.steps ?? [];
  if (trace.operation === 'observe' || (trace.page?.controls && !trace.finalObservation)) {
    page = trace.page;
  } else if (step === null || step === 'final') {
    page = trace.finalObservation;
  } else {
    page = steps[Number(step)]?.observation;
    steps = steps.slice(0, Number(step));
  }
  if (!page?.controls) throw new Error(`No full observation (controls) at step ${step ?? 'final'} of ${path}`);
  const mode = modeOverride ?? options.mode ?? options.level ?? 'read-only';
  const observation = { revision: page.revision ?? 'r', ...page };
  const legal = { mode, allowedOrigins: options.allowedOrigins, allowedUrls: options.allowedUrls ?? [], suppliedText: options.suppliedText ?? {} };
  if (options.policy) legal.policy = options.policy;
  // An observe trace records the actions it offered (every one a run would offer: runs have no listing cap); a
  // trace's controls lack the page script's risk classes, so rebuilding them would drop risk-classed controls.
  const terminals = legalActions({ url: observation.url, controls: [] }).filter(terminal);
  const offered = Array.isArray(trace.actions) && trace.actions.length && page === trace.page
    ? [...trace.actions.filter(action => !terminal(action)), ...terminals]
    : legalActions(observation, legal);
  const history = steps.map(entry => ({
    i: entry.i, type: entry.action?.type, label: entry.action?.label, fromUrl: entry.action?.fromUrl,
    toUrl: entry.action?.toUrl, changed: entry.changed, ...(entry.action?.ref !== undefined ? { ref: entry.action.ref } : {}),
    // As runtime historyEntry(): the supplied value's name (never its text) for a fill.
    ...(entry.action?.suppliedName !== undefined ? { suppliedName: entry.action.suppliedName } : {}),
  }));
  const payload = providerPayload(observation, offered, history, options.suppliedText ?? {});
  const context = { instruction, history: payload.history, mode, level: mode };
  if (options.policy) {
    const { forbid, note } = normalizeAdditions(options.policy);
    if (forbid.length || note) context.guardrails = { forbid, note };
  }
  return { trace, observation: payload.observation, offered: payload.actions, context };
}

const terminal = action => action.type === 'done' || action.type === 'handoff';

/** Keep the target plus `n` generic neighbours: a fixture-like page with the same instruction. */
function plainPage(sample, target, n = 5) {
  const others = sample.offered.filter(a => !terminal(a) && a !== target && a.target !== undefined).slice(0, n);
  const keep = [target, ...others];
  const ids = new Set(keep.map(a => String(a.target)));
  return {
    observation: { ...sample.observation, text: `${sample.observation.title}\n${keep.map(a => a.label).join('\n')}`, controls: sample.observation.controls.filter(c => ids.has(String(c.id))) },
    offered: [...keep, ...sample.offered.filter(terminal)],
  };
}

/**
 * The variations: name -> (sample, helpers) => { instruction?, guidance?, offered?, observation?, context?, body? }.
 * Each changes one factor of `base`.
 */
export function variations({ target, pathInstruction = '<scratch>' }) {
  const label = target?.label ?? 'Date grid';
  return {
    base: () => ({}),
    'instr-file-path': () => ({ instruction: pathInstruction }),
    'instr-owner': () => ({ instruction: `On the Google Flights results page, click the '${label}' button to open the date grid. Do not select or book a flight.` }),
    'instr-owner-no-neg': () => ({ instruction: `On the Google Flights results page, click the '${label}' button to open the date grid.` }),
    'instr-imperative': () => ({ instruction: `Click the '${label}' button.` }),
    'instr-goal': () => ({ instruction: 'Show the prices for nearby departure dates as a grid.' }),
    'instr-exact': () => ({ instruction: `Click ${target?.role ?? 'button'} ${target?.target}: ${label}` }),
    'instr-neg-only': () => ({ instruction: `Click the '${label}' button. Do not select or book a flight.` }),
    'policy-off': () => ({ guidance: { policy: false } }),
    'handoffOther-off': () => ({ guidance: { handoffOther: false } }),
    'criteria-off': () => ({ guidance: { criteria: false } }),
    'guards-off': () => ({ guidance: { guards: false } }),
    'mode-read-only': () => ({ context: { mode: 'read-only', level: 'read-only' } }),
    'mode-reversible': () => ({ context: { mode: 'reversible', level: 'reversible' } }),
    'mode-full': () => ({ context: { mode: 'full', level: 'full' } }),
    'opts-top20': sample => ({ offered: capActions(sample.offered, 20, relevanceHints({ instruction: sample.context.instruction })).actions }),
    'opts-top40': sample => ({ offered: capActions(sample.offered, 40, relevanceHints({ instruction: sample.context.instruction })).actions }),
    'opts-target-first': sample => ({ offered: [target, ...sample.offered.filter(a => a !== target)] }),
    'opts-reversed': sample => ({ offered: [...sample.offered.filter(a => !terminal(a)).reverse(), ...sample.offered.filter(terminal)] }),
    'label-descriptor': sample => ({ offered: sample.offered.map(a => (a === target ? { ...a, label: `unlabelled button 1 of 2 next to "${label}"` } : a)) }),
    'text-empty': sample => ({ observation: { ...sample.observation, text: '' } }),
    'text-no-target': sample => ({ observation: { ...sample.observation, text: sample.observation.text.split('\n').filter(line => !line.includes(label)).join('\n') } }),
    'history-3-clicks': sample => ({ context: { history: [1, 2, 3].map(i => ({ i, type: 'click', label: 'unlabelled button 1 of 2 next to "Departure"', fromUrl: sample.observation.url, toUrl: sample.observation.url, changed: true, ref: '19' })) } }),
    'plain-page': sample => plainPage(sample, target),
  };
}

export function buildBody(sample, change, model = 'jev-latest') {
  const guidance = { ...DEFAULT_GUIDANCE, ...(change.guidance ?? {}) };
  const context = { ...sample.context, ...(change.instruction ? { instruction: change.instruction } : {}), ...(change.context ?? {}) };
  const offered = (change.offered ?? sample.offered).filter(a => a.type !== 'done');
  return decideBody({ model, observation: change.observation ?? sample.observation, offered, context, guidance });
}

const hash = body => createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 8);

/** POST one body to the provider endpoint; returns the raw answers. */
async function ask(provider, body) {
  const response = await fetch(provider.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env[provider.keyEnv]}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()).answers ?? {};
}

const p = reply => reply?.noul ?? reply?.probability ?? null;

async function main() {
  const { values: args } = parseArgs({
    options: {
      trace: { type: 'string' }, step: { type: 'string' }, instruction: { type: 'string' }, target: { type: 'string' },
      variations: { type: 'string', default: 'all' }, repeat: { type: 'string', default: '3' }, mode: { type: 'string' },
      'dry-run': { type: 'boolean' }, json: { type: 'boolean' },
    },
  });
  if (!args.trace || !args.instruction) {
    process.stderr.write('usage: node bench/jev-replay.mjs --trace FILE --instruction TEXT [--target LABEL] [--step N|final] [--variations a,b|all] [--repeat 3] [--dry-run]\n');
    process.exit(2);
  }
  const sample = loadSample(args.trace, { step: args.step ?? null, mode: args.mode, instruction: args.instruction });
  const targetLabel = (args.target ?? '').toLowerCase();
  const target = targetLabel ? sample.offered.find(a => String(a.label ?? '').toLowerCase() === targetLabel)
    ?? sample.offered.find(a => String(a.label ?? '').toLowerCase().includes(targetLabel)) : null;
  if (targetLabel && !target) throw new Error(`No offered action labelled "${args.target}"`);
  const all = variations({ target });
  const names = args.variations === 'all' ? Object.keys(all) : args.variations.split(',');
  const provider = new TypeSafeProvider({ requireKey: false });
  if (!args['dry-run']) await requireDaemonKey('jev-replay');
  const sentControls = sample.observation.controls.slice(0, 60).map(c => String(c.id));
  process.stdout.write(`page ${sample.observation.url.slice(0, 80)} | offered ${sample.offered.length} | mode ${sample.context.mode}`
    + (target ? ` | target ${target.id} (${target.role} ${target.target} "${target.label}", offered #${sample.offered.indexOf(target) + 1}, in sent controls: ${sentControls.includes(String(target.target))})` : '') + '\n');
  const rows = [];
  for (const name of names) {
    if (!all[name]) throw new Error(`Unknown variation ${name}`);
    const change = all[name](sample);
    const body = buildBody(sample, change, provider.model);
    const ids = Object.keys(body.questions.action.criteria);
    const row = { name, hash: hash(body), chars: requestSizes(body).chars.total, options: ids.length, runs: [] };
    if (!args['dry-run']) {
      for (let r = 0; r < Number(args.repeat); r++) {
        try {
          const answers = await ask(provider, body);
          row.runs.push({ choice: answers.action?.choice, probabilities: answers.action?.probabilities ?? {}, done: p(answers.done),
            guards: Object.fromEntries(['blocked', 'injection', 'commit', 'purchase_control', 'purchase_page'].filter(k => answers[k]).map(k => [k, p(answers[k])])) });
        } catch (error) {
          row.runs.push({ error: String(error.message ?? error) });
        }
      }
    }
    const ok = row.runs.filter(run => !run.error);
    const mean = key => (ok.length ? ok.reduce((sum, run) => sum + (run.probabilities[key] ?? 0), 0) / ok.length : null);
    const keys = new Set(ok.flatMap(run => Object.keys(run.probabilities)));
    const top = [...keys].map(key => [key, mean(key)]).sort((a, b) => b[1] - a[1]);
    const label = id => (id === 'handoff' ? 'handoff' : String(sample.offered.find(a => a.id === id)?.label ?? id).slice(0, 28));
    row.top5 = top.slice(0, 5).map(([id, v]) => `${label(id)}=${v.toFixed(2)}`);
    row.handoff = mean('handoff');
    row.target = target ? mean(target.id) : null;
    row.targetRank = target ? (top.findIndex(([id]) => id === target.id) + 1 || null) : null;
    row.choices = ok.map(run => label(run.choice));
    row.done = ok.length ? ok.reduce((s, run) => s + (run.done ?? 0), 0) / ok.length : null;
    row.guards = ok[0]?.guards ?? null;
    row.errors = row.runs.length - ok.length;
    rows.push(row);
    const f = v => (v === null || v === undefined ? '-' : v.toFixed(2));
    process.stdout.write(`${name.padEnd(20)} ${row.hash} opts=${String(row.options).padStart(3)} chars=${row.chars} handoff=${f(row.handoff)} target=${f(row.target)}`
      + ` rank=${row.targetRank ?? '-'} done=${f(row.done)} choices=[${row.choices.join('|')}] top5: ${row.top5.join(', ')}${row.errors ? ` errors=${row.errors}` : ''}\n`);
  }
  if (args.json) process.stdout.write(`${JSON.stringify(rows)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    process.stderr.write(`jev-replay: ${error?.message ?? error}\n`);
    process.exit(1);
  });
}
