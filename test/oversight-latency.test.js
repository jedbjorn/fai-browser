// Regression guard for the wall-time check in bench 2026-10-04-oversight: on the one-call tasks (about-members,
// pricing-pro, settings-new-tab) FAI's in-run time was unchanged (elapsedMs medians 946/982/1002 ms before, 973/945/
// 1074 ms after; no late_navigation, scroll_nudge or re-observe in any receipt); the +2 s was in the model turns.
// The late-content wait added for slow-content must keep it that way: a page without a loading placeholder costs no
// extra observe, delay or decision.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserRuntime } from '../src/runtime.js';
import { agentResult } from '../src/result.js';
import { FakeBridge, PAGES, link } from './runtime-fixtures.js';

test('a one-click verified run with no placeholder does no content wait or re-observe', async () => {
  const bridge = new FakeBridge({
    pages: {
      ...PAGES,
      '/': { title: 'Home', text: 'Welcome', controls: [link('1', 'Pricing', '/pricing')] },
      '/pricing': { title: 'Pricing', text: 'Pro | $37 per month | $370 per year | 10', controls: [] },
    },
  });
  const provider = {
    async decide(observation, actions) {
      const onPricing = observation.url.endsWith('/pricing');
      const action = actions.find(candidate => candidate.label === 'Pricing');
      return { actionId: onPricing ? 'done' : action.id, confidence: 0.95, done: { probability: onPricing ? 0.97 : 0.05 } };
    },
  };
  const runtime = new BrowserRuntime({ bridge, provider });
  // Large delays: any wait or re-observe would show up in elapsedMs.
  const result = await runtime.run('Click Pricing and read the Pro monthly price.', {
    allowedOrigins: ['https://example.com'],
    expectation: { urlIncludes: '/pricing' },
    answerQuestion: 'What is the monthly price of the Pro plan?',
    contentWaitMs: 2000,
    reobserveDelayMs: 2000,
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.cost.decisions, 2);
  assert.equal(bridge.observes, 1, 'only the initial observe; the click returns the next observation');
  assert.ok(result.cost.elapsedMs < 1000, `${result.cost.elapsedMs} ms`);
  const why = agentResult(result).verdict.why;
  for (const code of ['content_wait', 'content_loading', 'late_navigation', 'late_reobserve', 'scroll_nudge']) {
    assert.ok(!why.includes(code), code);
  }
});
