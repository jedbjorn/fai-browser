// Offscreen document: decodes the captured frame, downscales it, draws control boxes and badges (the control refs,
// or with `labels` the offered action ids a host passes to act) plus a footer naming the action, and encodes JPEG.
//
// Encoder choice: in headless Chromium 153, OffscreenCanvas.convertToBlob() stalls ~1008 ms per frame while a
// synchronous HTMLCanvasElement.toDataURL() on this document's DOM canvas takes 5-11 ms for a 1280x720 JPEG
// (scripts/browser-smoke.mjs reports both on every run). The DOM canvas is the default; `encoder: 'offscreen'`
// keeps the other path available for comparison in headed Chrome.

const MAX_WIDTH = 1280;
const JPEG_QUALITY = 0.7;
const ACCENT = '#ff2d55';

// createImageBitmap rather than HTMLImageElement.decode(): decode() never settles in an offscreen document
// (it is never rendered), observed in headless Chromium.
async function decode(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  return await createImageBitmap(blob);
}

function createCanvas(encoder, width, height) {
  if (encoder === 'offscreen') return new OffscreenCanvas(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

async function encode(canvas, encoder) {
  if (encoder === 'offscreen') {
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }
  return canvas.toDataURL('image/jpeg', JPEG_QUALITY);
}

// Shortens text with an ellipsis so it fits `maxWidth` pixels in the current font.
function fit(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (ctx.measureText(text.slice(0, mid) + '…').width <= maxWidth) low = mid;
    else high = mid - 1;
  }
  return text.slice(0, low) + '…';
}

// A sensitive fill's own value, echoed by the page into the target's label, is never drawn either.
function scrubSecret(text, action) {
  const secret = action?.type === 'fill_supplied_text' && action.sensitive === true && typeof action.text === 'string'
    && action.text.length >= 3 ? action.text : null;
  return secret ? String(text).split(secret).join('[redacted]') : String(text);
}

function describeAction(action, target) {
  if (!action) return 'Observation';
  const parts = [action.type];
  if (target?.label) parts.push(`"${scrubSecret(target.label, action)}"`);
  if (action.target) parts.push(`(pre-action ref ${action.target})`);
  if (action.type === 'select') parts.push(`= ${action.value}`);
  if (action.type === 'scroll') parts.push(action.direction);
  // Supplied form text is deliberately not drawn; it may be sensitive.
  return parts.join(' ');
}

// The tag text for the action ids of one control: "a3", a contiguous run "a3–a5" (a select's options, a field's
// fills), else the first id and how many more ("a3 +2").
function tagText(ids) {
  if (ids.length === 1) return ids[0];
  const numbers = ids.map(id => Number(id.slice(1)));
  const contiguous = numbers.every((n, i) => i === 0 || n === numbers[i - 1] + 1);
  return contiguous ? `${ids[0]}–${ids[ids.length - 1]}` : `${ids[0]} +${ids.length - 1}`;
}

const BADGE_HEIGHT = 18;

function overlaps(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

// Where a badge of `badgeWidth` goes for a box: left of it when there is room (so it does not cover the line of
// text above), else above, else below, else inside its top-left corner, else to its right. The first place that
// overlaps no badge placed so far and stays in the frame wins; the first place when none does.
function placeBadge(box, badgeWidth, placed, width, height) {
  const candidates = [
    { x: box.x - badgeWidth - 2, y: box.y },
    { x: box.x, y: box.y - BADGE_HEIGHT - 2 },
    { x: box.x, y: box.y + box.height + 2 },
    { x: box.x + 2, y: box.y + 2 },
    { x: box.x + box.width + 2, y: box.y },
  ].map(at => ({ ...at, width: badgeWidth, height: BADGE_HEIGHT }));
  const inFrame = at => at.x >= 0 && at.y >= 0 && at.x + at.width <= width && at.y + at.height <= height;
  const free = candidates.find(at => inFrame(at) && !placed.some(other => overlaps(at, other)));
  if (free) return free;
  const clamp = at => ({ ...at, x: Math.min(Math.max(0, at.x), width - at.width), y: Math.min(Math.max(0, at.y), height - at.height) });
  return clamp(candidates.find(inFrame) ?? candidates[1]);
}

// Draws a box per control in the frame and a badge naming it. With `labels` (control ref -> offered action ids, from
// the runtime's offer for this revision) only the offered controls are boxed and each badge is its action id(s), the
// id a host passes to act; without, every control gets its ref. Returns the badges drawn: [{ id, ref, x, y, width,
// height }] in output pixels, for the trace.
function annotate(ctx, width, height, { observation, action, target, fromUrl, labels }) {
  // CSS pixels to output pixels; includes both device pixel ratio and the downscale.
  const scaleX = width / observation.viewport.width;
  const scaleY = height / observation.viewport.height;
  ctx.font = 'bold 13px sans-serif';
  ctx.lineWidth = 2;
  const tagged = labels && typeof labels === 'object';
  const placed = [];
  const tags = [];
  for (const control of observation.controls) {
    // Off-screen controls are offered but not in the frame; a clamped box would mislabel the top edge.
    if (control.offscreen) continue;
    const ids = tagged ? labels[control.id] : null;
    if (tagged && !(Array.isArray(ids) && ids.length)) continue;
    const box = control.bounds;
    const x = Math.max(0, box.x * scaleX);
    const y = Math.max(0, box.y * scaleY);
    const frame = { x, y, width: box.width * scaleX, height: box.height * scaleY };
    ctx.strokeStyle = ACCENT;
    ctx.strokeRect(frame.x, frame.y, frame.width, frame.height);
    const text = tagged ? tagText(ids) : control.id;
    const badgeWidth = Math.max(18, ctx.measureText(text).width + 6);
    const badge = placeBadge(frame, badgeWidth, placed, width, height);
    placed.push(badge);
    ctx.fillStyle = ACCENT;
    ctx.fillRect(badge.x, badge.y, badge.width, badge.height);
    ctx.fillStyle = 'white';
    ctx.fillText(text, badge.x + 3, badge.y + 14);
    tags.push({ id: text, ref: control.id, x: Math.round(badge.x), y: Math.round(badge.y),
      width: Math.round(badge.width), height: badge.height });
  }
  const footer = 46;
  ctx.fillStyle = 'rgba(0,0,0,.85)';
  ctx.fillRect(0, Math.max(0, height - footer), width, footer);
  ctx.fillStyle = 'white';
  ctx.font = 'bold 14px sans-serif';
  const heading = action ? `Action: ${describeAction(action, target)}` : 'Observation';
  ctx.fillText(fit(ctx, heading, width - 16), 8, height - 27);
  ctx.font = '12px sans-serif';
  // Both URLs arrive with their secrets redacted (src/secrets.js): the observation's from page.js, `fromUrl` from
  // page.js or the worker's reportedUrl(). The footer draws them as given.
  const route = fromUrl && fromUrl !== observation.url ? `${fromUrl} → ${observation.url}` : observation.url;
  const boxes = tagged ? `tags: action ids (${tags.length} in view)` : action ? 'boxes: post-action refs' : 'boxes: current refs';
  ctx.fillText(fit(ctx, `${route} | ${boxes} | ${observation.revision}`, width - 16), 8, height - 9);
  return tags;
}

// Screenshot redaction (docs/REFERENCE.md "Screenshot redaction"): every box the page script named (top-document
// viewport CSS px, already padded) is filled solid on the captured pixels, labelled with its placeholder number when
// it has one, so the image and the text agree. `withheld` (a page that would not hold still) first reduces the whole
// frame to an unreadable blur. Returns { boxes, withheld } for the worker's check; throws on a malformed request.
const REDACT_FILL = '#000000';
const REDACT_LABEL = '#ffd60a';
const WITHHELD_FACTOR = 48;

function redact(ctx, canvas, width, height, request) {
  if (!request || !Array.isArray(request.rects) || !(request.viewport?.width > 0) || !(request.viewport?.height > 0)) {
    throw new Error('No redaction boxes');
  }
  const withheld = request.withheld === true;
  if (withheld) {
    const small = createCanvas('dom', Math.max(1, Math.round(width / WITHHELD_FACTOR)), Math.max(1, Math.round(height / WITHHELD_FACTOR)));
    const smallCtx = small.getContext('2d');
    smallCtx.drawImage(canvas, 0, 0, small.width, small.height);
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.filter = 'blur(8px)';
    ctx.drawImage(small, 0, 0, width, height);
    ctx.restore();
  }
  const scaleX = width / request.viewport.width;
  const scaleY = height / request.viewport.height;
  let boxes = 0;
  ctx.save();
  ctx.font = 'bold 12px sans-serif';
  for (const rect of request.rects) {
    if (![rect?.x, rect?.y, rect?.width, rect?.height].every(Number.isFinite)) throw new Error('Malformed redaction box');
    // Outward rounding: a box never shrinks below what the page script named.
    const x = Math.floor(rect.x * scaleX);
    const y = Math.floor(rect.y * scaleY);
    const w = Math.ceil((rect.x + rect.width) * scaleX) - x;
    const h = Math.ceil((rect.y + rect.height) * scaleY) - y;
    ctx.fillStyle = REDACT_FILL;
    ctx.fillRect(x, y, w, h);
    boxes++;
    const label = typeof rect.label === 'string' && /^\[secret:\d{1,6}\]$/.test(rect.label) ? rect.label.slice(1, -1) : null;
    if (label && w >= 30 && h >= 12) {
      ctx.fillStyle = REDACT_LABEL;
      ctx.fillText(fit(ctx, label, w - 4), x + 2, y + Math.min(h - 2, 12));
    }
  }
  ctx.restore();
  return { boxes, withheld };
}

async function handle(message) {
  const encoder = message.encoder === 'offscreen' ? 'offscreen' : 'dom';
  const started = performance.now();
  const image = await decode(message.dataUrl);
  const decoded = performance.now();
  const scale = Math.min(1, MAX_WIDTH / image.width);
  const width = Math.round(image.width * scale);
  const height = Math.round(image.height * scale);
  const canvas = createCanvas(encoder, width, height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0, width, height);
  image.close();
  // Secrets go first, before any box, badge or footer is drawn over the frame; without boxes there is no image.
  const redacted = redact(ctx, canvas, width, height, message.redact);
  const tags = annotate(ctx, width, height, message);
  const drawn = performance.now();
  const dataUrl = await encode(canvas, encoder);
  const encoded = performance.now();
  return {
    dataUrl,
    width,
    height,
    ...(message.labels && typeof message.labels === 'object' ? { tags } : {}),
    redactions: redacted.boxes,
    withheld: redacted.withheld,
    encoder,
    timings: {
      decodeMs: Math.round(decoded - started),
      drawMs: Math.round(drawn - decoded),
      encodeMs: Math.round(encoded - drawn),
    },
  };
}

// A secret the user approved copying (copy_secret, the worker's writeClipboard): written with a textarea that is
// emptied and removed at once. The offscreen document has no focus, so navigator.clipboard is not usable here;
// execCommand('copy') is, with the clipboardWrite permission and the CLIPBOARD reason.
function writeClipboard(text) {
  if (typeof text !== 'string' || !text) return { ok: false };
  const area = document.createElement('textarea');
  area.value = text;
  document.body.append(area);
  let ok = false;
  try {
    area.select();
    ok = document.execCommand('copy') === true;
  } finally {
    area.value = '';
    area.remove();
  }
  return { ok };
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return undefined;
  if (message?.type === 'clipboard_write') {
    respond(writeClipboard(message.text));
    return undefined;
  }
  if (message?.type !== 'annotate') return undefined;
  handle(message).then(respond, error => respond({ error: error.message }));
  return true;
});
