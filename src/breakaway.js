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

// Reads base64 of UTF-8 lines from stdin (command, directory, 1 when hidden, then NAME=value lines), prints
// "<code> <pid>". Its text never contains caller data. It loads no PowerShell module: no JSON cmdlets and no CIM
// cmdlets, only .NET and the [wmiclass] accelerator. Loading a module in a sparse environment (a test's, say) can make
// Windows PowerShell rebuild its module analysis cache first, which took over 30 s on GitHub's runner.
const SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()))',
  '$lines = $text -split "`n"',
  "$startup = ([wmiclass]'Win32_ProcessStartup').CreateInstance()",
  "if ($lines[2] -eq '1') { $startup.ShowWindow = [uint16]0 }",
  "if ($lines.Count -gt 3) { $startup.EnvironmentVariables = [string[]]($lines[3..($lines.Count - 1)] -ne '') }",
  '$cwd = $null',
  'if ($lines[1]) { $cwd = $lines[1] }',
  "$r = ([wmiclass]'Win32_Process').Create($lines[0], $cwd, $startup)",
  "[Console]::Out.Write(('{0} {1}' -f [int]$r.ReturnValue, [int]$r.ProcessId))",
].join('\n');

/** The helper's stdin: base64 of the UTF-8 lines it reads (an environment entry with a line break is left out). */
export function helperInput({ command, cwd, hidden, env }) {
  if (/[\r\n]/.test(command) || /[\r\n]/.test(cwd ?? '')) throw new Error('A line break in the command or directory');
  const lines = [command, cwd ?? '', hidden ? '1' : '0', ...environmentBlock(env).filter(line => !/[\r\n]/.test(line))];
  return Buffer.from(lines.join('\n'), 'utf8').toString('base64');
}

/** PowerShell's -EncodedCommand form of a script (UTF-16LE, base64). */
export function encodePowerShell(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/** The line cmd.exe appends to the output file when the program exits with an error (WMI gives no exit code). */
export const EXIT_ERROR_MARKER = 'FAI_EXIT_ERROR';

/**
 * The cmd.exe line that runs `[file, ...args]` with stdout and stderr written to `outputFile`, and EXIT_ERROR_MARKER
 * appended when it exits with an error. `/s` strips the outer quotes, so quoted paths inside stay quoted. cmd would
 * expand `%NAME%` in any of them, so `%` is refused.
 */
export function breakawayCommandLine({ file, args = [], outputFile, comspec = 'C:\\Windows\\System32\\cmd.exe' }) {
  const parts = [file, ...args, outputFile];
  if (parts.some(part => /[%"\r\n]/.test(String(part)))) {
    throw new Error('A path for the background start contains %, " or a line break');
  }
  const inner = `${[file, ...args].map(part => `"${part}"`).join(' ')} > "${outputFile}" 2>&1`
    + ` || echo ${EXIT_ERROR_MARKER}>> "${outputFile}"`;
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
  const input = helperInput({ command, cwd, hidden: Boolean(outputFile), env });
  const output = String(await run(powershell, SCRIPT, input)).trim();
  const match = /^(\d+) (\d+)$/.exec(output);
  if (!match) throw new Error(`Win32_Process.Create gave no result (${output.slice(0, 200)})`);
  const [code, pid] = [Number(match[1]), Number(match[2])];
  if (code !== 0 || !pid) throw new Error(`Win32_Process.Create failed (code ${code})`);
  return { pid };
}
