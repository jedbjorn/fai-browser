// Real-site consent fixes in the runtime: a consent click counts as rejected only once the dialog has closed
// (booking.com's banner closes a few hundred ms after its Decline click), the same consent button is never clicked
// twice, and a consent wall on its own host (consent.google.com) is clicked only when its continue origin is
// approved, after which the run proceeds on the continue page. Fake bridge and fake providers only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserRuntime } from '../src/runtime.js';
import { consentContinueOrigin, consentKey } from '../src/oversight.js';
import { FakeBridge, ORIGIN, PAGES, link } from './runtime-fixtures.js';

const button = (id, label, extra = {}) => ({ id, role: 'button', label, type: 'button', enabled: true, ...extra });

/** A bridge whose consent dialog closes `closeAfter` observes after the reject click (0 = never closes). */
class SlowConsentBridge extends FakeBridge {
  constructor(options, closeAfter) {
    super(options);
    this.closeAfter = closeAfter;
    this.countdown = null;
  }

  async execute(action, revision, options) {
    const page = this.pages[this.path];
    const control = page.controls.find(c => c.id === action.target);
    if (control?.slowReject) {
      this.executions.push({ action, expectedRevision: revision, ...options });
      if (revision !== this.observation.revision) throw new Error('stale');
      this.countdown = this.closeAfter;
      return { observation: this.observation, settle: { reason: 'quiet', ms: 3 }, screenshot: Promise.resolve(null) };
    }
    return super.execute(action, revision, options);
  }

  async observe(signal, options) {
    if (this.countdown !== null && this.countdown > 0 && --this.countdown === 0) {
      delete this.pages[this.path].consent;
      this.version++;
    }
    return super.observe(signal, options);
  }
}

const bookingHome = () => ({
  title: 'Booking',
  text: 'Find your next stay',
  controls: [
    link('1', 'Search results', '/about'),
    button('22', 'Manage settings', { consent: true }),
    button('23', 'Decline', { consent: true, slowReject: true }),
    button('24', 'Accept', { consent: true, risk: 'destructive' }),
  ],
  consent: {
    text: 'Manage cookie settings',
    buttons: [{ id: '22', label: 'Manage settings', kind: 'settings' }, { id: '23', label: 'Decline', kind: 'reject' },
      { id: '24', label: 'Accept', kind: 'accept' }],
  },
});

function provider(labels) {
  const calls = [];
  return {
    calls,
    async decide(observation, actions) {
      calls.push(actions);
      const action = labels.map(label => actions.find(a => a.label === label)).find(Boolean);
      return { actionId: action?.id ?? 'handoff', confidence: 0.9, done: { probability: 0.9 } };
    },
  };
}

test('a dialog that closes a few observes after the click counts as rejected once closed; one click only', async () => {
  const bridge = new SlowConsentBridge({ pages: { ...PAGES, '/': bookingHome() } }, 3);
  const runtime = new BrowserRuntime({ bridge, provider: provider(['Search results']) });
  const result = await runtime.run('Open the search results', { expectation: { urlIncludes: '/about' }, consentWaitMs: 1 });
  assert.equal(result.status, 'completed', result.code);
  assert.equal(bridge.executions.filter(e => e.action.target === '23').length, 1);
  assert.ok(result.verdict.why.includes('consent:wait'));
  assert.ok(result.verdict.why.includes('consent:rejected'));
});

test('a dialog that never closes: needs_user/consent_banner after one click, never the same button twice', async () => {
  const bridge = new SlowConsentBridge({ pages: { ...PAGES, '/': bookingHome() } }, 0);
  const llm = provider(['Search results']);
  const runtime = new BrowserRuntime({ bridge, provider: llm });
  const result = await runtime.run('Open the search results', { expectation: { urlIncludes: '/about' }, consentWaitMs: 1 });
  assert.equal(result.code, 'consent_banner');
  assert.equal(bridge.executions.length, 1);
  assert.ok(result.verdict.why.includes('consent:persisted'));
  assert.ok(!result.verdict.why.includes('consent:rejected'));
  assert.ok(!result.verdict.why.includes('consent:no_reject'));
  assert.match(result.needs.message, /stayed open after FAI Browser clicked/);
  assert.equal(llm.calls.length, 0);
});

test('with two reject buttons the provider chooses one; if the dialog stays, the other is offered, never the same', async () => {
  const page = bookingHome();
  page.controls.push(button('25', 'Necessary only', { consent: true, dismissesConsent: true }));
  page.consent.buttons.push({ id: '25', label: 'Necessary only', kind: 'reject' });
  const bridge = new SlowConsentBridge({ pages: { ...PAGES, '/': page } }, 0);
  const llm = provider(['Decline', 'Necessary only', 'Search results']);
  const runtime = new BrowserRuntime({ bridge, provider: llm });
  const result = await runtime.run('Open the search results', { expectation: { urlIncludes: '/about' }, consentWaitMs: 1 });
  // Decline did not close the dialog: the run stops instead of re-offering it.
  assert.equal(result.code, 'consent_banner');
  assert.equal(bridge.executions.filter(e => e.action.target === '23').length, 1);
  assert.ok(result.verdict.why.includes('consent:persisted'));
});

