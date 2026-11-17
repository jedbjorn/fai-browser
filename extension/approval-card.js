// The Approve gate in the popup (docs/REFERENCE.md "Approve gate"): a card per approval bundle waiting for the user's
// Approve click (chrome.storage.session `bundles`, written by the worker; the approval window shows the same), and the
// three settings that say what
// asks (chrome.storage.local `approvals`, never config.json). The card shows what the approval window shows: the site
// and tab (from the browser), the kind, the control's label in quotes as page text, a total the page shows and the
// agent's one line (both marked untrusted); Approve once or Deny, neither focused first. Shared with approve.js
// (KIND_TEXT). Everything a page or an agent wrote is set with textContent only.
import { askSiteAccess, pressGuard, replaceCardsPreservingFocus } from './ui.js';

export const KIND_TEXT = {
  purchase: 'A purchase or payment step: the agent may click this one button once. FAI never fills payment details.',
  secret: 'A credential action: it may create, show, copy or revoke a key, token, password or recovery codes.',
  delete: 'A deletion or another change that may not be undone, above the level you granted.',
  submit: 'A submission (save, send, publish, confirm, apply) above the level you granted.',
};

export const KIND_NAME = { purchase: 'Purchase', secret: 'Credential', delete: 'Delete', submit: 'Submit' };

export const PAGE_CHANGED_TEXT = 'The page has changed since the agent asked.';

// A secret handle's use (fill_secret, copy_secret): the value never reaches the agent; the user approves each use.
export const SECRET_USE_TEXT = {
  fill_secret: 'FAI pastes the secret into this one field, once. The agent never sees the value. Approve only if this site should have it.',
  copy_secret: 'FAI copies the secret to the clipboard, once. Local programs, including your agent, can read the clipboard.',
};

// A committing Enter (the agent sent commits: true): the field's label (page text) and the tab's site from the browser.
export const ENTER_COMMIT_TEXT = 'Agent says this commits you.';

/** The line a committing Enter asks: `Press Enter in "Message" on chat.example.com?`. */
export function enterCommitLine(entry) {
  return `Press Enter in "${entry.label || 'this field'}" on ${hostOf(entry.origin) || 'this site'}?`;
}

const SECRET_WORDS = { password: 'password', 'private-key': 'private key', totp: 'TOTP seed', 'recovery-code': 'recovery code',
  jwt: 'token', generic: 'secret' };

/** Where the control is: its site, and for a control inside a frame from another site, the page that embeds it. */
export function originText(entry) {
  const origin = entry?.origin ?? '';
  return entry?.frameOf && entry.frameOf !== origin ? `${origin} (in a frame of ${entry.frameOf})` : origin;
}

function hostOf(origin) {
  try {
    return new URL(origin).host;
  } catch {
    return '';
  }
}

/**
 * The one line a secret use asks: `Paste secret:3 (openai key from platform.openai.com) into "API key" on vercel.com`
 * or `Copy secret:3 (openai key from platform.openai.com) to the clipboard`. `cross`: the secret came from another
 * site than the one it goes to.
 */
export function secretUseLine(entry) {
  const from = hostOf(entry.secret?.from);
  const to = hostOf(entry.origin);
  const kind = String(entry.secret?.kind ?? 'generic');
  const what = `secret:${entry.handle} (${SECRET_WORDS[kind] ?? `${kind} key`}${from ? ` from ${from}` : ''})`;
  const inFrame = entry.frameOf && hostOf(entry.frameOf) && hostOf(entry.frameOf) !== to ? ` (in a frame of ${hostOf(entry.frameOf)})` : '';
  const line = entry.kind === 'fill_secret' ? `Paste ${what} into "${entry.label || 'this field'}" on ${to || 'this site'}${inFrame}`
    : `Copy ${what} to the clipboard`;
  return { line, cross: Boolean(from && to && from !== to), from, to };
}

export const SETTINGS_TEXT = [
  ['purchase', 'Ask before purchases', 'At Full, a checkout or payment button the agent picks waits for your click. Off: purchases are refused outside testing, as before.'],
  ['secret', 'Ask before credential actions', 'Creating, showing, copying or revoking keys, tokens, passwords or recovery codes waits for your click, at every level. Off: they run at the granted level.'],
  ['level', 'Ask before actions above the level', 'A submit or delete above the level you granted waits for your click. Off: it is refused and the agent asks for a higher level.'],
];

