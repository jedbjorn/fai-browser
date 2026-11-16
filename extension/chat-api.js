// The chat panel's only route to the FAI service: each call is one message to the worker, which accepts it only from
// the panel page and forwards it unchanged to the service (background.js PANEL_MESSAGES). A failure rejects with the
// service's code, so the panel shows FAI's own fixed line for it (chat-view.js reasonLine).
//
// Contract (spec #84 and spec #80; Sprint 3's panel contract with amendment 1; the daemon work units build the service
// side). A failure is {error: {code, message}} from the service; the panel shows FAI's own line for a code it knows,
// else `message`.
//   state         {}                                    -> worker state: {connection, requests, session}
//   agents        {}                                    -> {agents: {sessions: [...]}} plus the worker state
//   chat_providers {}                                   -> {providers: [{provider, name, available, version, code, line}], defaultProvider}
//   chat_settings {}                                    -> {settings: {defaultProvider, models: {codex, claude, opencode}, appearance}}
//   chat_settings_set {settings}                        -> {settings}
//   chat_models   {provider}                            -> {models: [name]}; a failure means "type a name"
//   chat_list     {offset, limit}                       -> {chats: [{chatId, title, provider, model, lastActiveAt, running}], next}
//   chat_history  {chatId, after}                       -> {chat: {chatId, title, provider, model, reportedModel?, running}, messages, cursor}
//   chat_file     {chatId, name, mime, size, data}      -> {fileId}   one file per call, data in base64
//   chat_send     {chatId} or {provider, model}, text, files: [fileId] -> {chatId, turnId}
//   chat_stop     {chatId}    chat_delete {chatId}    chat_model {chatId, model}
//   agent_chat    {sessionId, after}                    -> {messages, busy, cursor, readable: true | {code, host, version}, ended,
//                                                            reset?, sends?: [{wakeId, state, error}]}
//   agent_send    {sessionId, text}                     -> {ok: true, wakeId, state?: 'queued' | 'sent'}; a failure is "Not delivered"
// A message is {id, role: 'user' | 'agent' | 'fai', text, at, files?: [{name, size, type}], code?, exit?, providerText?}.
// chat_file's MIME type travels as `mime`: `type` is the message type on every hop (Sprint 3 message #169).

export class ChatError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code ?? null;
  }
}

async function call(type, body = {}) {
  let reply;
  try {
    reply = await chrome.runtime.sendMessage({ ...body, type });
  } catch (error) {
    throw new ChatError(error?.message || 'The FAI extension did not answer.', 'unavailable');
  }
  if (!reply) throw new ChatError('The FAI extension did not answer.', 'unavailable');
  // The worker passes {error: message, code}; a reply carrying the service's own {error: {code, message}} is the same.
  if (reply.error && typeof reply.error === 'object') throw new ChatError(String(reply.error.message ?? 'Refused'), reply.error.code);
  if (reply.error) throw new ChatError(String(reply.error), reply.code);
  return reply;
}

export const chatApi = Object.freeze({
  state: () => call('state'),
  agents: () => call('agents'),
  providers: () => call('chat_providers'),
  settings: () => call('chat_settings'),
  saveSettings: settings => call('chat_settings_set', { settings }),
  models: provider => call('chat_models', { provider }),
  list: (offset = 0, limit = 50) => call('chat_list', { offset, limit }),
  history: (chatId, after = null) => call('chat_history', { chatId, after }),
  file: (chatId, file) => call('chat_file', { chatId, ...file }),
  send: message => call('chat_send', message),
  stop: chatId => call('chat_stop', { chatId }),
  remove: chatId => call('chat_delete', { chatId }),
  setModel: (chatId, model) => call('chat_model', { chatId, model }),
  agentRead: (sessionId, after = null) => call('agent_chat', { sessionId, after }),
  agentSend: (sessionId, text) => call('agent_send', { sessionId, text }),
});
