// Windows command lines: quoting for CommandLineToArgvW (src/breakaway.js builds the command line WMI starts).

/** One argument quoted for a Windows command line (the CommandLineToArgvW rules). */
export function quoteWindowsArg(value) {
  const text = String(value);
  if (text && !/[\s"]/.test(text)) return text;
  return `"${text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

