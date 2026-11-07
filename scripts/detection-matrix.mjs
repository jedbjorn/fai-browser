import assert from 'node:assert/strict';
import { directResult } from '../src/result.js';

export const DETECTION_TEXT = {
  name: 'Ada Lovelace-Byron',
  notes: 'Window seat, please; arriving late (after 22:00) with two bags & a stroller.',
  query: 'Flights to Oslo',
};

export function assertDetectionReceipt(response, action, { submit = false } = {}) {
  const receipt = directResult(response?.result ?? response);
  assert.ok(['acted', 'completed'].includes(receipt.status),
    `${action.description}: ${JSON.stringify(response).slice(0, 500)}`);
  const expected = submit ? 2 : 1;
  assert.equal(receipt.did?.length, expected, `${action.description}: missing or extra action receipts`);
  assert.equal(receipt.did[0], action.description, `${action.description}: receipt did another action`);
  if (submit) assert.match(receipt.did[1], /^press Enter in /);
}

/** Drive the local detector through normal agent-direct observe/act calls. The fixture posts the report on Finish. */
export async function runDetectionMatrix(client, requestId, origin) {
  const detectorUrl = `${origin}/detector.html`;
  const suppliedText = DETECTION_TEXT;
  const offered = await client.observe({ requestId, allowedUrls: [detectorUrl], suppliedText });
  const go = (offered.actions ?? []).find(action => action.type === 'navigate_allowed_url' && action.url === detectorUrl);
  assert.ok(go, 'a navigate action to the local detector');
  const landed = await client.act({ requestId, revision: offered.revision, actionId: go.id, waitMs: 20_000 });
  assertDetectionReceipt(landed, go);
  let page = await client.observe({ requestId, suppliedText });
  assert.equal(page.state, 'ok', JSON.stringify(page).slice(0, 400));

  async function act(match, extra = {}) {
    const actions = page.actions ?? [];
    const action = actions.find(item => Object.entries(match).every(([key, value]) => item[key] === value));
    assert.ok(action, `${JSON.stringify(match)} among ${JSON.stringify(actions.map(item => ({
      type: item.type, label: item.label, value: item.value, suppliedName: item.suppliedName,
    })))}`);
    const result = await client.act({ requestId, revision: page.revision, actionId: action.id, ...extra, waitMs: 20_000 });
    assertDetectionReceipt(result, action, extra);
    page = await client.observe({ requestId, suppliedText });
    assert.equal(page.state, 'ok', JSON.stringify(page).slice(0, 400));
  }

  await act({ type: 'click', label: '+ Show details' });
  await act({ type: 'fill_supplied_text', suppliedName: 'name', label: 'Full name' });
  await act({ type: 'fill_supplied_text', suppliedName: 'notes', label: 'Notes' });
  await act({ type: 'fill', label: 'Search' }, { text: suppliedText.query, submit: true });
  await act({ type: 'select', label: 'Sort by', value: 'price' });
  await act({ type: 'scroll', direction: 'down' });
  await act({ type: 'click', label: 'Load more results' });
  await act({ type: 'click', label: 'Jump to results' });
  await act({ type: 'click', label: 'Finish detection report' });
}

/** Assert the fixture's report and return its portable capability matrix. */
export function evaluateDetection(detection, { webdriver, persistentProfile }) {
  assert.ok(detection && typeof detection === 'object', JSON.stringify(detection));
  assert.deepEqual(detection.report.flags, {}, detection.report.details.join('\n'));
  assert.ok(detection.report.untrusted > 0, 'content-script events remain honestly untrusted');
  assert.equal(detection.report.counts.submit, 1);
  assert.deepEqual(detection.report.counts.click, {
    show: 1, name: 1, notes: 1, q: 1, go: 1, sort: 1, far: 1, section: 1, finish: 1,
  });
  assert.deepEqual(detection.report.counts.change, { name: 1, notes: 1, q: 1, sort: 1 });
  assert.deepEqual(detection.globals, []);
  assert.deepEqual(detection.mutations, []);
  assert.equal(detection.activation, false, 'synthetic events do not manufacture user activation');
  assert.equal(detection.webdriver, webdriver);
  assert.deepEqual(detection.values, {
    name: DETECTION_TEXT.name, notes: DETECTION_TEXT.notes, query: DETECTION_TEXT.query, sort: 'price',
    status: 'More results loaded.', hash: '#results',
  });
  return {
    event_sequences: { status: 'pass', avoidable_flags: detection.report.flags },
    action_effects: { status: 'pass', counts: detection.report.counts },
    isolated_world: { status: 'pass', fai_globals: detection.globals },
    dom_cleanliness: { status: 'pass', mutations: detection.mutations },
    trusted_events: { status: 'inherent_limit', untrusted_events: detection.report.untrusted },
    user_activation: { status: 'inherent_limit', active: detection.activation },
    navigator_webdriver: { status: webdriver ? 'marionette_harness_only' : 'pass', value: detection.webdriver },
    persistent_dev_profile: { status: persistentProfile ? 'pass' : 'later_manual_check' },
  };
}
