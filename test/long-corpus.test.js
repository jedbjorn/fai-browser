// Long-horizon corpus (fixtures/long, bench/long): every task is well formed and fits the MCP caps it is chunked
// under, its start page serves from the QA server's /long/ mount, its gold path walks with plain headless Chromium
// (no extension, no Jev) with every route mark landing on its hop, the ground truth is reproducible from the pages,
// and the runner's route progress, break taxonomy, answer grading and host emulation behave.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { headlessEnv } from '../scripts/headless-env.mjs';
import { startQaSite } from '../bench/qa/serve.mjs';
import {
  BREAK_CLASSES, MCP, MAX_HOPS, MIN_HOPS, budgetHits, chunkSteps, classifyBreak, gradeAnswer, gradeRecord, loadLongSuite,
  markMatches, materialize, naiveMaxActions, pickOption, reportMarkdown, routeProgress, runLongOracle, summarizeLong,
  supplyValues, traceObservations, validateLongSuite, validateLongTask,
} from '../bench/long/lib.mjs';

const suite = loadLongSuite();
const byId = id => suite.tasks.find(t => t.id === id);

let site;
let browser;
test.before(async () => {
  site = await startQaSite();
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, env: headlessEnv(), args: ['--no-sandbox'] });
});
test.after(async () => {
  await browser?.close();
  await site?.close();
});

// ------------------------------------------------------------------------------------------------ suite

test('suite: 5+ long tasks covering every family, each valid with no weak expectation', () => {
  assert.deepEqual(validateLongSuite(suite).errors, []);
  for (const task of suite.tasks) {
    const { errors, warnings } = validateLongTask(task);
    assert.deepEqual(errors, [], task.id);
    assert.deepEqual(warnings, [], task.id);
    assert.ok(task.hops >= MIN_HOPS && task.hops <= MAX_HOPS, task.id);
    // What a careful host sends today fits the caps: each chunk at most MAX_STEPS (15) steps and 30 actions per step.
    for (const chunk of chunkSteps(task.steps)) assert.ok(chunk.length <= MCP.maxSteps && chunk.every(s => (s.maxActions ?? 8) <= MCP.maxActions), task.id);
    assert.ok(naiveMaxActions(task) <= MCP.maxActions);
  }
});

test('suite: validation catches a broken route, a missing oracle hop and an oversized step chunk', () => {
  const task = structuredClone(byId('docs-deep-timeout'));
  task.route[3].hop = 2;
  task.oracle.actions.pop();
  task.steps[0].maxActions = 40;
  const { errors } = validateLongTask(task);
  assert.ok(errors.some(e => /route\[3\]/.test(e)), errors.join('; '));
  assert.ok(errors.some(e => /oracle.actions/.test(e)));
  assert.ok(errors.some(e => /maxActions/.test(e)));
});

// ------------------------------------------------------------------------------------------------ server

test('serve: every start page serves from /long/; non-GET is a violation there too; no escape from the mount', async () => {
  for (const task of suite.tasks) {
    const response = await fetch(materialize(task, site.origin).start);
    assert.equal(response.status, 200, task.id);
    await response.arrayBuffer();
  }
  const mark = site.mark();
  assert.equal((await fetch(`${site.origin}/long/wizard/step-6.html`, { method: 'POST', body: 'x' })).status, 405);
  assert.equal(site.since(mark).forbidden.length, 1);
  const escape = await fetch(`${site.origin}/long/%2e%2e/%2e%2e/package.json`);
  assert.equal(escape.status, 404);
  await escape.arrayBuffer();
});

// ------------------------------------------------------------------------------------------------ gold paths

test('oracle: every gold path walks headless and each route mark lands on its hop', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    for (const task of suite.tasks) {
      const result = await runLongOracle(context, task, site.origin);
      assert.deepEqual(result.missing, [], task.id);
      assert.equal(result.marks.length, task.route.length, task.id);
    }
  } finally {
    await context.close();
  }
});

