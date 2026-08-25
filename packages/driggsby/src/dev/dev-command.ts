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
import { startDevServers, type DevServers } from "./dev-servers.ts";
import { McpBroker } from "./mcp-broker.ts";
import { watchDirectory } from "./watcher.ts";

export const DEV_HOST_PORT = 4111;
export const DEV_APP_PORT = 4112;

const DEV_RETRY_COMMAND = "npx driggsby@latest dev";

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
      serveDirectory: config.serveDirectory,
      sdkBundle,
      runToolCall: (tool, argumentsObject) => broker.runToolCall(tool, argumentsObject),
      hostPort: options.hostPort ?? DEV_HOST_PORT,
      appPort: options.appPort ?? DEV_APP_PORT,
    });
  } catch (error) {
    throw devStartFailure(error, baseUrl);
  }

  const stopWatching = watchDirectory(config.serveDirectory, () => {
    servers.notifyChange();
  });

  try {
    const opened = await io.openUrl(servers.hostOrigin);
    io.out(
      `✓ Ready     ${config.slug} is running with your live Driggsby data${opened ? ", at:" : ":"}\n\n` +
        `  ${servers.hostOrigin}\n\n` +
        `${wrapProse("Edit the app's files and the page reloads on save. Press Ctrl+C to stop.")}\n` +
        "\nNext:\n  Put it live on driggsby.dev with npx driggsby@latest deploy\n",
    );
    await io.waitForShutdown();
    return 0;
  } finally {
    stopWatching();
    await servers.close();
  }
}

// The Driggsby SDK bundle ships inside @driggsby/sdk; dev serves it on the
// app origin at the same path production serves it, so the scaffold's
// script tag works identically in both places.
async function loadSdkBundle(): Promise<string> {
  const require = createRequire(import.meta.url);
  const bundlePath = require.resolve("@driggsby/sdk/driggsby-sdk.js");
  return await readFile(bundlePath, "utf8");
}

function devStartFailure(error: unknown, baseUrl: string): CliError {
  if (error instanceof CliError) {
    return error;
  }
  if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
    return new CliError(
      `${wrapProse(`Ports ${String(DEV_HOST_PORT)} and ${String(DEV_APP_PORT)} are how driggsby dev serves the preview, and something on this machine is already using one of them. Stop that program (often another driggsby dev) and try again:`)}\n` +
        `  ${DEV_RETRY_COMMAND}`,
      1,
    );
  }
  const blocked = blockedNetworkError(error, {
    host: apiHost(baseUrl),
    retryCommand: DEV_RETRY_COMMAND,
  });
  if (blocked !== null) {
    return blocked;
  }
  return new CliError(
    `We weren't able to start the preview just now. Please try again:\n  ${DEV_RETRY_COMMAND}`,
    1,
  );
}
