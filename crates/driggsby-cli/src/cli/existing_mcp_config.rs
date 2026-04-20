use std::process::Output;

use crate::cli::{
    McpScope,
    connect::run_config_command,
    known_client::KnownClient,
    supported_mcp_config::{
        CliMcpClient, DRIGGSBY_MCP_URL, McpConfigCommand, build_inspector_command,
        build_scoped_remover_command, render_shell_command,
    },
};

type StepLines = &'static [&'static str];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ExistingMcpConfig {
    Missing,
    Matches,
    Differs,
    Unknown,
}

pub(super) async fn handle_existing_config(
    client: KnownClient,
    cli_client: CliMcpClient,
    mcp_scope: Option<McpScope>,
    installer: &McpConfigCommand,
) -> anyhow::Result<bool> {
    let inspector = build_inspector_command(cli_client);

    let Ok(Ok(output)) = run_config_command(&inspector, false).await else {
        return Ok(false);
    };

    match classify_existing_mcp_config(cli_client, mcp_scope, &output) {
        ExistingMcpConfig::Matches => {
            print_already_setup(client);
            Ok(true)
        }
        ExistingMcpConfig::Differs => {
            print_existing_config_differs(client, cli_client, mcp_scope, installer);
            Ok(true)
        }
        ExistingMcpConfig::Missing | ExistingMcpConfig::Unknown => Ok(false),
    }
}

pub(super) fn print_existing_config_differs(
    client: KnownClient,
    cli_client: CliMcpClient,
    mcp_scope: Option<McpScope>,
    installer: &McpConfigCommand,
) {
    let remover = build_scoped_remover_command(cli_client, mcp_scope);

    println!(
        "Driggsby already exists in {} MCP config, but it does not match the expected Driggsby setup.",
        client.display_name()
    );
    println!();
    println!("Expected Driggsby MCP URL:");
    println!("  {DRIGGSBY_MCP_URL}");
    println!();
    println!("To replace the existing entry, run:");
    println!("  {}", render_shell_command(&remover));
    println!("  {}", render_shell_command(installer));
}

fn print_already_setup(client: KnownClient) {
    println!(
        "Driggsby is already set up in {} MCP config.",
        client.display_name()
    );
    println!();
    println!("Driggsby MCP URL:");
    println!("  {DRIGGSBY_MCP_URL}");
    println!();
    println!("Next:");
    for line in already_setup_next_step_lines(client) {
        println!("{line}");
    }
}

fn already_setup_next_step_lines(client: KnownClient) -> StepLines {
    match client {
        KnownClient::ClaudeCode => {
            &["  Open Claude Code, run /mcp, and authenticate Driggsby if prompted."]
        }
        KnownClient::Codex => &[
            "  Open Codex and ask it to use Driggsby.",
            "  If Codex asks you to sign in, run:",
            "    codex mcp login driggsby",
        ],
        KnownClient::Other => &[],
    }
}

pub(super) fn classify_existing_mcp_config(
    client: CliMcpClient,
    scope: Option<McpScope>,
    output: &Output,
) -> ExistingMcpConfig {
    let text = command_output_text(output);
    if !output.status.success() {
        return if reports_missing_config(&text) {
            ExistingMcpConfig::Missing
        } else {
            ExistingMcpConfig::Unknown
        };
    }

    if matches_expected_config(client, scope, &text) {
        ExistingMcpConfig::Matches
    } else {
        ExistingMcpConfig::Differs
    }
}

fn command_output_text(output: &Output) -> String {
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    format!("{stdout}\n{stderr}")
}

fn reports_missing_config(text: &str) -> bool {
    text.contains("No MCP server found")
        || text.contains("No MCP server named 'driggsby' found")
        || text.contains("No MCP server found with name")
}

fn matches_expected_config(client: CliMcpClient, scope: Option<McpScope>, text: &str) -> bool {
    match client {
        CliMcpClient::ClaudeCode => {
            has_line(text, "Type: http")
                && has_line(text, &format!("URL: {DRIGGSBY_MCP_URL}"))
                && has_claude_scope(text, scope.unwrap_or(McpScope::User))
        }
        CliMcpClient::Codex => {
            text.contains("\"enabled\": true")
                && text.contains("\"type\": \"streamable_http\"")
                && text.contains(&format!("\"url\": \"{DRIGGSBY_MCP_URL}\""))
        }
    }
}

fn has_claude_scope(text: &str, scope: McpScope) -> bool {
    let expected = match scope {
        McpScope::Local => "Scope: Local config",
        McpScope::User => "Scope: User config",
    };
    text.lines().any(|line| line.trim().starts_with(expected))
}

fn has_line(text: &str, expected: &str) -> bool {
    text.lines().any(|line| line.trim() == expected)
}

#[cfg(test)]
mod tests {
    use std::process::ExitStatus;

    use super::*;

    #[cfg(unix)]
    fn status(code: i32) -> ExitStatus {
        use std::os::unix::process::ExitStatusExt;
        ExitStatus::from_raw(code)
    }

    fn output(status: ExitStatus, stdout: &str, stderr: &str) -> Output {
        Output {
            status,
            stdout: stdout.as_bytes().to_vec(),
            stderr: stderr.as_bytes().to_vec(),
        }
    }

    #[cfg(unix)]
    #[test]
    fn claude_code_user_config_matches_expected_remote_mcp() {
        let output = output(
            status(0),
            "driggsby:\n  Scope: User config (available in all your projects)\n  Status: x Failed to connect\n  Type: http\n  URL: https://app.driggsby.com/mcp\n",
            "",
        );

        assert_eq!(
            classify_existing_mcp_config(CliMcpClient::ClaudeCode, None, &output),
            ExistingMcpConfig::Matches
        );
    }

    #[cfg(unix)]
    #[test]
    fn claude_code_scope_mismatch_differs() {
        let output = output(
            status(0),
            "driggsby:\n  Scope: User config (available in all your projects)\n  Type: http\n  URL: https://app.driggsby.com/mcp\n",
            "",
        );

        assert_eq!(
            classify_existing_mcp_config(CliMcpClient::ClaudeCode, Some(McpScope::Local), &output),
            ExistingMcpConfig::Differs
        );
    }

    #[cfg(unix)]
    #[test]
    fn codex_remote_config_matches_expected_remote_mcp() {
        let output = output(
            status(0),
            "{\n  \"name\": \"driggsby\",\n  \"enabled\": true,\n  \"transport\": {\n    \"type\": \"streamable_http\",\n    \"url\": \"https://app.driggsby.com/mcp\"\n  }\n}\n",
            "",
        );

        assert_eq!(
            classify_existing_mcp_config(CliMcpClient::Codex, None, &output),
            ExistingMcpConfig::Matches
        );
    }

    #[cfg(unix)]
    #[test]
    fn missing_config_is_not_a_conflict() {
        let output = output(
            status(1),
            "",
            "Error: No MCP server named 'driggsby' found.",
        );

        assert_eq!(
            classify_existing_mcp_config(CliMcpClient::Codex, None, &output),
            ExistingMcpConfig::Missing
        );
    }
}
