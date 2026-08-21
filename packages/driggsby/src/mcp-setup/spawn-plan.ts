// Turns an McpConfigCommand into something Node's spawn can run on every
// platform WITHOUT a shell. On POSIX the command runs as-is. On Windows,
// client CLIs are usually npm-installed .cmd shims, which Node (rightly)
// refuses to spawn directly — so we resolve the program ourselves against
// PATH + PATHEXT (never the current directory, which Windows shells would
// search first) and run shims through an explicit, absolute cmd.exe
// invocation with our own quoting. Real commands only ever carry fixed
// constant arguments (see commands.ts); nothing user-controlled may ever
// flow into a spawn plan.
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { type McpConfigCommand } from "./commands.ts";

export interface SpawnPlan {
  program: string;
  args: string[];
  windowsVerbatimArguments: boolean;
}

// null means the program does not exist on PATH (Windows only — POSIX lets
// spawn report ENOENT itself). platform and lookup are injectable so the
// Windows branch — including the absolute cmd.exe composition — stays
// unit-testable on every CI runner.
export function planSpawn(
  command: McpConfigCommand,
  platform: NodeJS.Platform = process.platform,
  lookup?: WindowsLookup,
): SpawnPlan | null {
  if (platform !== "win32") {
    return { program: command.program, args: command.args, windowsVerbatimArguments: false };
  }

  const resolved = resolveWindowsProgram(command.program, lookup ?? defaultLookup());
  if (resolved === null) {
    return null;
  }
  if (resolved.kind === "direct") {
    return { program: resolved.path, args: command.args, windowsVerbatimArguments: false };
  }
  const commandLine = [resolved.path, ...command.args].map(quoteForCmd).join(" ");
  return {
    // Absolute path: a bare "cmd.exe" would let Windows' legacy CreateProcess
    // lookup find a planted cmd.exe in the current directory first.
    program: join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe"),
    args: ["/d", "/s", "/c", `"${commandLine}"`],
    windowsVerbatimArguments: true,
  };
}

interface ResolvedProgram {
  kind: "direct" | "shim";
  path: string;
}

// The filesystem/environment surface resolveWindowsProgram reads, injectable
// so the pure resolution logic is unit-testable on every platform.
export interface WindowsLookup {
  path: string;
  pathext: string;
  exists: (candidate: string) => boolean;
}

function defaultLookup(): WindowsLookup {
  return {
    path: process.env.PATH ?? "",
    pathext: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
    exists: existsSync,
  };
}

function kindForPath(candidate: string): "direct" | "shim" {
  return /\.(cmd|bat)$/i.test(candidate) ? "shim" : "direct";
}

export function resolveWindowsProgram(
  program: string,
  lookup: WindowsLookup = defaultLookup(),
): ResolvedProgram | null {
  // An explicit path (absolute, or containing a separator) is used as given.
  if (isAbsolute(program) || program.includes("\\") || program.includes("/")) {
    return lookup.exists(program) ? { kind: kindForPath(program), path: program } : null;
  }

  // Windows PATH semantics regardless of the host running the tests: split
  // on ";" (a POSIX-style ":" would cut drive letters like C: in half).
  const pathDirectories = lookup.path
    .split(";")
    // Real Windows PATHs sometimes carry quoted segments; strip the quotes so
    // the directory still resolves.
    .map((directory) => directory.replaceAll('"', ""))
    .filter((directory) => directory !== "");
  const extensions = lookup.pathext.split(";").filter((extension) => extension !== "");
  const hasExtension = /\.[^\\/.]+$/.test(program);

  for (const directory of pathDirectories) {
    if (hasExtension) {
      const exact = join(directory, program);
      if (lookup.exists(exact)) {
        return { kind: kindForPath(exact), path: exact };
      }
    }
    for (const extension of extensions) {
      const candidate = join(directory, program + extension);
      if (lookup.exists(candidate)) {
        return { kind: kindForPath(candidate), path: candidate };
      }
    }
  }
  return null;
}

// Quoting for the cmd.exe /s /c command line: plain tokens pass through,
// anything else is wrapped in double quotes with embedded quotes doubled
// (the cmd convention) and trailing backslashes doubled (so a path ending
// in \ cannot escape the closing quote for the child's own parser). The
// safe set covers every constant argument the CLI actually runs, including
// the MCP URL; only fixed constants and PATH-resolved program paths may
// reach this function.
export function quoteForCmd(value: string): string {
  if (/^[A-Za-z0-9_\-.:\\/=]+$/.test(value)) {
    return value;
  }
  const escaped = value.replaceAll('"', '""').replace(/(\\+)$/, "$1$1");
  return `"${escaped}"`;
}