/** The settings as stored: every switch on unless explicitly false. */
export function normalizeApprovalSettings(value) {
  return { purchase: value?.purchase !== false, secret: value?.secret !== false, level: value?.level !== false };
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * The direct line for a click, `Click "<label>" on <site>?`, as nodes: the label in quotes and marked as page text,
 * the site the tab's host as the browser reported it when the agent asked.
 */
export function directLine(entry) {
  const label = element('span', 'page-text', entry.label || '(unlabelled control)');
  label.title = 'Text from the page';
  return ['Click "', label, `" on ${entry.host || hostOf(entry.origin) || 'this site'}?`];
}

// --- Approval bundles (spec #87 "Combined approvals"): everything the agent waits on for one task tab, each item on its
// own line with its tag, one Approve and one Deny. Shared by the approval window (approve.js) and the popup card.

export const BUNDLE_TEXT = {
  eyebrow: 'AGENT ASKS, NOT APPROVED YET',
  updated: 'Updated: the agent added an item. Check the list again.',
  noSiteAccess: 'Browser site access was not granted. Nothing was approved.',
  levelChange: 'This also changes what the agent may do without asking on this task.',
  pageText: ' (text from the page)',
};

// What each level the agent asks for lets it do on the task, after "<Act> on <site>: ".
const LEVEL_LINE = {
  full: 'save, send, submit and delete on this task',
  reversible: 'buttons and fields on this task',
  interactive: 'also search and filter on this task',
  testing: 'log in and buy on this test site',
  'read-only': 'read and follow links on this task',
};
const LEVEL_NAME = { 'read-only': 'Use', reversible: 'Act', interactive: 'Act', full: 'Act', testing: 'Test site' };
const CLICK_TAG = { delete: 'DELETE', submit: 'SUBMIT', purchase: 'PURCHASE', secret: 'CREDENTIAL' };
const WARN_TAGS = new Set(['DELETE', 'PURCHASE', 'CREDENTIAL', 'SECRET', 'COMMITS']);

/** The window title: one item, or how many. */
export function bundleTitle(count) {
  return count === 1 ? 'FAI Browser: approve this?' : `FAI Browser: approve ${count} things?`;
}

/** The line above the buttons (two items or more). */
export function bundleSummary(count) {
  return count > 1 ? `Approve covers all ${count} items, once each. Deny refuses all ${count}.` : '';
}

/** Another tab's bundles waiting for this one. */
export function queueLine(waiting) {
  if (waiting < 1) return '';
  return waiting === 1 ? '1 more approval waits on another tab.' : `${waiting} more approvals wait on other tabs.`;
}

function fileSize(size) {
  return size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : size >= 1024 ? `${Math.round(size / 1024)} KB` : `${size} bytes`;
}

// Page text in quotes, marked as such: `"`, the text, `"`.
function quoted(text) {
  const span = element('span', 'page-text', text);
  span.title = 'Text from the page';
  return ['"', span, '"'];
}

function siteName(origin) {
  return origin.includes('*') ? `all of ${origin.replace(/^https?:\/\/\*\./, '')}` : origin;
}

/**
 * The bundle's items in the order shown (level, sites, then the actions as asked): `{ tag, warn, line, phrase, notes,
 * pageText }`. `line` (nodes) is the item's own line; `phrase` (nodes, verb first, lowercase) is what the headline says
 * of it; `notes` are the lines under it.
 */
export function bundleItems(bundle) {
  const items = [];
  const site = bundle.host || 'this site';
  const ask = bundle.ask;
  if (ask?.level && LEVEL_LINE[ask.level]) {
    const name = `${LEVEL_NAME[ask.level]} on ${site}`;
    items.push({ tag: 'LEVEL', line: [`${name}: ${LEVEL_LINE[ask.level]}`], phrase: [name], notes: [BUNDLE_TEXT.levelChange] });
  }
  const added = [...(ask?.origins ?? [])];
  const access = (ask?.access ?? []).filter(origin => !added.includes(origin));
  if (added.length) {
    const count = `${added.length} more site${added.length === 1 ? '' : 's'}`;
    items.push({ tag: 'SITES', line: [`Also work on ${count}: ${added.map(siteName).join(', ')}`], phrase: [`also work on ${count}`],
      notes: [] });
  } else if (access.length) {
    const count = `${access.length} site${access.length === 1 ? '' : 's'}`;
    items.push({ tag: 'SITES', line: [`Allow site access on ${count}: ${access.map(siteName).join(', ')}`],
      phrase: [`allow site access on ${count}`], notes: [] });
  }
  for (const entry of bundle.entries ?? []) {
    const where = ` on ${entry.host || site}`;
    const notes = [];
    let item;
    if (entry.kind === 'fill_secret' || entry.kind === 'copy_secret') {
      const { line } = secretUseLine(entry);
      item = { tag: 'SECRET', line: [line], phrase: [line.charAt(0).toLowerCase() + line.slice(1)], pageText: entry.kind === 'fill_secret' };
    } else if (entry.kind === 'enter_commit') {
      const label = quoted(entry.label || 'this field');
      item = { tag: 'COMMITS', line: ['Press Enter in ', ...label, where], phrase: ['press Enter in ', ...quoted(entry.label || 'this field')],
        pageText: true };
      notes.push(ENTER_COMMIT_TEXT);
    } else if (entry.kind === 'upload' && entry.file) {
      const what = `${entry.file.name} (${fileSize(entry.file.size)})`;
      item = { tag: 'UPLOAD', line: [`Upload ${what} to ${entry.host || site}`], phrase: [`upload ${what}`] };
    } else if (entry.kind === 'dialog') {
      item = { tag: 'DIALOG', line: ['Accept the dialog ', ...quoted(entry.label), where],
        phrase: ['accept the dialog ', ...quoted(entry.label)], pageText: true };
    } else {
      const label = entry.label || '(unlabelled control)';
      item = { tag: CLICK_TAG[entry.cls] ?? 'ACTION', line: ['Click ', ...quoted(label), where], phrase: ['click ', ...quoted(label)],
        pageText: true };
      if (entry.cls === 'purchase' && entry.total) notes.push(`Total: ${entry.total} (as the page shows it)`);
    }
    if (entry.pageChanged) notes.push(PAGE_CHANGED_TEXT);
    if (entry.note) notes.push(`Agent says: ${entry.note} (not checked)`);
    items.push({ ...item, notes });
  }
  return items.map(item => ({ ...item, warn: WARN_TAGS.has(item.tag) }));
}

function capitalized(nodes) {
  const [first, ...rest] = nodes;
  return typeof first === 'string' ? [first.charAt(0).toUpperCase() + first.slice(1), ...rest] : nodes;
}

/** The headline (nodes): one item's line, `<first> and <second>?`, or `<first> and <n−1> more?`. */
export function bundleHeadline(items) {
  const [first, second] = items;
  // Fresh nodes: the headline and the list are shown together.
  const copy = nodes => nodes.map(node => (typeof node === 'string' ? node : node.cloneNode(true)));
  if (items.length === 1) return [...capitalized(copy(first.phrase)), '?'];
  if (items.length === 2) return [...capitalized(copy(first.phrase)), ' and ', ...copy(second.phrase), '?'];
  return [...capitalized(copy(first.phrase)), ` and ${items.length - 1} more?`];
}

/** The item list: each item on its own line, its tag first (warning colour for the costly ones), its notes under it. */
export function bundleList(items) {
  const list = element('ul', 'bundle-items');
  for (const item of items) {
    const row = element('li', 'bundle-item');
    row.dataset.tag = item.tag;
    const line = element('p', 'bundle-line');
    line.append(element('span', `bundle-tag${item.warn ? ' bundle-warn' : ''}`, item.tag), ' ', ...item.line);
    if (item.pageText) line.append(element('span', 'page-text-note', BUNDLE_TEXT.pageText));
    row.append(line, ...item.notes.map(note => element('p', 'bundle-note', note)));
    list.append(row);
  }
  return list;
}

/**
 * Approve or Deny on a bundle: every item, once each. Approve asks the browser for the ask's site access first, in
 * this click (call it synchronously from the click handler: Firefox shows its prompt only inside a user gesture);
 * refused, nothing is sent and nothing is approved. Rejects with the worker's error (`code` bundle_changed: the bundle
 * changed under the user).
 */
export function decideBundle(bundle, decision) {
  const apply = bundle.ask?.apply;
  const access = decision === 'approve' && apply && (apply.origins.length || apply.patterns.length)
    ? askSiteAccess(apply.patterns.length ? { value: () => 'domain', patterns: apply.patterns, prompt: () => null } : null,
      { requestId: bundle.requestId, level: apply.level, origins: apply.origins, tabMode: 'multiple' }).granted
    : Promise.resolve(true);
  return access.then(async granted => {
    if (!granted) throw new Error(BUNDLE_TEXT.noSiteAccess);
    const reply = await chrome.runtime.sendMessage({ type: 'bundle_decision', bundleId: bundle.id, version: bundle.version, decision });
    if (reply?.error) throw Object.assign(new Error(reply.error), { code: reply.code });
  });
}

/**
 * The popup's card for a bundle, a second place to answer it: a single action keeps its own card (approvalCard); two
 * items or more, or an ask, show the window's lines. Approve, Deny and Show approval window.
 */
export function bundleCard(bundle) {
  if (!bundle.ask && bundle.entries?.length === 1) {
    const card = approvalCard(bundle.entries[0], (_id, decision) => decideBundle(bundle, decision));
    card.dataset.bundleId = bundle.id;
    card.querySelector('.request-actions').append(showButton(bundle, card.querySelector('.status')));
    return card;
  }
  const items = bundleItems(bundle);
  const card = element('article', 'request-card approval-card bundle-card');
  card.dataset.bundleId = bundle.id;
  const top = element('div', 'card-topline');
  top.append(element('span', 'card-label', BUNDLE_TEXT.eyebrow), element('span', 'request-age', bundle.host || ''));
  const headline = element('p', 'approval-label bundle-headline');
  headline.append(...bundleHeadline(items));
  card.append(top, headline, bundleList(items));
  const summary = bundleSummary(items.length);
  if (summary) card.append(element('p', 'request-meta bundle-summary', summary));
  const count = items.length;
  const actions = element('div', 'request-actions');
  const approve = element('button', 'primary-button', count === 1 ? 'Approve once' : 'Approve');
  approve.type = 'button';
  const deny = element('button', 'secondary-button', 'Deny');
  deny.type = 'button';
  const status = element('p', 'status');
  const send = decision => {
    approve.disabled = true;
    deny.disabled = true;
    // Synchronous up to the browser's site-access prompt: it must open inside this click.
    decideBundle(bundle, decision).then(() => {
      status.textContent = decision === 'approve' ? (count === 1 ? 'Approved once.' : 'Approved.') : 'Denied.';
    }, error => {
      approve.disabled = false;
      deny.disabled = false;
      status.textContent = error.code === 'bundle_changed' ? BUNDLE_TEXT.updated : error.message;
    });
  };
  approve.addEventListener('click', () => send('approve'));
  deny.addEventListener('click', () => send('deny'));
  actions.append(approve, deny, showButton(bundle, status));
  card.append(actions, status);
  return card;
}

// Show approval window: the window comes to the front, or opens again after the user closed it.
function showButton(bundle, status) {
  const show = element('button', 'link-button bundle-show', 'Show approval window');
  show.type = 'button';
  show.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'bundle_show', bundleId: bundle.id }).then(reply => {
      if (reply?.error) status.textContent = reply.error;
    }, error => { status.textContent = error.message; });
  });
  return show;
}

