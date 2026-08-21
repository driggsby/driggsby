// Turns an McpConfigCommand into something Node's spawn can run on every
// platform WITHOUT a shell. On POSIX the command runs as-is. On Windows,
// client CLIs are usually npm-installed .cmd shims, which Node (rightly)
// refuses to spawn directly — so we resolve the program ourselves against
// PATH + PATHEXT (never the current directory, which Windows shells would
// search first) and run shims through an explicit cmd.exe invocation with
// our own quoting. Real commands only ever carry fixed constant arguments
// (see commands.ts); the quoting below still handles arbitrary strings so
// tests and future callers are safe too.
import { existsSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

import { type McpConfigCommand } from "./commands.ts";

export interface SpawnPlan {
  program: string;
  args: string[];
  windowsVerbatimArguments: boolean;
}

// null means the program does not exist on PATH (Windows only — POSIX lets
// spawn report ENOENT itself).
export function planSpawn(command: McpConfigCommand): SpawnPlan | null {
  if (process.platform !== "win32") {
    return { program: command.program, args: command.args, windowsVerbatimArguments: false };
  }

  const resolved = resolveWindowsProgram(command.program);
  if (resolved === null) {
    return null;
  }
  if (resolved.kind === "direct") {
    return { program: resolved.path, args: command.args, windowsVerbatimArguments: false };
  }
  const commandLine = [resolved.path, ...command.args].map(quoteForCmd).join(" ");
  return {
    program: "cmd.exe",
    args: ["/d", "/s", "/c", `"${commandLine}"`],
    windowsVerbatimArguments: true,
  };
}

interface ResolvedProgram {
  kind: "direct" | "shim";
  path: string;
}

function kindForPath(candidate: string): "direct" | "shim" {
  return /\.(cmd|bat)$/i.test(candidate) ? "shim" : "direct";
}

function resolveWindowsProgram(program: string): ResolvedProgram | null {
  // An explicit path (absolute, or containing a separator) is used as given.
  if (isAbsolute(program) || program.includes("\\") || program.includes("/")) {
    return existsSync(program) ? { kind: kindForPath(program), path: program } : null;
  }

  const pathDirectories = (process.env.PATH ?? "").split(delimiter).filter((dir) => dir !== "");
  const extensions = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter((ext) => ext !== "");
  const hasExtension = /\.[^\\/.]+$/.test(program);

  for (const directory of pathDirectories) {
    if (hasExtension) {
      const exact = join(directory, program);
      if (existsSync(exact)) {
        return { kind: kindForPath(exact), path: exact };
      }
    }
    for (const extension of extensions) {
      const candidate = join(directory, program + extension);
      if (existsSync(candidate)) {
        return { kind: kindForPath(candidate), path: candidate };
      }
    }
  }
  return null;
}

// Quoting for the cmd.exe /s /c command line: plain tokens pass through,
// anything else is wrapped in double quotes with embedded quotes doubled
// (the cmd convention). The characters in the safe set cover every constant
// argument the CLI actually runs, including the MCP URL.
function quoteForCmd(value: string): string {
  if (/^[A-Za-z0-9_\-.:\\/=]+$/.test(value)) {
    return value;
  }
  return `"${value.replaceAll('"', '""')}"`;
}
