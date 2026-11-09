// Extension transport hub, and the standalone companion built on it.
//
// Transport (protocol v3, see the Phase 2 design section 3):
// - WebSocket at /ext/ws. The extension offers the subprotocols ['fai-browser.v3', 'fai-auth.<secret>']. Origin and
//   secret are checked before the upgrade, so no unauthenticated socket ever exists. Every message is one JSON text
//   frame with "v":3; every extension message that has a `ref` gets exactly one {type:'reply', ref, ok, data|error}.
// - HTTP long-poll fallback on the same port (v2 paths, v3 payloads): POST /hello, /lease, /deny, /status,
//   /validate, /results, /screenshots, /heartbeat, and POST /commands?wait=25000, which replies
//   {command, requests, messages}. `messages` carries daemon->extension pushes (lease_update, cancel) in long-poll
//   mode. POST because Chrome sends no Origin header on extension GETs.
// Every route requires the exact extension Origin and the pairing secret (bearer header over HTTP, subprotocol
// over WebSocket), compared with timingSafeEqual. The server only listens on 127.0.0.1 and also rejects
// non-loopback peers.
// Command methods: observe {terms?, forbid?, expectText?, level?}, execute {action, expectedRevision, capture, forbid?, level?},
// and capture {action|null, target, fromUrl}. `level` is the run's effective permission level, never above the
// lease's grant; the extension intersects it with the level the user chose and never widens it.
// The `lease` message may carry `level` (the level the user approved in the popup, one of LEVELS). Execute screenshots arrive out of band as `screenshot` messages.
// The `lease_level` message {leaseId, level} (HTTP /lease-level) reports a level the extension lowered on its own (a
// testing environment removed mid-session). It may only lower the lease's grant; raising needs a new approval in the
// popup (a `lease` message from the request card), so a higher level is refused with `level_not_granted`.
// The `settings` message {settings: {budget}} (HTTP /settings), and `hello.settings`, carry the user's popup settings:
// `budget` {maxCalls, maxMs} is the per-request call budget (null when not set). The hub keeps the last reported
// settings (`extension().settings`) and emits a `settings` event; the daemon answers with the budget in effect.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { acceptUpgrade, offeredProtocols, rejectUpgrade } from './ws.js';
import { LEVELS, clampLevel, isLevel, levelRank } from './guardrails.js';

export const PROTOCOL_VERSION = 3;
// Chrome derives this ID from the `key` in extension/manifest.json, so every unpacked install shares it.
export const PINNED_EXTENSION_ID = 'ikkpdnokohfcjhfidepcledkbepmkfcm';
// The manifest's host_permissions grant only this companion origin; another port needs a manifest edit.
export const DEFAULT_PORT = 4318;
export const WS_PATH = '/ext/ws';
// Firefox gives every install of an add-on its own random origin, moz-extension://<UUID> (no pinnable ID as
// Chrome's `key` gives), so the hub accepts any such origin. A web page can never send one; the pairing secret, which
// only the native host (Firefox launches it for the FAI add-on IDs alone) or the user hands out, stays the
// authentication.
export const FIREFOX_EXTENSION_ORIGIN = /^moz-extension:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const WS_PROTOCOL = 'fai-browser.v3';
export const AUTH_PROTOCOL_PREFIX = 'fai-auth.';

export const BRIDGE_ERROR_CODES = Object.freeze([
  'stale', 'target_unavailable', 'blocked_risky', 'cross_origin', 'child_tab', 'tab_changed', 'origin_changed',
  'session_inactive', 'capture_failed', 'timeout', 'unsupported', 'disconnected', 'paused', 'stopped',
  // Point clicks (locate): nothing clickable at the point, a point outside the viewport, a frame page.js cannot read.
  'no_control', 'point_outside', 'point_frame',
  // The page stopped answering while a JavaScript dialog (alert, confirm, prompt) is most likely open.
  'js_dialog',
]);
const KNOWN_CODES = new Set(BRIDGE_ERROR_CODES);
export const LEVEL_RAISE_MESSAGE = 'A lease_level message can only lower the level; raising it needs a new approval '
  + 'in the FAI Browser popup';
const RECOVERABLE = new Set(['stale', 'target_unavailable', 'capture_failed']);
const MAX_BODY_BYTES = 12_000_000;
const MAX_LONG_POLL_MS = 25_000;

// HTTP fallback path -> v3 message type.
const HTTP_ROUTES = {
  '/hello': 'hello',
  '/lease': 'lease',
  '/lease-level': 'lease_level',
  '/settings': 'settings',
  '/driver': 'driver',
  '/update': 'update',
  '/deny': 'deny',
  '/status': 'status',
  '/validate': 'validate',
  '/results': 'result',
  '/screenshots': 'screenshot',
  '/heartbeat': 'heartbeat',
  '/commands': 'commands',
};
const REPLY_HTTP_STATUS = {
  bad_request: 400,
  unsupported_protocol: 400,
  no_request: 404,
  origin_not_requested: 403,
  request_not_pending: 409,
  level_not_granted: 403,
};

/**
 * The level for a command's args: the requested level clamped to the lease's grant (when the lease has one). No
 * level (a direct bridge caller) means the lease's grant; an unknown string means read-only. Null sends none, which
 * the extension treats as read-only; it intersects whatever arrives with the level the user chose.
 */
