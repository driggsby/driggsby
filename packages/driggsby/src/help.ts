// Help text is contract, asserted byte-for-byte against the fixtures in
// __fixtures__/. The mcp and mcp setup blocks are still byte-identical to
// the Rust CLI's output (captured from driggsby 0.1.42), including the clap
// quirks (the trailing spaces on the blank line before [possible values] in
// the long setup help, and the distinct short/long setup variants). The root
// help grew past the Rust CLI when login/logout landed; its fixture pins the
// current text.
import { DEV_IDLE_MINUTES } from "./dev/dev-commands.ts";
import { APP_TOOL_ALLOWLIST } from "./dev/tool-allowlist.ts";
import { wrapNames } from "./terminal-text.ts";

export const ROOT_HELP = `Usage: npx driggsby@latest <COMMAND>

Commands:
  mcp       Set up Driggsby MCP clients.
  login     Sign in to Driggsby and save an app token on this machine.
  logout    Remove the saved Driggsby app token.
  init      Create a new Driggsby app in a new folder.
  dev       Preview the app in this directory with your live Driggsby data.
  deploy    Deploy the app in this directory to Driggsby.
  rollback  Switch which deployed version of your app is live.
  versions  List your deployed app's versions.
  delete    Permanently remove a deployed app.
  query     Run one Driggsby data tool and print its result as JSON.

Options:
  -h, --help     Print help
  -V, --version  Print version

Examples:
  npx driggsby@latest mcp setup
  npx driggsby@latest mcp setup claude-code
  npx driggsby@latest mcp setup codex
  npx driggsby@latest mcp setup other
  npx driggsby@latest login
  npx driggsby@latest init money-dash
  npx driggsby@latest dev
  npx driggsby@latest deploy
  npx driggsby@latest query get_overview
`;

export const INIT_HELP = `Create a new Driggsby app in a new folder.

This makes a small static app — index.html, app.js, styles.css — plus the
driggsby.json that names it. The app shows sample data on its own, and your
real Driggsby data when it runs inside Driggsby.

Usage: npx driggsby@latest init [NAME]

Arguments:
  [NAME]  The app's name: 3-63 lowercase letters, digits, and dashes.
          Any readable name works — the first deploy assigns the app's
          address by adding a unique ending, like
          your-name-x7k2qf.driggsby.dev — so names never collide.
          Asked for when omitted.

Options:
  -h, --help  Print help
`;

export const LOGIN_HELP = `Sign in to Driggsby and save an app token on this machine.

This opens a Driggsby approval page in your browser. Approving it issues an
app token that lets this machine read your Driggsby data and deploy Driggsby
apps. The token is saved locally for other driggsby commands and is never
printed.

Usage: npx driggsby@latest login

Options:
  -h, --help  Print help
`;

export const LOGOUT_HELP = `Remove the saved Driggsby app token.

This removes the app token that npx driggsby@latest login saved on this
machine. It does not sign you out of Driggsby in your browser or in your AI
clients.

Usage: npx driggsby@latest logout

Options:
  -h, --help  Print help
`;

export const DEV_HELP = `Preview the app in this directory with your live Driggsby data.

This runs the app locally, embedded the same way Driggsby embeds it after a
deploy, so what you see here is what a deploy will show. Edits to the app's
files reload the page on save.

While dev runs, the preview serves your financial data to this machine —
other websites can't reach it, but anything running locally can, so stop
it when you're done: press Ctrl+C, or from any terminal run
npx driggsby@latest dev --stop. It also stops on its own after
${String(DEV_IDLE_MINUTES)} minutes with no page open.

Sign in first with npx driggsby@latest login.

Usage: npx driggsby@latest dev [--stop]

Options:
      --stop  Stop the driggsby dev running on this machine.
  -h, --help  Print help
`;

export const DEPLOY_HELP = `Deploy the app in this directory to Driggsby.

This reads driggsby.json next to your app files, uploads only what changed,
and makes the new version live. It prints the app's page in Driggsby, where
it runs with your data, then the app's own driggsby.dev address, which
shows no Driggsby data when opened directly. The first deploy creates the
app: Driggsby assigns its address (your name plus a unique ending) and
saves it back into driggsby.json. With --preview, the version is uploaded
and kept ready without changing what's live.

Sign in first with npx driggsby@latest login.

Usage: npx driggsby@latest deploy [--preview]

Options:
      --preview  Upload this version without making it live.
  -h, --help     Print help
`;

