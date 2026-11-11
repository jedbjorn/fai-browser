// The typing rhythm of extension/input.js (typingPlan and its parts), loaded without a page around it and run with
// seeded randomness: plans are valid keystroke sequences that type exactly the text (each key down once and up once,
// at most two down, no Shift change while a key is held, no two events closer than RHYTHM.sep), keys come in groups
// of 3, 4 or 5 characters (now and then a single) that prefer natural breaks, quick and close together inside a group
// with a longer, widely varied pause between groups, their statistics look like a fast typist's (right-skewed
// intervals, a pace per session, rare capped hesitations in place of a pause) with no artifacts (no time piled up at a
// bound, no fixed ratios), the pace stays quick, short values are typed in full and long ones within the budget, a
// secret's timing and groups depend on its length alone, and slips (a neighbouring key, Backspace, the right key) come
// at the planned rate, only where allowed, never split by a pause, and always end in the exact text. No timers run
// here; test/real-input.test.js plays plans in Chromium.
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

test('intervals are right-skewed, with the spread of quick groups and pauses between them', t => {
  const plans = corpus();
  const all = plans.flatMap(({ plan: p }) => gaps(p));
  assert.ok(mean(all) > median(all) * 1.05, `mean ${mean(all)} median ${median(all)}`);
  assert.ok(skewness(all) > 0.8, `skewness ${skewness(all)}`);
  // The pauses before groups alone are right-skewed too.
  const pauses = plans.flatMap(({ plan: p }) => groupGaps(p).between);
  assert.ok(mean(pauses) > median(pauses) * 1.05 && skewness(pauses) > 0.5, `pause skewness ${skewness(pauses)}`);
  // Within a fill the intervals spread wider than an even stream with noise (0.3-0.6 before groups): the quick keys
  // of a group and the pauses between.
  const cv = mean(plans.map(({ plan: p }) => sd(gaps(p)) / mean(gaps(p))));
  const overall = sd(all) / mean(all);
  t.diagnostic(`within-fill CV ${cv.toFixed(2)}, overall CV ${overall.toFixed(2)}`);
  assert.ok(cv >= 0.5 && cv <= 1, `within-fill CV ${cv}`);
  assert.ok(overall >= 0.5 && overall <= 1.1, `overall CV ${overall}`);
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
    // A blind hold is a human one: a group's first key as long as a normal one, the rest shorter (blindInGroupHold:
    // no rollover there), so a median above 45 ms.
    if (blind) assert.ok(median(t.hold) > 45, `blind hold median ${median(t.hold)}`);
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

// Characters per group of a plan, from the stroke indices that start one (a group's first stroke is never a Backspace).
function groupSizes(p) {
  const starts = p.groups.map(i => p.strokes[i].index);
  return starts.map((start, k) => (k + 1 < starts.length ? starts[k + 1] : p.typed) - start);
}

// Keydown-to-keydown gaps inside groups and before a group (its pause), corrections aside (a Backspace and the key
// after it).
function groupGaps(p) {
  const starts = new Set(p.groups);
  const order = p.events.filter(e => e.type === 'down');
  const within = [];
  const between = [];
  for (let k = 1; k < order.length; k++) {
    const gap = order[k].at - order[k - 1].at;
    if (starts.has(order[k].index)) between.push(gap);
    else if (!p.strokes[order[k].index].back && !p.strokes[order[k - 1].index].back) within.push(gap);
  }
  return { within, between };
}
const quantile = (xs, f) => [...xs].sort((a, b) => a - b)[Math.floor(f * (xs.length - 1))];

const UNBROKEN = ['482915736024', 'qwrtzxcvbnmpsdfghjkl', '0123456789'.repeat(4), 'aaaabbbbccccddddeeee'];
const GROUP_TEXTS = [...SENTENCES, 'ada.lovelace@example.com', ...UNBROKEN];

test('groups: 3, 4 or 5 characters, now and then a single (never first, never two in a row, the last too), no 2s', t => {
  const counts = { 1: 0, 3: 0, 4: 0, 5: 0 };
  const unbroken = { 1: 0, 3: 0, 4: 0, 5: 0 };
  let groups = 0;
  let lastSingles = 0;
  let fills = 0;
  for (const blind of [false, true]) {
    const random = seeded(blind ? 13 : 12);
    for (let i = 0; i < 4000; i++) {
      const text = GROUP_TEXTS[i % GROUP_TEXTS.length];
      const p = plan(text, { session: session(i + 1), random, blind, slips: !blind, ...UNBOUNDED });
      const sizes = groupSizes(p);
      assert.equal(sizes.reduce((a, b) => a + b, 0), p.typed);
      assert.equal(p.groups[0], 0);
      assert.ok(sizes[0] >= 3, 'the first group is never a single');
      // Every group, the last included: 1, 3, 4 or 5 characters, and never two singles in a row.
      for (let k = 0; k < sizes.length; k++) {
        assert.ok([1, 3, 4, 5].includes(sizes[k]), `a group of ${sizes[k]} in ${JSON.stringify(text)}`);
        if (k > 0) assert.ok(!(sizes[k] === 1 && sizes[k - 1] === 1), `two singles in a row in ${JSON.stringify(text)}`);
        counts[sizes[k]]++;
        if (UNBROKEN.includes(text)) unbroken[sizes[k]]++;
        groups++;
      }
      if (sizes.at(-1) === 1) lastSingles++;
      fills++;
    }
  }
  const unbrokenGroups = Object.values(unbroken).reduce((a, b) => a + b, 0);
  t.diagnostic(`shares (all groups, the last included): ${[1, 3, 4, 5].map(size => `${size}: ${(counts[size] / groups).toFixed(3)}`).join(', ')}; `
    + `unbroken ${[1, 3, 4, 5].map(size => `${size}: ${(unbroken[size] / unbrokenGroups).toFixed(3)}`).join(', ')}; a single last in ${(lastSingles / fills).toFixed(3)} of fills`);
  // Spread across 3, 4 and 5 (each 22-45% of groups: none dominating, none nearly absent); singles about one group
  // in 17 (3-8%); a lone last character about as rare (2-8% of fills).
  for (const size of [3, 4, 5]) assert.ok(counts[size] / groups > 0.22 && counts[size] / groups < 0.45, `${size}: ${counts[size] / groups}`);
  assert.ok(counts[1] / groups > 0.03 && counts[1] / groups < 0.08, `singles ${counts[1] / groups}`);
  assert.ok(lastSingles / fills > 0.02 && lastSingles / fills < 0.08, `single last ${lastSingles / fills}`);
  // With no natural break to snap to, 3, 4 and 5 each 25-42%.
  for (const size of [3, 4, 5]) assert.ok(unbroken[size] / unbrokenGroups > 0.25 && unbroken[size] / unbrokenGroups < 0.42, `unbroken ${size}: ${unbroken[size] / unbrokenGroups}`);
});

test('the tail is balanced: no group of 2, and a group of 1 or 2 only where the whole value is that short', () => {
  // Values of 1 to 4 characters are one group (so a 1- or 2-character value is the only 1- or 2-character group
  // that is not a single); from 5 characters every group is 3-5 or a single: 5 is 5 (or 4 and a lone last), 6 is 3+3,
  // 7 is 3+4 or 4+3 (or 3+3 and a lone last), never 5+1 or 5+2.
  const random = seeded(18);
  const seen = new Map();
  for (let length = 1; length <= 30; length++) {
    for (let i = 0; i < 600; i++) {
      for (const [blind, text] of [[false, 'abcdefghijklmnopqrstuvwxyz0123'.slice(0, length)], [false, 'the cat sat on a big red mat ok'.slice(0, length)], [true, 'x'.repeat(length)]]) {
        const sizes = groupSizes(plan(text, { session: session(i + 1), random, blind, ...UNBOUNDED }));
        if (length < 5) {
          assert.deepEqual(sizes, [length]);
          continue;
        }
        assert.ok(sizes.every(size => size !== 2), `${JSON.stringify(text)}: ${sizes}`);
        if (length <= 7) seen.set(`${length}:${sizes.join('+')}`, true);
      }
    }
  }
  const shapes = [...seen.keys()].sort();
  for (const shape of ['6:3+3', '7:3+4', '7:4+3']) assert.ok(shapes.includes(shape), `${shape} in ${shapes}`);
  for (const shape of ['6:5+1', '7:5+2', '6:4+2', '7:5+1+1', '5:3+2']) assert.ok(!shapes.includes(shape), `${shape} in ${shapes}`);
});

test('groups prefer natural breaks within reach (word starts, symbols, a capital), a secret\'s never look', t => {
  const random = seeded(14);
  const kind = ch => (ch === ' ' ? 'space' : /[a-z]/i.test(ch) ? 'letter' : /\d/.test(ch) ? 'digit' : 'symbol');
  const shifted = ch => /^[A-Z~!@#$%^&*()_+{}|:"<>?]$/.test(ch);
  const natural = (chars, i) => chars[i] !== ' ' && (kind(chars[i]) !== kind(chars[i - 1]) || (shifted(chars[i]) && !shifted(chars[i - 1])));
  const hits = { false: 0, true: 0 };
  const starts = { false: 0, true: 0 };
  for (let i = 0; i < 3000; i++) {
    const text = SENTENCES[i % SENTENCES.length];
    const chars = Array.from(text);
    for (const blind of [false, true]) {
      const p = plan(text, { session: session(i + 1), random, blind, ...UNBOUNDED });
      for (const g of p.groups.slice(1)) {
        if (natural(chars, p.strokes[g].index)) hits[blind]++;
        starts[blind]++;
      }
    }
  }
  t.diagnostic(`group starts on a natural break: ${(hits.false / starts.false).toFixed(2)}, blind ${(hits.true / starts.true).toFixed(2)}`);
  assert.ok(hits.false / starts.false > 0.55 && hits.false / starts.false > 2 * hits.true / starts.true, `on a natural break: ${hits.false / starts.false}`);
  assert.ok(hits.true / starts.true < 0.45, `blind, by chance only: ${hits.true / starts.true}`);
});

test('a capital stays with its word: a group starts on the letter after it no more often than after a small letter', t => {
  // The second letter of a word: after a capital ("O|slo") against after a small letter ("o|n"), same texts.
  const random = seeded(19);
  const texts = ['Maria Gonzalez', ...SENTENCES];
  const at = { capital: [0, 0], small: [0, 0] };
  for (let i = 0; i < 6000; i++) {
    const text = texts[i % texts.length];
    const chars = Array.from(text);
    const p = plan(text, { session: session(i + 1), random, ...UNBOUNDED });
    const starts = new Set(p.groups.map(g => p.strokes[g].index));
    for (let k = 1; k + 1 < chars.length; k++) {
      if (!/[a-z]/.test(chars[k]) || (k > 1 && /[a-z]/i.test(chars[k - 2]))) continue;
      const which = /[A-Z]/.test(chars[k - 1]) ? 'capital' : /[a-z]/.test(chars[k - 1]) ? 'small' : null;
      if (!which) continue;
      at[which][0] += starts.has(k) ? 1 : 0;
      at[which][1]++;
    }
  }
  const capital = at.capital[0] / at.capital[1];
  const small = at.small[0] / at.small[1];
  t.diagnostic(`a group starts on a word's second letter: after a capital ${capital.toFixed(3)}, after a small letter ${small.toFixed(3)}`);
  assert.ok(at.capital[1] > 5000 && at.small[1] > 5000);
  assert.ok(capital <= small * 1.1 + 0.005, `after a capital ${capital}, after a small letter ${small}`);
});

test('bursts: quick and even inside a group, a clearly longer and widely varied pause between groups', t => {
  const within = [];
  const between = [];
  const fillCv = [];
  const lowerCv = [];
  const changes = [];
  const holds = [];
  for (const { text, plan: p } of corpus({ fills: 2000, texts: GROUP_TEXTS, slips: true })) {
    const g = groupGaps(p);
    within.push(...g.within);
    between.push(...g.between);
    if (g.within.length >= 4) {
      fillCv.push(sd(g.within) / mean(g.within));
      if (/^[a-z ]+$/.test(text)) lowerCv.push(sd(g.within) / mean(g.within));
    }
    // How much one gap inside a group differs from the one before it in that group.
    const starts = new Set(p.groups);
    const order = p.events.filter(e => e.type === 'down');
    for (let k = 2; k < order.length; k++) {
      if (starts.has(order[k].index) || starts.has(order[k - 1].index)) continue;
      if ([k, k - 1, k - 2].some(j => p.strokes[order[j].index].back)) continue;
      changes.push(Math.abs((order[k].at - order[k - 1].at) - (order[k - 1].at - order[k - 2].at)));
    }
    const downAt = new Map();
    for (const e of p.events) {
      if (e.type === 'down') downAt.set(e.index, e.at);
      else if (e.type === 'up') holds.push(e.at - downAt.get(e.index));
    }
  }
  t.diagnostic(`within: median ${median(within).toFixed(0)} ms, p99 ${quantile(within, 0.99).toFixed(0)}, max ${Math.max(...within).toFixed(0)}, `
    + `SD ${sd(within).toFixed(0)}, CV per fill ${mean(fillCv).toFixed(2)} (lower case ${mean(lowerCv).toFixed(2)}); between: median `
    + `${median(between).toFixed(0)} ms, p5 ${quantile(between, 0.05).toFixed(0)}, max ${Math.max(...between).toFixed(0)}, SD ${sd(between).toFixed(0)}, `
    + `CV ${(sd(between) / mean(between)).toFixed(2)}; holds CV ${(sd(holds) / mean(holds)).toFixed(2)}`);
  // Between groups clearly longer (medians at least 2.5 times apart) and widely spread.
  assert.ok(median(between) > 2.5 * median(within), `between ${median(between)} vs within ${median(within)}`);
  assert.ok(sd(between) / mean(between) > 0.3, `between CV ${sd(between) / mean(between)}`);
  assert.ok(sd(between) > 4 * sd(within), `between SD ${sd(between)} vs within SD ${sd(within)}`);
  // Inside a group: slight irregularity, no big swings. Lower-case text: a CV of 0.04-0.18 per fill; with Shift and
  // symbols (a Shift change inside a group still waits for the key before it to come up) under 0.3 on average.
  assert.ok(mean(lowerCv) > 0.04 && mean(lowerCv) < 0.18, `lower-case within CV ${mean(lowerCv)}`);
  assert.ok(mean(fillCv) > 0.04 && mean(fillCv) < 0.3, `within CV ${mean(fillCv)}`);
  // No gap inside a group comes near a typical pause.
  assert.ok(quantile(within, 0.99) < 0.6 * median(between), `within p99 ${quantile(within, 0.99)} vs between median ${median(between)}`);
  assert.ok(Math.max(...within) < median(between), `within max ${Math.max(...within)}`);
  // Not a metronome: neighbouring gaps in a group are rarely within 1 ms of each other, and holds vary.
  assert.ok(changes.filter(d => d < 1).length / changes.length < 0.1, `equal neighbours ${changes.filter(d => d < 1).length} of ${changes.length}`);
  assert.ok(median(changes) > 3, `median change between neighbouring gaps ${median(changes)}`);
  assert.ok(sd(holds) / mean(holds) > 0.15, `hold CV ${sd(holds) / mean(holds)}`);
  // A ceiling on any gap: an interval (at most ikiMax) and one pause, hesitation or notice beat.
  for (const { plan: p } of corpus({ fills: 3000, texts: GROUP_TEXTS, slips: true, seed: 15 })) {
    for (const gap of gaps(p)) assert.ok(gap < 1300, `gap ${gap}`);
  }
});

test('a 12-character unbroken string pauses 2 to 5 times (2 to 4 in at least 95%); values of 1 to 4 characters never', t => {
  const random = seeded(16);
  const pauses = new Map();
  for (let i = 0; i < 4000; i++) {
    for (const text of ['482915736024', 'qwrtzxcvbnmp']) {
      const p = plan(text, { session: session(i + 1), random, blind: i % 2 === 1, ...UNBOUNDED });
      const n = p.groups.length - 1;
      assert.ok(n >= 2 && n <= 5, `${n} pauses`);
      pauses.set(n, (pauses.get(n) ?? 0) + 1);
    }
  }
  t.diagnostic(`pauses in 12 characters: ${JSON.stringify(Object.fromEntries([...pauses].sort()))} of 8000`);
  assert.ok(((pauses.get(2) ?? 0) + (pauses.get(3) ?? 0) + (pauses.get(4) ?? 0)) / 8000 >= 0.95);
  assert.ok((pauses.get(2) ?? 0) > 1000 && (pauses.get(3) ?? 0) > 1000);
  for (const text of ['a', 'Ab', 'x7!', 'Oslo', 'ab c', '1234']) {
    for (let i = 0; i < 300; i++) {
      for (const blind of [false, true]) {
        const p = plan(text, { session: session(i + 1), random, blind, slips: true, ...UNBOUNDED });
        assert.deepEqual(p.groups, [0]);
        assert.ok(gaps(p).every(gap => gap < 250), `${JSON.stringify(text)}: ${gaps(p)}`);
      }
    }
  }
});

test('slips inside groups: a correction is never split by a pause, and starts a group only sometimes', t => {
  const random = seeded(17);
  let slips = 0;
  let atStart = 0;
  for (let i = 0; i < 3000; i++) {
    const text = GROUP_TEXTS[i % 8];
    const p = plan(text, { session: session(i + 1), random, slips: true, slipRate: 0.2, ...UNBOUNDED });
    assertValid(text, p);
    const starts = new Set(p.groups);
    for (let k = 0; k < p.strokes.length; k++) {
      if (!p.strokes[k + 1]?.back || p.strokes[k].back) continue;
      // From the wrong key (one before, for a late notice) to the last key typed again: no group starts inside.
      const late = p.strokes[k + 2]?.back;
      const first = late ? k - 1 : k;
      const last = late ? k + 4 : k + 2;
      for (let j = first + 1; j <= last; j++) assert.ok(!starts.has(j), `a group starts inside a correction in ${JSON.stringify(text)}`);
      slips++;
      if (starts.has(first)) atStart++;
    }
  }
  t.diagnostic(`slips starting a group: ${atStart} of ${slips}`);
  assert.ok(slips > 1000, `${slips} slips`);
  assert.ok(atStart / slips > 0.05 && atStart / slips < 0.5, `slips starting a group ${atStart}/${slips}`);
});

test('the pause before a group is a draw of its own: right-skewed, widely spread, scaled by the typist', t => {
  // The pause itself (the plan's `pauses`), in multiples of the session's median interval, so the interval's own
  // spread cannot stand in for it: log-normal around 1.2 (sigma 0.45), within 0.6-5.
  const random = seeded(20);
  const ratios = [];
  const ms = { slow: [], fast: [] };
  for (let i = 0; i < 3000; i++) {
    const s = session(i + 1);
    for (const blind of [false, true]) {
      const p = plan(GROUP_TEXTS[i % GROUP_TEXTS.length], { session: s, random, blind, slips: !blind, ...UNBOUNDED });
      assert.equal(p.pauses.length, p.groups.length - 1);
      for (const pause of p.pauses) {
        ratios.push(pause / s.iki);
        if (s.iki > 100) ms.slow.push(pause);
        if (s.iki < 82) ms.fast.push(pause);
      }
    }
  }
  t.diagnostic(`pause / session interval: median ${median(ratios).toFixed(2)}, CV ${(sd(ratios) / mean(ratios)).toFixed(2)}, `
    + `5-95% ${quantile(ratios, 0.05).toFixed(2)}-${quantile(ratios, 0.95).toFixed(2)}; slow typist ${median(ms.slow).toFixed(0)} ms, fast ${median(ms.fast).toFixed(0)} ms`);
  assert.ok(ratios.every(r => r >= params.groupPause[2] - 1e-9 && r <= params.groupPause[3] + 1e-9));
  assert.ok(median(ratios) > 1 && median(ratios) < 1.4, `median ${median(ratios)}`);
  assert.ok(sd(ratios) / mean(ratios) > 0.35, `pause CV ${sd(ratios) / mean(ratios)}`);
  assert.ok(mean(ratios) > median(ratios) * 1.05 && skewness(ratios) > 0.5, `pause skewness ${skewness(ratios)}`);
  assert.ok(quantile(ratios, 0.95) / quantile(ratios, 0.05) > 3, 'widely spread, not a constant');
  assert.ok(median(ms.slow) > median(ms.fast) * 1.15, 'a slower typist pauses longer');
});

test('a hesitation replaces a group\'s pause, never stacks on it', () => {
  // Every group start hesitates (300 ms) while the group's own pause is about 3 times the session interval: replaced,
  // a group's gap is its interval (or, blind, the wait for the key before to come up) and 300 ms, under 3 intervals
  // over 300 ms; stacked, it would be 3 intervals longer than that.
  const ctx = vm.createContext({ navigator: { platform: 'Linux' }, document: { hidden: false }, performance, setTimeout, clearTimeout });
  vm.runInContext(SOURCE, ctx);
  const r = ctx.__faiInput.rhythm;
  Object.assign(r.params, { hesitation: 1, hesitationCap: 1e9, hesitationMs: [300, 300.001], groupPause: [3, 0.01, 2.9, 3.1] });
  for (let i = 0; i < 300; i++) {
    for (const blind of [false, true]) {
      const s = r.session(i + 1);
      const p = JSON.parse(JSON.stringify(r.plan('qwrtzxcvbnmpsdfghjkl', { session: s, random: r.seeded(i + 1), blind, ...UNBOUNDED })));
      assert.equal(p.hesitations, p.groups.length - 1);
      const { between } = groupGaps(p);
      assert.ok(between.length >= 3);
      assert.ok(median(between) - 300 < 3 * s.iki, `${blind ? 'blind' : 'normal'}: ${median(between)} ms with a ${s.iki} ms interval`);
      assert.ok(median(between) - 300 > 0.5 * s.iki);
    }
  }
});

test('Shift, digits and the same finger are slower; common bigrams and a change of hand quicker (damped inside a group)', () => {
  // Two-character values are one group: the context is damped there (inGroupContext), so the margins are smaller
  // than the factors themselves.
  const sample = (text, index) => {
    const random = seeded(77);
    return mean(Array.from({ length: 1500 }, (_, i) => {
      const at = downs(plan(text, { session: session(500 + (i % 50)), random, ...UNBOUNDED }));
      return at[index] - at[index - 1];
    }));
  };
  const plainKey = sample('xk', 1);
  assert.ok(sample('xK', 1) > plainKey * 1.2, 'Shift');
  assert.ok(sample('x7', 1) > plainKey * 1.06, 'digit');
  assert.ok(sample('dc', 1) > sample('df', 1) * 1.08, 'same finger (d, c) slower than another finger of that hand');
  assert.ok(sample('th', 1) < sample('tg', 1) * 0.85, 'a common bigram on alternating hands is quicker');
});

test('hesitations: a group\'s pause now and then (about 1% of keys), 250-550 ms instead, at most 600 ms per fill', () => {
  const random = seeded(21);
  let keys = 0;
  let count = 0;
  let starts = 0;
  let two = 0;
  const text = 'abcdefghij'.repeat(4);
  for (let i = 0; i < 4000; i++) {
    const p = plan(text, { session: session(i + 1), random, ...UNBOUNDED });
    keys += Array.from(text).length - 1;
    starts += p.groups.length - 1;
    count += p.hesitations;
    assert.ok(p.hesitationMs <= params.hesitationCap + 1e-9);
    assert.ok(p.hesitations <= 2);
    if (p.hesitations === 2) two++;
    // Only before a group, in place of its pause (never both): within ikiMax and the longer of the two.
    const g = groupGaps(p);
    assert.ok(g.within.every(gap => gap < params.hesitationMs[0]));
    for (const gap of gaps(p)) assert.ok(gap <= params.ikiMax + Math.max(params.hesitationMs[1], params.groupPause[3] * session(i + 1).iki) + 1e-9);
  }
  const rate = count / keys;
  assert.ok(rate > 0.007 && rate < 0.016, `rate per key ${rate}`);
  assert.ok(count / starts > 0.035 && count / starts < 0.06, `rate per group start ${count / starts}`);
  assert.ok(two > 0, 'two fit within the cap sometimes');
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
  // Typed in full, with groups and slips: a 4-character value always under 0.65 s; 12 digits about 1.2 s and an
  // email address of 24 characters about 2.8 s on average (each within 20%).
  const totals = text => Array.from({ length: 2000 }, (_, i) => plan(text, { session: session(i + 1), random, slips: true, ...UNBOUNDED }).total);
  assert.ok(Math.max(...totals('Oslo'), ...totals('Ab1!')) < 650);
  const digits = mean(totals('482915736024'));
  assert.ok(digits > 1000 && digits < 1450, `12 digits ${digits} ms`);
  const email = mean(totals('ada.lovelace@example.com'));
  assert.ok(email > 2300 && email < 3350, `email ${email} ms`);
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
  const typedShare = [];
  for (let i = 0; i < 1000; i++) {
    const s = session(i + 1);
    for (const length of [100, 400]) {
      const text = LONG.slice(0, length);
      const long = plan(text, { session: s, random, slips: true, budgetMs: 1000, maxTyped: 40 });
      typedShare.push(long.typed);
      assert.ok(long.total <= 1000, `${length}: ${long.total}`);
      assert.ok(long.typed <= 40 && long.typed >= 3);
      assert.equal(long.chunked, true);
      assert.equal(long.slips, 0, 'no slips in a prefix');
      assertValid(text, long);
    }
    const thirty = plan(value(30), { session: s, random, slips: true, budgetMs: 1000, maxTyped: 40 });
    assert.ok(thirty.total <= 1000 * params.slack);
  }
  // The pauses between groups do not eat the typed part of a long value: about 9 characters in the second (10 before
  // groups), never fewer than 8.5 on average.
  assert.ok(mean(typedShare) >= 8.5, `typed ${mean(typedShare)} characters of a long value`);
  assert.equal(plan('abc', { session: session(1), random, budgetMs: 0, maxTyped: 40 }).typed, 0);
  assert.equal(plan('abcdef', { session: session(1), random, budgetMs: 1e6, maxTyped: 4 }).typed, 4);
});

test('a secret is planned from its length alone: same times, groups, pauses, total and prefix whatever it holds; no slips', () => {
  const values = ['aaaaaaaaaaaa', 'Tr0ub4dor&3!', 'ZZZZZZZZZZZZ', 'p@ss W0RD #1', 'ééééééééééé1', 'AbCdEfGhIjKl', 'hello world!'];
  for (const budgetMs of [600, 1e9]) {
    for (let seed = 1; seed <= 300; seed++) {
      const shapes = values.map(value => {
        const p = plan(value, { session: session(seed), random: seeded(seed), blind: true, slips: true, slipRate: 1, budgetMs, maxTyped: 40 });
        assertValid(value, p);
        assert.equal(p.slips, 0);
        const keys = p.events.filter(e => e.type !== 'shift').map(e => [e.type, e.index, e.at]);
        return { keys, groups: p.groups, pauses: p.pauses, total: p.total, typed: p.typed, chunked: p.chunked, hesitations: p.hesitations, hesitationMs: p.hesitationMs };
      });
      for (const shape of shapes.slice(1)) assert.deepEqual(shape, shapes[0]);
    }
  }
  // Two secrets of another length: the same between them too, and still in groups.
  const a = plan('correct horse battery staple', { session: session(3), random: seeded(3), blind: true, ...UNBOUNDED });
  const b = plan('Xy9!Xy9!Xy9!Xy9!Xy9!Xy9!Xy9!', { session: session(3), random: seeded(3), blind: true, ...UNBOUNDED });
  assert.deepEqual(a.groups, b.groups);
  assert.ok(a.groups.length >= 5);
  assert.deepEqual(downs(a), downs(b));
  // Still bursts: with no rollover a key waits for the one before to come up, so holds and flights inside a group are
  // shorter; the pause before a group is at least 2.5 times the gap inside one (medians).
  const within = [];
  const between = [];
  for (const { plan: p } of corpus({ fills: 1500, texts: ['Tr0ub4dor&3!', 'correct horse battery staple'], blind: true, seed: 22 })) {
    const g = groupGaps(p);
    within.push(...g.within);
    between.push(...g.between);
  }
  assert.ok(median(between) >= 2.5 * median(within), `blind: between ${median(between)} vs within ${median(within)}`);
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
