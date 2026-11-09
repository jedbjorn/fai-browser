// The typing rhythm of extension/input.js (typingPlan and its parts), loaded without a page around it and run with
// seeded randomness: plans are valid keystroke sequences that type exactly the text (each key down once and up once,
// at most two down, no Shift change while a key is held, no two events closer than RHYTHM.sep), their statistics look
// like a fast typist's (right-skewed intervals, a human coefficient of variation, slower word and burst starts, a pace
// per session, rare capped hesitations) with no artifacts (no time piled up at a bound, no fixed ratios), the pace
// stays quick, short values are typed in full and long ones within the budget, a secret's timing depends on its length
// alone, and slips (a neighbouring key, Backspace, the right key) come at the planned rate, only where allowed, and
// always end in the exact text. No timers run here; test/real-input.test.js plays plans in Chromium.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SOURCE = readFileSync(new URL('../extension/input.js', import.meta.url), 'utf8');
const context = vm.createContext({ navigator: { platform: 'Linux' }, document: { hidden: false }, performance, setTimeout, clearTimeout });
vm.runInContext(SOURCE, context);
const rhythm = context.__faiInput.rhythm;
// Results copied out of the vm's realm, so deepEqual compares values, not prototypes.
const local = fn => (...args) => JSON.parse(JSON.stringify(fn(...args)));
const session = local(rhythm.session);
const plan = local(rhythm.plan);
const steps = local(rhythm.steps);
const { seeded, params } = rhythm;
const NEIGHBOURS = JSON.parse(JSON.stringify(rhythm.neighbours));

const SENTENCES = [
  'Ada Lovelace, 12 Baker Street.',
  'Flights to Oslo on the 3rd of May',
  'the quick brown fox jumps over the lazy dog',
  'Window seat, please; arriving late (after 22:00) with two bags.',
  'Meeting notes: review the Q3 budget and send it to Maria',
  'Hotels near the station in Bergen for two nights',
];
const UNBOUNDED = { budgetMs: 1e9, maxTyped: 1e6 };
const SHIFTED = /^[A-Z~!@#$%^&*()_+{}|:"<>?]$/;

const downs = p => p.events.filter(e => e.type === 'down').map(e => e.at);
const gaps = p => {
  const at = downs(p);
  return at.slice(1).map((t, i) => t - at[i]);
};
const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = xs => {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map(x => (x - m) ** 2)));
};
const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const skewness = xs => {
  const m = mean(xs);
  const s = sd(xs);
  return mean(xs.map(x => ((x - m) / s) ** 3));
};

// Plans over many sessions and texts, unbounded (every key typed).
function corpus({ fills = 600, seed = 11, texts = SENTENCES, blind = false, slips = false, slipRate } = {}) {
  const random = seeded(seed);
  return Array.from({ length: fills }, (_, i) => {
    const text = texts[i % texts.length];
    return { text, plan: plan(text, { session: session(1000 + i), random, blind, slips, ...(slipRate === undefined ? {} : { slipRate }), ...UNBOUNDED }) };
  });
}

// What the keystrokes of a plan leave in an empty field.
function result(p) {
  let value = [];
  for (const event of p.events) {
    if (event.type !== 'down') continue;
    const stroke = p.strokes[event.index];
    if (stroke.back) value = value.slice(0, -1);
    else value.push(stroke.ch);
  }
  return value.join('');
}

