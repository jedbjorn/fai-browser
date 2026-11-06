// Screenshot redaction on real pages in headless Chromium: extension/page.js gives the secret boxes, a Playwright
// viewport screenshot stands in for captureVisibleTab, and extension/offscreen.js (loaded in its own page with a stub
// chrome.runtime) fills the boxes and encodes the JPEG, as the extension does. captureRedacted() follows the worker's
// captureRedacted() in extension/background.js step for step (before query, capture, after query, one retry, union,
// withheld). pixelReport() decodes an image in Chromium (canvas getImageData) and counts the pure-green pixels the
// tests paint secrets in.
const OFFSCREEN_SCRIPT = new URL('../../extension/offscreen.js', import.meta.url).pathname;
const TOLERANCE_PX = 2;

/** A page running extension/offscreen.js; `annotate(message)` sends it an annotate message. */
export async function startOffscreen(browser) {
  const page = await browser.newPage();
  await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
  await page.evaluate(() => {
    globalThis.chrome = { runtime: { id: 'test', onMessage: { addListener(listener) { globalThis.__annotate = listener; } } } };
  });
  await page.addScriptTag({ path: OFFSCREEN_SCRIPT });
  return {
    page,
    annotate: message => page.evaluate(value => new Promise(resolve => globalThis.__annotate(value, { id: 'test' }, resolve)), message),
    close: () => page.close(),
  };
}

const near = (p, q) => Math.abs(p.x - q.x) <= TOLERANCE_PX && Math.abs(p.y - q.y) <= TOLERANCE_PX
  && Math.abs(p.width - q.width) <= TOLERANCE_PX && Math.abs(p.height - q.height) <= TOLERANCE_PX;
const sameRects = (a, b) => a.length === b.length && a.every(rect => b.some(other => near(rect, other)));

/**
 * One redacted screenshot of `page` (extension/page.js already injected): { dataUrl, width, height, redactions,
 * withheld, rects, attempts }. `hooks.beforeCapture(attempt)` runs between the query before and the capture (a race).
 */
export async function captureRedacted(page, offscreen, hooks = {}) {
  const query = arm => page.evaluate(value => globalThis.__faiPage.redactionRects({ arm: value }), arm);
  let raw;
  let redaction;
  let attempts = 0;
  for (let attempt = 0; ; attempt++) {
    attempts++;
    const before = await query(true);
    await hooks.beforeCapture?.(attempt);
    raw = `data:image/jpeg;base64,${(await page.screenshot({ type: 'jpeg', quality: 70, caret: 'initial' })).toString('base64')}`;
    const after = await query(false);
    const incomplete = before.incomplete === true || after.incomplete === true;
    const sameView = before.viewport.width === after.viewport.width && before.viewport.height === after.viewport.height
      && before.scroll.x === after.scroll.x && before.scroll.y === after.scroll.y;
    const stable = after.dirty === false && sameView && !incomplete && sameRects(before.rects, after.rects);
    if (stable || incomplete || attempt >= 1) {
      const rects = [...before.rects, ...after.rects.filter(rect => !before.rects.some(other => near(rect, other)))];
      redaction = { rects, viewport: after.viewport, withheld: !stable };
      break;
    }
  }
  // The worker numbers page tags per session; here each tag gets its order of first sight.
  const numbers = new Map();
  for (const rect of redaction.rects) {
    const tag = /^\[secret:~([0-9a-z]+)\]$/.exec(rect.label ?? '');
    if (!tag) continue;
    if (!numbers.has(tag[1])) numbers.set(tag[1], numbers.size + 1);
    rect.label = `[secret:${numbers.get(tag[1])}]`;
  }
  const observation = await page.evaluate(() => globalThis.__faiPage.observe({}));
  const annotated = await offscreen.annotate({ type: 'annotate', dataUrl: raw, observation, action: null, target: null,
    redact: redaction });
  if (annotated?.error) throw new Error(annotated.error);
  return { ...annotated, rects: redaction.rects, attempts };
}

/**
 * Wraps every occurrence of each value in `values` (text in the document, open shadow roots and same-origin frames)
 * in a span painted pure #00ff00, and paints #00ff00 every field whose value holds one (and every password field).
 * Returns nothing; the boxes to check are read with paintedBoxes().
 */
