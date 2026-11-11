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
//
// Several browsers (issue #9): every extension install reports a stable browser identity, the `browser` query
// parameter of the WebSocket URL and the X-Fai-Browser header of every HTTP call (a per-install random id from
// extension storage), plus `hello.browser` {product, name, version}. The hub keeps one connection per identity, with
// its own socket, held long-polls, outbox and liveness; a lease belongs to the browser that approved it, and its
// commands and pushes go to that connection only. A newer connection of the SAME identity (a restarted service
// worker) closes the older socket with CLOSE_SUPERSEDED, which the extension never answers with a reconnect; a
// connection of another identity never closes anyone. An older extension that reports no identity is known by its
// extension Origin (unique per Firefox install; one per Chromium-family browser). Each connection gets the request
// views the daemon publishes plus the list of connected browsers (`browsers`) for its popup; an older extension
// gets only the requests meant for it. `used {}` (the user opened the popup or clicked the toolbar icon) and `move
// {requestId}` (the popup's "Open here") are forwarded to the daemon as events with the sender's browserId.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
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
// WebSocket close codes the hub sends. 4000 was "replaced by a newer connection" from ANY browser before 0.6 (the
// cause of issue #9); the hub no longer sends it, and the extension backs off on it when an older service does.
export const CLOSE_REPLACED_LEGACY = 4000;
export const CLOSE_PAIRING_CHANGED = 4001;
// A newer connection of the same browser identity took over: the extension must not reconnect on it.
export const CLOSE_SUPERSEDED = 4003;
// The connection claimed a browser id that belongs to another extension Origin.
export const CLOSE_IDENTITY_REFUSED = 4004;
// The header (HTTP fallback) and query parameter (WebSocket) that carry the extension's browser identity.
export const BROWSER_HEADER = 'x-fai-browser';
// The ids the extension creates (b- and 8-40 letters or digits). Anything else is treated as no id at all.
export const BROWSER_ID = /^b-[A-Za-z0-9]{8,40}$/;
// A superseded socket that completed its hello and lived this long was not a restarted worker: another install (a
// copied browser profile) shares the identity. Reported as extension_duplicate_identity.
export const DUPLICATE_AFTER_MS = 10_000;
const DUPLICATE_WARN_MS = 10 * 60_000;
// How many browser ids (with their Origin and last use) the hub remembers.
const KNOWN_MAX = 64;
const BROWSER_PRODUCT = /^[a-z0-9-]{1,24}$/;
// A connection that closes more than this many times within FLAP_WINDOW_MS is reported as flapping.
export const FLAP_LIMIT = 8;
export const FLAP_WINDOW_MS = 60_000;
// Disconnected browsers with no lease are forgotten after this long.
const FORGET_BROWSER_MS = 10 * 60_000;
const MAX_BROWSERS = 16;

