// Task sub-skills (tasks/): the structure that keeps task know-how out of the core. Each task is tasks/<name>/ with a
// SKILL.md guide the main skill points at and an optional index.js (the task's vocabulary); tasks/index.js lists them
// statically and is the only place src/ takes task code from. Nothing in src/ names a task's site or vocabulary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { TASKS, TASK_ASK_NOUNS } from '../tasks/index.js';
import { isMultiPart } from '../src/digest.js';
import { taskGuides } from '../src/install.js';

const ROOT = resolve(import.meta.dirname, '..');
const read = path => readFileSync(path, 'utf8');
const taskDirs = () => readdirSync(join(ROOT, 'tasks'), { withFileTypes: true })
  .filter(entry => entry.isDirectory() && !entry.name.startsWith('_')).map(entry => entry.name).sort();

/** JavaScript source without its comments (block comments, and line comments not glued to a URL's `//`). */
function code(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

test('tasks/index.js lists every task directory statically; no task code is loaded dynamically or from FAI_HOME', () => {
  const index = read(join(ROOT, 'tasks', 'index.js'));
  const imports = [...index.matchAll(/^import \* as (\w+) from '\.\/([\w-]+)\/index\.js';$/gm)].map(match => match[2]).sort();
  assert.deepEqual(imports, taskDirs().filter(name => existsSync(join(ROOT, 'tasks', name, 'index.js'))));
  assert.deepEqual(TASKS.map(task => task.name).sort(), imports);
  for (const file of ['tasks/index.js', ...taskDirs().map(name => `tasks/${name}/index.js`), 'src/digest.js']) {
    if (!existsSync(join(ROOT, file))) continue;
    const text = code(read(join(ROOT, file)));
    assert.doesNotMatch(text, /\bimport\s*\(/, `${file} has no dynamic import`);
    assert.doesNotMatch(text, /\brequire\s*\(/, `${file} has no require`);
    // Task code never reads a user directory.
    if (file.startsWith('tasks/')) {
      assert.doesNotMatch(text, /FAI_HOME|FAI_DOMAINS_DIR|faiHome|homedir/, `${file} reads no user directory`);
    }
  }
  // The core takes task code from tasks/index.js alone.
  for (const file of readdirSync(join(ROOT, 'src')).filter(name => name.endsWith('.js'))) {
    const text = code(read(join(ROOT, 'src', file)));
    for (const [, specifier] of text.matchAll(/from '(\.\.\/tasks\/[^']+)'/g)) {
      assert.equal(specifier, '../tasks/index.js', `${file} imports task code through the list only`);
    }
  }
});

test('src/ holds no flight- or hotel-specific identifiers; the task vocabulary reaches the core through the list', () => {
  const identifier = /\b(?:flights?[A-Z_]\w*|[a-z]\w*Flights?\b|tfs[A-Z_]\w*|[a-z]\w*Tfs\b|airlines?\w*|carriers?\w*|hotels?[A-Z_]\w*|[a-z]\w*Hotels?\b|booking[A-Z_]\w*|[a-z]\w*Booking\b|checkin[A-Z_]\w*|checkout[A-Z_]\w*)\b/;
  for (const file of readdirSync(join(ROOT, 'src')).filter(name => name.endsWith('.js') && name !== 'psl-data.js')) {
    const text = code(read(join(ROOT, 'src', file)));
    const match = identifier.exec(text);
    assert.equal(match, null, `${file}: ${match?.[0]}`);
    assert.doesNotMatch(text, /Google Flights|google\.com\/travel|Booking\.com|booking\.com|searchresults/i, `${file} names no site`);
  }
  assert.deepEqual([...TASK_ASK_NOUNS], ['airlines?', 'carriers?', 'fares?', 'hotels?', 'propert(?:y|ies)', 'nights?', 'totals?']);
  assert.equal(isMultiPart('What is the cheapest flight, with its airline and price?'), true);
  assert.equal(isMultiPart('What is the fare and the carrier?'), true);
  assert.equal(isMultiPart('Which hotel is cheapest, with its name, price for the stay and rating?'), true);
  assert.equal(isMultiPart('Give the hotel and its price.'), true);
  assert.equal(isMultiPart('What is the price per night and total?'), true);
});

test('every task ships a short SKILL.md guide the main skill points at, installed beside it', () => {
  const guides = taskGuides();
  assert.deepEqual(guides, taskDirs().map(name => `tasks/${name}/SKILL.md`));
  const main = read(join(ROOT, 'skills', 'fai-browser', 'SKILL.md'));
  assert.match(main, /read `tasks\/<name>\/SKILL\.md` beside this file first/);
  for (const name of taskDirs()) {
    const guide = read(join(ROOT, 'tasks', name, 'SKILL.md'));
    const words = guide.split(/\s+/).filter(Boolean).length;
    assert.ok(words >= 150 && words <= 450, `${name}: ${words} words (a guide is about 200-400)`);
    assert.doesNotMatch(guide, /^---\n/, `${name}: a file the main skill points at, not a skill of its own`);
    for (const field of ['fai_browser_open', '`task`', 'expectation: ', 'mode: "interactive"', '`allowedUrls`', '`url`', 'page.digest']) {
      assert.ok(guide.includes(field), `${name} covers ${field}`);
    }
    assert.match(guide, /## Stuck/i, `${name} says what to do when stuck`);
    assert.ok(main.includes(`\`tasks/${name}/SKILL.md\``), `the main skill names tasks/${name}/SKILL.md`);
  }
  // The repository's skill directory reaches the guides through one relative link, so the pointer resolves there
  // and through .claude/skills and .agents/skills.
  const link = join(ROOT, 'skills', 'fai-browser', 'tasks');
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.equal(readlinkSync(link), '../../tasks');
  assert.equal(realpathSync(link), realpathSync(join(ROOT, 'tasks')));
  for (const dir of ['.claude', '.agents']) {
    for (const name of ['flights', 'hotels']) {
      assert.ok(existsSync(join(ROOT, dir, 'skills', 'fai-browser', 'tasks', name, 'SKILL.md')), `${dir}: ${name}`);
    }
  }
  assert.deepEqual(taskDirs(), ['flights', 'hotels'], 'the shipped tasks');
});

test('the hotels guide carries the URL approach, the default guests and the purchase refusal', () => {
  const guide = read(join(ROOT, 'tasks', 'hotels', 'SKILL.md'));
  assert.ok(guide.includes('https://www.booking.com/searchresults.html?ss=Paris&checkin=2027-03-01&checkout=2027-03-04&group_adults=2&group_children=0&no_rooms=1'));
  assert.match(guide, /fill_not_kept/);
  assert.match(guide, /mode: "interactive"/);
  assert.match(guide, /2 adults, 0 children, 1 room/, 'the default guests are visible');
  assert.match(guide, /never put the dates or the place in `urlIncludes`/);
  assert.match(guide, /purchase/i);
  assert.match(guide, /book it themselves/);
  assert.match(guide, /Sponsored/);
  assert.match(guide, /sold-out/i);
});

test('the flights guide carries what the live runs taught', () => {
  const guide = read(join(ROOT, 'tasks', 'flights', 'SKILL.md'));
  assert.ok(guide.includes('https://www.google.com/travel/flights?q=One%20way%20flights%20from%20Marseille%20to%20London%20on%202027-01-12'));
  assert.match(guide, /"Top flights", not "Departing flights"/);
  assert.match(guide, /fill_not_kept/);
  assert.match(guide, /mode: "interactive"/);
  assert.match(guide, /consent\.google\.com/);
});
