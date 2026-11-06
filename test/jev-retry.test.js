// Jev guidance pass, retry switch: exponential backoff (300 ms, 900 ms, cap 2 s) honouring Retry-After /
// retry-after-ms, on 408, 429, 5xx and network errors. Delays are scaled down with retryDelayMs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TypeSafeProvider, retryAfterMs } from '../src/typesafe.js';

const actions = [{ id: 'a0', type: 'click', target: '1', role: 'link', label: 'About' }];
const ok = () => new Response(JSON.stringify({ answers: { action: { type: 'choice', choice: 'a0' } } }),
  { status: 200, headers: { 'Content-Type': 'application/json' } });
const status = (code, headers = {}) => new Response('busy', { status: code, headers });

function provider(responses, options = {}) {
  const times = [];
  const p = new TypeSafeProvider({
    requireKey: false, keyEnv: 'FAI_UNUSED_TEST_KEY', ...options,
    fetchImpl: async () => {
      times.push(Date.now());
      const next = responses.shift();
      return typeof next === 'function' ? next() : next;
    },
  });
  return { p, times };
}

test('defaults: two retries after the first attempt, at 300 ms then 900 ms', () => {
  const p = new TypeSafeProvider({ requireKey: false });
  assert.equal(p.retries, 2);
  assert.equal(p.retryDelayMs, 300);
  const legacy = new TypeSafeProvider({ requireKey: false, guidance: { retry: false } });
  assert.equal(legacy.retries, 1);
});

test('backoff grows x3 between attempts and succeeds on the third', async () => {
  const { p, times } = provider([status(503), status(502), ok()], { retryDelayMs: 20 });
  assert.equal((await p.decide({}, actions, {})).actionId, 'a0');
  assert.equal(times.length, 3);
  assert.ok(times[1] - times[0] >= 18, `first delay ${times[1] - times[0]}`);
  assert.ok(times[2] - times[1] >= 55, `second delay ${times[2] - times[1]}`);
});

test('408, 429 and network errors are retried; persistent 5xx fails after three attempts', async () => {
  for (const first of [() => status(408), () => status(429), () => { throw new TypeError('fetch failed'); }]) {
    const { p, times } = provider([first, ok()], { retryDelayMs: 1 });
    assert.equal((await p.decide({}, actions, {})).actionId, 'a0');
    assert.equal(times.length, 2);
  }
  const { p, times } = provider([status(503), status(503), status(503)], { retryDelayMs: 1 });
  await assert.rejects(p.decide({}, actions, {}), /HTTP 503/);
  assert.equal(times.length, 3);
});

test('408 is not retried with the retry switch off; 4xx client errors never are', async () => {
  const legacy = provider([status(408), ok()], { retryDelayMs: 1, guidance: { retry: false } });
  await assert.rejects(legacy.p.decide({}, actions, {}), /HTTP 408/);
  const client = provider([status(422), ok()], { retryDelayMs: 1 });
  await assert.rejects(client.p.decide({}, actions, {}), /HTTP 422/);
  assert.equal(client.times.length, 1);
});

test('Retry-After and retry-after-ms extend the wait; one beyond the 2 s cap fails at once', async () => {
  const ms = provider([status(429, { 'retry-after-ms': '80' }), ok()], { retryDelayMs: 1 });
  await ms.p.decide({}, actions, {});
  assert.ok(ms.times[1] - ms.times[0] >= 75, `waited ${ms.times[1] - ms.times[0]}`);
  const long = provider([status(429, { 'retry-after': '30' }), ok()], { retryDelayMs: 1 });
  await assert.rejects(long.p.decide({}, actions, {}), /HTTP 429/);
  assert.equal(long.times.length, 1);
});

test('retryAfterMs parses seconds, milliseconds and HTTP dates', () => {
  const headers = values => new Headers(values);
  assert.equal(retryAfterMs(headers({ 'retry-after': '2' })), 2000);
  assert.equal(retryAfterMs(headers({ 'retry-after-ms': '150' })), 150);
  const now = Date.parse('2026-10-04T10:00:00Z');
  assert.equal(retryAfterMs(headers({ 'retry-after': 'Sun, 04 Oct 2026 10:00:01 GMT' }), now), 1000);
  assert.equal(retryAfterMs(headers({})), null);
  assert.equal(retryAfterMs(headers({ 'retry-after': 'soon' })), null);
});

test('an abort is never retried', async () => {
  const controller = new AbortController();
  controller.abort();
  const { p, times } = provider([() => { throw new DOMException('aborted', 'AbortError'); }, ok()], { retryDelayMs: 1 });
  await assert.rejects(p.decide({}, actions, {}, controller.signal));
  assert.ok(times.length <= 1);
});

test('an abort during a backoff wait ends the wait at once and sends no further attempt', async () => {
  const controller = new AbortController();
  const { p, times } = provider([status(429, { 'retry-after': '1' }), ok()], { retryDelayMs: 1 });
  const started = Date.now();
  setTimeout(() => controller.abort(new DOMException('stop', 'AbortError')), 30);
  await assert.rejects(p.decide({}, actions, {}, controller.signal), error => error.name === 'AbortError');
  assert.ok(Date.now() - started < 500, `waited ${Date.now() - started} ms`);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(times.length, 1);
});
