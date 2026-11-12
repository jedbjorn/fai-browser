// Windows command lines: quoting for CommandLineToArgvW, and running a .cmd or .bat (an npm shim such as claude.cmd),
// which Node refuses to execFile without a shell (EINVAL since the 2024 BatBadBut fix).

/** One argument quoted for a Windows command line (the CommandLineToArgvW rules). */
export function quoteWindowsArg(value) {
  const text = String(value);
  if (text && !/[\s"]/.test(text)) return text;
  return `"${text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

/**
 * `{ file, args, options }` for execFile. A .cmd or .bat on Windows runs as `cmd.exe /d /s /c "<line>"` with verbatim
 * arguments; anything else is returned as it is. cmd reads `& | < > ^ % !` even inside quotes once a batch file passes
 * `%*` on, so a line holding one of them is refused rather than escaped.
 */
export function shellSafeInvocation(file, args = [], { platform = process.platform, env = process.env } = {}) {
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(String(file))) return { file, args, options: {} };
  const line = [file, ...args].map(quoteWindowsArg).join(' ');
  if (/[&|<>^%!\r\n]/.test(line)) {
    throw new Error(`Cannot run ${file} safely: an argument holds one of & | < > ^ % ! or a line break`);
  }
  const comspec = env.ComSpec || env.COMSPEC || 'cmd.exe';
  return { file: comspec, args: ['/d', '/s', '/c', `"${line}"`], options: { windowsVerbatimArguments: true } };
}