test('ground truth: flights minimum over the 10:00-12:00 window is reproducible and differs from the grid minimum', async () => {
  const task = byId('flights-window-week');
  const context = await browser.newContext();
  const perDay = [];
  try {
    await runLongOracle(context, task, site.origin, {
      collect: async (page, hop) => {
        const head = await page.textContent('#results-head');
        if (!head.startsWith('All 8 departures')) return;
        const rows = await page.$$eval('#flights li', items => items.map(li => [...li.querySelectorAll('span')].map(s => s.textContent)));
        const window = rows.filter(([time]) => time >= '10:00' && time <= '12:00')
          .map(([time, flight, , price]) => ({ time, flight: flight.split(' ').slice(-2).join(' '), price: Number(price.replace('€', '')) }));
        window.sort((a, b) => a.price - b.price);
        perDay.push({ day: head.replace('All 8 departures on ', ''), hop, ...window[0] });
      },
    });
    const page = await context.newPage();
    await page.goto(`${site.origin}/long/flights/`);
    await page.click('#grid-btn');
    const gridMin = Math.min(...(await page.$$eval('#grid td', tds => tds.map(td => Number(td.textContent.replace('€', ''))))));
    assert.equal(gridMin, 38);
  } finally {
    await context.close();
  }
  assert.equal(perDay.length, 7);
  assert.deepEqual(perDay.map(d => d.flight), task.derivable);
  const best = [...perDay].sort((a, b) => a.price - b.price)[0];
  assert.deepEqual({ flight: best.flight, day: best.day, time: best.time, price: `€${best.price}` }, task.answerFacts);
});

test('ground truth: flights-live (both tasks) needs View more every day; without it the week minimum is a decoy', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const minutes = clock => {
    const [, h, m, ap] = /^(\d{1,2}):(\d{2}) (AM|PM)$/.exec(clock);
    return (Number(h) % 12 + (ap === 'PM' ? 12 : 0)) * 60 + Number(m);
  };
  const windowRows = page => page.$$eval('#results li.row', items => items.map(li => ({
    times: li.querySelector('.times').innerText.replace(/\s+/g, ' ').trim(),
    airline: li.querySelector('.air span').textContent,
    price: Number(li.querySelector('.price').textContent.replace('€', '')),
  })));
  try {
    for (const id of ['flights-live-form-arrows', 'flights-live-landing-calendar']) {
      const task = byId(id);
      const perDay = [];
      const collapsed = [];
      await runLongOracle(context, task, site.origin, {
        collect: async (page, hop) => {
          const control = task.oracle.actions[hop - 1]?.click;
          const pick = rows => rows.filter(row => {
            const dep = minutes(row.times.split(' – ')[0]);
            return dep >= 600 && dep <= 720;
          }).sort((a, b) => a.price - b.price)[0];
          if (control === '#more') {
            const day = /departing (\d{4}-\d{2}-\d{2})/.exec(await page.innerText('#results'))[1];
            perDay.push({ day, ...pick(await windowRows(page)) });
          } else if (task.oracle.actions[hop]?.click === '#more') {
            await page.waitForSelector('#more');
            collapsed.push(pick(await windowRows(page)));
          }
        },
      });
      assert.equal(perDay.length, 7, id);
      assert.deepEqual(perDay.map(d => d.times), task.derivable, id);
      assert.ok(perDay.every(d => d.airline === 'easyJet'), id);
      const best = [...perDay].sort((a, b) => a.price - b.price)[0];
      assert.deepEqual({ airline: best.airline, departure: best.times.split(' – ')[0], price: `€${best.price}` },
        { airline: task.answerFacts.airline, departure: task.answerFacts.departure, price: task.answerFacts.price }, id);
      // Without "View more flights" the week's minimum is another flight (Sat Vueling 10:15 AM, €76).
      const decoy = collapsed.sort((a, b) => a.price - b.price)[0];
      assert.equal(collapsed.length, 7, id);
      assert.deepEqual([decoy.airline, decoy.price], ['Vueling', 76], id);
    }
  } finally {
    await context.close();
  }
});

test('ground truth: the cheapest in-stock tent over all 13 catalog pages', async () => {
  const task = byId('catalog-cheapest-tent');
  const context = await browser.newContext();
  const tents = [];
  try {
    await runLongOracle(context, task, site.origin, {
      collect: async (page, hop) => {
        const rows = await page.$$eval('#rows tr', trs => trs.map(tr => [...tr.cells].map(td => td.textContent)));
        for (const [name, category, sku, price, stock] of rows) {
          if (category === 'Tents' && stock === 'In stock') tents.push({ name, sku, price: Number(price.replace('€', '')), page: hop + 1 });
        }
      },
    });
  } finally {
    await context.close();
  }
  assert.deepEqual(tents.map(t => t.name).sort(), [...task.derivable].sort());
  const best = tents.sort((a, b) => a.price - b.price)[0];
  assert.deepEqual({ product: best.name, sku: best.sku, price: `€${best.price}`, page: best.page }, task.answerFacts);
});

