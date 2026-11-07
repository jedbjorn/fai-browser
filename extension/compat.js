'use strict';
// Browser differences, in one place. The Firefox build (scripts/build-firefox.mjs) loads this file first in its
// background event page; the Chromium extension never loads it, so Chrome runs exactly the code it always did.
// Everything here only fills in what is missing (feature detection, never a browser sniff), so the rest of the
// extension keeps calling chrome.* as written.
//
// - chrome.offscreen (Chrome only): Firefox's background is a page with a DOM, so the offscreen document becomes a
//   hidden <iframe src="offscreen.html"> inside it. The same offscreen.js runs there and answers the same
//   runtime 'annotate' message, so screenshot drawing and redaction stay one shared code path.
// - Everything else the extension uses is either in Firefox with the same shape (storage.session, scripting with
//   func/args, action.setPopup/onClicked, windows.create type 'popup', sendNativeMessage, commands, alarms) or is
//   already feature-detected at its call site (tabGroups, action.getUserSettings, storage.local.setAccessLevel).
//   faiCompat.features() reports which of them this browser has, for tests and the smoke.

(() => {
  const api = globalThis.chrome;
  if (!api) return;

  const OFFSCREEN_FRAME_ID = 'fai-offscreen';
  let frame = null;
  let loading = null;

  function offscreenFrame(doc) {
    return frame?.isConnected ? frame : doc.getElementById(OFFSCREEN_FRAME_ID);
  }

  // The offscreen.html frame as an offscreen document: hasDocument once it loaded, createDocument adds it.
  const frameOffscreen = {
    polyfill: true,
    async hasDocument() {
      const doc = globalThis.document;
      return Boolean(doc && offscreenFrame(doc)?.dataset?.ready === 'true');
    },
    createDocument({ url } = {}) {
      const doc = globalThis.document;
      if (!doc?.body && !doc?.documentElement) return Promise.reject(new Error('No document to host the offscreen page'));
      const existing = offscreenFrame(doc);
      if (existing?.dataset?.ready === 'true') return Promise.reject(new Error('Only a single offscreen document may be created.'));
      loading ??= new Promise((resolve, reject) => {
        const node = existing ?? doc.createElement('iframe');
        node.id = OFFSCREEN_FRAME_ID;
        node.hidden = true;
        node.addEventListener('load', () => {
          node.dataset.ready = 'true';
          resolve();
        }, { once: true });
        node.addEventListener('error', () => reject(new Error('The offscreen page did not load')), { once: true });
        if (!existing) {
          node.src = api.runtime.getURL(url || 'offscreen.html');
          (doc.body ?? doc.documentElement).appendChild(node);
        }
        frame = node;
      }).finally(() => {
        loading = null;
      });
      return loading;
    },
  };

  if (!api.offscreen) {
    try {
      api.offscreen = frameOffscreen;
    } catch {
      // A sealed namespace object: background.js then fails captures with capture_failed, nothing else.
    }
  }

  // --- Firefox: activeTab ends at the tab's first navigation -------------------------------------------------
  // Chrome keeps activeTab on a tab until it leaves the origin; Firefox drops it at any navigation, after which the
  // worker can no longer read the tab's URL or run page.js there and pauses the lease (origin_changed). So in the
  // Firefox build the approval click also asks for the request's exact origins as host permissions (a Firefox prompt
  // the first time), and this keeper removes each one it added once no pending, active or paused request needs it.
  // A permission the user granted by hand (the extensions panel) is never added here, so never removed.
  // Firefox match patterns take no port: http://127.0.0.1:8080 is asked for as http://127.0.0.1/*.
  const geckoBuild = Boolean(api.runtime?.getManifest?.()?.browser_specific_settings?.gecko);
  const EXPECTED_KEY = 'compatExpectedOrigins'; // storage.session {pattern: at}: just asked for by an approval click
  const GRANTED_KEY = 'compatGrantedOrigins'; // storage.local [pattern]: added by such a click, removed by the keeper
  const EXPECT_MS = 5 * 60_000;
  const LIVE_STATES = new Set(['pending', 'active', 'paused']);

  /** The host permission pattern for an exact http(s) origin ("https://a.example:8443" -> "https://a.example/*"). */
  function originPattern(origin) {
    try {
      const url = new URL(origin);
      if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) return null;
      return `${url.protocol}//${url.hostname}/*`;
    } catch {
      return null;
    }
  }

  /** The patterns for a request's exact origins (domain roots "https://*.<root>" have their own prompt). */
  function requestPatterns(request) {
    const origins = Array.isArray(request?.origins) ? request.origins : [];
    return [...new Set(origins.filter(origin => typeof origin === 'string' && !origin.includes('*'))
      .map(originPattern).filter(Boolean))];
  }

  const cache = { requests: [], armedTabs: [], loaded: false };
  const expected = new Map();

  function expect(patterns) {
    const now = Date.now();
    for (const pattern of patterns) expected.set(pattern, now);
    try {
      api.storage.session.get([EXPECTED_KEY]).then(saved => {
        const next = { ...(saved?.[EXPECTED_KEY] ?? {}) };
        for (const pattern of patterns) next[pattern] = now;
        return api.storage.session.set({ [EXPECTED_KEY]: next });
      }).catch(() => {});
    } catch {
      // No storage.session: the in-memory list still covers this page's lifetime.
    }
  }

  // The approval click on an armed tab (the only tabs without a popup, so the only clicks that reach onClicked). It
  // must ask synchronously, inside the click, for Firefox to count it as user input; compat.js is loaded first, so
  // this listener runs before the worker's.
  let clickAccess = null;
  function askOnClick(tab) {
    clickAccess = null;
    const arm = cache.armedTabs.find(item => item?.tabId === tab?.id);
    const request = arm ? cache.requests.find(item => item?.requestId === arm.requestId) : null;
    let patterns = request ? requestPatterns(request) : [];
    // Not loaded yet (the click woke the background): at least the clicked page's own origin.
    if (!patterns.length && !cache.loaded && typeof tab?.url === 'string') {
      let own = null;
      try {
        own = originPattern(new URL(tab.url).origin);
      } catch {
        own = null;
      }
      patterns = own ? [own] : [];
    }
    if (!patterns.length || !api.permissions?.request) return;
    expect(patterns);
    clickAccess = { tabId: tab.id, promise: api.permissions.request({ origins: patterns }).catch(() => false) };
  }

  async function track(added) {
    const saved = await api.storage.session?.get?.([EXPECTED_KEY]).catch(() => ({})) ?? {};
    const now = Date.now();
    const asked = pattern => {
      const at = expected.get(pattern) ?? saved?.[EXPECTED_KEY]?.[pattern];
      return Number.isFinite(at) && now - at < EXPECT_MS;
    };
    const mine = added.filter(asked);
    if (!mine.length) return;
    const local = await api.storage.local.get([GRANTED_KEY]);
    const list = Array.isArray(local[GRANTED_KEY]) ? local[GRANTED_KEY] : [];
    await api.storage.local.set({ [GRANTED_KEY]: [...new Set([...list, ...mine])].slice(-100) });
    await reconcile();
  }

  let reconciling = Promise.resolve();
  function reconcile() {
    reconciling = reconciling.then(async () => {
      if (!cache.loaded || !api.permissions?.remove) return;
      const local = await api.storage.local.get([GRANTED_KEY]);
      const granted = Array.isArray(local[GRANTED_KEY]) ? local[GRANTED_KEY] : [];
      if (!granted.length) return;
      const live = new Set(cache.requests.filter(item => LIVE_STATES.has(item?.state)).flatMap(requestPatterns));
      const drop = granted.filter(pattern => !live.has(pattern));
      if (!drop.length) return;
      await api.permissions.remove({ origins: drop }).catch(() => false);
      await api.storage.local.set({ [GRANTED_KEY]: granted.filter(pattern => live.has(pattern)) });
    }).catch(() => {});
    return reconciling;
  }

  if (geckoBuild && api.action?.onClicked && api.storage?.session) {
    api.action.onClicked.addListener(askOnClick);
    api.permissions?.onAdded?.addListener?.(added => { track(added?.origins ?? []).catch(() => {}); });
    api.storage.onChanged.addListener((changes, area) => {
      if (area !== 'session') return;
      if (changes.armedTabs) cache.armedTabs = Array.isArray(changes.armedTabs.newValue) ? changes.armedTabs.newValue : [];
      if (changes.requests) {
        cache.requests = Array.isArray(changes.requests.newValue) ? changes.requests.newValue : [];
        cache.loaded = true;
        ignoreError(reconcile());
      }
    });
    api.storage.session.get(['requests', 'armedTabs']).then(saved => {
      if (!cache.loaded) cache.requests = Array.isArray(saved?.requests) ? saved.requests : [];
      cache.armedTabs = Array.isArray(saved?.armedTabs) ? saved.armedTabs : cache.armedTabs;
      cache.loaded = true;
    }).catch(() => {});
  }

  function ignoreError(promise) {
    promise?.catch?.(() => {});
  }

  globalThis.faiCompat = {
    originPattern,
    requestPatterns,
    // The worker awaits this same toolbar gesture instead of opening a duplicate Firefox permission prompt.
    approvalAccess(tabId) { return clickAccess?.tabId === tabId ? clickAccess.promise : null; },
    reconcile,
    EXPECTED_KEY,
    GRANTED_KEY,
    /** What this browser offers of the APIs the extension feature-detects (true/false each). */
    features() {
      return {
        offscreen: Boolean(api.offscreen) && !api.offscreen.polyfill,
        offscreenFrame: api.offscreen?.polyfill === true,
        tabGroups: Boolean(api.tabGroups && api.tabs?.group),
        storageSession: Boolean(api.storage?.session),
        userSettings: typeof api.action?.getUserSettings === 'function',
        nativeMessaging: typeof api.runtime?.sendNativeMessage === 'function',
        domBackground: typeof globalThis.document !== 'undefined',
      };
    },
  };
})();
