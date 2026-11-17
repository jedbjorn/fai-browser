// The approval window (approve.html?bundle=<bundle id>, opened by the worker): everything an agent waits on for one
// task tab (spec #87 "Combined approvals"), from chrome.storage.session `bundles`. One gated action shows as before:
// the site and tab (from the browser), the kind of action, the control's label as page text in quotes, a total the page
// shows and the agent's one line (both untrusted, marked as such), Approve once or Deny. Two items or more (or the
// agent's ask for a higher level or more sites) show each item on its own tagged line, one Approve and one Deny for
// all of them. Neither button has focus at first, so no key press decides. A bundle that changes under the user says
// so and holds both buttons for a second; a click on a changed bundle is refused. The window closes itself once the
// bundle no longer waits. Everything an agent or a page wrote is rendered with textContent only.
import { BUNDLE_TEXT, ENTER_COMMIT_TEXT, KIND_TEXT, PAGE_CHANGED_TEXT, SECRET_USE_TEXT, bundleHeadline, bundleItems, bundleList,
  bundleSummary, bundleTitle, decideBundle, directLine, enterCommitLine, originText, queueLine, secretUseLine } from './approval-card.js';

const UPDATED_HOLD_MS = 1000;
const id = new URLSearchParams(location.search).get('bundle');
const approve = document.getElementById('approve');
const deny = document.getElementById('deny');
const status = document.getElementById('status');
let closing = false;
// The bundle on screen, whether a click is being answered, and until when a change holds the buttons.
let current = null;
let busy = false;
let heldUntil = 0;
let holdTimer = null;

function close() {
  if (closing) return;
  closing = true;
  window.close();
}

function show(node, text) {
  const element = document.getElementById(node);
  element.textContent = text ?? '';
  element.hidden = !text;
  const term = document.getElementById(`${node}-term`);
  if (term) term.hidden = !text;
}

function setButtons() {
  const held = Date.now() < heldUntil;
  approve.disabled = busy || held;
  deny.disabled = busy || held;
}

// The bundle changed under the user (an item joined or left): say so, and hold both buttons for a second.
function holdForUpdate() {
  show('updated', BUNDLE_TEXT.updated);
  heldUntil = Date.now() + UPDATED_HOLD_MS;
  setButtons();
  clearTimeout(holdTimer);
  holdTimer = setTimeout(setButtons, UPDATED_HOLD_MS + 10);
}

function render(list) {
  const index = list.findIndex(item => item.id === id);
  if (index < 0) {
    close();
    return;
  }
  const bundle = list[index];
  if (current && bundle.version !== current.version) holdForUpdate();
  current = bundle;
  const items = bundleItems(bundle);
  document.title = bundleTitle(items.length);
  show('queue', queueLine(list.length - 1));
  show('summary', bundleSummary(items.length));
  approve.textContent = items.length === 1 ? 'Approve once' : 'Approve';
  const single = !bundle.ask && bundle.entries.length === 1;
  document.getElementById('facts').hidden = !single;
  document.getElementById('items').hidden = single;
  if (single) {
    renderEntry(bundle.entries[0]);
    return;
  }
  document.getElementById('headline').replaceChildren(...bundleHeadline(items));
  document.getElementById('items').replaceChildren(bundleList(items));
  show('changed', '');
  const minutes = Math.max(1, Math.round((bundle.expiresAt - Date.now()) / 60_000));
  document.getElementById('detail').textContent = `This waits about ${minutes} more minute${minutes === 1 ? '' : 's'}.`;
}

