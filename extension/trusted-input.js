// Trusted input (opt-in, Chromium only): input.js in the leased tab asks the worker to replay its pointer and key
// sequence through the Chrome DevTools Protocol (chrome.debugger, Input.dispatchMouseEvent / dispatchKeyEvent /
// insertText), so the page receives isTrusted events from the browser itself, with the user activation a real press
// gives. Loaded into the worker with importScripts (background.js) before it runs.
//
// Off unless both hold: the `debugger` permission is in the manifest (only the trusted-input build adds it:
// node scripts/build-trusted.mjs; Chrome does not allow `debugger` as an optional permission, so the store manifest
// never carries it and never shows its install warning) and the user turned on Advanced, "Trusted input".
// While attached Chrome shows its "FAI Browser started debugging this browser" bar on every window; the worker attaches
// for one action and detaches when the action's steps are done (TRUSTED_IDLE_MS after the last message).
// Firefox has no chrome.debugger: always off there.
//
// The worker accepts steps only from its own content script in the top frame of the leased tab, only the closed set
// below, with coordinates inside the viewport, bounded text and waits.

const TRUSTED_IDLE_MS = 600;
const TRUSTED_MAX_STEPS = 400;
const TRUSTED_MAX_WAIT_MS = 600;
const TRUSTED_MAX_TEXT = 4000;
const TRUSTED_MOUSE = new Set(['mouseMoved', 'mousePressed', 'mouseReleased', 'mouseWheel']);
const TRUSTED_KEY = new Set(['keyDown', 'keyUp', 'rawKeyDown']);

let trustedInputSetting = false;
let trustedAttached = null; // { tabId, timer, ready: Promise }

function trustedInputAvailable() {
  return typeof chrome?.debugger?.attach === 'function';
}

/** Whether page input goes through chrome.debugger: available in this build and turned on by the user. */
function trustedInputOn() {
  return trustedInputSetting && trustedInputAvailable();
}

async function loadTrustedInputSetting() {
  const saved = await chrome.storage.local.get(['trustedInput']);
  trustedInputSetting = saved.trustedInput === true;
}

/** One step of the closed set, cleaned, or null when it is anything else. */
function cleanTrustedStep(step, viewport) {
  if (!step || typeof step !== 'object') return null;
  const finite = (value, low, high) => Number.isFinite(value) && value >= low && value <= high;
  if (step.wait !== undefined) return finite(step.wait, 0, TRUSTED_MAX_WAIT_MS) ? { wait: step.wait } : null;
  const modifiers = finite(step.modifiers, 0, 15) ? Math.trunc(step.modifiers) : 0;
  if (step.m === 'mouse') {
    if (!TRUSTED_MOUSE.has(step.type) || !finite(step.x, 0, viewport.width) || !finite(step.y, 0, viewport.height)) return null;
    const pressing = step.type === 'mousePressed' || step.type === 'mouseReleased';
    const params = {
      type: step.type, x: step.x, y: step.y, modifiers, pointerType: 'mouse',
      button: pressing ? 'left' : 'none', buttons: step.type === 'mousePressed' ? 1 : 0,
      clickCount: pressing ? 1 : 0,
    };
    if (step.type === 'mouseWheel') {
      if (!finite(step.deltaY, -2000, 2000)) return null;
      Object.assign(params, { deltaX: 0, deltaY: step.deltaY });
    }
    return { method: 'Input.dispatchMouseEvent', params };
  }
  if (step.m === 'key') {
    if (!TRUSTED_KEY.has(step.type) || typeof step.key !== 'string' || step.key.length > 20) return null;
    const params = {
      type: step.type, modifiers, key: step.key,
      code: typeof step.code === 'string' ? step.code.slice(0, 20) : '',
      windowsVirtualKeyCode: finite(step.keyCode, 0, 255) ? step.keyCode : 0,
      nativeVirtualKeyCode: finite(step.keyCode, 0, 255) ? step.keyCode : 0,
    };
    if (typeof step.text === 'string' && step.text.length <= 2) Object.assign(params, { text: step.text, unmodifiedText: step.text });
    if (Array.isArray(step.commands) && step.commands.every(command => command === 'selectAll')) params.commands = step.commands;
    return { method: 'Input.dispatchKeyEvent', params };
  }
  if (step.m === 'text') {
    if (typeof step.text !== 'string' || !step.text || step.text.length > TRUSTED_MAX_TEXT) return null;
    return { method: 'Input.insertText', params: { text: step.text } };
  }
  return null;
}

