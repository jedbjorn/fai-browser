// A link is judged on every name a person could read as its name (extension/page.js linkGuardClass), in headless
// Chromium and Firefox (playwright-core's Firefox when installed), through BrowserRuntime over the page bridge. Each
// way of shaping a link's label (invisible padding before the action words, an aria-label naming something else,
// generated content, reordered or bidi-overridden text) is refused at read-only by offer and by point exactly as the
// plainly labelled link is, and its button twin stays refused; honest links stay offered; a destination that names
// signing out or a delete makes a link an action whatever its label. CHROMIUM_PATH overrides the Chromium binary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium, firefox } from 'playwright-core';
import { headlessEnv } from '../scripts/headless-env.mjs';
import { BrowserRuntime } from '../src/runtime.js';
import { PageBridge } from './helpers/page-bridge.js';

const ORIGIN = 'https://example.com';
const RLO = '‮';
const PDF = '‬';
const PADDING = 'Your profile and settings menu entry. '.repeat(6);
const pad = style => `<span style="${style}">${PADDING}</span>`;
const reversed = text => Array.from(text).reverse().join('');
// Ways to hide text other than opacity, size or colour: [name, wrap(text)].
const HIDERS = [
  ['text-fill', text => `<span style="-webkit-text-fill-color:transparent">${text}</span>`],
  ['filter', text => `<span style="filter:opacity(0)">${text}</span>`],
  ['clip-path', text => `<span style="display:inline-block;clip-path:inset(0 100% 0 0)">${text}</span>`],
  ['mask', text => `<span style="-webkit-mask-image:linear-gradient(transparent,transparent);mask-image:linear-gradient(transparent,transparent)">${text}</span>`],
  ['overlay', text => `<span style="position:relative"><span>${text}</span><span style="position:absolute;inset:0;background:white"></span></span>`],
  ['behind', text => `<span style="position:relative;z-index:-1">${text}</span>`],
];
// [name, inner html for a two-word action [first, second], extra attributes]: each becomes links (neutral
// destinations) for "Sign out" and "Delete account", and a button with the "Delete account" content (a button's rule).
const TRICKS = [
  ['opacity', ([a, b]) => `${pad('opacity:0')}${a} ${b}`],
  ['font-size', ([a, b]) => `${pad('font-size:0')}${a} ${b}`],
  ['clip', ([a, b]) => `${pad('position:absolute;clip:rect(0 0 0 0);width:1px;height:1px;overflow:hidden')}${a} ${b}`],
  ['off-screen', ([a, b]) => `${pad('position:absolute;left:-9999px')}${a} ${b}`],
  ['background-colour', ([a, b]) => `${pad('color:white')}${a} ${b}`],
  ['aria-label', ([a, b]) => `${a} ${b}`, 'aria-label="Profile"'],
  ['generated', ([a, b]) => `<span class="gen" data-text="${a} ${b}"></span>`],
  ['flex-order', ([a, b]) => `<span style="display:inline-flex"><span style="order:2">${b}</span><span style="order:1">${a}&nbsp;</span></span>`],
  ['bidi-control', ([a, b]) => `${RLO}${reversed(`${a} ${b}`)}${PDF}`],
  ['bidi-css', ([a, b]) => `<span style="direction:rtl;unicode-bidi:bidi-override">${reversed(`${a} ${b}`)}</span>`],
  // Generated text with invisible padding after it; faint, tiny, near-background or collapsed padding; text pushed
  // out of its box; a suffix the link's own box clips away; a tooltip on a link that shows no text of its own.
  ['generated-padded', ([a, b]) => `<span class="gen" data-text="${a} ${b}"></span>${pad('opacity:0')}`],
  ['faint', ([a, b]) => `${pad('opacity:0.01')}${a} ${b}`],
  ['tiny-font', ([a, b]) => `${pad('font-size:0.1px')}${a} ${b}`],
  ['near-colour', ([a, b]) => `${pad('color:#fefefe')}${a} ${b}`],
  ['scaled-away', ([a, b]) => `<span style="display:inline-block;transform:scale(0)">${PADDING}</span>${a} ${b}`],
  ['height-capped', ([a, b]) => `<span style="display:block;max-height:0;overflow:hidden">${PADDING}</span>${a} ${b}`],
  ['indented-away', ([a, b]) => `<span style="display:inline-block;text-indent:-9999px;width:1px;overflow:hidden">${PADDING}</span>${a} ${b}`],
  ['clipped-suffix', ([a, b]) => `${a} ${b}<br>${PADDING}`, 'style="height:15px;overflow:hidden;line-height:15px"'],
  ['title-only', () => '<span class="icon"></span>', 'title="__PHRASE__"'],
  ['several-strings', ([a, b]) => `<span class="gen2" data-a="${a}" data-b="${b}"></span>`],
  // A word before the action that the person does not see, hidden by a property other than opacity or colour: a
  // transparent text fill, a filter, a clip path, a mask, an element laid over it, a place behind the background.
  ...HIDERS.map(([name, wrap]) => [`hidden-word-${name}`, ([a, b]) => `${wrap('Profile')} ${a} ${b}`]),
  ...HIDERS.map(([name, wrap]) => [`hidden-padding-${name}`, ([a, b]) => `${wrap(PADDING)}${a} ${b}`]),
  // An icon link (a glyph, no words) named by its tooltip.
  ['glyph-arrow', () => '\u2192', 'title="__PHRASE__"'],
  ['glyph-cross', () => '\u00d7', 'title="__PHRASE__"'],
  ['glyph-emoji', () => '\u{1f5d1}', 'title="__PHRASE__"'],
];
const PHRASES = { signout: ['Sign', 'out'], delete: ['Delete', 'account'] };
const HONEST = [
  ['/join', 'Sign up'],
  ['/docs/delete-branch', 'How to delete a branch'],
  ['/jane', 'Jane Doe', 'aria-label="Jane Doe"'],
  ['/orders', 'Order history'],
  ['/docs', '<span class="arrow"></span>Docs'],
  ['/settings', '<span style="display:inline-flex"><span>⚙</span><span>Settings</span></span>'],
  ['/blog/logout-tips', 'Why a logout matters'],
  ['/login/forum.html', 'Threads'],
  // A tooltip is not the name a person reads when the link shows text.
  ['/p/4', 'Nike Air', 'title="Buy Nike Air"'],
  ['/projects/9/settings', 'Settings', 'title="Delete or rename project"'],
  ['/docs/next', 'Next \u2192', 'title="Delete records (next page)"'],
];
const DESTINATIONS = [
  ['/logout', 'Profile'],
  ['/account/sign-out', 'My account'],
  ['/items/5?action=delete', 'Open'],
  ['/#/logout', 'Account'],
  ['/?logout=1', 'Account'],
  ['/auth/signout?next=/', 'Account'],
  ['/me', 'Log me out'],
  ['/me2', 'Sign me out'],
];
const attrs = extra => (extra ? ` ${extra}` : '');
// Three pages, each under the page script's control cap: the shaped links, their button twins, the honest links and
// the destinations.
const page = body => `<!doctype html><html><head><meta charset="utf-8"><title>Guard</title>
<style>body { margin: 0; font: 12px sans-serif; background: white; } .r { height: 22px; overflow: hidden; white-space: nowrap; margin: 2px; }
.gen::before { content: attr(data-text); } .gen2::before { content: attr(data-a) " " attr(data-b); }
.icon { display: inline-block; width: 12px; height: 12px; background: #333; } .arrow::before { content: "\\2192 "; } a, button { display: inline-block; }</style></head><body>
${body}
</body></html>`;
// Links whose covered text a hit test finds only on screen, and links with many text pieces: some in view, some below
// a tall spacer (judged again when a click by id scrolls them into view), and an honest link below the fold.
const cover = text => `<span style="position:relative"><span>${text}</span><span style="position:absolute;inset:0;background:white"></span></span>`;
const under = text => `<span style="position:relative;z-index:-1">${text}</span>`;
const WORDS = PADDING.trim().split(' ');
const IN_VIEW = [
  ['pieces-covered', `${WORDS.slice(0, 20).map(word => cover(`${word} `)).join('')}Sign out`],
  ['pieces-behind', `${WORDS.slice(0, 20).map(word => under(`${word} `)).join('')}Sign out`],
  ['late-piece-covered', `${cover(WORDS.slice(0, 12).map(word => `<b>${word} </b>`).join('') + PADDING)}Sign out`],
  ['decoys-first', `${Array.from({ length: 12 }, () => '<b style="font-size:4px">.</b>').join('')}${under(PADDING)}Sign out`],
  ['middle-covered', `Sign ${cover('menu entry')} out`],
];
const BELOW = [
  ['fold-covered-word', `${cover('Profile')} Sign out`],
  ['fold-covered-padding', `${cover(PADDING)}Sign out`],
  ['fold-behind-word', `${under('Profile')} Sign out`],
];
const FOLD = `<!doctype html><html><head><meta charset="utf-8"><title>Fold</title>
<style>body { margin: 0; font: 12px sans-serif; background: white; } .r { height: 22px; overflow: hidden; white-space: nowrap; margin: 2px; } a { display: inline-block; }</style></head><body>
${IN_VIEW.map(([name, inner]) => `<div class="r"><a id="${name}" href="/n/${name}">${inner}</a></div>`).join('\n')}
<div style="height:3000px"></div>
${BELOW.map(([name, inner]) => `<div class="r"><a id="${name}" href="/n/${name}">${inner}</a></div>`).join('\n')}
<div class="r"><a id="fold-honest" href="/n/fold-honest"><span>Read</span> <span>the guide</span></a></div>
</body></html>`;

