import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { chromium } from 'playwright-core';
import { headlessEnv } from '../scripts/headless-env.mjs';

const source = await readFile(new URL('../extension/input.js', import.meta.url), 'utf8');
const background = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8');
const input = vm.createContext({ navigator: { platform: 'Linux' }, document: { hidden: false }, performance, setTimeout, clearTimeout });
vm.runInContext(source, input);
const { plan, seeded } = input.__faiInput.motion;
const plain = value => JSON.parse(JSON.stringify(value));

test('explicit click planner is seeded, bounded, sensitive to distance and width, and lands exactly', () => {
  const make = (distance, width, seed = 83) => plan({ x: 10, y: 10 }, { x: 10 + distance, y: 10 }, { width, height: width }, seeded(seed));
  assert.deepEqual(plain(make(300, 25)), plain(make(300, 25)));
  assert.ok(make(300, 25).travel > make(100, 25).travel);
  assert.ok(make(300, 25).travel > make(300, 100).travel);
  assert.equal(make(0, 25).travel, 0);
  for (let seed = 1; seed <= 200; seed++) {
    const motion = make(seed * 12, seed % 100 + 1, seed);
    assert.ok(motion.preparation >= 15 && motion.preparation <= 35);
    assert.ok(motion.travel >= 80 && motion.travel <= 260);
    assert.ok(motion.hover >= 20 && motion.hover <= 50);
    assert.ok(motion.hold >= 55 && motion.hold <= 95);
    assert.ok(motion.total <= 450);
    assert.ok(motion.points.length >= 2 && motion.points.length <= 17);
    assert.deepEqual(plain(motion.points.at(-1)), { x: 10 + seed * 12, y: 10, at: motion.travel });
    assert.ok(motion.points.every((point, i) => i === 0 || point.at > motion.points[i - 1].at));
  }
});

// Exercise the actual worker helper without starting the worker's unrelated network/session machinery.
function delayHarness() {
  const waits = [];
  const current = { tabId: 7, status: 'active' };
  const context = vm.createContext({
    session: current, chrome: { runtime: { id: 'extension' } },
    faiFrames: { frameApproved: origin => origin === 'https://frame.example' },
    originOf: value => { try { return new URL(value).origin; } catch { return null; } },
    automaticInputPermitted: () => true,
    setTimeout: (resolve, ms) => waits.push({ resolve, ms }),
  });
  vm.runInContext(background.slice(background.indexOf('async function clickDelay('), background.indexOf('\nfunction popupState(')), context);
  const sender = { id: 'extension', tab: { id: 7 }, frameId: 0 };
  return { context, current, waits, sender, run: (ms, from = sender) => context.clickDelay({ ms }, from) };
}

test('worker pacing validates bounds, sender, frame origin and lease before and after the wait', async () => {
  const h = delayHarness();
  for (const ms of [-1, 451, Infinity, 1.5, '20']) assert.equal((await h.run(ms)).reason, 'invalid');
  for (const sender of [
    { ...h.sender, id: 'other' }, { ...h.sender, tab: { id: 8 } },
    { ...h.sender, frameId: -1 }, { ...h.sender, frameId: 2, url: 'https://unapproved.example/' },
  ]) assert.equal((await h.run(20, sender)).reason, 'not_leased');
  assert.equal(h.waits.length, 0);
  const pending = h.run(35);
  assert.equal(h.waits[0].ms, 35);
  h.waits[0].resolve();
  assert.deepEqual(plain(await pending), { ok: true, paced: true });
  const framed = h.run(20, { ...h.sender, frameId: 2, url: 'https://frame.example/page' });
  h.waits[1].resolve();
  assert.equal((await framed).ok, true);
  const stopped = h.run(20);
  h.current.status = 'paused';
  h.waits[2].resolve();
  assert.equal((await stopped).reason, 'not_leased');
});

let browser;
test.before(async () => {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    headless: true, env: headlessEnv(), args: ['--no-sandbox'] });
});
test.after(() => browser?.close());

