import { spawn } from "node:child_process";

import { type ClientCommandOutput } from "./classify.ts";
import { type McpConfigCommand } from "./commands.ts";
import { planSpawn } from "./spawn-plan.ts";

const CLIENT_CONFIG_COMMAND_TIMEOUT_MS = 30_000;
// After the child exits, wait at most this long for its output pipes to
// close: a backgrounded grandchild that inherited the pipes must not be able
// to hang the CLI.
const OUTPUT_DRAIN_GRACE_MS = 250;
const LOOPBACK_REDIRECT_NEEDLE = "redirect_uri=http%3A%2F%2F127.0.0.1%3A";
const BROWSER_LAUNCH_FAILED_NEEDLE = "Browser launch failed";
const REMOTE_SIGN_IN_HINT_RECENT_CHARS = 512;

export const REMOTE_SIGN_IN_HINT = `
Remote sign-in note:
  The URL above redirects to 127.0.0.1 on this machine.
  If you opened this terminal over SSH, use SSH local port forwarding before
  opening the URL in your local browser.

If sign-in times out, run:
  codex mcp login driggsby
`;

export type ClientCommandResult =
  | { kind: "output"; output: ClientCommandOutput }
  | { kind: "not-found" }
  | { kind: "spawn-error" }
  | { kind: "timed-out" };

// Watches streamed Codex output for the signature of a headless/SSH session
// (loopback OAuth redirect plus a failed browser launch) and fires exactly
// once, over a rolling window so the needles can span chunk boundaries.
export class RemoteSignInHintState {
  #recentOutput = "";
  #sawLoopbackRedirect = false;
  #sawBrowserLaunchFailed = false;
  #printed = false;

  observe(text: string): boolean {
    this.#recentOutput += text;
    if (this.#recentOutput.includes(LOOPBACK_REDIRECT_NEEDLE)) {
      this.#sawLoopbackRedirect = true;
    }
    if (this.#recentOutput.includes(BROWSER_LAUNCH_FAILED_NEEDLE)) {
      this.#sawBrowserLaunchFailed = true;
    }
    if (this.#recentOutput.length > REMOTE_SIGN_IN_HINT_RECENT_CHARS) {
      this.#recentOutput = this.#recentOutput.slice(-REMOTE_SIGN_IN_HINT_RECENT_CHARS);
    }
    if (this.#printed || !this.#sawLoopbackRedirect || !this.#sawBrowserLaunchFailed) {
      return false;
    }
    this.#printed = true;
    return true;
  }
}

// Runs a client CLI command (claude/codex) with a hard timeout. When
// `streamOutput` is set (Codex, whose OAuth happens in-band) the child's
// output is echoed live to our own stdout/stderr while still being captured.
export function runClientCommand(
  command: McpConfigCommand,
  streamOutput: boolean,
  timeoutMs: number = CLIENT_CONFIG_COMMAND_TIMEOUT_MS,
): Promise<ClientCommandResult> {
  return new Promise((resolve) => {
    // No shell anywhere: spawn-plan.ts resolves Windows .cmd shims through an
    // explicit cmd.exe invocation and reports a missing program itself
    // (PATH-only lookup — the current directory is never searched).
    const plan = planSpawn(command);
    if (plan === null) {
      resolve({ kind: "not-found" });
      return;
    }
    const child = spawn(plan.program, plan.args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsVerbatimArguments: plan.windowsVerbatimArguments,
    });

    let settled = false;
    const settle = (result: ClientCommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Tear down our ends of the pipes and drop the child from the event
      // loop: a backgrounded grandchild that inherited the pipes must not be
      // able to keep this process alive after the result is decided.
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      resolve(result);
    };

    const hint = streamOutput ? new RemoteSignInHintState() : null;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const stdoutDone = collectStream(child.stdout, stdoutChunks, streamOutput ? "stdout" : null, hint);
    const stderrDone = collectStream(child.stderr, stderrChunks, streamOutput ? "stderr" : null, hint);

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle({ kind: "timed-out" });
    }, timeoutMs);
    timer.unref();

    child.once("error", (error: NodeJS.ErrnoException) => {
      settle(error.code === "ENOENT" ? { kind: "not-found" } : { kind: "spawn-error" });
    });

    child.once("exit", (code) => {
      void (async () => {
        // Race the pipes closing against the drain grace, and cancel the
        // grace timer as soon as the race settles so it can't hold the
        // process (or add dead wait) after a fast, clean exit.
        let drainTimer: NodeJS.Timeout | undefined;
        const drainGrace = new Promise<void>((resolveGrace) => {
          drainTimer = setTimeout(resolveGrace, OUTPUT_DRAIN_GRACE_MS);
        });
        await Promise.race([Promise.all([stdoutDone, stderrDone]), drainGrace]);
        clearTimeout(drainTimer);
        const stdout = Buffer.concat(stdoutChunks).toString("utf8");
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        settle({ kind: "output", output: { succeeded: code === 0, stdout, stderr } });
      })();
    });
  });
}

function collectStream(
  stream: NodeJS.ReadableStream | null,
  chunks: Buffer[],
  echoTo: "stdout" | "stderr" | null,
  hint: RemoteSignInHintState | null,
): Promise<void> {
  if (stream === null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    stream.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      if (echoTo !== null) {
        (echoTo === "stdout" ? process.stdout : process.stderr).write(chunk);
      }
      if (hint?.observe(chunk.toString("utf8")) === true) {
        process.stdout.write(REMOTE_SIGN_IN_HINT);
      }
    });
    stream.once("close", () => {
      resolve();
    });
    // A torn-down pipe (e.g. the SIGKILL timeout path on Windows) must end
    // the collection quietly, never surface as an uncaught stream error.
    stream.on("error", () => {
      resolve();
    });
  });
}
