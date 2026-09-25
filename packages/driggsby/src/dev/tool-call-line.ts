// The terminal line `driggsby dev` prints for each tool call the preview
// makes, after any retries: a check and the time it took, or a cross and
// the reason. A developer (or their agent) sees a failing watch in the
// terminal, not only in the page. The tool name passed the app allowlist
// before the call ran, and the broker has already sanitized the message;
// here it's capped shorter and wrapped, its continuation lines indented
// deeper than the CLI's own command suggestions, so server text can't pass
// for one.
import { capForTerminal, wrapProse } from "../terminal-text.ts";
import type { BrokerResult } from "./dev-servers.ts";

const MAX_LINE_MESSAGE_CHARS = 240;

export function toolCallLine(tool: string, result: BrokerResult, elapsedMs: number): string {
  if (result.ok) {
    return `✓ ${tool} ${(elapsedMs / 1000).toFixed(2)}s\n`;
  }
  const wrapped = wrapProse(`✗ ${tool}: ${capForTerminal(result.error.message, MAX_LINE_MESSAGE_CHARS)}`, 72);
  return `${wrapped.split("\n").join("\n    ")}\n`;
}