async function trustedAttach(tabId) {
  if (trustedAttached?.tabId === tabId) {
    clearTimeout(trustedAttached.timer);
    await trustedAttached.ready;
    return;
  }
  if (trustedAttached) await trustedDetach();
  const entry = { tabId, timer: null, ready: chrome.debugger.attach({ tabId }, '1.3') };
  trustedAttached = entry;
  try {
    await entry.ready;
  } catch (error) {
    if (trustedAttached === entry) trustedAttached = null;
    throw error;
  }
}

async function trustedDetach() {
  const entry = trustedAttached;
  trustedAttached = null;
  if (!entry) return;
  clearTimeout(entry.timer);
  try {
    await entry.ready;
    await chrome.debugger.detach({ tabId: entry.tabId });
  } catch {
    // Already detached (the tab closed, or the user cancelled from the infobar).
  }
}

/**
 * Replays `steps` in tab `tabId` (viewport `viewport`, CSS px). Resolves { ok, dispatched, reason? }: `dispatched`
 * counts the input events sent, so a caller falls back to its own events only when none went out.
 */
async function runTrustedSteps(tabId, steps, viewport) {
  if (!trustedInputOn()) return { ok: false, dispatched: 0, reason: 'off' };
  if (!Array.isArray(steps) || steps.length > TRUSTED_MAX_STEPS) return { ok: false, dispatched: 0, reason: 'invalid' };
  const box = {
    width: Number.isFinite(viewport?.width) ? Math.min(viewport.width, 20_000) : 0,
    height: Number.isFinite(viewport?.height) ? Math.min(viewport.height, 20_000) : 0,
  };
  const cleaned = steps.map(step => cleanTrustedStep(step, box));
  if (cleaned.some(step => !step)) return { ok: false, dispatched: 0, reason: 'invalid' };
  let dispatched = 0;
  try {
    await trustedAttach(tabId);
    for (const step of cleaned) {
      if (step.wait !== undefined) {
        await new Promise(resolve => setTimeout(resolve, step.wait));
        continue;
      }
      await chrome.debugger.sendCommand({ tabId }, step.method, step.params);
      dispatched++;
    }
    return { ok: true, dispatched };
  } catch (error) {
    await trustedDetach();
    return { ok: false, dispatched, reason: String(error?.message || error).slice(0, 200) };
  } finally {
    if (trustedAttached?.tabId === tabId) {
      clearTimeout(trustedAttached.timer);
      trustedAttached.timer = setTimeout(trustedDetach, TRUSTED_IDLE_MS);
    }
  }
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area === 'local' && changes.trustedInput) trustedInputSetting = changes.trustedInput.newValue === true;
  });
  loadTrustedInputSetting().catch(() => {});
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.kind !== 'fai-trusted-input') return false;
    // Only our own content script, in the top frame of the tab the user approved.
    const leased = typeof session !== 'undefined' && session?.tabId;
    if (sender.id !== chrome.runtime.id || !sender.tab || sender.frameId !== 0 || !leased || sender.tab.id !== leased) {
      respond({ ok: false, dispatched: 0, reason: 'not_leased' });
      return false;
    }
    runTrustedSteps(sender.tab.id, message.steps, message.viewport).then(respond, () => respond({ ok: false, dispatched: 0 }));
    return true;
  });
  chrome.debugger?.onDetach?.addListener(source => {
    if (trustedAttached?.tabId === source.tabId) {
      clearTimeout(trustedAttached.timer);
      trustedAttached = null;
    }
  });
}
