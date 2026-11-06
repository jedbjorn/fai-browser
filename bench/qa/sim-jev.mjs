#!/usr/bin/env node
// Simulated Jev: a loopback SystemOne-compatible server for measuring runtime mechanics (in-call retries, handoff
// rates, calls per run, run time) on the QA corpus without a Jev key. It is NOT a model of Jev's quality.
//
//   node bench/qa/sim-jev.mjs [--port N] [--latency-ms 260] [--noise 1] [--seed 1]
//   import { startSimJev } from './sim-jev.mjs'   -> { port, stats, close() }
//
// decide: scores each offered action by overlap with the next unvisited page the instruction names (src/oversight.js
// namedHops/remainingHops over the history and the current page), then all instruction terms; handoff has a fixed
// score. A position bias (earlier options score higher) and deterministic noise keyed by the request (instruction,
// page, option order, option id) make close calls and wrong picks happen, and a reordered request gets different
// noise. Probabilities are a softmax. `done` is high once every named page was visited (or, without named pages,
// when the page carries most instruction terms). Guards (blocked, injection, commit, purchase_*) come from keyword
// rules over the page and the offered labels. choose: question-term overlap plus a digit bonus, the same noise.
// Latency: a flat --latency-ms per request with a small deterministic jitter (Jev is about 260 ms flat).
import http from 'node:http';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { namedHops, remainingHops } from '../../src/oversight.js';

const STOP = new Set(('the and then from page open visit click read stop there current answer what which how that this '
  + 'into forms form type submit not for with its are was were has have will your you our out all any one two use '
  + 'find tell report show give list get see look order there their them they its link links tab section button '
  + 'menu item named name names does did done when where who whom whose why yes').split(' '));
const HANDOFF_TEXT = 'None of these clearly advances the instruction, or the user must act';

