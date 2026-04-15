use std::{
    io::{self, IsTerminal, Write as _},
    time::Duration,
};

use anyhow::{Result, bail};
use tokio::process::Command as TokioCommand;

use crate::{
    cli::McpScope,
    cli::client_id,
    cli::known_client::KnownClient,
    cli::supported_mcp_config::{
        DRIGGSBY_MCP_URL, McpConfigCommand, build_installer_command, build_scoped_remover_command,
        render_shell_command,
    },
};

const CLIENT_CONFIG_COMMAND_TIMEOUT: Duration = Duration::from_secs(30);

pub async fn run_setup_command(
    requested_client: Option<String>,
    print: bool,
    mcp_scope: Option<McpScope>,
) -> Result<()> {
    let client = resolve_client(requested_client)?;
    validate_mcp_scope(client, mcp_scope)?;

    let installer = build_installer_command(client.cli_mcp_client(), mcp_scope);
    if print {
        print_manual_command(client, &installer);
        return Ok(());
    }

    println!("Adding Driggsby to {} MCP config...", client.display_name());
    flush_stdout()?;

    match run_config_command(&installer).await {
        Ok(Ok(output)) if output.status.success() => {
            print_success(client);
            Ok(())
        }
        Ok(Ok(output)) if command_reports_existing_config(&output) => {
            reinstall_existing_client(client, mcp_scope).await
        }
        Ok(Ok(_)) => {
            print_auto_setup_failure(
                client,
                &format!("{} mcp add returned an error.", installer.program),
                &installer,
            );
            Ok(())
        }
        Ok(Err(error)) if error.kind() == std::io::ErrorKind::NotFound => {
            print_auto_setup_failure(
                client,
                &format!("{} was not found.", installer.program),
                &installer,
            );
            Ok(())
        }
        Ok(Err(_)) => {
            print_auto_setup_failure(
                client,
                &format!("Could not run {}.", installer.program),
                &installer,
            );
            Ok(())
        }
        Err(_) => {
            print_auto_setup_failure(
                client,
                &format!("{} mcp add timed out.", installer.program),
                &installer,
            );
            Ok(())
        }
    }
}

fn resolve_client(requested_client: Option<String>) -> Result<KnownClient> {
    match requested_client {
        Some(value) => parse_client(&value),
        None => prompt_for_client(),
    }
}

pub(super) fn parse_client(value: &str) -> Result<KnownClient> {
    let canonical = client_id::canonicalize(value);
    let Some(client) = KnownClient::from_client_id(&canonical) else {
        bail!("Unsupported client: {canonical}\n\nSupported clients:\n  claude-code\n  codex");
    };
    Ok(client)
}

pub(super) fn validate_mcp_scope(client: KnownClient, mcp_scope: Option<McpScope>) -> Result<()> {
    if mcp_scope.is_none() || matches!(client, KnownClient::ClaudeCode) {
        return Ok(());
    }
    bail!("-s is supported only for Claude Code.");
}

fn prompt_for_client() -> Result<KnownClient> {
    if !io::stdin().is_terminal() {
        bail!("Pass a client name.\n\nExample:\n  npx driggsby@latest mcp setup claude-code");
    }

    println!("Which client are you setting up?");
    println!();
    println!("  1. Claude Code");
    println!("  2. Codex");
    println!();
    print!("Choose 1-2: ");
    flush_stdout()?;

    let choice = read_trimmed_line()?;
    match choice.as_str() {
        "1" => Ok(KnownClient::ClaudeCode),
        "2" => Ok(KnownClient::Codex),
        _ => bail!("Choose 1 or 2."),
    }
}

fn read_trimmed_line() -> Result<String> {
    let mut line = String::new();
    io::stdin().read_line(&mut line)?;
    Ok(line.trim().to_string())
}

async fn reinstall_existing_client(client: KnownClient, mcp_scope: Option<McpScope>) -> Result<()> {
    let cli_client = client.cli_mcp_client();
    let remover = build_scoped_remover_command(cli_client, mcp_scope);
    let installer = build_installer_command(cli_client, mcp_scope);

    match run_config_command(&remover).await {
        Ok(Ok(output)) if output.status.success() || command_reports_missing_config(&output) => {
            match run_config_command(&installer).await {
                Ok(Ok(output)) if output.status.success() => {
                    print_success(client);
                    Ok(())
                }
                _ => {
                    print_auto_setup_failure(
                        client,
                        "could not update existing MCP config.",
                        &installer,
                    );
                    Ok(())
                }
            }
        }
        _ => {
            print_auto_setup_failure(client, "could not replace existing MCP config.", &installer);
            Ok(())
        }
    }
}

async fn run_config_command(
    command: &McpConfigCommand,
) -> Result<std::io::Result<std::process::Output>, tokio::time::error::Elapsed> {
    let mut process = TokioCommand::new(&command.program);
    process.args(&command.args).kill_on_drop(true);
    tokio::time::timeout(CLIENT_CONFIG_COMMAND_TIMEOUT, process.output()).await
}

fn print_success(client: KnownClient) {
    println!("{} is set up.", client.display_name());
    println!();
    println!("Driggsby MCP URL:");
    println!("  {DRIGGSBY_MCP_URL}");
    println!();
    println!("Next:");
    println!(
        "  Open {} and authenticate Driggsby when prompted.",
        client.display_name()
    );
}

fn print_auto_setup_failure(client: KnownClient, reason: &str, installer: &McpConfigCommand) {
    println!("Auto-setup failed for {}: {reason}", client.display_name());
    println!();
    print_manual_command(client, installer);
}

fn print_manual_command(client: KnownClient, installer: &McpConfigCommand) {
    println!(
        "Run this command to add Driggsby to {}:",
        client.display_name()
    );
    println!();
    println!("  {}", render_shell_command(installer));
    println!();
    println!("Driggsby MCP URL:");
    println!("  {DRIGGSBY_MCP_URL}");
}

fn command_reports_existing_config(output: &std::process::Output) -> bool {
    command_output_contains(output, "already exists")
}

fn command_reports_missing_config(output: &std::process::Output) -> bool {
    command_output_contains(output, "No MCP server found")
        || command_output_contains(output, "No project-local MCP server found")
        || command_output_contains(output, "No user-scoped MCP server found")
        || command_output_contains(output, "No MCP server named 'driggsby' found")
}

fn command_output_contains(output: &std::process::Output, needle: &str) -> bool {
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    stdout.contains(needle) || stderr.contains(needle)
}

fn flush_stdout() -> Result<()> {
    Ok(io::stdout().flush()?)
}

#[cfg(test)]
mod tests;
