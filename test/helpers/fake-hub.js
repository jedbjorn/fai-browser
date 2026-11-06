// In-memory hub implementing the design's hub interface (section 3) for daemon tests. Each bound lease gets a
// FakeBridge from runtime-fixtures; a lease that is no longer active rejects commands with its reason code, as the
// real hub does. Observations come from FakeBridge, so they carry `blocks` derived by runtime-fixtures blocksFor().
import http from 'node:http';
import { bridgeError } from '../../src/result.js';
import { FakeBridge, ORIGIN } from '../runtime-fixtures.js';

export function createFakeHub({ bridgeOptions = {} } = {}) {
  const listeners = new Set();
  const leases = new Map();
  const hub = {
    kind: 'fake',
    connected: true,
    published: [],
    updates: [],
    bound: [],
    forgotten: [],
    secrets: [],
    closed: false,
    bridges: new Map(),
    handleHttp: () => false,
    handleUpgrade: () => false,
    extension: () => ({
      connected: hub.connected,
      transport: hub.connected ? 'websocket' : 'none',
      version: 'test',
      lastSeenMs: 0,
    }),
    publishRequests(views) {
      hub.published.push(views);
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    bindLease(info) {
      const existing = leases.get(info.leaseId);
      const bridge = existing?.bridge ?? hub.bridgeForTab(info.tabId);
      leases.set(info.leaseId, { ...info, state: 'active', reason: null, bridge });
      hub.bound.push(info);
    },
    setLeaseOrigins(leaseId, origin, allowedOrigins) {
      const lease = leases.get(leaseId);
      if (!lease) return false;
      Object.assign(lease, { origin, allowedOrigins: [...allowedOrigins] });
      return true;
    },
    setLeaseLevel(leaseId, level) {
      const lease = leases.get(leaseId);
      if (!lease) return false;
      lease.level = level;
      return true;
    },
    updateLease(leaseId, state, reason) {
      hub.updates.push({ leaseId, state, reason });
      const lease = leases.get(leaseId);
      if (lease) {
        lease.state = state;
        lease.reason = reason;
      }
    },
    forgetLease(leaseId) {
      hub.forgotten.push(leaseId);
      return leases.delete(leaseId);
    },
    bridgeFor(leaseId) {
      const live = () => {
        const lease = leases.get(leaseId);
        if (!lease) throw bridgeError('session_inactive', 'No lease', false);
        if (lease.state !== 'active') {
          const code = lease.state === 'paused' ? lease.reason ?? 'paused' : 'stopped';
          throw bridgeError(code, `Lease ${lease.state}`, false);
        }
        return lease.bridge;
      };
      return {
        observe: async (signal, options) => live().observe(signal, options),
        execute: async (...args) => live().execute(...args),
        // Records the capture details (labels, revision) on the bridge; tags are reported when labels were sent, as
        // the extension does on the labels' own revision.
        capture: async details => {
          const bridge = live();
          (bridge.captures ??= []).push(details);
          // A bridge that takes real screenshots (test/helpers/secret-bridge.js with an offscreen page).
          if (typeof bridge.captureImage === 'function' && bridge.offscreen) return bridge.captureImage(details);
          const tagged = details?.labels && details.revision === bridge.observation.revision;
          const tags = tagged ? Object.entries(details.labels).map(([ref, ids]) => ({ id: ids[0], ref, x: 1, y: 1, width: 20, height: 18 })) : undefined;
          return { dataUrl: 'data:image/jpeg;base64,YQ==', revision: bridge.observation.revision, format: 'jpeg',
            width: 1280, height: 800, ...(tags ? { tags } : {}) };
        },
        locate: async (...args) => live().locate(...args),
        // The Approve gate: a test sets `approve` on the FakeBridge (decisions, waits); without it nothing can ask.
        approve: async (...args) => {
          const bridge = live();
          if (typeof bridge.approve !== 'function') throw bridgeError('unsupported', 'This bridge cannot ask the user', false);
          return bridge.approve(...args);
        },
      };
    },
    setSecret(secret) {
      hub.secrets.push(secret);
    },
    close() {
      hub.closed = true;
    },

    // --- test controls ------------------------------------------------------------------------------------
    /** One FakeBridge per tab id, so a resumed lease on the same tab keeps its page state. */
    bridgeForTab(tabId) {
      if (!hub.bridges.has(tabId)) hub.bridges.set(tabId, new FakeBridge(bridgeOptions));
      return hub.bridges.get(tabId);
    },
    lease(leaseId) {
      return leases.get(leaseId);
    },
    /** Emit an event; resolves with the reply value (or undefined for events without a reply). */
    emit(event) {
      return new Promise(resolve => {
        const withReply = { ...event, reply: value => resolve(value) };
        for (const listener of [...listeners]) listener(withReply);
        if (!['lease', 'deny', 'hello', 'lease_level', 'settings', 'driver'].includes(event.type)) resolve(undefined);
      });
    },
    /** The extension lowered the level of a lease on its own (lease_level). */
    lowerLevel(leaseId, level) {
      return hub.emit({ type: 'lease_level', leaseId, level });
    },
    /**
     * `level`: the level the user chose in the popup (omitted: an older extension that sends none). `scope`: the site
     * scope the extension reports (`domain` for an approved domain root with Chrome's host permission).
     */
    approve(requestId, { tabId = 1, origin = ORIGIN, level, scope } = {}) {
      return hub.emit({ type: 'lease', requestId, tabId, origin, title: 'Home', ...(level !== undefined ? { level } : {}),
        ...(scope !== undefined ? { scope } : {}) });
    },
  };
  return hub;
}

/** Raw HTTP call to a daemon. Resolves {status, body}. */
export function call(port, method, path, body, { token, headers = {}, host = `127.0.0.1:${port}`, raw } = {}) {
  return new Promise((resolve, reject) => {
    const payload = raw ?? (body === undefined ? null : JSON.stringify(body));
    const requestHeaders = { Host: host, ...headers };
    if (token) requestHeaders.Authorization = `Bearer ${token}`;
    if (payload !== null) {
      requestHeaders['Content-Type'] = 'application/json';
      requestHeaders['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: requestHeaders, agent: false }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          parsed = text;
        }
        resolve({ status: res.statusCode, body: parsed, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.end(payload ?? undefined);
  });
}
