use std::env;

use anyhow::Result;
use driggsby::{
    cli::{
        Commands,
        commands::{
            run_cli_daemon_command, run_login_command, run_logout_command, run_status_command,
        },
        parse_cli,
    },
    runtime_paths::resolve_runtime_paths,
    shim::run_mcp_server_command,
};

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<()> {
    let cli = parse_cli();
    let runtime_paths = resolve_runtime_paths(false)?;
    let current_exe = env::current_exe()?;

    match cli.command {
        Commands::Login => run_login_command(&runtime_paths).await,
        Commands::Logout => run_logout_command(&runtime_paths).await,
        Commands::Status => run_status_command(&runtime_paths).await,
        Commands::McpServer => run_mcp_server_command(&runtime_paths, &current_exe).await,
        Commands::CliDaemon => run_cli_daemon_command(&runtime_paths).await,
    }
}
