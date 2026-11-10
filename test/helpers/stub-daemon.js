// In-process stand-in for the Phase 2 daemon's client API (design section 2) with canned data. D3's MCP, CLI and
// setup tests run against it until the real daemon lands; it also checks auth and records every call.
import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PACKAGE = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
// A minimal JPEG (SOI + APP0 + EOI); the MCP server only reads and base64-encodes the bytes.
const JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');
const RESUMABLE = new Set(['pending', 'paused']);

function httpError(status, code, message, retryable = false) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.retryable = retryable;
  return error;
}

function clampWait(value, fallback) {
  const number = Number.isFinite(value) ? value : fallback;
  return Math.max(0, Math.min(45_000, number));
}

/**
 * Start the stub. `behavior` controls canned outcomes:
 *   steps, stepMs        how many steps a run takes and how long each one lasts
 *   finalStatus, finalCode  status and code of the finished run
 *   autoGrant            requests become active as soon as they are created
 *   requestWaitCapMs     the longest one request wait (approval) blocks, like the daemon's own cap
 *   hang                 set of route keys ("GET /v1/status") that never answer
 *   bigImage             the final screenshot is larger than 1.5 MB
 */
export async function startStubDaemon(behavior = {}) {
  const home = await mkdtemp(join(tmpdir(), 'fai-stub-home-'));
  const token = randomBytes(32).toString('hex');
  const events = new EventEmitter();
  events.setMaxListeners(100);
  const stub = {
    home,
    token,
    version: PACKAGE.version,
    calls: [],
    requests: new Map(),
    runs: new Map(),
    behavior: {
      steps: 2,
      stepMs: 30,
      finalStatus: 'completed',
      finalCode: 'expectation_passed',
      autoGrant: false,
      hang: new Set(),
      bigImage: false,
      ...behavior,
    },
  };
  const hung = new Set();

  function changed() {
    events.emit('change');
  }

  function requestView(request) {
    return {
      requestId: request.requestId,
      state: request.state,
      stateReason: request.stateReason ?? null,
      origins: request.origins,
      mode: request.mode,
      // The user's approval: the requested mode (as an extension that preselects the request's level would send).
      grant: request.state === 'active' || request.state === 'paused'
        ? { level: request.grantLevel ?? request.mode, testing: (request.grantLevel ?? request.mode) === 'testing', grantedAt: request.createdAt }
        : null,
      reason: request.reason,
      instruction: request.instruction ?? null,
      client: request.client,
      createdAt: request.createdAt,
      expiresAt: request.expiresAt,
      lease: request.state === 'active' || request.state === 'paused'
        // `leaseOrigins`: what the lease covers when a test narrows a domain root to one origin (origin scope).
        ? { leaseId: request.leaseId, tabId: 412, origin: request.origins[0], origins: request.leaseOrigins ?? request.origins,
          grantedAt: request.createdAt }
        : null,
      activeRunId: request.activeRunId ?? null,
      lastRunId: request.lastRunId ?? null,
      // How a pending request is approved (the daemon's view): `page` when the extension opened its page by itself,
      // else `window`; `behavior.approval` sets it (the daemon's default wording is the window's).
      approval: request.state === 'pending' ? (stub.behavior.approval ?? 'window') : null,
    };
  }

  function setRequestState(requestId, state, stateReason = null) {
    const request = stub.requests.get(requestId);
    request.state = state;
    request.stateReason = stateReason;
    if (state === 'active' && !request.leaseId) {
      request.leaseId = randomUUID();
    }
    changed();
  }

  stub.grant = requestId => setRequestState(requestId, 'active');
  stub.setRequestState = setRequestState;
  stub.callsTo = (method, prefix) => stub.calls.filter(call => call.method === method && call.path.startsWith(prefix));

  function snapshot(run) {
    if (run.done) {
      return { state: 'done', runId: run.runId, result: run.result };
    }
    const last = run.stepRecords.at(-1);
    return {
      state: 'running',
      runId: run.runId,
      progress: {
        steps: run.stepRecords.length,
        maxActions: run.maxActions,
        elapsedMs: Date.now() - run.started,
        lastStep: last ? { i: last.i, action: { type: last.action.type, ref: last.action.ref }, ms: last.ms } : null,
      },
    };
  }

  function finishRun(run, status, code, message = '') {
    if (run.done) {
      return;
    }
    clearTimeout(run.timer);
    run.done = true;
    const request = stub.requests.get(run.requestId);
    if (request && request.activeRunId === run.runId) {
      request.activeRunId = null;
      request.lastRunId = run.runId;
    }
    run.result = {
      v: 1,
      runId: run.runId,
      status,
      code,
      reason: `stub ${code}`,
      needs: { who: status === 'completed' ? 'none' : 'host', message },
      verification: { checked: Boolean(run.expectation), passed: status === 'completed', expectation: run.expectation },
      page: { url: 'https://example.com/members', title: 'Members', textExcerpt: 'Members: 3', truncated: false,
        controls: [] },
      steps: run.stepRecords,
      cost: { provider: 'stub', decisions: run.stepRecords.length, inputTokens: 0, outputTokens: 0,
        elapsedMs: Date.now() - run.started },
      trace: join(run.dir, 'trace.json'),
      lease: { requestId: run.requestId, state: request?.state ?? 'released' },
    };
    // Optional extra result fields (e.g. a receipt v2 verdict), an object or a function of the run.
    const extra = stub.behavior.finalExtra;
    if (extra) Object.assign(run.result, typeof extra === 'function' ? extra(run) : structuredClone(extra));
    changed();
  }

  async function advance(run) {
    if (run.done) {
      return;
    }
    const i = run.stepRecords.length + 1;
    const big = stub.behavior.bigImage && i === run.totalSteps;
    const screenshot = join(run.dir, `${i}.jpg`);
    await writeFile(screenshot, big ? Buffer.alloc(1.6 * 1024 * 1024, 1) : JPEG);
    run.stepRecords.push({
      i,
      action: { type: 'click', ref: String(i + 2), label: `Link ${i}` },
      observation: { url: 'https://example.com/members', title: 'Members' },
      screenshot: run.capture === 'none' ? null : screenshot,
      ms: { total: 40 },
    });
    changed();
    if (run.done) {
      return;
    }
    if (i >= run.totalSteps) {
      const { finalStatus, finalCode } = stub.behavior;
      const status = run.operation === 'step' && finalStatus === 'completed' && !run.expectation ? 'checkpoint'
        : finalStatus;
      finishRun(run, status, status === 'checkpoint' ? 'step_complete' : finalCode);
      return;
    }
    run.timer = setTimeout(() => advance(run), stub.behavior.stepMs);
  }

  async function startRun(body, operation) {
    const request = stub.requests.get(body.requestId);
    if (!request) {
      throw httpError(404, 'unknown_request', `No tab request ${body.requestId}; the daemon may have restarted. `
        + 'Request a tab again.');
    }
    // Like the daemon: no 422 for a mode above the grant; the run is clamped to it (receipt permissions).
    if (body.providerOptions?.endpoint) {
      throw httpError(422, 'provider_option_forbidden', 'providerOptions.endpoint is not accepted from clients');
    }
    if (request.activeRunId) {
      throw httpError(409, 'run_active', 'Another run is active on this lease');
    }
    const runId = randomUUID();
    const dir = join(home, 'artifacts', runId);
    await mkdir(dir, { recursive: true });
    const run = {
      runId,
      requestId: request.requestId,
      operation,
      body,
      dir,
      started: Date.now(),
      maxActions: body.maxActions ?? (operation === 'run' ? 8 : 1),
      totalSteps: operation === 'run' ? stub.behavior.steps : 1,
      expectation: body.expectation ?? null,
      capture: body.capture ?? 'each',
      stepRecords: [],
      done: false,
      result: null,
    };
    stub.runs.set(runId, run);
    if (request.state !== 'active') {
      const mapping = {
        pending: ['needs_user', 'select_tab', 'No tab is selected for this request yet. Ask the user to click the '
          + 'FAI Browser icon and approve it, then wait.'],
        paused: ['needs_user', request.stateReason || 'paused', 'The tab lease is paused.'],
      }[request.state] ?? ['needs_host', 'request_closed', 'This tab request has ended.'];
      finishRun(run, ...mapping);
      run.result.trace = null;
      return run;
    }
    request.activeRunId = runId;
    run.timer = setTimeout(() => advance(run), stub.behavior.stepMs);
    return run;
  }

  // Resolves when `ready()` is true, or after maxMs.
  function waitFor(ready, maxMs) {
    if (ready() || maxMs <= 0) {
      return Promise.resolve();
    }
    return new Promise(resolveWait => {
      const onChange = () => {
        if (ready()) {
          finish();
        }
      };
      const timer = setTimeout(finish, maxMs);
      function finish() {
        clearTimeout(timer);
        events.off('change', onChange);
        resolveWait();
      }
      events.on('change', onChange);
    });
  }

  async function waitRun(run, maxMs, afterStep) {
    await waitFor(() => run.done || (afterStep !== undefined && run.stepRecords.length > afterStep), maxMs);
    return snapshot(run);
  }

  function getRun(runId) {
    const run = stub.runs.get(runId);
    if (!run) {
      throw httpError(404, 'unknown_run', `No run ${runId}`);
    }
    return run;
  }

  function getRequest(requestId) {
    const request = stub.requests.get(requestId);
    if (!request) {
      throw httpError(404, 'unknown_request', `No tab request ${requestId}; the daemon may have restarted. `
        + 'Request a tab again.');
    }
    return request;
  }

  function release(requestId) {
    const request = getRequest(requestId);
    if (request.activeRunId) {
      finishRun(stub.runs.get(request.activeRunId), 'stopped', 'cancelled');
    }
    const state = request.state === 'pending' ? 'cancelled' : 'released';
    if (!['cancelled', 'released', 'expired', 'denied'].includes(request.state)) {
      setRequestState(requestId, state, 'released');
    }
    return { requestId, state: request.state };
  }

  async function route(method, url, body, headers) {
    const path = url.pathname;
    if (method === 'GET' && path === '/v1/health') {
      return [200, { ok: true, service: 'fai-browser', version: stub.version, pid: process.pid }];
    }
    if (headers.origin) {
      throw httpError(403, 'forbidden_origin', 'Requests with an Origin header are refused');
    }
    if (headers.authorization !== `Bearer ${token}`) {
      throw httpError(401, 'unauthorized', 'Missing or wrong client token');
    }
    if (method === 'GET' && path === '/v1/status') {
      const views = [...stub.requests.values()].map(requestView);
      const runs = [...stub.runs.values()];
      return [200, {
        daemon: { version: stub.version, pid: process.pid, port: stub.port, uptimeMs: 1000, home, log: null },
        extension: { connected: true, transport: 'websocket', version: '0.3.0', lastSeenMs: 10 },
        provider: { default: 'typesafe', keyConfigured: true },
        requests: views,
        runs: {
          active: runs.filter(run => !run.done).map(run => ({ runId: run.runId })),
          recent: runs.filter(run => run.done).map(run => ({ runId: run.runId, status: run.result.status })),
        },
        warnings: [],
      }];
    }
    if (method === 'POST' && path === '/v1/requests') {
      const origins = body.origins;
      if (!Array.isArray(origins) || !origins.length || !body.reason) {
        throw httpError(400, 'invalid_options', 'origins and reason are required');
      }
      const requestId = `req_${randomBytes(6).toString('hex')}`;
      const now = new Date();
      stub.requests.set(requestId, {
        requestId,
        state: 'pending',
        origins,
        mode: body.mode ?? 'read-only',
        reason: body.reason,
        instruction: body.instruction,
        client: String(headers['x-fai-client'] ?? 'unknown').split('/')[0],
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + (body.ttlMs ?? 600_000)).toISOString(),
      });
      if (stub.behavior.autoGrant) {
        setTimeout(() => stub.grant(requestId), 20);
      }
      return [201, {
        requestId,
        state: 'pending',
        extensionConnected: true,
        expiresAt: stub.requests.get(requestId).expiresAt,
        message: 'Ask the user to click the FAI Browser icon in Chrome on an approved page and choose this request.',
        request: requestView(stub.requests.get(requestId)),
      }];
    }
    if (method === 'GET' && path === '/v1/requests') {
      return [200, { requests: [...stub.requests.values()].map(requestView) }];
    }
    const requestMatch = path.match(/^\/v1\/requests\/([^/]+)$/);
    if (requestMatch && method === 'GET') {
      return [200, requestView(getRequest(requestMatch[1]))];
    }
    if (requestMatch && method === 'DELETE') {
      return [200, release(requestMatch[1])];
    }
    if (method === 'POST' && path === '/v1/wait') {
      const maxMs = Math.min(clampWait(body.maxMs, 30_000), body.runId ? Infinity : stub.behavior.requestWaitCapMs ?? Infinity);
      if (body.runId) {
        return [200, await waitRun(getRun(body.runId), maxMs, body.afterStep)];
      }
      const request = getRequest(body.requestId);
      const whileStates = new Set(body.while ?? RESUMABLE);
      const started = Date.now();
      await waitFor(() => !whileStates.has(request.state), maxMs);
      // `behavior.budget`: the budget the daemon reports in effect (the user's popup setting); an older daemon sends none.
      return [200, { state: request.state, request: requestView(request), waitedMs: Date.now() - started,
        ...(stub.behavior.budget ? { budget: stub.behavior.budget } : {}) }];
    }
    if (method === 'POST' && path === '/v1/runs') {
      // A test may make the stub refuse a body the way a (possibly older) daemon would: return the message.
      const refusal = stub.behavior.rejectRun?.(body);
      if (refusal) throw httpError(400, 'invalid_options', refusal);
      const run = await startRun(body, body.operation === 'step' ? 'step' : 'run');
      return [200, await waitRun(run, clampWait(body.waitMs, 40_000))];
    }
    if (method === 'POST' && path === '/v1/observe') {
      const request = getRequest(body.requestId);
      if (request.state !== 'active') {
        throw httpError(409, 'request_closed', `Request ${request.requestId} is ${request.state}`);
      }
      const observeId = randomUUID();
      const dir = join(home, 'artifacts', observeId);
      await mkdir(dir, { recursive: true });
      const screenshot = join(dir, 'observe.jpg');
      await writeFile(screenshot, JPEG);
      stub.lastRevision = `r_${randomBytes(3).toString('hex')}`;
      return [200, {
        state: 'ok',
        observeId,
        requestId: request.requestId,
        revision: stub.lastRevision,
        page: { url: 'https://example.com/', title: 'Home', text: 'Welcome', warnings: ['controls_capped'],
          consent: { text: 'We use cookies', buttons: [{ id: '9', label: 'Reject all', kind: 'reject' }] },
          controls: [{ id: '3', role: 'link', label: 'About' }] },
        actions: [{ id: 'a0', type: 'click', target: '3', label: 'About', description: 'Click link 3: About' }],
        screenshot: body.capture === false ? null : screenshot,
        image: body.capture === false ? null : { revision: stub.lastRevision, width: 1280, height: 800, tags: 'actionIds' },
      }];
    }
    if (method === 'POST' && path === '/v1/act') {
      getRequest(body.requestId);
      if (body.revision !== stub.lastRevision || (body.actionId !== 'a0' && !body.point)) {
        throw httpError(400, 'invalid_options', 'Unknown revision or action; observe again');
      }
      const run = await startRun(body, 'act');
      return [200, await waitRun(run, clampWait(body.waitMs, 40_000))];
    }
    if (method === 'GET' && path === '/v1/runs') {
      const limit = Number(url.searchParams.get('limit') ?? 20);
      const runs = [...stub.runs.values()].reverse().slice(0, limit);
      return [200, { runs: runs.map(run => ({ runId: run.runId, state: run.done ? 'done' : 'running',
        status: run.result?.status ?? null, operation: run.operation })) }];
    }
    const runMatch = path.match(/^\/v1\/runs\/([^/]+)(\/stop|\/evidence)?$/);
    if (runMatch && method === 'GET' && !runMatch[2]) {
      return [200, snapshot(getRun(runMatch[1]))];
    }
    if (runMatch && method === 'POST' && runMatch[2] === '/stop') {
      const run = getRun(runMatch[1]);
      finishRun(run, 'stopped', 'cancelled');
      return [200, snapshot(run)];
    }
    if (runMatch && method === 'GET' && runMatch[2] === '/evidence') {
      const run = getRun(runMatch[1]);
      const kind = url.searchParams.get('kind') ?? 'screenshot';
      if (kind === 'trace') {
        return [200, { path: join(run.dir, 'trace.json'), trace: { result: run.result, filler: 'x'.repeat(
          Number(url.searchParams.get('_filler') ?? stub.behavior.traceFiller ?? 0)) } }];
      }
      const wanted = url.searchParams.get('step');
      const step = wanted ? run.stepRecords.find(record => record.i === Number(wanted))
        : run.stepRecords.filter(record => record.screenshot).at(-1);
      if (!step?.screenshot) {
        throw httpError(404, 'no_evidence', 'That step has no screenshot');
      }
      const data = await readFile(step.screenshot);
      const response = { runId: run.runId, step: step.i, path: step.screenshot, mimeType: 'image/jpeg',
        width: 1, height: 1, bytes: data.length };
      if (url.searchParams.get('inline') === '1' || url.searchParams.get('inline') === 'true') {
        response.data = data.toString('base64');
      }
      return [200, response];
    }
    if (method === 'POST' && path === '/v1/daemon/reload') {
      return [200, { ok: true }];
    }
    if (method === 'POST' && path === '/v1/daemon/shutdown') {
      return [200, { ok: true }];
    }
    throw httpError(404, 'not_found', `No route ${method} ${path}`);
  }

  const server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      raw += chunk;
    });
    req.on('end', async () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      let body = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        body = {};
      }
      const key = `${req.method} ${url.pathname}`;
      stub.calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body,
        client: req.headers['x-fai-client'] ?? null });
      changed();
      if (stub.behavior.hang.has(key)) {
        hung.add(res);
        return;
      }
      let status;
      let payload;
      try {
        [status, payload] = await route(req.method, url, body, req.headers);
      } catch (error) {
        status = error.status ?? 500;
        payload = { error: { code: error.code ?? 'internal', message: error.message, retryable: !!error.retryable } };
      }
      if (res.destroyed) {
        return;
      }
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  stub.port = server.address().port;
  stub.url = `http://127.0.0.1:${stub.port}`;
  await writeFile(join(home, 'client-token'), `${token}\n`, { mode: 0o600 });
  await writeFile(join(home, 'daemon.json'), JSON.stringify({ pid: process.pid, port: stub.port, version: stub.version,
    startedAt: new Date().toISOString(), log: join(home, 'logs', 'daemon.log') }), { mode: 0o600 });
  /** Environment for a child process (CLI or MCP server) that should talk to this stub. */
  stub.env = (extra = {}) => ({
    PATH: process.env.PATH,
    HOME: home,
    FAI_HOME: home,
    FAI_DAEMON_PORT: String(stub.port),
    FAI_CLIENT_TOKEN: token,
    FAI_DAEMON_START_TIMEOUT_MS: '1000',
    // This stub has no agent-session registry (src/mcp-session.js); the real daemon's tests cover it.
    FAI_MCP_REGISTRY: '0',
    // A short call budget keeps its approval wait short too (as before FAI_MCP_APPROVAL_WAIT_MS: the budget less the
    // 2 s daemon margin), unless the test sets the allowance itself.
    ...(extra.FAI_MCP_MAX_CALL_MS && !extra.FAI_MCP_APPROVAL_WAIT_MS
      ? { FAI_MCP_APPROVAL_WAIT_MS: String(Math.max(1, Number(extra.FAI_MCP_MAX_CALL_MS) - 2000)) } : {}),
    ...extra,
  });
  // A daemon outage: down() stops answering (open connections reset), up() listens on the same port again.
  stub.down = async () => {
    server.closeAllConnections();
    await new Promise(resolveClose => server.close(resolveClose));
  };
  stub.up = () => new Promise(resolveListen => server.listen(stub.port, '127.0.0.1', resolveListen));
  stub.close = async () => {
    for (const run of stub.runs.values()) {
      clearTimeout(run.timer);
    }
    for (const res of hung) {
      res.destroy();
    }
    server.closeAllConnections();
    if (server.listening) await new Promise(resolveClose => server.close(resolveClose));
    await rm(home, { recursive: true, force: true });
  };
  return stub;
}
