// Runs Claude Code (`claude -p`) non-interactively as the benchmark host with exactly one MCP server and no built-in
// tools, wrapped in coreutils `timeout`, and parses its stream-json output into the shape lib/metrics.mjs parseEvents
// returns for Codex, so both hosts feed the same records and tables.
//
// Isolation (verified with probeClaudeContext, see bench/README.md):
//   --setting-sources ""            no user/project/local settings, so no ~/.claude/CLAUDE.md, project CLAUDE.md or
//                                   rules load (the user's global CLAUDE.md is a boot pointer that tells Claude to stop)
//   --settings {autoMemoryEnabled:false} + CLAUDE_CODE_DISABLE_AUTO_MEMORY=1   no memory section or MEMORY.md
//   --strict-mcp-config --mcp-config <file>   only the server under test
//   --tools "" --allowedTools mcp__<server>__*  no Bash/Read/WebSearch/...; MCP tools allowed without prompts
//   --disable-slash-commands        no skills (the repo's fai-browser skill must not leak into B)
//   cwd = empty scratch workspace outside the repo, stdin = /dev/null
// Condition R (real install) relaxes three of these on purpose; see claudeArgs.
import { spawn, execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

// Host-side environment for every Claude run: no auto-memory, MCP tool calls may block as long as Codex allows
// (tool_timeout_sec=120), MCP startup as long as Codex's startup_timeout_sec=60.
export const CLAUDE_ENV = Object.freeze({
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  MCP_TOOL_TIMEOUT: '120000',
  MCP_TIMEOUT: '60000',
});

// Prompt-cache TTL for bench runs (Claude Code 2.1.242+, CLAUDE_CODE_PROMPT_CACHE_TTL=5m|1h; listed in the binary and
// https://code.claude.com/docs/en/env-vars). Subscription auth defaults to 1-hour cache writes (2x input price);
// the bench sets 5m by default, which differs from that default and is labelled in config.json and summary.md.
export const CLAUDE_CACHE_TTLS = Object.freeze(['default', '5m', '1h']);
export function claudeRunEnv(base = process.env, ttl = 'default') {
  const env = { ...base };
  if (ttl === '5m' || ttl === '1h') {
    env.CLAUDE_CODE_PROMPT_CACHE_TTL = ttl;
  } else {
    delete env.CLAUDE_CODE_PROMPT_CACHE_TTL;
  }
  return env;
}

export async function claudeInfo(claude = 'claude') {
  try {
    return { version: (await run(claude, ['--version'], { timeout: 20_000 })).stdout.trim(), error: null };
  } catch (error) {
    return { version: null, error: error.message };
  }
}

// `--mcp-config` document for one stdio server.
export function mcpConfig(name, server) {
  const entry = { command: server.command, args: server.args ?? [] };
  if (server.env && Object.keys(server.env).length) {
    entry.env = server.env;
  }
  return { mcpServers: { [name]: entry } };
}

// argv after the binary. The prompt is the positional argument right after -p, before the variadic options
// (--mcp-config, --allowedTools, --disallowedTools) that would otherwise swallow it.
//
// `realInstall` (condition R) runs the host the way a user's install does, so the turns the default run hides show
// up: Claude Code's default tools stay (with them ToolSearch, which defers MCP tools unless the server entry or the
// tool says alwaysLoad, and the Skill tool), project settings load so the skill installed in the scratch workspace's
// .claude/skills/ is listed, and slash commands (skills) stay on. User and local settings, memory, Bash, WebSearch
// and WebFetch stay off as in B.
export function claudeArgs({ prompt, model, effort, mcpConfigPath, serverName, maxTurns = 40, budgetUsd = 2,
  realInstall = false }) {
  const args = ['-p', prompt, '--model', model];
  if (effort) {
    args.push('--effort', effort);
  }
  args.push(
    '--output-format', 'stream-json', '--verbose',
    '--setting-sources', realInstall ? 'project' : '',
    '--settings', JSON.stringify({ autoMemoryEnabled: false }),
    '--strict-mcp-config', '--no-chrome',
  );
  if (!realInstall) {
    args.push('--tools', '');
  }
  args.push(
    '--disallowedTools', 'Bash,WebSearch,WebFetch',
    '--permission-mode', 'dontAsk',
    '--no-session-persistence',
  );
  if (!realInstall) {
    args.push('--disable-slash-commands');
  }
  args.push(
    '--max-turns', String(maxTurns),
    '--max-budget-usd', String(budgetUsd),
  );
  if (mcpConfigPath) {
    args.push('--mcp-config', mcpConfigPath);
  }
  if (serverName) {
    args.push('--allowedTools', realInstall ? `mcp__${serverName}__*,${HOST_OVERHEAD_TOOLS.join(',')}`
      : `mcp__${serverName}__*`);
  }
  return args;
}

// Built-in tools a real install (condition R only) uses to reach the FAI tools and skill: each use is one more host
// turn, not a violation. Only the fai-browser skill counts; reading its installed SKILL.md with Read counts the same
// as a Skill call. In B every built-in tool use stays a violation.
export const HOST_OVERHEAD_TOOLS = Object.freeze(['ToolSearch', 'Skill']);
const SKILL_FILE = /[\\/]skills[\\/]fai-browser[\\/]/;
function overheadTool(block) {
  if (block.name === 'ToolSearch') {
    return 'ToolSearch';
  }
  if (block.name === 'Skill' && block.input?.skill === 'fai-browser') {
    return 'Skill';
  }
  if (block.name === 'Read' && SKILL_FILE.test(String(block.input?.file_path ?? ''))) {
    return 'Skill';
  }
  return null;
}

// Init-event MCP servers that did not come up. "connected" is good, "pending" is only noted; anything else aborts.
export function failedMcpServers(init) {
  return (init?.mcp_servers ?? []).filter(server => server.status !== 'connected' && server.status !== 'pending');
}

// Spawns `timeout -k 10 <s> claude ...` with stdin from /dev/null and streams stdout lines to `onLine`. Kills the run
// (SIGTERM to timeout(1), which forwards it) as soon as the init event reports a failed MCP server. Never throws.
// `envOverrides` win over CLAUDE_ENV (bench/live sets MCP_TOOL_TIMEOUT=600000 while a human approves the tab).
export function runClaude({ claude = 'claude', args, cwd, timeoutS, eventsPath, stderrPath, env, envOverrides, onLine }) {
  return new Promise(resolveRun => {
    const started = performance.now();
    const lines = [];
    const events = createWriteStream(eventsPath);
    const stderr = createWriteStream(stderrPath);
    let child;
    let abortReason = null;
    try {
      child = spawn('timeout', ['-k', '10', `${timeoutS}s`, claude, ...args], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...(env ?? process.env), ...CLAUDE_ENV, ...(envOverrides ?? {}) },
      });
    } catch (error) {
      events.end();
      stderr.end();
      resolveRun({ exitCode: null, signal: null, timedOut: false, wallMs: 0, lines, spawnError: error.message, abortReason });
      return;
    }
    let buffer = '';
    let sawInit = false;
    const flush = chunk => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const text = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!text.trim()) {
          continue;
        }
        const line = { at: performance.now() - started, text };
        lines.push(line);
        events.write(`${text}\n`);
        if (!sawInit && text.includes('"init"')) {
          try {
            const event = JSON.parse(text);
            if (event.type === 'system' && event.subtype === 'init') {
              sawInit = true;
              const failed = failedMcpServers(event);
              if (failed.length && !abortReason) {
                abortReason = `MCP server failed to start: ${failed.map(server => `${server.name} (${server.status})`).join(', ')}`;
                child.kill('SIGTERM');
              }
            }
          } catch {
            // not JSON; the parser counts it
          }
        }
        try {
          onLine?.(line);
        } catch {
          // observers must not break the run
        }
      }
    };
    child.stdout.setEncoding('utf8').on('data', flush);
    child.stderr.pipe(stderr);
    let spawnError = null;
    child.on('error', error => {
      spawnError = error.message;
    });
    child.on('close', (exitCode, signal) => {
      if (buffer.trim()) {
        flush('\n');
      }
      events.end();
      stderr.end();
      resolveRun({
        exitCode,
        signal,
        timedOut: !abortReason && (exitCode === 124 || exitCode === 137),
        wallMs: performance.now() - started,
        lines,
        spawnError,
        abortReason,
      });
    });
  });
}

