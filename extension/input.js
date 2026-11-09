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

  async function sendTrusted(steps) {
    if (!config.trusted || document.hidden || typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return { ok: false, dispatched: 0 };
    try {
      const reply = await chrome.runtime.sendMessage({ kind: 'fai-trusted-input', steps, viewport: { width: innerWidth, height: innerHeight } });
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
  //   Shift change, on the same key twice, or for Enter and keys outside the US layout; at most two keys down;
  // - no two events closer than RHYTHM.sep ms (a keyup within a few ms of a keydown reads as a script).
  // A secret (fill_secret, a password field) is planned blind: intervals and holds from its length alone, no rollover,
  // Shift slotted into the gaps, so neither the time a fill took nor how much was typed says more than its length.
  // ---------------------------------------------------------------------------------------------------------------

  const RHYTHM = {
    iki: [75, 108], // session median IKI range (ms, log-uniform): about 95-130 WPM at the keyboard
    hold: [62, 92], // session median hold range (ms, log-uniform)
    ikiSigma: 0.3,
    holdSigma: 0.22,
    ikiMin: 35,
    ikiMax: 650,
    holdMin: 30,
    holdMax: 180,
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
    sep: 8, // least time between two events
    blindIkiMin: 70,
    slack: 1.4, // a whole value is typed when its plan is within budget * slack
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
    R0: 'Digit0 Minus Equal KeyP BracketLeft BracketRight Backslash Semicolon Quote Slash',
  })) for (const code of codes.split(' ')) FINGERS[code] = finger;
  const PUNCTUATION = /^[.,;:!?)]$/;

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
    const key = keyFor(ch);
    const kind = ch === ' ' ? 'space' : ch === '\n' ? 'enter' : /^[a-z]$/i.test(ch) ? 'letter' : /^[0-9]$/.test(ch) ? 'digit'
      : key.code ? 'symbol' : 'foreign';
    const finger = FINGERS[key.code] ?? null;
    return { ch, shift: key.shift, kind, id: key.code || ch, finger, hand: finger?.[0] ?? null };
  }

  // How much slower (above 1) or quicker this key comes after `prev`.
  function contextFactor(prev, key) {
    if (!prev) return 1;
    let f = 1;
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

  // The random part of a plan, key by key: interval before it, hold, Shift lead, hesitation.
  function rhythmDraws(keys, session, random, blind) {
    const normal = () => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
    const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
    const out = { iki: [], hold: [], lead: [], bursts: [], hesitations: 0, hesitationMs: 0, start: 0, tail: 0 };
    let burstLeft = 0;
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const prev = keys[i - 1];
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
      let iki = i === 0 ? 0 : clamp(session.iki * f * Math.exp(RHYTHM.ikiSigma * normal()), blind ? RHYTHM.blindIkiMin : RHYTHM.ikiMin, RHYTHM.ikiMax);
      if (i > 0 && random() < RHYTHM.hesitation) {
        const [low, high] = RHYTHM.hesitationMs;
        const extra = Math.min(low + random() * (high - low), RHYTHM.hesitationCap - out.hesitationMs);
        if (extra > 0) {
          iki += extra;
          out.hesitations++;
          out.hesitationMs += extra;
        }
      }
      out.iki.push(iki);
      const space = !blind && key.kind === 'space' ? 0.9 : 1;
      out.hold.push(clamp(session.hold * space * Math.exp(RHYTHM.holdSigma * normal()), RHYTHM.holdMin, RHYTHM.holdMax));
      out.lead.push(clamp(RHYTHM.lead * Math.exp(0.3 * normal()), 20, 90));
    }
    out.start = clamp(RHYTHM.lead * Math.exp(0.3 * normal()), 30, 90);
    out.tail = clamp(25 + random() * 30, 2 * RHYTHM.sep, 60);
    return out;
  }

  const rollable = key => key.kind !== 'enter' && key.kind !== 'foreign';

  // The events of the first `count` keys: { at, type: 'down'|'up'|'shift', index?, on? }, in time order from 0.
  function rhythmLayout(keys, d, count) {
    const { sep, holdMin } = RHYTHM;
    const events = [];
    let shift = false;
    let last = null; // the previous key: { index, key, down, up (tentative until the next key is placed) }
    let lastUp = -Infinity; // the key before it, already up
    for (let i = 0; i < count; i++) {
      const key = keys[i];
      // At most two keys down: the one before the previous is up before this one goes down.
      let down = Math.max(i === 0 ? 0 : last.down + d.iki[i], lastUp + sep);
      const change = key.shift !== shift;
      let mod = change ? down - d.lead[i] : null;
      if (last) {
        last.up = Math.max(last.up, lastUp + sep);
        const releaseFirst = change || last.key.id === key.id || !rollable(last.key) || !rollable(key);
        if (releaseFirst) {
          const before = (mod ?? down) - sep;
          if (last.up > before) last.up = Math.max(last.down + holdMin, lastUp + sep, before);
          if (last.up > before) {
            const push = last.up - before;
            down += push;
            if (mod !== null) mod += push;
          }
        } else if (Math.abs(last.up - down) < sep) {
          const earlier = down - sep;
          last.up = earlier >= last.down + holdMin && earlier >= lastUp + sep ? earlier : down + sep;
        }
        events.push({ at: last.up, type: 'up', index: last.index });
        lastUp = last.up;
      }
      if (mod !== null) {
        if (last) mod = Math.max(mod, last.down + sep);
        down = Math.max(down, mod + 15);
        events.push({ at: mod, type: 'shift', on: key.shift });
        shift = key.shift;
      }
      events.push({ at: down, type: 'down', index: i });
      last = { index: i, key, down, up: down + d.hold[i] };
    }
    if (last) {
      last.up = Math.max(last.up, lastUp + sep);
      events.push({ at: last.up, type: 'up', index: last.index });
      if (shift) events.push({ at: last.up + d.tail, type: 'shift', on: false });
    }
    events.sort((a, b) => a.at - b.at);
    const base = events.length ? events[0].at : 0;
    for (const event of events) event.at -= base;
    return { events, total: events.length ? events.at(-1).at : 0 };
  }

  // A secret's events: times from the draws alone (no context, no rollover), Shift halfway through the gap before its
  // key, and a total that does not depend on which keys needed it.
  function rhythmLayoutBlind(keys, d, count) {
    const events = [];
    let shift = false;
    let at = d.start;
    let prevUp = 0;
    for (let i = 0; i < count; i++) {
      if (i > 0) at += d.iki[i];
      const hold = i < count - 1 ? Math.min(d.hold[i], 0.45 * d.iki[i + 1]) : d.hold[i];
      if (keys[i].shift !== shift) {
        shift = keys[i].shift;
        events.push({ at: (prevUp + at) / 2, type: 'shift', on: shift });
      }
      events.push({ at, type: 'down', index: i }, { at: at + hold, type: 'up', index: i });
      prevUp = at + hold;
    }
    if (shift) events.push({ at: prevUp + d.tail / 2, type: 'shift', on: false });
    events.sort((a, b) => a.at - b.at);
    return { events, total: count ? prevUp + d.tail : 0 };
  }

  /**
   * The plan for typing `text`: { events, total, typed, chunked, blind, bursts (the key indices that start one),
   * hesitations, hesitationMs (drawn over the first maxTyped keys) }. All of it when the whole plan fits within
   * budgetMs * RHYTHM.slack (and maxTyped), else the longest prefix whose plan fits within budgetMs; `typed` keys are
   * typed, the rest goes in as one insertion.
   */
  function typingPlan(text, { session = rhythmSession(1), random = Math.random, budgetMs = config.typeBudgetMs,
    maxTyped = config.maxTyped, blind = false } = {}) {
    const chars = Array.from(text);
    const n = Math.max(0, Math.min(chars.length, maxTyped));
    const keys = chars.slice(0, n).map(describeKey);
    const d = rhythmDraws(keys, session, random, blind);
    const lay = count => (blind ? rhythmLayoutBlind : rhythmLayout)(keys, d, count);
    let count = n;
    let plan = lay(n);
    if (n < chars.length || plan.total > budgetMs * RHYTHM.slack) {
      while (count > 0 && plan.total > budgetMs) plan = lay(--count);
    }
    return { ...plan, typed: count, chunked: count < chars.length, blind, bursts: d.bursts.filter(i => i < count),
      hesitations: d.hesitations, hesitationMs: d.hesitationMs };
  }

  // The session's typist (config.rhythmSeed, else this document's own seed).
  const documentSeed = (Math.floor(Math.random() * 2 ** 32) >>> 0) || 1;
  let typist = null;
  function currentTypist() {
    const seed = config.rhythmSeed || documentSeed;
    if (typist?.seed !== seed) typist = { seed, session: rhythmSession(seed) };
    return typist.session;
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

  // Inserts `data` where a keystroke would: over the selection (all of it right after select-all), else at the caret,
  // else at the end (an email or number field has no caret API). The native setter, so a framework's controlled
  // input sees the change on the input event that follows. Returns false when maxlength leaves no room.
  function insert(el, data, state) {
    const value = el.value;
    let start = value.length;
    let end = value.length;
    if (state.replaceAll) {
      start = 0;
    } else {
      try {
        if (typeof el.selectionStart === 'number') {
          start = el.selectionStart;
          end = el.selectionEnd;
        }
      } catch {
        // No selection API on this input type.
      }
    }
    let text = data;
    if (el.maxLength >= 0) {
      const room = el.maxLength - (value.length - (end - start));
      if (room <= 0) return false;
      text = text.slice(0, room);
    }
    state.replaceAll = false;
    valueSetter(el).call(el, value.slice(0, start) + text + value.slice(end));
    try {
      el.setSelectionRange(start + text.length, start + text.length);
    } catch {
      // No selection API on this input type.
    }
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

  // CDP modifier bits.
  const CDP_CTRL = 2;
  const CDP_META = 4;
  const CDP_SHIFT = 8;

  // The trusted-input steps of a plan: its events with the waits between them (none over TRUSTED_WAIT_MS; the
  // worker's limit is 600), Shift and keys as the browser's own.
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
      const ch = chars[event.index];
      const key = keyFor(ch);
      const modifiers = shift ? CDP_SHIFT : 0;
      steps.push(event.type === 'down'
        ? { m: 'key', type: 'keyDown', key: key.key, code: key.code, keyCode: key.keyCode, text: ch === '\n' ? '\r' : ch, modifiers }
        : { m: 'key', type: 'keyUp', key: key.key, code: key.code, keyCode: key.keyCode, modifiers });
    }
    if (plan.blind) waitUntil(plan.total);
    return steps;
  }

  // Trusted typing: select-all when the field holds something, the plan's keys, the rest as one insertText. Null when
  // nothing was dispatched (the synthetic path runs instead).
  async function typeTrusted(el, text, plan) {
    const steps = [];
    if (el.value) {
      const mod = MAC ? NAMED.Meta : NAMED.Control;
      const bit = MAC ? CDP_META : CDP_CTRL;
      steps.push({ m: 'key', type: 'rawKeyDown', key: mod.key, code: mod.code, keyCode: mod.keyCode, modifiers: bit },
        { wait: Math.round(jitter(60, 30, 20)) },
        { m: 'key', type: 'rawKeyDown', key: 'a', code: 'KeyA', keyCode: 65, modifiers: bit, commands: ['selectAll'] },
        { wait: Math.round(jitter(55, 25, 20)) },
        { m: 'key', type: 'keyUp', key: 'a', code: 'KeyA', keyCode: 65, modifiers: bit },
        { m: 'key', type: 'keyUp', key: mod.key, code: mod.code, keyCode: mod.keyCode, modifiers: 0 },
        { wait: Math.round(jitter(60, 30, 15)) });
    }
    const chars = Array.from(text);
    steps.push(...rhythmSteps(chars, plan));
    if (plan.chunked) steps.push({ wait: Math.round(jitter(60, 30, 15)) }, { m: 'text', text: chars.slice(plan.typed).join('') });
    const reply = await sendTrusted(steps);
    return reply.dispatched ? { typed: plan.typed, chunked: plan.chunked } : null;
  }

  // How far behind its plan synthetic typing may fall (a page whose key handlers are slow) before the rest goes in
  // as one insertion.
  const RHYTHM_LATE_MS = 400;

  // Plays a plan's events on `el` against the clock, so a slow handler eats into the next gap instead of adding to
  // it. Stops early, releasing what is held, when the field went away or a key would go down more than
  // RHYTHM_LATE_MS late. Returns how many keys went down.
  async function playRhythm(el, chars, plan, state) {
    const started = performance.now();
    const held = new Map();
    let typed = 0;
    let stopped = false;
    for (const event of plan.events) {
      if (event.at > 0) await pause(Math.max(event.at - (performance.now() - started), RHYTHM.sep / 2));
      if (!el.isConnected || (event.type === 'down' && performance.now() - started - event.at > RHYTHM_LATE_MS)) {
        stopped = true;
        break;
      }
      if (event.type === 'shift') {
        fireKey(el, event.on ? 'keydown' : 'keyup', NAMED.Shift, { shift: event.on });
        state.shift = event.on;
        continue;
      }
      const ch = chars[event.index];
      const key = keyFor(ch);
      const mods = { shift: state.shift };
      if (event.type === 'down') {
        let proceed = fireKey(el, 'keydown', key, mods);
        if (proceed && key.charCode) proceed = fireKey(el, 'keypress', key, mods);
        if (proceed) inputText(el, ch, state);
        held.set(event.index, key);
        typed = event.index + 1;
      } else if (held.delete(event.index)) {
        fireKey(el, 'keyup', key, mods);
      }
    }
    if (stopped && (held.size || state.shift)) await pause(RHYTHM.sep);
    for (const key of held.values()) fireKey(el, 'keyup', key, { shift: state.shift });
    if (state.shift) {
      fireKey(el, 'keyup', NAMED.Shift, {});
      state.shift = false;
    }
    if (plan.blind && !stopped) await pause(plan.total - (performance.now() - started));
    return typed;
  }

  /**
   * Types `text` into a text field as a keyboard does: focus it with a click if it is not focused, select what it
   * holds (Ctrl/Cmd+A), then per character Shift as needed, keydown, keypress, beforeinput, the insertion, input and
   * keyup, with human gaps; past the typing budget the rest goes in as one insertion. A key the page cancels inserts
   * nothing, as for a person. change is left for the blur or Enter that follows (commitPending).
   * `kept()` says whether the field shows the text afterwards; when it does not (a page that swallowed the keys, or
   * a field that was replaced), `fallback()` sets the value the plain way and the pending change is dropped (the
   * fallback fires its own).
   * Key timing follows the session's typing rhythm (typingPlan); `secret` (fill_secret; a password field counts as
   * one) plans it blind, from the length alone.
   * Resolves { typed, chunked, fallback, ms }.
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
    const plan = typingPlan(text, { session: currentTypist(), blind: secret || el.type === 'password' });
    if (config.trusted && deepActive(doc) === el) {
      const result = await typeTrusted(el, text, plan);
      if (result) {
        // The browser fires change itself on the blur or Enter that follows trusted typing.
        if (pending?.el === el) pending = null;
        let fellBack = false;
        if (fallback && !kept()) {
          fallback();
          fellBack = true;
        }
        return finish(started, { ...result, fallback: fellBack, trusted: true });
      }
    }
    const state = { replaceAll: false, shift: false };
    if (el.value) {
      await pause(jitter(90, 40, 30));
      state.onShortcut = () => {
        try {
          el.select();
        } catch {
          // Not selectable; the first insertion still replaces everything.
        }
        state.replaceAll = true;
      };
      await shortcut(el, 'a', state);
      delete state.onShortcut;
    }
    const chars = Array.from(text);
    const typed = await playRhythm(el, chars, plan, state);
    const chunked = typed < chars.length && el.isConnected;
    if (chunked) {
      await pause(jitter(60, 30, 15));
      inputText(el, chars.slice(typed).join(''), state);
    }
    let fellBack = false;
    if (fallback && !kept()) {
      fallback();
      fellBack = true;
      if (pending?.el === el) pending = null;
    }
    return finish(started, { typed, chunked, fallback: fellBack });
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
    rhythm: { session: rhythmSession, plan: typingPlan, steps: rhythmSteps, seeded, params: RHYTHM },
  };
})();
