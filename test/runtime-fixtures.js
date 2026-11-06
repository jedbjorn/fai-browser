// In-memory bridge implementing the W1/W2 bridge contract, including the async screenshot promise.
import { bridgeError } from '../src/result.js';

export const ORIGIN = 'https://example.com';

export const link = (id, label, path, extra = {}) => ({
  id,
  role: 'link',
  label,
  href: path.startsWith('http') ? path : ORIGIN + path,
  enabled: true,
  risk: 'navigation',
  ...extra,
});

export const PAGES = {
  '/': { title: 'Home', text: 'Welcome home', controls: [link('1', 'About', '/about')] },
  '/about': {
    title: 'About',
    text: 'About us',
    controls: [link('1', 'Members', '/members'), link('2', 'Home', '/')],
  },
  '/members': { title: 'Members', text: 'Ada, Grace, Linus', controls: [link('1', 'Home', '/')] },
  '/form': {
    title: 'Form',
    text: 'Profile form',
    controls: [
      { id: '1', role: 'textbox', label: 'Name', type: 'text', enabled: true },
      { id: '2', role: 'checkbox', label: 'Subscribe', type: 'checkbox', checked: false, enabled: true },
    ],
  },
};

// Blocks as extension/page.js would emit them for a fixture page: the title as h1, the text as a paragraph,
// links and buttons as their own blocks and form controls as labels, each with a ref to its control.
// A page may set `blocks` (and `blocksTruncated`) explicitly instead.
export function blocksFor(page) {
  if (page.blocks) return page.blocks.map(block => ({ ...block }));
  const blocks = [];
  if (page.title) blocks.push({ t: 'h1', text: page.title });
  if (page.text) blocks.push({ t: 'p', text: page.text });
  for (const control of page.controls) {
    if (!control.label) continue;
    if (control.options?.length) {
      // Contract: a select becomes `{t: "select", text: "<label>: <opt1> | <opt2> | ..."}` (20 options, 200 chars).
      const options = control.options.slice(0, 20).map(option => option.label).join(' | ');
      blocks.push({ t: 'select', text: `${control.label}: ${options}`.slice(0, 200), ref: control.id });
      continue;
    }
    const t = control.role === 'link' ? 'a' : control.role === 'button' ? 'button' : 'label';
    const block = { t, text: control.label, ref: control.id };
    if (control.offscreen) block.offscreen = true;
    blocks.push(block);
  }
  return blocks;
}

export class FakeBridge {
  constructor({ pages = PAGES, path = '/', captureDelayMs = 0, screenshot } = {}) {
    this.pages = structuredClone(pages);
    this.path = path;
    this.version = 1;
    this.captureDelayMs = captureDelayMs;
    this.screenshotOverride = screenshot; // optional (observation) => ScreenshotOutcome
    this.executions = [];
    this.observes = 0;
    this.failNext = []; // errors thrown by the next execute calls, in order
    this.log = []; // ordered event log for overlap tests
    this.observeOptions = []; // the options (terms) of every observe call
    // A link whose control has `lateHref` navigates only on the next observe (a navigation that starts after the
    // action settled); `settleNavigated` makes execute report `settle.navigated` as the extension does.
    this.pendingPath = null;
    // Host-composed acts: the paths visited (back/forward), keys pressed, hovers, and the lease's tabs.
    this.back = [];
    this.forward = [];
    this.keys = [];
    this.hovers = [];
  }

  // Moves to `path` as a navigation (kept for back).
  go(path) {
    if (path !== this.path) {
      this.back.push(this.path);
      this.forward = [];
    }
    this.path = path;
  }

  get observation() {
    const page = this.pages[this.path];
    return {
      revision: `${this.path}#${this.version}`,
      documentId: 'doc',
      tabId: 1,
      url: page.url ?? ORIGIN + this.path,
      title: page.title,
      text: page.text,
      blocks: blocksFor(page),
      blocksTruncated: page.blocksTruncated ?? false,
      controls: page.controls.map(control => ({ ...control })),
      viewport: { width: 1280, height: 800, dpr: 1 },
      consent: page.consent ? structuredClone(page.consent) : null,
      warnings: [...(page.warnings ?? [])],
      ...(page.unreadable ? { unreadable: structuredClone(page.unreadable) } : {}),
      // The extension worker's secret handles (handles and placeholders, never values).
      ...(page.secrets ? { secrets: structuredClone(page.secrets) } : {}),
      ...(this.tabs ? { tabs: structuredClone(this.tabs) } : {}),
      ...(page.dialog ? { dialog: structuredClone(page.dialog) } : {}),
      ...(page.logs ? { logs: structuredClone(page.logs) } : {}),
    };
  }

  async observe(signal, options = {}) {
    this.observes++;
    this.observeOptions.push(options);
    if (this.pendingPath) {
      this.path = this.pendingPath;
      this.pendingPath = null;
      this.version++;
    }
    return this.observation;
  }

