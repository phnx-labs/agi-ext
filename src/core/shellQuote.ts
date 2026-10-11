/**
 * Single-quote a value for interpolation into a POSIX shell command. The one
 * shell quoter in the extension: always quotes, so the emitted command never
 * depends on which characters a value happens to contain.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