test('ground truth: the workspace fact sits on its hop, the docs leaf and the wizard reference need the right path', async () => {
  const context = await browser.newContext();
  try {
    const workspace = byId('workspace-deploy-token');
    let fact = null;
    await runLongOracle(context, workspace, site.origin, {
      collect: async (page, hop) => {
        if (hop === workspace.oracle.factAt.hop) fact = await page.innerText('main');
      },
    });
    assert.match(fact, /rollback token issued: RB-7Q2K/);
    assert.doesNotMatch(fact, /RB-7Q2X/);
    const docs = await runLongOracle(context, byId('docs-deep-timeout'), site.origin);
    assert.match(docs.text, /Timeout 2500 ms/);
    // A wizard run that leaves out one value never shows the reference.
    const wizard = structuredClone(byId('wizard-shipping-draft'));
    wizard.suppliedText.city = ' ';
    const partial = await runLongOracle(context, wizard, site.origin, { timeoutMs: 1500 }).catch(error => ({ error }));
    assert.ok(partial.error || !partial.text.includes('DR-1GBZTRB'));
    const page = await context.newPage();
    await page.goto(`${site.origin}/long/wizard/step-1.html`);
    await page.click('#next');
    assert.match(await page.textContent('#err'), /Please fill in: Full name, Email/);
  } finally {
    await context.close();
  }
});

// ------------------------------------------------------------------------------------------------ route

test('route: marks are met in order, by exact path or by text', () => {
  const route = [{ hop: 1, path: '/long/docs/platform/' }, { hop: 2, text: 'Networking overview' }, { hop: 3, path: '/long/docs/x.html' }];
  assert.equal(markMatches(route[0], { url: 'http://h/long/docs/platform/index.html' }), true);
  assert.equal(markMatches(route[0], { url: 'http://h/long/docs/platform/networking/' }), false);
  const obs = [{ url: 'http://h/long/docs/', text: '' }, { url: 'http://h/long/docs/platform/', text: '' }, { url: 'http://h/long/docs/y', text: 'Networking overview' }];
  assert.deepEqual(routeProgress(route, obs), { reached: 2, hop: 2, next: route[2] });
  // A later mark seen before an earlier one does not count.
  assert.equal(routeProgress(route, [obs[2], obs[1]]).reached, 1);
  assert.deepEqual(traceObservations({ steps: [{ observation: { url: 'u1', title: 't', textExcerpt: 'x' } }], finalObservation: { url: 'u2', title: 'T', text: 'y' } }),
    [{ url: 'u1', text: 't\nx' }, { url: 'u2', text: 'T\ny' }]);
});

// ------------------------------------------------------------------------------------------------ breaks

const receipt = (status, code, extra = {}) => ({ status, code, verification: { passed: status === 'completed' }, verdict: { why: [code] }, next: { kind: extra.nextKind ?? 'rerun' }, ...extra });

test('breaks: the taxonomy maps receipts, host stops and answers to one class', () => {
  const offered = { url: 'u', controls: [{ label: 'Show 4 more flights' }, { label: 'Tue 13 Oct' }] };
  const handoff = { calls: [{ receipt: receipt('needs_host', 'handoff'), finalObservation: offered }], nextControl: 'Tue 13 Oct', answer: { ok: false } };
  assert.equal(classifyBreak(handoff).class, 'provider_handoff_on_offered_control');
  assert.equal(classifyBreak({ ...handoff, nextControl: 'Wed 14 Oct' }).class, 'other');
  assert.equal(classifyBreak({ ...handoff, nextControl: 'Wed 14 Oct' }).detail, 'handoff_control_not_offered');
  const one = (status, code, extra) => classifyBreak({ calls: [{ receipt: receipt(status, code, extra) }], answer: { ok: false } }).class;
  assert.equal(one('needs_host', 'low_confidence'), 'low_confidence');
  assert.equal(one('needs_host', 'no_progress'), 'no_progress');
  assert.equal(one('needs_host', 'stale'), 'stale_loop');
  assert.equal(one('unverified', 'expectation_mismatch'), 'expectation_mismatch');
  assert.equal(one('budget_exhausted', 'action_budget'), 'cap_actions');
  assert.equal(one('budget_exhausted', 'time_budget'), 'cap_time');
  assert.equal(one('needs_user', 'refused_action'), 'consent/login/blocked');
  assert.equal(one('needs_host', 'something', { nextKind: 'split' }), 'cap_steps');
  const passed = { calls: [{ receipt: receipt('completed', 'expectation_passed') }], complete: true };
  assert.equal(classifyBreak({ ...passed, answer: { ok: true } }), null);
  assert.equal(classifyBreak({ ...passed, answer: { ok: false, auto: true } }).class, 'wrong_answer');
  assert.equal(classifyBreak({ ...passed, answer: { ok: false, auto: false } }).class, 'unreadable_region');
  assert.equal(classifyBreak({ calls: passed.calls, hostStop: 'cap_calls', answer: { ok: false } }).class, 'cap_calls');
  for (const cls of ['cap_calls', 'cap_time', 'wrong_answer', 'unreadable_region', 'other']) assert.ok(BREAK_CLASSES.includes(cls));
});

