// Best-effort browser opening for the consent URL. Failure is always fine —
// the caller prints the URL either way — so nothing here throws to the user.
// Only https URLs (plus http on loopback, for the local-server dev override)
// are ever handed to a platform opener, and the URL is the sole,
// pre-validated argument: no shell interprets it on POSIX, and the Windows
// cmd.exe path quotes it with the same rules as the MCP setup spawns.
import { spawn } from "node:child_process";
import { win32 } from "node:path";

import { quoteForCmd } from "../mcp-setup/spawn-plan.ts";

export interface OpenUrlSpawnPlan {
  program: string;
  args: string[];
  windowsVerbatimArguments: boolean;
}

export function openUrlSpawnPlan(
  url: string,
  platform: NodeJS.Platform = process.platform,
  systemRoot: string = process.env.SystemRoot ?? "C:\\Windows",
): OpenUrlSpawnPlan | null {
  if (!isOpenableUrl(url)) {
    return null;
  }
  if (platform === "darwin") {
    // Absolute path, like /usr/bin/security in the keychain backend: `open`
    // is a fixed system binary and must not be resolvable off a hijacked
    // PATH. xdg-open below stays PATH-resolved — its location legitimately
    // varies across Linux distributions.
    return { program: "/usr/bin/open", args: [url], windowsVerbatimArguments: false };
  }
  if (platform === "win32") {
    // `start` is a cmd.exe builtin; its first quoted argument is the window
    // title, so an empty "" keeps the URL from being eaten as the title.
    const commandLine = ["start", '""', quoteForCmd(url)].join(" ");
    return {
      program: win32.join(systemRoot, "System32", "cmd.exe"),
      args: ["/d", "/s", "/c", `"${commandLine}"`],
      windowsVerbatimArguments: true,
    };
  }
  return { program: "xdg-open", args: [url], windowsVerbatimArguments: false };
}

// The plain RFC 3986 character set, with `%` and `!` deliberately excluded:
// cmd.exe expands %VAR% even inside quoted arguments, and expands !VAR! the
// same way on machines with delayed expansion enabled, so a URL carrying
// either could pull environment values into the URL the Windows opener
// launches. Claim URLs never contain them; a URL that does is simply not
// opened (the caller prints the link instead), on every platform for
// consistency.
const OPENABLE_URL_CHARACTERS = /^[A-Za-z0-9\-._~:/?#[\]@$&'()*+,;=]*$/;

function isOpenableUrl(url: string): boolean {
  if (!OPENABLE_URL_CHARACTERS.test(url)) {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:") {
    return true;
  }
  return (
    parsed.protocol === "http:" &&
    (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")
  );
}

// Resolves true once the opener process starts; the page itself may still
// fail to open, which is why callers always print the URL too.
export function tryOpenUrl(
  url: string,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  const plan = openUrlSpawnPlan(url, platform);
  if (plan === null) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const child = spawn(plan.program, plan.args, {
      stdio: "ignore",
      detached: platform !== "win32",
      windowsVerbatimArguments: plan.windowsVerbatimArguments,
    });
    child.on("error", () => {
      resolve(false);
    });
    child.on("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
}
