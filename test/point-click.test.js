// Point clicks (act with a point instead of an actionId) and action-id screenshot tags, without a browser: the
// image-to-page mapping (mapPoint), the badge labels (actionLabels), the classification of the control under the point
// (pointAction: an offered control runs its offered action, an unoffered safe one a click, the rest the same refusals
// as offered actions) and the runtime's act path on the fake bridge, with the refusal codes and the receipt's record.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserRuntime, OTHER_SITE_TEXT, actionLabels, mapPoint, offerImage, offeredActions, pointAction } from '../src/runtime.js';
import { agentResult } from '../src/result.js';
import { FORBID_REFUSAL_TEXT, PURCHASE_REFUSAL_TEXT } from '../src/oversight.js';
import { FakeBridge, ORIGIN, link } from './runtime-fixtures.js';

const box = (x, y, width = 100, height = 30) => ({ x, y, width, height });
const button = (id, label, extra = {}) => ({ id, role: 'button', label, type: 'button', enabled: true, risk: 'reversible', ...extra });

// A page whose observed controls carry bounds, plus controls the observation left out (`unlisted`): a safe button, a
// Delete, a Buy now, a password field, a link off the approved site, a forbidden label and a disabled button.
const PAGES = {
  '/': {
    title: 'Home',
    text: 'Welcome home',
    controls: [
      { ...link('1', 'About', '/about'), bounds: box(10, 10) },
      button('2', 'Show plan', { bounds: box(10, 50) }),
      { id: '3', role: 'textbox', label: 'Name', type: 'text', enabled: true, risk: 'reversible', bounds: box(10, 90) },
    ],
    unlisted: [
      { ...button('u1', 'Expand row', { bounds: box(10, 200) }), unlisted: true },
      { ...button('u2', 'Delete', { risk: 'delete', bounds: box(10, 240) }), unlisted: true },
      { ...button('u3', 'Buy now', { risk: 'purchase', bounds: box(10, 280) }), unlisted: true },
      { id: 'u4', role: 'textbox', label: 'Password', type: 'password', enabled: true, risk: 'sign_in', bounds: box(10, 320), unlisted: true },
      { ...link('u5', 'Partner', 'https://other.example/offers'), bounds: box(10, 360), unlisted: true },
      { ...button('u6', 'Archive thread', { bounds: box(10, 400) }), unlisted: true },
      { ...button('u7', 'Later', { enabled: false, bounds: box(10, 440) }), unlisted: true },
      { ...button('u8', 'Framed', { bounds: box(10, 480), frame: 'cross' }), unlisted: true },
    ],
  },
  '/about': { title: 'About', text: 'About us', controls: [link('1', 'Home', '/')] },
};

const runtimeOn = (options = {}) => {
  const bridge = new FakeBridge({ pages: PAGES, ...options });
  return { bridge, runtime: new BrowserRuntime({ bridge }) };
};

// --- mapping ----------------------------------------------------------------------------------------------------

test('offerImage: the noted size wins; else the extension would downscale the device-pixel frame to 1280 wide', () => {
  const at = (width, height, dpr) => ({ observation: { viewport: { width, height, dpr } } });
  assert.deepEqual(offerImage(at(1280, 800, 1)), { width: 1280, height: 800, noted: false });
  assert.deepEqual(offerImage(at(1280, 800, 2)), { width: 1280, height: 800, noted: false }, 'a 2560 px frame is scaled to 1280');
  assert.deepEqual(offerImage(at(1000, 600, 2)), { width: 1280, height: 768, noted: false });
  assert.deepEqual(offerImage(at(800, 600, 1)), { width: 800, height: 600, noted: false }, 'a narrow frame is not upscaled');
  assert.deepEqual(offerImage({ ...at(1000, 600, 2), image: { width: 640, height: 384 } }), { width: 640, height: 384, noted: true });
  assert.equal(offerImage({ observation: {} }), null);
});