function commandLevel(requested, lease) {
  if (requested === undefined || requested === null) return lease?.level ?? null;
  if (!isLevel(requested)) return 'read-only';
  return lease?.level ? clampLevel(requested, lease.level) : requested;
}

/** Guardrail phrases for the wire: strings only, at most 40 of at most 60 characters; null when there are none. */
function guardrailPhrases(value) {
  if (!Array.isArray(value)) return null;
  const phrases = value.filter(item => typeof item === 'string' && item && item.length <= 60).slice(0, 40);
  return phrases.length ? phrases : null;
}

// Expectation texts for the page script's document check: lower-cased strings of at most MAX_EXPECT_TEXT characters,
// at most four. null when none.
const MAX_EXPECT_TEXT = 200;
function expectationTexts(value) {
  if (!Array.isArray(value)) return null;
  const texts = value.filter(item => typeof item === 'string' && item.trim() && item.length <= MAX_EXPECT_TEXT)
    .map(item => item.toLowerCase()).slice(0, 4);
  return texts.length ? texts : null;
}

export class BridgeError extends Error {
  constructor(code, message = code, options = {}) {
    const known = KNOWN_CODES.has(code);
    super(known ? message : `${code}: ${message}`, options.cause ? { cause: options.cause } : undefined);
    this.name = 'BridgeError';
    this.code = known ? code : 'unsupported';
    this.recoverable = RECOVERABLE.has(this.code);
  }
}

// Builds the error for requests made while there is no active lease, from the lease's status and reason.
function inactiveError(lease) {
  if (!lease) return new BridgeError('session_inactive', 'Select and start a browser tab in the extension');
  const code = KNOWN_CODES.has(lease.reason) ? lease.reason : lease.status === 'stopped' ? 'stopped' : 'paused';
  const messages = {
    paused: 'Browser paused by the user; select and start the tab again',
    stopped: 'Browser stopped by the user; select and start the tab again',
    disconnected: 'Browser disconnected: extension connection lost; select and start the tab again',
    session_inactive: 'Browser session inactive; select and start a browser tab in the extension',
    tab_changed: 'Selected tab changed; select and start the tab again',
    origin_changed: 'Selected tab left the approved origin; select and start the tab again',
    child_tab: 'A child tab opened from the selected tab; user handoff required',
  };
  return new BridgeError(code, messages[code] ?? `Browser ${lease.status}`);
}

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function validateCredentials(secret, extensionId) {
  if (!secret || secret.length < 24) throw new Error('A pairing secret of at least 24 characters is required');
  if (!/^[a-p]{32}$/.test(extensionId ?? '')) throw new Error('Exact Chrome extension ID required');
}

/**
 * The extension's popup settings as reported: `{budget, openRightAway?}` with `budget` a {maxCalls, maxMs} of
 * integers within the bounds (src/settings.js BUDGET_LIMITS; the daemon validates again) or null when the user set
 * none, and `openRightAway` (whether a request's page opens by itself, the icon click on it approving) only when the
 * extension reports it as a boolean (an older extension does not).
 */
export function sanitizeSettings(settings) {
  if (!settings || typeof settings !== 'object') return null;
  const openRightAway = typeof settings.openRightAway === 'boolean' ? { openRightAway: settings.openRightAway } : {};
  const budget = settings.budget;
  if (!budget || typeof budget !== 'object') return { budget: null, ...openRightAway };
  const { maxCalls, maxMs } = budget;
  const ok = Number.isInteger(maxCalls) && maxCalls >= 1 && maxCalls <= 500
    && Number.isInteger(maxMs) && maxMs >= 1000 && maxMs <= 14_400_000;
  return { budget: ok ? { maxCalls, maxMs } : null, ...openRightAway };
}

function sanitizeSession(session) {
  if (!session || typeof session !== 'object' || typeof session.leaseId !== 'string') return null;
  return {
    requestId: typeof session.requestId === 'string' ? session.requestId : null,
    leaseId: session.leaseId,
    tabId: Number.isInteger(session.tabId) ? session.tabId : null,
    origin: typeof session.origin === 'string' ? session.origin : null,
    status: ['active', 'paused', 'stopped'].includes(session.status) ? session.status : 'paused',
    // The level the worker holds now (it can only have dropped below the grant; the daemon only ever lowers on it).
    ...(isLevel(session.level) ? { level: session.level } : {}),
  };
}

/**
 * The extension transport hub. See the Phase 2 design section 3 for the contract the daemon consumes.
 * `log(event, fields)` receives transport events only; it never sees secrets, page text or message bodies.
 */
