// File and folder names from the serve tree get echoed back in error
// messages, and terminals interpret control bytes (ANSI/OSC escapes,
// carriage returns, C1 controls), while bidi or zero-width characters can
// visually reorder or hide parts of a line. Strip them before interpolating
// any name this package did not author -- an agent-generated or cloned app
// folder is a realistic path for such bytes to reach a terminal. This file
// is the single home of these helpers: the driggsby CLI re-exports them
// (this package itself ships with zero dependencies).
//
// The deliberate boundary of this defense: stripping stops untrusted text
// from corrupting the terminal (escapes, control bytes) or hiding content
// (zero-width, bidi, default-ignorable code points). It does NOT try to
// stop a reader from trusting VISIBLE words inside a filename or server
// string -- no output transform can, because the text is displayed either
// way. Callers make provenance obvious instead: untrusted values print
// inside quotes with a hard length cap (quotedForTerminal), so they read as
// names, not as the CLI's own voice.
// The strip set covers C0/DEL/C1 controls, U+061C ARABIC LETTER MARK (the
// remaining Bidi_Control code point), zero-width joiners/marks, the
// deprecated bidi embeddings/overrides, and the bidi isolates.
// C0 whitespace (tab, newlines, carriage return) and the Unicode line and
// paragraph separators (U+2028/U+2029, which some renderers break on)
// become a space rather than vanishing: deleting a newline glues its
// neighboring words together ("tryagain"), while a space keeps the text
// readable and lets wrapProse re-flow it. The strip set also drops the
// soft hyphen, the Mongolian vowel separator, the interlinear annotation
// controls (U+FFF9-U+FFFB), the word joiner and invisible operators
// (U+2060-U+2069, which also covers the bidi isolates), and U+FEFF
// (ZWNBSP/BOM). The final pass strips Unicode's ENTIRE default-ignorable
// set -- the Tags block, variation selectors, Mongolian selectors, musical
// format controls, Hangul fillers, and friends -- because enumerated
// blocks kept leaving smuggling channels for invisible instructions into
// an agent's transcript; the property escape closes the whole class at
// once. (This also strips U+FE0F, so emoji lose their explicit
// presentation selector -- an acceptable cost.) Invisible or
// renderer-dependent code points have no place in CLI output.
export function sanitizeForTerminal(value: string): string {
  return (
    value
      .replace(/[\t\n\v\f\r\u2028\u2029]/g, " ")
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF\uFFF9-\uFFFB]/g, "")
      .replace(/\p{Default_Ignorable_Code_Point}/gu, "")
  );
}

// Sanitize plus a hard length bound, dropping an orphaned trailing high
// surrogate so the cut never emits a lone half of a surrogate pair. For any
// untrusted string headed to a terminal whose legitimate length is known.
export function capForTerminal(value: string, maxChars: number): string {
  return sanitizeForTerminal(value).slice(0, maxChars).replace(/[\uD800-\uDBFF]$/, "");
}

// capForTerminal with the provenance quotes built in. The quotes are what
// mark a value as untrusted, so the helper owns them: a double quote inside
// the value (or one produced by capping) would close the quotation early and
// let the rest of the payload read as the CLI's own sentence. Double quotes
// become single quotes — lossless enough for a name — so the rendered value
// always carries exactly one balanced pair. Every untrusted value printed
// inside quotes goes through here, never through hand-placed quote marks.
export function quotedForTerminal(value: string, maxChars: number): string {
  return `"${capForTerminal(value, maxChars).replaceAll('"', "'")}"`;
}

// Hard-wraps one paragraph of prose at the given width so lines built from
// dynamic parts (server-supplied error descriptions) never overflow an
// 80-column terminal. A single word longer than the width is hard-split at
// the width -- a space-free server string must not become one overflowing
// line. The input must be a single paragraph with no embedded newlines --
// only U+0020 spaces are treated as break points.
export function wrapProse(text: string, width = 76): string {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ").flatMap((long) => splitLongWord(long, width))) {
    if (line === "") {
      line = word;
    } else if (line.length + 1 + word.length <= width) {
      line = `${line} ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== "") {
    lines.push(line);
  }
  return lines.join("\n");
}

function splitLongWord(word: string, width: number): string[] {
  if (word.length <= width) {
    return [word];
  }
  // Split by code point, not code unit: a surrogate pair (an emoji in a
  // server error description) straddling the boundary must never be cut
  // into two lone surrogates.
  const pieces: string[] = [];
  let piece = "";
  for (const codePoint of word) {
    if (piece.length + codePoint.length > width) {
      pieces.push(piece);
      piece = "";
    }
    piece += codePoint;
  }
  if (piece !== "") {
    pieces.push(piece);
  }
  return pieces;
}