test('mapPoint scales image pixels to CSS pixels and refuses points off the image', () => {
  const offer = { observation: { viewport: { width: 1000, height: 600, dpr: 2 } } };
  // 1000 CSS px wide at dpr 2 -> 2000 device px -> 1280 image px: scale 1.28.
  assert.deepEqual(mapPoint(offer, { x: 640, y: 384 }), {
    image: { x: 640, y: 384 }, css: { x: 500, y: 300 }, scale: 1.28, imageSize: { width: 1280, height: 768 },
  });
  assert.deepEqual(mapPoint(offer, { x: 0, y: 0 }).css, { x: 0, y: 0 });
  assert.equal(mapPoint(offer, { x: 1280, y: 10 }), null, 'the right edge is outside');
  assert.equal(mapPoint(offer, { x: 10, y: 768 }), null, 'the bottom edge is outside');
  assert.equal(mapPoint(offer, { x: -1, y: 10 }), null);
  assert.equal(mapPoint(offer, { x: 'a', y: 10 }), null);
  assert.equal(mapPoint({ observation: {} }, { x: 1, y: 1 }), null, 'no image size known');
  // A noted image (the daemon saw the observe capture) maps against its own size.
  const noted = { ...offer, image: { width: 640, height: 384 } };
  assert.deepEqual(mapPoint(noted, { x: 320, y: 192 }).css, { x: 500, y: 300 });
  assert.equal(mapPoint(noted, { x: 700, y: 10 }), null);
});

test('actionLabels groups offered action ids by control ref and skips page actions', () => {
  const actions = [
    { id: 'a0', type: 'click', target: '1' },
    { id: 'a1', type: 'select', target: '2', value: 'x' },
    { id: 'a2', type: 'select', target: '2', value: 'y' },
    { id: 'a3', type: 'scroll', direction: 'down' },
    { id: 'a4', type: 'navigate_allowed_url', url: 'https://example.com/x' },
    { id: 'a5', type: 'fill_supplied_text', target: '2', suppliedName: 'q' },
  ];
  assert.deepEqual(actionLabels(actions), { 1: ['a0'], 2: ['a1', 'a2', 'a5'] });
  assert.deepEqual(actionLabels([]), {});
});

// --- classification ---------------------------------------------------------------------------------------------

function offerFor(level = 'reversible', extra = {}) {
  const observation = new FakeBridge({ pages: PAGES }).observation;
  const config = { mode: level, allowedOrigins: [ORIGIN], ...extra };
  const actions = offeredActions(observation, config).actions.filter(a => a.type !== 'done' && a.type !== 'handoff');
  return { offer: { revision: observation.revision, observation, actions, config }, config: { ...config, level, point: { x: 1, y: 1 } } };
}

test('pointAction runs the offered click of an offered control, by its own id', () => {
  const { offer, config } = offerFor();
  const about = offer.actions.find(a => a.label === 'About');
  const resolved = pointAction(offer, { id: '1', control: offer.observation.controls[0] }, config);
  assert.equal(resolved.offered, true);
  assert.equal(resolved.action, about, 'exactly the offered action object');
  assert.equal(resolved.action.point, undefined);
});

test('pointAction clicks a field offered only as fills (focus, never type) and an unoffered safe control by its point', () => {
  const { offer, config } = offerFor('reversible', { suppliedText: { name: 'Ada' } });
  const name = offer.observation.controls.find(c => c.label === 'Name');
  assert.ok(offer.actions.some(a => a.type === 'fill_supplied_text' && a.target === '3'), 'the field is offered as a fill');
  const field = pointAction(offer, { id: '3', control: name }, config);
  assert.equal(field.offered, false);
  assert.equal(field.action.type, 'click');
  assert.equal(field.action.target, '3');
  assert.equal(field.action.point, undefined, 'an observed control is clicked by its ref');
  assert.match(field.action.description, /no typing/);

  const expand = PAGES['/'].unlisted[0];
  const unlisted = pointAction(offer, { id: null, control: { ...expand, id: 'point' } }, config);
  assert.equal(unlisted.offered, false);
  assert.equal(unlisted.action.type, 'click');
  assert.equal(unlisted.action.id, 'point');
  assert.deepEqual(unlisted.action.point, { x: 1, y: 1 }, 'an unlisted control is clicked by the located point');
});