export function createHub({
  secret,
  extensionId,
  mode = 'daemon',
  log = null,
  commandTimeoutMs = 30_000,
  screenshotTimeoutMs = 5_000,
  // A lost WebSocket or dropped long-poll without a reconnect within this window counts as disconnected.
  disconnectGraceMs = 3_000,
  // Long-poll liveness: no request and no held poll for this long counts as disconnected.
  leaseTimeoutMs = 35_000,
  pingIntervalMs,
  idleTimeoutMs,
} = {}) {
  validateCredentials(secret, extensionId);
  const extensionOrigin = `chrome-extension://${extensionId}`;
  const originAllowed = origin => origin === extensionOrigin
    || (typeof origin === 'string' && FIREFOX_EXTENSION_ORIGIN.test(origin));
  let secretBuffer;
  let expectedAuth;
  const setCredentials = value => {
    secretBuffer = Buffer.from(value);
    expectedAuth = Buffer.from(`Bearer ${value}`);
  };
  setCredentials(secret);

  let closed = false;
  let socket = null; // the open WebSocketConnection, if any
  let socketReady = false; // hello handled on the current socket
  let connected = false;
  let connectedTransport = 'none';
  let extensionVersion = null;
  let extensionSettings = null; // the popup settings last reported ({budget}), null until an extension reports any
  let lastSeen = 0;
  let graceTimer = null;
  let requests = [];
  let requestsJson = '[]';
  const outbox = []; // daemon->extension messages waiting for the next long-poll response
  const waiters = new Set(); // held long-poll responses
  const leases = new Map(); // leaseId -> {leaseId, requestId, tabId, origin, allowedOrigins, status, reason, state}
  const pending = new Map(); // command id -> {method, leaseId, delivered, resolve, reject}
  const queue = []; // commands not yet delivered to the extension
  const screenshots = new Map(); // execute command id -> {resolve, timer}
  const listeners = new Set();

  const logEvent = (event, fields = {}) => {
    try {
      log?.(event, fields);
    } catch {
      // Logging must never break the transport.
    }
  };

  function emit(event) {
    let delivered = 0;
    for (const listener of [...listeners]) {
      try {
        listener(event);
        delivered++;
      } catch {
        // A listener failure must not break the transport.
      }
    }
    return delivered;
  }

  // --- connection state ----------------------------------------------------------------------------------

  const transport = () => (socket?.open ? 'websocket' : connected ? connectedTransport : 'none');

  function markSeen(kind) {
    lastSeen = Date.now();
    clearTimeout(graceTimer);
    graceTimer = null;
    const effective = socket?.open ? 'websocket' : kind;
    if (connected && connectedTransport === effective) return;
    connected = true;
    connectedTransport = effective;
    logEvent('extension_connected', { transport: effective });
    emit({ type: 'connected', transport: effective });
  }

  function connectionLost() {
    clearTimeout(graceTimer);
    graceTimer = null;
    const previous = connectedTransport;
    for (const lease of leases.values()) {
      if (lease.status === 'active') deactivate(lease, 'paused', 'disconnected');
    }
    if (!connected) return;
    connected = false;
    connectedTransport = 'none';
    logEvent('extension_disconnected', { transport: previous });
    emit({ type: 'disconnected', transport: previous });
  }

  // The extension went away (socket closed or held long-poll dropped). A live worker reconnects or re-polls
  // well within the grace period.
  function scheduleGrace() {
    clearTimeout(graceTimer);
    graceTimer = setTimeout(() => {
      graceTimer = null;
      if (!socket?.open && !waiters.size) connectionLost();
    }, disconnectGraceMs);
    graceTimer.unref?.();
  }

  // An open socket or a held long-poll counts as liveness.
  const expiry = setInterval(() => {
    if (socket?.open || waiters.size) lastSeen = Date.now();
    if (connected && Date.now() - lastSeen > leaseTimeoutMs) connectionLost();
  }, 250);
  expiry.unref();

  // --- outbound --------------------------------------------------------------------------------------------

  // Sends a daemon->extension push: over the socket when open, else queued for the next long-poll response.
  function push(message) {
    const framed = { v: 3, ...message };
    if (socket?.open) {
      socket.send(framed);
      return;
    }
    outbox.push(framed);
    if (outbox.length > 100) outbox.shift();
    wakeWaiters();
  }

  function takeCommand() {
    for (let command = queue.shift(); command; command = queue.shift()) {
      const lease = leases.get(command.lease.id);
      if (['open_tab', 'switch_tab'].includes(command.args?.action?.type) && lease?.tabMode !== 'multiple') {
        pending.get(command.id)?.reject(new BridgeError('blocked_risky', 'This request allows one task tab'));
        continue;
      }
      command.lease.tabMode = lease?.tabMode ?? 'single';
      return command;
    }
    return null;
  }

  function wakeWaiters({ requestsChanged = false } = {}) {
    for (const waiter of [...waiters]) {
      const command = takeCommand();
      if (command) {
        waiter.finish(command);
      } else if (outbox.length || requestsChanged) {
        waiter.finish(null);
      } else {
        return;
      }
    }
  }

  // Delivers queued commands: over the socket once its hello is handled, else to held long-polls.
  function dispatch() {
    if (socket?.open) {
      if (!socketReady) return;
      for (let command = takeCommand(); command; command = takeCommand()) {
        socket.send({ v: 3, type: 'command', command });
        const entry = pending.get(command.id);
        if (entry) entry.delivered = true;
      }
      return;
    }
    wakeWaiters();
  }

  function longPollBody(command) {
    if (command) {
      const entry = pending.get(command.id);
      if (entry) entry.delivered = true;
    }
    return { command, requests, messages: outbox.splice(0) };
  }

  function holdLongPoll(res, waitMs, reply) {
    const waiter = {
      finish(command) {
        if (!waiters.delete(waiter)) return;
        clearTimeout(waiter.timer);
        reply(200, longPollBody(command));
      },
    };
    waiter.timer = setTimeout(() => waiter.finish(null), waitMs);
    // Per-connection cleanup: a dropped connection must neither keep a timer nor swallow a command.
    res.on('close', () => {
      clearTimeout(waiter.timer);
      if (waiters.delete(waiter) && !socket?.open) scheduleGrace();
    });
    waiters.add(waiter);
  }

  function releaseWaiters() {
    for (const waiter of [...waiters]) waiter.finish(null);
  }

  // --- leases and commands ---------------------------------------------------------------------------------

  function failPendingFor(leaseId, error) {
    for (const entry of [...pending.values()]) {
      if (leaseId === null || entry.leaseId === leaseId) entry.reject(error);
    }
  }

  function deactivate(lease, status, reason) {
    lease.status = status;
    lease.reason = reason;
    failPendingFor(lease.leaseId, inactiveError(lease));
  }

  function leaseSnapshot(lease) {
    return lease && {
      leaseId: lease.leaseId,
      requestId: lease.requestId,
      tabId: lease.tabId,
      origin: lease.origin,
      allowedOrigins: [...lease.allowedOrigins],
      status: lease.status,
      state: lease.state,
      reason: lease.reason,
      ...(lease.level ? { level: lease.level } : {}),
    };
  }

  function request(leaseId, method, args, signal, onQueued, timeoutMs = commandTimeoutMs) {
    if (closed) return Promise.reject(new BridgeError('disconnected', 'Companion closed'));
    const lease = leaseId ? leases.get(leaseId) : null;
    if (!lease || lease.status !== 'active') return Promise.reject(inactiveError(lease));
    return new Promise((resolve, reject) => {
      const id = randomBytes(16).toString('hex');
      const timer = setTimeout(() => finish(new BridgeError('timeout', 'Browser command timed out')), timeoutMs);
      const abort = () => finish(signal.reason ?? new Error('Aborted'));
      function finish(error, result) {
        const entry = pending.get(id);
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        pending.delete(id);
        const index = queue.findIndex(command => command.id === id);
        if (index >= 0) queue.splice(index, 1);
        if (error) {
          settleScreenshot(id, null);
          // Tell the extension to drop a delivered command the host gave up on (abort or timeout). Lease ends and
          // extension-reported errors need no cancel.
          const gaveUp = !(error instanceof BridgeError) || error.code === 'timeout';
          if (entry?.delivered && gaveUp && !closed) push({ type: 'cancel', id });
          reject(error);
        } else {
          resolve(result);
        }
      }
      pending.set(id, { method, leaseId, delivered: false, resolve: result => finish(null, result), reject: finish });
      onQueued?.(id);
      queue.push({
        version: PROTOCOL_VERSION,
        id,
        deadline: Date.now() + timeoutMs,
        method,
        args,
        lease: { id: lease.leaseId, tabId: lease.tabId, requestId: lease.requestId, tabMode: lease.tabMode ?? 'single' },
        allowedOrigins: [...lease.allowedOrigins],
      });
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
      dispatch();
    });
  }

  async function execute(leaseId, action, expectedRevision, options = {}, signal) {
    if (['open_tab', 'switch_tab'].includes(action?.type) && leases.get(leaseId)?.tabMode !== 'multiple') {
      throw new BridgeError('blocked_risky', 'This request allows one task tab; approve Multiple task tabs first');
    }
    const capture = options?.capture !== false;
    let screenshot = Promise.resolve(null);
    const args = { action, expectedRevision, capture };
    // Guardrail additions (plain phrases, src/guardrails.js): the page script compiles and refuses them itself.
    const forbid = guardrailPhrases(options?.forbid);
    if (forbid) args.forbid = forbid;
    const level = commandLevel(options?.level, leases.get(leaseId));
    if (level) args.level = level;
    const result = await request(leaseId, 'execute', args, signal, id => {
      if (!capture) return;
      // Reserved before the command is sent, so a screenshot that beats the result is not lost.
      screenshot = new Promise(resolve => screenshots.set(id, { resolve, timer: null }));
    });
    return { ...result, screenshot };
  }

  // The control under a viewport point of the leased tab on `expectedRevision` (a point click's first half): the page
  // script's { id, control } (id null for a control the observation left out). Nothing runs.
  async function locate(leaseId, point, expectedRevision, options = {}, signal) {
    const args = { point: { x: point.x, y: point.y }, expectedRevision };
    const forbid = guardrailPhrases(options?.forbid);
    if (forbid) args.forbid = forbid;
    const level = commandLevel(options?.level, leases.get(leaseId));
    if (level) args.level = level;
    return request(leaseId, 'locate', args, signal);
  }

  // The Approve gate: asks the user, in the extension, to approve one click on `target` (a control of `revision`) of
  // gate class `cls` (purchase, secret, delete, submit). The extension shows the label it reads itself, waits up to
  // `waitMs` for the click and answers { decision: approved (with the approvalId it minted) | denied | pending | off |
  // refused }. Only the extension can mint an approvalId; an execute that carries one it did not mint is refused.
  // `kind` fill_secret or copy_secret with `handle` ('3'): the use of a secret handle the extension vaulted (it shows
  // the handle, its placeholder and both origins; the value never passes through here). A copy has no target.
  async function approve(leaseId, { target, revision, cls, note, waitMs, kind, handle, file }, options = {}, signal) {
    const wait = Math.max(0, Math.min(Number.isFinite(waitMs) ? waitMs : 0, 120_000));
    const args = { target, expectedRevision: revision, cls, waitMs: wait };
    if (kind === 'fill_secret' || kind === 'copy_secret') {
      args.kind = kind;
      args.handle = String(handle ?? '');
      if (kind === 'copy_secret') delete args.target;
    }
    // An upload: the file input, and the file's name and size the card shows (never its bytes).
    if (kind === 'upload') {
      args.kind = 'upload';
      args.file = { name: String(file?.name ?? ''), size: Number(file?.size) };
    }
    // Accepting a JavaScript dialog (Test site): no control, the extension shows the dialog's own text.
    if (kind === 'dialog') {
      args.kind = 'dialog';
      delete args.target;
    }
    if (typeof note === 'string' && note.trim()) args.note = note.slice(0, 200);
    const level = commandLevel(options?.level, leases.get(leaseId));
    if (level) args.level = level;
    return request(leaseId, 'approve', args, signal, undefined, wait + commandTimeoutMs);
  }

  // On-demand capture of the leased tab. Resolves a screenshot or {error}; rejects only on bridge errors.
  async function capture(leaseId, details = {}, signal) {
    const result = await request(leaseId, 'capture', details, signal);
    return normalizeScreenshot(result ?? {});
  }

  // --- screenshots -----------------------------------------------------------------------------------------

  function settleScreenshot(id, value) {
    const entry = screenshots.get(id);
    if (!entry) return false;
    screenshots.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(value);
    return true;
  }

  function normalizeScreenshot(body) {
    if (body.error) {
      const message = String(body.error.message ?? body.error.code ?? 'capture failed');
      return { error: { code: 'capture_failed', message } };
    }
    const shot = body.screenshot;
    if (typeof shot?.dataUrl !== 'string' || !/^data:image\/(jpeg|png);base64,/.test(shot.dataUrl)
      || typeof shot.revision !== 'string') {
      return { error: { code: 'capture_failed', message: 'Malformed screenshot from extension' } };
    }
    return { ...shot, format: shot.dataUrl.startsWith('data:image/png') ? 'png' : 'jpeg' };
  }

  // Starts the 5 s arrival timeout once the execute result is in.
  function armScreenshotTimeout(id) {
    const entry = screenshots.get(id);
    if (!entry || entry.timer) return;
    entry.timer = setTimeout(() => {
      settleScreenshot(id, { error: { code: 'capture_failed', message: 'timeout' } });
    }, screenshotTimeoutMs);
    entry.timer.unref?.();
  }

  function handleResult(body) {
    const entry = pending.get(body.id);
    if (!entry) {
      // Late result for a cancelled or timed-out command; drop any screenshot slot it reserved.
      settleScreenshot(body.id, null);
      return;
    }
    pending.delete(body.id);
    if (body.error) {
      const code = typeof body.error === 'string' ? 'unsupported' : body.error.code;
      const message = typeof body.error === 'string' ? body.error : String(body.error.message ?? code);
      settleScreenshot(body.id, null);
      entry.reject(new BridgeError(code, message));
      return;
    }
    if (entry.method === 'execute') {
      const result = body.result ?? {};
      // The screenshot arrives separately (possibly before this result).
      armScreenshotTimeout(body.id);
      const forwarded = { observation: result.observation, settle: result.settle ?? { reason: 'none', ms: 0 } };
      if (result.navigated === true) {
        forwarded.navigated = true;
        if (typeof result.url === 'string') forwarded.url = result.url;
      }
      entry.resolve(forwarded);
      return;
    }
    entry.resolve(body.result);
  }

  // --- inbound messages ------------------------------------------------------------------------------------

  // The most recently bound active lease; used for v2-style /status reports that carry no leaseId.
  function currentActiveLease() {
    let found = null;
    for (const lease of leases.values()) if (lease.status === 'active') found = lease;
    return found;
  }

  function handleStatus(message) {
    const status = ['active', 'paused', 'stopped'].includes(message.status) ? message.status : 'paused';
    const reason = typeof message.reason === 'string' ? message.reason : status;
    const lease = typeof message.leaseId === 'string' ? leases.get(message.leaseId) : currentActiveLease();
    if (!lease || status === 'active') return;
    if (lease.status === 'active') deactivate(lease, status, reason);
    else if (status === 'stopped' && lease.status !== 'stopped') lease.status = 'stopped';
    lease.state = status;
    emit({ type: 'status', leaseId: lease.leaseId, requestId: lease.requestId, status, reason });
  }

  // Routes one extension message. `answer(ok, payload)` replies to ref'd types exactly once.
  function handleMessage(message, answer, via) {
    let answered = false;
    const reply = value => {
      if (answered) return;
      answered = true;
      if (value && typeof value === 'object' && value.error) {
        const error = {
          code: String(value.error.code ?? 'bad_request'),
          message: String(value.error.message ?? value.error.code ?? 'Rejected'),
          ...(Array.isArray(value.error.origins) ? { origins: value.error.origins.map(String) } : {}),
        };
        answer(false, error);
      } else {
        answer(true, value ?? {});
      }
    };
    switch (message?.type) {
      case 'hello': {
        extensionVersion = typeof message.ext?.version === 'string' ? message.ext.version.slice(0, 40) : null;
        const session = sanitizeSession(message.session);
        // An older extension sends no settings: the ones last reported (if any) stand.
        if (message.settings !== undefined) extensionSettings = sanitizeSettings(message.settings);
        const finish = value => {
          const wasAnswered = answered;
          reply(via === 'http' && !value?.error ? { ...value, requests } : value);
          if (wasAnswered || via !== 'ws') return;
          socketReady = true;
          socket?.send({ v: 3, type: 'requests', requests });
          dispatch();
        };
        const event = { type: 'hello', session, settings: extensionSettings, reply: finish };
        if (!emit(event)) finish({ mode, endSession: Boolean(session) });
        return;
      }
      case 'settings': {
        // The user changed a popup setting (the per-request budget). Kept here for extension(); the daemon replies
        // with what is in effect.
        extensionSettings = sanitizeSettings(message.settings) ?? { budget: null };
        const event = { type: 'settings', settings: extensionSettings, reply };
        if (!emit(event)) reply({ settings: extensionSettings });
        return;
      }
      case 'driver': {
        // Explicit popup command only. Never replay a saved driver through hello/settings.
        if (message.driver !== undefined && !['agent', 'jev'].includes(message.driver)) {
          reply({ error: { code: 'invalid_driver', message: 'Choose your agent or Jev autopilot.' } });
          return;
        }
        if (!emit({ type: 'driver', driver: message.driver, reply })) {
          reply({ error: { code: 'unsupported', message: 'Update the local service to switch browser control.' } });
        }
        return;
      }
      case 'update': {
        // The popup's update card: status, check, or install (the user's Update click). The daemon decides.
        const action = message.action ?? 'status';
        if (!['status', 'check', 'install'].includes(action)) {
          reply({ error: { code: 'invalid_action', message: 'Unknown update action.' } });
          return;
        }
        if (!emit({ type: 'update', action, reply })) {
          reply({ error: { code: 'unsupported', message: 'This FAI service cannot update itself.' } });
        }
        return;
      }
      case 'ping':
        if (via === 'ws') socket?.send({ v: 3, type: 'pong' });
        return;
      case 'heartbeat':
        answer(true, { ok: true });
        return;
      case 'lease': {
        if (!Number.isInteger(message.tabId) || typeof message.origin !== 'string') {
          reply({ error: { code: 'bad_request', message: 'tabId and origin are required' } });
          return;
        }
        // The level the user approved in the popup. Missing (an older extension): the daemon picks the old default.
        if (message.level !== undefined && !isLevel(message.level)) {
          reply({ error: { code: 'bad_request', message: `level must be one of ${LEVELS.join(', ')}` } });
          return;
        }
        if (message.tabMode !== undefined && !['single', 'multiple'].includes(message.tabMode)) {
          reply({ error: { code: 'bad_request', message: 'tabMode must be single or multiple' } });
          return;
        }
        const event = {
          type: 'lease',
          requestId: typeof message.requestId === 'string' ? message.requestId : null,
          tabId: message.tabId,
          origin: message.origin,
          title: typeof message.title === 'string' ? message.title.slice(0, 300) : '',
          level: message.level ?? null,
          // `domain` when the user approved the request's domain roots and Chrome granted the host permission;
          // anything else is the exact-origin scope.
          scope: message.scope === 'domain' ? 'domain' : 'origin',
          tabMode: message.tabMode ?? 'single',
          reply,
        };
        if (!emit(event)) reply({ error: { code: 'no_request', message: 'No tab request is pending' } });
        return;
      }
      case 'lease_level': {
        // The extension lowered the user's grant on its own (a testing environment removed mid-session). Validated
        // like `lease.level`; it may only lower the lease's level, never raise it.
        if (!isLevel(message.level)) {
          reply({ error: { code: 'bad_request', message: `level must be one of ${LEVELS.join(', ')}` } });
          return;
        }
        const lease = typeof message.leaseId === 'string' ? leases.get(message.leaseId) : null;
        if (!lease) {
          reply({ error: { code: 'no_request', message: 'No such tab lease' } });
          return;
        }
        if (lease.level && levelRank(message.level) > levelRank(lease.level)) {
          reply({ error: { code: 'level_not_granted', message: LEVEL_RAISE_MESSAGE } });
          return;
        }
        // The hub's own ceiling drops at once: every later command of this lease is clamped to it.
        lease.level = message.level;
        const event = { type: 'lease_level', leaseId: lease.leaseId, requestId: lease.requestId, level: message.level, reply };
        if (!emit(event)) reply({ leaseId: lease.leaseId, level: lease.level });
        return;
      }
      case 'deny': {
        const requestId = typeof message.requestId === 'string' ? message.requestId : null;
        const event = { type: 'deny', requestId, reply };
        if (!emit(event)) reply({ error: { code: 'no_request', message: 'No tab request is pending' } });
        return;
      }
      case 'status':
        handleStatus(message);
        if (via === 'http') answer(true, { ok: true });
        return;
      case 'validate': {
        const lease = leases.get(message.leaseId);
        answer(true, { valid: pending.has(message.id) && lease?.status === 'active' });
        return;
      }
      case 'result':
        handleResult(message);
        if (via === 'http') answer(true, { ok: true });
        return;
      case 'screenshot':
        settleScreenshot(message.id, normalizeScreenshot(message));
        if (via === 'http') answer(true, { ok: true });
        return;
      default:
        if (message?.ref !== undefined || via === 'http') {
          reply({ error: { code: 'bad_request', message: 'Unknown message type' } });
        }
    }
  }

  // --- WebSocket -------------------------------------------------------------------------------------------

  function secretMatches(candidate) {
    const actual = Buffer.from(candidate);
    return actual.length === secretBuffer.length && timingSafeEqual(actual, secretBuffer);
  }

  function handleUpgrade(req, rawSocket, head) {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname !== WS_PATH) return false;
    const reject = (status, message) => {
      logEvent('extension_ws_rejected', { status });
      rejectUpgrade(rawSocket, status, message);
      return true;
    };
    if (closed) return reject(503, 'Shutting down');
    if (!isLoopback(req.socket?.remoteAddress)) return reject(403, 'Loopback only');
    if (!originAllowed(req.headers.origin)) return reject(403, 'Unauthorized extension origin');
    const protocols = offeredProtocols(req);
    const auth = protocols.find(value => value.startsWith(AUTH_PROTOCOL_PREFIX));
    if (!auth || !secretMatches(auth.slice(AUTH_PROTOCOL_PREFIX.length))) return reject(403, 'Unauthorized extension');
    if (!protocols.includes(WS_PROTOCOL)) return reject(400, 'unsupported_protocol');
    const connection = acceptUpgrade(req, rawSocket, head, { protocol: WS_PROTOCOL, pingIntervalMs, idleTimeoutMs });
    if (!connection) return true;
    const previous = socket;
    socket = connection;
    socketReady = false;
    if (previous?.open) previous.close(4000, 'Replaced by a newer connection');
    logEvent('extension_ws_open', {});
    markSeen('websocket');
    connection.on('message', text => {
      if (socket !== connection) return;
      lastSeen = Date.now();
      let message;
      try {
        message = JSON.parse(text);
      } catch {
        connection.close(1007, 'Invalid JSON');
        return;
      }
      if (message?.v !== 3) {
        if (message?.ref !== undefined) {
          const error = { code: 'unsupported_protocol', message: 'Protocol version 3 required' };
          connection.send({ v: 3, type: 'reply', ref: message.ref, ok: false, error });
        }
        return;
      }
      const answer = (ok, payload) => {
        if (message.ref === undefined) return;
        const body = ok ? { data: payload } : { error: payload };
        connection.send({ v: 3, type: 'reply', ref: message.ref, ok, ...body });
      };
      handleMessage(message, answer, 'ws');
    });
    connection.on('close', ({ code }) => {
      logEvent('extension_ws_close', { code });
      if (socket !== connection) return;
      socket = null;
      socketReady = false;
      scheduleGrace();
    });
    return true;
  }

  // --- HTTP fallback ---------------------------------------------------------------------------------------

  async function readBody(req) {
    const chunks = [];
    let length = 0;
    for await (const chunk of req) {
      length += chunk.length;
      if (length > MAX_BODY_BYTES) throw new Error('Request too large');
      chunks.push(chunk);
    }
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
  }

  function authenticate(req) {
    const actual = Buffer.from(req.headers.authorization ?? '');
    return originAllowed(req.headers.origin) && actual.length === expectedAuth.length
      && timingSafeEqual(actual, expectedAuth);
  }

  function handleHttp(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const type = HTTP_ROUTES[url.pathname];
    if (!type) return false;
    const reply = (status, value) => {
      if (res.writableEnded || res.destroyed) return;
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    if (!isLoopback(req.socket?.remoteAddress)) {
      reply(403, { error: 'Loopback only' });
      return true;
    }
    if (!originAllowed(req.headers.origin)) {
      reply(403, { error: 'Unauthorized extension origin' });
      return true;
    }
    if (req.method !== 'OPTIONS' && !authenticate(req)) {
      reply(403, { error: 'Unauthorized extension' });
      return true;
    }
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
      reply(200, {});
      return true;
    }
    if (req.method !== 'POST' && !(req.method === 'GET' && type === 'commands')) {
      reply(404, { error: 'Unknown route' });
      return true;
    }
    // Any authenticated request proves the extension is alive.
    markSeen('longpoll');
    (async () => {
      try {
        const body = req.method === 'POST' ? await readBody(req) : {};
        if (type === 'commands') {
          const command = takeCommand();
          const requested = Number(url.searchParams.get('wait') ?? 0);
          const waitMs = Number.isFinite(requested) ? Math.min(Math.max(requested, 0), MAX_LONG_POLL_MS) : 0;
          if (command || outbox.length || !waitMs || closed) return reply(200, longPollBody(command));
          return holdLongPoll(res, waitMs, reply);
        }
        const answer = (ok, payload) => {
          if (ok) return reply(200, payload);
          const status = REPLY_HTTP_STATUS[payload.code] ?? 409;
          const origins = payload.origins ? { origins: payload.origins } : {};
          return reply(status, { error: payload.message, code: payload.code, ...origins });
        };
        handleMessage({ ...body, type }, answer, 'http');
      } catch (error) {
        reply(400, { error: error.message });
      }
    })();
    return true;
  }

  // --- public API ------------------------------------------------------------------------------------------

  function updateLease(leaseId, state, reason = state) {
    const lease = leases.get(leaseId);
    if (!lease) return false;
    lease.state = state;
    if (state === 'active') {
      lease.status = 'active';
      lease.reason = null;
      dispatch();
    } else if (lease.status === 'active') {
      deactivate(lease, state === 'paused' ? 'paused' : 'stopped', reason);
    } else {
      if (state !== 'paused') lease.status = 'stopped';
      lease.reason = reason;
    }
    push({ type: 'lease_update', requestId: lease.requestId, leaseId, state, reason });
    return true;
  }

  return {
    mode,
    handleHttp,
    handleUpgrade,
    extension: () => ({
      connected: connected || Boolean(socket?.open),
      transport: transport(),
      version: extensionVersion,
      lastSeenMs: lastSeen ? Date.now() - lastSeen : null,
      settings: extensionSettings,
    }),
    publishRequests(views = []) {
      const next = JSON.parse(JSON.stringify(Array.isArray(views) ? views : []));
      const json = JSON.stringify(next);
      if (json === requestsJson) return;
      requests = next;
      requestsJson = json;
      if (socket?.open && socketReady) socket.send({ v: 3, type: 'requests', requests });
      wakeWaiters({ requestsChanged: true });
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    bindLease({ leaseId, requestId = null, tabId, origin, allowedOrigins = [], level, tabMode = 'single' }) {
      if (typeof leaseId !== 'string' || !leaseId) throw new TypeError('leaseId is required');
      if (level !== undefined && level !== null && !isLevel(level)) throw new TypeError('level must be a level');
      const lease = {
        leaseId,
        requestId,
        tabId,
        origin,
        allowedOrigins: [...allowedOrigins],
        status: 'active',
        state: 'active',
        reason: null,
      };
      // The user's grant: a ceiling for the level every command of this lease carries.
      if (level) lease.level = level;
      lease.tabMode = tabMode === 'multiple' ? 'multiple' : 'single';
      leases.set(leaseId, lease);
      dispatch();
      return leaseSnapshot(lease);
    },
    updateLease,
    // Changes the grant of an active lease (the user re-approved the tab at another level).
    setLeaseLevel(leaseId, level) {
      const lease = leases.get(leaseId);
      if (!lease || !isLevel(level)) return false;
      lease.level = level;
      return true;
    },
    setLeaseTabMode(leaseId, tabMode) {
      const lease = leases.get(leaseId);
      if (!lease || !['single', 'multiple'].includes(tabMode)) return false;
      lease.tabMode = tabMode;
      return true;
    },
    // Changes what an active lease covers (the user re-approved the tab with another scope).
    setLeaseOrigins(leaseId, origin, allowedOrigins) {
      const lease = leases.get(leaseId);
      if (!lease || !Array.isArray(allowedOrigins)) return false;
      lease.origin = origin;
      lease.allowedOrigins = [...allowedOrigins];
      return true;
    },
    // Forgets a terminal lease record (the daemon calls this when it drops the request).
    forgetLease(leaseId) {
      const lease = leases.get(leaseId);
      if (lease?.status === 'active') deactivate(lease, 'stopped', 'stopped');
      return leases.delete(leaseId);
    },
    lease: leaseId => leaseSnapshot(leases.get(leaseId)),
    bridgeFor(leaseId) {
      return {
        // `terms` (instruction words) let the page script keep matching controls under its 100-control cap;
        // `forbid` (guardrail additions) are refused by the page script on top of its own core block.
        // `expectText` (the expectation's textIncludes) is looked for in the rendered page text past the viewport.
        observe: (signal, options = {}) => {
          const args = Array.isArray(options?.terms) ? { terms: options.terms.slice(0, 24) } : {};
          const forbid = guardrailPhrases(options?.forbid);
          if (forbid) args.forbid = forbid;
          const expectText = expectationTexts(options?.expectText);
          if (expectText) args.expectText = expectText;
          const level = commandLevel(options?.level, leases.get(leaseId));
          if (level) args.level = level;
          // Test site: the page's console errors and failed requests since the last read (the extension refuses
          // nothing here; it only reads them on a testing session).
          if (options?.logs === true) args.logs = true;
          return request(leaseId, 'observe', args, signal);
        },
        execute: (action, expectedRevision, options, signal) => {
          return execute(leaseId, action, expectedRevision, options, signal);
        },
        capture: (details, signal) => capture(leaseId, details, signal),
        locate: (point, expectedRevision, options, signal) => locate(leaseId, point, expectedRevision, options, signal),
        approve: (details, options, signal) => approve(leaseId, details, options, signal),
      };
    },
    // Replaces the pairing secret; an open socket authenticated with the old one is closed with 4001.
    setSecret(value) {
      validateCredentials(value, extensionId);
      setCredentials(value);
      if (socket?.open) socket.close(4001, 'Pairing changed');
    },
    stats: () => ({
      polling: waiters.size > 0 || Boolean(socket?.open),
      heldPolls: waiters.size,
      pendingCommands: pending.size,
      pendingScreenshots: screenshots.size,
      queuedCommands: queue.length,
    }),
    close() {
      if (closed) return;
      closed = true;
      clearInterval(expiry);
      clearTimeout(graceTimer);
      for (const lease of leases.values()) {
        if (lease.status === 'active') {
          lease.status = 'stopped';
          lease.reason = 'disconnected';
        }
      }
      failPendingFor(null, new BridgeError('disconnected', 'Companion closed'));
      for (const id of [...screenshots.keys()]) {
        settleScreenshot(id, { error: { code: 'capture_failed', message: 'Companion closed' } });
      }
      releaseWaiters();
      if (socket) {
        const current = socket;
        socket = null;
        current.close(1001, 'Shutting down');
        current.socket.end();
      }
      listeners.clear();
    },
  };
}
