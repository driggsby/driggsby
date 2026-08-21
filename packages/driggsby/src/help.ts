// Help text is contract: every block below is byte-identical to the Rust
// CLI's output, asserted against fixtures captured from driggsby 0.1.42 —
// including the clap quirks (the trailing spaces on the blank line before
// [possible values] in the long setup help, and the distinct short/long
// setup variants).
export const ROOT_HELP = `Usage: npx driggsby@latest <COMMAND>

Commands:
  mcp  Set up Driggsby MCP clients.

Options:
  -h, --help     Print help
  -V, --version  Print version

Examples:
  npx driggsby@latest mcp setup
  npx driggsby@latest mcp setup claude-code
  npx driggsby@latest mcp setup codex
  npx driggsby@latest mcp setup other
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
