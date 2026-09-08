// CLI entry point. The bin stub (bin/driggsby.js) imports this module; it is
// never imported as a library.
import { homedir } from "node:os";

import { parseArgv } from "./args.ts";
import { CliError } from "./cli-error.ts";
import { runDelete } from "./deploy/delete-command.ts";
import { runDeploy } from "./deploy/deploy-command.ts";
import { runDev } from "./dev/dev-command.ts";
import { runDevStop } from "./dev/dev-stop.ts";
import { runInit } from "./init/init-command.ts";
import { runRollback } from "./deploy/rollback-command.ts";
import { runVersions } from "./deploy/versions-command.ts";
import { runQuery } from "./query/query-command.ts";
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
    case "init":
      return await runInit({ slug: command.slug });
    case "dev":
      return command.stop ? await runDevStop(homedir()) : await runDev();
    case "deploy":
      return await runDeploy({ preview: command.preview });
    case "delete":
      return await runDelete({ slug: command.slug, yes: command.yes });
    case "rollback":
      return await runRollback({ toVersion: command.toVersion });
    case "versions":
      return await runVersions({});
    case "query":
      return await runQuery({ tool: command.tool, params: command.params });
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
