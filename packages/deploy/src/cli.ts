// Side-effect entry for bin/driggsby-deploy.js. Kept separate from
// entrypoint.ts so tests exercise runDeployEntrypoint without triggering a
// real deploy on import.
import process from "node:process";

import { runDeployEntrypoint } from "./entrypoint.ts";

process.exitCode = await runDeployEntrypoint({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  env: process.env,
  out: (text) => {
    process.stdout.write(text);
  },
  error: (text) => {
    process.stderr.write(text);
  },
});
