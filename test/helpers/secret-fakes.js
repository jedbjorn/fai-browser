// The fake secrets of fixtures/secrets/fakes.js (one list for pages and tests) and a leak scanner: every value, its
// URL-encoded and base64 forms and a chunk from its middle, so a partial or re-encoded leak is caught too.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const FAKES_PATH = new URL('../../fixtures/secrets/fakes.js', import.meta.url);

export function loadFakes() {
  const context = {};
  vm.runInNewContext(readFileSync(FAKES_PATH, 'utf8'), context);
  return JSON.parse(JSON.stringify(context.FAKE_SECRETS));
}

/** [{name, needle}] for every fake value. */
export function leakNeedles(fakes = loadFakes()) {
  const values = [];
  for (const [name, value] of Object.entries(fakes)) {
    if (name === 'pem') continue; // its lines are listed one by one (pemLines)
    if (Array.isArray(value)) value.forEach((item, i) => values.push([`${name}[${i}]`, item]));
    else values.push([name, value]);
  }
  const needles = [];
  for (const [name, value] of values) {
    const forms = new Set([value, encodeURIComponent(value), Buffer.from(value).toString('base64').replace(/=+$/, ''),
      Buffer.from(value).toString('base64url')]);
    if (name === 'card') forms.add(value.replace(/\D/g, ''));
    if (value.length >= 16) {
      const middle = Math.floor(value.length / 2);
      forms.add(value.slice(middle - 6, middle + 6));
    }
    for (const needle of forms) needles.push({ name, needle });
  }
  return needles;
}

/** The names of the fakes that appear in `text` (a string, or anything JSON-serializable). */
export function leaks(text, needles = leakNeedles()) {
  const haystack = typeof text === 'string' ? text : JSON.stringify(text);
  return [...new Set(needles.filter(({ needle }) => haystack.includes(needle)).map(({ name }) => name))];
}
