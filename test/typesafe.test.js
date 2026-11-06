import test from 'node:test';
import assert from 'node:assert/strict';
import { DONE_QUESTION, TypeSafeProvider, LocalSystemOneProvider, criterion, providerPage } from '../src/typesafe.js';

const actions = [
  { id: 'a0', type: 'click', target: '1', role: 'link', label: 'About', description: 'Click link 1: About' },
  { id: 'a1', type: 'fill_supplied_text', target: '2', role: 'textbox', label: 'Name', suppliedName: 'name',
    description: 'Fill textbox 2: Name with supplied value name' },
  { id: 'a2', type: 'scroll', direction: 'down', label: 'scroll down', description: 'Scroll down to see more of the page' },
  { id: 'done', type: 'done', label: 'done', description: 'Finish.' },
];
const context = { instruction: 'Open About', history: [] };

function jsonResponse(body, { status = 200, statusText = 'OK', headers = {} } = {}) {
  return new Response(JSON.stringify(body), { status, statusText, headers: { 'Content-Type': 'application/json', ...headers } });
}
const answer = (choice = 'a0', extra = {}) => ({
  model: 'jev-latest',
  answers: { action: { type: 'choice', choice, confidence: 0.9, probabilities: { a0: 0.9, a2: 0.1 } } },
  usage: { input_tokens: 10, output_tokens: 3 },
  ...extra,
});

function provider(fetchImpl, options = {}) {
  return new TypeSafeProvider({ requireKey: false, keyEnv: 'FAI_UNUSED_TEST_KEY', retryDelayMs: 1, fetchImpl, ...options });
}

test('TypeSafe uses the typed choice endpoint, compact criteria and bearer key', async () => {
  process.env.FAI_TEST_KEY = 'sentinel';
  let request;
  const p = new TypeSafeProvider({
    keyEnv: 'FAI_TEST_KEY',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return jsonResponse(answer(), { headers: { 'x-typesafe-request-id': 'req-123' } });
    },
  });
  const page = { revision: 'r1', url: 'https://example.com/', title: 'Home', text: 'Hi', controls: [] };
  const result = await p.decide(page, actions, context);
  delete process.env.FAI_TEST_KEY;
  assert.equal(request.url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(request.options.headers.Authorization, 'Bearer sentinel');
  const body = JSON.parse(request.options.body);
  // done is not an action criterion: it is a separate noul question in the same request.
  assert.deepEqual(body.questions.action.criteria, {
    a0: '1 link About',
    a1: 'fill 2 textbox Name with supplied value name',
    a2: 'Scroll down to see more of the page',
  });
  assert.deepEqual(body.questions.done, { type: 'noul', instructions: DONE_QUESTION });
  assert.doesNotMatch(body.questions.action.instructions, /done/);
  assert.equal(body.state.page.revision, undefined);
  assert.equal(result.actionId, 'a0');
  assert.equal(result.confidence, 0.9);
  assert.deepEqual(result.probabilities, { a0: 0.9, a2: 0.1 });
  // The server did not answer the done question: no done on the decision (expectation-only completion).
  assert.equal(result.done, undefined);
  assert.equal(result.requestId, 'req-123');
  assert.equal(result.model, 'jev-latest');
  assert.ok(Number.isFinite(result.latencyMs));
});

test('the done answer becomes done.probability; a done action choice is rejected; bad done values are dropped', async () => {
  const reply = done => async () => jsonResponse(answer('a0', {
    answers: { action: { type: 'choice', choice: 'a0', confidence: 0.7 }, done },
  }));
  assert.deepEqual((await provider(reply({ type: 'noul', noul: 0.91 })).decide({}, actions, context)).done,
    { probability: 0.91 });
  assert.equal((await provider(reply({ type: 'noul', noul: 1.5 })).decide({}, actions, context)).done, undefined);
  assert.equal((await provider(reply({ type: 'choice', choice: 'x' })).decide({}, actions, context)).done, undefined);
  const local = new LocalSystemOneProvider({ port: 8009, fetchImpl: reply({ type: 'noul', noul: 0.2 }) });
  assert.deepEqual((await local.decide({}, actions, context)).done, { probability: 0.2 });
  await assert.rejects(provider(async () => jsonResponse(answer('done'))).decide({}, actions, context),
    /Invalid decision/);
});