  // A point click's first half: the page's control whose `bounds` hold the CSS point ({ id, control }); a control
  // with `unlisted: true` is one the observation left out (id null, control described with id "point"); one with
  // `frame: 'cross'` is in a frame the page cannot read. Nothing there: no_control.
  async locate(point, expectedRevision) {
    this.locates ??= [];
    this.locates.push({ point, expectedRevision });
    if (expectedRevision !== this.observation.revision) throw bridgeError('stale', 'Stale observation');
    const page = this.pages[this.path];
    const inside = control => control.bounds && point.x >= control.bounds.x && point.x < control.bounds.x + control.bounds.width
      && point.y >= control.bounds.y && point.y < control.bounds.y + control.bounds.height;
    const hit = [...page.controls, ...(page.unlisted ?? [])].find(inside);
    if (!hit) throw bridgeError('no_control', 'No clickable control is at that point');
    if (hit.frame === 'cross') throw bridgeError('point_frame', 'The point is inside a frame this page cannot read');
    const { unlisted, ...control } = hit;
    if (unlisted) return { id: null, control: { ...control, id: 'point' } };
    return { id: control.id, control: { ...control } };
  }

  async execute(action, expectedRevision, { capture } = {}) {
    this.executions.push({ action, expectedRevision, capture });
    const failure = this.failNext.shift();
    if (failure) throw typeof failure === 'function' ? failure() : failure;
    const pageAction = ['history', 'switch_tab', 'dialog'].includes(action.type) || (action.type === 'press' && !action.target);
    if (!pageAction && expectedRevision !== this.observation.revision) throw bridgeError('stale', 'Stale observation');
    const page = this.pages[this.path];
    let control = action.target ? page.controls.find(c => c.id === action.target) : null;
    if (action.point) {
      // A located, unlisted control is clicked by its point.
      const inside = c => c.bounds && action.point.x >= c.bounds.x && action.point.x < c.bounds.x + c.bounds.width
        && action.point.y >= c.bounds.y && action.point.y < c.bounds.y + c.bounds.height;
      control = (page.unlisted ?? []).find(inside) ?? null;
      if (!control) throw bridgeError('stale', 'The control at that point changed');
    }
    if (action.target && !control) throw bridgeError('target_unavailable', 'Target is unavailable');
    switch (action.type) {
      case 'click':
        if (control.lateHref) this.pendingPath = new URL(control.lateHref).pathname;
        else if (control.href) this.go(new URL(control.href).pathname);
        else if (control.role === 'checkbox') control.checked = !control.checked;
        if (control.dismissesConsent) delete page.consent;
        if (control.dismissesConsent || !control.lateHref) this.version++;
        break;
      case 'fill_supplied_text':
        control.filled = true;
        this.lastText = action.text;
        (this.typed ??= []).push({ target: action.target, text: action.text, typed: action.typed === true });
        this.version++;
        break;
      case 'history':
        if (action.move === 'back' && this.back.length) {
          this.forward.push(this.path);
          this.path = this.back.pop();
        } else if (action.move === 'forward' && this.forward.length) {
          this.back.push(this.path);
          this.path = this.forward.pop();
        }
        this.version++;
        break;
      case 'press':
        this.keys.push({ key: action.key, target: action.target });
        if (action.key === 'Escape' && page.dismissOnEscape) delete page.overlay;
        break;
      case 'hover':
        this.hovers.push(action.target);
        if (control.revealsOnHover) page.controls.push(...control.revealsOnHover);
        this.version++;
        break;
      case 'switch_tab': {
        const tab = this.tabs?.find(entry => entry.id === action.tab);
        if (!tab) throw bridgeError('target_unavailable', 'No such tab');
        for (const entry of this.tabs) entry.current = entry === tab;
        this.path = tab.path;
        this.version++;
        break;
      }
      case 'upload':
        (this.uploads ??= []).push({ target: action.target, file: { ...action.file }, approvalId: action.approvalId });
        this.version++;
        break;
      case 'dialog':
        this.dialogs = [...(this.dialogs ?? []), { answer: action.answer, text: action.text }];
        delete page.dialog;
        this.version++;
        break;
      case 'select':
        control.selectedValue = action.value;
        this.version++;
        break;
      case 'submit_field':
        // Enter in a filled field: the fixture control's submitHref is where its form goes.
        if (control.submitHref) this.go(new URL(control.submitHref).pathname);
        this.version++;
        break;
      case 'navigate_allowed_url':
        this.go(new URL(action.url).pathname);
        this.version++;
        break;
      default:
        // scroll and wait leave the page unchanged in this fake
        break;
    }
    const observation = this.observation;
    let screenshot = Promise.resolve(null);
    if (capture) {
      screenshot = new Promise(resolve => {
        setTimeout(() => {
          this.log.push(`captured:${observation.revision}`);
          resolve(this.screenshotOverride?.(observation) ?? {
            dataUrl: 'data:image/jpeg;base64,YQ==',
            revision: observation.revision,
            format: 'jpeg',
          });
        }, this.captureDelayMs);
      });
    }
    return { observation, settle: { reason: 'quiet', ms: 3 }, screenshot };
  }
}

/** Provider that clicks the first offered control whose label matches, else chooses `fallback`. */
export function clickProvider(labels, { fallback = 'done', log } = {}) {
  const calls = [];
  const provider = {
    calls,
    async decide(observation, actions, context) {
      calls.push({ observation, actions, context });
      log?.push(`decide:${observation.revision}`);
      for (const label of labels) {
        const action = actions.find(a => a.type === 'click' && a.label === label);
        if (action) {
          return { actionId: action.id, confidence: 0.9, model: 'fake', usage: { input_tokens: 10, output_tokens: 1 } };
        }
      }
      return { actionId: fallback };
    },
  };
  return provider;
}

export const tick = () => new Promise(resolve => setImmediate(resolve));