/** One card for a pending approval; `decide(id, decision)` sends the click to the worker. */
export function approvalCard(entry, decide) {
  const card = element('article', 'request-card approval-card');
  card.dataset.approvalId = entry.id;
  const top = element('div', 'card-topline');
  const secretUse = entry.kind === 'fill_secret' || entry.kind === 'copy_secret';
  const uploadUse = entry.kind === 'upload' && entry.file;
  const enterUse = entry.kind === 'enter_commit';
  top.append(element('span', 'card-label', secretUse ? 'APPROVE SECRET USE?' : uploadUse ? 'APPROVE UPLOAD?' : enterUse ? 'APPROVE ENTER?'
    : `APPROVE ${String(KIND_NAME[entry.cls] ?? entry.cls).toUpperCase()}?`),
    element('span', 'request-age', originText(entry)));
  card.append(top);
  card.append(element('p', 'request-meta', entry.title || '(no title)'));
  if (secretUse) {
    const use = secretUseLine(entry);
    card.append(element('p', 'approval-label', use.line), element('p', 'request-meta', SECRET_USE_TEXT[entry.kind]));
    if (use.cross) card.append(element('p', 'request-meta', `This secret came from ${use.from}, another site than ${use.to}.`));
    if (entry.kind === 'fill_secret') card.append(element('p', 'page-text-note', 'The field name is text from the page.'));
  } else if (enterUse) {
    card.append(element('p', 'approval-label', enterCommitLine(entry)), element('p', 'request-meta', ENTER_COMMIT_TEXT),
      element('p', 'page-text-note', 'The field name is text from the page.'));
  } else {
    if (uploadUse) {
      const size = entry.file.size >= 1024 * 1024 ? `${(entry.file.size / 1024 / 1024).toFixed(1)} MB`
        : entry.file.size >= 1024 ? `${Math.round(entry.file.size / 1024)} KB` : `${entry.file.size} bytes`;
      card.append(element('p', 'approval-label', `Upload ${entry.file.name} (${size}) to ${originText(entry) || 'this site'}?`),
        element('p', 'request-meta', "Approve once puts this one file from the agent's workspace into the file field below "
          + '(within a minute); the site receives it when the form is sent.'));
    } else {
      card.append(element('p', 'request-meta', KIND_TEXT[entry.cls] ?? ''));
    }
    const label = element('p', 'approval-label');
    // A plain click gets the direct line; an upload or a dialog accept names its control or text as before.
    if (entry.kind) label.append(element('q', '', entry.label || '(unlabelled control)'));
    else label.append(...directLine(entry));
    label.append(element('span', 'page-text-note', ' (text from the page)'));
    card.append(label);
  }
  if (entry.pageChanged) card.append(element('p', 'request-instruction', PAGE_CHANGED_TEXT));
  if (entry.total) card.append(element('p', 'request-meta', `Total: ${entry.total} (as the page shows it)`));
  if (entry.note) card.append(element('p', 'request-instruction', `Agent says: ${entry.note} (not checked)`));
  const actions = element('div', 'request-actions');
  const approve = element('button', 'primary-button', 'Approve once');
  approve.type = 'button';
  const deny = element('button', 'secondary-button', 'Deny');
  deny.type = 'button';
  const status = element('p', 'status');
  const send = async decision => {
    approve.disabled = true;
    deny.disabled = true;
    try {
      await decide(entry.id, decision);
      status.textContent = decision === 'approve' ? 'Approved once.' : 'Denied.';
    } catch (error) {
      approve.disabled = false;
      deny.disabled = false;
      status.textContent = error.message;
    }
  };
  approve.addEventListener('click', () => send('approve'));
  deny.addEventListener('click', () => send('deny'));
  actions.append(approve, deny);
  card.append(actions, status);
  return card;
}

