// Blocking overlays other than cookie dialogs: the observation's `overlay` (extension/page.js detectOverlay) and the
// runtime's dismissal plan for a nag (sign-in, newsletter, promo, app-install or permission prompt). Pure and
// synchronous; the runtime's loop (src/runtime.js) runs the plan as Rung 0 steps of class `dismiss`, at every level,
// as it runs a consent reject. Task dialogs, age gates and unknown dialogs are never dismissed.

export const NAG_KINDS = Object.freeze(['sign_in', 'newsletter', 'promo', 'app', 'permission']);
const KINDS = new Set([...NAG_KINDS, 'age_gate', 'task', 'unknown']);
// Dismissal steps per run, over every overlay, before the runtime stops trying.
export const MAX_OVERLAY_ACTIONS = 6;
// An overlay dismissed this many times that shows again is persistent: no further attempt (overlay:persistent).
export const MAX_OVERLAY_RETURNS = 2;
// After a dismissal, re-observe at most this many times (consentWaitMs apart) for the overlay to go.
export const MAX_OVERLAY_WAITS = 4;
const TEXT_LIMIT = 120;

/** The observation's overlay `{kind, nag, text, closers, escape?, backdrop?}`, or null for none or a malformed one. */
export function overlayOf(observation) {
  const overlay = observation?.overlay;
  if (!overlay || typeof overlay !== 'object' || !KINDS.has(overlay.kind)) return null;
  return {
    kind: overlay.kind,
    // Only a kind the runtime knows as a nag is dismissed, whatever the page script's flag says.
    nag: overlay.nag === true && NAG_KINDS.includes(overlay.kind),
    text: String(overlay.text ?? '').replace(/\s+/g, ' ').trim().slice(0, TEXT_LIMIT),
    closers: Array.isArray(overlay.closers) ? overlay.closers.filter(closer => closer && closer.id !== undefined && closer.id !== null) : [],
    escape: overlay.escape === true,
    backdrop: overlay.backdrop === true,
  };
}

/** Identity of an overlay across observations (ids are renumbered): its kind and the start of its text. */
export function overlayKey(overlay) {
  return `${overlay?.kind ?? ''}:${String(overlay?.text ?? '').toLowerCase().slice(0, 60)}`;
}

/**
 * The dismissal steps for a nag overlay, in order: its close controls (the page script's best first, each only while
 * it is an offered control with a risk the runtime may click), then Escape, then a click on its separate backdrop.
 * Each has a stable `key` (method plus label) so a step that did not close the overlay is never repeated for it.
 */
export function overlayDismissActions(overlay, observation) {
  if (!overlay?.nag) return [];
  const actions = [];
  const controls = new Map((observation?.controls ?? []).map(control => [String(control?.id), control]));
  for (const closer of overlay.closers.slice(0, 3)) {
    const target = String(closer.id);
    const control = controls.get(target);
    if (!control || control.enabled === false || control.dismiss !== true) continue;
    if (!['reversible', 'navigation'].includes(control.risk)) continue;
    const label = String(control.label ?? closer.label ?? '').replace(/\s+/g, ' ').trim().slice(0, 120) || '×';
    actions.push({
      type: 'click', target, role: control.role ?? 'button', label, overlayDismiss: true, method: 'close',
      key: `close:${label.toLowerCase()}`, description: `Close the ${overlay.kind} popup with control ${target}: ${label}`,
    });
  }
  if (overlay.escape) {
    actions.push({ type: 'dismiss_overlay', method: 'escape', label: 'Escape', overlayDismiss: true, key: 'escape',
      description: `Press Escape to close the ${overlay.kind} popup` });
  }
  if (overlay.backdrop) {
    actions.push({ type: 'dismiss_overlay', method: 'backdrop', label: 'backdrop', overlayDismiss: true, key: 'backdrop',
      description: `Click outside the ${overlay.kind} popup, on its backdrop` });
  }
  return actions;
}

/** Per-run dismissal state: steps spent, steps tried per overlay, dismissals per overlay, overlays given up on. */
export function overlayState() {
  return { actions: 0, tried: new Map(), dismissed: new Map(), stuck: new Set(), seen: new Set() };
}