test('pointAction refuses unoffered controls exactly as the offer gate would', () => {
  const { offer, config } = offerFor();
  const found = control => ({ id: null, control: { ...control, id: 'point' } });
  const [, del, buy, password, partner, archive, later] = PAGES['/'].unlisted;
  assert.deepEqual(pointAction(offer, found(del), config).refusal, { kind: 'delete', capability: 'delete' });
  assert.deepEqual(pointAction(offer, found(buy), config).refusal, { kind: 'purchase', capability: 'purchase' });
  assert.deepEqual(pointAction(offer, found(password), config).refusal, { kind: 'sign_in', capability: 'sign_in' });
  assert.deepEqual(pointAction(offer, found(partner), config).refusal, { kind: 'cross_origin', capability: null });
  assert.deepEqual(pointAction(offer, found(later), config).refusal, { kind: 'unavailable', capability: null });
  const forbidding = offerFor('reversible', { policy: { forbid: ['Archive'] } });
  assert.deepEqual(pointAction(forbidding.offer, found(archive), forbidding.config).refusal, { kind: 'forbid', capability: null });
  // At full, Delete is allowed and runs as a click; a purchase never is below testing.
  const full = offerFor('full');
  assert.equal(pointAction(full.offer, found(del), full.config).action?.type, 'click');
  assert.equal(pointAction(full.offer, found(buy), full.config).refusal?.kind, 'purchase');
  // A read-only offer has no controls at all: a link is navigation, a button needs a level.
  const readOnly = offerFor('read-only');
  assert.equal(pointAction(readOnly.offer, found(PAGES['/'].unlisted[0]), readOnly.config).refusal?.kind, 'level');
  // At read-only an unlisted same-site link is a link click by its point; a javascript: or off-site link never is.
  const docs = pointAction(readOnly.offer, found(link('u9', 'Docs', '/docs')), readOnly.config);
  assert.equal(docs.action?.type, 'click');
  assert.equal(docs.action.href, `${ORIGIN}/docs`);
  assert.deepEqual(docs.action.point, { x: 1, y: 1 });
  const script = pointAction(readOnly.offer, found(link('u10', 'Open panel', '/x', { href: 'javascript:void(0)' })), readOnly.config);
  assert.equal(script.action, undefined);
  assert.equal(script.refusal.kind, 'not_web', 'a javascript: link runs a script: never, at any level');
  for (const href of ['data:text/html,hi', 'mailto:a@example.com']) {
    assert.equal(pointAction(readOnly.offer, found(link('u12', 'Other', '/x', { href })), readOnly.config).refusal?.kind, 'not_web', href);
  }
  assert.equal(pointAction(full.offer, found(link('u10', 'Open panel', '/x', { href: 'javascript:void(0)' })), full.config).refusal?.kind, 'not_web');
  // A script link (role=link without an href) needs reversible, as its action id does; from reversible it is a click.
  const roleLink = { id: 'point', role: 'link', label: 'More info', enabled: true, risk: 'reversible' };
  assert.deepEqual(pointAction(readOnly.offer, { id: null, control: roleLink }, readOnly.config).refusal, { kind: 'level', capability: 'controls' });
  assert.equal(pointAction(offer, { id: null, control: roleLink }, config).action?.type, 'click');
  assert.equal(pointAction(readOnly.offer, found(partner), readOnly.config).refusal?.kind, 'cross_origin');
  // A link labelled as an action stays refused as its offered id would be (none is offered).
  assert.equal(pointAction(readOnly.offer, found(link('u11', 'Sign out', '/logout')), readOnly.config).refusal?.kind, 'sign_in');
});

// --- runtime act ------------------------------------------------------------------------------------------------

test('act with a point on an offered control runs that offered action and records the point', async () => {
  const { bridge, runtime } = runtimeOn();
  const { observation, actions } = await runtime.observe({ mode: 'reversible' });
  const about = actions.find(a => a.label === 'About');
  // 1280x800 at dpr 1: image pixels are CSS pixels. (15, 20) is inside About's box.
  const result = await runtime.act({ point: { x: 15, y: 20 } }, { revision: observation.revision });
  assert.equal(result.status, 'checkpoint', result.reason);
  assert.equal(result.steps.length, 1);
  assert.deepEqual(result.steps[0].decision, {
    by: 'host', actionId: about.id,
    point: { image: { x: 15, y: 20 }, css: { x: 15, y: 20 } },
    resolved: { ref: '1', label: 'About', offered: true },
  });
  assert.equal(result.steps[0].action.toUrl, `${ORIGIN}/about`);
  assert.deepEqual(bridge.locates[0], { point: { x: 15, y: 20 }, expectedRevision: '/#1' });
  assert.deepEqual(bridge.executions[0].action, { type: 'click', target: '1' }, 'the offered action, by ref');
  assert.ok(result.verdict.why.includes('act:point_offered'), result.verdict.why.join(','));
  assert.deepEqual(result.point, {
    image: { x: 15, y: 20 }, css: { x: 15, y: 20 }, scale: 1, imageSize: { width: 1280, height: 800 },
    control: { ref: '1', label: 'About', offered: true },
  });
  const lean = agentResult(result);
  assert.deepEqual(lean.steps[0].point, { x: 15, y: 20, ref: '1', offered: true });
  assert.deepEqual(lean.point.control, { ref: '1', label: 'About', offered: true });
});

