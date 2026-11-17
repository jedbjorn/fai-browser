// FAI chats (spec #84 "Approvals and wakes"): a wake addressed to a chat starts a turn in that chat. The kinds
// (invite, resume, approved, action_approved, action_denied, and spec #87's ask_declined, bundle_approved, bundle_denied
// and bundle_expired) each become one turn whose text is the wake's fixed
// template (src/wake.js wakeText). A chat's wakes run in order, each after the turn running before it has ended. The
// transcript shows each as one short FAI line (src/chat.js faiMessage), as spec #80 shows wakes.
//
// A wake's view has the shape of a session wake (src/sessions.js wakeView), so the popup's "Could not wake …" line and
// the invite card read it the same way: queued while it waits, delivered once its turn started, failed with the turn's
// reason code (chat_signed_out, chat_too_many …) and FAI's line for it, or skipped.
import { randomBytes } from 'node:crypto';
import { faiMessage } from './chat.js';
import { cleanBundleItems, wakeText } from './wake.js';

export const CHAT_WAKE_KINDS = Object.freeze(['invite', 'resume', 'approved', 'action_approved', 'action_denied',
  'ask_declined', 'bundle_approved', 'bundle_denied', 'bundle_expired']);
// Settled wakes are kept this long for the popup's views, as session wakes are.
const WAKE_KEEP_MS = 10 * 60_000;

const iso = ms => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

/**
 * `runner`: the chat runner (startTurn, running, whenDone). `skip(wake)`: true when the chat already saw what the wake
 * is about by the time its turn would start (it then settles as skipped and starts nothing). `onChange()`: a wake
 * changed state.
 */
export function createChatWakes({ runner, skip = () => false, now = Date.now, log = () => {}, onChange = () => {} }) {
  const wakes = new Map();
  // chatId -> the wakes waiting for a turn, oldest first; a chat with an entry has a drain running.
  const queues = new Map();
  let closed = false;

  const changed = () => {
    try {
      onChange();
    } catch (error) {
      log('chat_wake_change_error', { message: String(error?.message ?? error).slice(0, 200) });
    }
  };

  function view(wake) {
    return { wakeId: wake.wakeId, sessionId: null, chatId: wake.chatId, kind: wake.kind, requestId: wake.requestId,
      inviteId: wake.inviteId, state: wake.state, error: wake.error, detail: null, createdAt: iso(wake.createdAt),
      settledAt: iso(wake.settledAt) };
  }

  function settle(wake, state, error = null) {
    wake.state = state;
    wake.error = error;
    wake.settledAt = now();
    log('chat_wake_settled', { chatId: wake.chatId, kind: wake.kind, state, code: error?.code ?? null });
    changed();
  }

  async function startOne(wake) {
    const text = wakeText(wake);
    for (;;) {
      // Wait for the chat's running turn (the user's, or the previous wake's) to end.
      await runner.whenDone(wake.chatId);
      if (closed) return settle(wake, 'failed', { code: 'chat_start_failed', message: 'FAI Browser is shutting down.' });
      if (skip(wake)) return settle(wake, 'skipped');
      try {
        const started = await runner.startTurn({ chatId: wake.chatId, text,
          record: { role: 'fai', text: faiMessage(text).text } });
        settle(wake, 'delivered');
        await started.done;
        return undefined;
      } catch (error) {
        // The user's message took the chat between the check and the start: wait for that turn too.
        if (error?.code === 'chat_too_many' && runner.running(wake.chatId)) continue;
        return settle(wake, 'failed', { code: typeof error?.code === 'string' ? error.code : 'chat_start_failed',
          message: String(error?.message ?? 'The turn could not start.').slice(0, 200) });
      }
    }
  }

  async function drain(chatId) {
    const queue = queues.get(chatId);
    while (queue.length) {
      const wake = queue[0];
      try {
        await startOne(wake);
      } catch (error) {
        log('chat_wake_error', { chatId, message: String(error?.message ?? error).slice(0, 200) });
        if (wake.state === 'queued') settle(wake, 'failed', { code: 'chat_start_failed', message: 'The turn could not start.' });
      }
      queue.shift();
    }
    queues.delete(chatId);
  }

  /**
   * Queue a wake for chat `chatId`: {kind, requestId, inviteId, level, actionId, revision, items (a bundle's),
   * userText (an invite's words from the popup)}. Returns its view at once; its turn starts when the chat is free.
   */
  function queue(chatId, { kind, requestId = null, inviteId = null, level = null, actionId = null, revision = null,
    items = null, userText = '' }) {
    for (const [id, old] of wakes) if (old.settledAt && now() - old.settledAt >= WAKE_KEEP_MS) wakes.delete(id);
    const wake = { wakeId: `wake_${randomBytes(8).toString('base64url')}`, chatId, kind, requestId, inviteId, level,
      actionId, revision, items: items ? cleanBundleItems(items) : null, userText: typeof userText === 'string' ? userText : '',
      state: 'queued', error: null, createdAt: now(), settledAt: null };
    wakes.set(wake.wakeId, wake);
    log('chat_wake_queued', { chatId, kind, requestId, inviteId });
    if (closed) {
      settle(wake, 'failed', { code: 'chat_start_failed', message: 'FAI Browser is shutting down.' });
      return view(wake);
    }
    if (queues.has(chatId)) {
      queues.get(chatId).push(wake);
    } else {
      queues.set(chatId, [wake]);
      drain(chatId);
    }
    changed();
    return view(wake);
  }

  return {
    queue,
    wake: wakeId => (wakes.has(wakeId) ? view(wakes.get(wakeId)) : null),
    /** Wakes still waiting for a turn (daemon shutdown waits for nothing: they fail as the runner closes). */
    pending: () => [...queues.values()].reduce((sum, list) => sum + list.length, 0),
    close: () => {
      closed = true;
    },
  };
}
