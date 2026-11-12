// The update card in the popup (docs/REFERENCE.md "Updates"): "Update available vX.Y.Z" with the release notes link and
// an Update button, then the install's progress and outcome. The worker keeps the FAI service's update view in the
// session `connection.update` (already reduced to versions, a notes link built from the version, and the last
// install); Update sends `update_install`, which the worker passes to the service only from this popup. Nothing
// installs without that click. Text is set with textContent only.

const RECENT_MS = 24 * 60 * 60_000;

function recent(at, now) {
  const time = Date.parse(at ?? '');
  return Number.isFinite(time) && now - time < RECENT_MS;
}

/**
 * What the card shows for an update view: `{ hidden, state, label, text, notesUrl, button }` where `button` is null
 * (no button) or its label. `installing`: the user just clicked and the reply is not in yet.
 */
export function updateCard(update, { installing = false, now = Date.now() } = {}) {
  const hidden = { hidden: true, state: 'idle', label: '', text: '', notesUrl: null, button: null };
  if (!update || typeof update !== 'object') return hidden;
  const install = update.install;
  const available = update.available === true && typeof update.latest === 'string';
  if (installing || install?.state === 'running') {
    const to = install?.to ?? update.latest ?? '';
    return { hidden: false, state: 'running', label: 'UPDATING', notesUrl: null, button: null,
      text: `Installing ${to}. The FAI service restarts; the browser reloads FAI Browser when it is back.` };
  }
  if (install && ['failed', 'rolled_back'].includes(install.state) && (available || recent(install.at, now))) {
    const what = install.state === 'rolled_back' ? 'Update failed and was undone' : 'Update failed';
    return { hidden: false, state: 'failed', label: 'UPDATE FAILED', notesUrl: available ? update.notesUrl : null,
      button: available ? `Try again: update to ${update.latest}` : null,
      text: `${what}: ${install.message || 'see the update log.'}` };
  }
  if (available && update.installable === false) {
    // Not a git clone (the Windows installer, an npm install): no button, the way to update by hand.
    return { hidden: false, state: 'available', label: 'UPDATE AVAILABLE', notesUrl: update.notesUrl, button: null,
      text: `FAI Browser ${update.latest} is available (you have ${update.current}). `
        + (update.installer ? 'Run the FAI Browser install command again to update (README, Windows).'
          : 'This copy is not a git clone: update it the way you installed it (npm install -g fai-browser@latest).') };
  }
  if (available) {
    return { hidden: false, state: 'available', label: 'UPDATE AVAILABLE', notesUrl: update.notesUrl,
      button: `Update to ${update.latest}`,
      text: `FAI Browser ${update.latest} is available (you have ${update.current}). One click installs it.` };
  }
  if (install?.state === 'succeeded' && install.to === update.current && recent(install.at, now)) {
    return { hidden: false, state: 'succeeded', label: 'UPDATED', notesUrl: null, button: null,
      text: `Updated to ${install.to}. Restart your coding agent so it loads the new version.` };
  }
  return hidden;
}

/** Wire the card. `elements`: {card, label, text, notes, button, error}. Resolves once the first view is shown. */
export async function mountUpdate({ card, label, text, notes, button, error }, { send = message => chrome.runtime.sendMessage(message) } = {}) {
  let update = null;
  let installing = false;

  function render() {
    const view = updateCard(update, { installing });
    card.hidden = view.hidden;
    card.dataset.state = view.state;
    label.textContent = view.label;
    text.textContent = view.text;
    notes.hidden = !view.notesUrl;
    if (view.notesUrl) notes.href = view.notesUrl;
    else notes.removeAttribute('href');
    button.hidden = !view.button;
    button.disabled = installing;
    if (view.button) button.textContent = view.button;
  }

  function apply(connection) {
    if (connection && typeof connection === 'object') update = connection.update ?? null;
    render();
  }

  button.addEventListener('click', async () => {
    if (installing) return;
    installing = true;
    error.textContent = '';
    render();
    try {
      const result = await send({ type: 'update_install' });
      if (result?.error) throw new Error(result.error);
      installing = false;
      apply(result?.connection);
    } catch (failure) {
      installing = false;
      error.textContent = failure.message;
      render();
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes.connection) apply(changes.connection.newValue);
  });
  // While an install runs, ask the worker every 2 s (reconnecting once the restarted service answers), so the outcome
  // shows without reopening the popup.
  setInterval(() => {
    if (update?.install?.state === 'running' && !installing) send({ type: 'connect' }).catch(() => {});
  }, 2000);
  try {
    apply((await chrome.storage.session.get('connection'))?.connection);
  } catch {
    render();
  }
}
