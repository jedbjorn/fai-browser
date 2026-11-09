// Realistic synthetic input for page.js: injected into the same isolated world right before it (background.js
// executeScript files ['input.js', 'page.js']), once per document. page.js decides what may run (targets, guardrails,
// navigation checks); this file only decides how the input looks to the page: the event sequences a mouse, a keyboard
// and a wheel produce, with their coordinates, modifiers and human timing, instead of el.click() (a lone click with
// pointerId -1 at 0,0), a value set with no key events, or an instant 70% scroll.
//
// What it cannot change: every event dispatched from a content script has isTrusted false, and nothing here gives a
// page transient user activation. See docs/REFERENCE.md "Detection".
//
// Nothing is written to the page: no DOM attributes, styles, globals in the page's own world (this runs in the
// extension's isolated world), console output or storage. Without this file page.js falls back to its plain input.
(() => {
  if (globalThis.__faiInput) return;

  const config = {
    enabled: true,
    // Think time before each action (ms, a jittered draw between the two).
    think: [15, 70],
    // Typing: characters typed key by key while the planned rhythm stays within this much time (a whole value within
    // RHYTHM.slack of it is typed in full) and up to this many characters, the rest inserted in one piece (as an IME
    // commit or autocomplete does), so long text never takes long.
    typeBudgetMs: 1000,
    maxTyped: 40,
    // The typist's speed for this session (RHYTHM): the worker sends one seed per lease, so every document of a task
    // types at the same pace; 0 means a seed of this document's own.
    rhythmSeed: 0,
    // Test hooks: a seed for the per-key draws (0: Math.random), and the chance of a slip per letter (null: RHYTHM's).
    keySeed: 0,
    slipRate: null,
    // Wheel scrolling of the window to an off-screen target: farther than this jumps (scrollIntoView).
    revealMaxPx: 4000,
    // Trusted input (the worker's chrome.debugger replay, trusted-input.js): set by the worker per call, only when
    // the user turned it on in a build that has the permission.
    trusted: false,
  };
  const totals = { actions: 0, ms: 0 };

  // The pointer, in top-document viewport coordinates, and the element it is over (the last over/enter target).
  let cursor = null;
  let hovered = null;
  // A field typed into whose change event is due: fired when focus leaves it (a later click or fill) or on Enter,
  // as the browser fires it for a user's typing; never for a value set without typing.
  let pending = null;

  const MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
  const FOCUSABLE = 'a[href],area[href],button,input,select,textarea,iframe,summary,[tabindex],[contenteditable]';

  const random = (low, high) => low + Math.random() * (high - low);
  // A bell-shaped draw around `mean` (sum of three uniforms), never below `floor`.
  const jitter = (mean, spread, floor = 0) => Math.max(floor, mean + (Math.random() + Math.random() + Math.random() - 1.5) * spread);
  // Timers in a hidden tab are throttled to one a second; there is no one to look human to there, so no waits.
  const pause = ms => (!config.enabled || ms <= 0 || document.hidden
    ? Promise.resolve()
    : new Promise(resolve => setTimeout(resolve, Math.round(ms))));

  function think() {
    return pause(random(config.think[0], config.think[1]));
  }

  function viewOf(node) {
    return node?.ownerDocument?.defaultView ?? window;
  }

  function composedParent(node) {
    if (node.parentElement) return node.parentElement;
    const parent = node.parentNode;
    return parent && parent.nodeType === 11 ? parent.host ?? null : null;
  }

  function within(node, el) {
    for (let n = node; n; n = composedParent(n)) if (n === el) return true;
    return false;
  }

  function deepActive(doc) {
    let active = doc.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    return active;
  }

  function deepHit(doc, x, y) {
    let hit = doc.elementFromPoint(x, y);
    while (hit?.shadowRoot) {
      const inner = hit.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    return hit;
  }

  // Where a document's viewport sits in the top document's viewport (a same-origin frame's content box).
  function frameOffset(doc) {
    let x = 0;
    let y = 0;
    let view = doc.defaultView;
    for (let depth = 0; view && depth < 10; depth++) {
      let frame = null;
      try {
        frame = view.frameElement;
      } catch {
        frame = null;
      }
      if (!frame) break;
      const rect = frame.getBoundingClientRect();
      const style = frame.ownerDocument.defaultView.getComputedStyle(frame);
      x += rect.left + frame.clientLeft + (parseFloat(style.paddingLeft) || 0);
      y += rect.top + frame.clientTop + (parseFloat(style.paddingTop) || 0);
      view = frame.ownerDocument.defaultView;
    }
    return { x, y };
  }

  // Screen coordinates for a top-viewport point: the window's position plus the browser's own frame and toolbars.
  function screenOf(x, y) {
    const side = Math.max(0, Math.round((outerWidth - innerWidth) / 2));
    const top = Math.max(0, outerHeight - innerHeight - side);
    return { screenX: Math.round(screenX + side + x), screenY: Math.round(screenY + top + y) };
  }

  // A coordinate as a mouse reports it: whole CSS pixels at 1x, device-pixel steps on a high-density screen.
  function px(value) {
    const ratio = devicePixelRatio || 1;
    return ratio > 1 ? Math.round(value * ratio) / ratio : Math.round(value);
  }

  function mouseInit(view, x, y, extra = {}) {
    const offset = frameOffset(view.document);
    return {
      bubbles: true, cancelable: true, composed: true, view, detail: 0,
      clientX: x, clientY: y, ...screenOf(x + offset.x, y + offset.y),
      button: 0, buttons: 0, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, relatedTarget: null,
      ...extra,
    };
  }

  function pointerInit(init, extra = {}) {
    return {
      ...init, detail: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true, width: 1, height: 1,
      pressure: init.buttons ? 0.5 : 0, tangentialPressure: 0, tiltX: 0, tiltY: 0, twist: 0, ...extra,
    };
  }

  function fire(target, type, Kind, init) {
    const view = viewOf(target);
    const Constructor = view[Kind] ?? globalThis[Kind];
    return target.dispatchEvent(new Constructor(type, init));
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Pointer
  // ---------------------------------------------------------------------------------------------------------------

  function chain(node) {
    const list = [];
    for (let n = node; n; n = composedParent(n)) list.push(n);
    return list;
  }

  // The boundary events a mouse produces when it moves from the hovered element onto `next`, in Chrome's order:
  // pointerout, pointerleave (innermost first), pointerover, pointerenter (outermost first), then the mouse ones.
  function hoverTo(next, view, x, y) {
    const prev = hovered?.isConnected ? hovered : null;
    if (prev === next) return;
    const sameDoc = prev && next && prev.ownerDocument === next.ownerDocument;
    const prevChain = prev ? chain(prev) : [];
    const nextChain = next ? chain(next) : [];
    const leaving = prevChain.filter(node => !nextChain.includes(node));
    const entering = nextChain.filter(node => !prevChain.includes(node)).reverse();
    const out = mouseInit(viewOf(prev), x, y, { relatedTarget: sameDoc ? next : null });
    const over = mouseInit(view, x, y, { relatedTarget: sameDoc ? prev : null });
    const quiet = { bubbles: false, cancelable: false };
    for (const [Kind, wrap] of [['PointerEvent', pointerInit], ['MouseEvent', init => init]]) {
      const prefix = Kind === 'PointerEvent' ? 'pointer' : 'mouse';
      if (prev) fire(prev, `${prefix}out`, Kind, wrap(out));
      for (const node of leaving) fire(node, `${prefix}leave`, Kind, wrap({ ...out, ...quiet }));
      if (next) fire(next, `${prefix}over`, Kind, wrap(over));
      for (const node of entering) fire(node, `${prefix}enter`, Kind, wrap({ ...over, ...quiet }));
    }
    hovered = next;
  }

  // Where the pointer starts in a document it has not moved in yet: resting somewhere a few hundred pixels from the
  // target, inside the viewport.
  function restingPoint(view, x, y) {
    const angle = random(0, Math.PI * 2);
    const distance = random(150, 380);
    return {
      x: Math.min(view.innerWidth - 2, Math.max(1, x + Math.cos(angle) * distance)),
      y: Math.min(view.innerHeight - 2, Math.max(1, y + Math.sin(angle) * distance)),
    };
  }

  // The points of a pointer path to (x, y) in `doc`'s viewport: from where the pointer is (or a resting point) along a
  // slightly curved, decelerating line, with the gap after each point; the last point is exactly (x, y).
  function pathTo(doc, x, y) {
    const view = doc.defaultView;
    const offset = frameOffset(doc);
    let start = cursor ? { x: cursor.x - offset.x, y: cursor.y - offset.y } : restingPoint(view, x, y);
    if (start.x < 0 || start.y < 0 || start.x >= view.innerWidth || start.y >= view.innerHeight) start = restingPoint(view, x, y);
    const dx = x - start.x;
    const dy = y - start.y;
    const distance = Math.hypot(dx, dy);
    const steps = distance < 3 ? 1 : Math.min(7, Math.max(3, Math.round(distance / 110)));
    const bow = (Math.random() - 0.5) * Math.min(60, distance * 0.2);
    const nx = distance ? -dy / distance : 0;
    const ny = distance ? dx / distance : 0;
    const points = [];
    let last = { x: px(start.x), y: px(start.y) };
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const eased = 1 - (1 - t) ** 2.4;
      const curve = Math.sin(Math.PI * t) * bow;
      let sx = i === steps ? x : start.x + dx * eased + nx * curve + random(-1, 1);
      let sy = i === steps ? y : start.y + dy * eased + ny * curve + random(-1, 1);
      sx = px(Math.min(view.innerWidth - 1, Math.max(0, sx)));
      sy = px(Math.min(view.innerHeight - 1, Math.max(0, sy)));
      points.push({ x: sx, y: sy, movementX: Math.round(sx - last.x), movementY: Math.round(sy - last.y), gap: i < steps ? jitter(13, 8, 6) : 0 });
      last = { x: sx, y: sy };
    }
    return { points, offset };
  }

  // Moves the pointer to (x, y) in `doc`'s viewport (pathTo): pointermove and mousemove at each point (with
  // movementX/Y), and the boundary events wherever the element under it changes.
  async function moveTo(doc, x, y) {
    const view = doc.defaultView;
    const { points, offset } = pathTo(doc, x, y);
    for (const point of points) {
      const hit = deepHit(doc, point.x, point.y) ?? doc.documentElement;
      hoverTo(hit, view, point.x, point.y);
      const init = mouseInit(view, point.x, point.y, { movementX: point.movementX, movementY: point.movementY });
      fire(hit, 'pointermove', 'PointerEvent', pointerInit(init));
      fire(hit, 'mousemove', 'MouseEvent', init);
      cursor = { x: point.x + offset.x, y: point.y + offset.y };
      if (point.gap) await pause(point.gap);
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Trusted input: the same sequences as steps for the worker to replay through chrome.debugger (trusted-input.js),
  // in top-viewport coordinates. Each call resolves { ok, dispatched }; nothing dispatched means the caller's own
  // events go out instead (the setting off, a build without the permission, Firefox, an attach Chrome refused).
  // ---------------------------------------------------------------------------------------------------------------

  // `deadline` (ms from the first step): past it the worker presses no more keys, releases what is held and says
  // `late`.
  async function sendTrusted(steps, { deadline } = {}) {
    if (!config.trusted || document.hidden || typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return { ok: false, dispatched: 0 };
    try {
      const reply = await chrome.runtime.sendMessage({
        kind: 'fai-trusted-input', steps, viewport: { width: innerWidth, height: innerHeight },
        ...(Number.isFinite(deadline) ? { deadline: Math.round(deadline) } : {}),
      });
      return reply && typeof reply.dispatched === 'number' ? reply : { ok: false, dispatched: 0 };
    } catch {
      return { ok: false, dispatched: 0 };
    }
  }

  function trustedMoves(doc, x, y) {
    const { points, offset } = pathTo(doc, x, y);
    const steps = [];
    for (const point of points) {
      steps.push({ m: 'mouse', type: 'mouseMoved', x: point.x + offset.x, y: point.y + offset.y });
      if (point.gap) steps.push({ wait: Math.round(point.gap) });
    }
    return { steps, end: { x: points.at(-1).x + offset.x, y: points.at(-1).y + offset.y } };
  }

  function visibleRect(el) {
    const view = viewOf(el);
    const rect = el.getBoundingClientRect();
    const left = Math.max(rect.left, 0);
    const top = Math.max(rect.top, 0);
    const right = Math.min(rect.right, view.innerWidth);
    const bottom = Math.min(rect.bottom, view.innerHeight);
    if (right - left < 1 || bottom - top < 1) return null;
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }

  // A point a person would aim at: near the middle of the element's visible part, and one where the element (or
  // something inside it) is what is on top. A covered element is pressed at its centre.
  function aimAt(el) {
    const doc = el.ownerDocument;
    const rect = visibleRect(el);
    if (rect) {
      for (let attempt = 0; attempt < 8; attempt++) {
        const spread = attempt < 7 ? 0.32 : 0;
        const fx = 0.5 + (Math.random() + Math.random() - 1) * spread;
        const fy = 0.5 + (Math.random() + Math.random() - 1) * spread;
        const x = px(rect.left + rect.width * fx);
        const y = px(rect.top + rect.height * fy);
        if (x < rect.left || y < rect.top || x >= rect.right || y >= rect.bottom) continue;
        const hit = deepHit(doc, x, y);
        if (hit && within(hit, el)) return { x, y };
      }
    }
    const box = el.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  }

  function disabled(el) {
    try {
      return Boolean(el.matches?.(':disabled'));
    } catch {
      return false;
    }
  }

  // The change event a user's typing earns when the field loses focus (or on Enter), fired once.
  function commitPending(nextFocus) {
    if (!pending || pending.el === nextFocus) return;
    const { el, start } = pending;
    pending = null;
    if (el.isConnected && el.value !== start) fire(el, 'change', 'Event', { bubbles: true, cancelable: false });
  }

  // A typed field that loses focus some other way (the page moves focus, the user clicks elsewhere) gets its change
  // then, as the browser gives a user's typing. One capture listener per window, in this isolated world only.
  const blurWatched = new WeakSet();
  function watchBlur(view) {
    if (blurWatched.has(view)) return;
    blurWatched.add(view);
    view.addEventListener('blur', event => {
      if (pending && event.target === pending.el) commitPending(null);
    }, { capture: true });
  }

  // A press's default action: focus to the nearest focusable element under it, or, on nothing focusable, off the
  // focused element (the page sees its blur), as a mouse button does.
  function pressFocus(target) {
    let node = target;
    while (node && !(node.matches?.(FOCUSABLE) && !disabled(node) && node.getAttribute?.('contenteditable') !== 'false')) {
      node = composedParent(node);
    }
    const doc = target.ownerDocument;
    const active = deepActive(doc);
    if (node) {
      if (node !== active) {
        commitPending(node);
        // focusVisible false: a mouse press shows no focus ring on a button (a text field shows its own regardless).
        node.focus({ preventScroll: true, focusVisible: false });
      }
      return;
    }
    if (active && active !== doc.body && active !== doc.documentElement) {
      commitPending(null);
      active.blur();
    }
  }

  // Off-screen elements are scrolled to as a person would: wheel steps on the window when the window is what
  // scrolls and the distance is in reach, else the browser's own scrollIntoView.
  async function reveal(el) {
    const view = viewOf(el);
    const inView = () => {
      const rect = el.getBoundingClientRect();
      return rect.bottom > 0 && rect.right > 0 && rect.top < view.innerHeight && rect.left < view.innerWidth;
    };
    if (inView()) return;
    if (el.ownerDocument === document && !innerScroller(el)) {
      const rect = el.getBoundingClientRect();
      const dy = rect.top + rect.height / 2 - innerHeight / 2;
      const horizontal = rect.right > 0 && rect.left < innerWidth;
      if (horizontal && Math.abs(dy) <= config.revealMaxPx) await wheel(null, dy);
    }
    if (!inView()) el.scrollIntoView({ block: 'center', behavior: 'instant' });
  }

  function innerScroller(el) {
    for (let node = composedParent(el); node && node !== document.body && node !== document.documentElement; node = composedParent(node)) {
      if (node.scrollHeight > node.clientHeight + 1 && /^(?:auto|scroll|overlay)$/.test(getComputedStyle(node).overflowY)) return node;
    }
    return null;
  }

  /**
   * A mouse click on `el`: think, scroll it into view if needed, move the pointer to a point on it, hover, press
   * (pointerdown, mousedown, focus), hold, release (pointerup, mouseup), click. `point` (top-viewport coordinates)
   * presses there instead of an aimed point (a point click); `stillValid()` is asked right before the press and a
   * false answer stops before anything but hover happened. The click itself is the last event and nothing is awaited
   * after it, so the caller's navigation and submit listeners see what it started. A press the page cancels
   * (pointerdown) drops the compatibility mouse events; a mousedown it cancels keeps focus where it is; a target the
   * press removed or disabled gets no click, as with a real mouse.
   * Resolves { clicked, stale, ms }.
   */
  async function click(el, { point = null, stillValid = () => true, think: withThink = true } = {}) {
    const started = performance.now();
    if (withThink) await think();
    if (!point) await reveal(el);
    if (!el.isConnected) return finish(started, { clicked: false, stale: true });
    const doc = el.ownerDocument;
    const view = doc.defaultView;
    let x;
    let y;
    if (point) {
      const offset = frameOffset(doc);
      x = point.x - offset.x;
      y = point.y - offset.y;
    } else {
      ({ x, y } = aimAt(el));
    }
    if (config.trusted) {
      const moves = trustedMoves(doc, x, y);
      if ((await sendTrusted(moves.steps)).dispatched) {
        cursor = moves.end;
        await pause(jitter(35, 25, 8));
        if (!el.isConnected || !stillValid()) return finish(started, { clicked: false, stale: true });
        // The browser presses whatever is on top at the point: only ever the element or something inside it, else
        // the synthetic press below goes to the element itself.
        const hit = deepHit(doc, x, y);
        if (hit && within(hit, el)) {
          const { x: tx, y: ty } = moves.end;
          const pressed = await sendTrusted([
            { m: 'mouse', type: 'mousePressed', x: tx, y: ty }, { wait: Math.round(jitter(70, 30, 25)) },
            { m: 'mouse', type: 'mouseReleased', x: tx, y: ty },
          ]);
          if (pressed.dispatched) return finish(started, { clicked: true, trusted: true });
        }
      }
    }
    await moveTo(doc, x, y);
    await pause(jitter(35, 25, 8));
    if (!el.isConnected || !stillValid()) return finish(started, { clicked: false, stale: true });
    // What is under the pointer now (a hover may have changed the layout); only ever the element or inside it.
    const hit = deepHit(doc, x, y);
    const target = hit && within(hit, el) ? hit : el;
    const down = mouseInit(view, x, y, { buttons: 1, detail: 1 });
    const pointerOk = fire(target, 'pointerdown', 'PointerEvent', pointerInit(down));
    const mouseOk = pointerOk ? fire(target, 'mousedown', 'MouseEvent', down) : true;
    if (mouseOk && target.isConnected) pressFocus(target);
    await pause(jitter(70, 30, 25));
    const up = mouseInit(view, x, y, { buttons: 0, detail: 1 });
    const release = target.isConnected ? target : el;
    if (release.isConnected) {
      fire(release, 'pointerup', 'PointerEvent', pointerInit(up));
      if (pointerOk) fire(release, 'mouseup', 'MouseEvent', up);
    }
    if (!release.isConnected || disabled(release) || disabled(el)) return finish(started, { clicked: false });
    fire(release, 'click', 'PointerEvent', pointerInit(up, { detail: 1 }));
    return finish(started, { clicked: true });
  }

  function finish(started, result) {
    const ms = Math.round(performance.now() - started);
    totals.actions++;
    totals.ms += ms;
    return { ...result, ms };
  }

  /**
   * The click a key press produces on a control (Enter's implicit submission on a form's default button): no pointer,
   * so pointerId -1 and no coordinates, as the browser reports a keyboard-initiated click. Returns whether the page
   * let it proceed.
   */
  function keyboardClick(el) {
    return fire(el, 'click', 'PointerEvent', {
      bubbles: true, cancelable: true, composed: true, view: viewOf(el), detail: 0,
      pointerId: -1, pointerType: '', isPrimary: false, width: 1, height: 1, pressure: 0,
    });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Keyboard
  // ---------------------------------------------------------------------------------------------------------------

  // US layout: the physical key and keyCode of each printable ASCII character, and whether it needs Shift.
  const PLAIN = {
    ' ': ['Space', 32], '-': ['Minus', 189], '=': ['Equal', 187], '[': ['BracketLeft', 219], ']': ['BracketRight', 221],
    '\\': ['Backslash', 220], ';': ['Semicolon', 186], "'": ['Quote', 222], ',': ['Comma', 188], '.': ['Period', 190],
    '/': ['Slash', 191], '`': ['Backquote', 192],
  };
  const SHIFTED = {
    '!': ['Digit1', 49], '@': ['Digit2', 50], '#': ['Digit3', 51], $: ['Digit4', 52], '%': ['Digit5', 53],
    '^': ['Digit6', 54], '&': ['Digit7', 55], '*': ['Digit8', 56], '(': ['Digit9', 57], ')': ['Digit0', 48],
    _: ['Minus', 189], '+': ['Equal', 187], '{': ['BracketLeft', 219], '}': ['BracketRight', 221],
    '|': ['Backslash', 220], ':': ['Semicolon', 186], '"': ['Quote', 222], '<': ['Comma', 188], '>': ['Period', 190],
    '?': ['Slash', 191], '~': ['Backquote', 192],
  };
  const NAMED = {
    Enter: { key: 'Enter', code: 'Enter', keyCode: 13, charCode: 13 },
    Escape: { key: 'Escape', code: 'Escape', keyCode: 27, charCode: 0 },
    Shift: { key: 'Shift', code: 'ShiftLeft', keyCode: 16, charCode: 0, location: 1 },
    Control: { key: 'Control', code: 'ControlLeft', keyCode: 17, charCode: 0, location: 1 },
    Meta: { key: 'Meta', code: 'MetaLeft', keyCode: 91, charCode: 0, location: 1 },
    // The keys a host may press (src/runtime.js pressKey): focus, scrolling and list navigation.
    Tab: { key: 'Tab', code: 'Tab', keyCode: 9, charCode: 0 },
    Space: { key: ' ', code: 'Space', keyCode: 32, charCode: 32 },
    ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38, charCode: 0 },
    ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, charCode: 0 },
    ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37, charCode: 0 },
    ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, charCode: 0 },
    Home: { key: 'Home', code: 'Home', keyCode: 36, charCode: 0 },
    End: { key: 'End', code: 'End', keyCode: 35, charCode: 0 },
    PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33, charCode: 0 },
    PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34, charCode: 0 },
  };

  function keyFor(ch) {
    const point = ch.codePointAt(0);
    if (ch === '\n') return { ...NAMED.Enter, shift: false };
    if (/^[a-z]$/.test(ch)) return { key: ch, code: `Key${ch.toUpperCase()}`, keyCode: point - 32, charCode: point, shift: false };
    if (/^[A-Z]$/.test(ch)) return { key: ch, code: `Key${ch}`, keyCode: point, charCode: point, shift: true };
    if (/^[0-9]$/.test(ch)) return { key: ch, code: `Digit${ch}`, keyCode: point, charCode: point, shift: false };
    if (PLAIN[ch]) return { key: ch, code: PLAIN[ch][0], keyCode: PLAIN[ch][1], charCode: point, shift: false };
    if (SHIFTED[ch]) return { key: ch, code: SHIFTED[ch][0], keyCode: SHIFTED[ch][1], charCode: point, shift: true };
    // Outside the US layout (accents, other scripts): the character as the key, no physical key code.
    return { key: ch, code: '', keyCode: 0, charCode: point, shift: false };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Typing rhythm: when each key of a fill goes down and comes up, planned before the first key (pure: no DOM, no
  // timers, `random` injectable so test/typing-rhythm.test.js runs it seeded). Shaped on keystroke studies of fast
  // typists rather than a steady metronome:
  // - a typist per session (config.rhythmSeed, one per lease): the median keydown-to-keydown interval (IKI) and key
  //   hold, drawn once, so pace differs between tasks and stays put within one;
  // - log-normal (right-skewed) intervals around that median, scaled by context: common English bigrams and a change
  //   of hand are quicker; the same finger on another key, Shift, digits, symbols and keys outside the US layout
  //   slower; a new word, the key after punctuation and the start of a new burst (keys come in runs of 3-8) later;
  // - rare hesitations (2% of keys, 250-550 ms, at most 600 ms per fill);
  // - holds log-normal on their own, so a key can still be down when the next goes down (rollover), never across a
  //   Shift change, on the same key twice, or for Enter, Backspace and keys outside the US layout; at most two keys
  //   down; where a key must be up first, a flight time of its own before the next goes down;
  // - every bound is a truncated draw or a per-key random margin, never a clamp: no time shows up exactly at a limit;
  // - now and then (slips: letters only, outside secrets and fields where a wrong key could do harm) a neighbouring
  //   key, a beat to notice it, Backspace and the right key; a quarter of the time one more key goes in first, so two
  //   Backspaces and both keys again.
  // A secret (fill_secret, a password field) is planned blind: every draw from its length alone (no context, no slips,
  // no rollover, a Shift slot drawn for every key whether used or not), so neither the time a fill took nor how much
  // was typed says more than its length.
  // ---------------------------------------------------------------------------------------------------------------

  const RHYTHM = {
    iki: [75, 108], // session median IKI range (ms, log-uniform): with the context factors about 95-120 WPM overall
    hold: [62, 92], // session median hold range (ms, log-uniform)
    ikiSigma: 0.3,
    holdSigma: 0.22,
    ikiMin: 35, // intervals and holds are drawn within these (truncated: redrawn, never clamped)
    ikiMax: 650,
    holdMin: 30,
    holdMax: 180,
    flight: [12, 14, 0.55], // keyup to the next keydown where the key must be up first: floor + log-normal(median, sigma)
    pad: [3, 12], // a per-key margin over `sep` and holdMin wherever events are pushed apart: low + exponential(mean)
    burst: [3, 8], // keys per burst
    inBurst: 0.92,
    burstStart: 1.3,
    bigram: 0.8,
    alternate: 0.88,
    sameFinger: 1.3,
    sameKey: 1.05,
    shift: 1.35,
    shiftRun: 1.1,
    digit: 1.25,
    digitRun: 1.1,
    symbol: 1.25,
    foreign: 1.4,
    enter: 1.6,
    wordStart: 1.3,
    afterPunctuation: 1.5,
    floor: 0.62, // lowest combined context factor
    hesitation: 0.02, // chance per key
    hesitationMs: [250, 550],
    hesitationCap: 600, // most hesitation per fill
    lead: 45, // median Shift lead before its key (ms)
    sep: 8, // least time between two key events
    blindIkiMin: 45,
    shiftAt: [0.3, 0.7], // where a blind plan's Shift sits in the gap before its key
    slack: 1.4, // a whole value is typed when its plan is within budget * slack
    fullChars: 14, // a value this short is always typed in full (without hesitations and slips when they do not fit)
    slip: 1 / 45, // chance of a slip per eligible letter: about one per 60 characters typed
    slipMinLength: 6,
    slipMax: [1, 2], // most slips per fill: under 40 characters, from 40
    slipLate: 0.25, // one more key goes in before the slip is noticed
    notice: [150, 350, 240], // the beat before the Backspace: truncated log-normal (low, high, median)
    back: 1.1, // Backspace's own interval factor; a second one comes quicker
    backRun: 0.85,
    retype: 1.2, // the right key after Backspace
  };

  // Common English bigrams (letters, either case): the hands know them.
  const BIGRAMS = new Set(('th he in er an re on at en nd ti es or te of ed is it al ar st to nt ng se ha as ou io le ve co '
    + 'me de hi ri ro ic ne ea ra ce li ch ll be ma si om ur').split(' '));
  // Touch-typing fingers on a US keyboard, by physical key: hand (L/R) and finger 0-3 (pinky to index).
  const FINGERS = {};
  for (const [finger, codes] of Object.entries({
    L0: 'Backquote Digit1 KeyQ KeyA KeyZ', L1: 'Digit2 KeyW KeyS KeyX', L2: 'Digit3 KeyE KeyD KeyC',
    L3: 'Digit4 Digit5 KeyR KeyT KeyF KeyG KeyV KeyB', R3: 'Digit6 Digit7 KeyY KeyU KeyH KeyJ KeyN KeyM',
    R2: 'Digit8 KeyI KeyK Comma', R1: 'Digit9 KeyO KeyL Period',
    R0: 'Digit0 Minus Equal KeyP BracketLeft BracketRight Backslash Semicolon Quote Slash Backspace',
  })) for (const code of codes.split(' ')) FINGERS[code] = finger;
  const PUNCTUATION = /^[.,;:!?)]$/;
  // The letters next to each letter on a QWERTY keyboard: the keys a slip lands on.
  const NEIGHBOURS = {
    q: 'wa', w: 'qeas', e: 'wrsd', r: 'etdf', t: 'ryfg', y: 'tugh', u: 'yihj', i: 'uojk', o: 'ipkl', p: 'ol',
    a: 'qwsz', s: 'awedxz', d: 'serfcx', f: 'drtgvc', g: 'ftyhbv', h: 'gyujnb', j: 'huikmn', k: 'jiolm', l: 'kop',
    z: 'asx', x: 'zsdc', c: 'xdfv', v: 'cfgb', b: 'vghn', n: 'bhjm', m: 'njk',
  };
  const BACKSPACE = { key: 'Backspace', code: 'Backspace', keyCode: 8, charCode: 0 };

  // A small seeded generator (mulberry32): the session's draws, and the tests' per-key draws.
  function seeded(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** The typist of a session: median IKI and hold (ms), drawn once from `seed`. */
  function rhythmSession(seed) {
    const draw = seeded(seed || 1);
    const logUniform = ([low, high]) => low * (high / low) ** draw();
    return { iki: logUniform(RHYTHM.iki), hold: logUniform(RHYTHM.hold) };
  }

  function describeKey(ch) {
    if (ch === '\b') return { ch, shift: false, kind: 'back', id: 'Backspace', finger: 'R0', hand: 'R' };
    const key = keyFor(ch);
    const kind = ch === ' ' ? 'space' : ch === '\n' ? 'enter' : /^[a-z]$/i.test(ch) ? 'letter' : /^[0-9]$/.test(ch) ? 'digit'
      : key.code ? 'symbol' : 'foreign';
    const finger = FINGERS[key.code] ?? null;
    return { ch, shift: key.shift, kind, id: key.code || ch, finger, hand: finger?.[0] ?? null };
  }

  // How much slower (above 1) or quicker this key comes after `prev`.
  function contextFactor(prev, key) {
    if (!prev) return 1;
    if (key.kind === 'back') return prev.kind === 'back' ? RHYTHM.backRun : RHYTHM.back;
    let f = prev.kind === 'back' ? RHYTHM.retype : 1;
    if (key.kind === 'letter' && prev.kind === 'letter' && BIGRAMS.has((prev.ch + key.ch).toLowerCase())) f *= RHYTHM.bigram;
    if (prev.hand && key.hand) {
      if (prev.id === key.id) f *= RHYTHM.sameKey;
      else if (prev.finger === key.finger) f *= RHYTHM.sameFinger;
      else if (prev.hand !== key.hand) f *= RHYTHM.alternate;
    }
    if (key.shift) f *= prev.shift ? RHYTHM.shiftRun : RHYTHM.shift;
    if (key.kind === 'digit') f *= prev.kind === 'digit' ? RHYTHM.digitRun : RHYTHM.digit;
    if (key.kind === 'symbol') f *= RHYTHM.symbol;
    if (key.kind === 'foreign') f *= RHYTHM.foreign;
    if (key.kind === 'enter' || prev.kind === 'enter') f *= RHYTHM.enter;
    if (prev.kind === 'space' && key.kind !== 'space') f *= RHYTHM.wordStart;
    if (PUNCTUATION.test(prev.ch)) f *= RHYTHM.afterPunctuation;
    return Math.max(RHYTHM.floor, f);
  }

  // Where slips go: { index -> { wrong, late } }, on letters away from both ends, at most slipMax per fill.
  function chooseSlips(keys, random, rate) {
    const slips = new Map();
    if (keys.length < RHYTHM.slipMinLength || !(rate > 0)) return slips;
    const most = keys.length >= 40 ? RHYTHM.slipMax[1] : RHYTHM.slipMax[0];
    for (let i = 1; i < keys.length - 1 && slips.size < most; i++) {
      const lower = keys[i].ch.toLowerCase();
      if (keys[i].kind !== 'letter' || !NEIGHBOURS[lower] || random() >= rate) continue;
      const late = random() < RHYTHM.slipLate && i + 2 < keys.length && keys[i + 1].kind === 'letter';
      const options = NEIGHBOURS[lower];
      const wrong = options[Math.floor(random() * options.length)];
      slips.set(i, { wrong: keys[i].ch === lower ? wrong : wrong.toUpperCase(), late });
      i += late ? 3 : 2;
    }
    return slips;
  }

  // The keystrokes of a plan: each key once, or for a slip the wrong key, Backspace and the right key again.
  // { key, ch, index (the character it types; none for Backspace), wrong?, back?, notice? }
  function strokesOf(keys, slips = new Map()) {
    const strokes = [];
    const back = describeKey('\b');
    const plain = index => ({ key: keys[index], ch: keys[index].ch, index });
    for (let i = 0; i < keys.length; i++) {
      const slip = slips.get(i);
      if (!slip) {
        strokes.push(plain(i));
        continue;
      }
      strokes.push({ key: describeKey(slip.wrong), ch: slip.wrong, index: i, wrong: true, slip: true });
      if (slip.late) strokes.push({ ...plain(i + 1), wrong: true });
      strokes.push({ key: back, ch: '\b', back: true, notice: true });
      if (slip.late) strokes.push({ key: back, ch: '\b', back: true });
      strokes.push(plain(i));
      if (slip.late) strokes.push(plain(++i));
    }
    return strokes;
  }

  // The random part of a plan, stroke by stroke: interval before it (and any hesitation apart), hold, Shift lead,
  // flight, the margins where events are pushed apart, and the blind Shift slot.
  function rhythmDraws(strokes, session, random, blind) {
    const normal = () => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
    // A log-normal draw kept within [low, high] by drawing again (no pile-up at a bound).
    const logNormal = (median, sigma, low, high) => {
      for (let tries = 0; tries < 16; tries++) {
        const value = median * Math.exp(sigma * normal());
        if (value >= low && value <= high) return value;
      }
      return low + random() * (high - low);
    };
    const exponential = mean => -mean * Math.log(1 - random());
    const pad = () => RHYTHM.pad[0] + exponential(RHYTHM.pad[1]);
    const out = { iki: [], extra: [], hold: [], lead: [], flight: [], pad: [], shiftAt: [], bursts: [], start: 0, tail: 0, shiftEnd: 0 };
    let burstLeft = 0;
    let hesitated = 0;
    for (let i = 0; i < strokes.length; i++) {
      const stroke = strokes[i];
      const key = stroke.key;
      const prev = strokes[i - 1]?.key;
      let f = blind ? 1 : contextFactor(prev, key);
      const wordStart = !blind && prev?.kind === 'space' && key.kind !== 'space';
      if (i === 0 || wordStart || burstLeft <= 0) {
        out.bursts.push(i);
        burstLeft = RHYTHM.burst[0] + Math.floor(random() * (RHYTHM.burst[1] - RHYTHM.burst[0] + 1));
        if (i > 0 && !wordStart) f *= RHYTHM.burstStart;
      } else {
        f *= RHYTHM.inBurst;
      }
      burstLeft--;
      const median = session.iki * f;
      let iki = i === 0 ? 0 : logNormal(median, RHYTHM.ikiSigma, Math.min(blind ? RHYTHM.blindIkiMin : RHYTHM.ikiMin, median * 0.6), RHYTHM.ikiMax);
      if (stroke.notice) iki += logNormal(RHYTHM.notice[2], 0.3, RHYTHM.notice[0], RHYTHM.notice[1]);
      let extra = 0;
      if (i > 0 && !stroke.back && !stroke.wrong && !strokes[i - 1].back && random() < RHYTHM.hesitation) {
        const [low, high] = RHYTHM.hesitationMs;
        extra = Math.max(0, Math.min(low + random() * (high - low), RHYTHM.hesitationCap - hesitated));
        hesitated += extra;
      }
      out.iki.push(iki);
      out.extra.push(extra);
      const space = !blind && key.kind === 'space' ? 0.9 : 1;
      out.hold.push(logNormal(session.hold * space, RHYTHM.holdSigma, RHYTHM.holdMin, RHYTHM.holdMax));
      out.lead.push(logNormal(RHYTHM.lead, 0.3, 20, 90));
      out.flight.push(RHYTHM.flight[0] + logNormal(RHYTHM.flight[1], RHYTHM.flight[2], 0, 120));
      out.pad.push({ two: pad(), order: pad(), gap: pad(), mod: pad(), hold: pad() });
      out.shiftAt.push(RHYTHM.shiftAt[0] + random() * (RHYTHM.shiftAt[1] - RHYTHM.shiftAt[0]));
    }
    out.start = logNormal(RHYTHM.lead, 0.3, 30, 90);
    out.tail = logNormal(42, 0.3, 30, 75);
    out.shiftEnd = RHYTHM.shiftAt[0] + random() * (RHYTHM.shiftAt[1] - RHYTHM.shiftAt[0]);
    return out;
  }

  const rollable = key => key.kind !== 'enter' && key.kind !== 'foreign' && key.kind !== 'back';

  // The events of the first `count` strokes: { at, type: 'down'|'up'|'shift', index? (stroke), on? }, in time order
  // from 0. `hesitate` false lays them out without the hesitations.
  function rhythmLayout(strokes, d, count, hesitate = true) {
    const { sep } = RHYTHM;
    const events = [];
    let shift = false;
    let last = null; // the previous key: { index, key, down, up (tentative until the next key is placed) }
    let lastUp = -Infinity; // the key before it, already up
    for (let i = 0; i < count; i++) {
      const key = strokes[i].key;
      const pad = d.pad[i];
      const holdFloor = last ? last.down + RHYTHM.holdMin + pad.hold : 0;
      // At most two keys down: the one before the previous is up before this one goes down.
      let down = Math.max(i === 0 ? 0 : last.down + d.iki[i] + (hesitate ? d.extra[i] : 0), lastUp + sep + pad.two);
      const change = key.shift !== shift;
      let mod = change ? down - d.lead[i] : null;
      if (last) {
        last.up = Math.max(last.up, lastUp + sep + pad.order);
        const releaseFirst = change || last.key.id === key.id || !rollable(last.key) || !rollable(key);
        if (releaseFirst) {
          // Up before the Shift change (with a margin), or a flight time before the next key.
          const before = change ? mod - sep - pad.gap : down - d.flight[i];
          if (last.up > before) last.up = Math.max(holdFloor, lastUp + sep + pad.order, before);
          if (last.up > before) {
            const push = last.up - before;
            down += push;
            if (mod !== null) mod += push;
          }
        } else if (Math.abs(last.up - down) < sep + pad.gap) {
          const earlier = down - sep - pad.gap;
          last.up = earlier >= holdFloor && earlier >= lastUp + sep + pad.order ? earlier : down + sep + pad.gap;
        }
        events.push({ at: last.up, type: 'up', index: last.index });
        lastUp = last.up;
      }
      if (mod !== null) {
        if (last) mod = Math.max(mod, last.down + sep + pad.mod);
        down = Math.max(down, mod + 15 + pad.mod);
        events.push({ at: mod, type: 'shift', on: key.shift });
        shift = key.shift;
      }
      events.push({ at: down, type: 'down', index: i });
      last = { index: i, key, down, up: down + d.hold[i] };
    }
    if (last) {
      last.up = Math.max(last.up, lastUp + sep + d.pad[last.index].order);
      events.push({ at: last.up, type: 'up', index: last.index });
      if (shift) events.push({ at: last.up + d.tail, type: 'shift', on: false });
    }
    events.sort((a, b) => a.at - b.at);
    const base = events.length ? events[0].at : 0;
    for (const event of events) event.at -= base;
    return { events, total: events.length ? events.at(-1).at : 0 };
  }

  // A secret's events: every time from draws made for every key alike (an interval, a flight after the key before
  // is up, a hold of its own, a Shift slot used or not), and a total that does not depend on which keys needed Shift.
  function rhythmLayoutBlind(strokes, d, count, hesitate = true) {
    const events = [];
    let shift = false;
    let down = d.start;
    let prevDown = 0;
    let prevUp = 0;
    for (let i = 0; i < count; i++) {
      if (i > 0) down = Math.max(prevDown + d.iki[i] + (hesitate ? d.extra[i] : 0), prevUp + 2 * RHYTHM.sep + d.flight[i]);
      if (strokes[i].key.shift !== shift) {
        shift = !shift;
        events.push({ at: prevUp + d.shiftAt[i] * (down - prevUp), type: 'shift', on: shift });
      }
      const up = down + d.hold[i];
      events.push({ at: down, type: 'down', index: i }, { at: up, type: 'up', index: i });
      prevDown = down;
      prevUp = up;
    }
    if (shift) events.push({ at: prevUp + d.shiftEnd * d.tail, type: 'shift', on: false });
    events.sort((a, b) => a.at - b.at);
    return { events, total: count ? prevUp + d.tail : 0 };
  }

  /**
   * The plan for typing `text`: { events, total, typed, chunked, blind, strokes ([{ ch, back?, index? }], what each
   * event's `index` presses), bursts (stroke indices that start one), slips, hesitations, hesitationMs (within what is
   * typed) }. A value within maxTyped is typed in full when its plan fits within budgetMs * RHYTHM.slack, dropping
   * first its hesitations, then its slips, to fit (and always, without them, up to RHYTHM.fullChars characters); else
   * the longest prefix whose plan (no slips) fits within budgetMs is typed and the rest goes in as one insertion. `slips` allows slips (never with `blind`); `slipRate` overrides
   * their chance per letter.
   */
  function typingPlan(text, { session = rhythmSession(1), random = Math.random, budgetMs = config.typeBudgetMs,
    maxTyped = config.maxTyped, blind = false, slips = false, slipRate = RHYTHM.slip } = {}) {
    const chars = Array.from(text);
    const n = Math.max(0, Math.min(chars.length, maxTyped));
    const keys = chars.slice(0, n).map(describeKey);
    const lay = blind ? rhythmLayoutBlind : rhythmLayout;
    const make = (strokes, d, count, hesitate) => ({ ...lay(strokes, d, count, hesitate), strokes, d, count, hesitate });
    const whole = n === chars.length;
    const candidates = [];
    const chosenSlips = whole && slips && !blind ? chooseSlips(keys, random, slipRate) : new Map();
    if (chosenSlips.size) {
      const strokes = strokesOf(keys, chosenSlips);
      const d = rhythmDraws(strokes, session, random, blind);
      candidates.push(make(strokes, d, strokes.length, true), make(strokes, d, strokes.length, false));
    }
    const plain = strokesOf(keys);
    const d = rhythmDraws(plain, session, random, blind);
    if (whole) candidates.push(make(plain, d, n, true), make(plain, d, n, false));
    let plan = candidates.find(candidate => candidate.total <= budgetMs * RHYTHM.slack);
    if (!plan && whole && n <= RHYTHM.fullChars && budgetMs > 0) plan = candidates.at(-1);
    if (!plan) {
      let count = n;
      plan = make(plain, d, count, true);
      while (count > 0 && plan.total > budgetMs) plan = make(plain, d, --count, true);
    }
    const strokes = plan.strokes.slice(0, plan.count);
    const typed = strokes.reduce((most, stroke) => (stroke.back ? most : Math.max(most, stroke.index + 1)), 0);
    const extras = plan.hesitate ? plan.d.extra.slice(0, plan.count).filter(ms => ms > 0) : [];
    return {
      events: plan.events, total: plan.total, typed, chunked: typed < chars.length, blind,
      strokes: strokes.map(stroke => ({ ch: stroke.ch, ...(stroke.back ? { back: true } : { index: stroke.index }) })),
      bursts: plan.d.bursts.filter(i => i < plan.count),
      slips: strokes.filter(stroke => stroke.slip).length,
      hesitations: extras.length, hesitationMs: extras.reduce((sum, ms) => sum + ms, 0),
    };
  }

  // The session's typist (config.rhythmSeed, else this document's own seed).
  const documentSeed = (Math.floor(Math.random() * 2 ** 32) >>> 0) || 1;
  let typist = null;
  function currentTypist() {
    const seed = config.rhythmSeed || documentSeed;
    if (typist?.seed !== seed) typist = { seed, session: rhythmSession(seed) };
    return typist.session;
  }
  // Per-key draws: Math.random, or (config.keySeed, a test hook) a seeded sequence, one per fill.
  let keySeedFills = 0;
  function keyRandom() {
    return config.keySeed ? seeded(config.keySeed + keySeedFills++) : Math.random;
  }

  function fireKey(el, type, key, mods = {}) {
    const press = type === 'keypress';
    const code = press ? key.charCode : key.keyCode;
    return fire(el, type, 'KeyboardEvent', {
      bubbles: true, cancelable: true, composed: true, view: viewOf(el),
      key: key.key, code: key.code, location: key.location ?? 0, repeat: false, isComposing: false,
      keyCode: code, which: code, charCode: press ? key.charCode : 0,
      shiftKey: Boolean(mods.shift), ctrlKey: Boolean(mods.ctrl), metaKey: Boolean(mods.meta), altKey: false,
    });
  }

  function valueSetter(el) {
    const realm = viewOf(el);
    const prototype = el.tagName === 'TEXTAREA' ? realm.HTMLTextAreaElement.prototype : realm.HTMLInputElement.prototype;
    return Object.getOwnPropertyDescriptor(prototype, 'value').set;
  }

  // The part of `text` that fits in `room` UTF-16 units (maxlength counts them), never half a surrogate pair.
  function fitUnits(text, room) {
    let fit = '';
    for (const ch of text) {
      if (fit.length + ch.length > room) break;
      fit += ch;
    }
    return fit;
  }

  // Where an edit lands: over the selection (all of it right after select-all), else at the caret, else at the end (an
  // email or number field has no caret API).
  function editRange(el, state) {
    const length = el.value.length;
    if (state.replaceAll) return { start: 0, end: length };
    try {
      if (typeof el.selectionStart === 'number') return { start: el.selectionStart, end: el.selectionEnd };
    } catch {
      // No selection API on this input type.
    }
    return { start: length, end: length };
  }

  function setValue(el, value, caret) {
    valueSetter(el).call(el, value);
    try {
      el.setSelectionRange(caret, caret);
    } catch {
      // No selection API on this input type.
    }
  }

  // Inserts `data` where a keystroke would (editRange), with the native setter, so a framework's controlled input sees
  // the change on the input event that follows. Returns false when maxlength leaves no room.
  function insert(el, data, state) {
    const value = el.value;
    const { start, end } = editRange(el, state);
    let text = data;
    if (el.maxLength >= 0) {
      text = fitUnits(text, el.maxLength - (value.length - (end - start)));
      if (!text) return false;
    }
    state.replaceAll = false;
    setValue(el, value.slice(0, start) + text + value.slice(end), start + text.length);
    return true;
  }

  // beforeinput, the insertion, input: what a keystroke (or an IME commit, for a longer `data`) does to a field.
  function inputText(el, data, state) {
    const view = viewOf(el);
    const lineBreak = data === '\n';
    const init = { bubbles: true, composed: true, view, inputType: lineBreak ? 'insertLineBreak' : 'insertText', data: lineBreak ? null : data };
    if (!fire(el, 'beforeinput', 'InputEvent', { ...init, cancelable: true })) return;
    if (!el.isConnected || !insert(el, data, state)) return;
    fire(el, 'input', 'InputEvent', { ...init, cancelable: false });
  }

  // What Backspace does to a field: beforeinput, the selection or the character before the caret removed, input.
  function deleteBackward(el, state) {
    const init = { bubbles: true, composed: true, view: viewOf(el), inputType: 'deleteContentBackward', data: null };
    if (!fire(el, 'beforeinput', 'InputEvent', { ...init, cancelable: true }) || !el.isConnected) return;
    const value = el.value;
    let { start, end } = editRange(el, state);
    state.replaceAll = false;
    if (start === end) {
      if (start === 0) return;
      const pair = start >= 2 && /[\uDC00-\uDFFF]/.test(value[start - 1]) && /[\uD800-\uDBFF]/.test(value[start - 2]);
      start -= pair ? 2 : 1;
    }
    setValue(el, value.slice(0, start) + value.slice(end), start);
    fire(el, 'input', 'InputEvent', { ...init, cancelable: false });
  }

  async function shortcut(el, letter, state) {
    const mod = MAC ? NAMED.Meta : NAMED.Control;
    const mods = MAC ? { meta: true } : { ctrl: true };
    fireKey(el, 'keydown', mod, mods);
    await pause(jitter(60, 30, 20));
    const key = { key: letter, code: `Key${letter.toUpperCase()}`, keyCode: letter.toUpperCase().charCodeAt(0), charCode: 0 };
    const proceed = fireKey(el, 'keydown', key, mods);
    if (proceed) state.onShortcut?.();
    await pause(jitter(55, 25, 20));
    fireKey(el, 'keyup', key, mods);
    await pause(jitter(40, 20, 10));
    fireKey(el, 'keyup', mod, {});
    return proceed;
  }

  // Ctrl/Cmd+A, synthetic: the page's own handlers see it, and the field's whole value is what the next edit replaces.
  async function selectAll(el, state) {
    state.onShortcut = () => {
      try {
        el.select();
      } catch {
        // Not selectable; the next edit still replaces everything.
      }
      state.replaceAll = true;
    };
    await shortcut(el, 'a', state);
    delete state.onShortcut;
  }

  // CDP modifier bits.
  const CDP_CTRL = 2;
  const CDP_META = 4;
  const CDP_SHIFT = 8;

  // Trusted Ctrl/Cmd+A steps.
  function trustedSelectAll() {
    const mod = MAC ? NAMED.Meta : NAMED.Control;
    const bit = MAC ? CDP_META : CDP_CTRL;
    return [{ m: 'key', type: 'rawKeyDown', key: mod.key, code: mod.code, keyCode: mod.keyCode, modifiers: bit },
      { wait: Math.round(jitter(60, 30, 20)) },
      { m: 'key', type: 'rawKeyDown', key: 'a', code: 'KeyA', keyCode: 65, modifiers: bit, commands: ['selectAll'] },
      { wait: Math.round(jitter(55, 25, 20)) },
      { m: 'key', type: 'keyUp', key: 'a', code: 'KeyA', keyCode: 65, modifiers: bit },
      { m: 'key', type: 'keyUp', key: mod.key, code: mod.code, keyCode: mod.keyCode, modifiers: 0 },
      { wait: Math.round(jitter(60, 30, 15)) }];
  }

  const trustedBackspace = (type, modifiers = 0) => ({ m: 'key', type, key: 'Backspace', code: 'Backspace', keyCode: 8, modifiers });

  // The trusted-input steps of a plan: its events with the waits between them (none over TRUSTED_WAIT_MS; the
  // worker's limit is 600), Shift, keys and Backspace as the browser's own.
  const TRUSTED_WAIT_MS = 500;
  function rhythmSteps(chars, plan) {
    const steps = [];
    let clock = 0;
    let shift = false;
    const waitUntil = at => {
      let ms = Math.round(at) - clock;
      clock += Math.max(0, ms);
      for (; ms > 0; ms -= TRUSTED_WAIT_MS) steps.push({ wait: Math.min(ms, TRUSTED_WAIT_MS) });
    };
    for (const event of plan.events) {
      waitUntil(event.at);
      if (event.type === 'shift') {
        shift = event.on;
        steps.push({ m: 'key', type: shift ? 'rawKeyDown' : 'keyUp', key: 'Shift', code: 'ShiftLeft', keyCode: 16, modifiers: shift ? CDP_SHIFT : 0 });
        continue;
      }
      const stroke = plan.strokes[event.index];
      const modifiers = shift ? CDP_SHIFT : 0;
      if (stroke.back) {
        steps.push(trustedBackspace(event.type === 'down' ? 'rawKeyDown' : 'keyUp', modifiers));
        continue;
      }
      const key = keyFor(stroke.ch);
      steps.push(event.type === 'down'
        ? { m: 'key', type: 'keyDown', key: key.key, code: key.code, keyCode: key.keyCode, text: stroke.ch === '\n' ? '\r' : stroke.ch, modifiers }
        : { m: 'key', type: 'keyUp', key: key.key, code: key.code, keyCode: key.keyCode, modifiers });
    }
    if (plan.blind) waitUntil(plan.total);
    return steps;
  }

  // How far behind its plan typing may fall (a page whose key handlers are slow) before the keys stop and the rest
  // goes in as one insertion: on the synthetic path here, on the trusted path as the worker's deadline.
  const RHYTHM_LATE_MS = 400;
  // A blind plan's trusted call lasts a fixed time from its first step (an `until` step): its planned waits, then
  // this margin plus a share per character for the commands themselves, so the number of Shift changes in a secret
  // does not show in how long it took.
  const BLIND_MARGIN_MS = 100;
  const BLIND_PER_CHAR_MS = 6;

  // Trusted typing: select-all when the field holds something, the plan's keys (or Backspace for an empty value), the
  // rest as one insertText. Null when nothing was dispatched (the synthetic path runs instead); `late` when the worker
  // stopped pressing keys at the deadline.
  async function typeTrusted(el, chars, plan) {
    const steps = el.value ? trustedSelectAll() : [];
    const before = steps.reduce((sum, step) => sum + (step.wait ?? 0), 0);
    if (!chars.length && el.value) {
      steps.push(trustedBackspace('rawKeyDown'), { wait: Math.round(jitter(70, 30, 35)) }, trustedBackspace('keyUp'));
    }
    steps.push(...rhythmSteps(chars, plan));
    if (plan.chunked) steps.push({ wait: Math.round(jitter(60, 30, 15)) }, { m: 'text', text: chars.slice(plan.typed).join('') });
    const planned = steps.reduce((sum, step) => sum + (step.wait ?? 0), 0);
    if (plan.blind) steps.push({ until: planned + BLIND_MARGIN_MS + BLIND_PER_CHAR_MS * chars.length });
    const reply = await sendTrusted(steps, { deadline: before + plan.total + RHYTHM_LATE_MS });
    return reply.dispatched ? { typed: plan.typed, chunked: plan.chunked, late: reply.late === true } : null;
  }

  // Plays a plan's events on `el` against the clock, so a slow handler eats into the next gap instead of adding to
  // it. Stops early, releasing what is held, when the field went away or a key would go down more than
  // RHYTHM_LATE_MS late. Returns { stopped }.
  async function playRhythm(el, plan, state) {
    const started = performance.now();
    const held = new Map();
    let stopped = false;
    for (const event of plan.events) {
      // Behind the plan, still a few ms between two events (never a keyup a moment after a keydown).
      if (event.at > 0) await pause(Math.max(event.at - (performance.now() - started), 6));
      if (!el.isConnected || (event.type === 'down' && performance.now() - started - event.at > RHYTHM_LATE_MS)) {
        stopped = true;
        break;
      }
      if (event.type === 'shift') {
        fireKey(el, event.on ? 'keydown' : 'keyup', NAMED.Shift, { shift: event.on });
        state.shift = event.on;
        continue;
      }
      const stroke = plan.strokes[event.index];
      const key = stroke.back ? BACKSPACE : keyFor(stroke.ch);
      const mods = { shift: state.shift };
      if (event.type === 'down') {
        let proceed = fireKey(el, 'keydown', key, mods);
        if (stroke.back) {
          if (proceed) deleteBackward(el, state);
        } else {
          if (proceed && key.charCode) proceed = fireKey(el, 'keypress', key, mods);
          if (proceed) inputText(el, stroke.ch, state);
        }
        held.set(event.index, key);
      } else if (held.has(event.index)) {
        held.delete(event.index);
        fireKey(el, 'keyup', key, mods);
      }
    }
    if (stopped && (held.size || state.shift)) await pause(RHYTHM.sep + 4);
    for (const key of held.values()) fireKey(el, 'keyup', key, { shift: state.shift });
    if (state.shift) {
      fireKey(el, 'keyup', NAMED.Shift, {});
      state.shift = false;
    }
    if (plan.blind && !stopped) await pause(plan.total - (performance.now() - started));
    return { stopped };
  }

  // The text a field is given: no line break in a single-line input (the browser would drop it, and a keyboard's
  // Enter there submits the form), and a textarea's line breaks as the browser keeps them.
  function fieldText(el, text) {
    return el.tagName === 'TEXTAREA' ? text.replace(/\r\n?/g, '\n') : text.replace(/[\r\n]/g, '');
  }

  // The value the field should end up with: its text, cut to maxlength as typing would.
  function expectedValue(el, text) {
    return el.maxLength >= 0 ? fitUnits(text, el.maxLength) : text;
  }

  // Field types whose value is exactly what was typed (email and url trim their ends).
  const EXACT_TYPES = new Set(['text', 'search', 'tel', 'password', 'email', 'url']);
  function holds(el, expected) {
    if (el.tagName === 'TEXTAREA') return el.value === expected;
    if (el.tagName !== 'INPUT' || !EXACT_TYPES.has(el.type)) return true;
    return el.value === (el.type === 'email' || el.type === 'url' ? expected.trim() : expected);
  }

  // Slips go only where a wrong key and a Backspace can do no harm: plain text, search, email and url inputs and
  // textareas without maxlength (no one-time-code boxes, no truncation), no numeric keyboard, no one-time-code,
  // payment or password autocomplete, and nothing with a suggestion list that could take the Backspace or a wrong
  // suggestion (combobox, aria-autocomplete, a datalist, a popup).
  function slipsAllowed(el) {
    if (el.maxLength >= 0) return false;
    if (el.tagName === 'INPUT' ? !['text', 'search', 'email', 'url'].includes(el.type) : el.tagName !== 'TEXTAREA') return false;
    if (['numeric', 'decimal', 'tel', 'none'].includes((el.getAttribute('inputmode') || '').toLowerCase())) return false;
    if (/one-time-code|cc-|password/.test((el.getAttribute('autocomplete') || '').toLowerCase())) return false;
    const popup = (el.getAttribute('aria-haspopup') || 'false').toLowerCase();
    return el.getAttribute('role') !== 'combobox' && (el.getAttribute('aria-autocomplete') || 'none').toLowerCase() === 'none'
      && !el.hasAttribute('list') && popup === 'false';
  }

  // After the keys: a fill that stopped early gets the rest of its text (inserted at the end when what the field
  // shows is the start of it); then, when the field does not hold exactly the value (a page's formatter or
  // autocomplete, a key it swallowed), one correction: select all and insert the value (Backspace for an empty one).
  // Trusted when the keys were. Resolves whether it corrected.
  async function completeValue(el, expected, { stopped, trusted }) {
    if (!el.isConnected) return false;
    if (stopped && el.value !== expected && expected.startsWith(el.value)) {
      const rest = expected.slice(el.value.length);
      const done = trusted && (await sendTrusted([{ wait: Math.round(jitter(40, 20, 15)) }, { m: 'text', text: rest }])).dispatched;
      if (!done) {
        await pause(jitter(40, 20, 15));
        const state = { replaceAll: false };
        try {
          el.setSelectionRange(el.value.length, el.value.length);
        } catch {
          // No caret API: the insertion goes to the end anyway.
        }
        inputText(el, rest, state);
      }
    }
    if (!el.isConnected || holds(el, expected)) return false;
    if (trusted) {
      const steps = [...trustedSelectAll(), expected ? { m: 'text', text: expected } : trustedBackspace('rawKeyDown'),
        ...(expected ? [] : [{ wait: Math.round(jitter(70, 30, 35)) }, trustedBackspace('keyUp')])];
      if ((await sendTrusted(steps)).dispatched) return true;
    }
    const state = { replaceAll: false };
    await selectAll(el, state);
    if (expected) inputText(el, expected, state);
    else deleteBackward(el, state);
    return true;
  }

  /**
   * Types `text` into a text field as a keyboard does: focus it with a click if it is not focused, select what it
   * holds (Ctrl/Cmd+A), then per keystroke Shift as needed, keydown, keypress, beforeinput, the insertion, input and
   * keyup (Backspace: keydown, beforeinput, the deletion, input, keyup), with the session's typing rhythm (typingPlan);
   * past the typing budget the rest goes in as one insertion. An empty text clears the field (select-all, Backspace).
   * A single-line input gets no line breaks. A key the page cancels inserts nothing, as for a person. change is left
   * for the blur or Enter that follows (commitPending).
   * The field is then read back: not holding exactly the value, it is corrected once (completeValue; `corrected`).
   * `kept()` says whether the field shows the text afterwards; when it does not (a page that swallowed the keys, or
   * a field that was replaced), `fallback()` sets the value the plain way and the pending change is dropped (the
   * fallback fires its own).
   * `secret` (fill_secret; a password field counts as one) plans the rhythm blind, with no slips.
   * Resolves { typed, chunked, slips, corrected, fallback, ms }.
   */
  async function type(el, text, { kept = () => true, fallback = null, secret = false } = {}) {
    const started = performance.now();
    await think();
    const doc = el.ownerDocument;
    if (deepActive(doc) !== el) await click(el, { think: false });
    if (el.isConnected && deepActive(doc) !== el) {
      commitPending(el);
      el.focus({ preventScroll: true });
    }
    if (!pending || pending.el !== el) {
      commitPending(el);
      pending = { el, start: el.value };
      watchBlur(viewOf(el));
    }
    const value = fieldText(el, text);
    const chars = Array.from(value);
    const expected = expectedValue(el, value);
    const blind = secret || el.type === 'password';
    const plan = typingPlan(value, {
      session: currentTypist(), random: keyRandom(), blind, slips: !blind && slipsAllowed(el),
      slipRate: Number.isFinite(config.slipRate) ? config.slipRate : RHYTHM.slip,
    });
    let result = null;
    if (config.trusted && deepActive(doc) === el) {
      const trusted = await typeTrusted(el, chars, plan);
      if (trusted) {
        // The browser fires change itself on the blur or Enter that follows trusted typing.
        if (pending?.el === el) pending = null;
        const corrected = await completeValue(el, expected, { stopped: trusted.late, trusted: true });
        result = { typed: trusted.typed, chunked: trusted.chunked, slips: trusted.late ? 0 : plan.slips, corrected, trusted: true };
      }
    }
    if (!result) {
      const state = { replaceAll: false, shift: false };
      if (el.value) {
        await pause(jitter(90, 40, 30));
        await selectAll(el, state);
      }
      let stopped = false;
      if (!chars.length) {
        if (el.value) {
          if (fireKey(el, 'keydown', BACKSPACE)) deleteBackward(el, state);
          await pause(jitter(70, 30, 35));
          fireKey(el, 'keyup', BACKSPACE);
        }
      } else {
        ({ stopped } = await playRhythm(el, plan, state));
        if (plan.chunked && !stopped && el.isConnected) {
          await pause(jitter(60, 30, 15));
          inputText(el, chars.slice(plan.typed).join(''), state);
        }
      }
      const corrected = await completeValue(el, expected, { stopped, trusted: false });
      result = { typed: plan.typed, chunked: plan.chunked && el.isConnected, slips: stopped ? 0 : plan.slips, corrected };
    }
    let fellBack = false;
    if (fallback && !kept()) {
      fallback();
      fellBack = true;
      if (pending?.el === el) pending = null;
    }
    return finish(started, { ...result, fallback: fellBack });
  }

  /**
   * Enter in a field: keydown, keypress, then (unless the page cancelled either) the change the typing earned and
   * `onEnter()` (the caller's implicit submission), then keyup. Resolves { proceeded, ms }.
   */
  async function enter(el, onEnter = () => {}) {
    const started = performance.now();
    await think();
    const doc = el.ownerDocument;
    if (deepActive(doc) !== el) {
      commitPending(el);
      el.focus({ preventScroll: true });
    }
    if (config.trusted) {
      // The browser's own Enter: its keypress runs the implicit submission itself, so onEnter is not called.
      const reply = await sendTrusted([
        { m: 'key', type: 'keyDown', key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
        { wait: Math.round(jitter(70, 30, 25)) },
        { m: 'key', type: 'keyUp', key: 'Enter', code: 'Enter', keyCode: 13 },
      ]);
      if (reply.dispatched) {
        pending = null;
        return finish(started, { proceeded: true, trusted: true });
      }
    }
    let proceeded = fireKey(el, 'keydown', NAMED.Enter);
    if (proceeded) proceeded = fireKey(el, 'keypress', NAMED.Enter);
    if (proceeded) {
      if (pending?.el === el) {
        const { start } = pending;
        pending = null;
        if (el.value !== start) fire(el, 'change', 'Event', { bubbles: true, cancelable: false });
      }
      onEnter();
    }
    // The keyup comes after the submit: a navigation it started is not waited for (the caller reads its listeners).
    const keyup = () => { if (el.isConnected) fireKey(el, 'keyup', NAMED.Enter); };
    if (document.hidden || !config.enabled) keyup();
    else setTimeout(keyup, Math.round(jitter(70, 30, 25)));
    return finish(started, { proceeded });
  }

  // The focusable elements of a document in Tab order (positive tabindex first, then document order), visible ones only.
  function tabOrder(doc) {
    const all = Array.from(doc.querySelectorAll(FOCUSABLE)).slice(0, 2000)
      .filter(node => !disabled(node) && node.tabIndex >= 0 && node.getClientRects().length > 0);
    const positive = all.filter(node => node.tabIndex > 0).sort((a, b) => a.tabIndex - b.tabIndex);
    return [...positive, ...all.filter(node => node.tabIndex === 0)];
  }

  function editable(el) {
    return Boolean(el) && (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT'
      || (el.tagName === 'INPUT' && !['button', 'checkbox', 'radio', 'submit', 'reset', 'image', 'file', 'range', 'color'].includes(el.type)));
  }

  // What the browser itself does after an uncancelled synthetic key (which it never does for one): Tab moves focus,
  // the paging keys scroll the page outside a field, Space activates a focused button, checkbox or radio (the caller
  // has cleared that control) or scrolls the page. Ctrl/Cmd shortcuts have no default here: the page's own handlers
  // are what a shortcut is for.
  function keyDefault(el, name, mods) {
    const doc = el.ownerDocument;
    const view = viewOf(el);
    if (name === 'Tab') {
      const order = tabOrder(doc);
      if (!order.length) return;
      const at = order.indexOf(deepActive(doc));
      const next = mods.shift ? order[(at <= 0 ? order.length : at) - 1] : order[(at + 1) % order.length];
      commitPending(next);
      next.focus();
      return;
    }
    if (editable(el)) return;
    if (name === 'Space' && el !== doc.body && el !== doc.documentElement
      && (el.tagName === 'BUTTON' || ['checkbox', 'radio', 'button', 'submit', 'reset'].includes(el.type) || el.getAttribute('role') === 'button')) {
      keyboardClick(el);
      return;
    }
    const page = view.innerHeight * 0.875;
    const scroll = { ArrowDown: 40, ArrowUp: -40, PageDown: page, PageUp: -page, Space: mods.shift ? -page : page }[name];
    if (scroll) view.scrollBy({ top: scroll, behavior: 'instant' });
    else if (name === 'Home') view.scrollTo({ top: 0, behavior: 'instant' });
    else if (name === 'End') view.scrollTo({ top: doc.documentElement.scrollHeight, behavior: 'instant' });
  }

  /**
   * A named key pressed and released on `el` (Escape, Tab, arrows, Home, End, PageUp, PageDown, Space; a letter or
   * digit with `mods.ctrl`/`mods.meta`), with Shift/Ctrl/Meta held around it as a keyboard does, and the key's default
   * action (keyDefault) when the page did not cancel it. Resolves { proceeded, ms }.
   */
  async function press(el, name, mods = {}) {
    const started = performance.now();
    await think();
    const key = NAMED[name] ?? (/^[a-z0-9]$/i.test(name) ? keyFor(name.toLowerCase()) : null);
    if (!key) throw new Error(`Unknown key ${name}`);
    const held = [mods.ctrl && NAMED.Control, mods.meta && NAMED.Meta, mods.shift && NAMED.Shift].filter(Boolean);
    const flags = { shift: Boolean(mods.shift), ctrl: Boolean(mods.ctrl), meta: Boolean(mods.meta) };
    if (config.trusted) {
      const bits = (flags.ctrl ? CDP_CTRL : 0) | (flags.meta ? CDP_META : 0) | (flags.shift ? CDP_SHIFT : 0);
      const steps = [];
      for (const mod of held) steps.push({ m: 'key', type: 'rawKeyDown', key: mod.key, code: mod.code, keyCode: mod.keyCode, modifiers: bits }, { wait: Math.round(jitter(50, 20, 15)) });
      steps.push({ m: 'key', type: 'rawKeyDown', key: key.key, code: key.code, keyCode: key.keyCode, modifiers: bits,
        ...(name === 'Space' && !held.length ? { text: ' ' } : {}) },
      { wait: Math.round(jitter(70, 30, 25)) },
      { m: 'key', type: 'keyUp', key: key.key, code: key.code, keyCode: key.keyCode, modifiers: bits });
      for (const mod of [...held].reverse()) steps.push({ wait: Math.round(jitter(40, 20, 10)) }, { m: 'key', type: 'keyUp', key: mod.key, code: mod.code, keyCode: mod.keyCode });
      const reply = await sendTrusted(steps);
      if (reply.dispatched) return finish(started, { proceeded: true, trusted: true });
    }
    for (const mod of held) {
      fireKey(el, 'keydown', mod, flags);
      await pause(jitter(50, 20, 15));
    }
    const proceeded = fireKey(el, 'keydown', key, flags);
    if (proceeded && name === 'Space' && !held.length) fireKey(el, 'keypress', key, flags);
    await pause(jitter(70, 30, 25));
    if (el.isConnected) fireKey(el, 'keyup', key, flags);
    for (const mod of [...held].reverse()) {
      await pause(jitter(40, 20, 10));
      if (el.isConnected) fireKey(el, 'keyup', mod, {});
    }
    if (proceeded && el.isConnected && !held.some(mod => mod !== NAMED.Shift)) keyDefault(el, name, flags);
    return finish(started, { proceeded });
  }

  /**
   * The pointer moved onto `el` and left resting there (a menu that opens on hover, a tooltip): the same path a click
   * takes (pointer moves and the boundary events), no press. Resolves { ms }.
   */
  async function hover(el) {
    const started = performance.now();
    await think();
    await reveal(el);
    if (!el.isConnected) return finish(started, { hovered: false });
    const doc = el.ownerDocument;
    const { x, y } = aimAt(el);
    if (config.trusted) {
      const moves = trustedMoves(doc, x, y);
      if ((await sendTrusted(moves.steps)).dispatched) {
        cursor = moves.end;
        return finish(started, { hovered: true, trusted: true });
      }
    }
    await moveTo(doc, x, y);
    return finish(started, { hovered: true });
  }

  /**
   * A native <select> chosen with the mouse: a click on it (focus, no popup: an untrusted press opens none), a
   * moment to pick, then `choose()` (the caller sets the value and fires input and change, as the browser does when
   * an option is picked from its popup).
   */
  async function select(el, choose) {
    const started = performance.now();
    await click(el);
    await pause(jitter(150, 80, 60));
    choose();
    return finish(started, {});
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Wheel
  // ---------------------------------------------------------------------------------------------------------------

  function scrollPosition(scroller) {
    return scroller ? scroller.scrollTop : (document.scrollingElement ?? document.documentElement).scrollTop;
  }

  /**
   * Scrolls `scroller` (an element, or null for the window) by `dy` CSS pixels as a mouse wheel does: the pointer
   * over it, wheel events of 100 px notches at the pointer, each followed by its share of the scroll. A notch the page
   * cancels is not scrolled (the page handles its own wheel); when nothing moved at all and the page cancelled, the
   * whole distance is scrolled directly so the action still does what it did before.
   */
  async function wheel(scroller, dy) {
    if (!dy) return;
    const view = window;
    const doc = document;
    const area = scroller ? visibleRect(scroller) : { left: 0, top: 0, right: innerWidth, bottom: innerHeight, width: innerWidth, height: innerHeight };
    if (!area) {
      scrollStep(scroller, dy);
      return;
    }
    const inside = cursor && cursor.x >= area.left && cursor.x < area.right && cursor.y >= area.top && cursor.y < area.bottom
      && (!scroller || within(deepHit(doc, cursor.x, cursor.y) ?? doc.documentElement, scroller));
    if (!inside) {
      await moveTo(doc, px(area.left + area.width * random(0.35, 0.65)), px(area.top + area.height * random(0.35, 0.65)));
      await pause(jitter(40, 20, 10));
    }
    const { x, y } = cursor;
    const before = scrollPosition(scroller);
    if (config.trusted) {
      const count = Math.min(40, Math.max(1, Math.round(Math.abs(dy) / 100)));
      const steps = [];
      for (let i = 0; i < count; i++) {
        steps.push({ m: 'mouse', type: 'mouseWheel', x, y, deltaY: Math.sign(dy) * 100 });
        if (i < count - 1) steps.push({ wait: Math.round(jitter(20, 10, 6)) });
      }
      if ((await sendTrusted(steps)).dispatched) {
        // The browser animates wheel scrolls; let the animation finish before the page is read.
        await pause(180);
        return;
      }
    }
    const notches = Math.min(40, Math.max(1, Math.round(Math.abs(dy) / 100)));
    const share = dy / notches;
    const gap = notches > 8 ? 12 : 24;
    let cancelled = false;
    for (let i = 0; i < notches; i++) {
      const target = deepHit(doc, x, y) ?? doc.documentElement;
      const init = mouseInit(view, x, y, { deltaX: 0, deltaY: Math.sign(dy) * 100, deltaZ: 0, deltaMode: 0 });
      if (fire(target, 'wheel', 'WheelEvent', init)) scrollStep(scroller, share);
      else cancelled = true;
      if (i < notches - 1) await pause(jitter(gap, gap / 2, 4));
    }
    if (cancelled && scrollPosition(scroller) === before) {
      await pause(34);
      if (scrollPosition(scroller) === before) scrollStep(scroller, dy);
    }
  }

  function scrollStep(scroller, dy) {
    if (scroller) scroller.scrollBy({ top: dy, behavior: 'instant' });
    else scrollBy({ top: dy, behavior: 'instant' });
  }

  /** A scroll action: think, then wheel `dy` on `scroller` (null: the window). Resolves { ms }. */
  async function scroll(scroller, dy) {
    const started = performance.now();
    await think();
    await wheel(scroller, dy);
    return finish(started, {});
  }

  function configure(settings = {}) {
    for (const key of ['enabled', 'typeBudgetMs', 'maxTyped', 'revealMaxPx', 'trusted']) {
      if (typeof settings[key] === typeof config[key]) config[key] = settings[key];
    }
    if (Number.isInteger(settings.rhythmSeed) && settings.rhythmSeed >= 0) config.rhythmSeed = settings.rhythmSeed >>> 0;
    if (Number.isInteger(settings.keySeed) && settings.keySeed >= 0) config.keySeed = settings.keySeed >>> 0;
    if (settings.slipRate === null || (Number.isFinite(settings.slipRate) && settings.slipRate >= 0 && settings.slipRate <= 1)) config.slipRate = settings.slipRate;
    if (Array.isArray(settings.think) && settings.think.length === 2 && settings.think.every(Number.isFinite)) {
      config.think = [Math.max(0, settings.think[0]), Math.max(settings.think[0], settings.think[1])];
    }
    return { ...config };
  }

  globalThis.__faiInput = {
    get enabled() { return config.enabled; },
    click, keyboardClick, type, enter, press, hover, select, scroll, reveal, configure,
    stats: () => ({ ...totals }),
    // The typing rhythm's pure parts, for test/typing-rhythm.test.js.
    rhythm: { session: rhythmSession, plan: typingPlan, steps: rhythmSteps, seeded, params: RHYTHM, neighbours: NEIGHBOURS },
  };
})();
