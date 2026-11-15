import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { headlessEnv } from '../scripts/headless-env.mjs';

let browser;
test.before(async () => {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true,
    env: headlessEnv(), args: ['--no-sandbox'] });
});
test.after(() => browser?.close());
async function open(t, body, realistic = false) {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  t.after(() => page.close());
  await page.route('https://visibility.test/**', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><body>${body}` }));
  await page.goto('https://visibility.test/');
  if (realistic) await page.addScriptTag({ path: new URL('../extension/input.js', import.meta.url).pathname });
  await page.addScriptTag({ path: new URL('../extension/page.js', import.meta.url).pathname });
  await page.evaluate(() => {
    window.presses = 0; window.clicks = 0;
    document.addEventListener('pointerdown', () => window.presses++);
    document.addEventListener('click', e => { window.clicks++; e.preventDefault(); });
  });
  return page;
}
const observe = page => page.evaluate(() => __faiPage.observe({ allow: ['navigate', 'controls'] }));
test('black RGB text remains painted while explicit legacy and Color 4 zero alpha are hidden', async t => {
  const page = await open(t, `<style>a{display:block;margin:8px}</style>
    <a style="color:rgb(0,0,0)" href="#rgb">RGB black</a>
    <a style="color:rgba(0,0,0,1)" href="#rgba">RGBA black</a>
    <a style="color:rgb(0 0 0 / 100%)" href="#opaque4">Color four black</a>
    <a style="color:rgba(0,0,0,0)" href="#alpha">RGBA transparent</a>
    <a style="color:rgb(0 0 0 / 0%)" href="#alpha4">Color four transparent</a>
    <a style="color:color(srgb 0 0 0 / 0)" href="#srgb">SRGB transparent</a>`);
  const observation = await observe(page);
  for (const label of ['RGB black', 'RGBA black', 'Color four black']) {
    assert.equal(observation.controls.find(control => control.label === label)?.actionability, 'ready', label);
  }
  for (const label of ['RGBA transparent', 'Color four transparent', 'SRGB transparent']) {
    assert.notEqual(observation.controls.find(control => control.label === label)?.actionability, 'ready', label);
    assert.equal((await act(page, label)).error, 'target_unavailable', label);
  }
  assert.deepEqual(await page.evaluate(() => [presses, clicks]), [0, 0]);
});
async function act(page, label, type = 'click') {
  return page.evaluate(async ({ label, type }) => {
    const o = __faiPage.observe({ allow: ['navigate', 'controls'] });
    const c = o.controls.find(c => c.label === label);
    if (!c) return { missing: true };
    try { return await __faiPage.execute({ type, target: c.id }, o.revision, { quietMs: 1, capMs: 50 }); }
    catch (error) { return { error: error.code }; }
  }, { label, type });
}
for (const realistic of [false, true]) {
  test(`mechanical link gate refuses hidden, transparent, clipped, inert and covered (${realistic ? 'realistic' : 'plain'})`, async t => {
    const page = await open(t, `<style>a{display:block;width:120px;height:22px;margin:10px} .cover{position:absolute;inset:0;background:white}</style>
      <a href="#normal">Normal</a><a style="opacity:0" href="#transparent">Transparent</a>
      <div style="opacity:0"><a href="#ancestor">Ancestor opacity</a></div>
      <a style="filter:opacity(0)" href="#filter">Filtered opacity</a><a style="color:color(srgb 0 0 0 / 0)" href="#color4">Color four</a><a style="color:transparent" href="#transparent-text">Transparent text</a><a href="#invisible"><span style="opacity:0">Invisible contents</span></a><a style="pointer-events:none" href="#pointer">Pointer disabled</a>
      <div inert><a href="#inert">Inert</a></div>
      <div style="height:0;overflow:hidden"><a href="#clip">Clipped</a></div>
      <div style="position:relative;width:150px"><a href="#cover">Covered</a><div class="cover"></div></div>
      <details><summary>Details</summary><a href="#closed">Closed details</a></details>
      <a style="display:none" href="#hidden">Mounted hidden</a>`, realistic);
    const o = await observe(page);
    assert.equal(o.controls.find(c => c.label === 'Normal').actionability, 'ready');
    for (const name of ['Transparent', 'Filtered opacity', 'Color four', 'Transparent text', 'Invisible contents', 'Ancestor opacity', 'Pointer disabled', 'Inert', 'Clipped', 'Covered', 'Closed details', 'Mounted hidden']) {
      assert.notEqual(o.controls.find(c => c.label === name)?.actionability, 'ready', name);
      const result = await act(page, name);
      assert.ok(result.missing || result.error, `${name} activated`);
    }
    assert.deepEqual(await page.evaluate(() => [presses, clicks]), [0, 0]);
    assert.ok(o.unrevealedUrls.includes('https://visibility.test/#transparent'));
  });
  test(`below-fold links require reveal and a fresh decision (${realistic ? 'realistic' : 'plain'})`, async t => {
    const page = await open(t, '<div style="height:1100px">Long page</div><a href="#end">End link</a>', realistic);
    const before = await observe(page);
    assert.equal(before.controls.find(c => c.label === 'End link').actionability, 'reveal');
    assert.equal((await act(page, 'End link')).error, 'target_unavailable');
    assert.equal(await page.evaluate(() => scrollY), 0);
    const result = await act(page, 'End link', 'reveal');
    assert.equal(result.reveal.revealed, true);
    assert.notEqual(result.observation.revision, before.revision);
    assert.deepEqual(await page.evaluate(() => [presses, clicks]), [0, 0]);
    assert.equal(result.observation.controls.find(c => c.label === 'End link').actionability, 'ready');
    assert.ok(!(await act(page, 'End link')).error);
    assert.equal(await page.evaluate(() => clicks), 1);
  });
}
test('fragments preserve display contents, wrapped inline, decorative children and visibility overrides', async t => {
  const page = await open(t, `<a style="display:contents" href="#contents"><span>Contents link</span></a>
    <div style="width:70px"><a href="#wrap">Wrapped inline link</a></div>
    <a href="#decor"><span style="pointer-events:none">Decorative child</span></a>
    <a style="visibility:hidden" href="#override"><span style="visibility:visible">Visibility override</span></a>
    <a style="pointer-events:none" href="#restore"><span style="pointer-events:auto">Pointer restore</span></a>`);
  const o = await observe(page);
  for (const name of ['Contents link','Wrapped inline link','Decorative child','Visibility override','Pointer restore']) {
    assert.equal(o.controls.find(c => c.label === name)?.actionability, 'ready', name);
    assert.ok(!(await act(page, name)).error, name);
  }
});
test('nested horizontal and vertical scrollers reveal without activating; no-op reveal still refreshes', async t => {
  const page = await open(t, `<div style="width:220px;height:120px;overflow:auto"><div style="width:1000px;height:500px;position:relative">
    <a style="position:absolute;top:420px;left:850px;width:120px" href="#nested">Nested link</a></div></div>`);
  assert.equal((await observe(page)).controls.find(c => c.label === 'Nested link').actionability, 'reveal');
  const result = await act(page, 'Nested link', 'reveal');
  assert.equal(result.reveal.revealed, true);
  assert.equal(await page.evaluate(() => clicks), 0);
  const second = await act(page, 'Nested link', 'reveal');
  assert.notEqual(second.observation.revision, result.observation.revision);
});
test('same-origin iframe parent cover blocks child activation', async t => {
  const page = await open(t, `<div style="position:relative"><iframe style="width:400px;height:160px" srcdoc='<a href="https://visibility.test/#frame">Frame link</a>'></iframe>
    <div style="position:absolute;inset:0;background:white"></div></div>`);
  const o = await observe(page);
  assert.equal(o.controls.find(c => c.label === 'Frame link')?.actionability, 'blocked');
  assert.equal((await act(page, 'Frame link')).error, 'target_unavailable');
});
test('href and label mutations on pointer movement invalidate before pointerdown', async t => {
  for (const mutation of ['href', 'label', 'cover', 'detach']) {
    const page = await open(t, `<a style="display:block;margin:200px;width:180px" href="#first">Mutable link</a>`, true);
    await page.evaluate(mutation => document.addEventListener('pointermove', () => {
      const el = document.querySelector('a');
      if (mutation === 'href') el.href = '#changed';
      if (mutation === 'label') el.textContent = 'Changed link';
      if (mutation === 'detach') el.remove();
      if (mutation === 'cover') { const cover = document.createElement('div'); cover.style = 'position:fixed;inset:0;background:white'; document.body.append(cover); }
    }, { once: true }), mutation);
    assert.ok((await act(page, 'Mutable link')).error, mutation);
    assert.deepEqual(await page.evaluate(() => [presses, clicks]), [0, 0], mutation);
  }
});

test('portaled mounted menus require the trigger; modal background and closed details stay blocked', async t => {
  const page = await open(t, `<button id="trigger">Open menu</button><div id="portal" style="display:none"><a href="#portal">Portal item</a></div>
    <a href="#back">Background link</a><dialog><a href="#dialog">Dialog link</a></dialog>`);
  await page.evaluate(() => document.querySelector('#trigger').addEventListener('click', () => document.querySelector('#portal').style.display = 'block'));
  assert.ok(!(await observe(page)).controls.some(c => c.label === 'Portal item' && c.actionability === 'ready'));
  assert.ok(!(await act(page, 'Open menu')).error);
  assert.equal((await observe(page)).controls.find(c => c.label === 'Portal item').actionability, 'ready');
  await page.evaluate(() => document.querySelector('dialog').showModal());
  const modal = await observe(page);
  assert.equal(modal.controls.find(c => c.label === 'Background link').actionability, 'blocked');
  assert.equal(modal.controls.find(c => c.label === 'Dialog link').actionability, 'ready');
});
test('open shadow fragments, slot ownership and nested independent controls', async t => {
  const page = await open(t, '<div id="host"></div><a href="#outer"><button>Nested button</button></a>');
  await page.evaluate(() => {
    const host = document.querySelector('#host');
    host.attachShadow({ mode: 'open' }).innerHTML = '<a style="display:contents" href="#shadow"><span>Shadow link</span></a>';
  });
  const o = await observe(page);
  assert.equal(o.controls.find(c => c.label === 'Shadow link').actionability, 'ready');
  assert.equal(o.controls.find(c => c.role === 'link' && c.label === 'Nested button').actionability, 'blocked');
});
test('offscreen content-visibility auto has a bounded reveal outcome and no activation', async t => {
  const page = await open(t, '<div style="height:1400px"></div><section style="content-visibility:auto;contain-intrinsic-size:200px"><a href="#auto">Auto content link</a></section>');
  const result = await act(page, 'Auto content link', 'reveal');
  assert.equal(await page.evaluate(() => clicks), 0);
  assert.equal(result.error, undefined);
  assert.equal(result.reveal.revealed, true);
  assert.equal(result.observation.controls.find(c => c.label === 'Auto content link').actionability, 'ready');
});
for (const realistic of [false, true]) {
  test(`Space cannot activate a covered or offscreen focused control (${realistic ? 'realistic' : 'plain'})`, async t => {
    for (const state of ['covered', 'offscreen', 'transparent']) {
      const page = await open(t, '<button>Keyboard target</button>', realistic);
      await page.evaluate(state => {
        const target = document.querySelector('button');
        target.focus({ preventScroll: true });
        if (state === 'covered') { const cover = document.createElement('div'); cover.style = 'position:fixed;inset:0;background:white'; document.body.append(cover); }
        if (state === 'transparent') target.style.opacity = '0';
        if (state === 'offscreen') target.style.marginTop = '1200px';
      }, state);
      const result = await page.evaluate(async () => {
        const o = __faiPage.observe({ allow: ['navigate', 'controls'] });
        try { await __faiPage.execute({ type: 'press', key: 'Space' }, o.revision, { quietMs: 1, capMs: 50 }); return {}; }
        catch (error) { return { error: error.code }; }
      });
      assert.equal(result.error, 'target_unavailable', state);
      assert.equal(await page.evaluate(() => clicks), 0);
    }
  });
}
test('select and typing focus use the same final actionability guard', async t => {
  for (const kind of ['select', 'fill_supplied_text']) {
    const page = await open(t, '<label>Choice <select><option value="a">Alpha</option><option value="b">Beta</option></select></label><label>Text <input></label>', true);
    await page.evaluate(kind => {
      const target = document.querySelector(kind === 'select' ? 'select' : 'input');
      target.addEventListener('pointermove', () => target.style.opacity = '0', { once: true });
    }, kind);
    const result = await page.evaluate(async kind => {
      const o = __faiPage.observe({ allow: ['navigate', 'controls'] });
      const c = o.controls.find(c => c.label.startsWith(kind === 'select' ? 'Choice' : 'Text'));
      try { await __faiPage.execute({ type: kind, target: c.id, value: 'b', text: 'hello' }, o.revision, { quietMs: 1, capMs: 50 }); return {}; }
      catch (error) { return { error: error.code }; }
    }, kind);
    assert.equal(result.error, 'target_unavailable', kind);
    assert.deepEqual(await page.evaluate(() => [presses, clicks, document.querySelector('select').value, document.querySelector('input').value]), [0, 0, 'a', '']);
  }
});

test('realistic slotted link keeps composed hit ownership', async t => {
  const page = await open(t, '<div id="slot-host"><span slot="label">Slotted link</span></div>', true);
  await page.evaluate(() => document.querySelector('#slot-host').attachShadow({ mode: 'open' }).innerHTML = '<a href="#slot"><slot name="label"></slot></a>');
  assert.equal((await observe(page)).controls.find(c => c.label === 'Slotted link').actionability, 'ready');
  assert.ok(!(await act(page, 'Slotted link')).error);
  assert.equal(await page.evaluate(() => clicks), 1);
});
test('scaled and mirrored same-origin frame coordinates fail closed', async t => {
  for (const transform of ['transform:scale(.5)', 'transform:rotate(180deg)', 'transform:scaleX(-1)', 'scale:.5', 'rotate:180deg']) {
    const page = await open(t, `<iframe style="width:400px;height:240px;${transform};transform-origin:0 0" srcdoc='<a href="https://visibility.test/#frame">Transformed frame link</a>'></iframe>`);
    assert.equal((await observe(page)).controls.find(c => c.label === 'Transformed frame link').actionability, 'blocked');
  }
});
