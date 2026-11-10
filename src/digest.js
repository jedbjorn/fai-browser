// Task-conditioned page digest and answer candidates.
//
// The host model should not read raw page text. Instead it gets a short digest of the page blocks most relevant to
// the instruction, in document order, plus a ranked list of blocks that may answer the question. Everything here is
// deterministic, synchronous and cheap (well under 2 ms for 200 blocks): plain term overlap with a light stemmer,
// inverse block frequency so navigation words that appear everywhere count for little, and a few structural rules.
//
// Scoring, per block:
//   1. base = sum of idf(term) over the distinct instruction terms the block contains, idf = ln(1 + N / (1 + df));
//   2. price questions add a bonus to blocks with a currency amount, count questions to blocks with a number;
//   3. the result is weighted by block type (headings and table rows up, links and buttons down) and lowered a
//      little for off-screen blocks;
//   4. a matching heading passes its score to the list items, rows or terms right under it and a decaying share to
//      the rest of its section (until the next heading of the same or a higher level); a short label-like block (no
//      sentence punctuation) passes a smaller share to the next few blocks. A block keeps the larger of its own
//      score and its best bonus, plus a tenth of the bonus. This surfaces the list items under "Members" rather
//      than a sentence that only mentions members.
//
// Blocks come from the page script (`observation.blocks`). Older extensions send only `text`; blocks are then
// derived from its lines (see blocksOf).
import { TASK_ASK_NOUNS } from '../tasks/index.js';

// `chart` is a derived view (extension/page.js collectViews): an SVG chart's labels or the values read from its bars.
// Keyed grid rows ("Oct 10 × Oct 17: €312; ...") and grouped result rows ("10:25 AM – 11:40 AM · Air France · €121")
// arrive as ordinary `tr` and `li` blocks.
export const BLOCK_TYPES = ['h1', 'h2', 'h3', 'h4', 'p', 'li', 'tr', 'dt', 'label', 'a', 'button', 'alert', 'select', 'chart'];

export const DIGEST_MAX_BLOCKS = 25;
export const DIGEST_MAX_CHARS = 1500;
export const CANDIDATE_MAX = 12;

const BLOCK_TEXT_LIMIT = 300;
const MAX_BLOCKS = 200;
const MIN_CLIP_CHARS = 40; // a block is clipped into the remaining digest budget only if at least this much fits
const SECTION_WINDOW = 12;
// A results heading is often followed by a subtitle and sort or filter controls before its rows ("Top flights",
// "Ranked based on price and convenience", three buttons, then the rows): at most this many blocks between a heading
// and the row run it passes its score to.
const SECTION_LEAD = 4;
const LABEL_WINDOW = 6;
const LABEL_MAX_CHARS = 40;
// Result lists in the digest: a run of at least RUN_MIN_ROWS contiguous list items or table rows keeps its first rows,
// in order, across every relevant run (round-robin), inside RUN_CHARS_SHARE of the character budget, before any block
// is taken by score alone.
const RUN_MIN_ROWS = 2;
const RUN_CHARS_SHARE = 0.7;

const HEADING_LEVEL = { h1: 1, h2: 2, h3: 3, h4: 4 };
// A keyed grid row from the page script: "Oct 10 × Oct 17: €312; ..." or "Fare: Basic; Bags: 0; Price: €87".
const KEYED_ROW = /^[^|;:]{1,80} × [^|;:]{1,80}: |^[^|;:]{1,80}: [^|;]+(?:; [^|;:]{1,80}: [^|;]+)+$/;
const CONTENT_RUN = new Set(['li', 'tr', 'dt']);
const TYPE_WEIGHT = {
  h1: 1.4, h2: 1.5, h3: 1.5, h4: 1.4, p: 1, li: 1, tr: 1.2, dt: 1.1, label: 0.9, a: 0.6, button: 0.5, alert: 1.2,
  select: 1, chart: 1.3,
};
const VALID_TYPES = new Set(BLOCK_TYPES);

// Question words, filler and generic task words ("listed", "name", "answer only"). Matching on them would favour
// sentences such as "Former contributors are listed in the changelog" over the list the question is about.
// "about" is deliberately absent: it is filler in prose but also a common page name.
const STOPWORDS = new Set(`
a above after again all also am an and answer any are as at be been before being below between both but by
can could did do does doing done each either exact exactly few find for from full further get give go had has have
having he her here hers him his how i if in into is it its itself just let list listed lists me mention mentioned
more most my name named names no nor not now of off on once only or other our out over own please return say says
said see separated comma shown show shows displayed she should so some such tell than that the their them
then there these they this those through to too under until up us very want was we were what when where which while
who whom why will with would you your yours page site value text given
`.trim().split(/\s+/));

const PRICE_INTENT = /\b(price[sd]?|pricing|costs?|how much|fees?|monthly|per month|yearly|annual(ly)?|usd|eur|gbp|dollars?|euros?)\b|[$€£¥]/i;
const COUNT_INTENT = /\b(how many|number of|count|total|quantity|amount of)\b/i;
const CURRENCY = /[$€£¥]\s?\d|\d\s?(usd|eur|gbp|dollars?|euros?)\b/i;
const DIGIT = /\d/;
const SENTENCE_END = /[.!?;:,]$/;
const WORD = /[\p{L}\p{N}]+/gu;

const STEM_CACHE = new Map();
const STEM_CACHE_LIMIT = 20000;

/** Light suffix stripping, enough for "members"/"member", "monthly"/"month" and "pricing"/"price". */
export function stem(word) {
  let cached = STEM_CACHE.get(word);
  if (cached === undefined) {
    if (STEM_CACHE.size >= STEM_CACHE_LIMIT) STEM_CACHE.clear();
    cached = stemUncached(word);
    STEM_CACHE.set(word, cached);
  }
  return cached;
}