test('act with a point on an unoffered safe control clicks it by its point', async () => {
  const { bridge, runtime } = runtimeOn();
  const { observation } = await runtime.observe({ mode: 'reversible' });
  const result = await runtime.act({ point: { x: 20, y: 210 } }, { revision: observation.revision });
  assert.equal(result.status, 'checkpoint', result.reason);
  assert.deepEqual(bridge.executions[0].action, { type: 'click', point: { x: 20, y: 210 } });
  assert.deepEqual(result.steps[0].decision.resolved, { ref: 'point', label: 'Expand row', offered: false });
  assert.equal(result.steps[0].decision.actionId, 'point');
  assert.ok(result.verdict.why.includes('act:point'));
  assert.deepEqual(agentResult(result).steps[0].point, { x: 20, y: 210, ref: 'point', offered: false });
});

test('act with a point maps screenshot pixels through the noted image size', async () => {
  const { bridge, runtime } = runtimeOn();
  const { observation } = await runtime.observe({ mode: 'reversible' });
  // The daemon noted a half-size image for this revision: (10, 105) in it is (20, 210) on the page.
  runtime.noteImage(observation.revision, { width: 640, height: 400 });
  runtime.noteImage('unknown', { width: 1, height: 1 });
  const result = await runtime.act({ point: { x: 10, y: 105 } }, { revision: observation.revision });
  assert.equal(result.status, 'checkpoint', result.reason);
  assert.deepEqual(bridge.locates[0].point, { x: 20, y: 210 });
  assert.equal(result.point.scale, 0.5);
});

test('act with a point refuses Delete, Buy now, a password field, a forbidden label and an off-site link like the offer gate', async () => {
  const at = async (point, options = {}) => {
    const { bridge, runtime } = runtimeOn();
    const { observation } = await runtime.observe({ mode: 'reversible', ...options });
    const result = await runtime.act({ point }, { revision: observation.revision });
    assert.equal(bridge.executions.length, 0, 'nothing ran');
    return result;
  };
  const del = await at({ x: 20, y: 250 });
  assert.equal(del.code, 'refused_action');
  assert.equal(del.needs.level, 'full', 'a deletion needs full');
  assert.deepEqual(del.needs.control, { ref: 'point', label: 'Delete' });
  assert.ok(del.verdict.why.includes('point:delete'));
  assert.deepEqual(del.point.control, { ref: 'point', label: 'Delete', offered: false });

  const buy = await at({ x: 20, y: 290 });
  assert.equal(buy.code, 'refused_action');
  assert.equal(buy.needs.message, PURCHASE_REFUSAL_TEXT);
  assert.equal(buy.needs.level, undefined, 'a purchase is never a level request');
  assert.ok(buy.verdict.why.includes('point:purchase'));

  const password = await at({ x: 20, y: 330 });
  assert.equal(password.code, 'refused_action');
  assert.ok(password.verdict.why.includes('point:sign_in'));

  const forbidden = await at({ x: 20, y: 410 }, { policy: { forbid: ['Archive'] } });
  assert.equal(forbidden.code, 'refused_action');
  assert.equal(forbidden.needs.message, FORBID_REFUSAL_TEXT);
  assert.ok(forbidden.verdict.why.includes('point:forbid'));

  const partner = await at({ x: 20, y: 370 });
  assert.equal(partner.code, 'cross_origin');
  assert.ok(partner.verdict.why.includes('point:cross_origin'));

  const disabled = await at({ x: 20, y: 450 });
  assert.equal(disabled.code, 'target_unavailable');
});