async function fixture(t) {
  const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  t.after(() => context.close());
  const page = await context.newPage();
  await page.setContent('<a id="link" href="#ok" style="position:absolute;left:400px;top:200px;width:120px;height:40px;display:block">Open details</a><input id="field" style="position:absolute;left:400px;top:300px">');
  await page.addScriptTag({ content: source });
  await page.evaluate(() => {
    window.events = [];
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      document.getElementById('link').addEventListener(type, event => { events.push({ type, at: performance.now() }); if (type === 'click') event.preventDefault(); });
    }
  });
  return page;
}

test('explicit synthetic clicks use bounded pacing, preserve event order, and refuse a covered final point', async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async () => {
    const link = document.getElementById('link');
    const result = await __faiInput.click(link, { point: { x: 450, y: 220 }, fragment: { width: 120, height: 40 }, explicitClick: true });
    return { result, events };
  });
  assert.equal(result.result.clicked, true);
  assert.ok(result.result.plannedMs >= 150 && result.result.plannedMs <= 450);
  assert.ok(result.result.ms >= 150 && result.result.ms < 1200, JSON.stringify(result.result));
  assert.deepEqual(result.events.map(event => event.type), ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']);
  assert.ok(result.events[2].at - result.events[0].at >= 50);
  const covered = await page.evaluate(async () => {
    events.length = 0;
    return __faiInput.click(document.getElementById('link'), {
      point: { x: 450, y: 220 }, fragment: { width: 120, height: 40 }, explicitClick: true,
      stillValid: async () => {
        await Promise.resolve();
        const cover = document.createElement('div');
        cover.style.cssText = 'position:fixed;inset:0;z-index:999;background:white';
        document.body.append(cover);
        return true;
      },
    });
  });
  assert.equal(covered.unavailable, true);
  assert.deepEqual(await page.evaluate(() => events), []);
});

test('hidden clicks use worker pacing and refuse unavailable pacing before pressing', async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async () => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    window.waits = [];
    window.chrome = { runtime: { sendMessage: async message => {
      if (message.kind !== 'fai-click-delay') throw new Error('Unexpected message');
      waits.push(message.ms);
      await new Promise(resolve => setTimeout(resolve, message.ms));
      return { ok: true, paced: true };
    } } };
    const result = await __faiInput.click(document.getElementById('link'), { point: { x: 450, y: 220 }, fragment: { width: 120, height: 40 }, explicitClick: true });
    return { result, waits, events };
  });
  assert.equal(result.result.clicked, true);
  assert.ok(result.waits.length >= 4);
  assert.ok(result.result.ms >= 150);
  const refused = await page.evaluate(async () => {
    events.length = 0;
    chrome.runtime.sendMessage = async () => ({ ok: false });
    return __faiInput.click(document.getElementById('link'), { point: { x: 450, y: 220 }, explicitClick: true });
  });
  assert.equal(refused.unavailable, true);
  assert.deepEqual(await page.evaluate(() => events), []);
});

test('partial or uncertain trusted presses never cause a synthetic second activation', async t => {
  const page = await fixture(t);
  for (const failure of ['partial', 'lost-reply', 'zero-uncertain']) {
    const result = await page.evaluate(async failure => {
      events.length = 0;
      window.calls = [];
      window.chrome = { runtime: { sendMessage: async message => {
        if (message.kind === 'fai-click-delay') return { ok: true, paced: true };
        calls.push(message.steps);
        if (message.steps.some(step => step.type === 'mousePressed')) {
          if (failure === 'lost-reply') throw new Error('Reply lost');
          return { ok: false, dispatched: failure === 'partial' ? 1 : 0, uncertain: true };
        }
        return { ok: true, dispatched: message.steps.filter(step => step.m).length };
      } } };
      __faiInput.configure({ trusted: true });
      const result = await __faiInput.click(document.getElementById('link'), { point: { x: 450, y: 220 }, fragment: { width: 120, height: 40 }, explicitClick: true });
      return { result, events, calls };
    }, failure);
    assert.equal(result.result.unavailable, true, failure);
    assert.deepEqual(result.events, [], failure);
    assert.equal(result.calls.filter(steps => steps.some(step => step.type === 'mousePressed')).length, 1);
  }
});