const MCP_NAME = /^mcp__(.+?)__(.+)$/;

// Claude tool_result -> the MCP CallToolResult shape Codex records ({content: [...], structuredContent, isError}), so
// faiResultFrom and faiEvidence read both hosts alike.
function mcpResult(block, toolUseResult) {
  const fromBlock = typeof block.content === 'string'
    ? [{ type: 'text', text: block.content }]
    : Array.isArray(block.content) ? block.content : [];
  const result = { content: fromBlock, isError: Boolean(block.is_error) };
  if (toolUseResult && typeof toolUseResult === 'object' && !Array.isArray(toolUseResult)) {
    const structured = toolUseResult.structuredContent ?? toolUseResult.structured_content;
    if (structured && typeof structured === 'object') {
      result.structuredContent = structured;
    }
  }
  return result;
}

const cacheWriteSplit = usage => {
  const split = usage?.cache_creation;
  if (!split) {
    return null;
  }
  return { w5m: split.ephemeral_5m_input_tokens || 0, w1h: split.ephemeral_1h_input_tokens || 0 };
};

// Token record in the Codex convention: `input` includes cache reads and cache writes (Claude's input_tokens excludes
// both), `cachedInput` = cache reads, `cacheWrite` (5m + 1h) is the third priced bucket, `output` includes thinking.
export function claudeTokens(usage, modelUsage) {
  const split = cacheWriteSplit(usage);
  const toRecord = ({ input = 0, cacheRead = 0, cacheWrite = 0, output = 0 }) => {
    const share1h = split && split.w5m + split.w1h ? split.w1h / (split.w5m + split.w1h) : 0;
    const cacheWrite1h = Math.round(cacheWrite * share1h);
    return {
      input: input + cacheRead + cacheWrite,
      cachedInput: cacheRead,
      cacheWrite,
      cacheWrite5m: cacheWrite - cacheWrite1h,
      cacheWrite1h,
      output,
    };
  };
  const totals = toRecord({
    input: usage?.input_tokens || 0,
    cacheRead: usage?.cache_read_input_tokens || 0,
    cacheWrite: usage?.cache_creation_input_tokens || 0,
    output: usage?.output_tokens || 0,
  });
  const record = {
    ...totals,
    reasoning: usage?.output_tokens_details?.thinking_tokens || 0,
    uncachedRaw: usage?.input_tokens || 0,
  };
  // modelUsage covers every model the session called (a background model would show up here, not in usage).
  const models = Object.entries(modelUsage ?? {});
  if (models.length) {
    record.byModel = Object.fromEntries(models.map(([slug, m]) => [slug, {
      ...toRecord({
        input: m.inputTokens || 0,
        cacheRead: m.cacheReadInputTokens || 0,
        cacheWrite: m.cacheCreationInputTokens || 0,
        output: m.outputTokens || 0,
      }),
      reportedUsd: m.costUSD ?? null,
    }]));
    const sum = key => Object.values(record.byModel).reduce((total, m) => total + (m[key] || 0), 0);
    for (const key of ['input', 'cachedInput', 'cacheWrite', 'cacheWrite5m', 'cacheWrite1h', 'output']) {
      record[key] = Math.max(record[key], sum(key));
    }
  }
  record.total = record.input + record.output;
  return record;
}