// Every structural rule a plan keeps, whatever the text.
function assertValid(text, p) {
  const chars = Array.from(text);
  const fixed = stroke => stroke.back || stroke.ch === '\n' || !/^[\x20-\x7e]$/.test(stroke.ch);
  const at = p.events.map(e => e.at);
  assert.deepEqual(at, [...at].sort((a, b) => a - b), 'events in time order');
  for (let i = 1; i < at.length; i++) assert.ok(at[i] - at[i - 1] >= params.sep - 1e-9, `events ${i - 1},${i} ${at[i] - at[i - 1]} ms apart in ${JSON.stringify(text)}`);
  if (!p.blind) {
    assert.equal(p.total, at.at(-1) ?? 0);
    if (at.length) assert.equal(at[0], 0);
  } else if (at.length) {
    assert.ok(p.total > at.at(-1));
  }
  const down = new Map();
  const seenDown = new Set();
  const seenUp = new Set();
  let shift = false;
  let next = 0;
  for (const event of p.events) {
    if (event.type === 'shift') {
      assert.notEqual(event.on, shift, 'Shift toggles');
      assert.equal(down.size, 0, `no key held across a Shift change in ${JSON.stringify(text)}`);
      shift = event.on;
      continue;
    }
    const stroke = p.strokes[event.index];
    if (event.type === 'down') {
      assert.equal(event.index, next++, 'keystrokes go down in order');
      assert.equal(shift, !stroke.back && SHIFTED.test(stroke.ch), `Shift ${shift} for ${JSON.stringify(stroke.ch)}`);
      assert.ok(down.size <= 1, 'at most two keys down');
      for (const [index] of down) {
        assert.notEqual(p.strokes[index].ch, stroke.ch, 'the same key is up before it goes down again');
        assert.ok(!fixed(stroke) && !fixed(p.strokes[index]), 'no rollover with Enter, Backspace or keys outside the US layout');
        if (p.blind) assert.fail('no rollover in a blind plan');
      }
      down.set(event.index, event.at);
      seenDown.add(event.index);
    } else {
      assert.ok(down.has(event.index), 'up after down');
      assert.ok(event.at - down.get(event.index) >= params.holdMin - 1e-9, 'hold at least holdMin');
      down.delete(event.index);
      seenUp.add(event.index);
    }
  }
  assert.equal(down.size, 0, 'every key comes up');
  assert.equal(shift, false, 'Shift released at the end');
  assert.equal(seenDown.size, p.strokes.length);
  assert.equal(seenUp.size, p.strokes.length);
  assert.equal(result(p), chars.slice(0, p.typed).join(''), `keystrokes type ${JSON.stringify(text)}`);
  assert.equal(p.chunked, p.typed < chars.length);
}

const ALPHABET = Array.from('aAbBeEtThHsS0123456789 .,;:!?-_@#$%^&*()[]{}<>/\\|~`"\'+=\néüß日本🎉😀');
function randomText(random, length) {
  return Array.from({ length }, () => ALPHABET[Math.floor(random() * ALPHABET.length)]).join('');
}

test('plans are valid keystroke sequences for any text: letters, capitals, digits, symbols, unicode, emoji, newlines', () => {
  const random = seeded(3);
  for (let i = 0; i < 1500; i++) {
    const text = randomText(random, 1 + Math.floor(random() * 50));
    for (const blind of [false, true]) {
      const options = i % 3 ? UNBOUNDED : {};
      assertValid(text, plan(text, { session: session(i + 1), random, blind, slips: !blind, budgetMs: 1000, maxTyped: 40, ...options }));
    }
  }
  for (const text of ['', 'a', 'A', 'AAAA', 'aaaa', 'Ab', 'aB', 'll', 'LL', '\n\n', 'Hi there', 'x'.repeat(40)]) {
    assertValid(text, plan(text, { session: session(5), random, ...UNBOUNDED }));
  }
});

