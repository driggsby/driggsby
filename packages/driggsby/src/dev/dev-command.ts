// driggsby dev: preview the app in this folder with the developer's real
// Driggsby data, in the exact topology it will live in after deploy — the
// app on its own local origin, embedded by a local host page, talking
// through the frozen postMessage protocol. The app token stays in this
// process; the pages carry no credentials.
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import { readProjectConfig } from "@driggsby/deploy";

import { apiBaseUrl, apiHost } from "../api/base-url.ts";
import { blockedNetworkError } from "../api/network-error.ts";
import { CliError } from "../cli-error.ts";
import {
  type CredentialEnvironment,
  defaultCredentialEnvironment,
} from "../credentials/store.ts";
import { requireDeploySession } from "../deploy/api-session.ts";
import { tryOpenUrl } from "../login/open-url.ts";
import { wrapProse } from "../terminal-text.ts";
import { DEV_IDLE_MINUTES, DEV_START_COMMAND, DEV_STOP_COMMAND } from "./dev-commands.ts";
import { startDevServers, type DevServers } from "./dev-servers.ts";
import { pruneDevStatesForPorts, readDevStates, removeDevState, writeDevState } from "./dev-state.ts";
import { McpBroker } from "./mcp-broker.ts";
import { watchDirectory } from "./watcher.ts";

export const DEV_HOST_PORT = 4111;
export const DEV_APP_PORT = 4112;
// Previews for other folders can already hold the default pair (a person
// often runs several agents at once), so dev moves up two ports at a time,
// 4111/4112, then 4113/4114, and so on, through this many pairs.
export const DEV_PORT_PAIRS = 10;
const DEV_IDLE_TIMEOUT_MS = DEV_IDLE_MINUTES * 60 * 1000;
const DEV_IDLE_CHECK_MS = 15 * 1000;

export interface DevCommandIo {
  out: (text: string) => void;
  openUrl: (url: string) => Promise<boolean>;
  // Resolves when the run should end (the person pressed Ctrl+C).
  waitForShutdown: () => Promise<void>;
}

export interface DevCommandOptions {
  projectDirectory?: string;
  // Tests bind ephemeral ports; the real command starts at the default pair.
  hostPort?: number;
  appPort?: number;
  // Tests shorten the idle window; the real command uses the 30-minute one.
  idleTimeoutMs?: number;
  idleCheckMs?: number;
  // Tests try fewer port pairs; the real command tries DEV_PORT_PAIRS.
  portPairs?: number;
}

function defaultDevIo(): DevCommandIo {
  return {
    out: (text) => {
      process.stdout.write(text);
    },
    openUrl: tryOpenUrl,
    waitForShutdown: async () => {
      await new Promise<void>((resolve) => {
        process.once("SIGINT", () => {
          resolve();
        });
        process.once("SIGTERM", () => {
          resolve();
        });
        // A closed terminal window: still a clean stop, so the record and
        // the ports are released like any other exit. (On Windows, a signal
        // from `dev --stop` ends the process outright instead; `dev --stop`
        // then removes the record itself once the pid is gone.)
        process.once("SIGHUP", () => {
          resolve();
        });
      });
    },
  };
}

