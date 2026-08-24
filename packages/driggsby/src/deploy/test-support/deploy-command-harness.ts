// Shared setup for the deploy-family command tests: a temp project folder
// with a driggsby.json, a credential environment whose token comes from
// DRIGGSBY_TOKEN (so no platform keyring is ever consulted), and captured
// stdout. The protocol-level fake server comes from the deploy package.
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type CredentialEnvironment } from "../../credentials/store.ts";

export { startFakeDeployServer } from "../../../../deploy/src/test-support/fake-deploy-server.ts";

export const TEST_TOKEN = "dgb_at_test_token_3333";

// A project folder holding driggsby.json plus the given files.
export async function makeProject(
  slug: string,
  files: Record<string, string> = { "index.html": "<h1>hi</h1>" },
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "driggsby-cmd-"));
  await writeFile(join(directory, "driggsby.json"), JSON.stringify({ slug, serve: "." }));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(directory, name), content);
  }
  return directory;
}

// Signed in via DRIGGSBY_TOKEN; pass signedIn: false for the no-token path.
// platform "win32" keeps the token read away from any real keychain/keyring.
export async function makeEnvironment(
  serverBaseUrl: string,
  options: { signedIn?: boolean } = {},
): Promise<CredentialEnvironment> {
  const homeDirectory = await mkdtemp(join(tmpdir(), "driggsby-home-"));
  const env: NodeJS.ProcessEnv = { DRIGGSBY_BASE_URL: serverBaseUrl };
  if (options.signedIn !== false) {
    env.DRIGGSBY_TOKEN = TEST_TOKEN;
  }
  return { platform: "win32", env, homeDirectory };
}

export interface CapturedOut {
  out: (text: string) => void;
  text: () => string;
}

export function capturedOut(): CapturedOut {
  let buffer = "";
  return {
    out: (text) => {
      buffer += text;
    },
    text: () => buffer,
  };
}