test('the same seeds give the same plan; another session gives another pace', () => {
  const a = plan(SENTENCES[0], { session: session(9), random: seeded(1), slips: true, ...UNBOUNDED });
  const b = plan(SENTENCES[0], { session: session(9), random: seeded(1), slips: true, ...UNBOUNDED });
  assert.deepEqual(a, b);
  const paces = Array.from({ length: 300 }, (_, i) => session(i + 1).iki);
  assert.ok(new Set(paces.map(p => Math.round(p))).size > 20, 'sessions differ');
  assert.ok(Math.min(...paces) >= params.iki[0] && Math.max(...paces) <= params.iki[1]);
  assert.ok(Math.max(...paces) - Math.min(...paces) > 0.6 * (params.iki[1] - params.iki[0]), 'the range is used');
  // The same keystroke draws under a slow and a fast session: the slow one takes longer.
  const slow = Array.from({ length: 200 }, (_, i) => i + 1).find(s => session(s).iki > 100);
  const fast = Array.from({ length: 200 }, (_, i) => i + 1).find(s => session(s).iki < 82);
  const pace = s => mean(SENTENCES.map(text => plan(text, { session: session(s), random: seeded(4), ...UNBOUNDED }).total));
  assert.ok(pace(slow) > pace(fast) * 1.12, `${pace(slow)} vs ${pace(fast)}`);
  const perSession = s => mean(Array.from({ length: 40 }, (_, k) => mean(gaps(plan(SENTENCES[k % 6], { session: session(s), random: seeded(100 + k), ...UNBOUNDED })))));
  const spread = [1, 2, 3, 4, 5, 6, 7, 8].map(perSession);
  assert.ok(Math.max(...spread) / Math.min(...spread) > 1.15, `session means ${spread.map(Math.round)}`);
});

test('intervals are right-skewed, with a human coefficient of variation', () => {
  const plans = corpus();
  const all = plans.flatMap(({ plan: p }) => gaps(p));
  assert.ok(mean(all) > median(all) * 1.05, `mean ${mean(all)} median ${median(all)}`);
  assert.ok(skewness(all) > 0.8, `skewness ${skewness(all)}`);
  const body = all.filter(g => g < params.hesitationMs[0]);
  assert.ok(skewness(body) > 0.4, `body skewness ${skewness(body)}`);
  const cv = mean(plans.map(({ plan: p }) => sd(gaps(p)) / mean(gaps(p))));
  assert.ok(cv >= 0.3 && cv <= 0.6, `within-fill CV ${cv}`);
  const overall = sd(all) / mean(all);
  assert.ok(overall >= 0.3 && overall <= 0.7, `overall CV ${overall}`);
});

// Times of one kind across many plans, normal and blind: holds, keydown intervals, keyup to the next keydown,
// keyup to a Shift press, and each hold over the next interval.
function timings(blind) {
  const random = seeded(blind ? 31 : 32);
  const texts = blind ? ['Tr0ub4dor&3!xy', 'correct horse battery', 'P@ssw0rd-Is-Long', 'aaaaaaaa'] : [...SENTENCES, 'Hi there', 'Fjord Hotels'];
  const out = { hold: [], interval: [], upToDown: [], upToShift: [], ratio: [], delta: [] };
  for (let i = 0; i < 6000; i++) {
    const p = plan(texts[i % texts.length], { session: session(i + 1), random, blind, slips: !blind, ...UNBOUNDED });
    for (let k = 1; k < p.events.length; k++) out.delta.push(p.events[k].at - p.events[k - 1].at);
    const downAt = new Map();
    const upAt = new Map();
    let lastDown = null;
    let lastUp = null;
    for (const event of p.events) {
      if (event.type === 'down') {
        downAt.set(event.index, event.at);
        if (lastDown !== null) out.interval.push(event.at - lastDown);
        if (lastUp !== null && lastUp <= event.at) out.upToDown.push(event.at - lastUp);
        lastDown = event.at;
      } else if (event.type === 'up') {
        upAt.set(event.index, event.at);
        out.hold.push(event.at - downAt.get(event.index));
        lastUp = event.at;
      } else if (event.on && lastUp !== null) {
        out.upToShift.push(event.at - lastUp);
      }
    }
    for (const [index, at] of downAt) {
      if (downAt.has(index + 1)) out.ratio.push((upAt.get(index) - at) / (downAt.get(index + 1) - at));
    }
  }
  return out;
}

