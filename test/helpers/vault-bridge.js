// A SecretBridge that plays the extension worker's part for secret handles (extension/background.js "Secret handles"),
// for flows through the real daemon and MCP server in headless Chromium: it asks page.js for the values it redacts
// (useSecrets vault), numbers page tags once for the whole browser session (so secret:3 stays secret:3 across leases
// and origins, as the worker's vault does), lists the handles on every observation (`secrets`), answers the Approve
// gate (`decide`: 'approved' | 'denied', or a function of the request) with ids it mints, and runs an approved
// fill_secret (the value into page.js with the binding) or copy_secret (into `clipboard`). Values never leave it except
// into page.js. The worker's own code is tested in test/extension-worker.test.js; this helper is test-only.
import { randomUUID } from 'node:crypto';
import { bridgeError } from '../../src/result.js';
import { secretPlaceholder } from '../../src/secrets.js';
import { SecretBridge } from './secret-bridge.js';

const VAULT_KEY = '__faiVault';
const TAG = /\[secret:~([0-9a-z]{1,12})\b/g;

export class VaultBridge extends SecretBridge {
  constructor(page, options = {}) {
    super(page, { ...options, secrets: { vault: true, ...(options.secrets ?? {}) } });
    this.ids = new Map();
    this.vault = new Map();
    this.bindings = new Map();
    this.asked = [];
    this.decide = options.decide ?? 'approved';
    this.clipboard = [];
  }

  /** `value` with page tags numbered for the session, as the worker's numberSecrets does. */
  number(value) {
    if (typeof value === 'string') {
      return value.replace(TAG, (_, tag) => {
        if (!this.ids.has(tag)) this.ids.set(tag, String(this.ids.size + 1));
        return `[secret:${this.ids.get(tag)}`;
      });
    }
    if (Array.isArray(value)) return value.map(item => this.number(item));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.number(item)]));
  }

  /** A page result without its vault hand-over (kept here), numbered, with the handles listed on its observation. */
  take(result) {
    if (!result || typeof result !== 'object') return result;
    const { [VAULT_KEY]: found, ...rest } = result;
    const numbered = this.number(rest);
    for (const item of Array.isArray(found) ? found : []) {
      if (!this.ids.has(item.tag)) this.ids.set(item.tag, String(this.ids.size + 1));
      const handle = this.ids.get(item.tag);
      this.vault.delete(handle);
      this.vault.set(handle, { value: item.value, kind: item.kind, pre: item.pre ?? '', origin: item.origin });
    }
    return numbered;
  }

  withHandles(observation) {
    const secrets = [...this.vault].reverse().slice(0, 10).map(([handle, entry]) => ({ handle, kind: entry.kind, origin: entry.origin,
      label: secretPlaceholder(handle, entry.kind, entry.value, entry.pre) }));
    return secrets.length ? { ...observation, secrets } : observation;
  }

  async observe(signal, options) {
    const observation = this.withHandles(this.take(await super.observe(signal, options)));
    this.observation = observation;
    return observation;
  }

  async approve({ target, revision, cls, kind, handle }) {
    this.asked.push({ target, revision, cls, kind, handle });
    const secretUse = kind === 'fill_secret' || kind === 'copy_secret';
    if (secretUse && !this.vault.has(handle)) return { decision: 'refused', reason: 'unknown_secret' };
    let info = { cls: 'secret', labelHash: '' };
    if (kind !== 'copy_secret') {
      await this.inject();
      const outcome = await this.page.evaluate(([t, r, k]) => Promise.resolve().then(() => __faiPage.approvalInfo(t, r, k))
        .then(value => ({ value }), error => ({ error: { code: error.code, message: error.message } })), [target, revision, kind ?? null]);
      if (outcome.error) throw bridgeError(outcome.error.code ?? 'unsupported', outcome.error.message);
      info = outcome.value;
    }
    if (info.cls !== cls) return { decision: 'refused', reason: 'class_mismatch' };
    const decision = typeof this.decide === 'function' ? this.decide({ target, cls, kind, handle }) : this.decide;
    if (decision !== 'approved') return { decision };
    const approvalId = randomUUID();
    this.bindings.set(approvalId, { target, revision, cls, labelHash: info.labelHash, kind: kind ?? null, handle: handle ?? null });
    return { decision: 'approved', approvalId };
  }

  async execute(action, expectedRevision, options, signal) {
    if (action.approvalId === undefined) {
      if (action.type === 'fill_secret' || action.type === 'copy_secret') throw bridgeError('unsupported', 'Invalid secret action');
      const result = await super.execute(action, expectedRevision, options, signal);
      return { ...result, observation: this.withHandles(this.take(result.observation)) };
    }
    const binding = this.bindings.get(action.approvalId);
    this.bindings.delete(action.approvalId);
    const kind = action.type === 'click' ? null : action.type;
    if (!binding || binding.revision !== expectedRevision || binding.kind !== kind || (binding.handle ?? undefined) !== action.handle
      || (binding.target ?? undefined) !== action.target) {
      throw bridgeError('blocked_risky', 'This action has no approval from the user');
    }
    if (action.type === 'copy_secret') {
      this.clipboard.push(this.vault.get(action.handle).value);
      const observation = await this.observe(signal, { expectText: this.expectText });
      return { observation, settle: { reason: 'none', ms: 0 }, navigated: false, screenshot: Promise.resolve(null) };
    }
    const pageAction = action.type === 'fill_secret'
      ? { type: 'fill_secret', target: action.target, text: this.vault.get(action.handle).value }
      : { type: 'click', target: action.target };
    await this.inject();
    const approval = { target: binding.target, cls: binding.cls, labelHash: binding.labelHash, ...(kind ? { kind } : {}) };
    const outcome = await this.page.evaluate(([a, r, allow, expectText, ap]) => __faiPage.execute(a, r, { quietMs: 50, capMs: 300 }, null,
      [], allow, undefined, expectText, ap).then(value => ({ value }), error => ({ error: { code: error.code, message: error.message } })),
    [pageAction, expectedRevision, this.allow, this.expectText ?? [], approval]);
    if (outcome.error) throw bridgeError(outcome.error.code ?? 'unsupported', outcome.error.message);
    const value = this.take(outcome.value);
    const observation = this.withHandles(value.observation);
    this.observation = observation;
    const fill = value.fill && action.type === 'fill_secret' ? { ...value.fill, holds: `[secret:${action.handle}]` } : value.fill;
    const screenshot = this.offscreen ? this.captureImage().catch(error => ({ error: { code: 'capture_failed', message: error.message } }))
      : Promise.resolve(null);
    return { observation, settle: { reason: value.settle?.reason ?? 'quiet', ms: 0 }, navigated: false, ...(fill ? { fill } : {}), screenshot };
  }
}
