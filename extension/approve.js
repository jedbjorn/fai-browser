// The "Approve this action?" window (approve.html?id=<approval id>, opened by the worker's approveCommand): one
// gated action an agent wants to run (the Approve gate, docs/REFERENCE.md). It renders from chrome.storage.session
// `approvals`: the site and tab (from the browser), the kind of action, the control's label as page text in quotes,
// a total the page shows and the agent's one line (both untrusted, marked as such). Approve once or Deny; neither
// button has focus at first, so no key press decides. It closes itself once the action no longer waits. Everything
// an agent or a page wrote is rendered with textContent only.
import { KIND_TEXT, SECRET_USE_TEXT, originText, secretUseLine } from './approval-card.js';

const id = new URLSearchParams(location.search).get('id');
const approve = document.getElementById('approve');
const deny = document.getElementById('deny');
const status = document.getElementById('status');
let closing = false;

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

function render(list) {
  const entry = list.find(item => item.id === id);
  if (!entry) {
    close();
    return;
  }
  const secretUse = entry.kind === 'fill_secret' || entry.kind === 'copy_secret';
  document.getElementById('origin').textContent = originText(entry);
  document.getElementById('title').textContent = entry.title || '(no title)';
  document.getElementById('kind').textContent = secretUse ? SECRET_USE_TEXT[entry.kind] : KIND_TEXT[entry.cls] ?? entry.cls;
  document.getElementById('label').textContent = secretUse && entry.kind === 'copy_secret' ? (entry.secret?.label ?? '') : entry.label || '(unlabelled control)';
  show('total', entry.total ? `${entry.total} (as the page shows it)` : '');
  show('note', entry.note ? `${entry.note} (the agent's words, not checked)` : '');
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
  } else if (entry.kind === 'dialog') {
    // Accepting a JavaScript dialog (Test site): the label is the dialog's own text.
    document.getElementById('headline').textContent = 'Accept this page dialog?';
    document.getElementById('detail').textContent = `Approve once lets the agent answer OK to the page's next confirm or prompt `
      + `(within a minute). The text above is the page's own. ${wait}`;
  } else {
    document.getElementById('detail').textContent = `Approve once lets the agent click this control one time, on the page as `
      + `it is now (within a minute). Nothing else is allowed. ${wait}`;
  }
}

async function decide(decision) {
  approve.disabled = true;
  deny.disabled = true;
  try {
    const reply = await chrome.runtime.sendMessage({ type: 'approval_decision', id, decision });
    if (reply?.error) throw new Error(reply.error);
    status.textContent = decision === 'approve' ? 'Approved once.' : 'Denied.';
    setTimeout(close, 400);
  } catch (error) {
    approve.disabled = false;
    deny.disabled = false;
    status.textContent = error.message;
  }
}

approve.addEventListener('click', () => decide('approve'));
deny.addEventListener('click', () => decide('deny'));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.approvals) render(Array.isArray(changes.approvals.newValue) ? changes.approvals.newValue : []);
});

try {
  const { approvals } = await chrome.storage.session.get(['approvals']);
  render(Array.isArray(approvals) ? approvals : []);
} catch {
  close();
}
// No default focus: the window opens with nothing focused, so Enter or Space decides nothing.
document.activeElement?.blur?.();
