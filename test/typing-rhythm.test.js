// The typing rhythm of extension/input.js (typingPlan and its parts), loaded without a page around it and run with
// seeded randomness: plans are valid key sequences (each key down once and up once, at most two down, no Shift change
// while a key is held, no two events closer than RHYTHM.sep), their statistics look like a fast typist's (right-skewed
// intervals, a coefficient of variation in the human range, slower word starts and burst starts, a pace per session,
// rare capped hesitations), the pace stays quick, the time a fill takes is capped, and a secret's timing depends on
// its length alone. No timers run here; test/real-input.test.js plays plans in Chromium.
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

const SENTENCES = [
  'Ada Lovelace, 12 Baker Street.',
  'Flights to Oslo on the 3rd of May',
  'the quick brown fox jumps over the lazy dog',
  'Window seat, please; arriving late (after 22:00) with two bags.',
  'Meeting notes: review the Q3 budget and send it to Maria',
  'Hotels near the station in Bergen for two nights',
];
const UNBOUNDED = { budgetMs: 1e9, maxTyped: 1e6 };

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
function corpus({ fills = 600, seed = 11, texts = SENTENCES, blind = false } = {}) {
  const random = seeded(seed);
  return Array.from({ length: fills }, (_, i) => {
    const text = texts[i % texts.length];
    return { text, plan: plan(text, { session: session(1000 + i), random, blind, ...UNBOUNDED }) };
  });
}

