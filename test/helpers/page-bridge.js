// A bridge for BrowserRuntime over a real page: headless Chromium (playwright-core) with extension/page.js injected,
// the way extension/background.js drives it (observe; execute with dispatch, settle and observe in one call; after a
// navigation, wait for the load and settleAndObserve). No extension, no capture, no lease. For fixture-level tests of
// runtime rules on the real fixture pages (fixtures/long, fixtures/qa).
import { bridgeError } from '../../src/result.js';
import { fileURLToPath } from 'node:url';

const PAGE_SCRIPT = fileURLToPath(new URL('../../extension/page.js', import.meta.url));
// extension/background.js CAPABILITIES (what page.js may dispatch at each level).
const CAPABILITIES = {
  'read-only': ['navigate'],
  reversible: ['navigate', 'controls'],
  interactive: ['navigate', 'controls', 'submit_safe'],
  full: ['navigate', 'controls', 'submit_safe', 'submit', 'delete', 'consent_accept'],
};
const SETTLE_IN_PLACE = { quietMs: 50, capMs: 300 };
const SETTLE_AFTER_NAVIGATION = { quietMs: 100, capMs: 1500 };

export class PageBridge {
  constructor(page, { level = 'read-only' } = {}) {
    this.page = page;
    this.allow = CAPABILITIES[level];
    this.executions = [];
  }

  async inject() {
    if (!(await this.page.evaluate(() => Boolean(globalThis.__faiPage)).catch(() => false))) {
      await this.page.addScriptTag({ path: PAGE_SCRIPT });
    }
  }

  async observe(signal, options = {}) {
    const args = { terms: options.terms ?? [], forbid: options.forbid ?? [], allow: this.allow };
    // The expectation texts, kept for the execute that follows, as the extension keeps them on its session.
    this.expectText = options.expectText ?? [];
    args.expectText = this.expectText;
    for (let attempt = 0; ; attempt++) {
      try {
        await this.inject();
        return await this.page.evaluate(value => __faiPage.observe(value), args);
      } catch (error) {
        // A navigation that started after the last settle replaced the document under the call: wait and look again.
        if (attempt >= 3) throw error;
        await this.page.waitForLoadState('load').catch(() => {});
      }
    }
  }

  async execute(action, expectedRevision) {
    this.executions.push(action);
    await this.inject();
    const fromUrl = this.page.url();
    let outcome;
    try {
      outcome = await this.page.evaluate(
        // Terms null: the last observation's instruction terms stay, as the extension passes the decision's own (an
        // empty list would reorder term-matched offscreen controls and make every such click stale).
        ([a, r, s, allow, expectText]) => __faiPage.execute(a, r, s, null, [], allow, undefined, expectText).then(
          value => ({ value }), error => ({ error: { code: error.code, message: error.message } })),
        [action, expectedRevision, SETTLE_IN_PLACE, this.allow, this.expectText ?? []],
      );
    } catch {
      // The click tore the document down: a navigation.
      outcome = { value: { expectNavigation: true } };
    }
    if (outcome.error) throw bridgeError(outcome.error.code ?? 'unsupported', outcome.error.message);
    let { value } = outcome;
    if (value.expectNavigation) {
      await this.page.waitForLoadState('load');
      try {
        await this.inject();
        value = await this.page.evaluate(([s, allow, expectText]) => __faiPage.settleAndObserve(s, [], [], allow,
          undefined, expectText), [SETTLE_AFTER_NAVIGATION, this.allow, this.expectText ?? []]);
      } catch {
        const observation = await this.observe(undefined, { expectText: this.expectText });
        value = { settle: { reason: 'load_complete' }, observation };
      }
    }
    const navigated = value.observation.url !== fromUrl;
    const settle = { reason: value.settle?.reason ?? 'quiet', ms: 0 };
    if (navigated) Object.assign(settle, { navigated: true, url: value.observation.url });
    return { observation: value.observation, settle, navigated, screenshot: Promise.resolve(null) };
  }

  // A point click's first half, as extension/background.js runs it: the control under a CSS viewport point on the
  // expected revision ({ id, control }), described by page.js.
  async locate(point, expectedRevision, options = {}) {
    await this.inject();
    const outcome = await this.page.evaluate(
      ([p, r, forbid, allow]) => Promise.resolve().then(() => __faiPage.locate(p, r, null, forbid, allow, undefined)).then(
        value => ({ value }), error => ({ error: { code: error.code, message: error.message } })),
      [point, expectedRevision, options.forbid ?? [], this.allow],
    );
    if (outcome.error) throw bridgeError(outcome.error.code ?? 'unsupported', outcome.error.message);
    return outcome.value;
  }
}
