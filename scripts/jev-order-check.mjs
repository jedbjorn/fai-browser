#!/usr/bin/env node
// Option-order bias check for the TypeSafe Jev provider (TypeSafe documents that Jev "leans toward the option that
// comes first"). Replays recorded decision cases with the offered options in shuffled order and reports how often
// the choice flips relative to the original order.
//   node scripts/jev-order-check.mjs [--cases test/fixtures/jev/cases.json] [--shuffles 3] [--seed 1]
//                                    [--guidance all|base|policy+criteria...] [--shuffle-handoff] [--json]
// Cases are the labelled observations captured by bench/jev-eval/capture.mjs (page.js observations, history,
// instruction). Option ids stay the same under a shuffle, so a flip is a different action, not a renumbering.
// handoff stays last unless --shuffle-handoff. The key is loaded the way the daemon loads it (FAI_HOME/.env.local)
// and is never printed. Spends (shuffles + 1) x cases Jev requests.
import { parseArgs } from 'node:util';
import { GUIDANCE_KEYS, TypeSafeProvider } from '../src/typesafe.js';
import { goldIds, guidanceFor, loadCases, offeredFor, payloadFor, pool, requireDaemonKey, rng, shuffled } from '../bench/jev-eval/lib.mjs';

const { values: args } = parseArgs({
  options: {
    cases: { type: 'string' },
    shuffles: { type: 'string', default: '3' },
    seed: { type: 'string', default: '1' },
    guidance: { type: 'string', default: 'all' },
    'shuffle-handoff': { type: 'boolean' },
    concurrency: { type: 'string', default: '4' },
    json: { type: 'boolean' },
  },
});

let guidance;
try {
  guidance = guidanceFor(args.guidance, GUIDANCE_KEYS);
} catch (error) {
  process.stderr.write(`jev-order-check: ${error.message}\n`);
  process.exit(1);
}
const cases = await loadCases(args.cases);
const shuffles = Number(args.shuffles);
const random = rng(Number(args.seed));
await requireDaemonKey('jev-order-check');
const provider = new TypeSafeProvider({ guidance });

const jobs = [];
for (const entry of cases) {
  const offered = offeredFor(entry);
  jobs.push({ entry, offered, order: 0 });
  for (let k = 1; k <= shuffles; k++) jobs.push({ entry, offered: shuffled(offered, random, args['shuffle-handoff']), order: k });
}
const results = await pool(jobs, Number(args.concurrency), async ({ entry, offered, order }) => {
  const { observation, actions, context } = payloadFor(entry, offered);
  try {
    const decision = await provider.decide(observation, actions, context);
    return { id: entry.id, order, choice: decision.actionId, correct: goldIds(entry, offered).has(decision.actionId) };
  } catch (error) {
    return { id: entry.id, order, error: String(error?.message ?? error) };
  }
});

const byCase = new Map();
for (const r of results) {
  if (!byCase.has(r.id)) byCase.set(r.id, []);
  byCase.get(r.id).push(r);
}
let compared = 0;
let flips = 0;
let correctnessFlips = 0;
const flipped = [];
for (const [id, list] of byCase) {
  const original = list.find(r => r.order === 0);
  if (!original || original.error) continue;
  for (const r of list.filter(item => item.order > 0 && !item.error)) {
    compared++;
    if (r.choice !== original.choice) {
      flips++;
      flipped.push(`${id}: ${original.choice} -> ${r.choice}`);
    }
    if (r.correct !== original.correct) correctnessFlips++;
  }
}
const report = {
  guidance: args.guidance,
  cases: byCase.size,
  shuffles,
  compared,
  flips,
  flipRate: compared ? Math.round((flips / compared) * 1000) / 1000 : null,
  correctnessFlipRate: compared ? Math.round((correctnessFlips / compared) * 1000) / 1000 : null,
  errors: results.filter(r => r.error).length,
  flipped,
};
if (args.json) process.stdout.write(`${JSON.stringify(report, null, 1)}\n`);
else {
  process.stdout.write(`order check (${report.guidance}): ${report.flips}/${report.compared} shuffled requests changed the choice `
    + `(flip rate ${report.flipRate}; correctness flipped ${report.correctnessFlipRate}); errors ${report.errors}\n`);
  for (const line of flipped) process.stdout.write(`  ${line}\n`);
}
