// Help text is contract, asserted byte-for-byte against the fixtures in
// __fixtures__/. The mcp and mcp setup blocks are still byte-identical to
// the Rust CLI's output (captured from driggsby 0.1.42), including the clap
// quirks (the trailing spaces on the blank line before [possible values] in
// the long setup help, and the distinct short/long setup variants). The root
// help grew past the Rust CLI when login/logout landed; its fixture pins the
// current text.
export const ROOT_HELP = `Usage: npx driggsby@latest <COMMAND>

Commands:
  mcp     Set up Driggsby MCP clients.
  login   Sign in to Driggsby and save an app token on this machine.
  logout  Remove the saved Driggsby app token.

Options:
  -h, --help     Print help
  -V, --version  Print version

Examples:
  npx driggsby@latest mcp setup
  npx driggsby@latest mcp setup claude-code
  npx driggsby@latest mcp setup codex
  npx driggsby@latest mcp setup other
  npx driggsby@latest login
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
