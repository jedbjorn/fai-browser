// Preload for the regression runs with realistic input: every page that a test gives extension/page.js (through
// page.addScriptTag({ path }) or page.evaluate(source)) also gets extension/input.js first, as the extension injects
// both. The suites then run page.js's realistic click, typing, Enter, select and wheel paths instead of the plain
// fallback they exercise on their own.
//   node --import ./test/helpers/real-input.mjs --test --test-concurrency=1 test/<files>
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const INPUT_SOURCE = readFileSync(new URL('../../extension/input.js', import.meta.url), 'utf8');
const patched = new WeakSet();

function patchPage(page) {
  const proto = Object.getPrototypeOf(page);
  if (patched.has(proto)) return page;
  patched.add(proto);
  const addScriptTag = proto.addScriptTag;
  proto.addScriptTag = async function (options = {}) {
    if (typeof options.path === 'string' && options.path.endsWith('extension/page.js')) {
      await addScriptTag.call(this, { content: INPUT_SOURCE });
    }
    return addScriptTag.call(this, options);
  };
  const evaluate = proto.evaluate;
  proto.evaluate = function (fn, arg) {
    if (typeof fn === 'string' && fn.includes('globalThis.__faiPage = {')) fn = `${INPUT_SOURCE}\n${fn}`;
    return evaluate.call(this, fn, arg);
  };
  return page;
}

function patchContext(context) {
  const proto = Object.getPrototypeOf(context);
  if (patched.has(proto)) return context;
  patched.add(proto);
  const newPage = proto.newPage;
  proto.newPage = async function (...args) {
    return patchPage(await newPage.apply(this, args));
  };
  return context;
}

function patchBrowser(browser) {
  const proto = Object.getPrototypeOf(browser);
  if (patched.has(proto)) return browser;
  patched.add(proto);
  const newContext = proto.newContext;
  proto.newContext = async function (...args) {
    return patchContext(await newContext.apply(this, args));
  };
  const newPage = proto.newPage;
  proto.newPage = async function (...args) {
    return patchPage(await newPage.apply(this, args));
  };
  return browser;
}

const launch = chromium.launch.bind(chromium);
chromium.launch = async (...args) => patchBrowser(await launch(...args));
const persistent = chromium.launchPersistentContext.bind(chromium);
chromium.launchPersistentContext = async (...args) => patchContext(await persistent(...args));
