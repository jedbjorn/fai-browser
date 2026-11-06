import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserRuntime } from '../src/runtime.js';
import { LocalSystemOneProvider } from '../src/typesafe.js';
import { FakeBridge, ORIGIN } from './runtime-fixtures.js';

async function startServer(handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let input = '';
    for await (const chunk of req) input += chunk;
    const body = input ? JSON.parse(input) : null;
    requests.push({ method: req.method, path: req.url, body, authorization: req.headers.authorization });
    handler(req, res, body, requests.length);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, requests, port: server.address().port, close: () => new Promise(resolve => server.close(resolve)) };
}

// Answers both SystemOne requests the runtime sends: `action` plus `done` (decide) and `answer` (choose).
function choose(res, body, { requestId } = {}) {
  let answers;
  if (!body.questions.action && !body.questions.answer) {
    // The slim done-and-guards request (confirm): no action to choose.
    answers = { done: { type: 'noul', noul: 0.5 }, blocked: { type: 'noul', noul: 0.01 }, injection: { type: 'noul', noul: 0.01 } };
  } else if (body.questions.answer) {
    const criteria = body.questions.answer.criteria;
    const choice = Object.keys(criteria).find(key => criteria[key] === 'Members') ?? Object.keys(criteria)[0];
    answers = { answer: { type: 'choice', choice, confidence: 0.8, probabilities: { [choice]: 0.8 } } };
  } else {
    const criteria = body.questions.action.criteria;
    const onAbout = body.state.page.title === 'About';
    const choice = onAbout ? 'handoff' : Object.keys(criteria).find(key => criteria[key] === '1 link About');
    answers = {
      action: { type: 'choice', choice, confidence: 1, probabilities: { [choice]: 1 } },
      done: { type: 'noul', noul: onAbout ? 0.93 : 0.04 },
    };
  }
  res.writeHead(200, { 'Content-Type': 'application/json', ...(requestId ? { 'x-typesafe-request-id': requestId } : {}) });
  res.end(JSON.stringify({
    model: 'fixture-systemone',
    answers,
    usage: { input_tokens: 100, output_tokens: 2 },
    latency_ms: 7,
  }));
}

test('SystemOne adapter HTTP contract completes a fixture task with evidence', async () => {
  const fixture = await startServer((req, res, body) => choose(res, body, { requestId: 'fixture-req-1' }));
  const runtime = new BrowserRuntime({
    provider: new LocalSystemOneProvider({ port: fixture.port, model: 'fixture-systemone', keyEnv: 'FAI_HTTP_TEST_UNUSED_KEY' }),
    bridge: new FakeBridge(),
  });
  try {
    // Not a bounded imperative ("each"), so the landing page gets the done-gated terminal decide this test is about.
    const result = await runtime.run('Open About. Check each line.', { expectation: { urlEquals: `${ORIGIN}/about`,
      textIncludes: 'about us' } });
    assert.equal(result.status, 'completed');
    assert.equal(result.verification.passed, true);
    assert.equal(result.steps.length, 1);
    // The expectation passes on About, and the second decision's done question confirms it there (done 0.93),
    // so the provider's handoff choice is never acted on. The third request ranks the answer candidates; its
    // tokens count, but it is not a decision.
    assert.equal(result.code, 'expectation_passed');
    assert.equal(result.cost.decisions, 2);
    assert.deepEqual([result.cost.inputTokens, result.cost.outputTokens], [300, 6]);
    assert.equal(result.cost.provider, 'fixture-systemone');
    assert.equal(fixture.requests.length, 3);
    assert.equal(fixture.requests[0].body.questions.done.type, 'noul');
    assert.equal(fixture.requests[0].body.questions.action.criteria.done, undefined);
    assert.equal(result.steps[0].decision.done, 0.04);
    const [request, , answerRequest] = fixture.requests;
    assert.ok(request.path === '/v1/systemone' && request.method === 'POST' && request.authorization === undefined);
    assert.equal(request.body.questions.action.type, 'choice');
    assert.equal(request.body.state.instruction, 'Open About. Check each line.');
    assert.equal(request.body.state.page.revision, undefined);
    const [step] = result.steps;
    assert.equal(step.screenshot.revision, step.observation.revision);
    assert.equal(step.decision.requestId, 'fixture-req-1');
    assert.equal(step.decision.latencyMs, 7);

    assert.equal(answerRequest.body.questions.action, undefined);
    assert.equal(answerRequest.body.questions.answer.type, 'choice');
    assert.equal(answerRequest.body.state.question, 'Open About. Check each line.');
    assert.equal(answerRequest.body.state.page, undefined, 'choose sends candidate texts, not the page');
    assert.equal(result.answer.method, 'provider');
    assert.equal(result.answer.candidates[0].text, 'Members');
    assert.equal(result.answer.candidates[0].confidence, 0.8);
    assert.deepEqual(result.answer.candidates[0].source, { t: 'a', ref: '1' });
    assert.equal(result.answerDetail.requestId, 'fixture-req-1');
  } finally {
    await fixture.close();
  }
});