export async function runDev(
  options: DevCommandOptions = {},
  environment: CredentialEnvironment = defaultCredentialEnvironment(),
  io: DevCommandIo = defaultDevIo(),
): Promise<number> {
  const projectDirectory = options.projectDirectory ?? process.cwd();
  const baseUrl = apiBaseUrl(environment.env);

  const config = await readProjectConfig(projectDirectory);
  if (config.devCommand !== null) {
    throw new CliError(
      `${wrapProse('This driggsby.json sets "dev_command", which driggsby dev doesn\'t support yet. Remove it to preview the folder\'s files directly, or run your own dev server and deploy with:')}\n` +
        "  npx driggsby@latest deploy",
      1,
    );
  }
  const session = await requireDeploySession(environment);
  await refuseSecondPreview(environment.homeDirectory, projectDirectory);
  const sdkBundle = await loadSdkBundle();
  const broker = new McpBroker({ baseUrl: session.baseUrl, token: session.token });

  const hostPort = options.hostPort ?? DEV_HOST_PORT;
  const appPort = options.appPort ?? DEV_APP_PORT;
  const pairs = options.portPairs ?? DEV_PORT_PAIRS;
  // Ephemeral ports (0, in tests) are never in use, so they never move.
  const fixedPorts = hostPort !== 0 && appPort !== 0;
  let servers: DevServers | null = null;
  for (let pair = 0; servers === null; pair += 1) {
    try {
      servers = await startDevServers({
        slug: config.slug,
        background: config.background,
        serveDirectory: config.serveDirectory,
        sdkBundle,
        runToolCall: (tool, argumentsObject) => broker.runToolCall(tool, argumentsObject),
        hostPort: shiftedPort(hostPort, pair),
        appPort: shiftedPort(appPort, pair),
      });
    } catch (error) {
      // A pair already in use (another folder's preview, most often) moves
      // the run to the next pair; startDevServers has released the port it
      // did bind.
      if (portUnavailable(error) && pair + 1 < pairs && fixedPorts) {
        continue;
      }
      throw devStartFailure(error, baseUrl, { hostPort, appPort, pairs });
    }
  }

  const stopWatching = watchDirectory(config.serveDirectory, () => {
    servers.notifyChange();
  });
  const idleTimeoutMs = options.idleTimeoutMs ?? DEV_IDLE_TIMEOUT_MS;
  const idle = idleWatch(servers, idleTimeoutMs, options.idleCheckMs ?? DEV_IDLE_CHECK_MS);

  try {
    // The record is what `dev --stop` finds; a home that can't be written
    // costs that convenience, not the preview.
    const recorded = await tryWriteDevState(environment.homeDirectory, projectDirectory, servers);
    const opened = await io.openUrl(servers.hostOrigin);
    io.out(readyText(config.slug, servers, opened, recorded, idleTimeoutMs));
    const ending = await Promise.race([io.waitForShutdown().then(() => "shutdown" as const), idle.expired]);
    if (ending === "idle") {
      io.out(
        `✓ Stopped   No page was open for ${idleWindowWords(idleTimeoutMs)}, so ` +
          `driggsby dev stopped itself.\n\nStart it again with:\n  ${DEV_START_COMMAND}\n`,
      );
    }
    return 0;
  } finally {
    idle.cancel();
    stopWatching();
    // The record goes before the ports are freed, so a dev starting the
    // instant these close never finds a record this one is about to remove.
    // (A `dev --stop` waiting on this exit polls the pid for five seconds,
    // and closing takes well under one.) The record is a convenience: a
    // failure to remove it must never keep the ports open.
    try {
      await removeDevState(environment.homeDirectory, process.pid);
    } catch {
      // Left behind; the next read finds a dead pid and removes it.
    }
    await servers.close();
  }
}

async function tryWriteDevState(homeDirectory: string, folder: string, servers: DevServers): Promise<boolean> {
  try {
    // Records a dev left behind on these ports can't be live: they're ours now.
    await pruneDevStatesForPorts(homeDirectory, process.pid, servers.hostPort, servers.appPort);
    await writeDevState(homeDirectory, {
      pid: process.pid,
      folder,
      startedAt: new Date().toISOString(),
      hostPort: servers.hostPort,
      appPort: servers.appPort,
    });
    return true;
  } catch {
    return false;
  }
}

function readyText(slug: string, servers: DevServers, opened: boolean, recorded: boolean, idleTimeoutMs: number): string {
  const stopLine = recorded
    ? `${wrapProse("Edit the app's files and the page reloads on save. Press Ctrl+C to stop, or run this in the app's folder:")}\n  ${DEV_STOP_COMMAND}\n`
    : `${wrapProse("Edit the app's files and the page reloads on save. Press Ctrl+C to stop.")}\n`;
  return (
    `✓ Ready     ${slug} is running with your live Driggsby data${opened ? ", at:" : ":"}\n\n` +
    `  ${servers.hostOrigin}\n\n` +
    `${wrapProse(`That page embeds the app from ${servers.appOrigin}. Opened on its own, the app gets no Driggsby data, so use the address above.`)}\n\n` +
    `${stopLine}\n` +
    `${wrapProse(`It stops on its own after ${idleWindowWords(idleTimeoutMs)} with no page open.`)}\n` +
    "\nNext:\n  Put it live on driggsby.dev with npx driggsby@latest deploy\n"
  );
}

