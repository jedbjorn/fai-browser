// Deterministic SDK demonstration. Does not launch Chrome or contact a provider.
import { BrowserRuntime } from '../src/runtime.js';

const ORIGIN = 'http://127.0.0.1:8765';
// Placeholder 1x1 image; the real extension draws numbered annotations on a captured screenshot.
const PIXEL = 'data:image/png;base64,'
  + 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aEt8AAAAASUVORK5CYII=';

let observation = {
  revision: 'home',
  documentId: 'demo',
  tabId: 1,
  url: `${ORIGIN}/`,
  title: 'Home',
  text: 'Welcome',
  controls: [{ id: '1', role: 'link', label: 'About', href: `${ORIGIN}/about`, enabled: true }],
  viewport: { width: 1280, height: 800, dpr: 1 },
};

// In-memory bridge implementing the bridge contract: execute returns the settled observation immediately and the
// screenshot as a promise that resolves later.
const bridge = {
  async observe() {
    return observation;
  },
  async execute(action, expectedRevision, { capture }) {
    if (expectedRevision !== observation.revision) {
      throw Object.assign(new Error('Stale observation'), { code: 'stale', recoverable: true });
    }
    observation = {
      ...observation,
      revision: 'about',
      url: `${ORIGIN}/about`,
      title: 'About',
      text: 'About the demo',
      controls: [],
    };
    const settled = observation;
    const screenshot = capture
      ? new Promise(resolve => {
        setTimeout(() => resolve({ dataUrl: PIXEL, revision: settled.revision, format: 'png' }), 20);
      })
      : Promise.resolve(null);
    return { observation: settled, settle: { reason: 'quiet', ms: 0 }, screenshot };
  },
};

// Deterministic provider: click the About link.
const provider = {
  model: 'demo-provider',
  async decide(page, actions) {
    const about = actions.find(action => action.type === 'click' && action.label === 'About');
    return { actionId: about ? about.id : 'done', confidence: 1 };
  },
};

const browser = new BrowserRuntime({ bridge, provider });
const result = await browser.run('Open About', { expectation: { titleEquals: 'About' } });

// Shorten base64 so the printed schema stays readable.
const printable = JSON.parse(JSON.stringify(result));
for (const step of printable.steps) {
  if (step.screenshot) step.screenshot.dataUrl = `${step.screenshot.dataUrl.slice(0, 32)}...`;
}
console.log(JSON.stringify(printable, null, 2));
