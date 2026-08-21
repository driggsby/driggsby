// driggsby logout: remove the app token that login saved, everywhere it
// could live on this machine. A removal that fails is reported as a failure,
// never as "nothing to remove" — the token may still work, and the user must
// know that.
import {
  clearStoredToken,
  type CredentialEnvironment,
  defaultCredentialEnvironment,
  describeStorageLocation,
} from "../credentials/store.ts";
import { wrapProse } from "../terminal-text.ts";

function writeToStdout(text: string): void {
  process.stdout.write(text);
}

export async function runLogout(
  environment: CredentialEnvironment = defaultCredentialEnvironment(),
  out: (text: string) => void = writeToStdout,
): Promise<number> {
  const result = await clearStoredToken(environment);
  const cleared = result.clearedSources.map(describeStorageLocation).join(" and ");
  const failed = result.failedSources.map(describeStorageLocation).join(" and ");

  if (result.failedSources.length > 0) {
    if (result.clearedSources.length > 0) {
      out(`${wrapProse(`Your Driggsby app token was removed from ${cleared}.`)}\n\n`);
    }
    const keychainHint = result.failedSources.includes("keychain")
      ? " If your macOS keychain is locked, unlock it first."
      : result.failedSources.includes("keyring")
        ? " If your system keyring is locked or unreachable, unlock it first."
        : "";
    const failure =
      `We weren't able to remove your Driggsby app token from ${failed}, ` +
      `so it may still be saved there.${keychainHint}`;
    out(`${wrapProse(failure)}\n\nPlease try again:\n  npx driggsby@latest logout\n`);
  } else if (result.clearedSources.length === 0) {
    out("No saved Driggsby app token was found on this machine, so there was\nnothing to remove.\n");
  } else {
    out(`${wrapProse(`Signed out. Your Driggsby app token was removed from ${cleared}.`)}\n`);
  }

  if (result.envTokenStillSet) {
    out(
      "\nNote: DRIGGSBY_TOKEN is set in this environment and still works. Unset it\nto finish signing out here.\n",
    );
  }
  return result.failedSources.length > 0 ? 1 : 0;
}
