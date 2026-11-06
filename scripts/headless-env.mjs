// Environment for every headless Chromium that the tests, scripts and benches launch: the caller's environment without
// the desktop session variables. `--headless` alone does not keep Chromium off the desktop: the browser process
// inherits WAYLAND_DISPLAY and still opens a connection to that compositor (observed with Chromium 153 on KDE Plasma 6),
// and with DBUS_SESSION_BUS_ADDRESS it connects to the session bus. Unsetting the bus address is enough: an empty value
// still falls back to $XDG_RUNTIME_DIR/bus, an unset one does not (checked with Chromium 153). Without these variables
// a test browser has no way to reach the user's session: no windows, no clipboard, no primary selection, no bus.
// test/headless-guard.test.js checks that every launch passes this and that the browser holds none of these
// connections. Headed runs (scripts/bench.mjs --headed, npm run manual-smoke) keep the full environment.
export const SESSION_VARIABLES = Object.freeze(['DISPLAY', 'WAYLAND_DISPLAY', 'WAYLAND_SOCKET', 'DBUS_SESSION_BUS_ADDRESS']);

export function headlessEnv(env = process.env) {
  const copy = { ...env };
  for (const name of SESSION_VARIABLES) delete copy[name];
  return copy;
}

// A stdio server command (MCP host config) that starts `command` without the session variables. A host merges a
// config's `env` into its own environment, so an `env` entry cannot unset a variable, and copying headlessEnv() into
// the config would write the whole environment into config files and logs; `env -u` unsets them in the child only.
export function headlessCommand(command, args = []) {
  return { command: 'env', args: [...SESSION_VARIABLES.flatMap(name => ['-u', name]), command, ...args] };
}
