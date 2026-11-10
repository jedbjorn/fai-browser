import test from 'node:test';
import assert from 'node:assert/strict';
import { legalActions } from '../src/runtime.js';
import { leanObserve } from '../src/result.js';
import { FrameParser } from '../src/ws.js';
import { ORIGIN } from './runtime-fixtures.js';

test('codex: lean observe stays under 40 with many new-tab navigation controls', () => {
  const observation = { url: ORIGIN, revision: 'r', controls: Array.from({ length: 100 }, (_, i) => ({
    id: String(i + 1), role: 'link', label: `Link ${i}`, href: `${ORIGIN}/page${i}`, linkTarget: '_blank',
  })) };
  const actions = legalActions(observation, { allowedUrls: [`${ORIGIN}/explicit`] });
  const lean = leanObserve({ page: observation, actions });
  assert.ok(lean.actions.length <= 40, `got ${lean.actions.length} actions`);
  for (const action of actions.filter(a => a.type === 'scroll' || a.type === 'wait' || a.url?.endsWith('/explicit'))) {
    assert.ok(lean.actions.some(a => a.id === action.id), `lost page action ${action.id}`);
  }
  assert.equal(lean.moreActions, actions.length - lean.actions.length);
});

test('codex: WebSocket rejects non-minimal extended payload lengths', () => {
  // Masked, FIN text frames containing "x", encoded illegally with a 16- or 64-bit length instead of 7 bits.
  for (const frame of [
    Buffer.from([0x81, 0xfe, 0, 1, 0, 0, 0, 0, 0x78]),
    Buffer.from([0x81, 0xff, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0x78]),
  ]) {
    assert.throws(() => new FrameParser().push(frame), error => error.closeCode === 1002);
  }
});

test('codex: WebSocket rejects the reserved high length bit as a protocol error', () => {
  const header = Buffer.from([0x81, 0xff, 0x80, 0, 0, 0, 0, 0, 0, 0]);
  assert.throws(() => new FrameParser().push(header), error => error.closeCode === 1002);
});