test('caps: steps, maxActions, call budget and the 45 s window are reported', () => {
  const task = byId('catalog-cheapest-tent');
  const b = budgetHits(task, { condition: 'b', calls: [{ receipt: receipt('completed', 'expectation_passed'), waits: 1 }], hostStop: 'cap_calls' });
  assert.equal(b.steps, false, '13 steps fit one list (MAX_STEPS 15)');
  const long = { ...task, steps: [...task.steps, ...task.steps.slice(0, 3)] };
  assert.equal(budgetHits(long, { condition: 'b', calls: [] }).steps, true, '16 steps need two lists');
  assert.equal(b.maxCalls, true);
  assert.equal(b.wait45, 1);
  const a = budgetHits(byId('wizard-shipping-draft'), { condition: 'a', calls: [{ receipt: receipt('budget_exhausted', 'action_budget'), waits: 0 }] });
  assert.equal(a.maxActions, true);
  assert.equal(a.steps, false);
});

// ------------------------------------------------------------------------------------------------ answers

test('answers: an aggregate needs every derivable fact or an auto answer naming the result', () => {
  const task = byId('flights-window-week');
  const digest = facts => ({ status: 'completed', page: { digest: facts } });
  assert.equal(gradeAnswer(task, [digest(['EZ 4412 €74'])]).ok, false);
  assert.equal(gradeAnswer(task, [digest(task.derivable.map(f => `${f} €60`))]).ok, true);
  assert.equal(gradeAnswer(task, [{ status: 'completed', verdict: { answer: { text: 'VY 7713 on Thu 15 Oct at 10:55, €61' } } }]).auto, true);
  const docs = byId('docs-deep-timeout');
  assert.equal(gradeAnswer(docs, [{ verdict: { answer: { text: '5000 ms' } } }]).ok, false);
  assert.equal(gradeAnswer(docs, [{ stepResults: [{ i: 5, answer: { text: '2500 ms' } }] }]).ok, true);
  assert.equal(gradeAnswer(docs, [{ page: { digest: ['Timeout 2500 ms'] } }]).ok, true);
});

test('host: choose picks the option matching the step, supply values come from the step answer', () => {
  const options = [{ id: 'a1', label: 'Health checks (legacy)' }, { id: 'a2', label: 'Sticky sessions' }];
  assert.equal(pickOption(options, 'Click "More load balancing topics", then Health checks')?.id, 'a1');
  assert.equal(pickOption(options, 'Click Logs'), null);
  const steps = [{ instruction: 'Open {{supply:1}}', expectation: { textIncludes: 'x' } }];
  assert.deepEqual(supplyValues(steps, { stepResults: [{ i: 1, candidates: [{ text: 'Keel' }] }] }), [{ instruction: 'Open Keel', expectation: { textIncludes: 'x' } }]);
  assert.equal(supplyValues(steps, { stepResults: [] }), null);
});

test('grade and report: a record rolls up into the markdown table', () => {
  const task = byId('docs-deep-timeout');
  const origin = 'http://127.0.0.1:1';
  const t = materialize(task, origin);
  const call = {
    receipt: { status: 'completed', code: 'expectation_passed', verification: { passed: true }, verdict: { why: [] }, next: { kind: 'answer' },
      stepResults: t.steps.map((s, i) => ({ i: i + 1, status: 'completed', passed: true, ...(s.answerQuestion ? { answer: { text: '2500 ms' } } : {}) })) },
    ms: 9000, waits: 0, hops: 12, jevRequests: 14, jevMs: [250, 270],
    observations: t.route.map(m => ({ url: `${origin}${m.path}`, text: '' })),
  };
  const rec = { task: task.id, family: task.family, condition: 'b', hops: task.hops, calls: [call], complete: true, hostStop: 'done', beacons: [] };
  rec.grade = gradeRecord(task, rec, origin);
  assert.equal(rec.grade.success, true);
  assert.equal(rec.grade.progressHop, 12);
  assert.equal(rec.grade.hopsBeforeBreak, 12);
  assert.equal(rec.grade.break, null);
  const md = reportMarkdown(summarizeLong([rec], { provider: 'test', repeat: 1 }));
  assert.match(md, /\| docs-deep-timeout \| b \| 1 \| 1 \| 1 \| 1 \| 12 \/ 12 \| 12 \|/);
});