export const BRIDGE_ERROR_CODES = Object.freeze([
  'stale', 'target_unavailable', 'blocked_risky', 'cross_origin', 'child_tab', 'tab_changed', 'origin_changed',
  'session_inactive', 'capture_failed', 'timeout', 'unsupported', 'disconnected', 'paused', 'stopped',
  // Point clicks (locate): nothing clickable at the point, a point outside the viewport, a frame page.js cannot read.
  'no_control', 'point_outside', 'point_frame',
  // The page stopped answering while a JavaScript dialog (alert, confirm, prompt) is most likely open.
  'js_dialog',
  // A fill with a line break aimed at a single-line input: refused before anything was typed.
  'line_break_input',
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
  '/update': 'update',
  '/deny': 'deny',
  '/status': 'status',
  '/validate': 'validate',
  '/results': 'result',
  '/screenshots': 'screenshot',
  '/heartbeat': 'heartbeat',
  '/used': 'used',
  '/approval': 'approval',
  '/move': 'move',
  '/invite': 'invite',
  '/invite-cancel': 'invite_cancel',
  '/agents': 'agents',
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

// An approval event as the extension reports it, reduced to codes: the request id, which surface (the page request
// modal, the toolbar icon, the toolbar popup, the approval window), which step, a reason code and an origin (never a
// URL or page text). Null when it is not one.
export const APPROVAL_SURFACES = Object.freeze(['page_modal', 'toolbar', 'popup', 'window']);
export const APPROVAL_STEPS = Object.freeze(['shown', 'attempt', 'waiting', 'failed', 'approved', 'denied']);
export function approvalEvent(message) {
  if (!APPROVAL_SURFACES.includes(message?.surface) || !APPROVAL_STEPS.includes(message?.step)) return null;
  const requestId = typeof message.requestId === 'string' && /^[\w-]{1,64}$/.test(message.requestId) ? message.requestId : null;
  const reason = typeof message.reason === 'string' && /^[a-z][a-z0-9_]{0,39}$/.test(message.reason) ? message.reason : null;
  let origin = null;
  try {
    const url = typeof message.origin === 'string' && message.origin.length <= 300 ? new URL(message.origin) : null;
    if (url && /^https?:$/.test(url.protocol) && url.origin === message.origin) origin = url.origin;
  } catch {
    origin = null;
  }
  return { requestId, surface: message.surface, step: message.step, reason, origin };
}

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
 * integers within the bounds (maxCalls 1-10000, maxMs 1000-14400000: src/settings.js BUDGET_LIMITS, which imports
 * this module, so the bounds are repeated here and test/bridge-hub.test.js checks they agree; the daemon validates
 * again) or null when the user set none or it is out of bounds, and `openRightAway` (whether a request's page opens by
 * itself, the icon click on it approving) only when the extension reports it as a boolean (an older extension does
 * not).
 */
export function sanitizeSettings(settings) {
  if (!settings || typeof settings !== 'object') return null;
  const openRightAway = typeof settings.openRightAway === 'boolean' ? { openRightAway: settings.openRightAway } : {};
  const budget = settings.budget;
  if (!budget || typeof budget !== 'object') return { budget: null, ...openRightAway };
  const { maxCalls, maxMs } = budget;
  const ok = Number.isInteger(maxCalls) && maxCalls >= 1 && maxCalls <= 10_000
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
 * The browser identity of an extension connection: the id it reports (`reported`, the WebSocket URL's `browser`
 * parameter or the X-Fai-Browser header) when well formed, else one derived from its extension Origin (an extension
 * older than multi-browser support): `{id, legacy}`.
 */
export function connectionIdentity(reported, origin) {
  if (typeof reported === 'string' && BROWSER_ID.test(reported)) return { id: reported, legacy: false };
  const digest = createHash('sha256').update(String(origin ?? '')).digest('hex').slice(0, 16);
  return { id: `origin-${digest}`, legacy: true };
}

/** What a hello says about the browser: {product, name, version}, each cleaned, or nulls. */
export function sanitizeBrowserInfo(value) {
  const info = value && typeof value === 'object' ? value : {};
  const product = typeof info.product === 'string' && BROWSER_PRODUCT.test(info.product.toLowerCase())
    ? info.product.toLowerCase() : null;
  const printable = text => (typeof text === 'string' ? text.replace(/[^\x20-\x7e]/g, '').trim().slice(0, 40) : '');
  return { product, name: printable(info.name) || null, version: printable(info.version).slice(0, 20) || null };
}

// The product an older extension stands for, from its Origin.
function originProduct(origin) {
  return typeof origin === 'string' && origin.startsWith('moz-extension://') ? 'firefox' : 'chromium';
}

const PRODUCT_NAMES = { firefox: 'Firefox', chrome: 'Chrome', chromium: 'Chromium', edge: 'Edge', brave: 'Brave',
  opera: 'Opera', vivaldi: 'Vivaldi' };
const PRODUCT_ALIASES = { 'google chrome': 'chrome', 'microsoft edge': 'edge', msedge: 'edge', 'mozilla firefox': 'firefox' };

/** The label of a browser for people: its name, else its product's, else "Browser". */
export function browserLabel(browser) {
  return browser?.name || PRODUCT_NAMES[browser?.product] || browser?.product || 'Browser';
}

/** "Firefox (firefox), Chromium (chromium)": the connected browsers as an agent can name them. */
export function describeBrowsers(browsers) {
  return browsers.map(browser => `${browserLabel(browser)} (${browser.product ?? browser.id})`).join(', ');
}

/**
 * Whether `browser` ({id, product, name}) is the one an agent named: its id, its product (or an alias such as
 * "Google Chrome") or its name, case-insensitive. The daemon's choice and the MCP server's reuse check share it.
 */
export function browserMatches(browser, wanted) {
  if (!browser || wanted === undefined || wanted === null) return false;
  const raw = String(wanted).trim();
  const key = raw.toLowerCase();
  const product = PRODUCT_ALIASES[key] ?? key;
  return (Boolean(browser.id) && browser.id === raw) || (Boolean(browser.product) && browser.product === product)
    || (Boolean(browser.name) && String(browser.name).toLowerCase() === key);
}

/**
 * The browser a new tab request goes to: `wanted` (what the agent named: an id, a product such as "firefox" or a
 * name, case-insensitive) when given, else the one the user used FAI in most recently (`usedAt`: the last approval,
 * popup open or toolbar click), else the most recently connected one. Several matches: the most recently used.
 * Returns {browser} (null when nothing is connected and nothing was asked for) or {error: {code, message}}.
 * `browsers` are the connected browsers ({id, product, name, usedAt, connectedAt}).
 */
export function pickBrowser(browsers, wanted) {
  const list = Array.isArray(browsers) ? browsers : [];
  const recent = (a, b) => (b.usedAt ?? 0) - (a.usedAt ?? 0) || (b.connectedAt ?? 0) - (a.connectedAt ?? 0);
  if (wanted === undefined || wanted === null || wanted === '') {
    return { browser: [...list].sort(recent)[0] ?? null };
  }
  const matches = list.filter(browser => browserMatches(browser, wanted));
  if (matches.length) return { browser: matches.sort(recent)[0] };
  const message = list.length
    ? `No connected browser matches "${String(wanted).slice(0, 40)}". Connected: ${describeBrowsers(list)}. Pass one of `
      + 'those as browser, or leave browser out to use the one the user used FAI in last.'
    : `No browser with FAI Browser is connected, so "${String(wanted).slice(0, 40)}" cannot be used. Ask the user to open `
      + 'the browser with the FAI Browser extension, or leave browser out.';
  return { error: { code: 'browser_not_connected', message } };
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
  // More closes than flapLimit within flapWindowMs: the browser's connection is flapping (a warning in status).
  flapLimit = FLAP_LIMIT,
  flapWindowMs = FLAP_WINDOW_MS,
  // A superseded socket older than this (after its hello) means two installs share an identity.
  duplicateAfterMs = DUPLICATE_AFTER_MS,
  // What the daemon kept from earlier runs, per browser id: {usedAt, origin}. The last use routes new requests after a
  // restart; the origin binds the id (a known id from another extension Origin is refused).
  knownBrowsers = {},
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
  // One entry per browser identity (connectionIdentity): {id, legacy, origin, product, name, version, socket,
  // socketReady, connected, transport, connectedAt, lastSeen, graceTimer, outbox, waiters, settings, usedAt, closes,
  // sentJson, flapping}.
  const browsers = new Map();
  let extensionSettings = null; // the popup settings last reported by any browser ({budget}), null until one does
  let requests = [];
  let requestsJson = '[]';
  const leases = new Map(); // leaseId -> {leaseId, requestId, browserId, tabId, origin, allowedOrigins, status, reason, state}
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

  // --- browsers (one connection each) ---------------------------------------------------------------------

  // Each id belongs to the extension Origin it first came from (kept across restarts with `knownBrowsers`): a client
  // holding the pairing secret cannot take over another browser's connection by claiming its id from another origin.
  const known = new Map();
  for (const [id, entry] of Object.entries(knownBrowsers && typeof knownBrowsers === 'object' ? knownBrowsers : {})) {
    if (!BROWSER_ID.test(id) || !entry || typeof entry !== 'object') continue;
    known.set(id, { usedAt: Number.isFinite(entry.usedAt) ? entry.usedAt : 0,
      origin: typeof entry.origin === 'string' ? entry.origin : null });
  }
  const boundOrigin = id => browsers.get(id)?.origin ?? known.get(id)?.origin ?? null;

  // The identity of a connection, or null when it claims an id that belongs to another extension Origin.
  function identify(reported, origin) {
    const identity = connectionIdentity(reported, origin);
    if (identity.legacy) return identity;
    const bound = boundOrigin(identity.id);
    if (bound && bound !== origin) {
      // Logged once per id; counted for status (the refused extension picks a new id and connects again).
      if (!refusals.ids.has(identity.id)) logEvent('extension_identity_refused', { browserId: identity.id });
      refusals.ids.add(identity.id);
      refusals.count++;
      refusals.lastAt = Date.now();
      return null;
    }
    return identity;
  }
  const refusals = { count: 0, lastAt: 0, ids: new Set() };

  // Remembers a browser's last use and origin, and tells the daemon (which keeps them in its state directory).
  function noteUsage(browser, used = false) {
    if (browser.legacy) return;
    if (used) browser.usedAt = Date.now();
    const before = known.get(browser.id);
    const same = before && before.usedAt === browser.usedAt && before.origin === browser.origin;
    // Least recently seen first: every connection moves its browser to the end.
    known.delete(browser.id);
    known.set(browser.id, { usedAt: browser.usedAt, origin: browser.origin });
    let evicted = false;
    while (known.size > KNOWN_MAX) {
      // Browsers that are not connected go first, so a long-lived browser keeps its binding and last use through any
      // number of reinstalls elsewhere.
      const idle = [...known.keys()].find(id => !browsers.get(id)?.connected && !browsers.get(id)?.socket?.open);
      known.delete(idle ?? known.keys().next().value);
      evicted = true;
    }
    if (same && !evicted) return;
    emit({ type: 'usage', browsers: Object.fromEntries(known) });
  }

  function browserFor({ id, legacy }, origin) {
    let browser = browsers.get(id);
    if (!browser) {
      browser = {
        id, legacy, origin, product: originProduct(origin), name: null, version: null, browserVersion: null,
        socket: null, socketReady: false, socketOpenedAt: 0, connected: false, transport: 'none', connectedAt: 0,
        lastSeen: Date.now(), graceTimer: null, outbox: [], waiters: new Set(), settings: null,
        usedAt: known.get(id)?.usedAt ?? 0, closes: [], sentJson: null, flapping: false, duplicateAt: 0,
      };
      browsers.set(id, browser);
      pruneBrowsers(browser);
      noteUsage(browser);
    }
    return browser;
  }

  // Forgets disconnected browsers without a lease (long gone, or too many), never `keep` (one just seen).
  function pruneBrowsers(keep = null) {
    const idle = [...browsers.values()].filter(browser => browser !== keep && !browser.connected && !browser.socket?.open
      && !browser.waiters.size && ![...leases.values()].some(lease => lease.browserId === browser.id));
    for (const browser of idle) {
      if (browsers.size > MAX_BROWSERS || Date.now() - browser.lastSeen > FORGET_BROWSER_MS) {
        clearTimeout(browser.graceTimer);
        browsers.delete(browser.id);
      }
    }
  }

  const connectedBrowsers = () => [...browsers.values()].filter(browser => browser.connected || browser.socket?.open);
  // The browser of the most recent activity: used last, else connected last. A lease bound without a browserId
  // (an embedding or a test that names none) belongs to it.
  function latestBrowser() {
    const live = connectedBrowsers();
    const pool = live.length ? live : [...browsers.values()];
    return pool.sort((a, b) => b.usedAt - a.usedAt || b.connectedAt - a.connectedAt)[0] ?? null;
  }
  const ownerOf = lease => (lease?.browserId ? browsers.get(lease.browserId) ?? null : latestBrowser());
  const transportOf = browser => (browser?.socket?.open ? 'websocket' : browser?.connected ? browser.transport : 'none');

  function markSeen(browser, kind) {
    browser.lastSeen = Date.now();
    clearTimeout(browser.graceTimer);
    browser.graceTimer = null;
    const effective = browser.socket?.open ? 'websocket' : kind;
    if (browser.connected && browser.transport === effective) return;
    const wasConnected = browser.connected;
    browser.connected = true;
    browser.transport = effective;
    if (!wasConnected) browser.connectedAt = Date.now();
    logEvent('extension_connected', { transport: effective, browserId: browser.id });
    emit({ type: 'connected', transport: effective, browserId: browser.id });
    if (!wasConnected) {
      noteUsage(browser);
      publishAll();
    }
  }

  function connectionLost(browser) {
    clearTimeout(browser.graceTimer);
    browser.graceTimer = null;
    const previous = browser.transport;
    for (const lease of leases.values()) {
      if (lease.status === 'active' && ownerOf(lease) === browser) deactivate(lease, 'paused', 'disconnected');
    }
    if (!browser.connected) return;
    browser.connected = false;
    browser.transport = 'none';
    logEvent('extension_disconnected', { transport: previous, browserId: browser.id });
    emit({ type: 'disconnected', transport: previous, browserId: browser.id });
    publishAll();
  }

  // The browser went away (socket closed or held long-poll dropped). A live worker reconnects or re-polls well
  // within the grace period.
  function scheduleGrace(browser) {
    clearTimeout(browser.graceTimer);
    browser.graceTimer = setTimeout(() => {
      browser.graceTimer = null;
      if (!browser.socket?.open && !browser.waiters.size) connectionLost(browser);
    }, disconnectGraceMs);
    browser.graceTimer.unref?.();
  }

  // A closed socket of `browser`: counted, so a reconnect loop shows up as `extension_flapping` (status warnings).
  function noteClose(browser) {
    const now = Date.now();
    browser.closes = browser.closes.filter(at => now - at < flapWindowMs);
    browser.closes.push(now);
    const flapping = browser.closes.length > flapLimit;
    if (flapping && !browser.flapping) {
      logEvent('extension_flapping', { browserId: browser.id, closes: browser.closes.length, windowMs: flapWindowMs });
    }
    browser.flapping = flapping;
  }

  // An open socket or a held long-poll counts as liveness.
  const expiry = setInterval(() => {
    const now = Date.now();
    for (const browser of [...browsers.values()]) {
      if (browser.socket?.open || browser.waiters.size) browser.lastSeen = now;
      if (browser.connected && now - browser.lastSeen > leaseTimeoutMs) connectionLost(browser);
      if (browser.flapping && !browser.closes.some(at => now - at < flapWindowMs)) {
        browser.flapping = false;
        browser.closes = [];
      }
    }
    pruneBrowsers();
  }, 250);
  expiry.unref();

  function browserView(browser) {
    const iso = ms => (ms ? new Date(ms).toISOString() : null);
    const now = Date.now();
    return {
      id: browser.id,
      product: browser.product,
      name: browserLabel(browser),
      version: browser.version,
      browserVersion: browser.browserVersion,
      transport: transportOf(browser),
      connected: browser.connected || Boolean(browser.socket?.open),
      connectedAt: iso(browser.connectedAt),
      lastSeen: iso(browser.lastSeen),
      lastUsedAt: iso(browser.usedAt),
      legacy: browser.legacy,
      closesLastMinute: browser.closes.filter(at => now - at < flapWindowMs).length,
      leases: [...leases.values()]
        .filter(lease => ownerOf(lease) === browser && ['active', 'paused'].includes(lease.status))
        .map(lease => ({ leaseId: lease.leaseId, requestId: lease.requestId, status: lease.status })),
    };
  }

  // The connected browsers' display names, in connection order; a name two of them share gets " (2)", " (3)" ...
  function displayNames() {
    const names = new Map();
    const seen = new Map();
    for (const browser of connectedBrowsers().sort((a, b) => a.connectedAt - b.connectedAt)) {
      const label = browserLabel(browser);
      const count = (seen.get(label) ?? 0) + 1;
      seen.set(label, count);
      names.set(browser.id, count > 1 ? `${label} (${count})` : label);
    }
    return names;
  }

  // The connected browsers as one popup lists them: names only, with `self` for its own. Ids never go to an
  // extension (another one could claim them); agents see them in status.
  const browserList = (self, names = displayNames()) => connectedBrowsers().sort((a, b) => a.connectedAt - b.connectedAt)
    .map(browser => ({ product: browser.product, name: names.get(browser.id), self: browser === self }));

  // --- outbound --------------------------------------------------------------------------------------------

  // Sends a daemon->extension push to one browser: over its socket when open, else queued for its next long-poll.
  function push(browser, message) {
    if (!browser) return;
    const framed = { v: 3, ...message };
    if (browser.socket?.open) {
      browser.socket.send(framed);
      return;
    }
    browser.outbox.push(framed);
    if (browser.outbox.length > 100) browser.outbox.shift();
    wakeWaiters(browser);
  }

  // The request views one browser gets: all of them with the browser list (a current extension marks the ones meant
  // for another browser itself), or only its own and unassigned ones for an older extension that cannot tell.
  // Each view's `browser` becomes {product, name, mine}: whether the request is this browser's, never an id.
  function snapshotFor(browser) {
    const names = displayNames();
    const own = view => !view?.browser?.id || view.browser.id === browser.id;
    // The lease (its leaseId and browserId) only for the browser that holds it: another one could claim them.
    const marked = view => {
      if (!view || typeof view !== 'object') return view;
      const out = { ...view };
      const holder = view.lease?.browserId ?? view.browser?.id ?? null;
      if (view.lease && holder && holder !== browser.id) delete out.lease;
      if (view.browser?.id) {
        out.browser = { product: view.browser.product ?? null, name: names.get(view.browser.id) ?? view.browser.name ?? null,
          mine: view.browser.id === browser.id };
      }
      return out;
    };
    if (browser.legacy) return { requests: requests.filter(own).map(marked) };
    return { requests: requests.map(marked), browsers: browserList(browser, names) };
  }

  // Sends each ready socket its snapshot when it changed, and wakes held long-polls.
  function publishAll() {
    for (const browser of browsers.values()) {
      const snapshot = snapshotFor(browser);
      const json = JSON.stringify(snapshot);
      if (json === browser.sentJson) continue;
      if (browser.socket?.open) {
        if (!browser.socketReady) continue;
        browser.sentJson = json;
        browser.socket.send({ v: 3, type: 'requests', ...snapshot });
      } else {
        wakeWaiters(browser, { requestsChanged: true });
      }
    }
  }

  function takeCommand(browser) {
    for (let index = 0; index < queue.length;) {
      const command = queue[index];
      const lease = leases.get(command.lease.id);
      if (ownerOf(lease) !== browser) {
        index++;
        continue;
      }
      queue.splice(index, 1);
      if (['open_tab', 'switch_tab'].includes(command.args?.action?.type) && lease?.tabMode !== 'multiple') {
        pending.get(command.id)?.reject(new BridgeError('blocked_risky', 'This request allows one task tab'));
        continue;
      }
      command.lease.tabMode = lease?.tabMode ?? 'single';
      return command;
    }
    return null;
  }

  function wakeWaiters(browser, { requestsChanged = false } = {}) {
    for (const waiter of [...browser.waiters]) {
      const command = takeCommand(browser);
      if (command) {
        waiter.finish(command);
      } else if (browser.outbox.length || requestsChanged) {
        waiter.finish(null);
      } else {
        return;
      }
    }
  }

  // Delivers queued commands, each to the browser that holds its lease: over its socket once its hello is handled,
  // else to its held long-polls.
  function dispatch() {
    for (const browser of browsers.values()) {
      if (browser.socket?.open) {
        if (!browser.socketReady) continue;
        for (let command = takeCommand(browser); command; command = takeCommand(browser)) {
          browser.socket.send({ v: 3, type: 'command', command });
          delivered(command.id, browser);
        }
        continue;
      }
      wakeWaiters(browser);
    }
  }

  // A command went to `browser`: only that connection may answer it (result, screenshot).
  function delivered(id, browser) {
    const entry = pending.get(id);
    if (entry) {
      entry.delivered = true;
      entry.browserId = browser.id;
    }
    const shot = screenshots.get(id);
    if (shot) shot.browserId = browser.id;
  }

  function longPollBody(browser, command) {
    if (command) delivered(command.id, browser);
    const snapshot = snapshotFor(browser);
    browser.sentJson = JSON.stringify(snapshot);
    return { command, ...snapshot, messages: browser.outbox.splice(0) };
  }

  function holdLongPoll(browser, res, waitMs, reply) {
    const waiter = {
      finish(command) {
        if (!browser.waiters.delete(waiter)) return;
        clearTimeout(waiter.timer);
        reply(200, longPollBody(browser, command));
      },
    };
    waiter.timer = setTimeout(() => waiter.finish(null), waitMs);
    // Per-connection cleanup: a dropped connection must neither keep a timer nor swallow a command.
    res.on('close', () => {
      clearTimeout(waiter.timer);
      if (browser.waiters.delete(waiter) && !browser.socket?.open) scheduleGrace(browser);
    });
    browser.waiters.add(waiter);
  }

  function releaseWaiters() {
    for (const browser of browsers.values()) for (const waiter of [...browser.waiters]) waiter.finish(null);
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
      ...(lease.browserId ? { browserId: lease.browserId } : {}),
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
          if (entry?.delivered && gaveUp && !closed) push(ownerOf(leases.get(leaseId)), { type: 'cancel', id });
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

  function handleResult(body, browser) {
    const entry = pending.get(body.id);
    // A result from a connection that was not sent the command is dropped.
    if (entry?.browserId && entry.browserId !== browser.id) {
      logEvent('extension_result_dropped', { browserId: browser.id });
      return;
    }
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

  const LEFT_ORIGIN = /^https?:\/\/[a-z0-9.[\]:-]{1,260}$/i;

  // The browser's most recently bound active lease; used for v2-style /status reports that carry no leaseId.
  function currentActiveLease(browser) {
    let found = null;
    for (const lease of leases.values()) if (lease.status === 'active' && ownerOf(lease) === browser) found = lease;
    return found;
  }

  function handleStatus(message, browser) {
    const status = ['active', 'paused', 'stopped'].includes(message.status) ? message.status : 'paused';
    const reason = typeof message.reason === 'string' ? message.reason : status;
    const lease = typeof message.leaseId === 'string' ? leases.get(message.leaseId) : currentActiveLease(browser);
    if (!lease || status === 'active') return;
    // A browser reports on its own leases only.
    if (lease.browserId && lease.browserId !== browser.id) return;
    if (lease.status === 'active') deactivate(lease, status, reason);
    else if (status === 'stopped' && lease.status !== 'stopped') lease.status = 'stopped';
    lease.state = status;
    // An origin_changed pause names the origin the tab went to, a child_tab pause the origin of the tab or window the
    // page opened (origin only; the extension redacts it like any URL).
    const left = ['origin_changed', 'child_tab'].includes(reason) && typeof message.origin === 'string'
      && LEFT_ORIGIN.test(message.origin) ? { origin: message.origin } : {};
    emit({ type: 'status', leaseId: lease.leaseId, requestId: lease.requestId, status, reason, browserId: browser.id, ...left });
  }

  // Routes one extension message from `browser` (over `connection` when via the WebSocket). `answer(ok, payload)`
  // replies to ref'd types exactly once.
  function handleMessage(message, answer, via, browser, connection = null) {
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
    const browserId = browser.id;
    const browserRef = () => ({ id: browserId, product: browser.product, name: browserLabel(browser) });
    switch (message?.type) {
      case 'hello': {
        browser.version = typeof message.ext?.version === 'string' ? message.ext.version.slice(0, 40) : null;
        const info = sanitizeBrowserInfo(message.browser);
        if (info.product) browser.product = info.product;
        if (info.name) browser.name = info.name;
        if (info.version) browser.browserVersion = info.version;
        const session = sanitizeSession(message.session);
        // An older extension sends no settings: the ones last reported (if any) stand.
        if (message.settings !== undefined) {
          browser.settings = sanitizeSettings(message.settings);
          extensionSettings = browser.settings;
        }
        const finish = value => {
          const wasAnswered = answered;
          if (via === 'http' && !value?.error) {
            const snapshot = snapshotFor(browser);
            browser.sentJson = JSON.stringify(snapshot);
            reply({ ...value, ...snapshot });
          } else {
            reply(value);
          }
          if (wasAnswered || via !== 'ws' || browser.socket !== connection || !connection?.open) return;
          browser.socketReady = true;
          const snapshot = snapshotFor(browser);
          browser.sentJson = JSON.stringify(snapshot);
          connection.send({ v: 3, type: 'requests', ...snapshot });
          dispatch();
        };
        const event = { type: 'hello', session, settings: extensionSettings, browserId, browser: browserRef(), reply: finish };
        if (!emit(event)) finish({ mode, endSession: Boolean(session) });
        // The other browsers list this one by its reported name from now on.
        publishAll();
        return;
      }
      case 'used': {
        // The user opened the popup or clicked the toolbar icon in this browser: new tab requests go here.
        noteUsage(browser, true);
        emit({ type: 'used', browserId });
        if (message.ref !== undefined || via === 'http') answer(true, { ok: true });
        return;
      }
      case 'approval': {
        // An approval surface shown, an approval attempt, or why one failed (extension reportApproval): logged only.
        const event = approvalEvent(message);
        if (event) emit({ type: 'approval', browserId, ...event });
        if (message.ref !== undefined || via === 'http') answer(true, { ok: true });
        return;
      }
      case 'move': {
        // The popup's "Open here": the user wants a request that waits in another browser in this one.
        const requestId = typeof message.requestId === 'string' ? message.requestId : null;
        noteUsage(browser, true);
        const event = { type: 'move', requestId, browserId, browser: browserRef(), reply };
        if (!emit(event)) reply({ error: { code: 'no_request', message: 'No tab request is pending' } });
        return;
      }
      case 'settings': {
        // The user changed a popup setting (the per-request budget). Kept here for extension(); the daemon replies
        // with what is in effect.
        extensionSettings = sanitizeSettings(message.settings) ?? { budget: null };
        browser.settings = extensionSettings;
        const event = { type: 'settings', settings: extensionSettings, browserId, reply };
        if (!emit(event)) reply({ settings: extensionSettings });
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
        if (via === 'ws') connection?.send({ v: 3, type: 'pong' });
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
          // The user approved what the agent asked for on this request (a higher level, another origin): it joins it.
          ask: message.ask === true,
          // Which ask the user's card showed: only that exact ask is applied.
          askId: typeof message.askId === 'string' ? message.askId.slice(0, 64) : null,
          // The browser the user approved in: the lease, and every command of it, belong to it.
          browserId,
          browser: browserRef(),
          reply,
        };
        // An approval is the strongest sign of where the user works: new tab requests go here.
        noteUsage(browser, true);
        if (!emit(event)) reply({ error: { code: 'no_request', message: 'No tab request is pending' } });
        return;
      }
      case 'invite': {
        // The popup's Invite click (the worker sends it only for popup.html, docs/REFERENCE.md "Invites and wakes"):
        // the tab the user is on, at the level they chose, for the agent session they picked (or none: copy text).
        if (!Number.isInteger(message.tabId) || typeof message.origin !== 'string' || !isLevel(message.level)) {
          reply({ error: { code: 'bad_request', message: 'tabId, origin and level are required' } });
          return;
        }
        if (message.tabMode !== undefined && !['single', 'multiple'].includes(message.tabMode)) {
          reply({ error: { code: 'bad_request', message: 'tabMode must be single or multiple' } });
          return;
        }
        if (message.sessionId !== undefined && message.sessionId !== null && typeof message.sessionId !== 'string') {
          reply({ error: { code: 'bad_request', message: 'sessionId must be a string' } });
          return;
        }
        noteUsage(browser, true);
        const event = {
          type: 'invite',
          tabId: message.tabId,
          origin: message.origin,
          title: typeof message.title === 'string' ? message.title.slice(0, 300) : '',
          level: message.level,
          tabMode: message.tabMode ?? 'single',
          sessionId: typeof message.sessionId === 'string' ? message.sessionId.slice(0, 64) : null,
          // The user's own words from the popup's "What should it do?" field.
          text: typeof message.text === 'string' ? message.text.slice(0, 2000) : '',
          browserId,
          browser: browserRef(),
          reply,
        };
        if (!emit(event)) reply({ error: { code: 'unsupported', message: 'Update the FAI service to invite agents.' } });
        return;
      }
      case 'invite_cancel': {
        const event = {
          type: 'invite_cancel',
          inviteId: typeof message.inviteId === 'string' ? message.inviteId.slice(0, 64) : null,
          requestId: typeof message.requestId === 'string' ? message.requestId.slice(0, 128) : null,
          reason: message.reason === 'tab_closed' ? 'tab_closed' : 'cancelled',
          browserId,
          reply,
        };
        if (!emit(event)) reply({ error: { code: 'unknown_invite', message: 'No such invite' } });
        return;
      }
      case 'agents': {
        // The popup's Invite list: the live agent sessions (host, repo name, last activity, whether it can be woken).
        if (!emit({ type: 'agents', browserId, reply })) reply({ sessions: [], invites: [] });
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
        if (!lease || (lease.browserId && lease.browserId !== browserId)) {
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
        // `ask`: the user declined only what the agent asked for on top of an approved request.
        const event = { type: 'deny', requestId, browserId, reply, ...(message.ask === true ? { ask: true } : {}) };
        if (!emit(event)) reply({ error: { code: 'no_request', message: 'No tab request is pending' } });
        return;
      }
      case 'status':
        handleStatus(message, browser);
        if (via === 'http') answer(true, { ok: true });
        return;
      case 'validate': {
        const lease = leases.get(message.leaseId);
        answer(true, { valid: pending.has(message.id) && lease?.status === 'active' });
        return;
      }
      case 'result':
        handleResult(message, browser);
        if (via === 'http') answer(true, { ok: true });
        return;
      case 'screenshot': {
        const slot = screenshots.get(message.id);
        if (!slot?.browserId || slot.browserId === browserId) settleScreenshot(message.id, normalizeScreenshot(message));
        if (via === 'http') answer(true, { ok: true });
        return;
      }
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
    const identity = identify(url.searchParams.get('browser'), req.headers.origin);
    if (!identity) {
      connection.close(CLOSE_IDENTITY_REFUSED, 'This browser id belongs to another extension');
      return true;
    }
    const browser = browserFor(identity, req.headers.origin);
    const previous = browser.socket;
    const previousReady = browser.socketReady;
    const previousOpenedAt = browser.socketOpenedAt;
    browser.socket = connection;
    browser.socketReady = false;
    browser.socketOpenedAt = Date.now();
    browser.sentJson = null;
    // Only this browser's own older socket is replaced (a restarted worker); never another browser's (issue #9).
    if (previous?.open) {
      previous.close(CLOSE_SUPERSEDED, "Superseded by this browser's newer connection");
      // A restarted worker's old socket is new or already dead. One that said hello and lived on is another install
      // with the same identity (a copied profile), or someone claiming it.
      if (previousReady && Date.now() - previousOpenedAt >= duplicateAfterMs) {
        if (!browser.duplicateAt || Date.now() - browser.duplicateAt > DUPLICATE_WARN_MS) {
          logEvent('extension_duplicate_identity', { browserId: browser.id });
        }
        browser.duplicateAt = Date.now();
      }
    }
    logEvent('extension_ws_open', { browserId: browser.id });
    markSeen(browser, 'websocket');
    connection.on('message', text => {
      if (browser.socket !== connection) return;
      browser.lastSeen = Date.now();
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
      handleMessage(message, answer, 'ws', browser, connection);
    });
    connection.on('close', ({ code }) => {
      logEvent('extension_ws_close', { code, browserId: browser.id });
      noteClose(browser);
      if (browser.socket !== connection) return;
      browser.socket = null;
      browser.socketReady = false;
      scheduleGrace(browser);
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
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Fai-Browser');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
      reply(200, {});
      return true;
    }
    if (req.method !== 'POST' && !(req.method === 'GET' && type === 'commands')) {
      reply(404, { error: 'Unknown route' });
      return true;
    }
    // Which browser this is (the X-Fai-Browser header; an older extension by its Origin). Any authenticated request
    // proves that browser is alive.
    const identity = identify(req.headers[BROWSER_HEADER], req.headers.origin);
    if (!identity) {
      reply(403, { error: 'This browser id belongs to another extension', code: 'identity_refused' });
      return true;
    }
    const browser = browserFor(identity, req.headers.origin);
    markSeen(browser, 'longpoll');
    (async () => {
      try {
        const body = req.method === 'POST' ? await readBody(req) : {};
        if (type === 'commands') {
          const command = takeCommand(browser);
          const requested = Number(url.searchParams.get('wait') ?? 0);
          const waitMs = Number.isFinite(requested) ? Math.min(Math.max(requested, 0), MAX_LONG_POLL_MS) : 0;
          // A changed request list is answered at once, not held until the next change or the wait's end.
          const stale = browser.sentJson !== null && JSON.stringify(snapshotFor(browser)) !== browser.sentJson;
          if (command || browser.outbox.length || !waitMs || closed || stale) return reply(200, longPollBody(browser, command));
          return holdLongPoll(browser, res, waitMs, reply);
        }
        const answer = (ok, payload) => {
          if (ok) return reply(200, payload);
          const status = REPLY_HTTP_STATUS[payload.code] ?? 409;
          const origins = payload.origins ? { origins: payload.origins } : {};
          return reply(status, { error: payload.message, code: payload.code, ...origins });
        };
        handleMessage({ ...body, type }, answer, 'http', browser);
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
    push(ownerOf(lease), { type: 'lease_update', requestId: lease.requestId, leaseId, state, reason });
    return true;
  }

  return {
    mode,
    handleHttp,
    handleUpgrade,
    // The extension side as a whole (any browser connected; transport and version of the browser used last) and
    // `browsers`: every connected browser (browserView).
    extension: () => {
      const live = connectedBrowsers();
      const latest = live.length ? latestBrowser() : null;
      const seen = Math.max(0, ...[...browsers.values()].map(browser => browser.lastSeen));
      return {
        connected: live.length > 0,
        transport: transportOf(latest),
        version: latest?.version ?? null,
        lastSeenMs: live.length && seen ? Date.now() - seen : null,
        settings: extensionSettings,
        browsers: live.map(browserView),
      };
    },
    // Every browser known to the hub (connected ones and recently gone ones), for status.
    browsers: () => [...browsers.values()].map(browserView),
    // The connected browsers a new tab request can go to, for pickBrowser(): {id, product, name, usedAt, connectedAt}.
    candidates: () => connectedBrowsers().map(browser => ({ id: browser.id, product: browser.product,
      name: browserLabel(browser), usedAt: browser.usedAt, connectedAt: browser.connectedAt })),
    // Status warnings: a browser whose connection keeps closing (a reconnect loop, issue #9).
    warnings: () => [
      ...[...browsers.values()].filter(browser => browser.flapping).map(browser => {
        const closes = browser.closes.filter(at => Date.now() - at < flapWindowMs).length;
        return `extension_flapping: ${browserLabel(browser)} (${browser.id}) lost its connection ${closes} times in `
          + `${Math.round(flapWindowMs / 1000)} s; another FAI Browser install with the same identity, or an older `
          + 'FAI service, may be fighting over it';
      }),
      ...[...browsers.values()].filter(browser => browser.duplicateAt && Date.now() - browser.duplicateAt < DUPLICATE_WARN_MS)
        .map(browser => `extension_duplicate_identity: a second FAI Browser install took over the connection of `
          + `${browserLabel(browser)} (${browser.id}) from a live one; a copied browser profile shares its identity. `
          + 'Remove the extension from one copy, or reinstall it there'),
      ...(refusals.count && Date.now() - refusals.lastAt < DUPLICATE_WARN_MS
        ? [`extension_identity_refused: ${refusals.count} connection${refusals.count === 1 ? '' : 's'} claimed a browser id `
          + `bound to another extension Origin (last ${new Date(refusals.lastAt).toISOString()}); a reinstalled `
          + 'extension picks a new id by itself, anything else is not that browser'] : []),
    ],
    // The settings a browser last reported (sanitizeSettings), or null.
    settingsOf: browserId => browsers.get(browserId)?.settings ?? null,
    publishRequests(views = []) {
      const next = JSON.parse(JSON.stringify(Array.isArray(views) ? views : []));
      const json = JSON.stringify(next);
      if (json === requestsJson) return;
      requests = next;
      requestsJson = json;
      publishAll();
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    // `browserId`: the browser that holds the tab (the lease event's); its commands go only to that connection.
    // None (an embedding or a test): the browser used last.
    bindLease({ leaseId, requestId = null, browserId = null, tabId, origin, allowedOrigins = [], level, tabMode = 'single' }) {
      if (typeof leaseId !== 'string' || !leaseId) throw new TypeError('leaseId is required');
      if (level !== undefined && level !== null && !isLevel(level)) throw new TypeError('level must be a level');
      const lease = {
        leaseId,
        requestId,
        browserId: typeof browserId === 'string' && browserId ? browserId : null,
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
    // Replaces the pairing secret; every open socket authenticated with the old one is closed with 4001.
    setSecret(value) {
      validateCredentials(value, extensionId);
      setCredentials(value);
      for (const browser of browsers.values()) {
        if (browser.socket?.open) browser.socket.close(CLOSE_PAIRING_CHANGED, 'Pairing changed');
      }
    },
    stats: () => ({
      polling: [...browsers.values()].some(browser => browser.waiters.size > 0 || browser.socket?.open),
      heldPolls: [...browsers.values()].reduce((sum, browser) => sum + browser.waiters.size, 0),
      pendingCommands: pending.size,
      pendingScreenshots: screenshots.size,
      queuedCommands: queue.length,
    }),
    close() {
      if (closed) return;
      closed = true;
      clearInterval(expiry);
      for (const browser of browsers.values()) clearTimeout(browser.graceTimer);
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
      for (const browser of browsers.values()) {
        const current = browser.socket;
        if (!current) continue;
        browser.socket = null;
        current.close(1001, 'Shutting down');
        current.socket.end();
      }
      listeners.clear();
    },
  };
}
