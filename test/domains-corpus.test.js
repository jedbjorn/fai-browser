// Site profiles, the safety property on real pages: every action the fast path proposes is one the guardrail code
// offers for that page and level (one of legalActions' own entries: there are no URL edges), of the fast class (a
// link with a real href observed on the page), never a button, select, fill, submit or host-supplied URL.
// Checked over every QA corpus page (fixtures/qa, observed by extension/page.js in headless Chromium) at every level,
// with the QA fixture profile driven by every task expectation and with greedy profiles: one edge per control (buttons,
// selects and fields included) with that control's label and destination.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { chromium } from 'playwright-core';
import { headlessEnv } from '../scripts/headless-env.mjs';
import { startQaSite } from '../bench/qa/serve.mjs';
import { loadSuite, materialize } from '../bench/qa/lib.mjs';
import { SiteRun, compileProfile, fastClass } from '../src/domains.js';
import { actionKey, legalActions } from '../src/runtime.js';
import { CAPABILITIES, LEVELS, commitCandidate, guardrailPolicy } from '../src/guardrails.js';

const ROOT = new URL('..', import.meta.url).pathname;
const FIXTURES = join(ROOT, 'fixtures', 'qa');
const PAGE_SCRIPT = await readFile(join(ROOT, 'extension', 'page.js'), 'utf8');

async function htmlFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await htmlFiles(path));
    else if (entry.name.endsWith('.html')) out.push(path);
  }
  return out;
}

const TEMPLATE_SAFE = /^\/[A-Za-z0-9._~@:%+\-/?&=]*$/;

/**
 * Greedy profiles for one observation: for every control (links, buttons, selects, fields), an edge from this page to a
 * middle page whose label is the control's label and whose href is the control's destination (or a one-segment
 * placeholder for a control without one), so whatever the fast path could pick here is tried.
 */
function greedyProfiles(origin, observation) {
  const here = new URL(observation.url);
  const herePath = `${here.pathname}${here.search}`;
  const title = String(observation.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (!TEMPLATE_SAFE.test(herePath) || herePath.includes('?*') || !title) return [];
  const profiles = [];
  const seen = new Set();
  for (const control of observation.controls ?? []) {
    const label = String(control.label ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
    let href = '/{x}';
    if (control.href) {
      try {
        const url = new URL(control.href, observation.url);
        if (url.origin === origin && TEMPLATE_SAFE.test(`${url.pathname}${url.search}`)) href = `${url.pathname}${url.search}`;
      } catch {
        // keep the placeholder
      }
    }
    const key = `${label}\u0000${href}`;
    if (!label || seen.has(key)) continue;
    seen.add(key);
    try {
      profiles.push(compileProfile({
        schema: 1, id: 'greedy', version: 1, origins: [origin],
        pageTypes: {
          here: { label: 'this page', url: herePath, checks: [{ title }] },
          middle: { label: 'middle page', url: '/middle', checks: [{ title: 'x' }] },
          goal: { label: 'goal page', url: '/goal', checks: [{ title: 'x' }], expect: ['/goal'] },
        },
        edges: [
          { id: 'here->middle', from: 'here', to: 'middle', link: { label, href } },
          { id: 'middle->goal', from: 'middle', to: 'goal', link: { href: '/goal' } },
        ],
      }));
    } catch {
      // A label or path outside the profile grammar simply gets no greedy profile.
    }
  }
  return profiles;
}

let browser;
let site;
test.before(async () => {
  site = await startQaSite();
  try {
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, env: headlessEnv(), args: ['--no-sandbox'],
    });
  } catch {
    browser = null;
  }
});
test.after(async () => {
  await browser?.close();
  await site?.close();
});

test('every fast-path action is one the guardrails offer, across QA corpus pages and all levels', async t => {
  if (!browser) return t.skip('no Chromium');
  const origin = site.origin;
  const suite = loadSuite();
  const template = (await readFile(join(ROOT, 'domains', '_templates', 'qa-fixture.json'), 'utf8')).replaceAll('{{ORIGIN}}', origin);
  const fixture = compileProfile(JSON.parse(template));
  const expectations = [...new Map(suite.tasks.filter(task => task.expectation)
    .map(task => [JSON.stringify(task.expectation), task.expectation])).values()];
  const paths = new Set((await htmlFiles(FIXTURES)).map(file => `/${relative(FIXTURES, file)}`));
  for (const task of suite.tasks) paths.add(new URL(materialize(task, origin).start).pathname);

  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  t.after(() => page.close());
  let checked = 0;
  let fixtureSteps = 0;
  let greedySteps = 0;
  const kinds = new Set();
  for (const path of [...paths].sort()) {
    try {
      await page.goto(`${origin}${path}`, { waitUntil: 'load', timeout: 10_000 });
    } catch {
      continue;
    }
    for (const level of LEVELS) {
      await page.evaluate(PAGE_SCRIPT);
      const observation = await page.evaluate(allow => globalThis.__faiPage.observe({ allow }), [...CAPABILITIES[level]]);
      const config = { mode: level, allowedOrigins: [origin], guardrails: guardrailPolicy({ mode: level }) };
      const offered = legalActions(observation, config);
      const check = (fast, what) => {
        if (!fast) return false;
        checked++;
        const { action } = fast;
        const where = `${path} ${level} ${what}: ${JSON.stringify(action)}`;
        assert.ok(fastClass(action), where);
        assert.ok(!commitCandidate(action), where);
        assert.ok(['click', 'navigate_allowed_url'].includes(action.type), where);
        // Admission is checked against the offered set itself (the fast path has no other source of actions).
        assert.ok(offered.includes(action), `not offered: ${where}`);
        const match = offered.find(candidate => actionKey(candidate) === actionKey(action));
        assert.deepEqual(match, action, where);
        const destination = new URL(action.type === 'click' ? action.href : action.url, observation.url);
        assert.equal(destination.origin, origin, where);
        if (action.type === 'click') assert.equal(action.role, 'link', where);
        else assert.equal(action.newTab, true, where);
        kinds.add(action.type);
        return true;
      };
      for (const expectation of expectations) {
        if (check(new SiteRun([fixture], { expectation }).next(observation, offered), `fixture ${JSON.stringify(expectation)}`)) fixtureSteps++;
      }
      for (const profile of greedyProfiles(origin, observation)) {
        if (check(new SiteRun([profile], { expectation: { urlIncludes: '/goal' } }).next(observation, offered), profile.edges[0].link.href.template)) greedySteps++;
      }
    }
  }
  // Not vacuous: the fixture profile and the greedy profiles proposed real steps of both kinds.
  assert.ok(fixtureSteps >= 20, `fixture fast steps ${fixtureSteps}`);
  assert.ok(greedySteps >= 200, `greedy fast steps ${greedySteps}`);
  assert.ok(kinds.has('click'));
  t.diagnostic(`${paths.size} pages x ${LEVELS.length} levels: ${checked} fast actions checked (${fixtureSteps} fixture, ${greedySteps} greedy)`);
});
