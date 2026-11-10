import test from 'node:test';
import assert from 'node:assert/strict';
import { BRIDGE_ERROR_CODES } from '../src/bridge.js';
import { outcomeResult } from '../src/result.js';

test('codex: every BridgeError code has the expected result status', () => {
  const expected = {
    stale: 'needs_host', target_unavailable: 'needs_host', capture_failed: 'needs_host',
    unsupported: 'needs_host', timeout: 'failed', stopped: 'stopped',
    blocked_risky: 'needs_user', cross_origin: 'needs_user', child_tab: 'needs_user',
    tab_changed: 'needs_user', origin_changed: 'needs_user', session_inactive: 'needs_user',
    disconnected: 'needs_user', paused: 'needs_user',
    no_control: 'needs_host', point_outside: 'needs_host', point_frame: 'needs_host',
    js_dialog: 'needs_user', line_break_input: 'needs_host',
  };
  assert.deepEqual(Object.keys(expected).sort(), [...BRIDGE_ERROR_CODES].sort());
  for (const [bridgeCode, status] of Object.entries(expected)) {
    const result = outcomeResult(bridgeCode);
    assert.equal(result.code, bridgeCode);
    assert.equal(result.status, status, bridgeCode);
  }
});
