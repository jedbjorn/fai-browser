// The Approve gate in the popup (docs/REFERENCE.md "Approve gate"): a card per agent action waiting for the user's
// Approve click (chrome.storage.session `approvals`, written by the worker), and the three settings that say what
// asks (chrome.storage.local `approvals`, never config.json). The card shows what the approval window shows: the site
// and tab (from the browser), the kind, the control's label in quotes as page text, a total the page shows and the
// agent's one line (both marked untrusted); Approve once or Deny, neither focused first. Shared with approve.js
// (KIND_TEXT). Everything a page or an agent wrote is set with textContent only.
import { pressGuard, replaceCardsPreservingFocus } from './ui.js';

export const KIND_TEXT = {
  purchase: 'A purchase or payment step: the agent may click this one button once. FAI never fills payment details.',
  secret: 'A credential action: it may create, show, copy or revoke a key, token, password or recovery codes.',
  delete: 'A deletion or another change that may not be undone, above the level you granted.',
  submit: 'A submission (save, send, publish, confirm, apply) above the level you granted.',
};

export const KIND_NAME = { purchase: 'Purchase', secret: 'Credential', delete: 'Delete', submit: 'Submit' };

// A secret handle's use (fill_secret, copy_secret): the value never reaches the agent; the user approves each use.
export const SECRET_USE_TEXT = {
  fill_secret: 'FAI pastes the secret into this one field, once. The agent never sees the value. Approve only if this site should have it.',
  copy_secret: 'FAI copies the secret to the clipboard, once. Local programs, including your agent, can read the clipboard.',
};

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

/** One card for a pending approval; `decide(id, decision)` sends the click to the worker. */
export function approvalCard(entry, decide) {
  const card = element('article', 'request-card approval-card');
  card.dataset.approvalId = entry.id;
  const top = element('div', 'card-topline');
  const secretUse = entry.kind === 'fill_secret' || entry.kind === 'copy_secret';
  const uploadUse = entry.kind === 'upload' && entry.file;
  top.append(element('span', 'card-label', secretUse ? 'APPROVE SECRET USE?' : uploadUse ? 'APPROVE UPLOAD?'
    : `APPROVE ${String(KIND_NAME[entry.cls] ?? entry.cls).toUpperCase()}?`),
    element('span', 'request-age', originText(entry)));
  card.append(top);
  card.append(element('p', 'request-meta', entry.title || '(no title)'));
  if (secretUse) {
    const use = secretUseLine(entry);
    card.append(element('p', 'approval-label', use.line), element('p', 'request-meta', SECRET_USE_TEXT[entry.kind]));
    if (use.cross) card.append(element('p', 'request-meta', `This secret came from ${use.from}, another site than ${use.to}.`));
    if (entry.kind === 'fill_secret') card.append(element('p', 'page-text-note', 'The field name is text from the page.'));
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
    label.append(element('q', '', entry.label || '(unlabelled control)'), element('span', 'page-text-note', ' (text from the page)'));
    card.append(label);
  }
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

async function sendDecision(id, decision) {
  const reply = await chrome.runtime.sendMessage({ type: 'approval_decision', id, decision });
  if (reply?.error) throw new Error(reply.error);
}

/**
 * Mounts the cards into `list` (hidden while nothing waits) and the settings into `settings` (either may be null),
 * following storage changes.
 */
export async function mountApprovals({ list = null, settings = null } = {}) {
  // A press on Approve once survives an approvals update (ui.js pressGuard): the update renders after the click.
  const hold = list ? pressGuard(list) : () => false;
  const renderCards = entries => {
    if (!list || hold(() => renderCards(entries))) return;
    const pending = (Array.isArray(entries) ? entries : []).filter(entry => entry && typeof entry.id === 'string');
    replaceCardsPreservingFocus(list, pending.map(entry => approvalCard(entry, sendDecision)));
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
    if (area === 'session' && changes.approvals) renderCards(changes.approvals.newValue);
    if (area === 'local' && changes.approvals) {
      current = normalizeApprovalSettings(changes.approvals.newValue);
      renderSettings();
    }
  });
  try {
    renderCards((await chrome.storage.session.get(['approvals'])).approvals);
    current = normalizeApprovalSettings((await chrome.storage.local.get(['approvals'])).approvals);
  } catch {
    // Storage unavailable: nothing waits, the defaults stand.
  }
  renderSettings();
}
