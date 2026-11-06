// Colored terminal text for the replay: a line is a list of segments, each
// with an optional 24-bit color, background, bold or strikethrough. Every
// character the replay draws is one column wide, so a line's width is its
// characters' count; render pads or cuts a line to an exact width and resets
// its color at the end.

export interface SegStyle {
  bg?: string;
  bold?: boolean;
  strike?: boolean;
}

export interface Seg {
  text: string;
  fg: string | null;
  style: SegStyle;
}

export interface Line {
  segs: Seg[];
  render: (cols: number) => string;
}

const RESET = "\u001b[0m";

// Off when NO_COLOR is set (https://no-color.org) or for tests that ask.
let colorOn = (process.env.NO_COLOR ?? "") === "";
export function setColor(on: boolean): void {
  colorOn = on;
}

export function seg(text: string, fg: string | null = null, style: SegStyle = {}): Seg {
  return { text, fg, style };
}

export function width(segs: readonly Seg[]): number {
  return segs.reduce((sum, s) => sum + Array.from(s.text).length, 0);
}

export function padTo(text: string, size: number): string {
  const chars = Array.from(text);
  return chars.length >= size ? chars.slice(0, Math.max(0, size)).join("") : text + " ".repeat(size - chars.length);
}

function rgb(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}`;
}

function sgr(s: Seg): string {
  const codes: string[] = [];
  if (s.style.bold === true) codes.push("1");
  if (s.style.strike === true) codes.push("9");
  if (s.fg !== null) codes.push(`38;2;${rgb(s.fg)}`);
  if (s.style.bg !== undefined) codes.push(`48;2;${rgb(s.style.bg)}`);
  return codes.length === 0 ? "" : `\u001b[${codes.join(";")}m`;
}

export function line(...segs: Seg[]): Line {
  return {
    segs,
    render: (cols: number): string => {
      let left = cols;
      let out = "";
      for (const s of segs) {
        if (left <= 0) break;
        const chars = Array.from(s.text);
        const text = chars.slice(0, left).join("");
        left -= Math.min(chars.length, left);
        out += colorOn ? `${sgr(s)}${text}${RESET}` : text;
      }
      return out + " ".repeat(left);
    },
  };
}
