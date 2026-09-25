import { readFileSync, statSync } from "node:fs";
import { isIP } from "node:net";
import { hostname, platform, release, version } from "node:os";

// What this computer calls itself, so Driggsby's MCP page can tell your
// connections apart ("On mbp-studio · macOS 15.6"). Read from the operating
// system's own files; no program is run. `login` sends it with its sign-in.
// Each value is allowlisted before it leaves the CLI, and a value outside
// the allowlist is left out, never cleaned into something else. Nothing
// here can fail a command: if the OS won't say, the value is unknown.
export interface Device {
  name: string | null;
  system: string | null;
}

// The facts describeDevice reads, injectable so tests never depend on the
// machine running them.
export interface OsFacts {
  hostname: string;
  platform: NodeJS.Platform;
  release: string;
  // os.version(): on Windows, the edition ("Windows Server 2022 Datacenter").
  version: string;
  readFile: (path: string) => string | null;
}

// These allowlists keep what leaves the CLI plain text: they never admit
// % ! ^ & | < > " \ : or a control character (device.test.ts checks each).
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;
const SYSTEM_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,63}$/;
const MAC_VERSION_FILE = "/System/Library/CoreServices/SystemVersion.plist";
// os-release(5): /etc first, then the vendor copy.
const LINUX_RELEASE_FILES = ["/etc/os-release", "/usr/lib/os-release"];
// Both files are a few hundred bytes; anything larger isn't one.
const MAX_FILE_BYTES = 64 * 1024;
// A PRETTY_NAME is a short line; a longer one is not parsed at all.
const MAX_PRETTY_NAME_CHARS = 256;
// Hostname labels that spell out an address ("ip-172-31-22-33",
// "c-73-162-12-34", "192-168-1-20") or are only digits name no computer.
const ADDRESS_LABEL = /^((ip|c)-)?\d{1,3}(-\d{1,3}){3}$|^\d+$/i;
// Windows 11 reports itself as NT 10.0; its builds start at 22000.
const WINDOWS_11_FIRST_BUILD = 22000;

export function describeDevice(facts?: OsFacts): Device {
  try {
    const known = facts ?? realOsFacts();
    return { name: deviceName(known.hostname), system: deviceSystem(known) };
  } catch {
    // os.hostname() and os.release() can throw in unusual runtimes.
    return { name: null, system: null };
  }
}

// The known values alone, as the sign-in request carries them; null when
// nothing is known.
export function knownDevice(device: Device): { name?: string; system?: string } | null {
  const known = {
    ...(device.name === null ? {} : { name: device.name }),
    ...(device.system === null ? {} : { system: device.system }),
  };
  return Object.keys(known).length === 0 ? null : known;
}

// "mbp-studio.local" and "devbox-02.corp.example.test" are mbp-studio and
// devbox-02: the first label is the name people give their computer. An
// address or localhost names no computer.
function deviceName(raw: string): string | null {
  const trimmed = raw.trim();
  if (isIP(trimmed) !== 0) {
    return null;
  }
  const first = trimmed.split(".")[0] ?? "";
  if (first.toLowerCase() === "localhost" || ADDRESS_LABEL.test(first)) {
    return null;
  }
  return NAME_PATTERN.test(first) ? first : null;
}

function deviceSystem(facts: OsFacts): string | null {
  switch (facts.platform) {
    case "darwin":
      return allowed(macVersion(facts)) ?? "macOS";
    case "linux":
      return allowed(linuxPrettyName(facts)) ?? "Linux";
    case "win32":
      return facts.version.includes("Server") ? "Windows Server" : windowsName(facts.release);
    default:
      return null;
  }
}

function macVersion(facts: OsFacts): string | null {
  const plist = facts.readFile(MAC_VERSION_FILE);
  const version = plist?.match(/<key>ProductVersion<\/key>\s*<string>([0-9.]+)<\/string>/)?.[1];
  return version === undefined ? null : `macOS ${version}`;
}

// PRETTY_NAME="Debian GNU/Linux 12 (bookworm)" is Debian GNU/Linux 12.
function linuxPrettyName(facts: OsFacts): string | null {
  for (const path of LINUX_RELEASE_FILES) {
    const osRelease = facts.readFile(path);
    if (osRelease === null) {
      continue;
    }
    const line = osRelease.split(/\r?\n/).find((each) => each.startsWith("PRETTY_NAME="));
    if (line === undefined || line.length > MAX_PRETTY_NAME_CHARS) {
      return null;
    }
    const value = line.slice("PRETTY_NAME=".length).trim().replace(/^["']|["']$/g, "");
    return value.replace(/\s*\([^)]*\)\s*$/, "").trim();
  }
  return null;
}

// Windows 10 and 11 both report NT 10.0; anything else is just Windows.
function windowsName(nodeRelease: string): string {
  const [major, , buildText] = nodeRelease.split(".");
  const build = Number(buildText);
  if (major !== "10" || !Number.isInteger(build)) {
    return "Windows";
  }
  return build >= WINDOWS_11_FIRST_BUILD ? "Windows 11" : "Windows 10";
}

function allowed(value: string | null): string | null {
  return value !== null && SYSTEM_PATTERN.test(value) ? value : null;
}

function realOsFacts(): OsFacts {
  return { hostname: hostname(), platform: platform(), release: release(), version: version(), readFile: readTextFile };
}

// A regular file of a sane size only: never a FIFO or device node that
// would block, never something huge.
function readTextFile(path: string): string | null {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
      return null;
    }
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