test('act with a point: off the image, nothing there, a frame from another origin, and below reversible', async () => {
  const { bridge, runtime } = runtimeOn();
  let { observation } = await runtime.observe({ mode: 'reversible' });
  const outside = await runtime.act({ point: { x: 1280, y: 10 } }, { revision: observation.revision });
  assert.equal(outside.code, 'point_outside');
  assert.equal(outside.status, 'needs_host');
  assert.equal(bridge.locates, undefined, 'an off-image point never reaches the page');
  assert.ok(outside.verdict.why.includes('point:off_image'));

  ({ observation } = await runtime.observe({ mode: 'reversible' }));
  const nothing = await runtime.act({ point: { x: 600, y: 600 } }, { revision: observation.revision });
  assert.equal(nothing.code, 'no_control');
  assert.equal(nothing.status, 'needs_host');
  assert.ok(nothing.verdict.why.includes('point:no_control'));

  ({ observation } = await runtime.observe({ mode: 'reversible' }));
  const framed = await runtime.act({ point: { x: 20, y: 490 } }, { revision: observation.revision });
  assert.equal(framed.code, 'point_frame');
  assert.equal(framed.status, 'needs_host');

  // Read-only: a point on a button is located, then refused as an action id for it would be (it needs reversible).
  ({ observation } = await runtime.observe({ mode: 'read-only' }));
  const readOnly = await runtime.act({ point: { x: 15, y: 60 } }, { revision: observation.revision });
  assert.equal(readOnly.code, 'refused_action');
  assert.equal(readOnly.needs.level, 'reversible');
  assert.ok(readOnly.verdict.why.includes('point:level'));
  assert.equal(bridge.executions.length, 0, 'nothing ran');
});

test('act with a point at read-only follows a plain link like its action id, and refuses everything else as before', async () => {
  const at = async point => {
    const { bridge, runtime } = runtimeOn();
    const { observation } = await runtime.observe({ mode: 'read-only' });
    const result = await runtime.act({ point }, { revision: observation.revision });
    return { bridge, result };
  };
  // The offered About link: the offered click, by its id.
  const about = await at({ x: 15, y: 20 });
  assert.equal(about.result.status, 'checkpoint', about.result.reason);
  assert.deepEqual(about.bridge.executions[0].action, { type: 'click', target: '1' });
  assert.equal(about.result.steps[0].action.toUrl, `${ORIGIN}/about`);
  assert.ok(about.result.verdict.why.includes('act:point_offered'));
  // A field, a safe unoffered button, Delete, Buy now, a password field and an off-site link: refused, nothing runs.
  const cases = [
    [{ x: 20, y: 100 }, 'refused_action', 'point:level'],
    [{ x: 20, y: 210 }, 'refused_action', 'point:level'],
    [{ x: 20, y: 250 }, 'refused_action', 'point:delete'],
    [{ x: 20, y: 290 }, 'refused_action', 'point:purchase'],
    [{ x: 20, y: 330 }, 'refused_action', 'point:sign_in'],
    [{ x: 20, y: 370 }, 'cross_origin', 'point:cross_origin'],
  ];
  for (const [point, code, why] of cases) {
    const { bridge, result } = await at(point);
    assert.equal(result.code, code, JSON.stringify(point));
    assert.ok(result.verdict.why.includes(why), `${JSON.stringify(point)}: ${result.verdict.why.join(',')}`);
    assert.equal(bridge.executions.length, 0, `${JSON.stringify(point)} ran`);
  }
  const buy = await at({ x: 20, y: 290 });
  assert.equal(buy.result.needs.message, PURCHASE_REFUSAL_TEXT);
  const del = await at({ x: 20, y: 250 });
  assert.equal(del.result.needs.level, 'full');
  const partner = await at({ x: 20, y: 370 });
  assert.equal(partner.result.needs.message, OTHER_SITE_TEXT, 'the off-site link says how to follow it');
  assert.ok(!partner.result.needs.message.includes('other.example'), 'the page-made destination stays out of the trusted text');
});