test('provider page payload caps text at 6000 chars and controls at 60', () => {
  const observation = {
    revision: 'r',
    url: 'https://example.com/',
    title: 'T',
    text: 'x'.repeat(10000),
    controls: Array.from({ length: 80 }, (_, i) => ({ id: String(i), role: 'button', label: 'b', bounds: { x: 0 } })),
  };
  const page = providerPage(observation);
  assert.equal(page.text.length, 6000);
  assert.equal(page.controls.length, 60);
  assert.equal(page.revision, undefined);
  assert.equal(page.controls[0].bounds, undefined);
});

test('provider page text leaves out visually hidden status lines, keeps the same words in a visible line', () => {
  const observation = {
    url: 'https://example.com/search',
    title: 'T',
    text: 'Date grid\nFetching results\nLoading results\nTop flights\nLoading results is slow today',
    blocks: [
      { t: 'p', text: 'Fetching results', hidden: true },
      { t: 'p', text: 'Loading results', hidden: true },
      { t: 'p', text: 'Top flights' },
    ],
    controls: [],
  };
  assert.equal(providerPage(observation).text, 'Date grid\nTop flights\nLoading results is slow today');
  // No hidden block: the text is sent as read.
  assert.equal(providerPage({ ...observation, blocks: [] }).text, observation.text);
});

test('criteria reference controls and never carry supplied values', () => {
  const toggle = { type: 'click', target: '4', role: 'checkbox', label: 'Agree', checked: false };
  assert.equal(criterion(toggle), '4 checkbox Agree (unchecked)');
  const select = { type: 'select', target: '5', role: 'combobox', label: 'Plan', value: 'pro', optionLabel: 'Pro' };
  assert.equal(criterion(select), 'select "Pro" in 5 combobox Plan');
  const fill = { type: 'fill_supplied_text', target: '2', role: 'textbox', label: 'Name', suppliedName: 'name', text: 'SECRET' };
  assert.equal(criterion(fill), 'fill 2 textbox Name with supplied value name');
});

test('invalid choice rejected', async () => {
  await assert.rejects(provider(async () => jsonResponse(answer('bad'))).decide({}, actions, context), /Invalid decision/);
});

test('missing usage, confidence and probabilities and unknown fields are tolerated', async () => {
  const minimal = { answers: { action: { choice: 'a0', extra: 1 } }, latency_ms: 42, server: 'kev' };
  const p = provider(async () => jsonResponse(minimal));
  const result = await p.decide({}, actions, context);
  assert.equal(result.actionId, 'a0');
  assert.equal(result.usage, undefined);
  assert.equal(result.confidence, undefined);
  assert.equal(result.latencyMs, 42);
  // Probabilities for unknown ids are dropped rather than failing the decision.
  const odd = { answers: { action: { type: 'choice', choice: 'a0', probabilities: { zz: 1, a0: 0.5 } } } };
  const q = provider(async () => jsonResponse(answer('a0', odd)));
  assert.deepEqual((await q.decide({}, actions, context)).probabilities, { a0: 0.5 });
});

for (const [name, first] of [
  ['429', () => jsonResponse({ error: 'slow down' }, { status: 429, statusText: 'Too Many Requests' })],
  ['503', () => jsonResponse({ error: 'busy' }, { status: 503, statusText: 'Service Unavailable' })],
  ['network error', () => { throw new TypeError('fetch failed'); }],
]) {
  test(`retries once after ${name} (retry switch off: the earlier single retry)`, async () => {
    let calls = 0;
    const p = provider(async () => (++calls === 1 ? first() : jsonResponse(answer())), { guidance: { retry: false } });
    const result = await p.decide({}, actions, context);
    assert.equal(result.actionId, 'a0');
    assert.equal(calls, 2);
  });
}

