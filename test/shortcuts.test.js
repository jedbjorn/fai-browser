// src/shortcuts.js: the general shortcut machinery. The registry hands a site profile the kinds the shipped tasks
// define (tasks/index.js, a static list), every kind has the interface, and rewriteWithin keeps a kind's URL on the
// page's own origin and path. The kinds themselves are task code: test/tasks-flights.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SHORTCUT_KINDS, isIsoDate, isoDatesIn, rewriteWithin, validKind } from '../src/shortcuts.js';
import { TASKS, TASK_SHORTCUT_KINDS, taskOfKind } from '../tasks/index.js';
import { dateTexts, plainDateIn, stepDate } from '../src/dates.js';

/** A kind for tests: the value is the `page` query parameter of the current URL. */
const PAGE_KIND = {
  target: ({ instruction }) => /page (\d+)/.exec(instruction ?? '')?.[1] ?? null,
  current: url => new URL(url).searchParams.get('page'),
  apply: (url, value) => {
    const next = new URL(url);
    next.searchParams.set('page', value);
    next.hash = '';
    return next.href;
  },
  label: value => `page ${value}`,
};

test('registry: the kinds a profile may name are exactly the shipped tasks\' kinds, each with the interface', () => {
  assert.equal(SHORTCUT_KINDS, TASK_SHORTCUT_KINDS, 'one registry, built from tasks/index.js');
  assert.ok(Object.isFrozen(SHORTCUT_KINDS));
  assert.ok(Object.keys(SHORTCUT_KINDS).length >= 1);
  for (const [id, kind] of Object.entries(SHORTCUT_KINDS)) {
    assert.match(id, /^[a-z][a-z0-9_]{0,39}$/, id);
    assert.ok(validKind(kind), `${id} has target/current/apply/label`);
    assert.ok(Object.isFrozen(kind), `${id} is frozen`);
    const task = taskOfKind(id);
    assert.ok(task && TASKS.includes(task), `${id} belongs to a shipped task`);
    assert.equal(task.shortcutKinds[id], kind);
  }
  assert.equal(taskOfKind('nothing'), null);
  assert.equal(validKind(PAGE_KIND), true);
  assert.equal(validKind({ ...PAGE_KIND, apply: undefined }), false);
  assert.equal(validKind({ ...PAGE_KIND, landed: 'yes' }), false);
  assert.equal(validKind({ ...PAGE_KIND, fromEmpty: 1 }), false);
  assert.equal(validKind(null), false);
});

test('rewriteWithin: a kind\'s URL is taken only on the page\'s own origin and path, reading back the value', () => {
  assert.equal(rewriteWithin(PAGE_KIND, 'https://shop.example/catalog?sort=price&page=1#top', '3'),
    'https://shop.example/catalog?sort=price&page=3');
  assert.equal(rewriteWithin(PAGE_KIND, 'https://shop.example/catalog', '2'), 'https://shop.example/catalog?page=2');
  // Another origin, scheme or path, a non-http URL, a value the kind does not read back, or no URL at all: null.
  const elsewhere = { ...PAGE_KIND, apply: () => 'https://evil.example/catalog?page=3' };
  assert.equal(rewriteWithin(elsewhere, 'https://shop.example/catalog?page=1', '3'), null);
  const otherPath = { ...PAGE_KIND, apply: (url, value) => `${new URL(url).origin}/other?page=${value}` };
  assert.equal(rewriteWithin(otherPath, 'https://shop.example/catalog?page=1', '3'), null);
  const scheme = { ...PAGE_KIND, apply: (url, value) => `http://shop.example/catalog?page=${value}` };
  assert.equal(rewriteWithin(scheme, 'https://shop.example/catalog?page=1', '3'), null);
  const misread = { ...PAGE_KIND, current: () => '9' };
  assert.equal(rewriteWithin(misread, 'https://shop.example/catalog?page=1', '3'), null);
  const broken = { ...PAGE_KIND, apply: () => null };
  assert.equal(rewriteWithin(broken, 'https://shop.example/catalog?page=1', '3'), null);
  assert.equal(rewriteWithin(PAGE_KIND, 'javascript:alert(1)', '3'), null);
  assert.equal(rewriteWithin(PAGE_KIND, 'not a url', '3'), null);
  assert.equal(rewriteWithin(PAGE_KIND, undefined, '3'), null);
  const long = { ...PAGE_KIND, apply: url => `${url}&x=${'a'.repeat(2100)}` };
  assert.equal(rewriteWithin(long, 'https://shop.example/catalog?page=1', '1'), null);
});

test('dates: real calendar dates only; the one plain date a step asks for', () => {
  assert.equal(isIsoDate('2028-02-29'), true);
  assert.equal(isIsoDate('2026-02-29'), false);
  assert.equal(isIsoDate('1999-01-01'), false);
  assert.deepEqual(isoDatesIn('from 2026-10-07 to 2026-10-13, again 2026-10-07; not 2026-10-077 or 12026-10-07'), ['2026-10-07', '2026-10-13']);
  assert.deepEqual(dateTexts({ instruction: 'a', expectation: { textIncludes: 'b', urlIncludes: 'c' } }), ['a', 'b']);
  assert.deepEqual(dateTexts({}), ['']);
  assert.equal(plainDateIn('Show results for 2026-10-08', '2026-10-08'), true);
  for (const text of ['not 2026-10-08', 'Return on 2026-10-08', 'before the 2026-10-08', 'as of 2026-10-08', 'except for 2026-10-08']) {
    assert.equal(plainDateIn(text, '2026-10-08'), false, text);
  }
  assert.equal(stepDate({ instruction: 'Show results for 2026-10-08' }), '2026-10-08');
  assert.equal(stepDate({ instruction: 'Show the next day', expectation: { textIncludes: 'departing 2026-10-08' } }), '2026-10-08');
  assert.equal(stepDate({ instruction: 'Compare 2026-10-08 with 2026-10-09' }), null, 'two dates');
  assert.equal(stepDate({ instruction: 'Show results for Oct 8' }), null, 'no ISO date');
  assert.equal(stepDate({ instruction: 'Show results for 2026-10-08', expectation: { textIncludes: 'not 2026-10-08' } }), null);
  // The host's own text (a step list's template) must name the date too: a filled placeholder is page text.
  assert.equal(stepDate({ instruction: 'Show results for 2026-10-08', template: { instruction: 'Show results for {{answer:1}}' } }), null);
  assert.equal(stepDate({ instruction: 'Show results for 2026-10-08', template: { instruction: 'Show results for 2026-10-08' } }), '2026-10-08');
  assert.equal(stepDate({ instruction: 'Show results for 2026-10-08', template: undefined }), '2026-10-08', 'no template: a plain run');
});
