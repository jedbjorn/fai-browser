import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { headlessEnv } from '../scripts/headless-env.mjs';
import { instructionTerms } from '../src/oversight.js';

let browser;
test.before(async () => {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true,
    env: headlessEnv(), args: ['--no-sandbox'] });
});
test.after(() => browser?.close());
const cookie = (choice = '<button type="button" data-choice>Reject all</button>', extra = '') => `<div id="onetrust-banner-sdk" style="position:fixed;inset:0;background:white;z-index:20"><p>We use cookies and optional tracking.</p>${choice}<button type="button">Accept all</button>${extra}</div>`;
const newsletter = (close = '<button type="button" data-close>Close</button>', field = '<input aria-label="Email" type="email">') => `<div role="dialog" aria-modal="true" id="newsletter" style="position:fixed;inset:0;background:white;z-index:10"><h2>Subscribe to our newsletter</h2>${field}<button type="button">Subscribe</button>${close}</div>`;
async function open(t, body) {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  t.after(() => page.close());
  await page.route('https://popups.test/**', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><body>${body}` }));
  await page.goto('https://popups.test/');
  await page.addScriptTag({ path: new URL('../extension/input.js', import.meta.url).pathname });
  await page.addScriptTag({ path: new URL('../extension/page.js', import.meta.url).pathname });
  await page.evaluate(() => {
    window.presses = 0; window.clicked = []; window.profiles = [];
    document.addEventListener('pointerdown', () => window.presses++);
    document.addEventListener('click', e => window.clicked.push(e.target.textContent));
    document.querySelector('[data-choice]')?.addEventListener('click', () => document.querySelector('#onetrust-banner-sdk')?.remove());
    document.querySelector('[data-close]')?.addEventListener('click', () => document.querySelector('#newsletter')?.remove());
    const click = __faiInput.click;
    __faiInput.click = (el, options) => { profiles.push(options.explicitClick); return click(el, options); };
  });
  return page;
}
const clear = (page, overrides = {}) => page.evaluate(options => __faiPage.clearNuisances({ enabled: true, remaining: 2,
  deadline: Date.now() + 2000, terms: ['find', 'hotels'], allow: ['navigate'], ...options }), overrides);

test('new narrow Use policy rejects optional cookies with link pacing and fresh revision', async t => {
  const page = await open(t, `<button type="button">Ordinary action</button>${cookie()}`);
  const before = await page.evaluate(() => __faiPage.observe({ allow: ['navigate'] }));
  const result = await clear(page);
  assert.equal(result.attempted, 1);
  assert.equal(result.automatic[0].operation, 'cookies_necessary');
  assert.equal(result.automatic[0].outcome, 'dismissed');
  assert.notEqual(result.observation.revision, before.revision);
  assert.deepEqual(await page.evaluate(() => [presses, profiles]), [1, [true]]);
  const code = await page.evaluate(async () => {
    const o = __faiPage.observe({ allow: ['navigate'] });
    try { await __faiPage.execute({ type: 'click', target: o.controls[0].id }, o.revision, { quietMs: 1, capMs: 50 }); }
    catch (error) { return error.code; }
  });
  assert.equal(code, 'blocked_risky');
});
test('explicit necessary-only is eligible; a cookie X, settings, selected consent and conflicting names are not', async t => {
  for (const label of ['Necessary cookies only', 'Accept only necessary cookies', 'Tout refuser']) {
    const page = await open(t, cookie(`<button type="button" data-choice>${label}</button>`));
    assert.equal((await clear(page)).automatic[0]?.outcome, 'dismissed', label);
  }
  for (const choice of ['<button>X</button>', '<button>Settings</button>', '<button>Accept selected</button>', '<button>Save preferences</button>',
    '<button aria-label="Reject all">Accept all</button>', '<button>Reject all and subscribe</button>']) {
    const page = await open(t, cookie(choice));
    const result = await clear(page);
    assert.equal(result.attempted, 0, choice);
    assert.equal(result.nuisancePending[0].reason, 'no_clear_cookie_choice');
    assert.equal(await page.evaluate(() => presses), 0);
  }
});
test('cookies are processed before a newsletter under one two-action budget', async t => {
  const page = await open(t, `${newsletter()}${cookie()}`);
  const result = await clear(page);
  assert.deepEqual(result.automatic.map(item => [item.operation, item.outcome]), [['cookies_necessary', 'dismissed'], ['newsletter_dismiss', 'dismissed']]);
  assert.equal(result.attempted, 2);
  assert.deepEqual(await page.evaluate(() => profiles), [true, true]);
});
test('filled, task-related, unknown-intent and form-submitting newsletter modals stay', async t => {
  for (const [body, options, reason] of [
    [newsletter(undefined, '<input type="email" value="person@example.test">'), {}, 'entered_data'],
    [newsletter(), { terms: ['subscribe', 'newsletter'] }, 'task_related'],
    [newsletter(), { terms: [] }, 'unknown_task'],
    [newsletter('<form><button data-close>Close</button></form>'), {}, 'no_clear_newsletter_close'],
    [newsletter('<form><button type="reset" data-close>Close</button></form>'), {}, 'no_clear_newsletter_close'],
  ]) {
    const page = await open(t, body);
    const result = await clear(page, options);
    assert.equal(result.attempted, 0);
    assert.equal(result.nuisancePending[0]?.reason, reason);
    assert.equal(await page.evaluate(() => presses), 0);
  }
});
test('an agent-opened same-document newsletter is preserved', async t => {
  const page = await open(t, `<button type="button" id="open">Show options</button><div id="holder" hidden>${newsletter()}</div>`);
  await page.evaluate(() => document.querySelector('#open').onclick = () => document.querySelector('#holder').hidden = false);
  await page.evaluate(async () => {
    const o = __faiPage.observe({ allow: ['navigate', 'controls'] });
    await __faiPage.execute({ type: 'click', target: o.controls.find(c => c.label === 'Show options').id }, o.revision, { quietMs: 1, capMs: 50 });
  });
  const result = await clear(page);
  assert.equal(result.attempted, 0);
  assert.equal(result.nuisancePending[0]?.reason, 'agent_interaction');
});
test('embedded newsletter and unrelated blocking dialogs are never auto-dismissed', async t => {
  for (const body of ['<section>Subscribe to our newsletter<input><button>Close</button></section>',
    '<dialog open><p>Sign in to your account</p><button>Close</button></dialog>',
    '<div role="dialog" aria-modal="true" style="position:fixed;inset:0">Sign in to your account. Subscribe to our newsletter<input type="password"><button type="button">Close</button></div>',
    '<div role="dialog" aria-modal="true" style="position:fixed;inset:0">Save changes?<button>Close</button></div>']) {
    const page = await open(t, body);
    assert.equal((await clear(page)).attempted, 0);
  }
});
test('no-op and remounted identical popups are not retried', async t => {
  const body = cookie('<button type="button" id="reject">Reject all</button>');
  const page = await open(t, body);
  const first = await clear(page);
  assert.equal(first.automatic[0].outcome, 'unchanged');
  assert.equal(first.attempted, 1);
  await page.evaluate(body => document.body.innerHTML = body, body);
  const second = await clear(page);
  assert.equal(second.attempted, 0);
  assert.equal(second.nuisancePending[0].reason, 'already_attempted');
  assert.equal(await page.evaluate(() => presses), 1);
});
test('missing policy, expired deadline and disabled pacing never press', async t => {
  for (const options of [{ enabled: false }, { deadline: 1 }, { remaining: 0 }]) {
    const page = await open(t, cookie());
    assert.equal((await clear(page, options)).attempted, 0);
    assert.equal(await page.evaluate(() => presses), 0);
  }
  const page = await open(t, cookie());
  await page.evaluate(() => __faiInput.configure({ enabled: false }));
  assert.equal((await clear(page)).nuisancePending[0].reason, 'pacing_unavailable');
});
test('popup relabel or coverage during motion refuses before pressing; no other button is tried', async t => {
  for (const mutation of ['label', 'cover']) {
    const page = await open(t, cookie());
    await page.evaluate(mutation => document.addEventListener('pointermove', () => {
      if (mutation === 'label') document.querySelector('[data-choice]').textContent = 'Accept all';
      else { const cover = document.createElement('div'); cover.style = 'position:fixed;inset:0;background:white;z-index:100'; document.body.append(cover); }
    }, { once: true }), mutation);
    const result = await clear(page);
    assert.equal(result.attempted, 1);
    assert.equal(result.automatic[0].outcome, 'unavailable');
    assert.equal(await page.evaluate(() => presses), 0);
  }
});
test('forbidden labels, hidden pacing failure, and forged action flags cannot expand narrow scope', async t => {
  const forbidden = await open(t, cookie());
  assert.equal((await clear(forbidden, { forbid: ['Reject all'] })).nuisancePending[0].reason, 'guardrail');
  assert.equal(await forbidden.evaluate(() => presses), 0);
  const hidden = await open(t, cookie());
  await hidden.evaluate(() => Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }));
  const result = await clear(hidden);
  assert.equal(result.automatic[0].outcome, 'unavailable');
  assert.equal(await hidden.evaluate(() => presses), 0);
  const forged = await open(t, '<button type="button">Ordinary action</button>');
  const code = await forged.evaluate(async () => {
    const o = __faiPage.observe({ allow: ['navigate'] });
    try { await __faiPage.execute({ type: 'click', target: o.controls[0].id, automaticNuisance: true }, o.revision, { quietMs: 1, capMs: 50 }); }
    catch (error) { return error.code; }
  });
  assert.equal(code, 'blocked_risky');
});
test('per-document maximum is two automatic attempts across separate stages', async t => {
  const page = await open(t, cookie());
  assert.equal((await clear(page, { remaining: 1 })).attempted, 1);
  for (const [label, expected] of [['Necessary cookies only', 1], ['Decline all cookies', 0]]) {
    await page.evaluate(body => {
      document.body.innerHTML = body;
      document.querySelector('[data-choice]').onclick = () => document.querySelector('#onetrust-banner-sdk').remove();
    }, cookie(`<button type="button" data-choice>${label}</button>`));
    const result = await clear(page);
    assert.equal(result.attempted, expected);
    if (!expected) assert.equal(result.nuisancePending[0].reason, 'attempt_limit');
  }
});
test('same-origin cookie frames use parent hit checks; unmodelled newsletter frames defer', async t => {
  const page = await open(t, '<iframe style="width:700px;height:400px;border:0"></iframe>');
  await page.evaluate(body => document.querySelector('iframe').srcdoc = body, cookie());
  await page.frameLocator('iframe').locator('[data-choice]').waitFor();
  await page.frames()[1].evaluate(() => {
    document.querySelector('[data-choice]').onclick = () => document.querySelector('#onetrust-banner-sdk').remove();
  });
  assert.equal((await clear(page)).automatic[0]?.outcome, 'dismissed');
  const covered = await open(t, '<div style="position:relative"><iframe style="width:700px;height:400px;border:0"></iframe><div style="position:absolute;inset:0;background:white"></div></div>');
  await covered.evaluate(body => document.querySelector('iframe').srcdoc = body, cookie());
  await covered.frameLocator('iframe').locator('[data-choice]').waitFor();
  assert.equal((await clear(covered)).attempted, 0);
  const news = await open(t, '<iframe style="width:700px;height:400px;border:0"></iframe>');
  await news.evaluate(body => document.querySelector('iframe').srcdoc = body, newsletter());
  await news.frameLocator('iframe').locator('#newsletter').waitFor();
  const result = await clear(news);
  assert.equal(result.attempted, 0);
  assert.equal(result.nuisancePending[0]?.reason, 'frame_unsupported');
});

test('newsletter autofill during the final asynchronous point check invalidates the private proof', async t => {
  const page = await open(t, newsletter());
  await page.evaluate(() => {
    window.pointChecks = 0;
    window.chrome = { runtime: { id: 'fixture', sendMessage: async message => {
      if (message.kind === 'fai-click-delay') {
        await new Promise(resolve => setTimeout(resolve, message.ms));
        return { ok: true, paced: true };
      }
      if (message.kind === 'fai.framePoint') {
        if (++pointChecks === 3) document.querySelector('input').value = 'autofilled@example.test';
        return { ok: true, valid: true };
      }
      throw new Error('Unexpected fixture message');
    } } };
  });
  const result = await clear(page);
  assert.equal(result.automatic[0]?.outcome, 'unavailable');
  assert.deepEqual(await page.evaluate(() => [pointChecks, presses, document.querySelector('input')?.value]),
    [3, 0, 'autofilled@example.test']);
  assert.equal(await page.locator('#newsletter').count(), 1);
});

test('automatic cookie choices defer native form submission while the manual reject exception stays unchanged', async t => {
  const page = await open(t, '<form id="cookie-banner" style="position:fixed;inset:0;background:white"><p>We use cookies</p><input name="account" value="kept"><button>Reject all</button><button type="button">Accept all</button></form>');
  await page.evaluate(() => {
    window.submits = 0;
    document.addEventListener('submit', event => { submits++; event.preventDefault(); });
  });
  const result = await clear(page);
  assert.equal(result.attempted, 0);
  assert.equal(result.nuisancePending[0]?.reason, 'no_clear_cookie_choice');
  assert.deepEqual(await page.evaluate(() => [presses, submits, document.querySelector('input').value]), [0, 0, 'kept']);
  await page.evaluate(async () => {
    const observation = __faiPage.observe({ allow: ['navigate'] });
    const target = observation.controls.find(control => control.label === 'Reject all').id;
    await __faiPage.execute({ type: 'click', target }, observation.revision, { quietMs: 1, capMs: 50 }, [], [], ['navigate']);
  });
  assert.equal(await page.evaluate(() => submits), 1);
});

test('mixed paid subscription, account and promotional dialogs remain for the agent', async t => {
  for (const text of ['Subscribe to premium for $10/month to read this article.',
    'Register for membership to unlock exclusive content.', 'Spin to win a 20% discount. Get your coupon.',
    'Subscribe for 10 EUR per month.']) {
    const page = await open(t, newsletter(undefined, `<p>${text}</p><input type="email">`));
    const result = await clear(page);
    assert.equal(result.attempted, 0, text);
    assert.equal(result.nuisancePending[0]?.reason, 'other_dialog', text);
    assert.equal(await page.evaluate(() => presses), 0);
  }
  const pure = await open(t, newsletter().replace('Subscribe to our newsletter', 'Sign up for our newsletter'));
  assert.equal((await clear(pure)).automatic[0]?.outcome, 'dismissed', 'an explicit newsletter-only invitation is eligible');
});

test('real tokenized signup and digest task intent preserves newsletter dialogs', async t => {
  const terms = instructionTerms('Sign me up for the weekly digest');
  assert.ok(terms.includes('sign') && terms.includes('digest'));
  const page = await open(t, newsletter());
  const result = await clear(page, { terms });
  assert.equal(result.attempted, 0);
  assert.equal(result.nuisancePending[0]?.reason, 'task_related');
  assert.equal(await page.evaluate(() => presses), 0);
});

test('CSS-hidden entered fields and open shadow fields preserve newsletters; transport fields do not', async t => {
  for (const field of ['<input type="email" style="display:none" value="entered@example.test">',
    '<input type="email" style="visibility:hidden" value="entered@example.test">', '<span id="shadow-field"></span>']) {
    const page = await open(t, newsletter(undefined, field));
    if (field.includes('shadow-field')) await page.evaluate(() => {
      document.getElementById('shadow-field').attachShadow({ mode: 'open' }).innerHTML = '<input type="email" style="display:none" value="entered@example.test">';
    });
    const result = await clear(page);
    assert.equal(result.attempted, 0, field);
    assert.equal(result.nuisancePending[0]?.reason, 'entered_data', field);
    assert.equal(await page.evaluate(() => presses), 0);
  }
  const transport = await open(t, newsletter(undefined, '<input type="hidden" value="transport-token"><input type="email">'));
  assert.equal((await clear(transport)).automatic[0]?.outcome, 'dismissed');
});

test('an aria-modal attribute alone does not make an in-flow newsletter a blocking popup', async t => {
  const page = await open(t, `<article><p>Article before.</p>${newsletter().replace('position:fixed;inset:0;background:white;z-index:10', 'width:700px;height:150px;background:#eee')}<p>Article after.</p></article>`);
  const result = await clear(page);
  assert.equal(result.attempted, 0);
  assert.equal(result.nuisancePending[0]?.reason, 'not_blocking');
  assert.equal(await page.evaluate(() => presses), 0);
});

test('automatic text and field inspections fail closed when their bounds are exhausted', async t => {
  const filler = 'Readers get regular updates about our editorial work. '.repeat(32);
  const page = await open(t, newsletter(undefined, `<p style="height:10px;overflow:hidden">${filler}</p><p>Create your account</p><input type="email">`));
  const result = await clear(page);
  assert.equal(result.attempted, 0);
  assert.equal(result.nuisancePending[0]?.reason, 'inspection_limit');
  assert.equal(await page.evaluate(() => presses), 0);
  const fields = await open(t, newsletter(undefined, `${'<span></span>'.repeat(2100)}<input type="email" value="entered@example.test">`));
  const bounded = await clear(fields);
  assert.equal(bounded.attempted, 0);
  assert.equal(bounded.nuisancePending[0]?.reason, 'inspection_limit');
  assert.equal(await fields.evaluate(() => presses), 0);
});