function stemUncached(word) {
  let w = word;
  if (/^\d/.test(w)) return w;
  if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  else if (w.length > 5 && w.endsWith('ly')) w = w.slice(0, -2);
  else if (w.length > 4 && /(sses|xes|ches|shes)$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !/(ss|us|is)$/.test(w)) w = w.slice(0, -1);
  if (w.length > 3 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

/** Lowercased, stemmed content words. Stopwords are dropped only when `query` is true. */
export function tokenize(text, { query = false } = {}) {
  const out = [];
  for (const match of String(text ?? '').toLowerCase().matchAll(WORD)) {
    const word = match[0];
    if (query && (STOPWORDS.has(word) || word.length < 2)) continue;
    out.push(stem(word));
  }
  return out;
}

function clip(value, limit) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

/**
 * The observation's blocks, normalized: known types only, text collapsed and clipped to 300 characters, at most
 * 200. Without page-script blocks, they are derived from the text lines: a line equal to a link or button label
 * becomes an `a` or `button` block with that ref, a line with tab-separated cells becomes `tr`, a line equal to the
 * title (the usual h1) becomes `h1`, and every other line is a `p`.
 */
export function blocksOf(observation) {
  if (Array.isArray(observation?.blocks) && observation.blocks.length) {
    const withRecordList = Array.isArray(observation.records) && observation.records.length > 0;
    const cached = withRecordList ? recordMemo.get(observation) : undefined;
    if (cached && cached.blocks === observation.blocks && cached.records === observation.records) return cached.value;
    const blocks = [];
    const origins = [];
    for (const [index, block] of observation.blocks.entries()) {
      if (blocks.length >= MAX_BLOCKS) break;
      const text = clip(block?.text, BLOCK_TEXT_LIMIT);
      if (!text) continue;
      const entry = { t: VALID_TYPES.has(block.t) ? block.t : 'p', text };
      if (block.ref !== undefined && block.ref !== null) entry.ref = String(block.ref);
      if (block.offscreen === true) entry.offscreen = true;
      // Visually hidden status text (extension/page.js visuallyHidden): never a loading placeholder.
      if (block.hidden === true) entry.hidden = true;
      // Inside a popup over the page (extension/page.js detectOverlay): ranked below the main content.
      if (block.overlay === true) entry.overlay = true;
      blocks.push(entry);
      origins.push(index);
    }
    if (!withRecordList) return blocks;
    const value = withRecords(observation, blocks, origins);
    recordMemo.set(observation, { blocks: observation.blocks, records: observation.records, value });
    return value;
  }
  return fallbackBlocks(observation);
}

// ---------------------------------------------------------------------------------------------------------------
// Records (extension/page.js detectRecords): one block per repeated card, tile or row
// ---------------------------------------------------------------------------------------------------------------
//
// A results page's cards arrive as scattered blocks (a heading, a link, a rating line, a price paragraph), so the
// digest interleaved one card's price with the next card's name and the aggregation read prices without names. The
// page script also sends `records`: one entry per member of a detected list, with its title, its visible fields in
// order and the indices of the blocks it covers. A list of at least RECORD_LIST_MIN records replaces its blocks with
// one `li` block per record, in list order, where the list's first block was ("<title> · <field> · <field>", the
// record's own texts, at most 300 characters): every later phase (result runs, answer candidates, fact memory,
// aggregation) then reads a record as one item, its name next to its price and rating. A record that is already one
// row block (a `li` or `tr` the page script grouped) keeps that block's text. Without records (an older extension,
// a page with no repeats) the blocks are as before; the result-list phase and the block scores are the fallbacks.

const recordMemo = new WeakMap();
const RECORD_LIMIT = 60;
const RECORD_LIST_MIN = 3;
const RECORD_FIELD_LIMIT = 160;
const RECORD_FIELDS = 24;
const RECORD_SINGLE = new Set(['li', 'tr']);

/**
 * The observation's records, normalized: `[{ id, list, title, fields, blocks, href?, ref?, hints?, sponsored?,
 * unavailable?, offscreen? }]`, at most 60, page text clipped. Hints are kept only as numbers and short texts.
 */
export function recordsOf(observation) {
  const raw = Array.isArray(observation?.records) ? observation.records : [];
  const out = [];
  const ids = new Set();
  for (const record of raw) {
    if (out.length >= RECORD_LIMIT) break;
    if (!record || typeof record !== 'object') continue;
    const title = clip(record.title, RECORD_FIELD_LIMIT);
    const fields = (Array.isArray(record.fields) ? record.fields : []).map(field => clip(field, RECORD_FIELD_LIMIT))
      .filter(Boolean).slice(0, RECORD_FIELDS);
    if (!title && fields.length < 2) continue;
    const id = clip(record.id, 20) || `r${out.length + 1}`;
    if (ids.has(id)) continue;
    ids.add(id);
    const entry = {
      id, list: Number.isInteger(record.list) && record.list >= 0 ? record.list : 0, title, fields,
      blocks: (Array.isArray(record.blocks) ? record.blocks : []).filter(index => Number.isInteger(index) && index >= 0),
    };
    if (typeof record.href === 'string' && /^https?:/i.test(record.href)) entry.href = record.href.slice(0, 500);
    if (record.ref !== undefined && record.ref !== null) entry.ref = String(record.ref);
    const hints = recordHintsOf(record.hints);
    if (hints) entry.hints = hints;
    for (const flag of ['sponsored', 'unavailable', 'offscreen']) if (record[flag] === true) entry[flag] = true;
    out.push(entry);
  }
  return out;
}

function recordHintsOf(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const hints = {};
  const number = value => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
  if (typeof raw.price === 'string' && raw.price.trim()) hints.price = clip(raw.price, 40);
  if (Array.isArray(raw.prices)) hints.prices = raw.prices.filter(item => typeof item === 'string').slice(0, 4).map(item => clip(item, 40));
  for (const key of ['rating', 'scale', 'reviews']) if (number(raw[key]) !== undefined) hints[key] = raw[key];
  if (Array.isArray(raw.ratings)) {
    const ratings = raw.ratings.filter(item => number(item?.value) !== undefined).slice(0, 4)
      .map(item => (number(item.scale) !== undefined ? { value: item.value, scale: item.scale } : { value: item.value }));
    if (ratings.length) hints.ratings = ratings;
  }
  for (const key of ['when', 'counts']) {
    if (Array.isArray(raw[key])) hints[key] = raw[key].filter(item => typeof item === 'string').slice(0, 3).map(item => clip(item, 80));
  }
  return Object.keys(hints).length ? hints : null;
}

/** A record as one line: its title, then its fields, joined by " · ", whole fields within 300 characters. */
export function recordText(record) {
  const parts = [];
  let length = 0;
  for (const part of [record.title, ...record.fields.filter(field => field !== record.title)]) {
    if (!part) continue;
    const add = (parts.length ? 3 : 0) + part.length;
    if (length + add > BLOCK_TEXT_LIMIT) continue;
    parts.push(part);
    length += add;
  }
  return parts.join(' · ');
}

function withRecords(observation, blocks, origins) {
  const records = recordsOf(observation);
  if (!records.length) return blocks;
  const perList = new Map();
  for (const record of records) {
    if (!perList.has(record.list)) perList.set(record.list, []);
    perList.get(record.list).push(record);
  }
  for (const [list, members] of perList) if (members.length < RECORD_LIST_MIN) perList.delete(list);
  if (!perList.size) return blocks;
  const owner = new Map(); // original block index -> record
  const claims = new Map(); // original block index -> how many records hold it (a grid row of tiles: several)
  for (const members of perList.values()) {
    for (const record of members) {
      for (const index of record.blocks) {
        if (!owner.has(index)) owner.set(index, record);
        claims.set(index, (claims.get(index) ?? 0) + 1);
      }
    }
  }
  // A record whose blocks are one row block keeps that block's text (the page script already joined its fields),
  // unless the row lacks a field with a number the record holds (a rating read from an aria-label, a price the
  // block's 300 characters cut off).
  const single = new Map();
  for (const [i, origin] of origins.entries()) {
    const record = owner.get(origin);
    if (record && record.blocks.length === 1 && claims.get(origin) === 1 && RECORD_SINGLE.has(blocks[i].t)
      && record.fields.every(field => !DIGIT.test(field) || blocks[i].text.includes(field))) single.set(record, blocks[i]);
  }
  const recordBlock = record => {
    const row = single.get(record);
    const entry = { t: row?.t ?? 'li', text: row?.text ?? recordText(record), rec: record.id, record };
    const ref = row?.ref ?? record.ref;
    if (ref !== undefined) entry.ref = ref;
    if (record.offscreen || (row && row.offscreen)) entry.offscreen = true;
    return entry;
  };
  const out = [];
  const placed = new Set();
  for (const [i, block] of blocks.entries()) {
    const record = owner.get(origins[i]);
    if (!record) {
      out.push(block);
      continue;
    }
    if (placed.has(record.list)) continue;
    placed.add(record.list);
    for (const member of perList.get(record.list)) out.push(recordBlock(member));
  }
  // A list none of whose blocks were sent (cut by the page script's cap) still counts, after the other blocks.
  for (const [list, members] of perList) if (!placed.has(list)) for (const member of members) out.push(recordBlock(member));
  return out.slice(0, MAX_BLOCKS);
}

function fallbackBlocks(observation) {
  const labels = new Map();
  for (const control of observation?.controls ?? []) {
    if (control?.sensitive || control?.type === 'password') continue;
    const key = clip(control?.label, BLOCK_TEXT_LIMIT).toLowerCase();
    if (!key || labels.has(key)) continue;
    if (control.role === 'link') labels.set(key, { t: 'a', ref: String(control.id) });
    else if (control.role === 'button') labels.set(key, { t: 'button', ref: String(control.id) });
  }
  const title = clip(observation?.title, BLOCK_TEXT_LIMIT).toLowerCase();
  let titleSeen = false;
  const blocks = [];
  for (const line of String(observation?.text ?? '').split(/\n+/)) {
    if (blocks.length >= MAX_BLOCKS) break;
    const text = clip(line, BLOCK_TEXT_LIMIT);
    if (!text) continue;
    const key = text.toLowerCase();
    const control = labels.get(key);
    if (/\S\t+\S/.test(line)) {
      // innerText separates table cells with tabs.
      blocks.push({ t: 'tr', text });
    } else if (control) {
      blocks.push({ t: control.t, text, ref: control.ref });
    } else if (!titleSeen && title && key === title) {
      titleSeen = true;
      blocks.push({ t: 'h1', text });
    } else {
      blocks.push({ t: 'p', text });
    }
  }
  return blocks;
}

function isHeading(type) {
  return Object.hasOwn(HEADING_LEVEL, type);
}

// buildDigest and pickAnswerCandidates usually run on the same observation and instruction; score once.
const memo = new WeakMap();

/**
 * Score every block against the instruction. Returns `{ blocks, scores, matched, echo }` where `matched[i]` is true
 * when block i itself contains an instruction term (as opposed to inheriting a section bonus) and `echo[i]` when
 * every word of block i is an instruction term ("Members" for a question about members).
 */
export function scoreBlocks(observation, instruction) {
  const key = String(instruction ?? '');
  const cacheable = observation !== null && typeof observation === 'object';
  const hit = cacheable ? memo.get(observation) : undefined;
  if (hit && hit.key === key && hit.source === observation.blocks && hit.text === observation.text) return hit.value;
  const value = computeScores(observation, key);
  if (cacheable) memo.set(observation, { key, source: observation.blocks, text: observation.text, value });
  return value;
}

function computeScores(observation, instruction) {
  const blocks = blocksOf(observation);
  const n = blocks.length;
  const query = [...new Set(tokenize(instruction, { query: true }))];
  const terms = blocks.map(block => new Set(tokenize(block.text)));
  const df = new Map(query.map(term => [term, 0]));
  for (const set of terms) {
    for (const term of query) if (set.has(term)) df.set(term, df.get(term) + 1);
  }
  const idf = new Map(query.map(term => [term, Math.log(1 + n / (1 + df.get(term)))]));
  const priceIntent = PRICE_INTENT.test(String(instruction ?? ''));
  const countIntent = COUNT_INTENT.test(String(instruction ?? ''));

  const querySet = new Set(query);
  const own = new Array(n).fill(0);
  const matched = new Array(n).fill(false);
  const echo = new Array(n).fill(false);
  for (let i = 0; i < n; i++) {
    const block = blocks[i];
    let base = 0;
    for (const term of query) if (terms[i].has(term)) base += idf.get(term);
    matched[i] = base > 0;
    if (matched[i]) {
      const words = tokenize(block.text, { query: true });
      echo[i] = words.length > 0 && words.every(word => querySet.has(word));
    }
    if (priceIntent && CURRENCY.test(block.text)) base += matched[i] ? 1.5 : 0.5;
    else if (countIntent && DIGIT.test(block.text)) base += matched[i] ? 0.75 : 0.25;
    let score = base * (TYPE_WEIGHT[block.t] ?? 1);
    if (block.offscreen) score *= 0.9;
    if (block.overlay) score *= 0.5;
    own[i] = score;
  }

  // Section and label bonuses are computed from the blocks' own scores, so they never chain. A block keeps the
  // larger of its own score and its best bonus, plus a tenth of the bonus: a sentence that merely repeats the
  // topic word ("Former members are in the changelog") must not outrank the list under the "Members" heading.
  const bonus = new Array(n).fill(0);
  const give = (j, value) => {
    if (value > bonus[j]) bonus[j] = value;
  };
  for (let i = 0; i < n; i++) {
    if (!matched[i]) continue;
    const block = blocks[i];
    if (isHeading(block.t)) {
      const level = HEADING_LEVEL[block.t];
      // The section's content run: the first block, and the list items, rows or terms contiguous with it; or, after
      // a short lead (a subtitle, sort or filter controls: at most SECTION_LEAD blocks), the first row run of the
      // section. The lead keeps the decaying share; the rows get the heading's score, as rows right under it would.
      let runStart = i + 1;
      let runType = CONTENT_RUN.has(blocks[i + 1]?.t) ? blocks[i + 1].t : null;
      if (!runType) {
        for (let j = i + 2, k = 1; j < n && k <= SECTION_LEAD; j++, k++) {
          if (isHeading(blocks[j].t)) break;
          if (CONTENT_RUN.has(blocks[j].t)) {
            runStart = j;
            runType = blocks[j].t;
            break;
          }
        }
      }
      let inRun = true;
      for (let j = i + 1, k = 0; j < n && j < runStart + SECTION_WINDOW; j++, k++) {
        const next = blocks[j];
        if (isHeading(next.t) && HEADING_LEVEL[next.t] <= level) break;
        if (j > runStart && next.t !== runType) inRun = false;
        const full = k === 0 || (inRun && j >= runStart);
        give(j, full ? own[i] : own[i] * 0.6 * (1 - 0.04 * k));
      }
    } else if (isLabelLike(block)) {
      for (let j = i + 1, k = 0; j < n && k < LABEL_WINDOW; j++, k++) {
        if (isHeading(blocks[j].t)) break;
        give(j, own[i] * 0.3 * (1 - 0.1 * k));
      }
    }
  }
  const scores = own.map((score, i) => Math.max(score, bonus[i]) + 0.1 * bonus[i]);
  return { blocks, scores, matched, echo };
}

function isLabelLike(block) {
  return (block.t === 'p' || block.t === 'dt' || block.t === 'label')
    && block.text.length <= LABEL_MAX_CHARS
    && !SENTENCE_END.test(block.text);
}

/**
 * Up to `maxBlocks` blocks and about `maxChars` characters of the page, chosen by relevance to the instruction and
 * returned in document order as `{ t, text, ref? }`. Always includes the first h1 and the block right after a
 * matching heading. A result list (resultRuns: a run of list items or table rows under a matching heading, or with
 * rows that match) keeps its heading and its first rows in order, whole, round-robin across the page's result lists
 * inside RUN_CHARS_SHARE of the budget: a results page is read top-down, and its top list is ranked by the site, so
 * the earliest rows of every list come before any block taken by score alone (a later list's rows that happen to
 * hold a question word, or a sentence that only repeats the topic). A selected table row brings the first row of its
 * table (usually the header), unless it is a keyed grid row that already names its headers. When few blocks match,
 * the remaining budget is filled with the leading content blocks so the digest is never empty for a page with text.
 * Returns `{ digest, truncated }`, where `truncated` means relevant blocks (or rows) did not fit.
 */
export function buildDigest(observation, instruction, { maxBlocks = DIGEST_MAX_BLOCKS, maxChars = DIGEST_MAX_CHARS } = {}) {
  const { blocks, scores, matched } = scoreBlocks(observation, instruction);
  const chosen = new Map(); // index -> text (possibly clipped)
  const seen = new Set();
  let chars = 0;
  let truncated = false;

  // `whole`: never clip (a row clipped at the end loses its price).
  const add = (index, { whole = false } = {}) => {
    if (chosen.has(index) || chosen.size >= maxBlocks) return false;
    const block = blocks[index];
    const key = `${block.t}\u0000${block.text}`;
    if (seen.has(key)) return false;
    const room = maxChars - chars;
    let text = block.text;
    if (text.length > room) {
      if (whole || room < MIN_CLIP_CHARS) {
        truncated = true;
        return false;
      }
      text = `${text.slice(0, room - 1)}…`;
    }
    seen.add(key);
    chosen.set(index, text);
    chars += text.length;
    return true;
  };

  // Forced: the first h1, and the block after each matching heading.
  const firstH1 = blocks.findIndex(block => block.t === 'h1');
  if (firstH1 >= 0) add(firstH1);
  for (let i = 0; i < blocks.length - 1; i++) {
    if (matched[i] && isHeading(blocks[i].t)) add(i + 1);
  }

  // Result lists: each run's heading, then the rows round-robin (row 1 of every run, then row 2, ...), whole, until a
  // row no longer fits the rows' share of the budget (characters and blocks).
  const runs = resultRuns(blocks, scores, matched);
  for (const run of runs) if (run.heading !== null) add(run.heading);
  const rowLimit = Math.floor(maxChars * RUN_CHARS_SHARE);
  const rowBlocks = Math.max(1, Math.floor(maxBlocks * RUN_CHARS_SHARE));
  let rowChars = 0;
  let rowCount = 0;
  rows: for (let r = 0; runs.some(run => r < run.rows.length); r++) {
    for (const run of runs) {
      const index = run.rows[r];
      if (index === undefined || chosen.has(index)) continue;
      if (rowChars + blocks[index].text.length > rowLimit || rowCount >= rowBlocks) {
        truncated = true;
        break rows;
      }
      if (add(index, { whole: true })) {
        rowChars += blocks[index].text.length;
        rowCount += 1;
      }
    }
  }

  // By score, highest first; ties in document order.
  const ranked = blocks.map((_, i) => i).filter(i => scores[i] > 0).sort((a, b) => scores[b] - scores[a] || a - b);
  for (const i of ranked) {
    if (chosen.size >= maxBlocks) {
      truncated = true;
      break;
    }
    // A keyed grid row names its own headers: its table's first row would only repeat them.
    if (blocks[i].t === 'tr' && !KEYED_ROW.test(blocks[i].text)) {
      const header = tableStart(blocks, i);
      if (header !== i) add(header);
    }
    add(i);
  }

  // Fill: leading content blocks (not links or buttons), so pages without matches still read.
  for (let i = 0; i < blocks.length && chosen.size < maxBlocks && chars < maxChars - MIN_CLIP_CHARS; i++) {
    if (blocks[i].t === 'a' || blocks[i].t === 'button') continue;
    add(i);
  }

  const digest = [...chosen.keys()].sort((a, b) => a - b).map(i => {
    const entry = { t: blocks[i].t, text: chosen.get(i) };
    if (blocks[i].ref !== undefined) entry.ref = blocks[i].ref;
    if (blocks[i].rec !== undefined) entry.rec = blocks[i].rec;
    return entry;
  });
  return { digest, truncated };
}

/**
 * The page's result lists: runs of at least RUN_MIN_ROWS contiguous list items or table rows (one type), with the
 * heading above them (at most SECTION_LEAD blocks before the run, none of them a row), as `[{ heading, rows }]` in
 * document order. A run counts when its heading matches the instruction or at least RUN_MIN_ROWS of its rows score
 * (a menu of plain links under no matching heading does not). A keyed grid (rows that name their own headers, such
 * as a date grid) is a matrix the question names one cell of, not a ranked list: its rows are taken by score alone.
 */
function resultRuns(blocks, scores, matched) {
  const runs = [];
  for (let i = 0; i < blocks.length;) {
    const type = blocks[i].t;
    if (!ROW_BLOCK_TYPES.has(type)) {
      i++;
      continue;
    }
    let j = i;
    while (j < blocks.length && blocks[j].t === type) j++;
    if (j - i >= RUN_MIN_ROWS && !(type === 'tr' && KEYED_ROW.test(blocks[j - 1].text))) {
      let heading = null;
      for (let k = i - 1; k >= 0 && k >= i - 1 - SECTION_LEAD; k--) {
        if (ROW_BLOCK_TYPES.has(blocks[k].t)) break;
        if (isHeading(blocks[k].t)) {
          heading = k;
          break;
        }
      }
      const rows = Array.from({ length: j - i }, (_, k) => i + k);
      if ((heading !== null && matched[heading]) || rows.filter(k => scores[k] > 0).length >= RUN_MIN_ROWS) {
        runs.push({ heading, rows });
      }
    }
    i = j;
  }
  return runs;
}

/** Index of the first `tr` in the contiguous run of rows containing index i. */
function tableStart(blocks, i) {
  let j = i;
  while (j > 0 && blocks[j - 1].t === 'tr') j--;
  return j;
}

/**
 * Blocks that may answer the instruction, best first, as `{ t, text, ref?, index, score }`. Left out: headings
 * and blocks that only repeat instruction words (they label an answer rather than state it), blocks with no
 * relevance, and duplicate texts. The runtime ranks them with heuristicConfidences.
 */
export function pickAnswerCandidates(observation, instruction, { max = CANDIDATE_MAX } = {}) {
  const { blocks, scores, echo, matched } = scoreBlocks(observation, instruction);
  const seen = new Set();
  const out = [];
  // List questions: the item run under the best matching heading is one candidate, not one row per item.
  const run = classifyIntent(instruction) === 'list' ? listRun(blocks, scores, matched) : null;
  const inRun = new Set(run?.items ?? []);
  const ranked = blocks.map((_, i) => i)
    .filter(i => scores[i] > 0 && !isHeading(blocks[i].t) && !echo[i] && !inRun.has(i))
    .sort((a, b) => scores[b] - scores[a] || a - b);
  const entries = ranked.map(i => {
    const entry = { t: blocks[i].t, text: blocks[i].text, index: i, score: Math.round(scores[i] * 1000) / 1000 };
    if (blocks[i].ref !== undefined) entry.ref = blocks[i].ref;
    return entry;
  });
  if (run) {
    const entry = { t: 'list', text: run.text, index: run.items[0], score: run.score, items: run.items.length };
    const at = entries.findIndex(other => other.score < entry.score);
    entries.splice(at < 0 ? entries.length : at, 0, entry);
  }
  for (const entry of entries) {
    if (out.length >= max) break;
    const key = entry.text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

const LIST_TEXT_LIMIT = 300;
const LIST_MAX_ITEMS = 30;

/**
 * The best list under a matching heading: at least two contiguous `li`/`tr`/`dt` blocks right after it (a table's
 * first row, usually the header, is skipped when the rest are rows). Returns `{ items, text, score }` or null.
 */
function listRun(blocks, scores, matched) {
  let best = null;
  for (let i = 0; i < blocks.length - 2; i++) {
    if (!matched[i] || !isHeading(blocks[i].t)) continue;
    const type = blocks[i + 1].t;
    if (!CONTENT_RUN.has(type)) continue;
    const items = [];
    for (let j = i + 1; j < blocks.length && blocks[j].t === type && items.length < LIST_MAX_ITEMS; j++) items.push(j);
    if (items.length < 2) continue;
    const score = Math.round((Math.max(...items.map(j => scores[j])) + 0.01) * 1000) / 1000;
    if (!best || score > best.score) {
      const text = items.map(j => blocks[j].text).join('; ');
      best = { items, score, text: text.length > LIST_TEXT_LIMIT ? `${text.slice(0, LIST_TEXT_LIMIT - 1)}…` : text };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------------------------
// Answer intent, shape and the auto-confirm rule (docs/design/OVERSIGHT-SPEC.md 1.2)
// ---------------------------------------------------------------------------------------------------------------

// "once it has loaded" and "after a short delay" are the bench phrasings the first classifier missed (it caught the
// slow-content instruction only through "finish loading").
const LATE_INTENT = /\b(after (?:it|the (?:page|content|list|data|section)) (?:loads?|appears?|has loaded)|finish(?:es|ed)? loading|loads? (?:late|slowly)|late[- ]load(?:ed|ing)?|once (?:(?:it|the \w+)(?:'s| is| has)? )?(?:finished )?loaded|wait (?:for|until)|after (?:a|the) (?:short |brief )?delay|delayed (?:section|content|text|block|panel)|eventually)\b/i;

// A loading placeholder: a short block that starts with a loading word and ends in an ellipsis or is at most five
// words ("Loading reconciliation status…", "Please wait", "Fetching results..."), or is only an ellipsis. A sentence
// such as "Loading times are shown below for every region." is content. Late content is not there while one shows.
const LOADING_START = /^\s*(?:(?:still |now )?loading\b|fetching\b|retrieving\b|please wait\b|one moment\b|updating\b)/i;
const ELLIPSIS_END = /(?:…|\.{2,})\s*$/;
const LOADING_MAX_CHARS = 100;
const LOADING_MAX_WORDS = 5;
const LOADING_BLOCK_TYPES = new Set(['p', 'li', 'tr', 'dt', 'h1', 'h2', 'h3', 'h4', 'label', 'alert']);

/** Whether a block's text is a loading placeholder rather than content. */
export function isLoadingText(text) {
  const value = String(text ?? '').trim();
  if (!value || value.length > LOADING_MAX_CHARS) return false;
  if (/^(?:…|\.{3,})$/.test(value)) return true;
  if (!LOADING_START.test(value)) return false;
  return ELLIPSIS_END.test(value) || value.split(/\s+/).length <= LOADING_MAX_WORDS;
}

/**
 * The content blocks of an observation that are still loading placeholders (links and buttons excluded). A block the
 * page script marked visually hidden (`hidden: true`: a 1px or clipped screen-reader status such as Google Flights'
 * "Loading results") is not a placeholder anyone sees, and `persistent` (a Set of trimmed texts the runtime saw survive
 * a settle wait on a page that carries content, src/runtime.js awaitContent) is not loading either: both are left out,
 * but only on a page with at least PERSISTENT_MIN_ROWS rows of its own.
 */
export function loadingBlocks(observation, persistent = null) {
  const blocks = blocksOf(observation ?? {});
  const loading = blocks.filter(block => LOADING_BLOCK_TYPES.has(block.t) && isLoadingText(block.text));
  // Hidden or persistent status text is skipped only on a page that carries rows of its own: on an empty results
  // page the same text (a live region next to text-less skeleton rows) is the only sign of a real load.
  if (!loading.length || contentRows(blocks) < PERSISTENT_MIN_ROWS) return loading;
  return loading.filter(block => !block.hidden && !persistent?.has(String(block.text).trim()));
}

const ROW_BLOCK_TYPES = new Set(['li', 'tr']);
const PERSISTENT_MIN_ROWS = 3;

/** The list and table rows of `blocks` that carry text and are not loading placeholders themselves. */
function contentRows(blocks) {
  return blocks.filter(block => ROW_BLOCK_TYPES.has(block.t) && !isLoadingText(block.text)
    && String(block.text ?? '').trim()).length;
}

/**
 * Whether `placeholders` (loading blocks of `current`) are persistent status text rather than loading: every one of
 * them was already there in `previous` (one settle wait earlier), nothing else in the content changed between the two
 * observations, and the page carries content of its own (at least three list or table rows besides them). A real
 * placeholder ("Loading reconciliation status…" on an otherwise empty section) keeps its waits.
 */
export function persistentPlaceholders(previous, current, placeholders) {
  if (!previous || !placeholders.length) return false;
  const before = new Set(loadingBlocks(previous).map(block => String(block.text).trim()));
  if (!placeholders.every(block => before.has(String(block.text).trim()))) return false;
  const loading = new Set(placeholders.map(block => String(block.text).trim()));
  const content = observation => blocksOf(observation ?? {})
    .filter(block => !loading.has(String(block.text ?? '').trim()))
    .map(block => `${block.t}\u0000${String(block.text ?? '').trim()}`);
  const now = content(current);
  const then = content(previous);
  if (now.length !== then.length || now.some((entry, index) => entry !== then[index])) return false;
  return contentRows(blocksOf(current)) >= PERSISTENT_MIN_ROWS;
}
const NTH_INTENT = /\b(second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|\d+(?:st|nd|rd|th)|last|nth|penultimate)\b|\bthe first \w*\s?(?:item|row|entry|result|product|one|listing)\b/i;
const LIST_INTENT = /\b(list (?:all|the|every)|all (?:the )?(?:\w+ )?(?:names|members|items|people|products|entries)|every \w+|which \w+(?: \w+)? are (?:listed|shown|named|there)|names of|who are (?:the|all))\b/i;
const NAME_INTENT = /\b(who|whose|name of|what is the name|which person|called|named)\b/i;
// A time of day or opening hours: "the opening hours", "the help desk hours", "what time is high tide", "the first
// departure time", "when does the office open". Checked before list and name ("the office led by the person who ...").
const HOURS_INTENT = /\b(?:(?:opening|office|business|desk|store|shop|working|visiting|service|support|trading|counter) hours|hours of (?:operation|business)|open(?:ing)? times?|(?:what|which) time\b|(?:departure|arrival|start|end|opening|closing|check-?in|check-?out|pick-?up) times?|when (?:does|do|is|are|will) (?:\S+ ){1,6}?(?:open|close|depart|leave|arrive|start|begin|end)s?\b)/i;
// A share, duration, frequency or measured amount: "what share of traffic", "what percentage", "how long are backups
// kept", "how often are metrics scraped", "how much storage does the plan include". Checked after count and hours;
// "how much <noun>" is a quantity, not a price, unless the question also names a price word ("how much does it cost",
// "how much is Pro" stay price). Its answer holds an amount with its unit ("35 days", "5%", "every 30 seconds", "250
// GB", "two weeks") or a frequency word ("daily"), once money amounts are set aside: neither a breadcrumb or heading of
// the page that has the number, nor a price row whose only other number is a bare cell (threshold 0.80 pass: "› › ›
// Canary releases" at 0.84-0.87 for "What share of traffic do canaries receive?"; "Pro | $37 per month | $370 per year
// | 10" at 0.87-0.90 for "How much storage does the Oslo office's plan include?").
const QUANTITY_INTENT = /\b(?:what (?:share|percentage|percent|proportion|fraction|portion|ratio)|how (?:long|often|frequently|far|big|large|old|tall|wide|deep|heavy|fast|soon|many times))\b/i;
const HOW_MUCH_MEASURE = /\bhow much (?!(?:does|do|did|is|are|was|were|will|would|can|could|should|has|have|for|to|it|this|that|money|cash|more|less|extra|per)\b)[a-z]+/i;
const NUMBER_WORD = String.raw`(?:\d[\d.,]*|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|ninety|hundred|thousand|a few|several|half an?))`;
const QUANTITY_SHAPE = new RegExp(String.raw`(?:${NUMBER_WORD})\s?(?:%|(?:per ?cent|percent)\b|(?!(?:and|or|to|of|per|x|×)\b)[a-z]{1,12}\b)|\b(?:half|quarter|third|dozen|once|twice|hourly|daily|nightly|weekly|fortnightly|monthly|quarterly|yearly|annually|forever|indefinitely|unlimited|every (?:day|night|week|month|quarter|year|hour|minute|second))\b`, 'i');

/** Whether a text holds an amount with its unit or a frequency word, money amounts set aside (a quantity answer). */
export function hasQuantityShape(text) {
  return QUANTITY_SHAPE.test(String(text ?? '').replace(MONEY, ' '));
}
// A breadcrumb or navigation trail ("Home › Guides › Deployment", "› › › Canary releases"): at least two trail
// separators, or a leading one, in a short text. It names where the page is, never a value on it.
const TRAIL_SEPARATOR = /\s*[›»]\s*|\s+[>/]\s+/g;

/** Whether a candidate text is a navigation trail rather than content (never auto-confirmed). */
export function isNavigationTrail(text) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!value || value.split(' ').length > 16) return false;
  const separators = value.match(TRAIL_SEPARATOR)?.length ?? 0;
  return separators >= 2 || /^[›»>/]/.test(value);
}

// A time of day (09:00, 9.30, 9am, 17h30, noon) or a whole-day state (24/7, closed).
const TIME_SHAPE = /\b(?:[01]?\d|2[0-4])[:.h][0-5]\d\b|\b\d{1,2}\s?(?:am|pm|a\.m\.|p\.m\.)(?![\p{L}])|\b(?:noon|midday|midnight|24\s?\/\s?7|closed)\b/iu;

/**
 * The question's answer intent: late (late-loaded content), nth (an ordinal item), count, price, hours (a time of
 * day or opening hours), quantity (a share, duration, frequency or size), list, name or other. Checked in that order, so "How many members are listed?" is a count,
 * "the third item's price" an nth and "the opening hours of the office the person who handles billing leads" hours.
 */
export function classifyIntent(question, instruction = '') {
  const text = String(question ?? '');
  if (LATE_INTENT.test(text) || LATE_INTENT.test(String(instruction ?? ''))) return 'late';
  if (NTH_INTENT.test(text)) return 'nth';
  if (COUNT_INTENT.test(text)) return 'count';
  if (HOW_MUCH_MEASURE.test(text) && !PRICE_INTENT.test(text.replace(/\bhow much\b/gi, ' '))) return 'quantity';
  if (PRICE_INTENT.test(text)) return 'price';
  if (HOURS_INTENT.test(text)) return 'hours';
  if (QUANTITY_INTENT.test(text)) return 'quantity';
  if (LIST_INTENT.test(text)) return 'list';
  if (NAME_INTENT.test(text)) return 'name';
  return 'other';
}

const NAME_SHAPE = /\p{Lu}\p{Ll}+/u;

/**
 * Whether the candidate text has the shape the intent needs: price → currency, count → digit, hours → a time of day,
 * quantity → a number or a frequency word, list → ≥ 2 items.
 */
export function answerShape(intent, candidate) {
  const text = String(candidate?.text ?? candidate ?? '');
  switch (intent) {
    case 'price':
      return CURRENCY.test(text);
    case 'count':
      return DIGIT.test(text);
    case 'hours':
      return TIME_SHAPE.test(text);
    case 'quantity':
      return hasQuantityShape(text);
    case 'list':
      return candidate?.t === 'list' && (candidate.items ?? 0) >= 2;
    case 'name':
      return NAME_SHAPE.test(text);
    case 'nth':
    case 'late':
      return false;
    default:
      return text.trim().length > 0;
  }
}

// The intents a page can be checked for deterministically: a page without a line of the shape cannot answer.
const PAGE_SHAPES = { price: CURRENCY, count: DIGIT, hours: TIME_SHAPE };

/** Intents never auto-confirmed: one candidate rarely holds a list, and Nth items and late text were wrong 11/11. */
const NO_AUTO_INTENTS = new Set(['list', 'nth', 'late']);

function round2(value) {
  return Math.round(value * 100) / 100;
}

/**
 * The auto-confirm rule: a ranked (method `provider`; the heuristic ranking never sets it) top candidate is at least
 * `answerConfirm`, has the intent's shape,
 * leads the second by at least `answerMargin`, and the intent is not list, Nth or late-load. Returns
 * `{ answer: {text, confidence, basis} | null, intent, why }`; `why` lists the machine reasons it was rejected.
 */
export function autoConfirm(answer, { question = '', instruction = '', thresholds = {} } = {}) {
  const confirm = thresholds.answerConfirm ?? 0.8;
  const margin = thresholds.answerMargin ?? 0.5;
  const intent = classifyIntent(question, instruction);
  const candidates = Array.isArray(answer?.candidates) ? answer.candidates : [];
  const why = [];
  const top = candidates[0];
  if (!top) return { answer: null, intent, why: ['answer:none'] };
  if (answer.method !== 'provider') why.push('answer:not_ranked');
  if (NO_AUTO_INTENTS.has(intent)) why.push(`answer:intent_${intent}`);
  const confidence = Number(top.confidence);
  if (!(confidence >= confirm)) why.push('answer:low_confidence');
  const shapeCandidate = { text: top.text, t: top.source?.t ?? top.t, items: top.items };
  if (!NO_AUTO_INTENTS.has(intent) && !answerShape(intent, shapeCandidate)) why.push(`answer:shape_${intent}`);
  // A placeholder is never an answer, whatever the intent classifier said about the question.
  if (isLoadingText(top.text)) why.push('answer:loading_text');
  // Nor is a breadcrumb: it names where the page is, whatever the question asked.
  if (isNavigationTrail(top.text)) why.push('answer:navigation_trail');
  const second = Number(candidates[1]?.confidence) || 0;
  const lead = confidence - second;
  if (!(lead >= margin)) why.push('answer:margin');
  if (why.length) return { answer: null, intent, why };
  const basis = [`candidate>=${confirm}`, `shape:${intent}`, `margin:${round2(lead)}`];
  let value = answerValue(top.text, { intent, question });
  // A question that asks for two things ("who ... and what is the title ...") is confirmed only when the one line
  // carries both, kept whole: a byline for a question about a person and a work, or a line with the asked price (or
  // count, hours) beside other text for "which ... and what does it cost", or an aggregation's item line (the item
  // with the measure it was ranked by). Any other line may answer one part.
  if (isMultiPart(question)) {
    const line = String(top.text ?? '').replace(/\s+/g, ' ').trim();
    const rule = bylineAnswersBoth(value, question) ? 'byline_whole'
      : top.aggregate !== undefined ? 'multi_part_line' : shapedAnswersBoth(value, line, intent, question);
    if (!rule) return { answer: null, intent, why: ['answer:multi_part'] };
    value = { text: line, exact: rule === 'byline_whole' || !isCompound(line), rule };
  }
  const confirmed = { text: value.text, confidence, basis };
  if (value.rule) basis.push(`value:${value.rule}`);
  if (value.text !== String(top.text ?? '').trim()) confirmed.line = String(top.text ?? '').trim();
  if (!value.exact) confirmed.exact = false;
  return { answer: confirmed, intent, why: [] };
}

// ---------------------------------------------------------------------------------------------------------------
// The answer value inside an auto-confirmed block. Rankings cover whole page blocks, so the top candidate is
// often a table row ("Pro | $37 per month | $370 per year | 10"), a byline ("Migrating Ledgers to Version Two by
// Priya Raman") or a sentence. Strong hosts trim it; weaker hosts (bench matrix-2: Luna, Terra) copy verbatim and
// fail. These narrow rules cut out the value when the block's structure makes it unambiguous; otherwise the block is
// returned with exact: false so the receipt tells the host to reply with only the requested part.
// ---------------------------------------------------------------------------------------------------------------

const MONEY = /(?:[$€£¥]\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s?(?:usd|eur|gbp|dollars?|euros?)\b)(?:\s*(?:per|a|an|\/)\s*(?:month|mo|year|yr|annum|week|day|seat|user)\b)?/gi;
const PERIOD_WORDS = [
  { ask: /\b(month(?:ly)?|per month|a month|\/mo)\b/i, has: /\b(month|mo)\b/i },
  { ask: /\b(year(?:ly)?|annual(?:ly)?|per year|a year)\b/i, has: /\b(year|yr|annum)\b/i },
];
const WHO_QUESTION = /\b(who|whose|whom|author|which person|what person|name of the (?:person|author|member|writer))\b/i;
const PERSON = String.raw`\p{Lu}[\p{L}'’.-]+(?:\s+\p{Lu}[\p{L}'’.-]+){1,3}`;
const BYLINE = new RegExp(String.raw`^(.{3,}?)\s+by\s+(${PERSON})\s*$`, 'u');
const BYLINE_QUESTION = /\b(titles?|titled|guides?|articles?|books?|posts?|papers?|stor(?:y|ies)|written|wrote|writes|authors?|who|whose)\b/i;
const ROLE_LINE = new RegExp(String.raw`^(${PERSON})\s+[—–-]\s+(.{2,})$`, 'u');
const LABEL_LINE = /^([\p{L}][\p{L}\p{N} ]{0,40}):\s+(\S.*)$/u;
const HEADER_QUESTION = /\bheaders?\b/i;
const HEADER_TOKEN = /\b(?:[A-Z][A-Za-z0-9]*-)+[A-Z][A-Za-z0-9]*\b/g;
const SENTENCE_SPLIT = /[.!?](?:\s|$)/;

// A question that asks for two things: a second wh-clause after "and", "as well as", "plus", "along with" or "; "
// ("who is the docs lead and what is the title of their guide", "which plan and how much"), two question marks, or
// two question nouns joined ("name and email", "the docs lead and the title of their guide"). "And" inside a noun
// phrase ("the sales and support office", "terms and conditions", "bed and breakfast") is not a second part.
const WH = String.raw`(?:who|whom|whose|what|which|when|where|why|how)`;
const JOIN = String.raw`(?:and|as well as|plus|along with)`;
// The general nouns, plus the nouns the shipped task sub-skills ask for (tasks/index.js TASK_ASK_NOUNS: a flights
// question asks for "the airline and price").
const ASK_NOUN = String.raw`(?:names?|e-?mails?|e-?mail address|phone(?: number)?|address|titles?|prices?|costs?|roles?|`
  + String.raw`positions?|dates?|times?|hours|locations?|urls?|links?|authors?|versions?|sizes?|ratings?|deadlines?`
  + TASK_ASK_NOUNS.map(noun => `|${noun}`).join('') + ')';
const MULTI_PART = [
  new RegExp(String.raw`\b${JOIN}\s+(?:also\s+)?${WH}\b`, 'i'),
  new RegExp(String.raw`;\s*(?:and\s+)?${WH}\b`, 'i'),
  new RegExp(String.raw`\b${ASK_NOUN}\s*(?:,|&|\b${JOIN}\b)\s*(?:(?:the|their|its|his|her)\s+)?${ASK_NOUN}\b`, 'i'),
  new RegExp(String.raw`^\s*${WH}\b.*\b${JOIN}\s+(?:the|their|its|his|her)\s+${ASK_NOUN}\s+(?:of|for)\b`, 'i'),
];

/** Whether the question asks for two things (see MULTI_PART), so a value cut to one of them answers only part. */
export function isMultiPart(question) {
  const all = String(question ?? '').replace(/\s+/g, ' ').trim();
  if (!all) return false;
  // Only the asked sentences count: an instruction's "The Contact page lists the offices and who leads each one."
  // describes a page, its question follows.
  const asks = all.split(/(?<=[.!?])\s+/).filter(sentence => sentence.endsWith('?'));
  if (asks.length >= 2) return true;
  const text = asks[0] ?? all;
  return MULTI_PART.some(pattern => pattern.test(text));
}

const WORK_QUESTION = /\b(titles?|titled|guides?|articles?|books?|posts?|papers?|stor(?:y|ies))\b/i;

/** Whether a byline line ("<Title> by <Name>") answers both parts: the question asks for the person and the work. */
function bylineAnswersBoth(value, question) {
  if (value.rule !== 'byline_name' && value.rule !== 'byline_title') return false;
  return WHO_QUESTION.test(question) && WORK_QUESTION.test(question);
}

/**
 * Whether a line answers both parts of "which <item> ... and what does it cost" (or how many, when): the question
 * asks for a price (count, hours) and the value cut from the line is only part of it, so the rest names the item.
 * A compound line returned whole (exact: false) holds the items beside their values. A line that is the value alone
 * answers one part. Returns the rule name or null.
 */
function shapedAnswersBoth(value, line, intent, question) {
  const shaped = PRICE_INTENT.test(question) || /\bfares?\b/i.test(question) ? 'price' : PAGE_SHAPES[intent] ? intent : null;
  if (!shaped || !PAGE_SHAPES[shaped].test(line)) return null;
  if (value.rule && value.text !== line) return 'multi_part_line';
  // A compound line (table row, list of "label: value" pairs) returned whole: the host replies with the asked parts.
  return !value.rule && !value.exact ? 'multi_part_line' : null;
}

function unquote(text) {
  return text.trim().replace(/^["'“‘«]+|["'”’»]+$/g, '').trim();
}

/** Whether a block reads as compound (table cells, several sentences or a long sentence) rather than one value. */
function isCompound(text) {
  if (/\s[|·•]\s/.test(text)) return true;
  const sentences = text.split(SENTENCE_SPLIT).filter(part => part.trim());
  if (sentences.length > 1) return true;
  return text.split(/\s+/).length > 12;
}

/**
 * The requested value inside a candidate block: `{text, exact, rule}`. `rule` names the cut (price, byline_title,
 * byline_name, role_name, header) or is null when the block is returned whole; `exact` is false when the whole block
 * is compound, so the host must reply with only the requested part of it.
 */
export function answerValue(block, { intent = 'other', question = '' } = {}) {
  const text = String(block ?? '').replace(/\s+/g, ' ').trim();
  const asked = String(question ?? '');
  if (!text) return { text, exact: true, rule: null };
  if (intent === 'price' || (intent !== 'quantity' && PRICE_INTENT.test(asked))) {
    const spans = [...text.matchAll(MONEY)].map(match => match[0].trim());
    const period = PERIOD_WORDS.find(entry => entry.ask.test(asked));
    const preferred = period ? spans.filter(span => period.has.test(span)) : spans;
    const unique = [...new Set(preferred.length ? preferred : spans)];
    if (unique.length === 1) return { text: unique[0], exact: true, rule: unique[0] === text ? null : 'price' };
  }
  const who = WHO_QUESTION.test(asked);
  // A "by <Name>" tail is a byline only when the question is about a work or its author ("Sorted by Date Added" is
  // not).
  const byline = BYLINE_QUESTION.test(asked) ? BYLINE.exec(text) : null;
  if (byline) {
    return who
      ? { text: byline[2].trim(), exact: true, rule: 'byline_name' }
      : { text: unquote(byline[1]), exact: true, rule: 'byline_title' };
  }
  const role = ROLE_LINE.exec(text);
  if (role && (who || intent === 'name')) return { text: role[1].trim(), exact: true, rule: 'role_name' };
  if (HEADER_QUESTION.test(asked)) {
    const tokens = [...new Set(text.match(HEADER_TOKEN) ?? [])];
    if (tokens.length === 1 && tokens[0] !== text) return { text: tokens[0], exact: true, rule: 'header' };
  }
  // "Region: eu-west-2" for "Which region ...?": the label repeats the question, the value follows it.
  const labelled = LABEL_LINE.exec(text);
  if (labelled && !isCompound(labelled[2])) {
    const asks = new Set(tokenize(asked, { query: true }));
    const label = tokenize(labelled[1], { query: true });
    if (label.length && label.length <= 4 && label.some(word => asks.has(word))) {
      return { text: labelled[2].trim(), exact: true, rule: 'label' };
    }
  }
  return { text, exact: !isCompound(text), rule: null };
}

/**
 * Heuristic confidences for ranked candidates: each score's share of the total plus a prior mass of 1 for "the
 * answer is not among them", rounded to three decimals. A rough ordering signal, not a calibrated probability.
 */
export function heuristicConfidences(candidates) {
  const total = candidates.reduce((sum, candidate) => sum + candidate.score, 0) + 1;
  return candidates.map(candidate => Math.round((candidate.score / total) * 1000) / 1000);
}