export function idleWindowWords(timeoutMs: number): string {
  const minutes = Math.round(timeoutMs / 60_000);
  if (minutes < 1) {
    return "a moment";
  }
  return minutes === 1 ? "1 minute" : `${String(minutes)} minutes`;
}

interface IdleWatch {
  // Resolves once no host page has held its event stream for the whole window.
  expired: Promise<"idle">;
  cancel: () => void;
}

function idleWatch(servers: DevServers, timeoutMs: number, checkMs: number): IdleWatch {
  let resolveExpired: (ending: "idle") => void = () => undefined;
  const expired = new Promise<"idle">((resolve) => {
    resolveExpired = resolve;
  });
  let idleSince = Date.now();
  const timer = setInterval(() => {
    if (servers.clientCount() > 0) {
      idleSince = Date.now();
      return;
    }
    if (Date.now() - idleSince >= timeoutMs) {
      resolveExpired("idle");
    }
  }, checkMs);
  // A pending check must never hold the process open once the run ends.
  timer.unref();
  return {
    expired,
    cancel: () => {
      clearInterval(timer);
    },
  };
}

// The Driggsby SDK bundle ships inside @driggsby/sdk; dev serves it on the
// app origin at the same path production serves it, so the scaffold's
// script tag works identically in both places.
async function loadSdkBundle(): Promise<string> {
  const require = createRequire(import.meta.url);
  const bundlePath = require.resolve("@driggsby/sdk/driggsby-sdk.js");
  return await readFile(bundlePath, "utf8");
}

function shiftedPort(port: number, pair: number): number {
  return port === 0 ? 0 : port + pair * 2;
}

// In use, or reserved (Windows can exclude port ranges for Hyper-V and
// WinNAT, which reads as access denied).
function portUnavailable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "EADDRINUSE" || code === "EACCES";
}

// One preview per folder: a second would only compete with the first for
// the same files, so dev points at the one already running instead.
async function refuseSecondPreview(homeDirectory: string, projectDirectory: string): Promise<void> {
  const reads = await readDevStates(homeDirectory, undefined, projectDirectory);
  const running = reads.find((read) => read.status === "live")?.state;
  if (running === undefined) {
    return;
  }
  throw new CliError(
    `driggsby dev is already running for this app, at:\n  http://127.0.0.1:${String(running.hostPort)}\n\n` +
      `${wrapProse("Open that address, or stop it and start again:")}\n  ${DEV_STOP_COMMAND}\n  ${DEV_START_COMMAND}`,
    1,
  );
}

interface PortRange {
  hostPort: number;
  appPort: number;
  pairs: number;
}

function devStartFailure(error: unknown, baseUrl: string, ports: PortRange): CliError {
  if (error instanceof CliError) {
    return error;
  }
  if (portUnavailable(error)) {
    const first = Math.min(ports.hostPort, ports.appPort);
    const last = Math.max(shiftedPort(ports.hostPort, ports.pairs - 1), shiftedPort(ports.appPort, ports.pairs - 1));
    return new CliError(
      `${wrapProse(`driggsby dev serves previews in pairs of ports from ${String(first)} to ${String(last)}, and none of those pairs is free on this machine. Stop a preview you're done with, in its app's folder:`)}\n` +
        `  ${DEV_STOP_COMMAND}\n\n` +
        `Then try again here:\n  ${DEV_START_COMMAND}`,
      1,
    );
  }
  const blocked = blockedNetworkError(error, {
    host: apiHost(baseUrl),
    retryCommand: DEV_START_COMMAND,
  });
  if (blocked !== null) {
    return blocked;
  }
  return new CliError(
    `We weren't able to start the preview just now. Please try again:\n  ${DEV_START_COMMAND}`,
    1,
  );
}
