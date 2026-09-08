// Terminal-output text helpers. The sanitizer and prose wrapper live in
// @driggsby/deploy (the zero-dependency package this CLI already depends
// on) and are re-exported here so every caller keeps one import path. See
// the sanitizer's comment there for what it strips and for the deliberate
// boundary of that defense: it stops terminal corruption and hidden text,
// and callers print untrusted values quoted and length-capped so they read
// as names, not as the CLI's own voice.
export { capForTerminal, quotedForTerminal, sanitizeForTerminal, wrapProse } from "@driggsby/deploy";

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

// Comma-separated names on indented lines that stay inside 80 columns.
export function wrapNames(names: string[], indent: string): string {
  const lines: string[] = [];
  let line = indent;
  for (const [index, name] of names.entries()) {
    const piece = index === names.length - 1 ? `${name}.` : `${name},`;
    if (line !== indent && line.length + 1 + piece.length > 80) {
      lines.push(line);
      line = indent;
    }
    line += line === indent ? piece : ` ${piece}`;
  }
  lines.push(line);
  return lines.join("\n");
}