function words(text) {
  return (String(text ?? '').toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter(w => !STOP.has(w));
}

function unit(seed, ...parts) {
  const hash = createHash('sha256').update([seed, ...parts].join('\u0000')).digest();
  return hash.readUInt32BE(0) / 0xffffffff;
}

function softmax(scores, temperature) {
  const max = Math.max(...scores);
  const exps = scores.map(s => Math.exp((s - max) * temperature));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map(e => e / sum);
}

const round = x => Math.round(x * 1000) / 1000;

function optionText(value) {
  return typeof value === 'string' ? value : String(value?.what ?? '');
}

export function simulateDecide(body, { noise = 1, seed = 1 } = {}) {
  const state = body.state ?? {};
  const instruction = String(state.instruction ?? '');
  const page = state.page ?? {};
  const criteria = body.questions?.action?.criteria ?? {};
  const ids = Object.keys(criteria);
  const handoff = ids.find(id => optionText(criteria[id]) === HANDOFF_TEXT || id === 'handoff') ?? null;
  const options = ids.filter(id => id !== handoff);
  let path = '';
  // Noise is keyed by the page's path and query, never its origin: the QA site runs on a random port per session, so
  // keying by the full URL made two runs of the same task (say --retry off and on) draw different noise.
  let pageKey = String(page.url ?? '');
  try {
    const url = new URL(page.url);
    pageKey = url.pathname + url.search;
    path = decodeURIComponent(new URL(page.url).pathname).toLowerCase().replace(/[-_/.]+/g, ' ');
  } catch {
    // no path
  }
  const seen = [String(page.title ?? '').toLowerCase(), path];
  for (const entry of state.history ?? []) {
    seen.push(String(entry.label ?? '').toLowerCase());
    try {
      seen.push(decodeURIComponent(new URL(entry.toUrl).pathname).toLowerCase().replace(/[-_/.]+/g, ' '));
    } catch {
      // no path
    }
  }
  const hops = namedHops(instruction);
  const remaining = remainingHops(hops, seen);
  const next = remaining[0] ? new Set(words(remaining[0])) : new Set();
  const terms = new Set(words(instruction));
  const order = options.join(',');
  const scores = options.map((id, position) => {
    const text = optionText(criteria[id]).toLowerCase();
    const label = new Set(words(text));
    let score = 0;
    if (/declines optional cookies/.test(text)) score += 3;
    for (const w of next) if (label.has(w)) score += 2;
    for (const w of terms) if (label.has(w)) score += 0.5;
    if (/^scroll|^wait/.test(text)) score = /scroll|below|load more|bottom/.test(instruction.toLowerCase()) ? 1.2 : 0.1;
    const bias = options.length > 1 ? 0.35 * (1 - position / (options.length - 1)) : 0;
    return score + bias + noise * (unit(seed, instruction, pageKey, order, id) - 0.5);
  });
  const handoffScore = 1 + noise * 0.5 * (unit(seed, instruction, pageKey, order, 'handoff') - 0.5);
  const all = handoff ? [...scores, handoffScore] : scores;
  const probabilities = softmax(all, 2.5);
  const allIds = handoff ? [...options, handoff] : options;
  let best = 0;
  for (let i = 1; i < all.length; i++) if (all[i] > all[best]) best = i;
  // A slim terminal request (src/typesafe.js confirmBody) has no action question: only the nouls are answered.
  const answers = {};
  if (body.questions?.action) {
    answers.action = {
      type: 'choice',
      choice: allIds[best],
      confidence: round(probabilities[best]),
      probabilities: Object.fromEntries(allIds.map((id, i) => [id, round(probabilities[i])])),
    };
  }
  const text = `${page.title ?? ''} ${page.text ?? ''}`.toLowerCase();
  const pageTerms = new Set(words(text));
  const coverage = terms.size ? [...terms].filter(w => pageTerms.has(w)).length / terms.size : 0;
  const done = hops.length ? (remaining.length ? 0.08 : 0.86) : coverage >= 0.5 ? 0.8 : 0.1;
  if (body.questions?.done) answers.done = { type: 'noul', noul: done };
  const labels = ids.map(id => optionText(criteria[id]).toLowerCase()).join(' | ');
  const nouls = {
    blocked: /sign in to|log in to|captcha|verify you are human|bot or not|subscribe to (?:continue|read)|paywall/.test(text) ? 0.9 : 0.05,
    injection: /ignore (?:all |any )?(?:previous|prior) instructions|ai assistant|dear (?:agent|assistant)|system prompt/.test(text) ? 0.9 : 0.05,
    commit: /place order|pay now|buy|delete|confirm|send|subscribe|book now|yes, delete/.test(labels) ? 0.85 : 0.1,
    purchase_control: /place order|pay|buy|checkout|subscribe|purchase/.test(labels) ? 0.9 : 0.05,
    purchase_page: /checkout|payment details|review and pay|order review/.test(text) ? 0.8 : 0.05,
  };
  for (const [name, p] of Object.entries(nouls)) if (body.questions?.[name]) answers[name] = { type: 'noul', noul: p };
  return answers;
}

export function simulateChoose(body, { noise = 1, seed = 1 } = {}) {
  const state = body.state ?? {};
  const question = String(state.question ?? '');
  const criteria = body.questions?.answer?.criteria ?? {};
  const ids = Object.keys(criteria);
  const terms = new Set(words(question));
  const numeric = /how many|price|cost|count|number|total|amount/i.test(question);
  const scores = ids.map(id => {
    const text = String(criteria[id]);
    let score = words(text).filter(w => terms.has(w)).length;
    if (numeric && /\d/.test(text)) score += 1.5;
    return score + noise * 0.6 * (unit(seed, question, ids.join(','), id) - 0.5);
  });
  const probabilities = softmax(scores, 2);
  let best = 0;
  for (let i = 1; i < scores.length; i++) if (scores[i] > scores[best]) best = i;
  return {
    answer: {
      type: 'choice',
      choice: ids[best],
      confidence: round(probabilities[best]),
      probabilities: Object.fromEntries(ids.map((id, i) => [id, round(probabilities[i])])),
    },
  };
}

export async function startSimJev({ port = 0, latencyMs = 260, noise = 1, seed = 1 } = {}) {
  const stats = { decide: 0, choose: 0, errors: 0 };
  const server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"data":[{"id":"sim-jev"}]}');
      return;
    }
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      let body;
      let answers;
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        body = JSON.parse(raw);
        if (body.questions?.answer) {
          stats.choose++;
          answers = simulateChoose(body, { noise, seed });
        } else {
          stats.decide++;
          answers = simulateDecide(body, { noise, seed });
        }
      } catch (error) {
        stats.errors++;
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end(String(error.message));
        return;
      }
      const jitter = Math.round((unit(seed, raw.length, raw.slice(0, 200)) - 0.5) * 80);
      const wait = Math.max(0, latencyMs + jitter);
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ model: 'sim-jev', answers, latency_ms: wait,
          usage: { input_tokens: Math.round(raw.length / 4), output_tokens: 0 } }));
      }, wait);
    });
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    stats,
    close: () => new Promise(resolve => server.close(() => resolve())),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: {
    port: { type: 'string', default: '0' }, 'latency-ms': { type: 'string', default: '260' },
    noise: { type: 'string', default: '1' }, seed: { type: 'string', default: '1' },
  } });
  const sim = await startSimJev({ port: Number(values.port), latencyMs: Number(values['latency-ms']),
    noise: Number(values.noise), seed: Number(values.seed) });
  console.log(`sim-jev on http://127.0.0.1:${sim.port}/v1/systemone`);
}
