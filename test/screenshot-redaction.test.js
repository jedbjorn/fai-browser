// Screenshot redaction on the fixtures/secrets pages in headless Chromium: every fake secret is painted pure #00ff00,
// the frame goes through extension/page.js (boxes), a viewport capture and extension/offscreen.js (fill, encode), and
// the decoded JPEG must show (almost) no green pixel while every painted secret's box is solid dark. The race cases
// insert a key between the box query and the capture: the frame is covered or withheld, never raw.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { headlessEnv } from '../scripts/headless-env.mjs';
import { loadFakes } from './helpers/secret-fakes.js';
import { startStaticSite } from './helpers/static-site.js';
import { captureRedacted, paintSecrets, paintedBoxes, pixelReport, startOffscreen } from './helpers/redacted-capture.js';

const PAGE_SCRIPT = new URL('../extension/page.js', import.meta.url).pathname;
const F = loadFakes();
// Every fake value as shown on a page (the PEM line by line; recovery codes one by one).
const VALUES = Object.entries(F).flatMap(([name, value]) => (name === 'pem' ? [] : Array.isArray(value) ? value : [value]));
// A few pixels of JPEG ringing at a box edge may read as green; a leaked secret is hundreds.
const EPSILON = 25;

let site;
let browser;
let offscreen;
test.before(async () => {
  site = await startStaticSite(new URL('../fixtures/secrets/', import.meta.url).pathname);
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true,
    env: headlessEnv(), args: ['--no-sandbox'] });
  offscreen = await startOffscreen(browser);
});
test.after(async () => {
  await offscreen?.close();
  await browser?.close();
  await site?.close();
});

async function open(t, path, { secrets = {}, before } = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  t.after(() => page.close());
  await before?.(page);
  await page.goto(site.origin + path);
  await page.waitForTimeout(150);
  await paintSecrets(page, VALUES);
  await page.addScriptTag({ path: PAGE_SCRIPT });
  await page.evaluate(settings => globalThis.__faiPage.useSecrets(settings), { mode: 'standard', relaxed: [], salt: 's', ...secrets });
  return page;
}

function assertCovered(report, boxes, label) {
  assert.ok(report.green < EPSILON, `${label}: ${report.green} green pixels on the image`);
  report.boxes.forEach((box, i) => {
    assert.equal(box.green, 0, `${label}: green inside painted box ${i} ${JSON.stringify(boxes[i])}`);
    if (box.pixels > 0) {
      assert.ok(box.dark / box.pixels >= 0.85, `${label}: box ${i} ${JSON.stringify(boxes[i])} is ${box.dark}/${box.pixels} dark`);
    }
  });
}

for (const path of ['/keys.html', '/env/', '/account.html', '/api-keys/', '/billing.html', '/embedded.html', '/settings/tokens/new.html']) {
  test(`every painted secret on ${path} is boxed on the screenshot`, async t => {
    const page = await open(t, path);
    const boxes = await paintedBoxes(page);
    // The page shows secrets in the viewport, and the unredacted capture does show them green (the check has teeth).
    assert.ok(boxes.length > 0, `${path}: painted secrets in view`);
    const plain = `data:image/jpeg;base64,${(await page.screenshot({ type: 'jpeg', quality: 70, caret: 'initial' })).toString('base64')}`;
    assert.ok((await pixelReport(offscreen, plain)).green > EPSILON * 4, `${path}: the raw frame shows green`);
    const shot = await captureRedacted(page, offscreen);
    assert.equal(shot.withheld, false, `${path}: a still page is not withheld`);
    assert.equal(shot.redactions, shot.rects.length);
    assert.ok(shot.redactions >= 1);
    const report = await pixelReport(offscreen, shot.dataUrl, boxes, { width: 1280 });
    assertCovered(report, boxes, path);
  });
}

test('labels: a box carries its placeholder tag, the same number the text uses', async t => {
  const page = await open(t, '/api-keys/');
  const shot = await captureRedacted(page, offscreen);
  assert.ok(shot.rects.some(rect => /^\[secret:\d+\]$/.test(rect.label ?? '')), JSON.stringify(shot.rects.slice(0, 3)));
  // The tag the page script wrote is the one its text placeholders carry (the worker numbers both the same way).
  const tags = await page.evaluate(() => globalThis.__faiPage.redactionRects({ arm: false }).rects.map(rect => rect.label).filter(Boolean));
  const text = JSON.stringify(await page.evaluate(() => globalThis.__faiPage.observe({})));
  assert.ok(tags.some(tag => text.includes(tag.slice(0, -1))), 'a box tag matches a text placeholder');
});

