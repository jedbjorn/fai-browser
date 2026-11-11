// Reading links (issue #32) through the real page script in headless Chromium and Firefox (playwright-core's Firefox
// when it is installed): BrowserRuntime over test/helpers/page-bridge.js on synthetic pages, several markups per
// front-end trait. Link text inside web components (slotted into a shadow-root <a>, held in a nested component's
// shadow root, a named slot, slot fallback), nested spans and aria-hidden wrappers, role=link script links, links in
// alert banners and live regions, pages with hundreds of shadow roots and deep nesting, a long nav rail (counted in
// moreActions and reachable with a focus), a link to another site listed with its (redacted) destination and refused
// with how to follow it, a long banner the digest shows whole for focus and digestChars and marks when cut, and point
// clicks at read-only: a plain link is followed, a button, a javascript: link and a purchase control are not.
// CHROMIUM_PATH overrides the Chromium binary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium, firefox } from 'playwright-core';
import { headlessEnv } from '../scripts/headless-env.mjs';
import { BrowserRuntime, OTHER_SITE_TEXT } from '../src/runtime.js';
import { agentResult, leanObserve } from '../src/result.js';
import { OTHER_SITE_NEXT } from '../src/other-site.js';
import { directText } from '../src/mcp.js';
import { PURCHASE_REFUSAL_TEXT } from '../src/oversight.js';
import { PageBridge } from './helpers/page-bridge.js';

const ORIGIN = 'https://example.com';
const FAKE_TOKEN = ['FAKE', 'tok0123456789', 'abcdefABCDEF'].join('');
const HIDDEN = 'Your profile and settings menu entry. '.repeat(6);

// Web components, defined before the body is parsed (attributes are read once connected).
const COMPONENTS = `<script>
const shadow = (name, html) => customElements.define(name, class extends HTMLElement {
  connectedCallback() { if (!this.shadowRoot) this.attachShadow({ mode: 'open' }).innerHTML = html(this); }
});
// A link component: the host's light-DOM text is slotted into an <a> inside its shadow root.
shadow('x-link', el => '<a part="control" href="' + el.getAttribute('href') + '"><span part="content"><slot></slot></span></a>');
// A named slot.
shadow('x-named', el => '<a href="' + el.getAttribute('href') + '"><i>›</i> <slot name="label"></slot></a>');
// Slot fallback content: no light children, the slot's own text shows.
shadow('x-fallback', el => '<a href="' + el.getAttribute('href') + '"><slot>' + el.getAttribute('fallback') + '</slot></a>');
// A label component: its text lives only in its own shadow root.
shadow('x-text', el => '<span>' + el.getAttribute('text') + '</span>');
shadow('x-box', () => '<div class="box"><slot></slot></div>');
shadow('x-icon', () => '<i class="icon">*</i>');
// A button component: its name is slotted.
shadow('x-btn', () => '<button onclick="document.title = \\'x-btn\\'"><slot></slot></button>');
</script>`;