// The fullest 1 ms bin, against the bins around it: a pile-up at a bound or a fixed margin stands out.
function worstSpike(values, low = 0, high = 400) {
  const bins = new Map();
  for (const value of values) if (value >= low && value < high) bins.set(Math.floor(value), (bins.get(Math.floor(value)) ?? 0) + 1);
  let worst = { ratio: 0 };
  for (const [bin, count] of bins) {
    if (count < 30) continue;
    const around = [-3, -2, 2, 3].map(k => bins.get(bin + k) ?? 0);
    const ratio = count / Math.max(mean(around), 1);
    if (ratio > worst.ratio) worst = { bin, count, ratio, around };
  }
  return worst;
}

test('no artifacts: no 1 ms bin of holds, intervals or keyup-to-keydown times piles up, normal or blind; no fixed ratio', () => {
  for (const blind of [false, true]) {
    const t = timings(blind);
    for (const name of ['hold', 'interval', 'upToDown', 'upToShift']) {
      assert.ok(t[name].length > 1000, `${name} samples`);
      const spike = worstSpike(t[name]);
      assert.ok(spike.ratio < 3, `${blind ? 'blind' : 'normal'} ${name}: ${JSON.stringify(spike)}`);
    }
    // No hold is a fixed share of the interval after it.
    const ratios = new Map();
    for (const r of t.ratio) ratios.set(r.toFixed(6), (ratios.get(r.toFixed(6)) ?? 0) + 1);
    const most = [...ratios.values()].reduce((a, b) => Math.max(a, b), 0);
    assert.ok(most / t.ratio.length < 0.002, `${blind ? 'blind' : 'normal'}: one hold/interval ratio in ${most} of ${t.ratio.length}`);
    // A blind hold is as long as a normal one.
    if (blind) assert.ok(median(t.hold) > 55, `blind hold median ${median(t.hold)}`);
    // The time between two events rises from its floor instead of starting with a full bin there: the lowest
    // populated 1 ms bins hold a small share of the fuller bins a few ms above them.
    const bins = new Map();
    for (const d of t.delta) bins.set(Math.floor(d), (bins.get(Math.floor(d)) ?? 0) + 1);
    const floor = Math.min(...bins.keys());
    const above = Math.max(...Array.from({ length: 20 }, (_, k) => bins.get(floor + 3 + k) ?? 0));
    for (const k of [0, 1]) {
      const count = bins.get(floor + k) ?? 0;
      assert.ok(count < 0.3 * above, `${blind ? 'blind' : 'normal'}: bin ${floor + k} ms holds ${count}, the fullest above ${above}`);
    }
  }
});

test('word starts and burst starts come later than keys inside a burst', () => {
  const word = [];
  const burst = [];
  const inside = [];
  for (const { text, plan: p } of corpus()) {
    const chars = Array.from(text);
    const at = downs(p);
    const starts = new Set(p.bursts);
    for (let i = 1; i < at.length; i++) {
      const gap = at[i] - at[i - 1];
      if (gap > params.hesitationMs[0]) continue;
      if (!/[a-z]/.test(chars[i]) || !/[a-z ]/.test(chars[i - 1])) continue;
      if (chars[i - 1] === ' ') word.push(gap);
      else if (starts.has(i)) burst.push(gap);
      else inside.push(gap);
    }
  }
  assert.ok(mean(word) > mean(inside) * 1.25, `word start ${mean(word)} vs inside ${mean(inside)}`);
  assert.ok(mean(burst) > mean(inside) * 1.2, `burst start ${mean(burst)} vs inside ${mean(inside)}`);
});

test('bursts of 3-8 keys exist inside words', () => {
  let counted = 0;
  for (const { text, plan: p } of corpus({ fills: 200 })) {
    const chars = Array.from(text);
    const bounds = [...p.bursts, p.typed];
    for (let k = 0; k < bounds.length - 1; k++) {
      const length = bounds[k + 1] - bounds[k];
      if (chars[bounds[k + 1] - 1] !== ' ' && bounds[k + 1] !== p.typed) {
        assert.ok(length >= params.burst[0] && length <= params.burst[1], `burst of ${length}`);
        counted++;
      }
    }
    assert.ok(p.bursts.length > 1);
  }
  assert.ok(counted > 100);
});

