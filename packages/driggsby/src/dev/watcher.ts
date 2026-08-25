// Change detection for the serve folder. `driggsby dev` tells the embedded
// app to reload when a served file changes. Polling a directory signature —
// names, sizes, mtimes — is deliberately boring: it behaves identically on
// macOS, Linux, and Windows (recursive fs.watch does not), and a scaffolded
// static app is a handful of files, so a walk every second is nothing.
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export const WATCH_POLL_MS = 1_000;

// One stable string describing the current served files; any edit, add,
// delete, or rename changes it. Skips what dev never serves (dotfiles,
// node_modules), so churn in an ignored folder can't cause reloads.
export async function directorySignature(serveDirectory: string): Promise<string> {
  const parts: string[] = [];
  await collectSignature(serveDirectory, "", parts);
  return parts.join("\n");
}

async function collectSignature(
  directory: string,
  prefix: string,
  parts: string[],
): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    parts.push(`${prefix}<unreadable>`);
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") {
      continue;
    }
    const entryPath = join(directory, entry.name);
    const entryKey = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      await collectSignature(entryPath, `${entryKey}/`, parts);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    try {
      const stats = await stat(entryPath);
      parts.push(`${entryKey}:${String(stats.size)}:${String(stats.mtimeMs)}`);
    } catch {
      parts.push(`${entryKey}:<gone>`);
    }
  }
}

// Polls until stopped; calls onChange once per observed signature change.
export function watchDirectory(
  serveDirectory: string,
  onChange: () => void,
  pollMs: number = WATCH_POLL_MS,
): () => void {
  let stopped = false;
  let lastSignature: string | null = null;
  let timer: NodeJS.Timeout | null = null;

  const poll = async (): Promise<void> => {
    const signature = await directorySignature(serveDirectory);
    if (stopped) {
      return;
    }
    if (lastSignature !== null && signature !== lastSignature) {
      onChange();
    }
    lastSignature = signature;
    timer = setTimeout(() => {
      void poll();
    }, pollMs);
    // Never keep the process alive just to poll.
    timer.unref();
  };
  void poll();

  return () => {
    stopped = true;
    if (timer !== null) {
      clearTimeout(timer);
    }
  };
}