// Every structural rule a plan keeps, whatever the text.
function assertValid(text, p) {
  const chars = Array.from(text);
  const shifted = ch => /^[A-Z~!@#$%^&*()_+{}|:"<>?]$/.test(ch);
  const fixed = ch => ch === '\n' || !/^[\x20-\x7e]$/.test(ch);
  const at = p.events.map(e => e.at);
  assert.deepEqual(at, [...at].sort((a, b) => a - b), 'events in time order');
  for (let i = 1; i < at.length; i++) assert.ok(at[i] - at[i - 1] >= params.sep - 1e-9, `events ${i - 1},${i} ${at[i] - at[i - 1]} ms apart in ${JSON.stringify(text)}`);
  assert.equal(p.total, p.blind ? p.total : at.at(-1) ?? 0);
  if (!p.blind && at.length) assert.equal(at[0], 0);
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
    const ch = chars[event.index];
    if (event.type === 'down') {
      assert.equal(event.index, next++, 'keys go down in text order');
      assert.equal(shift, shifted(ch), `Shift ${shift} for ${JSON.stringify(ch)}`);
      assert.ok(down.size <= 1, 'at most two keys down');
      for (const [index] of down) {
        assert.notEqual(chars[index], ch, 'the same key is up before it goes down again');
        assert.ok(!fixed(ch) && !fixed(chars[index]), 'no rollover with Enter or keys outside the US layout');
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
  assert.equal(seenDown.size, p.typed);
  assert.equal(seenUp.size, p.typed);
  assert.equal(p.chunked, p.typed < chars.length);
}

test('plans are valid key sequences for any text: letters, capitals, digits, symbols, unicode, emoji, newlines', () => {
  const random = seeded(3);
  const alphabet = Array.from('aAbBeEtThHsS0123456789 .,;:!?-_@#$%^&*()[]{}<>/\\|~`"\'+=\néüß日本🎉😀');
  for (let i = 0; i < 1500; i++) {
    const length = 1 + Math.floor(random() * 50);
    const text = Array.from({ length }, () => alphabet[Math.floor(random() * alphabet.length)]).join('');
    for (const blind of [false, true]) {
      const options = i % 3 ? UNBOUNDED : {};
      const p = plan(text, { session: session(i + 1), random, blind, budgetMs: 1000, maxTyped: 40, ...options });
      assertValid(text, p);
    }
  }
  for (const text of ['', 'a', 'A', 'AAAA', 'aaaa', 'Ab', 'aB', 'll', 'LL', '\n\n', 'Hi there', 'x'.repeat(40)]) {
    assertValid(text, plan(text, { session: session(5), random, ...UNBOUNDED }));
  }
});

test('the same seeds give the same plan; another session gives another pace', () => {
  const a = plan(SENTENCES[0], { session: session(9), random: seeded(1), ...UNBOUNDED });
  const b = plan(SENTENCES[0], { session: session(9), random: seeded(1), ...UNBOUNDED });
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
  // Within a session, the pace holds: one session's sentences sit closer together than different sessions'.
  const perSession = s => mean(Array.from({ length: 40 }, (_, k) => mean(gaps(plan(SENTENCES[k % 6], { session: session(s), random: seeded(100 + k), ...UNBOUNDED })))));
  const spread = [1, 2, 3, 4, 5, 6, 7, 8].map(perSession);
  assert.ok(Math.max(...spread) / Math.min(...spread) > 1.15, `session means ${spread.map(Math.round)}`);
});

test('intervals are right-skewed, with a human coefficient of variation', () => {
  const plans = corpus();
  const all = plans.flatMap(({ plan: p }) => gaps(p));
  assert.ok(mean(all) > median(all) * 1.05, `mean ${mean(all)} median ${median(all)}`);
  assert.ok(skewness(all) > 0.8, `skewness ${skewness(all)}`);
  // Without hesitations (the long tail's outliers) still skewed: the log-normal body.
  const body = all.filter(g => g < params.hesitationMs[0]);
  assert.ok(skewness(body) > 0.4, `body skewness ${skewness(body)}`);
  const withinFill = plans.map(({ plan: p }) => sd(gaps(p)) / mean(gaps(p)));
  const cv = mean(withinFill);
  assert.ok(cv >= 0.3 && cv <= 0.6, `within-fill CV ${cv}`);
  const overall = sd(all) / mean(all);
  assert.ok(overall >= 0.3 && overall <= 0.7, `overall CV ${overall}`);
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
      // Compare letters only, so Shift, digits and punctuation do not blur the picture.
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
      // A burst ends early only at a word start.
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
  // Second key of a word, after the same first key: only the second key's context differs.
  const plainKey = sample('xk', 1);
  assert.ok(sample('xK', 1) > plainKey * 1.2, 'Shift');
  assert.ok(sample('x7', 1) > plainKey * 1.1, 'digit');
  assert.ok(sample('dc', 1) > sample('df', 1) * 1.2, 'same finger (d, c) slower than another finger of that hand');
  assert.ok(sample('th', 1) < sample('tg', 1) * 0.8, 'a common bigram on alternating hands is quicker');
});

test('hesitations: about 2% of keys, 250-550 ms, at most 600 ms per fill', () => {
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
  // Not a superhuman burst either: no interval under the floor.
  assert.ok(Math.min(...perChar) > 60);
});

test('a fill types for a bounded time: short values in full, long ones in a prefix within the budget', () => {
  const random = seeded(5);
  let whole = 0;
  for (let i = 0; i < 1000; i++) {
    const s = session(i + 1);
    const short = plan('Hi there', { session: s, random, budgetMs: 1000, maxTyped: 40 });
    assert.ok(short.total <= (short.chunked ? 1000 : 1000 * params.slack));
    if (!short.chunked) whole++;
    for (const length of [100, 400]) {
      const long = plan('Lorem ipsum dolor sit amet, consectetur. '.repeat(10).slice(0, length), { session: s, random, budgetMs: 1000, maxTyped: 40 });
      assert.ok(long.total <= 1000, `${length}: ${long.total}`);
      assert.ok(long.typed <= 40 && long.typed >= 3);
      assert.equal(long.chunked, true);
      assertValid('Lorem ipsum dolor sit amet, consectetur. '.repeat(10).slice(0, length), long);
    }
    const any = plan('x'.repeat(30), { session: s, random, budgetMs: 1000, maxTyped: 40 });
    assert.ok(any.total <= 1000 * params.slack);
  }
  // A short value is typed in full (the slack spares pasting its last letter or two), short of a long hesitation.
  assert.ok(whole >= 970, `${whole}/1000 typed in full`);
  assert.equal(plan('abc', { session: session(1), random, budgetMs: 0, maxTyped: 40 }).typed, 0);
  assert.equal(plan('abcdef', { session: session(1), random, budgetMs: 1e6, maxTyped: 4 }).typed, 4);
});

test('a secret is planned from its length alone: same times, same total, same prefix whatever it holds', () => {
  const values = ['aaaaaaaaaaaa', 'Tr0ub4dor&3!', 'ZZZZZZZZZZZZ', 'p@ss W0RD #1', 'ééééééééééé1'];
  for (let seed = 1; seed <= 300; seed++) {
    const shapes = values.map(value => {
      const p = plan(value, { session: session(seed), random: seeded(seed), blind: true, budgetMs: 600, maxTyped: 40 });
      assertValid(value, p);
      const keys = p.events.filter(e => e.type !== 'shift').map(e => [e.type, e.index, e.at]);
      return { keys, total: p.total, typed: p.typed, chunked: p.chunked };
    });
    for (const shape of shapes.slice(1)) assert.deepEqual(shape, shapes[0]);
  }
});

test('trusted steps: the plan as debugger steps, waits within the worker limit, keys and text in order', () => {
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
  // A long hesitation is split into waits the worker accepts; 40 keys of alternating case fit its 400 steps.
  const busy = plan('aB'.repeat(20), { session: session(3), random: seeded(3), ...UNBOUNDED });
  assert.ok(steps(Array.from('aB'.repeat(20)), busy).length < 300);
  // A blind plan waits out its full total.
  const secret = plan('s3cret', { session: session(2), random: seeded(2), blind: true, ...UNBOUNDED });
  assert.equal(steps(Array.from('s3cret'), secret).reduce((sum, step) => sum + (step.wait ?? 0), 0), Math.round(secret.total));
});
