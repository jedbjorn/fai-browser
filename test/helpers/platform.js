// Skip reasons for tests that cannot run on Windows, stated once. A test that can run there is fixed instead (CI runs
// the browserless suite on windows-latest and macos-latest).
export const WINDOWS = process.platform === 'win32';

/**
 * A test that plans for Linux or macOS from POSIX path strings ('/home/u/.config', '/usr/lib/firefox'): src/ joins
 * them with node:path, which writes backslashes on Windows, where that plan is never made for real.
 */
export const POSIX_PATHS = WINDOWS
  ? 'plans for Linux or macOS from POSIX path strings; node:path writes backslashes on Windows, where that plan is never made'
  : false;

/**
 * Wakes reach the agent's host through a Unix domain socket (Claude Code's messaging socket, FAI's OpenCode plugin) or
 * a codex shim the test writes as a POSIX shell script. FAI does not wake a host on Windows yet: the MCP server there
 * keeps the wait command and the copy line, which the tests of the non-wake paths cover.
 */
export const NO_WAKES = WINDOWS
  ? 'wakes use Unix domain sockets and POSIX shell shims; FAI does not wake a host on Windows yet'
  : false;

/** A fake program the test writes as a POSIX shell script (`#!/bin/sh`), which Windows cannot run. */
export const SH_SHIMS = WINDOWS ? 'the test fakes a program with a #!/bin/sh script, which Windows cannot run' : false;
