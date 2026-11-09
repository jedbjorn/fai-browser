// "Invite agent" in the toolbar popup (docs/REFERENCE.md "Invites and wakes"): the user is on a tab they already have
// open and invites a connected coding agent to work in it. One tap with one live agent session, one tap on its row
// with several, and a copy line ("Tell your agent: join FAI invite inv-…") when the agent cannot be woken. The level
// is the one last chosen for invites (initially Use = interactive), changed with one tap; Test site only on a listed test site. The
// optional "What should it do?" text is the user's own words: it comes only from this input.
// Everything the daemon reports (host, repo name, ids, errors) is rendered with textContent only.
import { askSiteAccess, element } from './ui.js';

export const HOST_NAMES = Object.freeze({ claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', unknown: 'Agent' });
export const INVITE_LEVELS = Object.freeze([
  { level: 'read-only', name: 'Read' },
  { level: 'interactive', name: 'Use' },
  { level: 'full', name: 'Act' },
]);
// Use is `interactive` here, as the popup's "Preselect up to" calls it: clicks, fills, search, filter, sort and paging.
export const DEFAULT_INVITE_LEVEL = 'interactive';
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
 * What the invite's wake did, in a line, and whether the copy fallback is needed (true; `soft` after a sent wake). `invite` is the request view's
 * `invite` ({state, wake: {state, error}, session, joinedBy}).
 */
export function wakeLine(invite) {
  const who = invite?.session ? agentLabel(invite.session) : 'your agent';
  if (invite?.state === 'joined') {
    return { text: `${invite.joinedBy ? agentLabel(invite.joinedBy) : 'The agent'} joined and works in this tab.`, fallback: false };
  }
  const wake = invite?.wake?.state ?? 'none';
  if (wake === 'queued' || wake === 'sent') return { text: `Waking ${who}…`, fallback: false };
  // "Sent", not "received": Claude Code's socket answers nothing, not even to a refused or held message (checked on
  // 2.1.319), so a delivered wake only means the message was written. The copy line stays one tap away.
  if (wake === 'delivered' || wake === 'skipped') return { text: `Sent to ${who}. It should start in a moment.`, fallback: 'soft' };
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
  // The session whose invite waits for a second tap because it would end another agent's task (see busyTask).
  let confirming = undefined;
  const text = element('input', 'invite-text');
  text.type = 'text';
  text.maxLength = 500;
  text.placeholder = 'What should it do? (optional)';
  text.setAttribute('aria-label', 'What should the agent do? Optional; your own words go to the agent.');
  text.spellcheck = true;

  chrome.storage.local.get(['inviteLevel']).then(saved => {
    // A choice saved as Use before Use meant `interactive` here counts as Use.
    const stored = saved?.inviteLevel === 'reversible' ? 'interactive' : saved?.inviteLevel;
    if (INVITE_LEVELS.some(item => item.level === stored) || stored === 'testing') level = stored;
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
    // This browser holds one tab at a time: inviting ends another agent's task here, so the first tap only says so.
    const other = busyTask(ctx, agent);
    if (other?.owner && confirming !== (agent?.sessionId ?? null)) {
      confirming = agent?.sessionId ?? null;
      render();
      return;
    }
    confirming = undefined;
    const chosen = levels(ctx).some(item => item.level === level) ? level : DEFAULT_INVITE_LEVEL;
    const asked = askSiteAccess(null, { origins: [ctx.currentOrigin], tabMode: 'single' });
    busy = true;
    render();
    say(agent ? `Inviting ${agentLabel(agent)}…` : 'Creating the invite…');
    // The tab and origin shown in this popup: the worker binds nothing if the active tab is no longer that page.
    asked.granted.then(() => chrome.runtime.sendMessage({ type: 'invite', sessionId: agent?.sessionId ?? null, level: chosen,
      text: text.value.trim(), tabId: ctx.currentTabId, origin: ctx.currentOrigin })).then(reply => {
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
      // `soft`: the wake was sent, but a held or refused message cannot be told from a taken one.
      label.append(element('span', '', fallback === 'soft' ? 'If it does not start, tell it: ' : 'Tell your agent: '),
        element('code', 'invite-join', joinLine(invite.inviteId)));
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
      const armed = confirming !== undefined && confirming === (agent?.sessionId ?? null);
      const button = element('button', 'primary-button invite-agent', armed ? 'End that task and invite'
        : agent ? `Invite ${agentLabel(agent)}` : 'Invite agent');
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
        const armed = confirming === agent.sessionId;
        row.append(element('span', 'invite-row-name', armed ? `End that task and invite ${agentLabel(agent)}` : agentLabel(agent)),
          element('span', 'invite-row-meta', hint(agent)));
        row.addEventListener('click', () => invite(agent));
        list.append(row);
      }
    }
    wrap.append(list);
    // One line before the click: an invite here ends the task this browser runs on another tab.
    const conflicts = (agents.length ? agents : [null]).map(agent => busyTask(ctx, agent)).filter(Boolean);
    const other = conflicts[0];
    if (other) {
      const line = element('p', 'level-warning invite-supersede', other.owner
        ? `This will end ${agentLabel(other.owner)}'s current tab task.${confirming !== undefined ? ' Tap again to invite anyway.' : ''}`
        : 'This will end the current FAI tab task.');
      line.setAttribute('role', 'note');
      wrap.append(line);
    }
    return wrap;
  }

  /**
   * The task this browser runs now (an active or paused tab of another request) that an invite for `agent` would end,
   * or null. A request the invited session itself owns is no conflict: it moves to the new tab.
   */
  function busyTask(ctx, agent) {
    return (ctx.requests ?? []).find(request => ['active', 'paused'].includes(request.state) && ctx.here(request)
      && request.lease?.tabId !== undefined && request.lease?.tabId !== ctx.currentTabId
      && !(agent && request.owner?.sessionId === agent.sessionId)) ?? null;
  }

  // Started at (so two look-alike sessions of one repo can be told apart), last activity, and how it is reached.
  function hint(agent) {
    if (agent.host === 'codex' && !agent.ready) return `${startedLabel(agent)}not ready: ask it to run any FAI command`;
    const when = since(agent.lastActiveAt);
    return `${startedLabel(agent)}${[when, agent.wake === 'none' ? 'you paste a line' : ''].filter(Boolean).join(' · ')}`;
  }

  function startedLabel(agent) {
    const at = Date.parse(agent.startedAt ?? '');
    if (!Number.isFinite(at)) return '';
    return `started ${new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · `;
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
