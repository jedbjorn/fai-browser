// Test-only UI driver for the one Firefox created by record-demo. Stock Firefox uses Marionette, not Playwright's
// patched Firefox protocol. Reuses the repository's smoke-test client; never connects to an existing browser.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GECKO_ID } from '../build-firefox.mjs';
const sleep = ms => new Promise(done => setTimeout(done, ms));
export class DemoFirefoxUI {
  constructor(marionette, { output, fixtures, holdMs = 2200 }) {
    this.m = marionette; this.output = output; this.fixtures = fixtures; this.holdMs = holdMs;
    this.events = []; this.saved = new Set(); this.started = Date.now();
  }
  async chrome(script, args = [], async = false) {
    await this.m.setContext('chrome');
    try { return await this.m.execute(script, args, { async }); }
    finally { await this.m.setContext('content'); }
  }
  async init({ development = false } = {}) {
    const state = await this.chrome(`
      const done=arguments[arguments.length-1];
      const {AddonManager}=ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
      AddonManager.getAddonByID(arguments[0]).then(a=>done({active:a?.isActive,
        signed:a?.signedState>=AddonManager.SIGNEDSTATE_SIGNED,temporary:a?.temporarilyInstalled,
        uuid:WebExtensionPolicy.getByID(arguments[0])?.mozExtensionHostname}));`, [GECKO_ID], true);
    assert.ok(state.active && (development ? state.temporary : state.signed && !state.temporary),
      'The requested signed or temporary development add-on must be active');
    assert.match(state.uuid, /^[0-9a-f-]{36}$/);
    this.extensionOrigin = `moz-extension://${state.uuid}`;
    return state;
  }
  async windows() {
    const result = await this.m.send('WebDriver:GetWindowHandles');
    const handles = Array.isArray(result) ? result : result.value;
    const windows = [];
    for (const handle of handles) {
      try {
        await this.m.send('WebDriver:SwitchToWindow', { handle });
        const { value: url } = await this.m.send('WebDriver:GetCurrentURL');
        windows.push({ handle, url });
      } catch { /* a closing approval window */ }
    }
    return windows;
  }
  async select(win, { popup = false } = {}) {
    await this.m.send('WebDriver:SwitchToWindow', { handle: win.handle, focus: true });
    await this.m.send('WebDriver:SetWindowRect', popup
      ? { x: 1170, y: 190, width: 640, height: 770 }
      : { x: 1100, y: 0, width: 820, height: 1010 });
  }
  async click(selector) {
    const { value } = await this.m.send('WebDriver:FindElement', { using: 'css selector', value: selector });
    const id = value['element-6066-11e4-a52e-4f735466cecf'];
    assert.ok(id, `Missing UI control ${selector}`);
    await this.m.send('WebDriver:ElementClick', { id });
  }
  async prepareExtras() {
    const target = (await this.windows()).find(w => w.url.startsWith(this.fixtures.deploy));
    assert.ok(target);
    await this.select(target);
    await this.m.navigate(`${this.extensionOrigin}/popup.html`);
    await sleep(800);
    await this.click('#advanced > summary');
    const { value } = await this.m.send('WebDriver:FindElement', { using: 'css selector', value: '#testing-origin' });
    await this.m.send('WebDriver:ElementSendKeys', { id: value['element-6066-11e4-a52e-4f735466cecf'], text: this.fixtures.shop });
    await this.click('#testing-add');
    await sleep(500);
    const sites = await this.m.execute('return document.querySelector("#testing-list").innerText');
    assert.ok(sites.includes(this.fixtures.shop), 'Only the fixture origin is added through Advanced');
    await this.capture('popup-advanced', { selector: '#advanced' });
  }
  async capture(name, { selector = 'body' } = {}) {
    if (this.saved.has(name)) return;
    const url = (await this.m.send('WebDriver:GetCurrentURL')).value;
    const origin = new URL(url).origin;
    assert.ok(url.startsWith(`${this.extensionOrigin}/`) || [this.fixtures.shop, this.fixtures.keys, this.fixtures.deploy].includes(origin), 'Only fixture and extension pages may be captured');
    if (selector === 'body' && url.startsWith(`${this.extensionOrigin}/`)) selector = 'main';
    // Reject private paths even in the throwaway welcome page; never hide them after capture.
    const text = await this.m.execute('return document.body.innerText');
    assert.doesNotMatch(text, /\/home\/|\/Users\/|file:\/\//, 'Private path on capture subject');
    const rect = await this.m.execute(`
      const e=document.querySelector(arguments[0]); const r=e.getBoundingClientRect();
      return {x:r.x+scrollX,y:r.y+scrollY,width:r.width,height:r.height};`, [selector]);
    const png = await this.chrome(`
      const done=arguments[arguments.length-1],r=arguments[0];
      const browser=gBrowser.selectedBrowser;
      browser.browsingContext.currentWindowGlobal.drawSnapshot(new DOMRect(r.x,r.y,r.width,r.height),2,'white')
        .then(bitmap=>{const c=document.createElementNS('http://www.w3.org/1999/xhtml','canvas');
          c.width=bitmap.width;c.height=bitmap.height;c.getContext('2d').drawImage(bitmap,0,0);bitmap.close();
          done(c.toDataURL('image/png').split(',')[1]);}).catch(e=>done({error:String(e)}));`, [rect], true);
    assert.equal(typeof png, 'string', 'Firefox snapshot failed');
    await writeFile(join(this.output, `${name}.png`), Buffer.from(png, 'base64'));
    this.saved.add(name);
    this.events.push({ name, seconds: (Date.now()-this.started)/1000, type: 'screenshot' });
  }
  async subject(name, url) {
    const win = (await this.windows()).find(w => w.url === url);
    assert.ok(win, `The fixture page for ${name} must be open`);
    await this.select(win); await this.capture(name);
  }
  async toolbar(url) {
    const target = (await this.windows()).find(w => w.url === url);
    assert.ok(target, 'The fixture tab for toolbar approval must exist');
    await this.select(target);
    const clicked = await this.chrome(`
      const {ExtensionParent}=ChromeUtils.importESModule('resource://gre/modules/ExtensionParent.sys.mjs');
      const extension=WebExtensionPolicy.getByID(arguments[0])?.extension;
      const win=[...Services.wm.getEnumerator('navigator:browser')].find(w=>w.gBrowser?.selectedBrowser?.currentURI?.spec===arguments[1]);
      if(!win||!extension)return false;
      win.focus();ExtensionParent.apiManager.global.browserActionFor(extension).triggerAction(win);return true;`, [GECKO_ID, url]);
    assert.equal(clicked, true, 'The requested fixture tab must receive the toolbar click');
  }
  async permissions() {
    // Click Firefox's actual Allow control; calling its callback alone leaves the panel visible.
    return this.chrome(`
      for(const win of Services.wm.getEnumerator('navigator:browser')){
        const note=win.PopupNotifications?.getNotification?.('addon-webext-permissions');
        if(note){
          const card=win.document.getElementById('addon-webext-permissions-notification');
          const button=card?.button || card?.querySelector('.popup-notification-primary-button');
          if(!button)throw new Error('Firefox permission Allow control is missing');
          button.click();return true;
        }
      }return false;`);
  }
  async during(promise, approval) {
    let done = false, result, error;
    promise.then(x => { result = x; done = true; }, e => { error = e; done = true; });
    let clicked = false, opened = false;
    const deadline = Date.now() + 90_000;
    while (!done && Date.now() < deadline) {
      if (approval) {
        const windows = await this.windows();
        if (approval.kind === 'action' && !clicked) {
          const card = windows.find(w => w.url.startsWith(`${this.extensionOrigin}/approve.html`));
          if (card) {
            await this.select(card, { popup: true });
            const label = await this.m.execute('return document.getElementById("label")?.textContent');
            assert.ok(label?.includes(approval.label), 'Never approve an unexpected action');
            if (approval.shot === 'approve-once') {
              const total = await this.m.execute('return document.getElementById("total")?.textContent');
              assert.ok(total?.includes('$142.80'), 'The card must show the full fixture total');
            }
            approval.before?.();
            await sleep(this.holdMs);
            await this.capture(approval.shot);
            approval.before?.();
            await this.click('#approve');
            clicked = true;
            this.events.push({ name: approval.shot, type: 'approved', seconds: (Date.now()-this.started)/1000 });
          }
        } else if (approval.kind === 'request' && !clicked) {
          const arm = windows.find(w => w.url.startsWith(`${this.extensionOrigin}/arm.html`));
          const popup = windows.find(w => w.url.startsWith(`${this.extensionOrigin}/popup.html`));
          if (arm) {
            await this.select(arm, { popup: true });
            await sleep(this.holdMs);
            await this.capture(approval.shot);
            await this.toolbar(approval.url);
            clicked = true;
          } else if (popup && !opened) {
            await this.select(popup, { popup: true });
            await sleep(this.holdMs);
            if (approval.shot === 'test-site') {
              await this.click('.request-card select option[value="testing"]');
              await sleep(250);
            }
            await this.capture(approval.shot, { selector: '.request-card' });
            if (approval.shot === 'approval-card') await this.capture('level-picker', { selector: '.request-level' });
            const next = await this.m.execute('return document.querySelector(".open-request:not(:disabled)") ? "open" : document.querySelector(".fai-tab-request:not(:disabled)") ? "reuse" : null');
            if (next) { await this.click(next === 'open' ? '.open-request:not(:disabled)' : '.fai-tab-request:not(:disabled)'); opened = true; clicked = next === 'reuse'; }
          } else if (opened && windows.some(w => w.url === approval.url)) {
            await this.toolbar(approval.url);
            clicked = true;
          }
        }
        if (clicked && approval.kind === 'request') await this.permissions();
      }
      if (!done) await sleep(200);
    }
    if (!done) throw new Error('Timed out waiting for real MCP/UI result; recording aborted');
    if (error) throw error;
    if (approval && !clicked) {
      // A fast relay/error is returned unchanged; the session driver decides from next.kind.
      return result;
    }
    if (approval?.kind === 'request') {
      const win = (await this.windows()).find(w => w.url === approval.url);
      if (win) await this.select(win);
    }
    return result;
  }
}