// Parses `claude -p --output-format stream-json --verbose` lines ([{at: msSinceStart, text}]).
// `serverAlias` maps the MCP server name used in the run (fai, playwright) to the name Codex records use
// (fai_browser, playwright) so toolCallsByName keys match across hosts.
export function parseClaudeEvents(lines, { serverAlias = {}, realInstall = false } = {}) {
  const calls = [];
  const open = new Map();
  const messageIds = new Set();
  const perMessageUsage = new Map();
  const messages = [];
  const errors = [];
  let nonMcpToolUses = 0;
  let webSearchTools = 0;
  const hostToolUses = {};
  let unparsed = 0;
  let init = null;
  let result = null;
  for (const { at, text } of lines) {
    let event;
    try {
      event = JSON.parse(text);
    } catch {
      unparsed += 1;
      continue;
    }
    if (event.type === 'system' && event.subtype === 'init') {
      init = event;
    } else if (event.type === 'assistant' && event.message && !event.parent_tool_use_id) {
      const message = event.message;
      if (message.id) {
        messageIds.add(message.id);
        if (message.usage) {
          perMessageUsage.set(message.id, message.usage);
        }
      }
      for (const block of message.content ?? []) {
        if (block.type === 'tool_use') {
          const match = MCP_NAME.exec(block.name ?? '');
          const overhead = match || !realInstall ? null : overheadTool(block);
          if (overhead) {
            hostToolUses[overhead] = (hostToolUses[overhead] || 0) + 1;
          } else if (!match) {
            nonMcpToolUses += 1;
            if (/^web_?search$/i.test(block.name ?? '')) {
              webSearchTools += 1;
            }
          }
          open.set(block.id, {
            id: block.id,
            server: match ? (serverAlias[match[1]] ?? match[1]) : null,
            tool: match ? match[2] : block.name,
            mcp: Boolean(match),
            arguments: block.input ?? null,
            at,
            ts: Date.parse(event.timestamp ?? '') || null,
          });
        } else if (realInstall && block.type === 'server_tool_use' && /tool_search/i.test(block.name ?? '')) {
          // API-side tool search, should a Claude Code version use it instead of its own ToolSearch tool.
          hostToolUses.ToolSearch = (hostToolUses.ToolSearch || 0) + 1;
        } else if (block.type === 'text' && block.text?.trim()) {
          messages.push(block.text);
        }
      }
      if (event.error) {
        errors.push(typeof event.error === 'string' ? event.error : JSON.stringify(event.error).slice(0, 500));
      }
    } else if (event.type === 'user' && event.message && !event.parent_tool_use_id) {
      const blocks = (event.message.content ?? []).filter(block => block?.type === 'tool_result');
      for (const block of blocks) {
        const started = open.get(block.tool_use_id);
        if (!started) {
          continue;
        }
        open.delete(block.tool_use_id);
        const ts = Date.parse(event.timestamp ?? '') || null;
        const toolResult = mcpResult(block, blocks.length === 1 ? event.tool_use_result : null);
        const textOf = () => toolResult.content.filter(part => part?.type === 'text').map(part => part.text).join('\n');
        calls.push({
          id: started.id,
          server: started.server,
          tool: started.tool,
          arguments: started.arguments,
          status: block.is_error ? 'failed' : 'completed',
          error: block.is_error ? textOf().slice(0, 500) : null,
          isError: Boolean(block.is_error),
          startedAtMs: Math.round(started.at),
          ms: Math.round(at - started.at),
          tsMs: started.ts && ts ? ts - started.ts : null,
          result: toolResult,
          mcp: started.mcp,
        });
      }
    } else if (event.type === 'result') {
      result = event;
    }
  }
  for (const started of open.values()) {
    calls.push({
      id: started.id, server: started.server, tool: started.tool, arguments: started.arguments, status: 'incomplete',
      startedAtMs: Math.round(started.at), ms: null, result: null, mcp: started.mcp,
    });
  }
  calls.sort((a, b) => a.startedAtMs - b.startedAtMs);
  // Cumulative usage is only reliable on the result event; per-message usage in the stream is partial (output tokens
  // are a mid-stream count). Without a result (timeout, kill) the per-message sum is the best available lower bound.
  let usageSource = 'result';
  let tokens;
  if (result?.usage) {
    tokens = claudeTokens(result.usage, result.modelUsage);
  } else {
    usageSource = 'messages (partial)';
    const sum = { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } };
    for (const usage of perMessageUsage.values()) {
      for (const key of ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'output_tokens']) {
        sum[key] += usage[key] || 0;
      }
      sum.cache_creation.ephemeral_5m_input_tokens += usage.cache_creation?.ephemeral_5m_input_tokens || 0;
      sum.cache_creation.ephemeral_1h_input_tokens += usage.cache_creation?.ephemeral_1h_input_tokens || 0;
    }
    tokens = claudeTokens(sum, null);
  }
  tokens.turns = result?.num_turns ?? null;
  if (result?.is_error || (result && result.subtype !== 'success')) {
    errors.push(`${result.subtype}${result.terminal_reason ? ` (${result.terminal_reason})` : ''}${result.api_error_status ? `: ${result.api_error_status}` : ''}`);
  }
  const byName = {};
  for (const call of calls) {
    const name = call.tool ? (call.server ? `${call.server}.${call.tool}` : call.tool) : 'incomplete';
    byName[name] = (byName[name] || 0) + 1;
  }
  const mcpCalls = calls.filter(call => call.mcp);
  const serverToolSearches = result?.usage?.server_tool_use?.web_search_requests || 0;
  return {
    threadId: result?.session_id ?? init?.session_id ?? null,
    calls: mcpCalls,
    toolCalls: mcpCalls.length,
    toolCallsByName: byName,
    toolErrors: mcpCalls.filter(call => call.status === 'failed' || call.isError).length,
    usage: tokens,
    usageSource,
    requests: messageIds.size,
    lastMessage: result?.result ?? messages.at(-1) ?? null,
    commandExecutions: nonMcpToolUses - webSearchTools,
    webSearches: webSearchTools + serverToolSearches,
    // ToolSearch / Skill uses (condition R): turns spent reaching the FAI tools and skill.
    hostToolUses,
    errors,
    unparsed,
    firstToolCallMs: mcpCalls.length ? Math.min(...mcpCalls.map(call => call.startedAtMs)) : null,
    claude: {
      version: init?.claude_code_version ?? null,
      model: init?.model ?? null,
      mcpServers: init?.mcp_servers ?? null,
      failedMcpServers: init ? failedMcpServers(init) : null,
      tools: init?.tools ?? null,
      skills: init?.skills ?? null,
      numTurns: result?.num_turns ?? null,
      subtype: result?.subtype ?? null,
      isError: result?.is_error ?? null,
      terminalReason: result?.terminal_reason ?? null,
      stopReason: result?.stop_reason ?? null,
      durationMs: result?.duration_ms ?? null,
      durationApiMs: result?.duration_api_ms ?? null,
      totalCostUsd: result?.total_cost_usd ?? null,
      permissionDenials: result?.permission_denials ?? [],
      sawResult: Boolean(result),
    },
  };
}

