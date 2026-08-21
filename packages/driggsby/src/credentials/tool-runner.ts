// Runs a platform credential tool (macOS `security`, Linux `secret-tool`)
// with a hard timeout, optional stdin, and captured output. POSIX-only by
// construction: Windows uses the file store and never reaches this module,
// so there is no .cmd shim handling here. Programs are fixed constants named
// by the calling backend; nothing user-controlled selects the program.
import { spawn } from "node:child_process";

const CREDENTIAL_TOOL_TIMEOUT_MS = 15_000;

export type ToolRunResult =
  | { kind: "output"; exitCode: number; stdout: string; stderr: string }
  | { kind: "not-found" }
  | { kind: "spawn-error" }
  | { kind: "timed-out" };

export interface ToolRunOptions {
  // Written to the child's stdin, then stdin is closed. The token flows to
  // secret-tool this way so it never appears on a process argument list.
  stdinText?: string | undefined;
  // Spawn environment override, used by tests to point PATH at a fake tool.
  spawnEnv?: NodeJS.ProcessEnv | undefined;
  timeoutMs?: number | undefined;
}

export function runCredentialTool(
  program: string,
  args: readonly string[],
  options: ToolRunOptions = {},
): Promise<ToolRunResult> {
  return new Promise((resolve) => {
    const child = spawn(program, [...args], {
      stdio: [options.stdinText === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      env: options.spawnEnv ?? process.env,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (result: ToolRunResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill();
      // A tool that ignores SIGTERM must not linger with the token; the
      // follow-up SIGKILL is unref'd so it never holds the process open.
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
      settle({ kind: "timed-out" });
    }, options.timeoutMs ?? CREDENTIAL_TOOL_TIMEOUT_MS);

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      settle(error.code === "ENOENT" ? { kind: "not-found" } : { kind: "spawn-error" });
    });
    child.on("close", (code) => {
      settle({ kind: "output", exitCode: code ?? 1, stdout, stderr });
    });

    if (options.stdinText !== undefined && child.stdin !== null) {
      // A tool that exits without reading stdin can EPIPE the write; that is
      // its own failure signal, never a crash of ours.
      child.stdin.on("error", () => {
        // Swallowed deliberately; the tool's exit code is the signal.
      });
      child.stdin.end(options.stdinText);
    }
  });
}
