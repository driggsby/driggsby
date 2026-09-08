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
import { readLiveDevState, removeDevState, writeDevState } from "./dev-state.ts";
import { displayFolder } from "./display-folder.ts";
import { McpBroker } from "./mcp-broker.ts";
import { watchDirectory } from "./watcher.ts";

export const DEV_HOST_PORT = 4111;
export const DEV_APP_PORT = 4112;
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
  // Tests bind ephemeral ports; the real command uses the fixed dev ports.
  hostPort?: number;
  appPort?: number;
  // Tests shorten the idle window; the real command uses the 30-minute one.
  idleTimeoutMs?: number;
  idleCheckMs?: number;
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
  const sdkBundle = await loadSdkBundle();
  const broker = new McpBroker({ baseUrl: session.baseUrl, token: session.token });

  let servers: DevServers;
  try {
    servers = await startDevServers({
      slug: config.slug,
      background: config.background,
      serveDirectory: config.serveDirectory,
      sdkBundle,
      runToolCall: (tool, argumentsObject) => broker.runToolCall(tool, argumentsObject),
      hostPort: options.hostPort ?? DEV_HOST_PORT,
      appPort: options.appPort ?? DEV_APP_PORT,
    });
  } catch (error) {
    throw await devStartFailure(error, baseUrl, environment.homeDirectory);
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
    await removeDevState(environment.homeDirectory, process.pid);
    await servers.close();
  }
}

async function tryWriteDevState(homeDirectory: string, folder: string, servers: DevServers): Promise<boolean> {
  try {
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
    ? `${wrapProse("Edit the app's files and the page reloads on save. Press Ctrl+C to stop, or from any terminal:")}\n  ${DEV_STOP_COMMAND}\n`
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

function idleWindowWords(timeoutMs: number): string {
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

async function devStartFailure(error: unknown, baseUrl: string, homeDirectory: string): Promise<CliError> {
  if (error instanceof CliError) {
    return error;
  }
  if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
    const running = await readLiveDevState(homeDirectory);
    if (running !== null) {
      return new CliError(
        `driggsby dev is already running for the app in:\n  ${displayFolder(running.folder)}\n\n` +
          `Only one can run at a time. Stop it first:\n  ${DEV_STOP_COMMAND}\n\n` +
          `Then try again here:\n  ${DEV_START_COMMAND}`,
        1,
      );
    }
    return new CliError(
      `${wrapProse(`Ports ${String(DEV_HOST_PORT)} and ${String(DEV_APP_PORT)} are how driggsby dev serves the preview, and something on this machine is already using one of them. Stop that program and try again:`)}\n` +
        `  ${DEV_START_COMMAND}`,
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
