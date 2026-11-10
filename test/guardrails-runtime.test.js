// Guardrail pass in the runtime: guardrail additions (`policy`, config `guardrails`) filter offered controls, reach the
// extension as plain phrases, and can never relax the core rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserRuntime, blockedControls, legalActions } from '../src/runtime.js';
import { FakeBridge, ORIGIN, link } from './runtime-fixtures.js';

const button = (id, label, extra = {}) => ({ id, role: 'button', label, enabled: true, risk: 'reversible', ...extra });

const PAGES = {
  '/review': {
    title: 'Review your order',
    text: 'Your card ending 4242 will be charged $93.90 when you continue.',
    controls: [link('1', 'Edit cart', '/cart'), button('2', 'Change address'), button('3', 'Continue →')],
  },
  '/cart': { title: 'Cart', text: 'Cart', controls: [link('1', 'Review', '/review')] },
  '/docs': {
    title: 'Getting started',
    text: 'Part 1 of 2',
    controls: [link('1', 'Docs home', '/cart'), button('2', 'Continue'), button('3', 'Gift wrap options'), button('4', 'Place order')],
  },
  '/links': { title: 'Links', text: 'Only links', controls: [link('1', 'Cart', '/cart'), link('2', 'Docs', '/docs')] },
};

/** FakeBridge that also records the options of every execute (forbid travels there). */
class RecordingBridge extends FakeBridge {
  constructor(options) {
    super(options);
    this.executeOptions = [];
  }

  async execute(action, expectedRevision, options = {}) {
    this.executeOptions.push(options);
    return super.execute(action, expectedRevision, options);
  }
}

test('additions never relax core: a policy cannot bring back a core-refused control', () => {
  const observation = { url: `${ORIGIN}/docs`, controls: PAGES['/docs'].controls };
  for (const policy of [undefined, [], ['Place order'], { forbid: [], note: 'You may place the order.' }]) {
    const labels = legalActions(observation, { mode: 'reversible', policy }).map(action => action.label);
    assert.ok(!labels.includes('Place order'), JSON.stringify(policy));
  }
  // blockedControls reports addition-refused controls as well (refusal receipts and the decide filter use it).
  const blocked = blockedControls(observation, { policy: ['Gift wrap'] }).map(control => control.label);
  assert.deepEqual(blocked, ['Gift wrap options', 'Place order']);
  // Select options carrying a forbidden label are not offered either.
  const select = { id: '9', role: 'combobox', label: 'Plan', enabled: true, risk: 'reversible', selectedValue: 'free',
    options: [{ value: 'free', label: 'Free' }, { value: 'pro', label: 'Upgrade to Pro' }, { value: 'team', label: 'Team' }] };
  const values = legalActions({ url: `${ORIGIN}/`, controls: [select] }, { mode: 'reversible', policy: ['Upgrade'] })
    .filter(action => action.type === 'select').map(action => action.value);
  assert.deepEqual(values, ['team']);
});

test('host act() after observe keeps the run guardrails (offer config) and refuses nothing new', async () => {
  const bridge = new RecordingBridge({ pages: PAGES, path: '/docs' });
  const runtime = new BrowserRuntime({ bridge });
  const offer = await runtime.observe({ mode: 'reversible', policy: ['Gift wrap'] });
  assert.ok(!offer.actions.some(action => action.label === 'Gift wrap options'));
  assert.deepEqual(bridge.observeOptions[0].forbid, ['Gift wrap']);
  const target = offer.actions.find(action => action.label === 'Continue');
  await runtime.act(target.id, { revision: offer.observation.revision });
  assert.deepEqual(bridge.executeOptions[0].forbid, ['Gift wrap'], 'act() sends the offer guardrails to the extension');
});