test('Shift, digits and the same finger are slower; common bigrams and a change of hand quicker', () => {
  const sample = (text, index) => {
    const random = seeded(77);
    return mean(Array.from({ length: 1500 }, (_, i) => {
      const at = downs(plan(text, { session: session(500 + (i % 50)), random, ...UNBOUNDED }));
      return at[index] - at[index - 1];
    }));
  };
  const plainKey = sample('xk', 1);
  assert.ok(sample('xK', 1) > plainKey * 1.2, 'Shift');
  assert.ok(sample('x7', 1) > plainKey * 1.1, 'digit');
  assert.ok(sample('dc', 1) > sample('df', 1) * 1.2, 'same finger (d, c) slower than another finger of that hand');
  assert.ok(sample('th', 1) < sample('tg', 1) * 0.8, 'a common bigram on alternating hands is quicker');
});

test('hesitations: about 2% of keys, 250-550 ms, at most 600 ms per fill, counted within what is typed', () => {
  const random = seeded(21);
  let keys = 0;
  let count = 0;
  let capped = 0;
  const text = 'abcdefghij'.repeat(4);
  for (let i = 0; i < 4000; i++) {
    const p = plan(text, { session: session(i + 1), random, ...UNBOUNDED });
    keys += Array.from(text).length - 1;
    count += p.hesitations;
    assert.ok(p.hesitationMs <= params.hesitationCap + 1e-9);
    if (p.hesitationMs >= params.hesitationCap - 1e-9) capped++;
    for (const gap of gaps(p)) assert.ok(gap <= params.ikiMax + params.hesitationMs[1] + 1e-9);
  }
  const rate = count / keys;
  assert.ok(rate > 0.014 && rate < 0.026, `rate ${rate}`);
  assert.ok(capped > 0, 'the cap is reached sometimes');
  // A prefix reports only its own hesitations.
  for (let i = 0; i < 300; i++) {
    const p = plan('x'.repeat(100), { session: session(i + 1), random, budgetMs: 1000, maxTyped: 40 });
    assert.ok(p.hesitations <= Math.max(0, p.typed - 1));
    assert.ok(p.hesitationMs <= p.total);
  }
});

test('the pace stays quick: a 30-character value at about 9 characters a second', () => {
  const random = seeded(8);
  const text = SENTENCES[0];
  assert.equal(Array.from(text).length, 30);
  const perChar = Array.from({ length: 2000 }, (_, i) => {
    const at = downs(plan(text, { session: session(i + 1), random, ...UNBOUNDED }));
    return at.at(-1) / (at.length - 1);
  });
  const charsPerSecond = 1000 / mean(perChar);
  assert.ok(charsPerSecond >= 7.5 && charsPerSecond <= 11, `${charsPerSecond} chars/s`);
  assert.ok(Math.min(...perChar) > 60);
});

const LONG = 'Lorem ipsum dolor sit amet, consectetur. '.repeat(10);

