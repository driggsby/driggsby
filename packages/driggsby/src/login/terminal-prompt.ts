// The code prompt for driggsby login on a real terminal: null when stdin or
// stdout isn't one (an agent running the command). One close listener
// settles whichever question is open, and closing mid-question ends its
// line, so what prints next starts on a fresh one. Ctrl-C at the prompt
// ends the command, as it does everywhere else.
import { createInterface } from "node:readline";

import { type CodePrompt } from "./await-token.ts";

export function terminalCodePrompt(): CodePrompt | null {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return null;
  }
  const lines = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  let closed = false;
  let open: ((answer: string | null) => void) | null = null;
  lines.on("close", () => {
    closed = true;
    const settle = open;
    open = null;
    settle?.(null);
  });
  lines.on("SIGINT", () => {
    lines.close();
    process.kill(process.pid, "SIGINT");
  });
  return {
    ask: (question) => {
      if (closed) {
        return Promise.resolve(null);
      }
      return new Promise((resolve) => {
        open = resolve;
        lines.question(question, (answer) => {
          open = null;
          resolve(answer);
        });
      });
    },
    close: () => {
      if (closed) {
        return;
      }
      if (open !== null) {
        process.stdout.write("\n");
      }
      lines.close();
    },
  };
}
