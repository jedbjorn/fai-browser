// page.js and domain roots (headless Chromium): a link or allowed URL may leave the page's origin only for another https
// page under a root the worker passed in `sites` that also covers the page; without `sites` (exact origins) every
// cross-origin link is refused as before, and another domain, http or a non-default port always is.
import test from 'node:test';
import { headlessEnv } from '../scripts/headless-env.mjs';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

let browser;
test.before(async () => {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    headless: true, env: headlessEnv(), args: ['--no-sandbox'] });
});
test.after(() => browser?.close());

const HOME = `<!doctype html><title>Docs</title><h1>Docs</h1>
<a href="https://www.example.org/team">Team</a>
<a href="https://example.net/x">Elsewhere</a>
<a href="http://www.example.org/old">Plain http</a>
<a href="https://www.example.org:8443/alt">Other port</a>
<a href="/guide">Guide</a>`;

async function open(t) {
  const page = await browser.newPage();
  t.after(() => page.close());
  for (const origin of ['https://developer.example.org', 'https://www.example.org', 'https://example.net']) {
    await page.route(`${origin}/**`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Page</title><h1>Page</h1>' }));
  }
  await page.route('https://developer.example.org/', route => route.fulfill({ contentType: 'text/html', body: HOME }));
  await page.goto('https://developer.example.org/');
  await page.addScriptTag({ path: new URL('../extension/page.js', import.meta.url).pathname });
  return page;
}

// Observes with `sites`, then dispatches a click on the link labelled `label`; returns the error code or 'ok'.
async function click(page, label, sites) {
  return page.evaluate(async ([label, sites]) => {
    const observation = __faiPage.observe({ sites });
    const control = observation.controls.find(item => item.label === label);
    try {
      await __faiPage.execute({ type: 'click', target: control.id }, observation.revision, { quietMs: 10, capMs: 50 },
        undefined, undefined, undefined, sites);
      return 'ok';
    } catch (error) {
      return error.code;
    }
  }, [label, sites]);
}

test('a sibling-subdomain link is dispatched only with the approved root', async t => {
  assert.equal(await click(await open(t), 'Team', []), 'cross_origin', 'exact origins: refused as before');
  assert.equal(await click(await open(t), 'Team', ['example.org']), 'ok');
});

test('another domain, http and a non-default port stay refused under the root', async t => {
  for (const label of ['Elsewhere', 'Plain http', 'Other port']) {
    assert.equal(await click(await open(t), label, ['example.org']), 'cross_origin', label);
  }
  assert.equal(await click(await open(t), 'Team', ['other.test']), 'cross_origin', 'a root that does not cover the page');
  assert.equal(await click(await open(t), 'Team', ['org']), 'cross_origin', 'a malformed root is ignored');
  assert.equal(await click(await open(t), 'Guide', []), 'ok', 'same-origin links are unchanged');
});

test('navigate_allowed_url follows the same rule', async t => {
  const page = await open(t);
  const result = await page.evaluate(async () => {
    const outcome = {};
    for (const [name, url, sites] of [['outside', 'https://example.net/x', ['example.org']],
      ['exact', 'https://www.example.org/team', []]]) {
      const observation = __faiPage.observe({ sites });
      try {
        await __faiPage.execute({ type: 'navigate_allowed_url', url }, observation.revision, { quietMs: 10, capMs: 50 },
          undefined, undefined, ['navigate'], sites);
        outcome[name] = 'ok';
      } catch (error) {
        outcome[name] = error.code;
      }
    }
    return outcome;
  });
  assert.deepEqual(result, { outside: 'cross_origin', exact: 'cross_origin' });
  const inside = await open(t);
  const ok = await inside.evaluate(async () => {
    const observation = __faiPage.observe({ sites: ['example.org'] });
    const dispatched = await __faiPage.execute({ type: 'navigate_allowed_url', url: 'https://www.example.org/team' },
      observation.revision, { quietMs: 10, capMs: 50 }, undefined, undefined, ['navigate'], ['example.org']);
    return dispatched.expectNavigation;
  });
  assert.equal(ok, true);
});