const GOOGLE_CONSENT = 'https://consent.google.com/m?continue=https://www.google.com/travel/flights?hl%3Den&gl=FR&hl=en';
function googlePages() {
  return {
    '/m': {
      url: GOOGLE_CONSENT,
      title: 'Before you continue',
      text: 'Before you continue to Google. We use cookies and data.',
      controls: [
        link('2', 'Sign in', 'https://accounts.google.com/ServiceLogin'),
        button('4', 'Reject all', { type: 'submit', consent: true, redirectTo: '/travel/flights' }),
        button('5', 'Accept all', { type: 'submit', consent: true, risk: 'destructive' }),
      ],
      consent: { text: 'Before you continue to Google', buttons: [{ id: '4', label: 'Reject all', kind: 'reject' }, { id: '5', label: 'Accept all', kind: 'accept' }] },
    },
    '/travel/flights': {
      url: 'https://www.google.com/travel/flights?hl=en',
      title: 'Google Flights',
      text: 'Find cheap flights. Lisbon to London Heathrow from €105',
      controls: [link('1', 'Explore', 'https://www.google.com/travel/explore')],
    },
  };
}

class RedirectBridge extends FakeBridge {
  async execute(action, revision, options) {
    const control = this.pages[this.path].controls.find(c => c.id === action.target);
    if (control?.redirectTo) {
      this.executions.push({ action, expectedRevision: revision, ...options });
      this.path = control.redirectTo;
      this.version++;
      return { observation: this.observation, settle: { reason: 'load_complete', ms: 3, navigated: true }, screenshot: Promise.resolve(null) };
    }
    return super.execute(action, revision, options);
  }
}

test('Google consent page: Reject all is the mechanical step and the run proceeds on the continue URL', async () => {
  const bridge = new RedirectBridge({ pages: googlePages(), path: '/m' });
  const llm = provider([]);
  const runtime = new BrowserRuntime({ bridge, provider: llm });
  const result = await runtime.run('Report the cheapest fare shown', {
    allowedOrigins: ['https://consent.google.com', 'https://www.google.com'],
    expectation: { textIncludes: 'Heathrow' },
    consentWaitMs: 1,
  });
  assert.equal(result.status, 'completed', result.code);
  assert.equal(result.steps[0].class, 'consent');
  assert.equal(result.steps[0].action.label, 'Reject all');
  assert.equal(result.observation.url, 'https://www.google.com/travel/flights?hl=en');
  assert.ok(result.verdict.why.includes('consent:rejected'));
  // The followed redirect is named in the receipt (URL-derived origin only).
  assert.ok(result.verdict.why.includes('consent:redirect:https://www.google.com'), result.verdict.why.join());
  // The one provider decision was made on the flights page, not on the consent page.
  assert.equal(llm.calls.length, 1);
});

test('Google consent page whose continue origin is not approved: needs_user/cross_origin naming it, nothing clicked', async () => {
  const bridge = new RedirectBridge({ pages: googlePages(), path: '/m' });
  const llm = provider([]);
  const runtime = new BrowserRuntime({ bridge, provider: llm });
  const result = await runtime.run('Report the cheapest fare shown', { allowedOrigins: ['https://consent.google.com'] });
  assert.equal(result.status, 'needs_user');
  assert.equal(result.code, 'cross_origin');
  assert.match(result.needs.message, /continues to https:\/\/www\.google\.com/);
  assert.ok(result.verdict.why.includes('origin:https://www.google.com'));
  assert.equal(bridge.executions.length, 0);
  assert.equal(llm.calls.length, 0);
});

test('a consent page on an origin the request excludes is cross_origin naming that origin, not handoff', async () => {
  const bridge = new RedirectBridge({ pages: googlePages(), path: '/m' });
  const runtime = new BrowserRuntime({ bridge, provider: provider([]) });
  const result = await runtime.run('Report the cheapest fare shown', { allowedOrigins: ['https://www.google.com'] });
  assert.equal(result.code, 'cross_origin');
  assert.match(result.needs.message, /https:\/\/consent\.google\.com/);
});

test('consentContinueOrigin and consentKey', () => {
  assert.equal(consentContinueOrigin(GOOGLE_CONSENT), 'https://www.google.com');
  assert.equal(consentContinueOrigin('https://consent.youtube.com/m?continue=https%3A%2F%2Fwww.youtube.com%2F'), 'https://www.youtube.com');
  assert.equal(consentContinueOrigin('https://www.google.com/?continue=https://evil.test/'), null);
  assert.equal(consentContinueOrigin('https://consent.google.com/m?continue=javascript:alert(1)'), null);
  assert.equal(consentContinueOrigin('https://consent.google.com/m'), null);
  assert.equal(consentKey({ label: '  Reject   All ' }), 'reject all');
  assert.equal(ORIGIN, 'https://example.com');
});
