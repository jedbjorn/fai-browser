'use strict';
// Approved cross-origin frames (docs/REFERENCE.md "Frames"), for the service worker. Loaded before background.js
// (importScripts in Chromium, a background script in the Firefox build) and run in the same global scope: the
// functions below use the worker's session, page calls, redaction and errors at call time. Without this file the
// worker behaves as before (every cross-origin frame unread, the plain cross_origin_frame warning).
//
// page.js never reads a cross-origin frame. It lists each one it sees as a slot (its path in window.frames, its box
// in the top viewport, the origin its element names). Here the worker asks the browser which frames the extension
// can reach (one executeScript with allFrames: a probe that returns each frame's own origin and path, nothing else),
// and reads a frame only when its origin is one the request approved (an exact origin of the lease, the tab's origin,
// or with domain scope an https origin under an approved root) and every frame above it was read as well. It runs the
// same page.js there (pinned to that frame), with the page context of the other documents (a purchase page, a
// password or payment field, a credentials page anywhere in the tab restricts every document), and merges the
// frame's blocks, text and controls into the observation: control ids become `f<n>.<id>`, bounds move into the top
// viewport, `frame` names the frame (`f<n>`) and `frameOrigin` its origin. Frames it could not read are named in
// `frames` [{origin, read: false, reason}] with the plain cross_origin_frame warning; their content is never read.
//
// The observation's revision then stands for the top document and every frame read: `<top revision>.<n>`, mapped
// here to its parts, so an act on a frame control runs in that frame on that frame's revision (page.js checks it)
// after the frame's current origin was probed again, and an act on a top control runs on the top revision.
(() => {
  const FRAME_READ_MAX = 8;
  const FRAME_DEPTH_MAX = 4;
  const FRAME_TEXT_TOTAL = 12_000;
  const FRAME_BLOCKS_MAX = 200;
  const FRAME_CONTROLS_MAX = 100;
  const FRAME_CONTROLS_SHARE = 50;
  const FRAME_UNREAD_MAX = 8;
  const FRAME_LOAD_CAP_MS = 3_000;
  const FRAME_REDACT_MS = 2_000;
  const COMPOSITES_MAX = 32;
  const FRAME_TARGET = /^f([1-9])\.(\d{1,3})$/;
  const ORIGIN = /^https?:\/\/[^/\s?#]+$/;
  // executeScript refusals that happen before the script runs (the target is gone or out of reach).
  const NOT_STARTED = /No document with id|No frame with id|Cannot access|Missing host permission|showing error page/i;
  // How far a frame may have moved (CSS px) between two looks and still count as in place.
  const MOVE_TOLERANCE_PX = 2;

  // Per tab: { context, frames (the read frames of the last merged observation), composites: Map revision -> parts }.
  const states = new Map();
  let sequence = 0;

  function stateOf(tabId) {
    let state = states.get(tabId);
    if (!state) {
      state = { context: null, frames: [], composites: new Map() };
      states.set(tabId, state);
      while (states.size > 8) states.delete(states.keys().next().value);
    }
    return state;
  }

  // Runs in every frame the extension can reach: its own origin and its path from the top window, nothing else.
  // Must not reference anything outside itself (chrome.scripting serializes it).
  function frameProbe() {
    const path = [];
    let view = window;
    try {
      while (view !== view.top) {
        if (path.length >= 4) return null;
        const parent = view.parent;
        let index = -1;
        for (let i = 0; i < Math.min(parent.length, 200); i++) {
          if (parent[i] === view) {
            index = i;
            break;
          }
        }
        if (index < 0) return null;
        path.unshift(index);
        view = parent;
      }
    } catch {
      return null;
    }
    return { origin: location.origin, opaque: window.origin === 'null', path, ready: document.readyState,
      page: Boolean(globalThis.__faiPage), width: innerWidth, height: innerHeight };
  }

  /** The request's exact origins (and the tab's) as page.js gets them for link checks in a frame. */
  function exactOrigins() {
    const list = [session?.origin, ...(Array.isArray(session?.origins) ? session.origins : [])];
    return [...new Set(list.filter(entry => typeof entry === 'string' && ORIGIN.test(entry) && !entry.includes('*')))].slice(0, 20);
  }

  /** True when a frame at `origin` may be read: the tab's origin, an exact origin of the lease, or under a root. */
  function frameApproved(origin) {
    if (!session || typeof origin !== 'string' || !ORIGIN.test(origin)) return false;
    if (exactOrigins().includes(origin)) return true;
    return session.scope === 'domain' && originCovered(origin, session.sites ?? []);
  }

  // Whether anything but the tab's own origin could be approved (else no probe is needed: every frame stays unread).
  function anyFrameApprovable() {
    return exactOrigins().some(origin => origin !== session?.origin) || (session?.scope === 'domain' && (session.sites ?? []).length > 0);
  }

  async function probeFrames(tabId, frameIds = null) {
    try {
      const target = frameIds ? { tabId, frameIds } : { tabId, allFrames: true };
      const results = await chrome.scripting.executeScript({ target, func: frameProbe });
      return (Array.isArray(results) ? results : []).filter(item => Number.isInteger(item?.frameId) && item.frameId !== 0
        && item.result && typeof item.result.origin === 'string' && Array.isArray(item.result.path) && item.result.path.length);
    } catch {
      return [];
    }
  }

  /** The page context a document of the tab is sent with: the union of the others' facts. */
  function topContext(tabId) {
    const context = states.get(tabId)?.context;
    return context ? { ...context } : null;
  }

  function frameContext(tabId) {
    return { purchase: false, sensitive: false, secretPage: false, ...(states.get(tabId)?.context ?? {}), frame: true,
      topOrigin: session?.origin ?? null, origins: exactOrigins() };
  }

  // One page.js call inside a frame: pinned to its document where the browser has document ids (Chromium), else to
  // its frame id (page.js then checks its own origin and revision). A fresh document is probed before page.js goes in.
  async function callFrame(tabId, frame, method, args, context = frameContext(tabId)) {
    const secrets = { ...secretOptions(), context };
    const target = frame.documentId ? { tabId, documentIds: [frame.documentId] } : { tabId, frameIds: [frame.frameId] };
    // The browser refusing the injection itself (the document or frame is gone, no access) means nothing ran: never a
    // navigation the act started (execute re-probes the frame to say what happened).
    const script = details => chrome.scripting.executeScript(details).catch(error => {
      if (NOT_STARTED.test(String(error?.message ?? error))) {
        throw new ExtensionError('target_unavailable', 'The frame document is gone', { notStarted: true });
      }
      throw error;
    });
    const run = () => script({ target, func: pageCall, args: [method, args, secrets] });
    let [injection] = await run();
    if (injection?.result?.missing) {
      const [probe] = await probeFrames(tabId, [frame.frameId]);
      if (!probe || probe.result.origin !== frame.origin || !frameApproved(probe.result.origin)) {
        throw new ExtensionError('cross_origin', 'The frame left the approved origins; observe again', { notStarted: true });
      }
      await script({ target, files: ['input.js', 'page.js'] });
      [injection] = await run();
    }
    const outcome = injection?.result;
    if (outcome?.error) throw new ExtensionError(outcome.error.code, numberSecrets(outcome.error.message));
    if (!outcome?.value) throw new ExtensionError('unsupported', 'Frame returned no result', { teardown: true });
    if (typeof outcome.value === 'object' && Object.hasOwn(outcome.value, VAULT_KEY)) {
      const { [VAULT_KEY]: found, ...rest } = outcome.value;
      const numbered = numberSecrets(rest);
      vaultFound(found);
      return numbered;
    }
    return numberSecrets(outcome.value);
  }

  const pathKey = path => path.join('.');
  const startsWith = (path, prefix) => path.length > prefix.length && prefix.every((step, i) => path[i] === step);
  // The frame a probe found has the size of the slot page.js saw at that path (a frame that was reordered or swapped
  // between the two looks does not), within MOVE_TOLERANCE_PX.
  const sameSize = (probe, slot) => [[probe.result.width, slot.width], [probe.result.height, slot.height]]
    .every(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= MOVE_TOLERANCE_PX);
  const cleanOrigin = origin => (typeof origin === 'string' && ORIGIN.test(origin) ? reportedUrl(origin) : null);
  const facts = observation => ({
    purchase: observation?.pageFacts?.purchase === true,
    sensitive: observation?.pageFacts?.sensitive === true,
    secretPage: observation?.pageFacts?.secretPage === true,
  });
  const FACT_KEYS = ['purchase', 'sensitive', 'secretPage'];
  const union = list => ({
    purchase: list.some(item => item.purchase), sensitive: list.some(item => item.sensitive), secretPage: list.some(item => item.secretPage),
  });

  function strip(observation) {
    if (!observation || typeof observation !== 'object') return observation;
    const { frameSlots: _slots, pageFacts: _facts, ...rest } = observation;
    return rest;
  }

  function intersect(a, b) {
    return { left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) };
  }

  // A slot reported by a document read at offset (dx, dy) inside `clip`, in top-viewport px.
  function placeSlot(slot, offset) {
    const box = slot?.box;
    const clip = slot?.clip;
    if (!box || !clip || !Array.isArray(slot.path) || !slot.path.every(Number.isInteger)) return null;
    const numbers = [box.x, box.y, box.width, box.height, clip.left, clip.top, clip.right, clip.bottom];
    if (!numbers.every(Number.isFinite)) return null;
    const shifted = { left: clip.left + offset.dx, top: clip.top + offset.dy, right: clip.right + offset.dx, bottom: clip.bottom + offset.dy };
    return {
      path: slot.path.slice(0, FRAME_DEPTH_MAX + 1),
      dx: box.x + offset.dx,
      dy: box.y + offset.dy,
      clip: offset.clip ? intersect(shifted, offset.clip) : shifted,
      width: box.width,
      height: box.height,
      declared: typeof slot.declared === 'string' ? slot.declared : null,
    };
  }

  // Reads the approved frames under `top` (page.js's observation of the top document). `options` are observe()'s
  // ({terms, forbid, allow, sites, expectText}); `retop` observes the top document again with a new context.
  async function readFrames(tabId, top, options, retop) {
    const state = stateOf(tabId);
    const unread = [];
    const read = [];
    const slots = (Array.isArray(top.frameSlots) ? top.frameSlots : []).map(slot => placeSlot(slot, { dx: 0, dy: 0, clip: null }))
      .filter(Boolean);
    if (!slots.length) return { top, read, unread };
    const probes = anyFrameApprovable() ? await probeFrames(tabId) : [];
    const byPath = new Map(probes.map(item => [pathKey(item.result.path), item]));
    let level = slots;
    const seen = new Set();
    while (level.length) {
      const next = [];
      const reading = [];
      for (const slot of level) {
        const key = pathKey(slot.path);
        if (seen.has(key)) continue;
        seen.add(key);
        const probe = byPath.get(key);
        const origin = probe ? probe.result.origin : slot.declared;
        if (!probe) {
          // Only the frame element's src names this origin (page-provided): `declared`.
          unread.push({ origin, reason: origin && frameApproved(origin) ? 'no_access' : 'not_approved', declared: true });
        } else if (probe.result.opaque) {
          unread.push({ origin, reason: 'sandboxed' });
        } else if (!frameApproved(origin)) {
          unread.push({ origin, reason: 'not_approved' });
        } else if (!sameSize(probe, slot)) {
          // The frame at this path is not the one page.js placed there (the page moved its frames in between).
          unread.push({ origin, reason: 'unavailable' });
        } else if (slot.path.length > FRAME_DEPTH_MAX || read.length + reading.length >= FRAME_READ_MAX) {
          unread.push({ origin, reason: 'limit' });
        } else {
          reading.push({ slot, frame: { frameId: probe.frameId, documentId: typeof probe.documentId === 'string' ? probe.documentId : null,
            origin, path: slot.path, dx: slot.dx, dy: slot.dy, clip: slot.clip } });
        }
      }
      const observed = await Promise.all(reading.map(({ frame }) => callFrame(tabId, frame, 'observe', [options]).then(
        observation => ({ frame, observation }),
        () => ({ frame, observation: null }))));
      for (const { frame, observation } of observed) {
        if (!observation || typeof observation !== 'object' || !Array.isArray(observation.controls)) {
          unread.push({ origin: frame.origin, reason: 'unavailable' });
          continue;
        }
        frame.n = read.length + 1;
        read.push({ frame, observation });
        for (const slot of Array.isArray(observation.frameSlots) ? observation.frameSlots : []) {
          const placed = placeSlot(slot, { dx: frame.dx, dy: frame.dy, clip: frame.clip });
          // A frame only reports frames below itself.
          if (placed && startsWith(placed.path, frame.path)) next.push(placed);
        }
      }
      level = next;
    }
    // One page context for the whole tab: the union of every document's own facts. A document read with less than
    // that is read again with it (own facts do not depend on the context, so once is enough).
    const all = union([facts(top), ...read.map(item => facts(item.observation))]);
    const before = state.context ?? union([]);
    state.context = all;
    // A document read with another context than the tab's (a fact it lacked, or one that no longer holds anywhere) is
    // read again: what applied to it is its own facts or the context's.
    const lacking = own => FACT_KEYS.some(key => (own[key] || before[key]) !== (own[key] || all[key]));
    let current = top;
    if (lacking(facts(top))) current = (await retop().catch(() => null)) ?? top;
    for (const item of read) {
      if (!lacking(facts(item.observation))) continue;
      const again = await callFrame(tabId, item.frame, 'observe', [options]).catch(() => null);
      if (again && Array.isArray(again.controls)) item.observation = again;
    }
    state.topFacts = facts(current);
    for (const item of read) item.frame.facts = facts(item.observation);
    return { top: current, read, unread };
  }

  function inViewport(rect, viewport) {
    return rect.right > 0 && rect.bottom > 0 && rect.left < (viewport?.width ?? Infinity) && rect.top < (viewport?.height ?? Infinity);
  }

  // The merged observation: the top document's, with each read frame's blocks, text and controls added.
  function merge(tabId, top, read, unread) {
    const state = stateOf(tabId);
    const out = { ...top };
    const viewport = top.viewport;
    const frameBlocks = [];
    const frameControls = [];
    let text = String(top.text ?? '');
    let textTruncated = top.textTruncated === true;
    const found = new Set(Array.isArray(top.textFound) ? top.textFound : []);
    const warnings = new Set((Array.isArray(top.warnings) ? top.warnings : []).filter(code => code !== 'cross_origin_frame'));
    let consent = top.consent ?? null;
    let overlay = top.overlay ?? null;
    for (const { frame, observation } of read) {
      const id = local => `f${frame.n}.${local}`;
      const shown = frame.clip.right > frame.clip.left && frame.clip.bottom > frame.clip.top && inViewport(frame.clip, viewport);
      const own = String(observation.text ?? '');
      if (shown && own) {
        const room = FRAME_TEXT_TOTAL - text.length - 2;
        if (room > 0) text = `${text}${text ? '\n\n' : ''}${own.slice(0, room)}`;
        if (room < own.length) textTruncated = true;
      }
      if (observation.textTruncated) textTruncated = true;
      for (const entry of Array.isArray(observation.textFound) && shown ? observation.textFound : []) found.add(entry);
      for (const code of Array.isArray(observation.warnings) ? observation.warnings : []) {
        if (code !== 'cross_origin_frame') warnings.add(code);
      }
      for (const block of Array.isArray(observation.blocks) ? observation.blocks : []) {
        const copy = { ...block };
        if (copy.ref !== undefined) copy.ref = id(copy.ref);
        if (!shown) copy.offscreen = true;
        frameBlocks.push(copy);
      }
      for (const control of observation.controls) {
        const copy = { ...control, id: id(control.id), frame: `f${frame.n}`, frameOrigin: reportedUrl(frame.origin),
          frameDepth: frame.path.length };
        const bounds = control.bounds;
        if (bounds && [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) {
          copy.bounds = { x: bounds.x + frame.dx, y: bounds.y + frame.dy, width: bounds.width, height: bounds.height };
          const rect = { left: copy.bounds.x, top: copy.bounds.y, right: copy.bounds.x + bounds.width, bottom: copy.bounds.y + bounds.height };
          const visible = rect.right > frame.clip.left && rect.left < frame.clip.right && rect.bottom > frame.clip.top
            && rect.top < frame.clip.bottom && inViewport(rect, viewport);
          if (!visible) copy.offscreen = true;
        }
        frameControls.push(copy);
      }
      if (!consent && observation.consent && Array.isArray(observation.consent.buttons)) {
        consent = { ...observation.consent, buttons: observation.consent.buttons.map(button => ({ ...button, id: id(button.id) })) };
      }
      if (!overlay && observation.overlay && typeof observation.overlay === 'object') {
        // Its close buttons route to the frame; Escape and a backdrop click (dismiss_overlay) would go to the top
        // document, so a frame's popup offers neither.
        const { escape: _escape, backdrop: _backdrop, ...rest } = observation.overlay;
        overlay = { ...rest, closers: (Array.isArray(rest.closers) ? rest.closers : []).map(closer => ({ ...closer, id: id(closer.id) })) };
      }
    }
    // Controls: the frames get up to half of the cap (more when the top document leaves room), in-view first.
    const topControls = Array.isArray(top.controls) ? top.controls : [];
    const ranked = [...frameControls.filter(control => !control.offscreen), ...frameControls.filter(control => control.offscreen)];
    const frameShare = Math.min(ranked.length, Math.max(FRAME_CONTROLS_SHARE, FRAME_CONTROLS_MAX - topControls.length));
    const topShare = Math.min(topControls.length, FRAME_CONTROLS_MAX - frameShare);
    out.controls = [...topControls.slice(0, topShare), ...ranked.slice(0, frameShare)];
    const dropped = (topControls.length - topShare) + (ranked.length - frameShare);
    if (dropped > 0) {
      out.controlsDropped = (Number(top.controlsDropped) || 0) + dropped;
      warnings.add('controls_capped');
    }
    // Blocks: the top document's first (their indexes stay valid for its records), then the frames', within the cap.
    const topBlocks = Array.isArray(top.blocks) ? top.blocks : [];
    const blockShare = Math.min(frameBlocks.length, Math.max(FRAME_BLOCKS_MAX - topBlocks.length, Math.floor(FRAME_BLOCKS_MAX / 2)));
    const keepTop = Math.min(topBlocks.length, FRAME_BLOCKS_MAX - blockShare);
    out.blocks = [...topBlocks.slice(0, keepTop), ...frameBlocks.slice(0, blockShare)];
    if (keepTop < topBlocks.length || blockShare < frameBlocks.length) out.blocksTruncated = true;
    if (keepTop < topBlocks.length && Array.isArray(out.records)) {
      out.records = out.records.map(record => (Array.isArray(record.blocks) ? { ...record, blocks: record.blocks.filter(index => index < keepTop) } : record));
    }
    out.text = text;
    out.textTruncated = textTruncated;
    if (found.size) out.textFound = [...found];
    out.consent = consent;
    if (overlay) out.overlay = overlay;
    const listed = [];
    for (const { frame } of read) listed.push({ id: `f${frame.n}`, origin: reportedUrl(frame.origin), read: true });
    const named = new Set();
    for (const entry of unread) {
      const origin = cleanOrigin(entry.origin);
      const key = `${origin}|${entry.reason}|${entry.declared === true}`;
      if (named.has(key) || listed.length >= FRAME_READ_MAX + FRAME_UNREAD_MAX) continue;
      named.add(key);
      listed.push({ origin, read: false, reason: entry.reason, ...(entry.declared ? { declared: true } : {}) });
    }
    if (unread.length) warnings.add('cross_origin_frame');
    out.warnings = [...warnings];
    if (listed.length) out.frames = listed;
    // The revision: the top document's when no frame was read; else one that stands for all of them.
    if (read.length) {
      const key = [top.revision, ...read.map(({ frame, observation }) => `${frame.n}:${frame.frameId}:${observation.revision}`)].join('|');
      let composite = null;
      for (const [revision, parts] of state.composites) if (parts.key === key) composite = revision;
      if (!composite) {
        composite = `${top.revision}.${++sequence}`;
        state.composites.set(composite, { key, top: top.revision, topFacts: { ...(state.topFacts ?? facts(top)) },
          frames: new Map(read.map(({ frame, observation }) => [frame.n, { ...frame, revision: observation.revision }])) });
        while (state.composites.size > COMPOSITES_MAX) state.composites.delete(state.composites.keys().next().value);
      }
      out.revision = composite;
    }
    state.frames = read.map(({ frame }) => ({ ...frame }));
    return out;
  }

  /**
   * The observation `value` (page.js's observe, or the `observation` of settleAndObserve or an in-place execute) with
   * the approved frames of the tab merged in. `options` are the observe() options of that call.
   */
  async function withFrames(tabId, value, options = {}) {
    const holder = value && typeof value === 'object' && value.observation && typeof value.observation === 'object' ? value : null;
    const top = holder ? holder.observation : value;
    if (!top || typeof top !== 'object' || !Array.isArray(top.controls)) return value;
    const state = stateOf(tabId);
    if (!Array.isArray(top.frameSlots) || !top.frameSlots.length) {
      state.frames = [];
      if (state.context && !top.pageFacts) state.context = null;
      return holder ? { ...holder, observation: strip(top) } : strip(top);
    }
    const retop = () => callPage(tabId, 'observe', [options]);
    const { top: current, read, unread } = await readFrames(tabId, top, options, retop);
    const merged = strip(merge(tabId, current, read, unread));
    return holder ? { ...holder, observation: merged } : merged;
  }

  /** The observe-shaped options of a page call (observe's object, or settleAndObserve's positional arguments). */
  function optionsOf(method, args) {
    if (method === 'observe') return args?.[0] && typeof args[0] === 'object' ? args[0] : {};
    if (method === 'settleAndObserve') {
      const [, terms, forbid, allow, sites, expectText] = args ?? [];
      return { terms, forbid, allow, sites, expectText };
    }
    return {};
  }

  /** The top document's observation, with the approved frames: what a capture checks its revision against. */
  async function observeTab(tabId) {
    return withFrames(tabId, await callPage(tabId, 'observe'), {});
  }

  // What an expected revision means: { top, frame? } for an action on `target` (a frame control `f<n>.<id>`, a top
  // control, or none). A frame target on a revision this worker does not know (or no longer has) is stale.
  function resolve(tabId, expectedRevision, target) {
    const parts = states.get(tabId)?.composites.get(expectedRevision) ?? null;
    const match = typeof target === 'string' ? FRAME_TARGET.exec(target) : null;
    if (!match) return { top: parts ? parts.top : expectedRevision, frame: null };
    const frame = parts?.frames.get(Number(match[1]));
    if (!frame) throw new ExtensionError('stale', 'Stale observation: the frame changed since the decision');
    return { top: parts.top, frame, local: match[2] };
  }

  // The frame of an act, probed again now: still there, on the same document where the browser says so, on an
  // approved origin. Else nothing runs: cross_origin (the frame left the approved origins or is gone) or stale (it
  // shows another approved document).
  async function recheckFrame(tabId, frame) {
    const [probe] = await probeFrames(tabId, [frame.frameId]);
    if (!probe || pathKey(probe.result.path) !== pathKey(frame.path)) {
      throw new ExtensionError('cross_origin', 'The frame is gone or left the approved origins; observe again');
    }
    if (probe.result.opaque || !frameApproved(probe.result.origin)) {
      throw new ExtensionError('cross_origin', 'The frame moved to an origin this request does not approve');
    }
    if (probe.result.origin !== frame.origin || (frame.documentId && probe.documentId && probe.documentId !== frame.documentId)) {
      throw new ExtensionError('stale', 'Stale observation: the frame shows another page since the decision');
    }
  }

  // The page context from the documents' current own facts: `top` (the top document's), and each frame's from
  // `frames` (a Map n -> facts) or, for a frame not looked at again, the facts it had when it was read.
  function setContext(tabId, parts, top, frames = new Map()) {
    const state = stateOf(tabId);
    const list = [top, ...[...parts.frames.values()].map(frame => frames.get(frame.n) ?? frame.facts ?? union([]))];
    state.context = union(list);
  }

  // Before anything runs in a frame: the top document must still be the page the decision saw (its revision), and
  // the frame then runs with the tab context as the top document has it now (a page that turned into a checkout
  // since the observation makes a frame's "Continue" a purchase). A top document that changed is `stale`.
  async function refreshTop(tabId, parts, options = {}) {
    const fresh = await callPage(tabId, 'observe', [{ ...options, blocks: false }]);
    if (fresh?.revision !== parts.top) throw new ExtensionError('stale', 'Stale observation: the page changed since the decision');
    setContext(tabId, parts, facts(fresh));
  }

  // Before a top act: each read frame's facts as they are now (one cheap look per frame), so a frame that turned into
  // a payment or sign-in form since the observation restricts the top document's control. A frame that does not
  // answer keeps the facts it had.
  async function refreshFrames(tabId, parts, options = {}) {
    const looks = await Promise.all([...parts.frames.values()].map(frame => callFrame(tabId, frame, 'observe',
      [{ ...options, blocks: false }]).then(value => [frame.n, value], () => [frame.n, null])));
    const current = new Map(looks.filter(([, value]) => value?.pageFacts).map(([n, value]) => [n, facts(value)]));
    setContext(tabId, parts, parts.topFacts ?? union([]), current);
  }

  // The frame of an act, the top document refreshed and the frame probed again (see refreshTop, recheckFrame).
  async function prepareFrameAct(tabId, expectedRevision, frame, options) {
    const parts = states.get(tabId)?.composites.get(expectedRevision);
    if (!parts) throw new ExtensionError('stale', 'Stale observation: the frame changed since the decision');
    await recheckFrame(tabId, frame);
    await refreshTop(tabId, parts, options);
  }

  /**
   * approvalInfo for the Approve gate, in the document the target is in; its revision is the expected one. For a frame
   * control `frameOrigin` names the frame's own origin (checked against the request) and `topOrigin` the page's.
   */
  async function approvalInfo(tabId, target, expectedRevision, kind) {
    const { top, frame, local } = resolve(tabId, expectedRevision, target);
    if (!frame) {
      const info = await callPage(tabId, 'approvalInfo', [target, top, kind]);
      return info?.revision === top ? { ...info, revision: expectedRevision } : info;
    }
    await prepareFrameAct(tabId, expectedRevision, frame, {});
    const info = await callFrame(tabId, frame, 'approvalInfo', [local, frame.revision, kind]);
    if (!info || info.revision !== frame.revision) return info;
    // The origin the control is on, as the frame's page script reads it: the one the request approved for that frame.
    if (info.origin !== frame.origin || !frameApproved(info.origin)) {
      throw new ExtensionError('cross_origin', 'The frame moved to an origin this request does not approve');
    }
    return { ...info, revision: expectedRevision, target, frameOrigin: frame.origin, topOrigin: session?.origin ?? null };
  }

  function frameTarget(action) {
    return typeof action?.target === 'string' && FRAME_TARGET.test(action.target);
  }

  // Top acts on a control that may submit, pay or sign in (a click, Enter, a key, a select or fill a page submits on
  // change, an upload) look at the frames' facts again first (refreshFrames). A hover never does.
  const REFRESHING = new Set(['click', 'submit_field', 'press', 'select', 'fill_supplied_text', 'fill_secret', 'upload']);

  // A page action (execute) in the top document or a frame. `rest` are execute()'s arguments after the revision
  // (settle, terms, forbid, allow, sites, expectText, approval). Returns execute()'s outcome, its observation merged; an
  // action that navigates the tab returns { expectNavigation } for the worker's own wait.
  async function execute(tab, action, expectedRevision, rest, navigation) {
    const [settle, terms, forbid, allow, sites, expectText, approval] = rest;
    const options = { terms, forbid, allow, sites, expectText };
    const { top, frame, local } = resolve(tab.id, expectedRevision, action.target);
    if (!frame) {
      const parts = states.get(tab.id)?.composites.get(expectedRevision);
      if (parts?.frames.size && action.target !== undefined && REFRESHING.has(action.type)) await refreshFrames(tab.id, parts, options);
      const outcome = await callPage(tab.id, 'execute', [action, top, ...rest]);
      return outcome?.observation ? withFrames(tab.id, outcome, options) : outcome;
    }
    await prepareFrameAct(tab.id, expectedRevision, frame, options);
    const id = value => `f${frame.n}.${value}`;
    const fromUrl = reportedUrl(tab.url);
    const inFrame = { ...action, target: local };
    const frameApproval = approval ? { ...approval, target: local } : null;
    let outcome;
    let navigated = false;
    try {
      outcome = await callFrame(tab.id, frame, 'execute', [inFrame, frame.revision, settle, terms, forbid, allow, sites, expectText, frameApproval]);
    } catch (error) {
      // Refused before the script ran (the frame's document is gone): say what the frame is now, never a success.
      if (error?.notStarted) {
        await recheckFrame(tab.id, frame);
        throw new ExtensionError('stale', 'Stale observation: the frame changed before the action could run');
      }
      if (!isTeardown(error)) throw error;
      navigated = true;
      outcome = {};
    }
    const target = outcome.target && typeof outcome.target === 'object'
      ? { ...outcome.target, ...(outcome.target.id !== undefined ? { id: id(outcome.target.id) } : {}) } : null;
    const { observation: _own, expectNavigation, ...kept } = outcome;
    if (expectNavigation || navigated) {
      // A link or form in the frame: it navigates the tab (_top) or only the frame. The tab's own load is the
      // worker's to wait for; a frame's load is waited for here, then the whole tab is observed again.
      const deadline = Date.now() + FRAME_LOAD_CAP_MS;
      while (Date.now() < deadline) {
        if (navigation?.started || navigation?.urlChanged) return { ...kept, fromUrl, target, expectNavigation: true };
        const [probe] = await probeFrames(tab.id, [frame.frameId]);
        const replaced = !probe || probe.result.page === false || (probe.documentId && frame.documentId && probe.documentId !== frame.documentId);
        if (replaced && (!probe || probe.result.ready === 'complete')) break;
        await delay(NAV_POLL_MS);
      }
      const after = await observePage(tab.id, 'settleAndObserve', [SETTLE_AFTER_NAVIGATION, terms, forbid, allow, sites, expectText]);
      return { ...kept, fromUrl, target, settle: after.settle, observation: after.observation, frameNavigated: true };
    }
    const observation = await withFrames(tab.id, await callPage(tab.id, 'observe', [options]), options);
    return { ...kept, fromUrl, target, observation };
  }

  // Screenshot redaction for the tab's cross-origin frames, placed where they are now. The top document's query
  // (`value`, page.js redactionRects) names each cross-origin frame's current box by its current path (frameBoxes),
  // and so does each approved frame's own query for the frames inside it. A path is only a position (removing an earlier
  // frame shifts every later one), so the frames read last are found again by their frame id: a probe gives each one's
  // current path, origin and size, and a box is matched to a read frame only when that frame is at that path now, on
  // the same origin and document, with the box's size. A matched frame is asked for its own boxes (secrets, password,
  // payment and secret fields, and in Strict mode its canvases, code and unread frames), moved into the top viewport by
  // its current box and clipped to it; one that does not answer within the shared FRAME_REDACT_MS is boxed whole. Every
  // other box is boxed whole: a frame that was not read, and a read frame's box that does not match (the capture is then
  // marked dirty too). A read frame no query places is boxed where it was and marks the capture dirty; so does one that
  // moved more than MOVE_TOLERANCE_PX between the query before the capture and the one after it (the worker then takes
  // the capture again or withholds it).
  async function redaction(tabId, value, arm) {
    if (!value || !Array.isArray(value.rects)) return value;
    const { frameBoxes = [], ...rest } = value;
    const state = stateOf(tabId);
    const frames = state.frames ?? [];
    if (!frames.length && !(Array.isArray(frameBoxes) && frameBoxes.length)) return rest;
    const rects = [...rest.rects];
    let incomplete = rest.incomplete === true;
    let mismatch = false;
    let dirty = rest.dirty;
    const deadline = Date.now() + FRAME_REDACT_MS;
    const box = (clip, kind) => ({ x: Math.floor(clip.left), y: Math.floor(clip.top), width: Math.ceil(clip.right - clip.left),
      height: Math.ceil(clip.bottom - clip.top), kind });
    const visible = clip => clip.right > clip.left && clip.bottom > clip.top;
    // Where each frame read last is now (each probed alone: one that is gone does not hide the others).
    const probes = await Promise.all(frames.map(frame => probeFrames(tabId, [frame.frameId]).then(([probe]) => [frame, probe])));
    const byPath = new Map();
    for (const [frame, probe] of probes) {
      const same = probe && probe.result.origin === frame.origin && !probe.result.opaque && frameApproved(probe.result.origin)
        && !(frame.documentId && probe.documentId && probe.documentId !== frame.documentId);
      if (same) byPath.set(pathKey(probe.result.path), { frame, probe });
    }
    const placed = new Set();
    const now = new Map();
    let level = (Array.isArray(frameBoxes) ? frameBoxes : []).map(slot => placeSlot(slot, { dx: 0, dy: 0, clip: null })).filter(Boolean);
    while (level.length) {
      const asking = [];
      for (const slot of level) {
        const key = pathKey(slot.path);
        if (now.has(key)) continue;
        now.set(key, slot);
        const match = byPath.get(key);
        if (!match) {
          // Not read (or not the frame read there): nothing of it is known, so none of it is shown.
          if (visible(slot.clip)) rects.push(box(slot.clip, 'frame'));
          // A read frame sits at this path now but is not the document or origin it was: the capture is not trusted.
          if (probes.some(([, probe]) => probe && pathKey(probe.result.path) === key)) mismatch = true;
          continue;
        }
        if (!sameSize(match.probe, slot)) {
          if (visible(slot.clip)) rects.push(box(slot.clip, 'frame'));
          mismatch = true;
          continue;
        }
        placed.add(match.frame);
        asking.push({ slot, frame: match.frame });
      }
      const answers = await Promise.all(asking.map(({ slot, frame }) => Promise.race([
        callFrame(tabId, frame, 'redactionRects', [{ arm }]).catch(() => null),
        delay(Math.max(0, deadline - Date.now())).then(() => null),
      ]).then(answer => ({ slot, answer }))));
      const next = [];
      for (const { slot, answer } of answers) {
        if (!answer || !Array.isArray(answer.rects)) {
          if (visible(slot.clip)) rects.push(box(slot.clip, 'frame'));
          continue;
        }
        if (answer.incomplete === true) incomplete = true;
        if (!arm && answer.dirty !== false) dirty = true;
        for (const rect of answer.rects) {
          const clean = cleanRect(rect);
          if (!clean) {
            rects.push(box(slot.clip, 'frame'));
            continue;
          }
          const clip = intersect({ left: clean.x + slot.dx, top: clean.y + slot.dy, right: clean.x + slot.dx + clean.width,
            bottom: clean.y + slot.dy + clean.height }, slot.clip);
          if (!visible(clip)) continue;
          rects.push({ ...box(clip, rect.kind ?? 'secret'), ...(clean.label ? { label: clean.label } : {}) });
        }
        for (const inner of Array.isArray(answer.frameBoxes) ? answer.frameBoxes : []) {
          const nested = placeSlot(inner, { dx: slot.dx, dy: slot.dy, clip: slot.clip });
          if (nested && startsWith(nested.path, slot.path)) next.push(nested);
        }
      }
      level = next;
    }
    // A frame read last that no box matched: box it where it was, and the capture cannot be trusted as is.
    for (const frame of frames) {
      if (placed.has(frame)) continue;
      if (visible(frame.clip)) rects.push(box(frame.clip, 'frame'));
      mismatch = true;
    }
    if (arm) {
      state.redactBoxes = now;
      state.redactMissing = mismatch;
    } else {
      const before = state.redactBoxes ?? new Map();
      const moved = (a, b) => !a || !b || Math.abs(a.dx - b.dx) > MOVE_TOLERANCE_PX || Math.abs(a.dy - b.dy) > MOVE_TOLERANCE_PX
        || Math.abs(a.width - b.width) > MOVE_TOLERANCE_PX || Math.abs(a.height - b.height) > MOVE_TOLERANCE_PX;
      for (const key of new Set([...before.keys(), ...now.keys()])) if (moved(before.get(key), now.get(key))) dirty = true;
      if (state.redactMissing || mismatch) dirty = true;
      state.redactBoxes = null;
      state.redactMissing = false;
    }
    return { ...rest, rects, ...(incomplete ? { incomplete: true } : {}), ...(arm ? {} : { dirty }) };
  }

  globalThis.faiFrames = { withFrames, optionsOf, observeTab, approvalInfo, execute, frameTarget, redaction, topContext,
    frameApproved, resolve };
})();