/**
 * Mounts the cards into `list` (hidden while nothing waits) and the settings into `settings` (either may be null),
 * following storage changes.
 */
export async function mountApprovals({ list = null, settings = null } = {}) {
  // A press on Approve once survives an approvals update (ui.js pressGuard): the update renders after the click.
  const hold = list ? pressGuard(list) : () => false;
  const renderCards = bundles => {
    if (!list || hold(() => renderCards(bundles))) return;
    const pending = (Array.isArray(bundles) ? bundles : []).filter(bundle => bundle && typeof bundle.id === 'string');
    replaceCardsPreservingFocus(list, pending.map(bundle => bundleCard(bundle)));
    list.hidden = pending.length === 0;
  };
  let current = normalizeApprovalSettings();
  const renderSettings = () => {
    if (!settings) return;
    const rows = SETTINGS_TEXT.map(([key, name, help]) => {
      const row = element('div', 'approval-setting');
      const label = element('label');
      const box = element('input');
      box.type = 'checkbox';
      box.checked = current[key];
      box.id = `approval-${key}`;
      box.addEventListener('change', () => {
        current = { ...current, [key]: box.checked };
        chrome.storage.local.set({ approvals: current }).catch(() => {});
      });
      label.append(box, element('span', 'approval-setting-name', name));
      row.append(label, element('p', 'field-help', help));
      return row;
    });
    settings.replaceChildren(element('span', 'section-label', 'Approve gate'), ...rows);
  };
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes.bundles) renderCards(changes.bundles.newValue);
    if (area === 'local' && changes.approvals) {
      current = normalizeApprovalSettings(changes.approvals.newValue);
      renderSettings();
    }
  });
  try {
    renderCards((await chrome.storage.session.get(['bundles'])).bundles);
    current = normalizeApprovalSettings((await chrome.storage.local.get(['approvals'])).approvals);
  } catch {
    // Storage unavailable: nothing waits, the defaults stand.
  }
  renderSettings();
}
