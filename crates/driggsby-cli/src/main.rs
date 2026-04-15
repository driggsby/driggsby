use anyhow::Result;
use driggsby::cli::{Commands, McpCommand, connect::run_setup_command, parse_cli};

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<()> {
    let cli = parse_cli();

    match cli.command {
        Commands::Mcp { command } => match command {
            McpCommand::Setup {
                client,
                print,
                mcp_scope,
            } => run_setup_command(client, print, mcp_scope).await,
        },
    }
}
