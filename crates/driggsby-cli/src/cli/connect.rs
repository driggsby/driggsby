use std::{
    io::{self, IsTerminal, Write as _},
    process::Command,
};

use anyhow::{Result, bail};

use crate::{
    auth::login::login_broker,
    broker::{
        grants::{
            CLIENT_GRANT_ID_ENV, CLIENT_GRANT_SECRET_ENV, CreatedClientGrant, create_client_grant,
            list_client_grants, revoke_client_grant, revoke_other_grants_for_integration,
        },
        installation::read_broker_metadata,
        secret_store::SecretStore,
    },
    runtime_paths::{RuntimePaths, ensure_runtime_directories},
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnectTarget {
    Known(KnownClient),
    Other(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KnownClient {
    ClaudeCode,
    Codex,
}

impl KnownClient {
    fn integration_id(self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude-code",
            Self::Codex => "codex",
        }
    }

    fn display_name(self) -> &'static str {
        match self {
            Self::ClaudeCode => "Claude Code",
            Self::Codex => "Codex",
        }
    }
}

impl ConnectTarget {
    fn display_name(&self) -> &str {
        match self {
            Self::Known(client) => client.display_name(),
            Self::Other(name) => name.as_str(),
        }
    }

    fn integration_id(&self) -> Option<&str> {
        match self {
            Self::Known(client) => Some(client.integration_id()),
            Self::Other(_) => None,
        }
    }
}

pub async fn run_connect_command(
    runtime_paths: &RuntimePaths,
    requested_client: Option<String>,
) -> Result<()> {
    ensure_runtime_directories(runtime_paths)?;
    let target = resolve_connect_target(requested_client)?;
    println!("Connecting Driggsby to {}...", target.display_name());
    flush_stdout()?;

    let resolved_store = crate::broker::resolve_secret_store::resolve_secret_store(runtime_paths)?;
    login_broker(
        runtime_paths,
        resolved_store.store.as_ref(),
        print_manual_sign_in_url,
    )
    .await?;

    let metadata = read_broker_metadata(runtime_paths)?
        .ok_or_else(|| anyhow::anyhow!("The local CLI auth state is incomplete."))?;
    let created = create_client_grant(
        resolved_store.store.as_ref(),
        &metadata.broker_id,
        target.display_name(),
        target.integration_id(),
    )?;

    println!();
    match target {
        ConnectTarget::Known(client) => {
            if install_known_client(client, &created)? {
                revoke_other_grants_for_integration(
                    resolved_store.store.as_ref(),
                    &metadata.broker_id,
                    client.integration_id(),
                    &created.grant.grant_id,
                )?;
            }
        }
        ConnectTarget::Other(_) => print_other_mcp_config(&created),
    }
    Ok(())
}

pub fn run_clients_command(
    runtime_paths: &RuntimePaths,
    command: super::ClientCommand,
) -> Result<()> {
    let resolved_store = crate::broker::resolve_secret_store::resolve_secret_store(runtime_paths)?;
    let Some(metadata) = read_broker_metadata(runtime_paths)? else {
        println!("No approved clients.");
        return Ok(());
    };

    match command {
        super::ClientCommand::Revoke { client } => {
            let revoked =
                revoke_client_grant(resolved_store.store.as_ref(), &metadata.broker_id, &client)?;
            if revoked.is_empty() {
                println!("No matching approved client found for {client}.");
            } else {
                println!("Revoked {client}.");
                remove_known_client_configs(&revoked);
                if revoked.iter().any(|grant| grant.integration_id.is_none()) {
                    println!();
                    println!("Also remove Driggsby from that client's MCP settings.");
                }
            }
        }
        super::ClientCommand::List => {
            print_client_grants(resolved_store.store.as_ref(), &metadata.broker_id)?;
        }
    }
    Ok(())
}

fn resolve_connect_target(requested_client: Option<String>) -> Result<ConnectTarget> {
    match requested_client {
        Some(value) => Ok(parse_connect_target(&value)),
        None => prompt_for_connect_target(),
    }
}

fn parse_connect_target(value: &str) -> ConnectTarget {
    let trimmed = value.trim();
    match trimmed
        .to_ascii_lowercase()
        .replace(['_', ' '], "-")
        .as_str()
    {
        "claude" | "claude-code" => ConnectTarget::Known(KnownClient::ClaudeCode),
        "codex" => ConnectTarget::Known(KnownClient::Codex),
        _ => ConnectTarget::Other(trimmed.to_string()),
    }
}

fn prompt_for_connect_target() -> Result<ConnectTarget> {
    if !io::stdin().is_terminal() {
        bail!("Pass a client name, such as npx driggsby@latest connect claude-code.");
    }

    println!("Which client are you setting up?");
    println!();
    println!("  1. Claude Code");
    println!("  2. Codex");
    println!("  3. Other MCP client");
    println!();
    print!("Choose 1-3: ");
    flush_stdout()?;

    let choice = read_trimmed_line()?;
    match choice.as_str() {
        "1" => Ok(ConnectTarget::Known(KnownClient::ClaudeCode)),
        "2" => Ok(ConnectTarget::Known(KnownClient::Codex)),
        "3" => prompt_for_other_client_name(),
        _ => bail!("Choose 1, 2, or 3."),
    }
}

fn prompt_for_other_client_name() -> Result<ConnectTarget> {
    print!("Client name: ");
    flush_stdout()?;
    let name = read_trimmed_line()?;
    if name.is_empty() {
        bail!("Client name is required.");
    }
    Ok(ConnectTarget::Other(name))
}

fn read_trimmed_line() -> Result<String> {
    let mut line = String::new();
    io::stdin().read_line(&mut line)?;
    Ok(line.trim().to_string())
}

fn install_known_client(client: KnownClient, created: &CreatedClientGrant) -> Result<bool> {
    let installer = build_installer_command(client, created);
    println!("Adding Driggsby to {}...", client.display_name());
    flush_stdout()?;

    let output = Command::new(&installer.program)
        .args(&installer.args)
        .output();
    match output {
        Ok(output) if output.status.success() => {
            println!("{} is connected.", client.display_name());
            println!();
            println!("Approved local client:");
            println!("  {}", client.display_name());
            Ok(true)
        }
        Ok(_) | Err(_) => {
            println!("Automatic setup did not complete.");
            println!();
            print_known_client_command(&installer);
            println!();
            print_other_mcp_config(created);
            Ok(false)
        }
    }
}

struct InstallerCommand {
    program: String,
    args: Vec<String>,
}

fn build_installer_command(client: KnownClient, created: &CreatedClientGrant) -> InstallerCommand {
    let grant_id_env = format!("{}={}", CLIENT_GRANT_ID_ENV, created.grant.grant_id);
    let grant_secret_env = format!("{}={}", CLIENT_GRANT_SECRET_ENV, created.secret);
    match client {
        KnownClient::ClaudeCode => InstallerCommand {
            program: "claude".to_string(),
            args: vec![
                "mcp".to_string(),
                "add".to_string(),
                "-e".to_string(),
                grant_id_env,
                "-e".to_string(),
                grant_secret_env,
                "driggsby".to_string(),
                "--".to_string(),
                "npx".to_string(),
                "-y".to_string(),
                "driggsby@latest".to_string(),
                "mcp-server".to_string(),
            ],
        },
        KnownClient::Codex => InstallerCommand {
            program: "codex".to_string(),
            args: vec![
                "mcp".to_string(),
                "add".to_string(),
                "--env".to_string(),
                grant_id_env,
                "--env".to_string(),
                grant_secret_env,
                "driggsby".to_string(),
                "--".to_string(),
                "npx".to_string(),
                "-y".to_string(),
                "driggsby@latest".to_string(),
                "mcp-server".to_string(),
            ],
        },
    }
}

fn remove_known_client_configs(grants: &[crate::broker::grants::BrokerClientGrant]) {
    let mut removed_claude = false;
    let mut removed_codex = false;
    for grant in grants {
        match grant.integration_id.as_deref() {
            Some("claude-code") if !removed_claude => {
                remove_known_client_config(KnownClient::ClaudeCode);
                removed_claude = true;
            }
            Some("codex") if !removed_codex => {
                remove_known_client_config(KnownClient::Codex);
                removed_codex = true;
            }
            _ => {}
        }
    }
}

fn remove_known_client_config(client: KnownClient) {
    let remover = build_remover_command(client);
    let output = Command::new(&remover.program).args(&remover.args).output();
    match output {
        Ok(output) if output.status.success() => {
            println!("Removed Driggsby from {}.", client.display_name());
        }
        Ok(_) | Err(_) => {
            println!(
                "Could not remove Driggsby from {} automatically.",
                client.display_name()
            );
            println!("Run this command to remove the MCP config:");
            println!("  {}", render_shell_command(&remover));
        }
    }
}

fn build_remover_command(client: KnownClient) -> InstallerCommand {
    match client {
        KnownClient::ClaudeCode => InstallerCommand {
            program: "claude".to_string(),
            args: vec![
                "mcp".to_string(),
                "remove".to_string(),
                "driggsby".to_string(),
            ],
        },
        KnownClient::Codex => InstallerCommand {
            program: "codex".to_string(),
            args: vec![
                "mcp".to_string(),
                "remove".to_string(),
                "driggsby".to_string(),
            ],
        },
    }
}

fn print_known_client_command(installer: &InstallerCommand) {
    println!("Run this command to finish setup:");
    println!("  {}", render_shell_command(installer));
}

fn print_other_mcp_config(created: &CreatedClientGrant) {
    println!("Add this MCP server to your client:");
    println!();
    println!("Command:");
    println!("  npx");
    println!();
    println!("Arguments:");
    println!("  -y");
    println!("  driggsby@latest");
    println!("  mcp-server");
    println!();
    println!("Environment:");
    println!("  {}={}", CLIENT_GRANT_ID_ENV, created.grant.grant_id);
    println!("  {}={}", CLIENT_GRANT_SECRET_ENV, created.secret);
    println!();
    println!("Revoke this client with:");
    println!(
        "  npx driggsby@latest clients revoke {}",
        created.grant.grant_id
    );
}

fn print_client_grants(secret_store: &dyn SecretStore, broker_id: &str) -> Result<()> {
    let grants = list_client_grants(secret_store, broker_id)?;
    if grants.is_empty() {
        println!("No approved clients.");
        return Ok(());
    }
    println!("Approved clients:");
    for grant in grants {
        let last_used = grant.last_used_at.as_deref().unwrap_or("never");
        println!(
            "  {}  {}  last used {}",
            grant.display_name, grant.grant_id, last_used
        );
    }
    Ok(())
}

fn print_manual_sign_in_url(sign_in_url: &str) -> Result<()> {
    println!("Your browser did not open automatically.");
    println!("Open this URL to finish connecting Driggsby:");
    println!("{sign_in_url}");
    println!();
    flush_stdout()
}

fn render_shell_command(installer: &InstallerCommand) -> String {
    std::iter::once(installer.program.as_str())
        .chain(installer.args.iter().map(String::as_str))
        .map(shell_quote)
        .collect::<Vec<_>>()
        .join(" ")
}

fn shell_quote(value: &str) -> String {
    if value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || "-_./:@=".contains(ch))
    {
        return value.to_string();
    }
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn flush_stdout() -> Result<()> {
    io::stdout().flush()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{ConnectTarget, KnownClient, build_installer_command, parse_connect_target};

    #[test]
    fn parses_known_and_other_connect_targets() {
        assert_eq!(
            parse_connect_target("claude code"),
            ConnectTarget::Known(KnownClient::ClaudeCode)
        );
        assert_eq!(
            parse_connect_target("codex"),
            ConnectTarget::Known(KnownClient::Codex)
        );
        assert_eq!(
            parse_connect_target("Raycast"),
            ConnectTarget::Other("Raycast".to_string())
        );
    }

    #[test]
    fn installer_commands_include_grant_environment() {
        let created = crate::broker::grants::CreatedClientGrant {
            grant: crate::broker::grants::BrokerClientGrant {
                schema_version: 1,
                grant_id: "lc_id".to_string(),
                display_name: "Codex".to_string(),
                integration_id: Some("codex".to_string()),
                secret_sha256: "hash".to_string(),
                created_at: "2026-04-13T00:00:00Z".to_string(),
                last_used_at: None,
                revoked_at: None,
            },
            secret: "ls_secret".to_string(),
        };

        let command = build_installer_command(KnownClient::Codex, &created);

        assert_eq!(command.program, "codex");
        assert!(command.args.contains(&"--env".to_string()));
        assert!(
            command
                .args
                .contains(&"DRIGGSBY_CLIENT_GRANT_ID=lc_id".to_string())
        );
        assert!(
            command
                .args
                .contains(&"DRIGGSBY_CLIENT_GRANT_SECRET=ls_secret".to_string())
        );
    }
}