test('SystemOne adapter retries a 503 from a real HTTP server once', async () => {
  const fixture = await startServer((req, res, body, count) => {
    if (count === 1) {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      return res.end('warming up');
    }
    return choose(res, body);
  });
  const provider = new LocalSystemOneProvider({ port: fixture.port, retryDelayMs: 5 });
  const runtime = new BrowserRuntime({ provider, bridge: new FakeBridge() });
  try {
    const result = await runtime.step('Open About', { expectation: { urlIncludes: '/about' } });
    assert.equal(result.status, 'completed');
    // 503, retried decide, then the answer request.
    assert.equal(fixture.requests.length, 3);
    assert.ok(fixture.requests[2].body.questions.answer);
  } finally {
    await fixture.close();
  }
});

test('warm() reaches /v1/models on a local server', async () => {
  const fixture = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"data":[]}');
  });
  try {
    const result = await new LocalSystemOneProvider({ port: fixture.port }).warm();
    assert.equal(result.ok, true);
    assert.equal(fixture.requests[0].path, '/v1/models');
    assert.equal(fixture.requests[0].method, 'GET');
  } finally {
    await fixture.close();
  }
});

test('choose() over real HTTP: one choice question over redacted, clipped candidate texts', async () => {
  const fixture = await startServer((req, res, body) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'x-typesafe-request-id': 'answer-1' });
    res.end(JSON.stringify({
      answers: { answer: { type: 'choice', choice: 'c1', confidence: 0.7, probabilities: { c0: 0.2, c1: 0.7, zz: 0.1 } } },
      usage: { input_tokens: 40, output_tokens: 1 },
    }));
  });
  const provider = new LocalSystemOneProvider({ port: fixture.port, model: 'fixture-systemone' });
  const candidates = Array.from({ length: 70 }, (_, i) => ({ id: `c${i}`, text: `${'x'.repeat(400)} ${i}` }));
  candidates[1].text = 'Pro $37 per month';
  try {
    const reply = await provider.choose({
      instruction: 'Open the pricing page',
      question: 'What is the monthly price of the Pro plan?',
      candidates,
      signal: AbortSignal.timeout(2000),
    });
    assert.deepEqual(reply, {
      choice: 'c1', confidence: 0.7, probabilities: { c0: 0.2, c1: 0.7 },
      usage: { input_tokens: 40, output_tokens: 1 }, model: 'fixture-systemone', requestId: 'answer-1',
      latencyMs: reply.latencyMs, request: reply.request,
    });
    const [{ body }] = fixture.requests;
    // The body's size by section (numbers only): 60 candidates offered.
    assert.equal(reply.request.options, 60);
    assert.equal(reply.request.chars.total, JSON.stringify(body).length);
    assert.equal(reply.request.chars.options, JSON.stringify(body.questions.answer.criteria).length);
    assert.deepEqual(Object.keys(body.questions), ['answer']);
    const { criteria } = body.questions.answer;
    assert.equal(Object.keys(criteria).length, 60);
    assert.equal(criteria.c1, 'Pro $37 per month');
    assert.equal(criteria.c0.length, 300);
    assert.deepEqual(body.state, {
      question: 'What is the monthly price of the Pro plan?',
      instruction: 'Open the pricing page',
    });
    await assert.rejects(provider.choose({ question: 'q', candidates: [] }), TypeError);
  } finally {
    await fixture.close();
  }
});

test('the runtime redacts supplied values from choose() candidates over real HTTP', async () => {
  const secret = 'Ada Lovelace-42';
  const fixture = await startServer((req, res, body) => {
    const answers = body.questions.answer
      ? { answer: { type: 'choice', choice: Object.keys(body.questions.answer.criteria)[0], confidence: 0.6 } }
      : { action: { type: 'choice', choice: 'handoff' }, done: { type: 'noul', noul: 0.95 } };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ answers }));
  });
  const pages = {
    '/': {
      title: 'Profile',
      text: '',
      controls: [],
      blocks: [
        { t: 'h1', text: 'Profile' },
        { t: 'h2', text: 'Display name' },
        { t: 'p', text: `Your display name is ${secret}.` },
        { t: 'p', text: 'Shown on invoices and receipts.' },
      ],
    },
  };
  const runtime = new BrowserRuntime({
    provider: new LocalSystemOneProvider({ port: fixture.port }),
    bridge: new FakeBridge({ pages }),
  });
  try {
    const result = await runtime.run('What display name is shown?', { suppliedText: { name: secret } });
    // No expectation and done 0.95 (at least 0.8): the run ends unverified on the first page.
    assert.equal(result.status, 'unverified');
    assert.equal(result.code, 'no_expectation');
    const answerRequest = fixture.requests.find(request => request.body.questions.answer);
    const sent = JSON.stringify(answerRequest.body);
    assert.ok(!sent.includes(secret), 'the supplied value never reaches the provider');
    assert.match(sent, /\[supplied:name\]/);
    // The host-facing candidates are page text as the host's own value appears on the page.
    assert.equal(result.answer.method, 'provider');
    assert.equal(result.answer.candidates[0].text, `Your display name is ${secret}.`);
  } finally {
    await fixture.close();
  }
});