test('act with a point on a stale revision is refused like a stale action id, with no re-resolve', async () => {
  const { bridge, runtime } = runtimeOn();
  const { observation } = await runtime.observe({ mode: 'reversible' });
  await assert.rejects(runtime.act({ point: { x: 15, y: 20 } }, { revision: 'unknown' }), /Unknown revision/);
  // The page moved on after the observe: the pixels were read off a page that is gone.
  bridge.version++;
  const result = await runtime.act({ point: { x: 15, y: 20 } }, { revision: observation.revision });
  assert.equal(result.code, 'stale');
  assert.equal(result.status, 'needs_host');
  assert.equal(bridge.executions.length, 0);
  assert.ok(result.verdict.why.includes('point:stale'));
  await assert.rejects(runtime.act({ point: { x: 15, y: 20 } }, { revision: observation.revision }), /Unknown revision/,
    'the offer is spent');
});

test('act validates its choice: an action id, or a point with finite coordinates, on a bridge that can locate', async () => {
  const { runtime } = runtimeOn();
  await assert.rejects(runtime.act({ point: { x: 'a', y: 1 } }), /action id or a point/);
  await assert.rejects(runtime.act({}), /action id or a point/);
  await assert.rejects(runtime.act(5), /action id or a point/);
  const bridge = new FakeBridge({ pages: PAGES });
  delete bridge.locate;
  const plain = new BrowserRuntime({ bridge: Object.assign(Object.create(Object.getPrototypeOf(bridge)), bridge, { locate: undefined }) });
  const { observation } = await plain.observe({ mode: 'reversible' });
  await assert.rejects(plain.act({ point: { x: 1, y: 1 } }, { revision: observation.revision }), /cannot locate/);
});

test('an act tags its final screenshot with the landing page\'s offer ids, the ids the next act may use', async () => {
  const { bridge, runtime } = runtimeOn();
  const captures = [];
  bridge.capture = async details => {
    captures.push(details);
    const tags = details.labels ? Object.entries(details.labels).map(([ref, ids]) => ({ id: ids[0], ref, x: 0, y: 0, width: 20, height: 18 })) : undefined;
    return { dataUrl: 'data:image/jpeg;base64,YQ==', revision: bridge.observation.revision, format: 'jpeg', width: 1280, height: 800,
      ...(tags ? { tags } : {}) };
  };
  const { observation, actions } = await runtime.observe({ mode: 'reversible' });
  const about = actions.find(a => a.label === 'About');
  const result = await runtime.act(about.id, { revision: observation.revision, capture: 'last' });
  assert.equal(result.status, 'checkpoint');
  // The landing page (/about) is remembered as the next offer: its ids are drawn on the final capture.
  assert.equal(result.offer.revision, result.steps[0].observation.revision);
  assert.equal(captures.length, 1);
  assert.deepEqual(captures[0].labels, actionLabels(result.offer.actions));
  assert.equal(captures[0].revision, result.offer.revision);
  assert.deepEqual(result.steps[0].screenshot.tags.map(tag => tag.id), result.offer.actions.filter(a => a.target !== undefined).map(a => a.id));
});

test('a point click returns the landing page\'s offer, and the next act runs one of its ids with no observe in between', async () => {
  const { bridge, runtime } = runtimeOn();
  const { observation } = await runtime.observe({ mode: 'reversible' });
  const first = await runtime.act({ point: { x: 15, y: 20 } }, { revision: observation.revision });
  assert.equal(first.status, 'checkpoint', first.reason);
  assert.equal(first.steps[0].action.toUrl, `${ORIGIN}/about`);
  assert.ok(first.offer, 'the point act carries the landing offer');
  assert.equal(first.offer.revision, '/about#2');
  const home = first.offer.actions.find(a => a.label === 'Home');
  assert.ok(home && first.offer.listed.includes(home.id));
  const lean = agentResult(first);
  assert.equal(lean.revision, first.offer.revision);
  assert.ok(lean.actions.some(a => a.id === home.id));
  // No observe: the id and revision from the point act's result.
  const second = await runtime.act(home.id, { revision: first.offer.revision });
  assert.equal(second.status, 'checkpoint', second.reason);
  assert.equal(second.steps[0].action.toUrl, `${ORIGIN}/`);
  assert.deepEqual(second.steps[0].decision, { by: 'host', actionId: home.id });
  assert.equal(bridge.observes, 1, 'one observe for the whole chain');
  // And a point on the page the second act landed on, again without an observe.
  const third = await runtime.act({ point: { x: 15, y: 20 } }, { revision: second.offer.revision });
  assert.equal(third.status, 'checkpoint', third.reason);
  assert.equal(third.steps[0].decision.resolved.offered, true);
});
