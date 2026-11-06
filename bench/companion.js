// Test and benchmark harness only, not part of FAI Browser: a standalone companion (the transport hub in `companion`
// mode plus one implicit request with fixed allowedOrigins, on its own loopback server, no daemon). The bench
// (scripts/bench.mjs --browser, bench/selftest.mjs), scripts/browser-smoke.mjs and the bridge tests drive the real
// extension through it, starting a session with the worker's `start` message (no request id). The product path is the
// daemon (src/daemon.js) with the same hub in `daemon` mode.
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { BridgeError, DEFAULT_PORT, createHub } from '../src/bridge.js';
import { rejectUpgrade } from '../src/ws.js';
import { isLevel } from '../src/guardrails.js';

/**
 * Standalone companion: the hub in `companion` mode plus one implicit request with fixed allowedOrigins, served on
 * its own loopback server. Keeps the v2 public API (bridge, status, onLease, waitForLease, listen, close).
 */
export function createCompanion({
  port = DEFAULT_PORT,
  secret,
  extensionId,
  allowedOrigins = [],
  // Longer than the 25 s long-poll so an idle but connected extension never expires its lease.
  leaseTimeoutMs = 35_000,
  commandTimeoutMs = 30_000,
  screenshotTimeoutMs = 5_000,
  disconnectGraceMs = 3_000,
  pingIntervalMs,
  idleTimeoutMs,
} = {}) {
  const hub = createHub({
    secret,
    extensionId,
    mode: 'companion',
    leaseTimeoutMs,
    commandTimeoutMs,
    screenshotTimeoutMs,
    disconnectGraceMs,
    pingIntervalMs,
    idleTimeoutMs,
  });
  // Exact origins only: the companion has no domain-root scope (src/origins.js roots need the daemon and the popup).
  if (allowedOrigins.some(origin => typeof origin !== 'string' || origin.includes('*'))) {
    throw new TypeError('createCompanion allowedOrigins must be exact origins (no domain roots such as https://*.example.com)');
  }
  const origins = [...allowedOrigins];
  const leaseListeners = new Set();
  let currentLeaseId = null;
  let closed = false;
  const current = () => (currentLeaseId ? hub.lease(currentLeaseId) : null);

  function publicLease(lease) {
    const out = { tabId: lease.tabId, origin: lease.origin, status: lease.status, id: lease.leaseId };
    if (lease.level) out.level = lease.level;
    return out;
  }

  function notifyLease() {
    const lease = current();
    const snapshot = { ...publicLease(lease), reason: lease.reason };
    for (const listener of [...leaseListeners]) {
      try {
        listener(snapshot);
      } catch {
        // A listener failure must not break the transport.
      }
    }
  }

  function onLeaseEvent(event) {
    if (event.requestId !== null) {
      const message = 'This companion has no tab requests; use Select tab and start';
      event.reply({ error: { code: 'no_request', message } });
      return;
    }
    if (!origins.includes(event.origin)) {
      const message = 'Tab origin is not approved in companion configuration';
      event.reply({ error: { code: 'origin_not_requested', message, origins } });
      return;
    }
    const lease = current();
    if (lease?.status === 'active' && lease.tabId !== event.tabId) {
      const message = 'Stop the current tab lease before selecting another tab';
      event.reply({ error: { code: 'request_not_pending', message } });
      return;
    }
    if (lease?.status === 'active') {
      event.reply({ leaseId: lease.leaseId, requestId: null, ...publicLease(lease) });
      return;
    }
    const leaseId = randomBytes(16).toString('hex');
    // The level the user approved; an older extension sends none, which keeps the Phase 1 ceiling (reversible).
    const bound = hub.bindLease({
      leaseId,
      requestId: null,
      tabId: event.tabId,
      origin: event.origin,
      allowedOrigins: origins,
      level: isLevel(event.level) ? event.level : 'reversible',
    });
    currentLeaseId = leaseId;
    event.reply({ leaseId, requestId: null, ...publicLease(bound) });
    notifyLease();
  }

  // A restarted worker (session null) or one holding an unknown lease loses the lease; a socket blip with the
  // same leaseId resumes it.
  function onHello(event) {
    const lease = current();
    const session = event.session;
    let endSession = false;
    if (session && lease && session.leaseId === lease.leaseId) {
      const resumable = lease.status === 'active' || (lease.status === 'paused' && lease.reason === 'disconnected');
      if (session.status === 'active' && resumable) {
        if (lease.status !== 'active') hub.updateLease(lease.leaseId, 'active');
      } else if (session.status !== 'active' && lease.status === 'active') {
        hub.updateLease(lease.leaseId, session.status === 'stopped' ? 'released' : 'paused', session.status);
      } else if (session.status === 'active') {
        endSession = true;
      }
    } else {
      if (lease?.status === 'active') hub.updateLease(lease.leaseId, 'paused', 'session_inactive');
      endSession = Boolean(session);
    }
    event.reply({ mode: 'companion', endSession });
  }

  hub.onEvent(event => {
    if (event.type === 'lease') onLeaseEvent(event);
    else if (event.type === 'hello') onHello(event);
    // The hub already lowered its lease (lease_level never raises); the companion keeps no other grant.
    else if (event.type === 'lease_level') {
      event.reply({ leaseId: event.leaseId, level: event.level });
      if (event.leaseId === currentLeaseId) notifyLease();
    }
    else if (event.type === 'deny') {
      event.reply({ error: { code: 'no_request', message: 'No tab request is pending' } });
    }
  });

  const server = http.createServer((req, res) => {
    if (hub.handleHttp(req, res)) return;
    const status = req.headers.origin === `chrome-extension://${extensionId}` ? 404 : 403;
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: status === 404 ? 'Unknown route' : 'Unauthorized extension origin' }));
  });
  server.on('upgrade', (req, socket, head) => {
    if (!hub.handleUpgrade(req, socket, head)) rejectUpgrade(socket, 400, 'Unknown upgrade path');
  });

  const route = method => (...args) => hub.bridgeFor(currentLeaseId)[method](...args);

  function waitForLease({ timeoutMs, signal } = {}) {
    const lease = current();
    if (lease?.status === 'active') return Promise.resolve(publicLease(lease));
    if (closed) return Promise.reject(new BridgeError('disconnected', 'Companion closed'));
    return new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        unsubscribe();
        signal?.removeEventListener('abort', onAbort);
      };
      const unsubscribe = onLease(snapshot => {
        cleanup();
        resolve(snapshot);
      });
      const onAbort = () => {
        cleanup();
        reject(signal.reason ?? new Error('Aborted'));
      };
      if (Number.isFinite(timeoutMs)) {
        timer = setTimeout(() => {
          cleanup();
          reject(new BridgeError('timeout', 'No browser tab was selected in time'));
        }, timeoutMs);
      }
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  // Calls `listener(lease)` each time a lease becomes active. Returns an unsubscribe function.
  function onLease(listener) {
    leaseListeners.add(listener);
    return () => leaseListeners.delete(listener);
  }

  return {
    hub,
    bridge: {
      observe: route('observe'),
      execute: route('execute'),
      capture: route('capture'),
      locate: route('locate'),
    },
    // Always an object. `status` is 'none' before any tab was selected, else the lease status.
    // `polling` is true while the extension holds a long-poll or an open WebSocket.
    status: () => {
      const lease = current();
      const stats = hub.stats();
      const extension = hub.extension();
      return {
        ...(lease ? publicLease(lease) : { status: 'none' }),
        reason: lease?.reason ?? null,
        lastSeenMs: extension.lastSeenMs,
        polling: stats.polling,
        transport: extension.transport,
        connected: extension.connected,
        pendingCommands: stats.pendingCommands,
        pendingScreenshots: stats.pendingScreenshots,
      };
    },
    onLease,
    waitForLease,
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve(server.address());
      });
    }),
    close: () => {
      closed = true;
      hub.close();
      leaseListeners.clear();
      return new Promise(resolve => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