// --- context probe ----------------------------------------------------------------------------------------------

export const PROBE_PROMPT = 'Before answering, inspect your full context. List every instruction source in it other '
  + 'than this user message and the built-in Claude Code system prompt: CLAUDE.md or AGENTS.md files, user, project or '
  + 'local instructions, memory sections or memory files, skills, output styles, and system-reminders. Reply with only '
  + 'a JSON array on one line, one object per source: {"kind": "<what it is>", "firstLine": "<its first line, verbatim>"}. '
  + 'Reply [] if there are none.';

// Text that would only be present if the user's global or project instructions leaked into the host.
const FOREIGN_MARKERS = /boot pointer|dos-e|make enter|super-coder|per-shell|fai browser agent usage|memory\.md|auto-?memory/i;
// Account context Claude Code attaches to every session; it carries no instructions.
const BENIGN = /user'?s? ?email|useremail|email address|as you answer the user's questions, you can use the following context/i;

export function judgeProbe(answer) {
  const text = String(answer ?? '').trim();
  let sources = null;
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start >= 0 && end > start) {
    try {
      sources = JSON.parse(text.slice(start, end + 1));
    } catch {
      sources = null;
    }
  }
  if (!Array.isArray(sources)) {
    return { ok: !FOREIGN_MARKERS.test(text) && /^\s*(\[\s*\]|none)\s*$/i.test(text), sources: null, foreign: null, answer: text };
  }
  const foreign = sources.filter(source => {
    const line = `${source?.kind ?? ''} ${source?.firstLine ?? ''}`;
    return !BENIGN.test(line) || FOREIGN_MARKERS.test(line);
  });
  return { ok: foreign.length === 0 && !FOREIGN_MARKERS.test(text), sources, foreign, answer: text };
}

