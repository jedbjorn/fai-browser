// A stand-in for a provider's program (Claude Code, Codex, OpenCode) in the chat runner tests: `node chat-standin.js
// <provider> <the program's own arguments>`. It answers --version and the status commands from STANDIN_DIR/control.json,
// logs every call to STANDIN_DIR/calls.jsonl (arguments, working folder, the turn token), and plays one turn in the
// provider's output shape (D5) as control.json's `mode` says: ok, fail, stderr, hang (with a child process).
import { appendFileSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const [provider, ...args] = process.argv.slice(2);
const DEFAULT_VERSIONS = { claude: '2.1.325 (Claude Code)', codex: '0.169.0', opencode: '1.19.5' };
const dir = process.env.STANDIN_DIR;
let control = {};
try {
  control = JSON.parse(readFileSync(join(dir, 'control.json'), 'utf8'))[provider] ?? {};
} catch {
  // Defaults.
}
const log = entry => appendFileSync(join(dir, 'calls.jsonl'), `${JSON.stringify({ provider, pid: process.pid, ...entry })}\n`);
const out = value => process.stdout.write(`${JSON.stringify(value)}\n`);

if (args[0] === '--version') {
  process.stdout.write(`${provider === 'codex' ? 'codex-cli ' : ''}${control.version ?? DEFAULT_VERSIONS[provider]}\n`);
  process.exit(0);
}
if ((provider === 'claude' && args[0] === 'auth') || (provider === 'codex' && args[0] === 'login')) {
  const signedIn = control.signedIn ?? true;
  if (provider === 'claude') out({ loggedIn: signedIn, authMethod: 'claude.ai' });
  else process.stdout.write(signedIn ? 'Logged in using ChatGPT\n' : 'Not logged in\n');
  process.exit(signedIn ? 0 : 1);
}

const token = process.env.FAI_CHAT_TURN_TOKEN ?? null;
log({ args, cwd: process.cwd(), token, xdg: process.env.XDG_CONFIG_HOME ?? null,
  faiSecret: Object.keys(process.env).filter(name => /^FAI_/.test(name) && !['FAI_HOME', 'FAI_CHAT_TURN_TOKEN'].includes(name)) });
const mode = control.mode ?? 'ok';
const conversation = control.conversation ?? `conv-${provider}`;
const turnIndex = args.includes('--resume') || args.includes('resume') || args.includes('--session') ? 2 : 1;
const answer = `answer ${turnIndex} from ${provider}`;

if (mode === 'hang') {
  // A child of its own, like the MCP server a real program starts: Stop must end it too.
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  log({ grandchild: child.pid });
  if (provider === 'claude') out({ type: 'system', subtype: 'init', session_id: conversation, model: 'stand-in-model' });
  setInterval(() => {}, 1000);
} else if (mode === 'stderr') {
  process.stderr.write(control.stderr ?? 'sandbox could not start\n');
  process.exit(1);
} else if (provider === 'claude') {
  out({ type: 'system', subtype: 'init', session_id: conversation, model: 'stand-in-model', tools: ['Read'] });
  out({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hidden thought' }] } });
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__fai__fai_browser_status', input: {} }] } });
  out({ type: 'user', message: { content: [{ type: 'tool_result', content: 'tool output' }] } });
  out({ type: 'stand_in_unknown', text: 'never shown' });
  process.stdout.write('not json at all\n');
  if (mode === 'fail') {
    out({ type: 'assistant', error: 'invalid_request', message: { content: [{ type: 'text', text: control.error }] } });
    out({ type: 'result', subtype: 'success', is_error: true, result: control.error, session_id: conversation });
    process.exit(1);
  }
  out({ type: 'assistant', message: { content: [{ type: 'text', text: answer }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: answer, session_id: conversation });
} else if (provider === 'codex') {
  out({ type: 'thread.started', thread_id: conversation });
  out({ type: 'turn.started' });
  out({ type: 'item.completed', item: { type: 'error', message: 'a configuration warning' } });
  if (mode === 'fail') {
    out({ type: 'error', message: control.error });
    out({ type: 'turn.failed', error: { message: control.error } });
    process.exit(1);
  }
  out({ type: 'item.completed', item: { type: 'agent_message', text: answer } });
  out({ type: 'turn.completed', usage: {} });
} else {
  out({ type: 'step_start', sessionID: conversation, part: { type: 'step-start' } });
  if (mode === 'fail') {
    out({ type: 'error', sessionID: conversation, error: { name: 'APIError', data: { message: control.error } } });
    process.exit(1);
  }
  out({ type: 'text', sessionID: conversation, part: { type: 'text', text: answer } });
  out({ type: 'step_finish', sessionID: conversation, part: { type: 'step-finish', reason: 'stop' } });
}