test('second failure surfaces status text and a body snippet (retry switch off)', async () => {
  let calls = 0;
  const p = provider(async () => {
    calls++;
    return new Response('upstream model overloaded\n please retry', { status: 502, statusText: 'Bad Gateway' });
  }, { guidance: { retry: false } });
  await assert.rejects(p.decide({}, actions, context), /HTTP 502 Bad Gateway: upstream model overloaded please retry/);
  assert.equal(calls, 2);
});

test('client errors are not retried', async () => {
  let calls = 0;
  const p = provider(async () => {
    calls++;
    return jsonResponse({ error: 'bad key' }, { status: 401, statusText: 'Unauthorized' });
  });
  await assert.rejects(p.decide({}, actions, context), /HTTP 401 Unauthorized/);
  assert.equal(calls, 1);
});

test('abort is never retried', async () => {
  let calls = 0;
  const controller = new AbortController();
  controller.abort();
  const p = provider(async (_, { signal }) => {
    calls++;
    signal.throwIfAborted();
  });
  await assert.rejects(p.decide({}, actions, context, controller.signal));
  assert.equal(calls, 1);
});

test('port option targets a loopback server with the longer local timeout', () => {
  const kev = new LocalSystemOneProvider({ port: 8009 });
  assert.equal(kev.endpoint, 'http://127.0.0.1:8009/v1/systemone');
  assert.equal(kev.timeoutMs, 30000);
  assert.equal(new LocalSystemOneProvider().endpoint, 'http://127.0.0.1:8000/v1/systemone');
  assert.equal(new TypeSafeProvider().timeoutMs, 10000);
  assert.equal(new TypeSafeProvider({ timeoutMs: 1234 }).timeoutMs, 1234);
  assert.throws(() => new TypeSafeProvider({ endpoint: 'http://example.com/v1/systemone' }), /HTTPS or loopback/);
  assert.throws(() => new TypeSafeProvider({ port: 0 }), /port/);
});

test('local provider does not forward hosted key', async () => {
  const old = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = 'hosted-sentinel';
  let headers;
  const fetchImpl = async (_, options) => {
    headers = options.headers;
    return jsonResponse(answer());
  };
  const p = new LocalSystemOneProvider({ fetchImpl });
  await p.decide({}, actions, context);
  assert.equal(headers.Authorization, undefined);
  if (old === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = old;
});

test('warm() sends an unauthenticated GET to /v1/models and never throws', async () => {
  process.env.FAI_TEST_KEY = 'sentinel';
  let request;
  const fetchImpl = async (url, options) => {
    request = { url: String(url), options };
    return new Response('{}', { status: 401 });
  };
  const ok = new TypeSafeProvider({ keyEnv: 'FAI_TEST_KEY', fetchImpl });
  const warmed = await ok.warm();
  delete process.env.FAI_TEST_KEY;
  assert.equal(request.url, 'https://api.typesafe.ai/v1/models');
  assert.equal(request.options.method, 'GET');
  assert.equal(request.options.headers, undefined);
  assert.deepEqual([warmed.ok, warmed.status], [true, 401]);
  const failing = provider(async () => { throw new TypeError('connect ECONNREFUSED'); });
  const result = await failing.warm();
  assert.equal(result.ok, false);
  assert.match(result.error, /ECONNREFUSED/);
});

test('provider page text drops one line per hidden block: a visible line with the same words stays', () => {
  const observation = {
    url: 'https://example.com/search', title: 'T',
    // The hidden span first, then a visible "Loading results" placeholder the user sees.
    text: 'Loading results\nTop flights\nLoading results',
    blocks: [{ t: 'p', text: 'Loading results', hidden: true }, { t: 'p', text: 'Top flights' }, { t: 'p', text: 'Loading results' }],
    controls: [],
  };
  assert.equal(providerPage(observation).text, 'Top flights\nLoading results');
});
