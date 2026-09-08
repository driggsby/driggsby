// The minimal `npx @driggsby/deploy` entrypoint for Node-only sandboxes:
// deploy the current directory's driggsby.json project, authenticating with
// the DRIGGSBY_TOKEN environment variable. The full experience (saved
// sign-in, previews, rollback) lives in the driggsby CLI; this exists for
// environments that can only run one command with an injected token.
import { readFile } from "node:fs/promises";

import { resolveBaseUrl } from "./base-url.ts";
import { deployProjectFiles } from "./deploy.ts";
import { DeployApiError, DeployError } from "./errors.ts";
import { collectDeployFiles, formatBytes } from "./manifest.ts";
import { hasLiveAddress, liveAddresses, liveAddressLines } from "./live-addresses.ts";
import { readProjectConfig } from "./project-config.ts";
import { capForTerminal, quotedForTerminal, wrapProse } from "./terminal-text.ts";

// Server-supplied error text is bounded like every other string this bin did
// not author (same cap as the driggsby CLI's deploy commands).
const MAX_ERROR_DESCRIPTION_CHARS = 300;

const USAGE =
  "Deploys the Driggsby app in the current directory, live.\n" +
  "\n" +
  "Usage:\n" +
  "  npx @driggsby/deploy\n" +
  "\n" +
  "This is the whole interface: a bare invocation reads driggsby.json in the\n" +
  'current directory, uploads its "serve" folder, and makes the result live\n' +
  "at your app's address. It authenticates only through the DRIGGSBY_TOKEN\n" +
  "environment variable.\n" +
  "\n" +
  "Previews, version history, rollback, and saved sign-in live in the full\n" +
  "CLI:\n" +
  "  npx driggsby@latest --help\n";

export interface EntrypointIo {
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  out: (text: string) => void;
  error: (text: string) => void;
}

export async function runDeployEntrypoint(io: EntrypointIo): Promise<number> {
  // A bare invocation is the only one that deploys. Anything else — a help
  // flag, a guessed --preview, a typo — must never trigger a live publish,
  // because an agent probing an unfamiliar bin starts with `--help`.
  if (io.argv.includes("-h") || io.argv.includes("--help")) {
    io.out(USAGE);
    return 0;
  }
  if (io.argv.includes("--version")) {
    io.out(`${await packageVersion()}\n`);
    return 0;
  }
  if (io.argv.length > 0) {
    io.error(
      `Unrecognized argument: ${quotedForTerminal(io.argv[0] ?? "", 80)}\n` +
        `Nothing was deployed.\n\n${USAGE}`,
    );
    return 2;
  }
  try {
    const token = io.env.DRIGGSBY_TOKEN?.trim();
    if (token === undefined || token === "") {
      io.error(
        "DRIGGSBY_TOKEN isn't set. This command authenticates only through that\n" +
          "environment variable. On your own machine, use the full CLI instead:\n" +
          "sign in once with npx driggsby@latest login, then run\n" +
          "npx driggsby@latest deploy.\n",
      );
      return 1;
    }
    const baseUrl = resolveBaseUrl(io.env);
    const config = await readProjectConfig(io.cwd);
    const collected = await collectDeployFiles(config.serveDirectory);
    const { outcome, createdApp } = await deployProjectFiles(
      { baseUrl, token },
      io.cwd,
      config.slug,
      collected,
      { live: true, ...(config.background !== null ? { background: config.background } : {}) },
    );
    if (createdApp !== null) {
      // The assigned slug is server text, so it prints quoted and bounded
      // like every other string this bin did not author; the whole sentence
      // wraps because a maximum-length slug pushes it past 80 columns. The
      // commit reminder matters most here: this bin targets ephemeral
      // sandboxes, and a checkout that discards the rewritten driggsby.json
      // creates a brand-new app at a new address on every run.
      io.out(
        `${wrapProse(
          `Created your app as ${quotedForTerminal(createdApp.appSlug, 80)} — Driggsby assigns the final name (yours plus a unique ending) and saved it in driggsby.json. Commit that updated driggsby.json: it is the only record of your app's address, and without it the next deploy creates a second app.`,
        )}\n`,
      );
    }
    const uploadedNote =
      outcome.uploadedBlobCount === 0
        ? "nothing new to upload — every file was already on Driggsby"
        : `uploaded ${formatBytes(outcome.uploadedBytes)}`;
    // The slug and URL come back from the server, so they are sanitized and
    // length-bounded like every other string this bin did not author — and
    // the slug prints quoted so it reads as a name, never as this bin's own
    // sentence. The bounds never truncate legitimate values: a slug tops
    // out at 63 characters and the app URL at 84.
    io.out(
      `Deployed ${quotedForTerminal(outcome.appSlug, 80)} (v${outcome.versionNumber}, ${uploadedNote}).\n`,
    );
    // The Driggsby page for the app first, where it runs with the person's
    // data, then the app's own address: the same lines the driggsby CLI prints.
    const addresses = liveAddresses(outcome.url, outcome.consoleUrl, baseUrl);
    if (hasLiveAddress(addresses)) {
      io.out(`Live at:\n${liveAddressLines(addresses)}`);
    }
    return 0;
  } catch (error) {
    if (error instanceof DeployApiError) {
      // A 503's server description talks to the protocol client ("retry the
      // same PUT"), so it gets copy written for the person or agent running
      // this bin instead.
      if (error.status === 503) {
        io.error(
          "Driggsby is briefly unavailable just now. Please run this command\n" +
            "again in a minute.\n",
        );
        return 1;
      }
      const description = capForTerminal(error.message, MAX_ERROR_DESCRIPTION_CHARS).trim();
      io.error(
        description === ""
          ? "The Driggsby deploy API refused this request without saying why.\nPlease try again in a minute.\n"
          : `${wrapProse(description)}\n`,
      );
      return 1;
    }
    if (error instanceof DeployError) {
      // Locally-authored message; any interpolated filesystem names were
      // already sanitized where the message was built.
      io.error(`${error.message}\n`);
      return 1;
    }
    io.error("We weren't able to finish this deploy. Please try again in a minute.\n");
    return 1;
  }
}

// --version runs outside the deploy try block, so a failure here would
// escape as a raw stack trace; an unreadable own-package.json — or one
// missing its version field (an impossible install, effectively) — degrades
// to "unknown" instead.
async function packageVersion(): Promise<string> {
  try {
    const raw = await readFile(new URL("../package.json", import.meta.url), "utf8");
    const version = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof version === "string" ? version : "unknown";
  } catch {
    return "unknown";
  }
}
