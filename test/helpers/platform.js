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

// Each channel unit lifts its own skip once its Windows implementation and fakes pass CI.
export const NO_CLAUDE_WAKES = WINDOWS ? 'Claude wake binding does not support Windows pipes yet' : false;
export const NO_CODEX_WAKES = WINDOWS ? 'Codex wakes and test binaries do not support Windows executables yet' : false;
export const NO_OPENCODE_WAKES = WINDOWS ? 'the OpenCode plugin does not support Windows pipes yet' : false;

/** A fake program the test writes as a POSIX shell script (`#!/bin/sh`), which Windows cannot run. */
export const SH_SHIMS = WINDOWS ? 'the test fakes a program with a #!/bin/sh script, which Windows cannot run' : false;

/** Code that stops a child by its POSIX process group (`process.kill(-pid)`), which Windows does not have. */
export const POSIX_GROUPS = WINDOWS
  ? 'stops its child by POSIX process group (process.kill(-pid)); Windows has none, so the child would run on'
  : false;
