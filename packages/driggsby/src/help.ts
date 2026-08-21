// Help text is contract: the root and mcp help blocks are byte-identical to
// the Rust CLI's output (asserted against fixtures), and the launch docs
// quote these exact example commands. The mcp setup help is a deliberate
// simplification: one clean text serves both -h and --help (the original
// clap build rendered a short and a long variant), with all of the original
// content preserved.
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

export const MCP_SETUP_HELP = `Set up Driggsby for an AI client.

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

          [possible values: local, user]

  -h, --help
          Print help
`;
