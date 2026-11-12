// Windows: start a process outside the caller's job object, inheriting none of its handles.
//
// Firefox runs a native messaging host in a job object that kills every process in it when the host exits, and a
// child inherits that job. Node's `detached: true` does not set CREATE_BREAKAWAY_FROM_JOB (libuv leaves it out on
// purpose), so a FAI service the pairing helper starts would die a moment after the add-on paired. A process created
// by WMI (Win32_Process.Create) is created by the WMI service on the user's behalf, outside the caller's job, so it
// outlives the helper. It also inherits none of the caller's handles: CreateProcess (libuv) hands a child every
// inheritable handle, so a service started by setup under a pipe (an agent running the installer) would hold that
// pipe open and the agent's command would never end. The environment is passed in full (WMI would otherwise give the
// user's default one). A service runs hidden through cmd.exe only to send its output to a file (`outputFile`,
// rewritten each start; not daemon.log, which the service opens itself and cmd's redirection would hold without write
// sharing); a browser is started as it is, its window shown.
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { quoteWindowsArg } from './windows.js';

// Reads `{ command, cwd, env, hidden }` from stdin, prints `{ code, pid }`. Its text never contains caller data.
const SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$p = [Console]::In.ReadToEnd() | ConvertFrom-Json',
  '$props = @{ EnvironmentVariables = [string[]]$p.env }',
  'if ($p.hidden) { $props.ShowWindow = [uint16]0 }',
  '$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property $props',
  '$a = @{ CommandLine = [string]$p.command; ProcessStartupInformation = $startup }',
  'if ($p.cwd) { $a.CurrentDirectory = [string]$p.cwd }',
  '$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments $a',
  '[Console]::Out.Write((ConvertTo-Json -Compress @{ code = [int]$r.ReturnValue; pid = [int]$r.ProcessId }))',
].join('\n');

/** PowerShell's -EncodedCommand form of a script (UTF-16LE, base64). */
export function encodePowerShell(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/**
 * The cmd.exe line that runs `[file, ...args]` with stdout and stderr written to `outputFile`. `/s` strips the outer
 * quotes, so quoted paths inside stay quoted. cmd would expand `%NAME%` in any of them, so `%` is refused.
 */
export function breakawayCommandLine({ file, args = [], outputFile, comspec = 'C:\\Windows\\System32\\cmd.exe' }) {
  const parts = [file, ...args, outputFile];
  if (parts.some(part => /[%"\r\n]/.test(String(part)))) {
    throw new Error('A path for the background start contains %, " or a line break');
  }
  const inner = `${[file, ...args].map(part => `"${part}"`).join(' ')} > "${outputFile}" 2>&1`;
  return `${quoteWindowsArg(comspec)} /d /s /c "${inner}"`;
}

/** `NAME=value` strings for Win32_ProcessStartup.EnvironmentVariables (undefined values dropped). */
export function environmentBlock(env) {
  return Object.entries(env)
    .filter(([name, value]) => name && !name.includes('=') && value !== undefined && value !== null)
    .map(([name, value]) => `${name}=${value}`);
}

function runPowerShell(powershell, script, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
      encodePowerShell(script)], { windowsHide: true, timeout: 20_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
    child.stdin.end(input);
  });
}

/**
 * Start `[file, ...args]` outside the caller's job object and without any of its handles. With `outputFile` it runs
 * hidden through cmd.exe, output written there (a background service); without, it is started as it is, its window
 * shown (a browser). Resolves `{ pid }`; rejects when WMI refuses (the caller then falls back to a plain spawn).
 */
export async function spawnOutsideJob({ file, args = [], outputFile, cwd, env = process.env, run = runPowerShell }) {
  const root = env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows';
  const command = outputFile ? breakawayCommandLine({ file, args, outputFile, comspec: join(root, 'System32', 'cmd.exe') })
    : [file, ...args].map(quoteWindowsArg).join(' ');
  const powershell = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const input = JSON.stringify({ command, cwd: cwd ?? null, env: environmentBlock(env), hidden: Boolean(outputFile) });
  const output = String(await run(powershell, SCRIPT, input)).trim();
  let result;
  try {
    result = JSON.parse(output);
  } catch {
    throw new Error(`Win32_Process.Create gave no result (${output.slice(0, 200)})`);
  }
  if (result?.code !== 0 || !result.pid) throw new Error(`Win32_Process.Create failed (code ${result?.code})`);
  return { pid: result.pid };
}
