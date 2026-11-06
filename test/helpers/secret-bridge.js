// PageBridge (headless Chromium with extension/page.js) that hands page.js the secret-redaction options before every
// call, as the extension worker does (pageCall's third argument): the user's mode, Relaxed origins and the lease salt.
// It keeps the last observation, which test/helpers/fake-hub.js reads for captures. With `offscreen` (a
// test/helpers/redacted-capture.js startOffscreen()), screenshots are real: every fake secret painted pure green, then
// boxed by page.js and filled by extension/offscreen.js, as the extension captures (the pixel check reads them).
import { PageBridge } from './page-bridge.js';
import { captureRedacted, paintSecrets } from './redacted-capture.js';
import { loadFakes } from './secret-fakes.js';

const FAKES = loadFakes();
const PAINTED = Object.entries(FAKES).flatMap(([name, value]) => (name === 'pem' ? [] : Array.isArray(value) ? value : [value]));

export class SecretBridge extends PageBridge {
  constructor(page, { level = 'reversible', secrets = {}, offscreen = null, gates = null } = {}) {
    super(page, { level });
    this.secrets = { mode: 'standard', relaxed: [], salt: 'lease-salt', ...secrets };
    // The Approve gate's settings as the worker would send them (null: page.js defaults, every ask on).
    this.gates = gates;
    this.observation = null;
    this.offscreen = offscreen;
    this.images = [];
  }

  async inject() {
    await super.inject();
    await this.page.evaluate(settings => globalThis.__faiPage.useSecrets(settings), this.secrets);
    if (this.gates) await this.page.evaluate(gates => globalThis.__faiPage.useGates(gates), this.gates);
  }

  async observe(signal, options) {
    this.observation = await super.observe(signal, options);
    return this.observation;
  }

  async execute(...args) {
    const result = await super.execute(...args);
    this.observation = result.observation;
    if (this.offscreen) result.screenshot = this.captureImage().catch(error => ({ error: { code: 'capture_failed', message: error.message } }));
    return result;
  }

  /** A redacted screenshot of the page as it is ({dataUrl, revision, format, width, height, redactions}). */
  async captureImage() {
    await paintSecrets(this.page, PAINTED);
    await this.inject();
    const shot = await captureRedacted(this.page, this.offscreen);
    const image = { dataUrl: shot.dataUrl, revision: this.observation?.revision ?? 'none', format: 'jpeg', width: shot.width,
      height: shot.height, redactions: shot.redactions, ...(shot.withheld ? { redaction: 'withheld' } : {}) };
    this.images.push(image);
    return image;
  }
}