test('typing focus and wheel positioning retain the legacy profile instead of worker click delays', async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async () => {
    window.delayCalls = 0;
    window.chrome = { runtime: { sendMessage: async message => { if (message.kind === 'fai-click-delay') delayCalls++; return { ok: false, dispatched: 0 }; } } };
    await __faiInput.click(document.getElementById('field'), { think: false });
    await __faiInput.scroll(null, 100);
    return { delayCalls, active: document.activeElement.id };
  });
  assert.equal(result.delayCalls, 0);
  assert.equal(result.active, 'field');
});

test('representative explicit link motion reports planned and elapsed time separately', async t => {
  const page = await fixture(t);
  const cases = await page.evaluate(async () => {
    const link = document.getElementById('link');
    const cases = [];
    for (const shape of [
      { name: 'first large', left: 40, width: 120, height: 60 },
      { name: 'already there', left: 40, width: 120, height: 60 },
      { name: 'medium large', left: 400, width: 120, height: 60 },
      { name: 'far narrow', left: 900, width: 24, height: 24 },
    ]) {
      link.style.left = `${shape.left}px`;
      link.style.width = `${shape.width}px`;
      link.style.height = `${shape.height}px`;
      const point = { x: shape.left + shape.width / 2, y: 200 + shape.height / 2 };
      const result = await __faiInput.click(link, { point, fragment: shape, explicitClick: true });
      cases.push({ name: shape.name, ...result });
    }
    return cases;
  });
  for (const item of cases) {
    assert.equal(item.clicked, true, item.name);
    assert.ok(item.plannedMs <= 450, JSON.stringify(item));
    assert.ok(item.ms >= item.plannedMs - 20 && item.ms < item.plannedMs + 500, JSON.stringify(item));
    t.diagnostic(`${item.name}: planned ${item.plannedMs} ms, input ${item.ms} ms; no reveal or settling in input fixture`);
  }
  assert.ok(cases[1].plannedMs < cases[3].plannedMs);
});

test('guarded activating Space releases its key but refuses a stale default, including when trusted is enabled', async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async () => {
    const link = document.getElementById('link');
    link.setAttribute('role', 'button');
    link.focus();
    window.keyEvents = [];
    window.trustedCalls = 0;
    window.valid = true;
    window.chrome = { runtime: { sendMessage: async () => { trustedCalls++; return { ok: true, dispatched: 2 }; } } };
    __faiInput.configure({ trusted: true });
    link.addEventListener('keydown', () => { keyEvents.push('down'); valid = false; });
    link.addEventListener('keyup', () => keyEvents.push('up'));
    const result = await __faiInput.press(link, 'Space', {}, async () => valid);
    return { result, keyEvents, trustedCalls, events };
  });
  assert.equal(result.result.proceeded, false);
  assert.equal(result.result.stale, true);
  assert.deepEqual(result.keyEvents, ['down', 'up']);
  assert.equal(result.trustedCalls, 0);
  assert.deepEqual(result.events, []);
});

test('cancelled trusted authority aborts pointer and keyboard actions without a synthetic fallback', async t => {
  const page = await fixture(t);
  for (const operation of ['click', 'press']) {
    const result = await page.evaluate(async operation => {
      events.length = 0;
      window.keydowns = 0;
      document.addEventListener('keydown', () => keydowns++);
      window.chrome = { runtime: { sendMessage: async message => {
        if (message.kind === 'fai-click-delay') return { ok: true, paced: true };
        if (message.steps.some(step => step.type === 'mousePressed' || step.m === 'key')) {
          return { ok: false, dispatched: 0, cancelled: true, reason: 'cancelled' };
        }
        return { ok: true, dispatched: message.steps.filter(step => step.m).length };
      } } };
      __faiInput.configure({ trusted: true });
      try {
        if (operation === 'click') await __faiInput.click(document.getElementById('link'), {
          point: { x: 450, y: 220 }, fragment: { width: 120, height: 40 }, explicitClick: true,
        });
        else await __faiInput.press(document.getElementById('link'), 'Escape');
        return { error: null, events, keydowns };
      } catch (error) { return { error: error.code, events, keydowns }; }
    }, operation);
    assert.equal(result.error, 'target_unavailable', operation);
    assert.deepEqual(result.events, [], operation);
    assert.equal(result.keydowns, 0, operation);
  }
});