// One gated action: the window as it was before bundles.
function renderEntry(entry) {
  const secretUse = entry.kind === 'fill_secret' || entry.kind === 'copy_secret';
  document.getElementById('origin').textContent = originText(entry);
  document.getElementById('title').textContent = entry.title || '(no title)';
  const enterUse = entry.kind === 'enter_commit';
  document.getElementById('kind').textContent = secretUse ? SECRET_USE_TEXT[entry.kind] : enterUse ? ENTER_COMMIT_TEXT
    : KIND_TEXT[entry.cls] ?? entry.cls;
  document.getElementById('label').textContent = secretUse && entry.kind === 'copy_secret' ? (entry.secret?.label ?? '') : entry.label || '(unlabelled control)';
  show('total', entry.total ? `${entry.total} (as the page shows it)` : '');
  show('note', entry.note ? `${entry.note} (the agent's words, not checked)` : '');
  show('changed', entry.pageChanged ? PAGE_CHANGED_TEXT : '');
  const minutes = Math.max(1, Math.round((entry.expiresAt - Date.now()) / 60_000));
  const wait = `This request waits about ${minutes} more minute${minutes === 1 ? '' : 's'}.`;
  if (secretUse) {
    const use = secretUseLine(entry);
    document.getElementById('headline').textContent = `${use.line}?`;
    document.getElementById('detail').textContent = `${use.cross ? `This secret came from ${use.from}, another site than ${use.to}. ` : ''}`
      + `Approve once uses it one time, now (within a minute); the agent never receives the value. ${wait}`;
  } else if (entry.kind === 'upload' && entry.file) {
    // An upload: the file (from the agent's workspace), its size and the site that receives it.
    const size = entry.file.size >= 1024 * 1024 ? `${(entry.file.size / 1024 / 1024).toFixed(1)} MB`
      : entry.file.size >= 1024 ? `${Math.round(entry.file.size / 1024)} KB` : `${entry.file.size} bytes`;
    document.getElementById('headline').textContent = `Upload ${entry.file.name} (${size}) to ${originText(entry) || 'this site'}?`;
    document.getElementById('detail').textContent = `Approve once puts this one file from the agent's workspace into the `
      + `file field above (within a minute); the site receives it when the form is sent. ${wait}`;
  } else if (enterUse) {
    // A committing Enter: the agent declared that pressing Enter in this field commits the user.
    document.getElementById('headline').textContent = enterCommitLine(entry);
    document.getElementById('detail').textContent = 'Approve once lets the agent press Enter in this field one time, on the '
      + `page as it is now (within a minute). Nothing else is allowed. ${wait}`;
  } else if (entry.kind === 'dialog') {
    // Accepting a JavaScript dialog (Test site): the label is the dialog's own text.
    document.getElementById('headline').textContent = 'Accept this page dialog?';
    document.getElementById('detail').textContent = `Approve once lets the agent answer OK to the page's next confirm or prompt `
      + `(within a minute). The text above is the page's own. ${wait}`;
  } else {
    document.getElementById('headline').replaceChildren(...directLine(entry));
    document.getElementById('detail').textContent = `Approve once lets the agent click this control one time, on the page as `
      + `it is now (within a minute). Nothing else is allowed. ${wait}`;
  }
}

function decide(decision) {
  if (!current || busy || Date.now() < heldUntil) return;
  busy = true;
  setButtons();
  status.textContent = '';
  // Synchronous up to the browser's site-access prompt (decideBundle): it must open inside this click.
  decideBundle(current, decision).then(() => {
    const one = bundleItems(current).length === 1;
    status.textContent = decision === 'approve' ? (one ? 'Approved once.' : 'Approved.') : 'Denied.';
    setTimeout(close, 400);
  }, error => {
    busy = false;
    if (error.code === 'bundle_changed') holdForUpdate();
    else status.textContent = error.message;
    setButtons();
  });
}

approve.addEventListener('click', () => decide('approve'));
deny.addEventListener('click', () => decide('deny'));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.bundles) render(Array.isArray(changes.bundles.newValue) ? changes.bundles.newValue : []);
});

try {
  const { bundles } = await chrome.storage.session.get(['bundles']);
  render(Array.isArray(bundles) ? bundles : []);
} catch {
  close();
}
// No default focus: the window opens with nothing focused, so Enter or Space decides nothing.
document.activeElement?.blur?.();