export async function paintSecrets(page, values) {
  await page.evaluate(list => {
    const trees = [document];
    for (const frame of document.querySelectorAll('iframe')) {
      try {
        if (frame.contentDocument?.body) trees.push(frame.contentDocument);
      } catch {
        // Cross-origin.
      }
    }
    for (let i = 0; i < trees.length; i++) {
      for (const el of trees[i].querySelectorAll('*')) if (el.shadowRoot) trees.push(el.shadowRoot);
    }
    for (const tree of trees) {
      const doc = tree.ownerDocument ?? tree;
      const walker = doc.createTreeWalker(tree, NodeFilter.SHOW_TEXT);
      const nodes = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!['SCRIPT', 'STYLE', 'TEXTAREA'].includes(node.parentElement?.tagName)) nodes.push(node);
      }
      for (const node of nodes) {
        let text = node.nodeValue;
        const hits = list.filter(value => text.includes(value));
        if (!hits.length) continue;
        const fragment = doc.createDocumentFragment();
        while (text) {
          let at = -1;
          let value = null;
          for (const candidate of hits) {
            const index = text.indexOf(candidate);
            if (index >= 0 && (at < 0 || index < at)) [at, value] = [index, candidate];
          }
          if (at < 0) {
            fragment.append(text);
            break;
          }
          if (at) fragment.append(text.slice(0, at));
          const span = doc.createElement('span');
          span.dataset.fake = '1';
          span.style.color = '#00ff00';
          span.textContent = value;
          fragment.append(span);
          text = text.slice(at + value.length);
        }
        node.replaceWith(fragment);
      }
      for (const field of tree.querySelectorAll('input,textarea')) {
        if (field.type === 'password' || list.some(value => field.value.includes(value))) {
          field.dataset.fake = '1';
          field.style.color = '#00ff00';
        }
      }
    }
  }, values);
}

/** The viewport boxes (CSS px, top document) of everything paintSecrets() painted that is on screen. */
export async function paintedBoxes(page) {
  return page.evaluate(() => {
    const out = [];
    const trees = [[document, 0, 0]];
    for (const frame of document.querySelectorAll('iframe')) {
      try {
        const rect = frame.getBoundingClientRect();
        if (frame.contentDocument?.body) trees.push([frame.contentDocument, rect.left + frame.clientLeft, rect.top + frame.clientTop]);
      } catch {
        // Cross-origin.
      }
    }
    for (let i = 0; i < trees.length; i++) {
      for (const el of trees[i][0].querySelectorAll('*')) if (el.shadowRoot) trees.push([el.shadowRoot, trees[i][1], trees[i][2]]);
    }
    for (const [tree, dx, dy] of trees) {
      for (const el of tree.querySelectorAll('[data-fake]')) {
        for (const rect of el.getClientRects()) {
          const box = { x: rect.left + dx, y: rect.top + dy, width: rect.width, height: rect.height };
          if (box.width > 0 && box.height > 0 && box.x < innerWidth && box.y < innerHeight && box.x + box.width > 0 && box.y + box.height > 0) {
            out.push(box);
          }
        }
      }
    }
    return out;
  });
}

/**
 * Decodes `dataUrl` in Chromium and reports `{ width, height, green, boxes: [{ green, dark, pixels }] }`: `green` counts
 * pure-green pixels (a JPEG tolerance: g above 150, r and b below 110, g at least 80 above both) in the whole image,
 * and per box (CSS px of a `viewport` CSS px wide frame, shrunk by 1 px against rounding) the green pixels and the
 * dark ones (the fill or its yellow label).
 */
export function pixelReport(offscreen, dataUrl, boxes = [], viewport = null) {
  return offscreen.page.evaluate(async ({ url, list, view }) => {
    const bitmap = await createImageBitmap(await (await fetch(url)).blob());
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const isGreen = i => data[i + 1] > 150 && data[i] < 110 && data[i + 2] < 110 && data[i + 1] - Math.max(data[i], data[i + 2]) >= 80;
    let green = 0;
    for (let i = 0; i < data.length; i += 4) if (isGreen(i)) green++;
    const scale = view ? canvas.width / view.width : 1;
    const report = list.map(box => {
      const x0 = Math.max(0, Math.ceil(box.x * scale) + 1);
      const y0 = Math.max(0, Math.ceil(box.y * scale) + 1);
      const x1 = Math.min(canvas.width, Math.floor((box.x + box.width) * scale) - 1);
      const y1 = Math.min(canvas.height, Math.floor((box.y + box.height) * scale) - 1);
      let inside = 0;
      let dark = 0;
      let boxGreen = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * canvas.width + x) * 4;
          inside++;
          if (isGreen(i)) boxGreen++;
          // The fill, or the yellow placeholder label drawn on it.
          if ((data[i] < 70 && data[i + 1] < 70 && data[i + 2] < 70) || (data[i] > 170 && data[i + 1] > 140 && data[i + 2] < 110)) dark++;
        }
      }
      return { green: boxGreen, dark, pixels: inside };
    });
    return { width: canvas.width, height: canvas.height, green, boxes: report };
  }, { url: dataUrl, list: boxes, view: viewport });
}