test('a fill types for a bounded time: values up to 14 characters in full, long ones in a prefix within the budget', () => {
  const random = seeded(5);
  const words = 'the quick brown fox Oslo Bergen Maria hotel flight station near John Smith'.split(' ');
  const value = length => {
    let s = '';
    while (s.length < length) s += (s ? ' ' : '') + words[Math.floor(random() * words.length)];
    return s.slice(0, length);
  };
  for (const length of [6, 10, 12, 14]) {
    let chunked = 0;
    for (let i = 0; i < 2000; i++) {
      const p = plan(value(length), { session: session(i + 1), random, slips: true, budgetMs: 1000, maxTyped: 40 });
      if (p.chunked) chunked++;
      assert.ok(p.total < 2600, `${length}: ${p.total}`);
    }
    assert.equal(chunked, 0, `${length}-character values chunked ${chunked} of 2000`);
  }
  for (const text of ['Hi there', 'Fjord Hotels']) {
    for (let i = 0; i < 2000; i++) assert.equal(plan(text, { session: session(i + 1), random, slips: true, budgetMs: 1000, maxTyped: 40 }).chunked, false);
  }
  for (let i = 0; i < 1000; i++) {
    const s = session(i + 1);
    for (const length of [100, 400]) {
      const text = LONG.slice(0, length);
      const long = plan(text, { session: s, random, slips: true, budgetMs: 1000, maxTyped: 40 });
      assert.ok(long.total <= 1000, `${length}: ${long.total}`);
      assert.ok(long.typed <= 40 && long.typed >= 3);
      assert.equal(long.chunked, true);
      assert.equal(long.slips, 0, 'no slips in a prefix');
      assertValid(text, long);
    }
    const thirty = plan(value(30), { session: s, random, slips: true, budgetMs: 1000, maxTyped: 40 });
    assert.ok(thirty.total <= 1000 * params.slack);
  }
  assert.equal(plan('abc', { session: session(1), random, budgetMs: 0, maxTyped: 40 }).typed, 0);
  assert.equal(plan('abcdef', { session: session(1), random, budgetMs: 1e6, maxTyped: 4 }).typed, 4);
});

test('a secret is planned from its length alone: same times, same total, same prefix whatever it holds; no slips', () => {
  const values = ['aaaaaaaaaaaa', 'Tr0ub4dor&3!', 'ZZZZZZZZZZZZ', 'p@ss W0RD #1', 'ééééééééééé1', 'AbCdEfGhIjKl'];
  for (let seed = 1; seed <= 300; seed++) {
    const shapes = values.map(value => {
      const p = plan(value, { session: session(seed), random: seeded(seed), blind: true, slips: true, slipRate: 1, budgetMs: 600, maxTyped: 40 });
      assertValid(value, p);
      assert.equal(p.slips, 0);
      const keys = p.events.filter(e => e.type !== 'shift').map(e => [e.type, e.index, e.at]);
      return { keys, total: p.total, typed: p.typed, chunked: p.chunked };
    });
    for (const shape of shapes.slice(1)) assert.deepEqual(shape, shapes[0]);
  }
});

test('trusted steps: the plan as debugger steps, waits within the worker limit, keys, Backspace and text in order', () => {
  const text = 'Hi Ölaf! 🎉\nAa1';
  const p = plan(text, { session: session(2), random: seeded(2), ...UNBOUNDED });
  const list = steps(Array.from(text), p);
  assert.ok(list.every(step => step.wait === undefined || (step.wait > 0 && step.wait <= 600)));
  assert.deepEqual(list.filter(step => step.type === 'keyDown').map(step => step.text), Array.from(text).map(ch => (ch === '\n' ? '\r' : ch)));
  assert.equal(list.filter(step => step.type === 'keyUp' && step.key !== 'Shift').length, Array.from(text).length);
  let shift = 0;
  for (const step of list) {
    if (step.key === 'Shift') shift = step.type === 'rawKeyDown' ? 8 : 0;
    else if (step.type) assert.equal(step.modifiers, shift);
  }
  const waited = list.reduce((sum, step) => sum + (step.wait ?? 0), 0);
  assert.ok(Math.abs(waited - p.total) <= 1, `${waited} vs ${p.total}`);
  const busy = plan('aB'.repeat(20), { session: session(3), random: seeded(3), ...UNBOUNDED });
  assert.ok(steps(Array.from('aB'.repeat(20)), busy).length < 300);
  const secret = plan('s3cret', { session: session(2), random: seeded(2), blind: true, ...UNBOUNDED });
  assert.equal(steps(Array.from('s3cret'), secret).reduce((sum, step) => sum + (step.wait ?? 0), 0), Math.round(secret.total));
  // A slip: the wrong key's text, Backspace as a raw key, then the right key.
  const random = seeded(4);
  let slipped = null;
  for (let i = 0; !slipped && i < 200; i++) {
    const p2 = plan('typing slowly', { session: session(i + 1), random, slips: true, slipRate: 1, ...UNBOUNDED });
    if (p2.slips) slipped = p2;
  }
  const keyed = steps(Array.from('typing slowly'), slipped).filter(step => step.type === 'keyDown' || step.key === 'Backspace');
  assert.ok(keyed.some(step => step.key === 'Backspace' && step.type === 'rawKeyDown'));
  let typed = '';
  for (const step of keyed) {
    if (step.key === 'Backspace') {
      if (step.type === 'rawKeyDown') typed = typed.slice(0, -1);
    } else {
      typed += step.text;
    }
  }
  assert.equal(typed, 'typing slowly');
});

