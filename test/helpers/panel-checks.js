// In-page checks for the chat panel, shared by the Chromium and Firefox suites: WCAG 2.1 AA contrast of every visible
// text and control, and that every focusable control has a name. Each is a self-contained function run in the page
// (Playwright page.evaluate, or Marionette as `return (${fn})()`).

/**
 * Every visible text node's colour against the background behind it (4.5:1, or 3:1 for large text), and every
 * enabled control's border or fill against the background around it (3:1, WCAG 1.4.11). Returns the failures.
 */
export function contrastFailures() {
  const parse = value => {
    const m = String(value).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return { r, g, b, a };
  };
  const lum = ({ r, g, b }) => {
    const c = [r, g, b].map(v => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const ratio = (x, y) => {
    const [a, b] = [lum(x), lum(y)].sort((p, q) => q - p);
    return (a + 0.05) / (b + 0.05);
  };
  const blend = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a),
    b: top.b * top.a + under.b * (1 - top.a), a: 1 });
  const background = node => {
    const layers = [];
    for (let el = node; el; el = el.parentElement) {
      const color = parse(getComputedStyle(el).backgroundColor);
      if (color && color.a > 0) {
        layers.push(color);
        if (color.a >= 1) break;
      }
    }
    let result = { r: 255, g: 255, b: 255, a: 1 };
    for (const layer of layers.reverse()) result = blend(layer, result);
    return result;
  };
  const visible = el => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && Number(style.opacity) > 0;
  };
  const failures = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    const el = text.parentElement;
    if (!text.textContent.trim() || !el || !visible(el) || el.closest('[hidden], [aria-hidden="true"], :disabled, option')) continue;
    // Behind the open delete dialog nothing else is readable or reachable.
    if (document.querySelector('dialog[open]') && !el.closest('dialog')) continue;
    const style = getComputedStyle(el);
    const size = parseFloat(style.fontSize);
    const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
    const value = ratio(blend(parse(style.color), background(el)), background(el));
    if (value < (large ? 3 : 4.5)) failures.push(`${el.tagName.toLowerCase()}.${el.className} "${text.textContent.trim().slice(0, 30)}" ${value.toFixed(2)}`);
  }
  for (const el of document.querySelectorAll('input:not([type=radio]):not([type=file]), textarea, select, .send, .new-chat, .attach')) {
    if (!visible(el) || el.disabled || el.closest('[hidden]')) continue;
    if (document.querySelector('dialog[open]') && !el.closest('dialog')) continue;
    const style = getComputedStyle(el);
    const around = background(el.parentElement);
    const fill = parse(style.backgroundColor);
    const border = parse(style.borderTopColor);
    const best = Math.max(fill && fill.a ? ratio(blend(fill, around), around) : 1, border && border.a ? ratio(blend(border, around), around) : 1);
    if (best < 3) failures.push(`control ${el.tagName.toLowerCase()}#${el.id}.${el.className} ${best.toFixed(2)}`);
  }
  return failures;
}

/** Every visible, focusable control and its accessible name ('' when it has none). */
export function namedControls() {
  const name = el => {
    const labelled = el.getAttribute('aria-labelledby');
    if (labelled) return labelled.split(' ').map(id => document.getElementById(id)?.textContent ?? '').join(' ').trim();
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label').trim();
    if (el.labels?.length) return [...el.labels].map(label => label.textContent).join(' ').trim();
    if (el.tagName === 'SELECT') return '';
    return (el.textContent || el.title || el.placeholder || '').trim();
  };
  return [...document.querySelectorAll('button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])')]
    .filter(el => !el.disabled && !el.closest('[hidden]') && el.getClientRects().length && el.tabIndex >= 0
      && !(document.querySelector('dialog[open]') && !el.closest('dialog')))
    .map(el => ({ id: el.id || el.className, tag: el.tagName.toLowerCase(), name: name(el) }));
}