const PAGES = {
  '/fold': FOLD,
  '/guard': page(`${TRICKS.map(([name, inner, extra], i) => Object.entries(PHRASES).map(([phrase, words]) => `<div class="r"><a
  id="l-${phrase}-${name}" href="/account/${phrase}-${i}"${attrs(extra?.replace('__PHRASE__', words.join(' ')))}>${inner(words)}</a></div>`).join('\n')).join('\n')}
<div class="r"><a id="l-signout-plain" href="/account/signout-plain">Sign out</a></div>
<div class="r"><a id="l-delete-plain" href="/account/delete-plain">Delete account</a></div>`),
  '/buttons': page(`${TRICKS.map(([name, inner, extra]) => `<div class="r"><button id="b-${name}"${attrs(extra?.replace('__PHRASE__',
    PHRASES.delete.join(' ')))}>${inner(PHRASES.delete)}</button></div>`).join('\n')}
<div class="r"><button id="b-plain">Delete account</button></div>`),
  '/honest': page(`${HONEST.map(([href, inner, extra], i) => `<div class="r"><a id="h-${i}" href="${href}"${attrs(extra)}>${inner}</a></div>`).join('\n')}
${DESTINATIONS.map(([href, inner], i) => `<div class="r"><a id="d-${i}" href="${href}">${inner}</a></div>`).join('\n')}`),
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

  async function open(t, level = 'read-only', path = '/guard') {
    const context = await browser.newContext({ viewport: { width: 1280, height: 2600 } });
    t.after(() => context.close());
    const tab = await context.newPage();
    await tab.route(`${ORIGIN}/**`, route => {
      const body = PAGES[new URL(route.request().url()).pathname];
      return route.fulfill({ contentType: 'text/html', body: body ?? '<title>landed</title>' });
    });
    await tab.goto(`${ORIGIN}${path}`);
    const bridge = new PageBridge(tab, { level });
    const runtime = new BrowserRuntime({ bridge });
    return { context, tab, bridge, runtime, look: () => runtime.observe({ mode: level, allowedOrigins: [ORIGIN] }) };
  }
  const offeredPaths = observed => new Set(observed.actions.filter(action => action.href).map(action => {
    const url = new URL(action.href);
    return `${url.pathname}${url.search}`;
  }));

  test(`${engine.name}: a link whose label is shaped to look harmless is refused like the plainly labelled one`, { skip }, async t => {
    const { look } = await open(t);
    const offered = offeredPaths(await look());
    const other = offeredPaths(await (await open(t, 'read-only', '/honest')).look());
    for (const phrase of Object.keys(PHRASES)) {
      assert.ok(!offered.has(`/account/${phrase}-plain`), `the plainly labelled ${phrase} link is an action`);
      TRICKS.forEach(([name], i) => assert.ok(!offered.has(`/account/${phrase}-${i}`), `${phrase} ${name}: offered`));
    }
    HONEST.forEach(([href, inner]) => assert.ok(other.has(href), `honest link ${inner} (${href}) is offered`));
    DESTINATIONS.forEach(([href, inner]) => assert.ok(!other.has(href), `${href} "${inner}": a sign-out or delete destination`));
  });

  test(`${engine.name}: a point on each shaped link gets the plain link's refusal; nothing runs`, { skip }, async t => {
    const attempt = async (selector, path = '/guard') => {
      const opened = await open(t, 'read-only', path);
      const observed = await opened.look();
      const box = await opened.tab.locator(selector).boundingBox();
      const result = await opened.runtime.act({ point: { x: Math.round(box.x + Math.min(box.width / 2, 20)), y: Math.round(box.y + box.height / 2) } },
        { revision: observed.observation.revision });
      const ran = opened.bridge.executions.length;
      const url = opened.tab.url();
      // One browser context at a time: the attempts are many.
      await opened.context.close();
      assert.equal(ran, 0, `${selector} ran`);
      assert.equal(url, `${ORIGIN}${path}`, `${selector} navigated`);
      return `${result.code}/${result.needs?.level ?? ''}`;
    };
    const plain = { signout: await attempt('#l-signout-plain'), delete: await attempt('#l-delete-plain') };
    assert.deepEqual(plain, { signout: 'refused_action/testing', delete: 'refused_action/full' });
    for (const [name] of TRICKS) {
      for (const phrase of Object.keys(PHRASES)) assert.equal(await attempt(`#l-${phrase}-${name}`), plain[phrase], `${phrase} ${name}`);
    }
    assert.equal(await attempt('#d-0', '/honest'), plain.signout, 'a /logout link labelled "Profile"');
    assert.equal(await attempt('#d-2', '/honest'), plain.delete, 'an ?action=delete link labelled "Open"');
    assert.equal(await attempt('#d-3', '/honest'), plain.signout, 'a #/logout hash route');
  });

  test(`${engine.name}: every piece of a link's text is hit-tested, and a link below the fold is judged again when revealed`, { skip }, async t => {
    const opened = await open(t, 'read-only', '/fold');
    const observed = await opened.look();
    const offered = offeredPaths(observed);
    for (const [name] of IN_VIEW) assert.ok(!offered.has(`/n/${name}`), `${name}: offered`);
    // Below the fold the covering is unknown at observe time: a click by id scrolls the link into view, where the page
    // script judges it again and refuses it before clicking, as it refuses any action link.
    for (const [name] of BELOW) {
      const run = await open(t, 'read-only', '/fold');
      const seen = await run.look();
      const action = seen.actions.find(entry => entry.href === `${ORIGIN}/n/${name}`);
      if (!action) continue;
      const result = await run.runtime.act(action.id, { revision: seen.observation.revision });
      assert.notEqual(result.status, 'checkpoint', `${name}: ${result.code}`);
      assert.equal(run.tab.url(), `${ORIGIN}/fold`, `${name} navigated`);
      await run.context.close();
    }
    // An honest link below the fold is revealed and clicked once.
    const honest = observed.actions.find(entry => entry.href === `${ORIGIN}/n/fold-honest`);
    const result = await opened.runtime.act(honest.id, { revision: observed.observation.revision });
    assert.equal(result.status, 'checkpoint', `${result.code}: ${result.reason}`);
    assert.equal(opened.tab.url(), `${ORIGIN}/n/fold-honest`);
    assert.equal(opened.bridge.executions.length, 1);
  });

  test(`${engine.name}: the button twins stay refused, and the honest links stay clickable`, { skip }, async t => {
    const { look } = await open(t, 'reversible', '/buttons');
    const observed = await look();
    assert.ok(observed.observation.controls.filter(control => control.role === 'button').length >= TRICKS.length + 1, 'every button is observed');
    const buttons = new Set(observed.observation.controls.filter(control => control.role === 'button').map(control => String(control.id)));
    const offeredButtons = observed.actions.filter(action => buttons.has(String(action.target)));
    assert.deepEqual(offeredButtons.map(action => action.label), [], 'no shaped "Delete account" button is offered');
    const honest = await open(t, 'read-only', '/honest');
    const seen = await honest.look();
    const docs = seen.actions.find(action => action.href === `${ORIGIN}/docs/delete-branch`);
    const result = await honest.runtime.act(docs.id, { revision: seen.observation.revision });
    assert.equal(result.status, 'checkpoint', `${result.code}: ${result.reason}`);
    assert.equal(honest.tab.url(), `${ORIGIN}/docs/delete-branch`);
  });
}
