// "Invite agent" in the toolbar popup (docs/REFERENCE.md "Invites and wakes"): the user is on a tab they already have
// open and invites a connected coding agent to work in it. One tap with one live agent session, one tap on its row
// with several, and a copy line ("Tell your agent: join FAI invite inv-…") when the agent cannot be woken. The level
// is the one last chosen for invites (initially Use), changed with one tap; Test site only on a listed test site. The
// optional "What should it do?" text is the user's own words: it comes only from this input.
// Everything the daemon reports (host, repo name, ids, errors) is rendered with textContent only.
import { askSiteAccess, element } from './ui.js';

export const HOST_NAMES = Object.freeze({ claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', unknown: 'Agent' });
export const INVITE_LEVELS = Object.freeze([
  { level: 'read-only', name: 'Read' },
  { level: 'reversible', name: 'Use' },
  { level: 'full', name: 'Act' },
]);
export const DEFAULT_INVITE_LEVEL = 'reversible';
const LEVEL_NAMES = { 'read-only': 'Read', reversible: 'Use', interactive: 'Use', full: 'Act', testing: 'Test site' };
const LIVE_INVITE = new Set(['open', 'joined']);

/** "Claude Code · fai-browser" for a session view. */
export function agentLabel(agent) {
  return `${HOST_NAMES[agent?.host] ?? 'Agent'} · ${String(agent?.repo ?? 'unknown')}`;
}

/** The text the user copies when the agent cannot be woken. */
export function joinLine(inviteId) {
  return `join FAI invite ${inviteId}`;
}

function since(at) {
  const ms = Date.now() - Date.parse(at ?? '');
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 60_000) return 'active just now';
  const minutes = Math.round(ms / 60_000);
  return minutes < 60 ? `active ${minutes} min ago` : `active ${Math.round(minutes / 60)} h ago`;
}

/**
 * What the invite's wake did, in a line, and whether the copy fallback is needed. `invite` is the request view's
 * `invite` ({state, wake: {state, error}, session, joinedBy}).
 */
export function wakeLine(invite) {
  const who = invite?.session ? agentLabel(invite.session) : 'your agent';
  if (invite?.state === 'joined') {
    return { text: `${invite.joinedBy ? agentLabel(invite.joinedBy) : 'The agent'} joined and works in this tab.`, fallback: false };
  }
  const wake = invite?.wake?.state ?? 'none';
  if (wake === 'queued' || wake === 'sent') return { text: `Waking ${who}…`, fallback: false };
  if (wake === 'delivered' || wake === 'skipped') return { text: `${who} got the invite and starts in a moment.`, fallback: false };
  if (wake === 'failed') {
    const why = invite.wake.error?.message ? ` (${String(invite.wake.error.message).slice(0, 120)})` : '';
    return { text: `Could not wake ${who}${why}.`, fallback: true };
  }
  return { text: invite?.session ? `${who} cannot be woken by FAI.` : 'Invite ready.', fallback: true };
}

/**
 * Mounts the invite section in `root`. `context()` returns the popup's current view: {connected, currentOrigin,
 * currentTabId, windowMode, testingOrigins, session, requests, here(request)}. `onState(state)` applies a worker
 * reply; `say(text)` writes the popup's status line.
 */
export function mountInvite({ root, context, onState, say }) {
  let agents = [];
  let level = DEFAULT_INVITE_LEVEL;
  let busy = false;
  let copiedFor = null;
  const text = element('input', 'invite-text');
  text.type = 'text';
  text.maxLength = 500;
  text.placeholder = 'What should it do? (optional)';
  text.setAttribute('aria-label', 'What should the agent do? Optional; your own words go to the agent.');
  text.spellcheck = true;

  chrome.storage.local.get(['inviteLevel']).then(saved => {
    if (INVITE_LEVELS.some(item => item.level === saved?.inviteLevel) || saved?.inviteLevel === 'testing') level = saved.inviteLevel;
    render();
  }, () => {});

  function refresh() {
    if (context().windowMode) return Promise.resolve();
    return chrome.runtime.sendMessage({ type: 'agents' }).then(reply => {
      if (reply && !reply.error) agents = Array.isArray(reply.agents?.sessions) ? reply.agents.sessions : [];
      render();
    }, () => {});
  }

  function levels(ctx) {
    const list = [...INVITE_LEVELS];
    if (ctx.currentOrigin && (ctx.testingOrigins ?? []).includes(ctx.currentOrigin)) list.push({ level: 'testing', name: 'Test site' });
    return list;
  }

  function chooseLevel(next) {
    level = next;
    chrome.storage.local.set({ inviteLevel: next }).catch(() => {});
    render();
  }

  // The click: the browser's own site-access prompt first, synchronously inside the gesture (Firefox needs the exact
  // origin; Chromium's toolbar popup already holds activeTab on this tab), then the worker binds the tab.
  function invite(agent) {
    const ctx = context();
    if (busy || !ctx.currentOrigin) return;
    const chosen = levels(ctx).some(item => item.level === level) ? level : DEFAULT_INVITE_LEVEL;
    const asked = askSiteAccess(null, { origins: [ctx.currentOrigin], tabMode: 'single' });
    busy = true;
    render();
    say(agent ? `Inviting ${agentLabel(agent)}…` : 'Creating the invite…');
    asked.granted.then(() => chrome.runtime.sendMessage({ type: 'invite', sessionId: agent?.sessionId ?? null, level: chosen,
      text: text.value.trim() })).then(reply => {
      if (reply?.error) throw new Error(reply.error);
      text.value = '';
      say('');
      onState(reply);
    }).catch(error => say(error.message)).finally(() => {
      busy = false;
      render();
    });
  }

  function cancel(request) {
    busy = true;
    render();
    chrome.runtime.sendMessage({ type: 'invite_cancel', inviteId: request.invite.inviteId, requestId: request.requestId })
      .then(reply => {
        if (reply?.error) throw new Error(reply.error);
        say('Invite cancelled.');
        onState(reply);
      }).catch(error => say(error.message)).finally(() => {
        busy = false;
        render();
      });
  }

  function copy(inviteId, button) {
    const line = joinLine(inviteId);
    Promise.resolve(navigator.clipboard?.writeText?.(line)).then(() => {
      copiedFor = inviteId;
      button.textContent = 'Copied';
    }, () => {
      button.textContent = 'Select and copy';
    });
  }

  function statusCard(request) {
    const invite = request.invite;
    const card = element('article', 'request-card invite-status');
    card.dataset.requestId = request.requestId;
    card.dataset.state = invite.state === 'joined' ? 'active' : 'invited';
    const top = element('div', 'card-topline');
    top.append(element('span', 'card-label', invite.state === 'joined' ? 'INVITED AGENT' : 'INVITE'),
      element('span', 'request-age', `${LEVEL_NAMES[invite.level] ?? invite.level}`));
    card.append(top);
    card.append(element('p', 'invite-where', `${invite.origin}${request.state === 'paused' ? ' · paused' : ''}`));
    const { text: line, fallback } = wakeLine(invite);
    const said = element('p', 'invite-line', line);
    said.setAttribute('role', 'status');
    card.append(said);
    if (fallback && invite.state === 'open') {
      const row = element('div', 'invite-copy');
      const label = element('p', 'invite-copy-text');
      label.append(element('span', '', 'Tell your agent: '), element('code', 'invite-join', joinLine(invite.inviteId)));
      const button = element('button', 'secondary-button invite-copy-button', copiedFor === invite.inviteId ? 'Copied' : 'Copy');
      button.type = 'button';
      button.addEventListener('click', () => copy(invite.inviteId, button));
      row.append(label, button);
      card.append(row);
    }
    if (invite.state === 'open') {
      const actions = element('div', 'request-actions');
      const stop = element('button', 'link-button invite-cancel', 'Cancel invite');
      stop.type = 'button';
      stop.disabled = busy;
      stop.addEventListener('click', () => cancel(request));
      actions.append(stop);
      card.append(actions);
    }
    return card;
  }

  function picker(ctx) {
    const wrap = element('div', 'invite-picker');
    const top = element('div', 'card-topline');
    top.append(element('span', 'card-label', 'INVITE AN AGENT TO THIS TAB'));
    wrap.append(top);
    const chips = element('div', 'invite-levels');
    chips.setAttribute('role', 'radiogroup');
    chips.setAttribute('aria-label', 'Level');
    const offered = levels(ctx);
    const current = offered.some(item => item.level === level) ? level : DEFAULT_INVITE_LEVEL;
    for (const item of offered) {
      const chip = element('button', `invite-level${item.level === 'testing' ? ' level-testing' : ''}`, item.name);
      chip.type = 'button';
      chip.dataset.level = item.level;
      chip.setAttribute('role', 'radio');
      chip.setAttribute('aria-checked', String(item.level === current));
      chip.disabled = busy;
      chip.addEventListener('click', () => chooseLevel(item.level));
      chips.append(chip);
    }
    wrap.append(chips, text);
    text.disabled = busy;
    const list = element('div', 'invite-agents');
    if (agents.length <= 1) {
      const agent = agents[0] ?? null;
      const button = element('button', 'primary-button invite-agent', agent ? `Invite ${agentLabel(agent)}` : 'Invite agent');
      button.type = 'button';
      button.disabled = busy;
      if (agent) button.dataset.sessionId = agent.sessionId;
      button.addEventListener('click', () => invite(agent));
      list.append(button);
      list.append(element('p', 'field-help', agent ? hint(agent)
        : 'No agent session is running FAI Browser. You get a line to paste into your agent.'));
    } else {
      for (const agent of agents) {
        const row = element('button', 'invite-agent invite-row');
        row.type = 'button';
        row.dataset.sessionId = agent.sessionId;
        row.disabled = busy;
        row.append(element('span', 'invite-row-name', agentLabel(agent)), element('span', 'invite-row-meta', hint(agent)));
        row.addEventListener('click', () => invite(agent));
        list.append(row);
      }
    }
    wrap.append(list);
    return wrap;
  }

  function hint(agent) {
    if (agent.host === 'codex' && !agent.ready) return 'not ready: ask it to run any FAI command';
    const when = since(agent.lastActiveAt);
    return agent.wake === 'none' ? [when, 'you paste a line'].filter(Boolean).join(' · ') : when;
  }

  function render() {
    const ctx = context();
    // An active invited tab gets this status card; a paused one keeps its usual request card (Resume, Release).
    const live = (ctx.requests ?? []).filter(request => request.invite && LIVE_INVITE.has(request.invite.state)
      && request.state === 'active' && ctx.here(request));
    const onSessionTab = ctx.session && ['active', 'paused'].includes(ctx.session.status)
      && ctx.session.tabId === ctx.currentTabId;
    const invitedHere = live.some(request => request.lease?.tabId === ctx.currentTabId);
    const showPicker = Boolean(ctx.connected && ctx.currentOrigin && !ctx.windowMode && !onSessionTab && !invitedHere);
    const cards = live.map(statusCard);
    if (showPicker) cards.unshift(picker(ctx));
    // Re-rendering moves the text field: keep the user's caret where it was.
    const typing = document.activeElement === text;
    const caret = typing ? [text.selectionStart, text.selectionEnd] : null;
    root.replaceChildren(...cards);
    root.hidden = cards.length === 0;
    if (typing && text.isConnected) {
      text.focus({ preventScroll: true });
      text.setSelectionRange(...caret);
    }
  }

  refresh();
  return { render, refresh };
}
