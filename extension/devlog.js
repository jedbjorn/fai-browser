'use strict';
// Test site only: the extension-world half of the dev-log hook (extension/devhook.js runs in the page's world). It
// keeps what the hook reports since the last read, at most MAX_ENTRIES (older ones are counted, then dropped), and
// the last JavaScript dialog; page.js observe() takes them (globalThis.__faiDevLog.drain()). It also forwards the
// agent's armed dialog answer to the hook (arm()). Registered and injected only with devhook.js.
(() => {
  if (globalThis.__faiDevLog) return;
  const MAX_ENTRIES = 50;
  const KINDS = new Set(['error', 'warning', 'exception', 'rejection', 'network']);
  const DIALOGS = new Set(['alert', 'confirm', 'prompt']);
  let entries = [];
  let dropped = 0;
  let dialog = null;
  const str = (value, limit) => (typeof value === 'string' ? value.slice(0, limit) : '');

  window.addEventListener('fai:devlog', event => {
    let entry = null;
    try {
      entry = JSON.parse(String(event.detail ?? ''));
    } catch {
      return;
    }
    if (!entry || typeof entry !== 'object') return;
    if (entry.kind === 'dialog' && DIALOGS.has(entry.dialog)) {
      dialog = { kind: entry.dialog, text: str(entry.text, 500), answered: entry.answered === 'accept' ? 'accept' : 'dismiss' };
      return;
    }
    if (!KINDS.has(entry.kind)) return;
    const clean = { kind: entry.kind, text: str(entry.text, 500) };
    if (entry.kind === 'network') {
      clean.method = str(entry.method, 10).toUpperCase();
      clean.url = str(entry.url, 500);
      if (Number.isInteger(entry.status)) clean.status = entry.status;
    }
    entries.push(clean);
    if (entries.length > MAX_ENTRIES) {
      dropped += entries.length - MAX_ENTRIES;
      entries = entries.slice(-MAX_ENTRIES);
    }
  });

  globalThis.__faiDevLog = {
    /** The entries and the last dialog since the last drain, then empty. */
    drain() {
      const out = { logs: entries, dropped, dialog };
      entries = [];
      dropped = 0;
      dialog = null;
      return out;
    },
    /** The last dialog since the last read, then none (each is reported once). */
    takeDialog() {
      const out = dialog;
      dialog = null;
      return out;
    },
    /** The answer the page's next confirm or prompt gets (once, within 60 s). */
    arm(answer, text) {
      const detail = JSON.stringify({ answer, ...(typeof text === 'string' ? { text } : {}) });
      window.dispatchEvent(new CustomEvent('fai:dialog-answer', { detail }));
    },
  };
})();