const page = (body, title = 'Links') => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${COMPONENTS}
<style>body { margin: 0; font: 14px sans-serif; } a, [role="link"] { display: inline-block; margin: 4px; }
.r { display: block; width: 220px; margin: 4px; } .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }</style>
</head><body>${body}</body></html>`;

const PAGES = {
  '/shadow': page(`
    <nav aria-label="Breadcrumb"><ol>
      <li><x-link href="/home"><span><span>Home</span></span></x-link></li>
      <li><x-link href="/settings">Account settings</x-link></li>
    </ol></nav>
    <x-named href="/billing"><span slot="label">Billing history</span></x-named>
    <a href="/plans"><x-text text="Plans and pricing"></x-text></a>
    <x-fallback href="/help" fallback="Help center"></x-fallback>
    <x-link href="/logout">Sign out</x-link>`),
  '/nested': page(`
    <a href="/verify"><span class="a"><span class="b"><b>Verification</b> <i>Summary</i></span></span></a>
    <a href="/learn"><span aria-hidden="true">→</span><span>Learn more</span></a>
    <div aria-hidden="true"><a href="/partner-ids">View Partner IDs</a></div>
    <span role="link" tabindex="0" onclick="document.title = 'went'"><span><span>go here</span></span></span>
    <div role="link" tabindex="0" onclick="document.title = 'report'"><x-text text="Open report"></x-text></div>`),
  '/alerts': page(`
    <div role="alert">Verify your account. See the <a href="/verify">Verification Summary</a>, or
      <a href="https://learn.other.example/docs?token=${FAKE_TOKEN}">Learn more</a>.</div>
    <div aria-live="assertive" class="toast">Your details expire soon. <a href="/details">Review details</a></div>
    <div role="status" class="banner">New this week: <a href="/whats-new">What's new</a></div>
    <section class="message-bar"><x-box><x-link href="/partner-ids">View Partner IDs</x-link></x-box></section>
    <p>Main content.</p>`),
  '/components': page(`
    <header>${Array.from({ length: 300 }, () => '<x-icon></x-icon>').join('')}</header>
    <p>Status: pending, <x-link href="/status">go here</x-link> to fix it.</p>
    ${Array.from({ length: 7 }).reduce(inner => `<x-box>${inner}</x-box>`, '<x-link href="/deep">Deep link</x-link>')}`),
  '/rail': page(`
    <aside><ul>${Array.from({ length: 150 }, (_, i) => `<li><a href="/nav/${i + 1}">Section ${i + 1}</a></li>`).join('')}</ul></aside>
    <main><h1>Overview</h1><p>Pick a section.</p></main>`),
  '/footer': page(`
    <main><h1>Jane Doe</h1><p>Designer. Projects below.</p><a href="/projects">Projects</a></main>
    <footer style="margin-top: 1200px">
      <a href="https://jane.example.org/site/">Our marketing site</a>
      <a href="https://social.example.net/jane" target="_blank">Social</a>
      <a href="mailto:jane@example.org">Email</a>
    </footer>`),
  '/banner': page(`
    <h1>Legal info</h1>
    <div role="alert">Your account is not verified. ${'Partners in this program must keep their contacts current. '.repeat(10)}
      You must add the Primary Contact in Account Settings, then User Management.</div>
    <div role="alert" id="huge">${'Very long notice text. '.repeat(100)}End of notice.</div>
    <p>Company name: Example Ltd</p>`),
  '/point': page(`
    <a id="about" href="/about" style="display:block;width:140px">About us</a>
    <button id="plan" style="display:block;width:140px" onclick="document.title = 'clicked'">Show plan</button>
    <a id="script" href="javascript:void(document.title = 'script')" style="display:block;width:140px">Open panel</a>
    <button id="buy" style="display:block;width:140px" onclick="document.title = 'bought'">Buy now</button>
    <x-link id="slotted" href="/team" style="display:block;width:140px">Team</x-link>
    <x-link id="spanned" class="r" href="/team"><span>Team page</span></x-link>
    <span id="rolelink" class="r" role="link" tabindex="0" onclick="document.title = 'rolelink'">More info</span>
    <a id="data" class="r" href="data:text/html,hi">Data link</a>`),
  // A web component and its light-DOM twin with the same visible content, side by side: split words, an aria-hidden
  // name next to screen-reader-only text, a long display:none prefix.
  '/guards': page(`
    <x-link id="c-split" class="r" href="/account/delete">Del<b>ete</b> account</x-link>
    <a id="l-split" class="r" href="/account/delete2">Del<b>ete</b> account</a>
    <x-link id="c-so" class="r" href="/logout2">Sign <b>o</b>ut</x-link>
    <a id="l-so" class="r" href="/logout3">Sign <b>o</b>ut</a>
    <x-link id="c-hidden" class="r" href="/logout4"><span aria-hidden="true">Sign out</span><span class="sr">Profile</span></x-link>
    <a id="l-hidden" class="r" href="/logout5"><span aria-hidden="true">Sign out</span><span class="sr">Profile</span></a>
    <x-link id="c-prefix" class="r" href="/logout6"><span style="display:none">${HIDDEN}</span>Sign out</x-link>
    <a id="l-prefix" class="r" href="/logout7"><span style="display:none">${HIDDEN}</span>Sign out</a>
    <x-btn id="c-btn" class="r">Del<b>ete</b></x-btn>
    <button id="l-btn" class="r">Del<b>ete</b></button>
    <x-btn id="c-btn2" class="r"><span aria-hidden="true">Delete</span><span class="sr">Options</span></x-btn>
    <button id="l-btn2" class="r"><span aria-hidden="true">Delete</span><span class="sr">Options</span></button>`),
  // A long project page: 150 same-site links, then the one link to another site last, in the footer.
  '/bigproject': page(`<main><h1>Widget</h1><p>Intro.</p><ul>${Array.from({ length: 150 }, (_, i) => `<li><a href="/docs/topic-${i + 1}">Topic ${i + 1}</a></li>`).join('')}</ul></main>
    <footer><a href="/privacy">Privacy</a> <a href="https://widget-company.example/contact">Built by Widget Co</a></footer>`, 'Widget'),
  // Twelve links to other sites in a profile.
  '/profile': page(`<h1>Jane Doe</h1><p>Builds tools.</p>${Array.from({ length: 12 }, (_, i) => `<a href="https://site${i + 1}.example.net/jane">Profile ${i + 1}</a>`).join(' ')}`, 'Jane'),
  '/about': page('<h1>About</h1><a href="/point">Back</a>', 'About'),
  '/team': page('<h1>Team</h1>', 'Team'),
};

const ENGINES = [
  { name: 'chromium', launch: () => chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    headless: true, env: headlessEnv(), args: ['--no-sandbox'] }), available: () => true },
  { name: 'firefox', launch: () => firefox.launch({ headless: true, env: headlessEnv() }),
    available: () => { try { return existsSync(firefox.executablePath()); } catch { return false; } } },
];

for (const engine of ENGINES) {
  const skip = engine.available() ? false : 'playwright-core Firefox is not installed';
  let browser;
  test.before(async () => {
    if (!skip) browser = await engine.launch();
  });
  test.after(() => browser?.close());

  async function open(t, path, level = 'read-only') {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    t.after(() => context.close());
    const tab = await context.newPage();
    await tab.route(`${ORIGIN}/**`, route => {
      const body = PAGES[new URL(route.request().url()).pathname];
      return body ? route.fulfill({ contentType: 'text/html', body }) : route.fulfill({ status: 404, body: 'missing' });
    });
    await tab.route(/^https:\/\/(?!example\.com\/)/, route => route.abort());
    await tab.goto(ORIGIN + path);
    const bridge = new PageBridge(tab, { level });
    const runtime = new BrowserRuntime({ bridge });
    const look = (options = {}) => runtime.observe({ mode: level, allowedOrigins: [ORIGIN], ...options });
    return { tab, bridge, runtime, look };
  }

  const listedLabels = observed => {
    const listed = new Set(observed.offer.listed);
    return observed.actions.filter(action => listed.has(action.id)).map(action => action.label);
  };
  const byLabel = (observed, label) => observed.actions.find(action => action.label === label);

  test(`${engine.name}: link text slotted into or held inside web components is the link's label`, { skip }, async t => {
    const { look } = await open(t, '/shadow');
    const observed = await look();
    const labels = listedLabels(observed);
    for (const label of ['Home', 'Account settings', 'Billing history', 'Plans and pricing', 'Help center']) {
      assert.ok(labels.some(item => item === label || item.endsWith(` ${label}`)), `${label} in ${JSON.stringify(labels)}`);
    }
    assert.ok(!labels.some(label => /^unlabelled/.test(label)), JSON.stringify(labels));
    assert.equal(byLabel(observed, 'Home').href, `${ORIGIN}/home`);
    // The slotted label is what the guardrails read: a "Sign out" component link is never offered.
    assert.ok(!observed.actions.some(action => /Sign out/.test(action.label ?? '')), 'a sign-out link stays refused');
  });

  test(`${engine.name}: nested spans and aria-hidden wrappers keep their text; role=link script links need Use`, { skip }, async t => {
    const readOnly = await open(t, '/nested');
    const observed = await readOnly.look();
    const labels = listedLabels(observed);
    assert.ok(labels.includes('Verification Summary'), JSON.stringify(labels));
    assert.ok(labels.some(label => label.endsWith('Learn more')), JSON.stringify(labels));
    assert.ok(labels.includes('View Partner IDs'), 'a link under an aria-hidden wrapper that is on screen is offered');
    assert.ok(!labels.includes('go here'), 'a script link (role=link, no href) is not navigation');

    const reversible = await open(t, '/nested', 'reversible');
    const more = listedLabels(await reversible.look());
    assert.ok(more.includes('go here'), JSON.stringify(more));
    assert.ok(more.includes('Open report'), 'a role=link whose text sits in a component shadow root is named by it');
  });

  test(`${engine.name}: links inside alert banners, live regions and message bars are offered with their text`, { skip }, async t => {
    const { look } = await open(t, '/alerts');
    const observed = await look();
    const labels = listedLabels(observed);
    for (const label of ['Verification Summary', 'Review details', "What's new", 'View Partner IDs']) {
      assert.ok(labels.includes(label), `${label} in ${JSON.stringify(labels)}`);
    }
    const learn = byLabel(observed, 'Learn more');
    assert.equal(learn?.type, 'other_site', 'the banner link to another site is listed with its destination');
    assert.ok(!learn.description.includes(FAKE_TOKEN), learn.description);
    assert.match(learn.description, /^Link \d+ to https:\/\/learn\.other\.example\/docs \(other site\): Learn more$/);
    assert.ok(!learn.href.includes(FAKE_TOKEN), 'the href kept internally is redacted too');
    assert.match(learn.href, /token=\[secret:[^\]]+\]/);
    assert.ok(observed.digest.some(block => block.t === 'alert' && /Verify your account/.test(block.text)));
  });

  test(`${engine.name}: hundreds of shadow roots and deep nesting do not hide a link`, { skip }, async t => {
    const { look } = await open(t, '/components');
    const labels = listedLabels(await look());
    assert.ok(labels.includes('go here'), JSON.stringify(labels));
    assert.ok(labels.includes('Deep link'), 'a link seven components deep is read');
  });

  test(`${engine.name}: a long nav rail is counted in moreActions and a focus brings any item in`, { skip }, async t => {
    const { look } = await open(t, '/rail');
    const observed = await look();
    const lean = leanObserve({ revision: observed.observation.revision, page: observed.observation, actions: observed.actions,
      offer: observed.offer, digest: observed.digest });
    const shown = lean.actions.filter(action => /^click "Section \d+"$/.test(action.description)).length;
    assert.equal(shown, 40, 'the read-only listing cap');
    assert.ok(lean.moreActions >= 150 - 40, `moreActions ${lean.moreActions}: every unlisted link is counted`);
    assert.ok(lean.warnings.some(code => /^controls_capped:\d+$/.test(code)));

    const focused = await look({ focus: 'Section 140' });
    assert.ok(listedLabels(focused).includes('Section 140'), 'a focus reaches past the page script\'s cap and the listing cap');
    const other = await look({ focus: 'section 77' });
    assert.ok(listedLabels(other).includes('Section 77'));
  });

  test(`${engine.name}: a footer link to another site shows its destination and is followed by requesting it`, { skip }, async t => {
    const { tab, bridge, runtime, look } = await open(t, '/footer');
    const observed = await look();
    const site = byLabel(observed, 'Our marketing site');
    assert.equal(site?.type, 'other_site');
    assert.equal(site.href, 'https://jane.example.org/site/');
    assert.equal(site.description, `Link ${site.target} to https://jane.example.org/site/ (other site): Our marketing site`);
    assert.equal(byLabel(observed, 'Social')?.type, 'other_site', 'a new-tab link to another site too');
    assert.ok(!observed.actions.some(action => action.label === 'Email'), 'a mailto: link is no site');
    assert.ok(listedLabels(observed).includes('Our marketing site'));

    const result = await runtime.act(site.id, { revision: observed.observation.revision });
    assert.equal(result.code, 'cross_origin');
    assert.equal(result.needs.message, OTHER_SITE_TEXT);
    assert.equal(agentResult(result).next.text, OTHER_SITE_NEXT);
    assert.equal(bridge.executions.length, 0, 'nothing was clicked');
    assert.equal(tab.url(), `${ORIGIN}/footer`);
  });

  test(`${engine.name}: on a long page the footer link to another site is listed, and its host finds it`, { skip }, async t => {
    const { look } = await open(t, '/bigproject');
    const lean = observed => leanObserve({ revision: observed.observation.revision, page: observed.observation,
      actions: observed.actions, offer: observed.offer, digest: observed.digest });
    const plain = lean(await look());
    assert.deepEqual(plain.actions.filter(action => /other site/.test(action.description)).map(action => action.description),
      ['link to https://widget-company.example/contact (other site): "Built by Widget Co"'], 'listed with no task or focus');
    for (const focus of ['widget-company', 'contact']) {
      const focused = lean(await look({ focus }));
      assert.ok(focused.actions.some(action => /widget-company\.example/.test(action.description)), focus);
    }
    // Twelve links to other sites: five listed, the rest named in the moreActions count.
    const profile = await open(t, '/profile');
    const many = lean(await profile.look());
    assert.equal(many.actions.filter(action => /other site/.test(action.description)).length, 5);
    assert.equal(many.moreOtherSites, 7);
    const text = directText({ status: 'observed', ...many });
    assert.match(text, /\(7 more not listed, 7 of them links to other sites; these are the most relevant\)/);
    const generic = lean(await profile.look({ focus: 'jane' }));
    assert.equal(generic.actions.filter(action => /other site/.test(action.description)).length, 5, 'a generic focus word lists no more');
    const named = lean(await profile.look({ focus: 'site9' }));
    assert.ok(named.actions.some(action => /site9\.example\.net/.test(action.description)), 'a host the focus names is listed');
  });

  test(`${engine.name}: a web component never names a control more leniently than its light-DOM twin`, { skip }, async t => {
    const readOnly = await open(t, '/guards');
    const observed = await readOnly.look();
    const offeredHref = path => observed.actions.some(action => action.href === `${ORIGIN}${path}`);
    // Each pair has the same visible content: the same verdict.
    for (const [component, light] of [['/account/delete', '/account/delete2'], ['/logout2', '/logout3'], ['/logout4', '/logout5'],
      ['/logout6', '/logout7']]) {
      assert.equal(offeredHref(component), offeredHref(light), `${component} vs ${light}`);
      assert.equal(offeredHref(component), false, `${component} is an action link: never offered at read-only`);
    }
    const labelOf = id => observed.observation.controls.find(control => control.href === `${ORIGIN}${id}`)?.label;
    assert.equal(labelOf('/account/delete'), 'Delete account', 'split words join as they render');
    assert.equal(labelOf('/logout2'), 'Sign out');
    assert.equal(labelOf('/logout6'), 'Sign out', 'display:none text is no part of the name');
    // A point on the component link is refused as its twin's would be.
    for (const [component, light] of [['#c-split', '#l-split'], ['#c-hidden', '#l-hidden'], ['#c-prefix', '#l-prefix']]) {
      const codes = [];
      for (const selector of [component, light]) {
        const opened = await open(t, '/guards');
        const seen = await opened.look();
        const box = await opened.tab.locator(selector).boundingBox();
        const result = await opened.runtime.act({ point: { x: Math.round(box.x + 8), y: Math.round(box.y + box.height / 2) } },
          { revision: seen.observation.revision });
        codes.push(`${result.code}/${result.needs?.level ?? ''}`);
        assert.equal(opened.tab.url(), `${ORIGIN}/guards`, `${selector} did not navigate`);
      }
      assert.equal(codes[0], codes[1], `${component} ${codes[0]} vs ${light} ${codes[1]}`);
      assert.match(codes[0], /^refused_action\//);
    }
    // Buttons, at reversible: a split or aria-hidden "Delete" is a delete either way.
    const reversible = await open(t, '/guards', 'reversible');
    const buttons = (await reversible.look()).actions.filter(action => action.role === 'button').map(action => action.label);
    assert.ok(!buttons.some(label => /del\s*ete/i.test(label)), JSON.stringify(buttons));
  });

  test(`${engine.name}: a long banner is marked when cut and read whole with focus or digestChars`, { skip }, async t => {
    const { look } = await open(t, '/banner');
    const plain = await look();
    const banner = digest => digest.find(block => block.t === 'alert' && /not verified/.test(block.text))?.text ?? '';
    assert.ok(banner(plain.digest).endsWith('…'), banner(plain.digest));
    assert.ok(!banner(plain.digest).includes('User Management'));

    const focused = await look({ focus: 'Primary Contact' });
    assert.match(banner(focused.digest), /You must add the Primary Contact in Account Settings, then User Management\.$/);
    const wide = await look({ digestChars: 6000 });
    assert.match(banner(wide.digest), /then User Management\.$/);
    // A block longer than the page script reads (1500 characters) is cut there and marked, even at 6000.
    const huge = wide.digest.find(block => /Very long notice/.test(block.text))?.text ?? '';
    assert.ok(huge.endsWith('…') && huge.length <= 1501, `${huge.length}`);
    assert.ok(!huge.includes('End of notice'));
  });

  test(`${engine.name}: a point at read-only follows a plain link (also a web-component link) and refuses the rest`, { skip }, async t => {
    const center = async (tab, selector) => {
      const box = await tab.locator(selector).boundingBox();
      return { x: Math.round(box.x + 10), y: Math.round(box.y + box.height / 2) };
    };
    const attempt = async (selector, path = '/point') => {
      const opened = await open(t, path);
      const observed = await opened.look();
      const result = await opened.runtime.act({ point: await center(opened.tab, selector) }, { revision: observed.observation.revision });
      return { ...opened, result };
    };
    const about = await attempt('#about');
    assert.equal(about.result.status, 'checkpoint', `${about.result.code}: ${about.result.reason} ${JSON.stringify(about.result.point)}`);
    assert.equal(about.tab.url(), `${ORIGIN}/about`);
    assert.ok(about.result.verdict.why.includes('act:point_offered'));

    const team = await attempt('#slotted');
    assert.equal(team.result.status, 'checkpoint', `${team.result.code}: ${team.result.reason}`);
    assert.equal(team.tab.url(), `${ORIGIN}/team`);

    // Light-DOM text wrapped in a span and slotted into the component's <a>: the point still lands on the link.
    const spanned = await attempt('#spanned');
    assert.equal(spanned.result.status, 'checkpoint', `${spanned.result.code}: ${spanned.result.reason}`);
    assert.equal(spanned.tab.url(), `${ORIGIN}/team`);

    // A script link (role=link, no href) needs reversible, as its action id does.
    const roleLink = await attempt('#rolelink');
    assert.equal(roleLink.result.code, 'refused_action');
    assert.equal(roleLink.result.needs.level, 'reversible');
    assert.equal(await roleLink.tab.title(), 'Links');

    // A data: link opens no page: refused at every level, never a level request or an origin to approve.
    const data = await attempt('#data');
    assert.equal(data.result.code, 'refused_action');
    assert.equal(data.result.needs.level, undefined);
    assert.equal(data.bridge.executions.length, 0);

    const plan = await attempt('#plan');
    assert.equal(plan.result.code, 'refused_action');
    assert.equal(plan.result.needs.level, 'reversible');
    assert.equal(await plan.tab.title(), 'Links', 'the button never ran');

    const script = await attempt('#script');
    assert.equal(script.result.code, 'refused_action', 'a javascript: link is a risk refusal, not an origin');
    assert.equal(script.result.needs.level, undefined);
    assert.equal(script.bridge.executions.length, 0);
    assert.equal(await script.tab.title(), 'Links', 'the javascript: link never ran');

    const buy = await attempt('#buy');
    assert.equal(buy.result.code, 'refused_action');
    assert.equal(buy.result.needs.message, PURCHASE_REFUSAL_TEXT);
    assert.equal(await buy.tab.title(), 'Links');
  });
}