test('slips: about one per 60 characters, at most 1 (under 40 characters) or 2 per fill, on letters, never at either end', () => {
  const random = seeded(61);
  const texts = ['the quick brown fox jumps over the lazy dog', 'hotels near the station', 'Meeting notes for Maria and John'];
  let chars = 0;
  let slips = 0;
  let late = 0;
  for (let i = 0; i < 6000; i++) {
    const text = texts[i % texts.length];
    const p = plan(text, { session: session(i + 1), random, slips: true, ...UNBOUNDED });
    chars += Array.from(text).length;
    slips += p.slips;
    assert.ok(p.slips <= (text.length >= 40 ? 2 : 1));
    for (let k = 0; k < p.strokes.length; k++) {
      const stroke = p.strokes[k];
      const next = p.strokes[k + 1];
      if (!next?.back || stroke.back) continue;
      // The stroke before the first Backspace is the wrong key (or, for a late notice, the key after it).
      const lateNotice = p.strokes[k + 2]?.back;
      if (lateNotice) late++;
      const wrong = lateNotice ? p.strokes[k - 1] : stroke;
      const index = wrong.index;
      assert.ok(index > 0 && index < Array.from(text).length - 1, 'never the first or last character');
      const right = Array.from(text)[index];
      assert.match(right, /^[a-z]$/i);
      assert.ok(NEIGHBOURS[right.toLowerCase()].includes(wrong.ch.toLowerCase()), `${wrong.ch} next to ${right}`);
      assert.equal(wrong.ch === wrong.ch.toUpperCase(), right === right.toUpperCase(), 'same case');
    }
    assertValid(text, p);
  }
  const perChar = slips / chars;
  assert.ok(perChar > 1 / 90 && perChar < 1 / 40, `one slip per ${(1 / perChar).toFixed(0)} characters`);
  assert.ok(late / slips > 0.15 && late / slips < 0.35, `late notices ${late}/${slips}`);
  // Under 6 characters, in a blind plan, or not allowed: none.
  for (let i = 0; i < 500; i++) {
    assert.equal(plan('hotel', { session: session(i + 1), random, slips: true, slipRate: 1, ...UNBOUNDED }).slips, 0);
    assert.equal(plan('hotels nearby', { session: session(i + 1), random, slips: false, slipRate: 1, ...UNBOUNDED }).slips, 0);
    assert.equal(plan('hotels nearby', { session: session(i + 1), random, blind: true, slips: true, slipRate: 1, ...UNBOUNDED }).slips, 0);
    assert.equal(plan('1234567890+-', { session: session(i + 1), random, slips: true, slipRate: 1, ...UNBOUNDED }).slips, 0);
  }
});

test('slips forced on: thousands of random values still type exactly; slips count toward the budget and go first', () => {
  const random = seeded(62);
  let slipped = 0;
  for (let i = 0; i < 4000; i++) {
    const text = randomText(random, 6 + Math.floor(random() * 30));
    const p = plan(text, { session: session(i + 1), random, slips: true, slipRate: 0.5, ...UNBOUNDED });
    assertValid(text, p);
    if (p.slips) slipped++;
  }
  assert.ok(slipped > 1000, `${slipped} plans with slips`);
  // Within the budget: a slip that does not fit is dropped before anything is cut.
  let dropped = 0;
  for (let i = 0; i < 2000; i++) {
    const text = 'hotel rooms';
    const p = plan(text, { session: session(i + 1), random, slips: true, slipRate: 1, budgetMs: 1000, maxTyped: 40 });
    assertValid(text, p);
    if (p.slips) assert.ok(p.total <= 1000 * params.slack, `${p.total}`);
    else dropped++;
    if (p.chunked) assert.equal(p.slips, 0);
  }
  assert.ok(dropped > 0 && dropped < 2000, `dropped ${dropped}`);
});

