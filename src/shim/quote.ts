export function shellQuotePosix(s: string): string {
  if (/^[A-Za-z0-9_./@:+=-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export function shellQuoteCmd(s: string): string {
  if (!/[\s"&|<>^]/.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

export function resolveThomasInvocation(): string {
  const exec = process.execPath;
  const script = process.argv[1];
  const quote = process.platform === "win32" ? shellQuoteCmd : shellQuotePosix;
  if (!script || script === exec) return quote(exec);
  return `${quote(exec)} ${quote(script)}`;
}
