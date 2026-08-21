// User-supplied argv gets echoed back in error messages. Terminals interpret
// control bytes (ANSI/OSC escapes, carriage returns, C1 controls), so strip
// them before interpolation -- this CLI is agent-facing, and an agent pasting
// untrusted text into an argument is a realistic path for escape bytes to
// reach a terminal. (Deliberate hardening drift from the Rust CLI, which
// echoed argv raw.)
export function sanitizeForTerminal(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001F\u007F-\u009F]/g, "");
}