export const ROLLBACK_HELP = `Switch which deployed version of your app is live.

Driggsby keeps your app's recent versions, so going live with any of them —
older or newer — re-uploads nothing. Without --to, this lists the versions
you can choose from and asks for one.

Usage: npx driggsby@latest rollback [--to <VERSION>]

Options:
      --to <VERSION>  The version number to make live, as shown by
                      npx driggsby@latest versions.
  -h, --help          Print help
`;

export const DELETE_HELP = `Permanently remove a deployed app.

This deletes the app and every version Driggsby kept for it. There is no
undo: the app's address shows nothing from that moment on. With no name,
the app in this folder's driggsby.json is the one deleted. You'll be asked
to type the name back to confirm; scripts and agents pass --yes instead.

Usage: npx driggsby@latest delete [APP-ADDRESS-NAME] [--yes]

Options:
      --yes   Skip the confirmation question. For scripts and agents.
  -h, --help  Print help
`;

export const VERSIONS_HELP = `List your deployed app's versions.

Shows every version Driggsby has kept for the app in this directory, which
one is live, and the version numbers npx driggsby@latest rollback accepts.

Usage: npx driggsby@latest versions

Options:
  -h, --help  Print help
`;

// The tool list is the allowlist itself, so the help can never name a tool
// a Driggsby app cannot watch.
const QUERY_TOOL_LINES = wrapNames([...APP_TOOL_ALLOWLIST], "          ");

export const QUERY_HELP = `Run one Driggsby data tool and print its result as JSON.

The output is exactly what driggsby.watch hands an app's callback for the
same tool and params, so you can read a result's shape before writing any
render code. Only the read-only tools an app can watch are accepted. The
JSON goes to stdout and nothing else does; messages go to stderr.

Sign in first with npx driggsby@latest login.

Usage: npx driggsby@latest query <TOOL> [--sql <SQL>] [--params <JSON>]

Arguments:
  <TOOL>  One of:
${QUERY_TOOL_LINES}

Options:
      --sql <SQL>      The SQL for query_cash_sql or query_investment_sql.
                       Overrides a sql key given in --params.
      --params <JSON>  Other params as a JSON object, for example
                       '{"history_type":"liabilities"}'.
  -h, --help           Print help

Examples:
  npx driggsby@latest query get_overview
  npx driggsby@latest query list_recurring_transactions
  npx driggsby@latest query query_cash_sql --sql "SELECT 1"
`;

export const MCP_HELP = `Set up Driggsby MCP clients.

Usage: npx driggsby@latest mcp <COMMAND>

Commands:
  setup  Set up Driggsby for an AI client.

Options:
  -h, --help  Print help
`;

// mcp setup -h: clap's compact table.
export const MCP_SETUP_HELP_SHORT = `Set up Driggsby for an AI client.

Usage: npx driggsby@latest mcp setup [OPTIONS] [CLIENT]

Arguments:
  [CLIENT]  Client ID: claude-code, codex, or other.

Options:
      --print     Print the native setup command instead of running it.
  -s <MCP_SCOPE>  Claude Code only. Values: local, user (default). [possible values: local, user]
  -h, --help      Print help (see more with '--help')
`;

// mcp setup --help: clap's long form. The trailing spaces after the
// "Values: local, user (default)." line are clap's own rendering.
export const MCP_SETUP_HELP_LONG = `Set up Driggsby for an AI client.

Run once per client. This adds Driggsby's MCP URL to supported native client configs. Choose other
to print OAuth-based remote MCP setup instructions.

Supported clients: claude-code, codex, other.

Usage: npx driggsby@latest mcp setup [OPTIONS] [CLIENT]

Arguments:
  [CLIENT]
          Client ID: claude-code, codex, or other.

Options:
      --print
          Print the native setup command instead of running it.

  -s <MCP_SCOPE>
          Claude Code only. Values: local, user (default).
${"          "}
          [possible values: local, user]

  -h, --help
          Print help (see a summary with '-h')
`;
