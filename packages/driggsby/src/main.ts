// CLI entry point. The bin stub (bin/driggsby.js) imports this module; it is
// never imported as a library.
import { parseArgv } from "./args.ts";
import { CliError } from "./cli-error.ts";
import { runDeploy } from "./deploy/deploy-command.ts";
import { runRollback } from "./deploy/rollback-command.ts";
import { runVersions } from "./deploy/versions-command.ts";
import { runLogin } from "./login/login.ts";
import { runLogout } from "./login/logout.ts";
import { runMcpSetup } from "./mcp-setup/setup.ts";
import { VERSION } from "./version.ts";

async function run(argv: string[]): Promise<number> {
  const command = parseArgv(argv);
  switch (command.kind) {
    case "print-help": {
      const stream = command.stream === "stdout" ? process.stdout : process.stderr;
      stream.write(command.text);
      return command.exitCode;
    }
    case "print-version":
      process.stdout.write(`driggsby ${VERSION}\n`);
      return 0;
    case "mcp-setup":
      await runMcpSetup({ client: command.client, print: command.print, scope: command.scope });
      return 0;
    case "login":
      await runLogin();
      return 0;
    case "logout":
      return await runLogout();
    case "deploy":
      return await runDeploy({ preview: command.preview });
    case "rollback":
      return await runRollback({ toVersion: command.toVersion });
    case "versions":
      return await runVersions({});
  }
}

try {
  process.exitCode = await run(process.argv.slice(2));
} catch (error) {
  if (error instanceof CliError) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.exitCode;
  } else {
    process.stderr.write("Something went wrong running driggsby. Please try again.\n");
    process.exitCode = 1;
  }
}