test('containedOnce: a formatter\'s output holds the value; the value twice or with residue in it does not', () => {
  const once = rhythm.containedOnce;
  for (const [value, text] of [
    ['$1,500.00', '1500'], ['1,500', '1500'], ['$0.00', '0'], ['+1 5551234567', '5551234567'], ['(555) 123-4567', '555 123 4567'],
    ['ABC123', 'abc123'], ['NO9386011117947', 'NO93 8601 1117 947'], ['https://example.com', 'example.com'],
    ['#abc', 'abc'], ['12 kg', '12'], ['@ada', 'ada'], ['Oslo', 'oslo'], ['', ''], ['$15.00', '15'], ['1500 kr', '1500'],
    ['1500.0', '1500'], ['+1 555 123 4567', '555 123 4567'], ['+1 (555) 123-4567', '5551234567'], ['€ 1.500,00', '1500'],
    ['abc!', 'abc'], ['Ada Lovelace', 'ada lovelace'], ['$0.15', '0.15'],
  ]) assert.equal(once(value, text), true, `${JSON.stringify(value)} holds ${JSON.stringify(text)}`);
  for (const [value, text] of [
    ['abcabc', 'abc'], ['15001500', '1500'], ['$1,500.00$1,500.00', '1500'], ['resxervations', 'reservations'],
    ['rservations', 'reservations'], ['old valuenew', 'new value'], ['x', ''], ['', 'abc'],
    // Residue against the value's own letters or digits.
    ['abcc', 'abc'], ['aabc', 'abc'], ['155', '15'], ['$150.00', '15'], ['115', '15'], ['rreservations', 'reservations'],
    ['abc abc', 'abc'], ['$0.15', '15'], ['15.5', '15'],
  ]) assert.equal(once(value, text), false, `${JSON.stringify(value)} does not hold ${JSON.stringify(text)}`);
});

test('Backspace through trusted input: macOS carries its deleteBackward command on the key press, other platforms none', () => {
  const mac = vm.createContext({ navigator: { platform: 'MacIntel' }, document: { hidden: false }, performance, setTimeout, clearTimeout });
  vm.runInContext(SOURCE, mac);
  const onMac = local(mac.__faiInput.rhythm.backspace);
  const elsewhere = local(rhythm.backspace);
  assert.deepEqual(onMac('rawKeyDown'), { m: 'key', type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', keyCode: 8, modifiers: 0, commands: ['deleteBackward'] });
  assert.deepEqual(onMac('keyUp'), { m: 'key', type: 'keyUp', key: 'Backspace', code: 'Backspace', keyCode: 8, modifiers: 0 });
  assert.deepEqual(elsewhere('rawKeyDown'), { m: 'key', type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', keyCode: 8, modifiers: 0 });
  // A slip's steps on macOS carry it too.
  const slipRandom = seeded(4);
  let slipped = null;
  for (let i = 0; !slipped && i < 200; i++) {
    const p = JSON.parse(JSON.stringify(mac.__faiInput.rhythm.plan('typing slowly', { session: session(i + 1), random: slipRandom, slips: true, slipRate: 1, budgetMs: 1e9, maxTyped: 1e6 })));
    if (p.slips) slipped = p;
  }
  const steps = JSON.parse(JSON.stringify(mac.__faiInput.rhythm.steps(Array.from('typing slowly'), slipped)));
  const presses = steps.filter(step => step.key === 'Backspace' && step.type === 'rawKeyDown');
  assert.ok(presses.length && presses.every(step => step.commands?.[0] === 'deleteBackward'));
});
