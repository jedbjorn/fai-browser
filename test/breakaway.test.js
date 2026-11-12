import test from 'node:test';
import assert from 'node:assert/strict';
import { breakawayCommandLine, encodePowerShell, environmentBlock, spawnOutsideJob } from '../src/breakaway.js';
import { quoteWindowsArg } from '../src/windows.js';
import { ensureDaemon } from '../src/client.js';
import { homePaths } from '../src/home.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('breakawayCommandLine runs the command through cmd with its output in a separate file', () => {
  const line = breakawayCommandLine({ file: 'C:\\FAI Browser\\node\\node.exe', args: ['C:\\app\\src\\daemon-main.js'],
    outputFile: 'C:\\Users\\A B\\AppData\\Local\\fai-browser\\logs\\daemon-start.log' });
  assert.equal(line, 'C:\\Windows\\System32\\cmd.exe /d /s /c ""C:\\FAI Browser\\node\\node.exe" "C:\\app\\src\\daemon-main.js"'
    + ' > "C:\\Users\\A B\\AppData\\Local\\fai-browser\\logs\\daemon-start.log" 2>&1"');
  assert.throws(() => breakawayCommandLine({ file: 'C:\\100%\\node.exe', outputFile: 'C:\\log' }), /contains %/);
  assert.throws(() => breakawayCommandLine({ file: 'C:\\node.exe', args: ['a"b'], outputFile: 'C:\\log' }), /contains %/);
});

test('quoteWindowsArg follows the CommandLineToArgvW rules', () => {
  assert.equal(quoteWindowsArg('plain'), 'plain');
  assert.equal(quoteWindowsArg('C:\\Program Files\\x'), '"C:\\Program Files\\x"');
  assert.equal(quoteWindowsArg('C:\\dir with space\\'), '"C:\\dir with space\\\\"');
  assert.equal(quoteWindowsArg('say "hi"'), '"say \\"hi\\""');
  assert.equal(quoteWindowsArg(''), '""');
});

test('environmentBlock passes every defined variable as NAME=value', () => {
  assert.deepEqual(environmentBlock({ FAI_HOME: 'C:\\h', PATH: 'a;b', EMPTY: '', GONE: undefined, '=C:': 'C:\\' }),
    ['FAI_HOME=C:\\h', 'PATH=a;b', 'EMPTY=']);
});

test('encodePowerShell is base64 of UTF-16LE', () => {
  assert.equal(Buffer.from(encodePowerShell('Write-Output ü'), 'base64').toString('utf16le'), 'Write-Output ü');
});

test('spawnOutsideJob sends the command, directory and environment on stdin, never in the script', async () => {
  const calls = [];
  const run = async (powershell, script, input) => {
    calls.push({ powershell, script, input: JSON.parse(input) });
    return '{"code":0,"pid":4242}';
  };
  const env = { SystemRoot: 'D:\\Win', FAI_HOME: 'C:\\secret-dir', FAI_BRIDGE_SECRET: 's3cret' };
  const result = await spawnOutsideJob({ file: 'C:\\node.exe', args: ['C:\\d.js'], outputFile: 'C:\\o.log', cwd: 'C:\\h', env, run });
  assert.deepEqual(result, { pid: 4242 });
  assert.equal(calls[0].powershell, join('D:\\Win', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
  assert.match(calls[0].script, /Win32_Process -MethodName Create/);
  assert.match(calls[0].script, /ShowWindow = \[uint16\]0/);
  assert.doesNotMatch(calls[0].script, /secret|node\.exe/);
  assert.equal(calls[0].input.cwd, 'C:\\h');
  assert.deepEqual(calls[0].input.env, ['SystemRoot=D:\\Win', 'FAI_HOME=C:\\secret-dir', 'FAI_BRIDGE_SECRET=s3cret']);
  assert.ok(calls[0].input.command.startsWith(`${join('D:\\Win', 'System32', 'cmd.exe')} /d /s /c ""C:\\node.exe" "C:\\d.js" > "C:\\o.log" 2>&1"`));
  await assert.rejects(spawnOutsideJob({ file: 'C:\\n.exe', outputFile: 'C:\\o', env, run: async () => '{"code":9,"pid":0}' }), /code 9/);
  await assert.rejects(spawnOutsideJob({ file: 'C:\\n.exe', outputFile: 'C:\\o', env, run: async () => 'Access denied' }), /no result/);
});

test('ensureDaemon starts through WMI on Windows unless told not to, and never elsewhere', async t => {
  const home = await mkdtemp(join(tmpdir(), 'fai-breakaway-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { FAI_DAEMON_PORT: '0', FAI_DAEMON_START_TIMEOUT_MS: '300' };
  const started = [];
  const spawnOutsideJob = async options => { started.push(options); return { pid: 1 }; };
  // The fake start never brings a daemon up, so each call ends unreachable; what matters is which start ran.
  await assert.rejects(ensureDaemon({ home, env, platform: 'win32', spawnOutsideJob,
    command: ['C:\\node.exe', 'C:\\daemon-main.js'] }), error => error.code === 'daemon_unreachable');
  assert.equal(started.length, 1);
  assert.deepEqual([started[0].file, started[0].args], ['C:\\node.exe', ['C:\\daemon-main.js']]);
  assert.equal(started[0].outputFile, join(homePaths({ home, env }).logDir, 'daemon-start.log'));
  const plain = ['port_in_use', 'daemon_unreachable'];
  await assert.rejects(ensureDaemon({ home, env, platform: 'win32', breakaway: false, spawnOutsideJob,
    command: [process.execPath, '-e', 'process.exit(3)'] }), error => plain.includes(error.code));
  await assert.rejects(ensureDaemon({ home, env, platform: 'linux', spawnOutsideJob,
    command: [process.execPath, '-e', 'process.exit(3)'] }), error => plain.includes(error.code));
  assert.equal(started.length, 1);
});

test('spawnOutsideJob without an output file starts the program as it is, window shown', async () => {
  let sent;
  await spawnOutsideJob({ file: 'C:\\Program Files\\Mozilla Firefox\\firefox.exe', args: ['--profile', 'C:\\p q', '--no-remote'],
    env: { SystemRoot: 'C:\\Windows' }, run: async (_ps, _script, input) => { sent = JSON.parse(input); return '{"code":0,"pid":7}'; } });
  assert.equal(sent.command, '"C:\\Program Files\\Mozilla Firefox\\firefox.exe" --profile "C:\\p q" --no-remote');
  assert.equal(sent.hidden, false);
});
