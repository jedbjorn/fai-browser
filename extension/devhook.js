'use strict';
// Test site only (docs/REFERENCE.md "Dev logs and JavaScript dialogs"): the page-world hook, registered by the worker
// at document_start for a session granted at testing on origins the user listed under Test sites, and injected into
// the page already open then. Nothing registers it at any other level.
//
// It runs in the page's own JavaScript world, so the page can see it (wrapped console methods, fetch,
// XMLHttpRequest, alert, confirm and prompt) and can forge what it reports: everything it reports is untrusted page
// content, and it is acceptable only on the user's own test sites. It reports, as `fai:devlog` events on window with
// a JSON string detail (read by extension/devlog.js in the extension's isolated world):
// - console.error and console.warn calls, uncaught errors and unhandled promise rejections (message text only);
// - fetch and XMLHttpRequest responses with status >= 400 or a network failure: method, URL without its query or
//   fragment, status (never a request or response body, never headers);
// - alert, confirm and prompt: kind and message. They never block: each is answered at once with the answer the
//   agent armed (`fai:dialog-answer`, JSON {answer, text?}: once, within 60 s), else dismissed (confirm false, prompt null), so the page
//   never stops answering the extension while a native dialog would be open.
(() => {
  if (window.__faiDevHook) return;
  Object.defineProperty(window, '__faiDevHook', { value: true });
  const MAX_TEXT = 500;
  const ARM_MS = 60_000;
  const post = entry => {
    try {
      window.dispatchEvent(new CustomEvent('fai:devlog', { detail: JSON.stringify(entry) }));
    } catch {
      // A page that broke CustomEvent or JSON gets no logs.
    }
  };
  const textOf = value => {
    try {
      if (value instanceof Error) return `${value.name}: ${value.message}`;
      if (typeof value === 'string') return value;
      return JSON.stringify(value) ?? String(value);
    } catch {
      return String(value);
    }
  };
  const clip = text => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
  const bareUrl = raw => {
    try {
      const url = new URL(String(raw), location.href);
      return `${url.origin}${url.pathname}${url.search ? '?…' : ''}`;
    } catch {
      return '';
    }
  };

  for (const [method, kind] of [['error', 'error'], ['warn', 'warning']]) {
    const original = console[method];
    if (typeof original !== 'function') continue;
    console[method] = function (...args) {
      post({ kind, text: clip(args.map(textOf).join(' ')) });
      return original.apply(this, args);
    };
  }
  window.addEventListener('error', event => {
    if (event.error || event.message) post({ kind: 'exception', text: clip(event.error ? textOf(event.error) : event.message) });
  });
  window.addEventListener('unhandledrejection', event => post({ kind: 'rejection', text: clip(textOf(event.reason)) }));

  const fetchOriginal = window.fetch;
  if (typeof fetchOriginal === 'function') {
    window.fetch = function (input, init) {
      const method = String(init?.method ?? input?.method ?? 'GET').toUpperCase().slice(0, 10);
      const url = bareUrl(input?.url ?? input);
      return fetchOriginal.apply(this, arguments).then(response => {
        if (response.status >= 400) post({ kind: 'network', method, url, status: response.status, text: clip(response.statusText) });
        return response;
      }, error => {
        post({ kind: 'network', method, url, status: 0, text: clip(textOf(error)) });
        throw error;
      });
    };
  }
  const xhrOpen = XMLHttpRequest.prototype.open;
  const xhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__faiRequest = { method: String(method ?? 'GET').toUpperCase().slice(0, 10), url: bareUrl(url) };
    return xhrOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    const request = this.__faiRequest;
    if (request) {
      this.addEventListener('loadend', () => {
        if (this.status === 0 || this.status >= 400) post({ kind: 'network', ...request, status: this.status, text: clip(this.statusText) });
      });
    }
    return xhrSend.apply(this, arguments);
  };

  let armed = null;
  window.addEventListener('fai:dialog-answer', event => {
    let detail = null;
    try {
      detail = JSON.parse(String(event.detail ?? ''));
    } catch {
      detail = null;
    }
    armed = ['accept', 'dismiss'].includes(detail?.answer)
      ? { answer: detail.answer, text: typeof detail.text === 'string' ? detail.text.slice(0, 5000) : null, until: Date.now() + ARM_MS }
      : null;
  });
  const answerFor = () => {
    const current = armed && Date.now() <= armed.until ? armed : { answer: 'dismiss', text: null };
    armed = null;
    return current;
  };
  window.alert = function (message) {
    post({ kind: 'dialog', dialog: 'alert', text: clip(message), answered: 'accept' });
    armed = null;
  };
  window.confirm = function (message) {
    const { answer } = answerFor();
    post({ kind: 'dialog', dialog: 'confirm', text: clip(message), answered: answer });
    return answer === 'accept';
  };
  window.prompt = function (message, value) {
    const { answer, text } = answerFor();
    post({ kind: 'dialog', dialog: 'prompt', text: clip(message), answered: answer });
    return answer === 'accept' ? (text ?? String(value ?? '')) : null;
  };
})();
