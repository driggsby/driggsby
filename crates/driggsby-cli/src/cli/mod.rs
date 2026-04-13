pub mod commands;
pub mod connect;
pub mod format;

use clap::{CommandFactory, Parser, Subcommand};

const EXAMPLES: &str = "\
Examples:
  npx driggsby@latest connect
  npx driggsby@latest connect claude-code
  npx driggsby@latest connect codex
  npx driggsby@latest login
  npx driggsby@latest status
  npx -y driggsby@latest mcp-server";

#[derive(Debug, Parser)]
#[command(
    name = "driggsby",
    bin_name = "npx driggsby@latest",
    version,
    arg_required_else_help = true,
    disable_help_subcommand = true,
    about = "Local Driggsby CLI for connecting AI clients to Driggsby over MCP.",
    long_about = "Local Driggsby CLI for connecting AI clients to Driggsby over MCP.\n\nThe normal flow is:\n  1. Run npx driggsby@latest connect.\n  2. Choose your MCP client.\n  3. Use npx driggsby@latest status any time to confirm readiness.",
    after_help = EXAMPLES,
)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Commands,
}

#[derive(Debug, Clone, Subcommand)]
pub enum Commands {
    #[command(about = "Connect Driggsby to an MCP client.")]
    Connect {
        #[arg(help = "Known client id such as claude-code or codex, or another client name.")]
        client: Option<String>,
    },
    #[command(about = "Open the browser sign-in flow and connect the CLI.")]
    Login,
    #[command(about = "List or revoke approved local MCP clients.")]
    Clients {
        #[command(subcommand)]
        command: ClientCommand,
    },
    #[command(about = "Show a clear readiness summary for humans and agents.")]
    Status,
    #[command(about = "Run the local MCP server that AI clients should launch.")]
    McpServer,
    #[command(about = "Clear local CLI auth and session state.")]
    Logout,
    #[command(name = "cli-daemon", hide = true)]
    CliDaemon,
}

#[derive(Debug, Clone, Subcommand)]
pub enum ClientCommand {
    #[command(about = "List approved local MCP clients.")]
    List,
    #[command(about = "Revoke an approved local MCP client.")]
    Revoke {
        #[arg(help = "Client grant id, integration id, or display name to revoke.")]
        client: String,
    },
}

pub fn parse_cli() -> Cli {
    Cli::parse()
}

pub fn render_help() -> String {
    let mut command = Cli::command();
    let mut output = Vec::new();
    let _ = command.write_long_help(&mut output);
    String::from_utf8_lossy(&output).into_owned()
}

#[cfg(test)]
mod tests {
    use super::render_help;

    #[test]
    fn help_mentions_happy_path_and_examples() {
        let help = render_help();

        assert!(help.contains("npx driggsby@latest connect"));
        assert!(help.contains("npx driggsby@latest connect claude-code"));
        assert!(help.contains("npx driggsby@latest login"));
        assert!(help.contains("npx -y driggsby@latest mcp-server"));
        assert!(help.contains("npx driggsby@latest status"));
        assert!(help.contains("Connect Driggsby to an MCP client"));
    }
}
