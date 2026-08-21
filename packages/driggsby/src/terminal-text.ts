// User-supplied argv gets echoed back in error messages. Terminals interpret
// control bytes (ANSI/OSC escapes, carriage returns, C1 controls), and bidi
// or zero-width characters can visually reorder or hide parts of a line, so
// strip them before interpolation -- this CLI is agent-facing, and an agent
// pasting untrusted text into an argument is a realistic path for such bytes
// to reach a terminal. (Deliberate hardening drift from the Rust CLI, which
// echoed argv raw.)
export function sanitizeForTerminal(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, "");
}

// Rust's str::trim() trims the Unicode White_Space set, which differs from
// JavaScript's String.prototype.trim at exactly two code points: Rust trims
// U+0085 (NEL) and does NOT trim U+FEFF (ZWNBSP/BOM); JS does the opposite.
// Client-id parsing must match the retired Rust binary byte-for-byte, so
// trim against Rust's set explicitly.
const RUST_WHITESPACE_CLASS =
  "[\\t\\n\\v\\f\\r \\u0085\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000]";
const LEADING_RUST_WHITESPACE = new RegExp(`^${RUST_WHITESPACE_CLASS}+`);
const TRAILING_RUST_WHITESPACE = new RegExp(`${RUST_WHITESPACE_CLASS}+$`);

export function trimLikeRust(value: string): string {
  return value.replace(LEADING_RUST_WHITESPACE, "").replace(TRAILING_RUST_WHITESPACE, "");
}
