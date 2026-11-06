// Runs `codex exec` non-interactively with one MCP server configured through `-c mcp_servers.<name>.*` overrides,
// wrapped in coreutils `timeout`, and records every stdout JSONL line with its arrival time.
import { spawn, execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);

// Codex built-ins that would let the agent answer without the browser tool under test, or that add noise.
// Only flags this Codex version knows are passed (`--disable` of an unknown feature is a hard error).
export const DISABLED_FEATURES = [
  'browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'in_app_browser', 'computer_use',
  'apps', 'plugins', 'multi_agent', 'multi_agent_v2', 'image_generation', 'shell_tool', 'unified_exec',
];

// Features that add ~700 tokens to every request's prefix without helping a browser task (caching research,
// 2026-10-04: 9,090 -> 8,387 input tokens on a one-request probe). Turned off in both conditions with
// `-c features.<name>=false`, and only when this Codex version lists the feature.
export const CACHE_TRIM_FEATURES = ['tool_suggest', 'skill_search', 'goals', 'sleep_tool', 'realtime_conversation'];

// The trim features this Codex version lists (all of them when the listing is unknown, as for DISABLED_FEATURES).
export const trimFeatures = features => CACHE_TRIM_FEATURES.filter(feature => !features || features.has(feature));

export async function codexInfo(codex = 'codex') {
  const info = { version: null, features: null, error: null };
  try {
    info.version = (await run(codex, ['--version'], { timeout: 20_000 })).stdout.trim();
    const listing = (await run(codex, ['features', 'list'], { timeout: 20_000 })).stdout;
    info.features = new Set(listing.split('\n').map(line => line.trim().split(/\s+/)[0]).filter(Boolean));
  } catch (error) {
    info.error = error.message;
  }
  return info;
}

// TOML literal for a -c value. JSON strings are valid TOML basic strings for the characters we use.
const tomlString = value => JSON.stringify(String(value));
const tomlArray = values => `[${values.map(tomlString).join(',')}]`;
const tomlTable = object => `{${Object.entries(object).map(([key, value]) => `${key}=${tomlString(value)}`).join(',')}}`;

export function mcpOverrides(name, server) {
  const prefix = `mcp_servers.${name}`;
  const args = [
    '-c', `${prefix}.command=${tomlString(server.command)}`,
    '-c', `${prefix}.args=${tomlArray(server.args ?? [])}`,
    // `codex exec` runs with approval policy "never", which rejects MCP tool calls that need approval.
    '-c', `${prefix}.default_tools_approval_mode="approve"`,
    '-c', `${prefix}.startup_timeout_sec=${server.startupTimeoutSec ?? 60}`,
    '-c', `${prefix}.tool_timeout_sec=${server.toolTimeoutSec ?? 120}`,
  ];
  if (server.env && Object.keys(server.env).length) {
    // Codex starts stdio MCP servers with a minimal environment, so anything the server needs goes here.
    args.push('-c', `${prefix}.env=${tomlTable(server.env)}`);
  }
  return args;
}

export function codexArgs({ model, effort, workdir, finalPath, server, serverName, features, sandboxNetwork, keepBuiltins }) {
  const args = [
    'exec', '-m', model, '-c', `model_reasoning_effort=${effort}`,
    '-s', 'workspace-write', '-C', workdir, '--skip-git-repo-check', '--ephemeral', '--json', '-o', finalPath,
  ];
  if (!keepBuiltins) {
    for (const feature of DISABLED_FEATURES) {
      if (!features || features.has(feature)) {
        args.push('--disable', feature);
      }
    }
    args.push('-c', 'web_search="disabled"');
    for (const feature of trimFeatures(features)) {
      args.push('-c', `features.${feature}=false`);
    }
  }
  if (sandboxNetwork) {
    args.push('-c', 'sandbox_workspace_write.network_access=true');
  }
  args.push(...mcpOverrides(serverName, server));
  args.push('-');
  return args;
}

// Spawns `timeout -k 10 <s> codex ...`, feeds the prompt on stdin, and streams stdout lines to `onLine`.
// Never throws for a failed or timed-out run; the caller records the outcome.
export function runCodex({ codex = 'codex', args, prompt, timeoutS, eventsPath, stderrPath, env, onLine }) {
  return new Promise(resolveRun => {
    const started = performance.now();
    const lines = [];
    const events = createWriteStream(eventsPath);
    const stderr = createWriteStream(stderrPath);
    let child;
    try {
      child = spawn('timeout', ['-k', '10', `${timeoutS}s`, codex, ...args], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: env ?? process.env,
      });
    } catch (error) {
      events.end();
      stderr.end();
      resolveRun({ exitCode: null, signal: null, timedOut: false, wallMs: 0, lines, spawnError: error.message });
      return;
    }
    let buffer = '';
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
        try {
          onLine?.(line);
        } catch {
          // observers must not break the run
        }
      }
    };
    child.stdout.setEncoding('utf8').on('data', flush);
    child.stderr.pipe(stderr);
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
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
        // coreutils timeout exits 124 on timeout, 137 if it had to SIGKILL after -k.
        timedOut: exitCode === 124 || exitCode === 137,
        wallMs: performance.now() - started,
        lines,
        spawnError,
      });
    });
  });
}

export async function readFinal(path) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}