test('a password field is boxed whatever its value; a payment widget frame is boxed in every mode', async t => {
  const page = await open(t, '/account.html', {
    before: async p => {
      await p.route('https://js.stripe.com/**', route => route.fulfill({ contentType: 'text/html',
        body: '<body style="margin:0;background:#00ff00">card field</body>' }));
    },
  });
  await page.evaluate(() => {
    const input = document.createElement('input');
    input.type = 'password';
    input.dataset.fake = '1';
    input.style.cssText = 'color:#00ff00;font-size:24px;display:block';
    input.value = 'abc';
    document.body.prepend(input);
    const frame = document.createElement('iframe');
    frame.src = 'https://js.stripe.com/v3/elements-inner-card.html';
    frame.dataset.fake = '1';
    frame.style.cssText = 'width:300px;height:60px;border:0;display:block';
    document.body.prepend(frame);
  });
  await page.waitForTimeout(300);
  const boxes = await paintedBoxes(page);
  const shot = await captureRedacted(page, offscreen);
  assert.ok(shot.rects.some(rect => rect.kind === 'widget'), JSON.stringify(shot.rects.map(rect => rect.kind)));
  assert.ok(shot.rects.some(rect => rect.kind === 'password'));
  assertCovered(await pixelReport(offscreen, shot.dataUrl, boxes, { width: 1280 }), boxes, 'widget');
});

test('strict mode boxes canvases and code blocks too', async t => {
  const page = await open(t, '/account.html', { secrets: { mode: 'strict' } });
  await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 200;
    canvas.height = 40;
    canvas.dataset.fake = '1';
    canvas.getContext('2d').fillStyle = '#00ff00';
    canvas.getContext('2d').fillRect(0, 0, 200, 40);
    document.body.prepend(canvas);
  });
  const boxes = await paintedBoxes(page);
  const shot = await captureRedacted(page, offscreen);
  assert.ok(shot.rects.some(rect => rect.kind === 'canvas'));
  assertCovered(await pixelReport(offscreen, shot.dataUrl, boxes, { width: 1280 }), boxes, 'strict');
});

test('race: a key inserted between the box query and the capture is covered or the frame is withheld, never raw', async t => {
  for (const variant of ['kept', 'flash', 'scroll']) {
    const page = await open(t, '/account.html');
    const shot = await captureRedacted(page, offscreen, {
      async beforeCapture(attempt) {
        if (attempt > 0) return;
        await page.evaluate(([value, kind]) => {
          const p = document.createElement('p');
          p.style.cssText = 'color:#00ff00;font-size:28px;margin:0';
          p.textContent = `Your new key: ${value}`;
          document.body.prepend(p);
          if (kind === 'flash') requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => p.remove(), 0)));
          if (kind === 'scroll') scrollBy(0, 1);
        }, [F.xai, variant]);
        // Let the inserted key paint before the capture.
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      },
    });
    assert.equal(shot.attempts, 2, `${variant}: the dirty frame is taken again`);
    const report = await pixelReport(offscreen, shot.dataUrl);
    assert.ok(report.green < EPSILON, `${variant}: ${report.green} green pixels (withheld ${shot.withheld})`);
    await page.close();
  }
});

test('a page that never holds still is withheld: the whole frame is covered', async t => {
  const page = await open(t, '/account.html');
  await page.evaluate(value => {
    const p = document.createElement('p');
    p.style.cssText = 'color:#00ff00;font-size:40px;margin:0';
    document.body.prepend(p);
    let on = false;
    setInterval(() => {
      on = !on;
      p.textContent = on ? `token ${value}` : 'loading';
    }, 5);
  }, F.xai);
  const shot = await captureRedacted(page, offscreen);
  assert.equal(shot.withheld, true);
  const report = await pixelReport(offscreen, shot.dataUrl);
  assert.ok(report.green < EPSILON, `${report.green} green pixels`);
});

test('the page is never changed by a capture: no attribute, style or element added', async t => {
  const page = await open(t, '/api-keys/');
  const before = await page.evaluate(() => document.documentElement.outerHTML);
  await captureRedacted(page, offscreen);
  assert.equal(await page.evaluate(() => document.documentElement.outerHTML), before);
});

// A withheld frame must carry no captured pixels, even when neither query found a box. Covering
// large color fields also catches blur/downsampling that retained color and source-over edge leaks.
for (const encoder of ['dom', 'offscreen']) {
  test(`withheld ${encoder} frames discard all source pixels, including edges`, async () => {
    const source = color => offscreen.page.evaluate(fill => {
      const canvas = document.createElement('canvas');
      canvas.width = 1280;
      canvas.height = 900;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = fill;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/png');
    }, color);
    const green = await source('#00ff00');
    const magenta = await source('#ff00ff');
    assert.equal((await pixelReport(offscreen, green)).green, 1280 * 900);
    const message = { type: 'annotate', encoder, action: null, target: null,
      observation: { viewport: { width: 1280, height: 900 }, controls: [], url: 'https://example.test/', revision: 'test' },
      redact: { rects: [], viewport: { width: 1280, height: 900 }, withheld: true } };
    const first = await offscreen.annotate({ ...message, dataUrl: green });
    const second = await offscreen.annotate({ ...message, dataUrl: magenta });
    assert.equal(first.error, undefined);
    assert.equal(second.error, undefined);
    assert.equal(first.withheld, true);
    assert.equal(first.redactions, 0);
    assert.equal(first.dataUrl, second.dataUrl, 'withheld output is independent of every source pixel');
    const boxes = [{ x: 0, y: 0, width: 1280, height: 850 }];
    const report = await pixelReport(offscreen, first.dataUrl, boxes, { width: 1280 });
    assert.equal(report.green, 0);
    assert.equal(report.boxes[0].dark, report.boxes[0].pixels);
  });
}