// One cheap session with the exact isolation flags of a bench run (no MCP server, no tools), asking the model to name
// any instruction source besides the prompt. Run once per invocation before any Claude host run.
export async function probeClaudeContext({ claude = 'claude', model, timeoutS = 120, dir } = {}) {
  const scratch = await mkdtemp(join(tmpdir(), 'fai-bench-claude-probe-'));
  const workdir = join(scratch, 'ws');
  await mkdir(workdir);
  const out = dir ?? scratch;
  await mkdir(out, { recursive: true });
  try {
    const args = claudeArgs({ prompt: PROBE_PROMPT, model, effort: 'low', maxTurns: 2, budgetUsd: 0.5 });
    const result = await runClaude({
      claude, args, cwd: workdir, timeoutS,
      eventsPath: join(out, 'claude-probe.events.jsonl'), stderrPath: join(out, 'claude-probe.stderr.txt'),
    });
    const parsed = parseClaudeEvents(result.lines);
    const verdict = judgeProbe(parsed.lastMessage);
    const record = {
      ...verdict,
      exitCode: result.exitCode,
      model,
      costUsd: parsed.claude.totalCostUsd,
      tools: parsed.claude.tools,
      skills: parsed.claude.skills,
      mcpServers: parsed.claude.mcpServers,
      error: result.spawnError || (result.exitCode !== 0 ? `claude exited ${result.exitCode}` : null),
    };
    if (record.error) {
      record.ok = false;
    }
    await writeFile(join(out, 'claude-probe.json'), `${JSON.stringify(record, null, 2)}\n`);
    return record;
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
