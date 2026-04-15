use crate::cli::McpScope;

pub(super) const DRIGGSBY_MCP_URL: &str = "https://app.driggsby.com/mcp";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum CliMcpClient {
    ClaudeCode,
    Codex,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct McpConfigCommand {
    pub program: String,
    pub args: Vec<String>,
}

pub(super) fn build_installer_command(
    client: CliMcpClient,
    scope: Option<McpScope>,
) -> McpConfigCommand {
    match client {
        CliMcpClient::ClaudeCode => {
            let mut args = vec![
                "mcp".to_string(),
                "add".to_string(),
                "--transport".to_string(),
                "http".to_string(),
            ];
            let scope = scope.unwrap_or(McpScope::User);
            args.extend([
                "-s".to_string(),
                scope.as_cli_value().to_string(),
                "driggsby".to_string(),
                DRIGGSBY_MCP_URL.to_string(),
            ]);
            McpConfigCommand {
                program: "claude".to_string(),
                args,
            }
        }
        CliMcpClient::Codex => McpConfigCommand {
            program: "codex".to_string(),
            args: vec![
                "mcp".to_string(),
                "add".to_string(),
                "driggsby".to_string(),
                "--url".to_string(),
                DRIGGSBY_MCP_URL.to_string(),
            ],
        },
    }
}

pub(super) fn build_scoped_remover_command(
    client: CliMcpClient,
    scope: Option<McpScope>,
) -> McpConfigCommand {
    match client {
        CliMcpClient::ClaudeCode => {
            let mut args = vec![
                "mcp".to_string(),
                "remove".to_string(),
                "driggsby".to_string(),
            ];
            let scope = scope.unwrap_or(McpScope::User);
            args.extend(["-s".to_string(), scope.as_cli_value().to_string()]);
            McpConfigCommand {
                program: "claude".to_string(),
                args,
            }
        }
        CliMcpClient::Codex => McpConfigCommand {
            program: "codex".to_string(),
            args: vec![
                "mcp".to_string(),
                "remove".to_string(),
                "driggsby".to_string(),
            ],
        },
    }
}

pub(super) fn render_shell_command(command: &McpConfigCommand) -> String {
    std::iter::once(command.program.as_str())
        .chain(command.args.iter().map(String::as_str))
        .map(shell_quote)
        .collect::<Vec<_>>()
        .join(" ")
}

fn shell_quote(value: &str) -> String {
    if value.bytes().all(|byte| {
        byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'/' | b'=')
    }) {
        return value.to_string();
    }
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::{
        CliMcpClient, DRIGGSBY_MCP_URL, build_installer_command, build_scoped_remover_command,
    };

    #[test]
    fn codex_installer_uses_remote_mcp_url() {
        let command = build_installer_command(CliMcpClient::Codex, None);

        assert_eq!(command.program, "codex");
        assert_eq!(
            command.args,
            ["mcp", "add", "driggsby", "--url", DRIGGSBY_MCP_URL]
        );
    }

    #[test]
    fn claude_code_installer_defaults_to_user_scope() {
        let command = build_installer_command(CliMcpClient::ClaudeCode, None);

        assert!(
            command
                .args
                .windows(2)
                .any(|values| values == ["-s", "user"])
        );
        assert!(command.args.contains(&DRIGGSBY_MCP_URL.to_string()));
    }

    #[test]
    fn claude_code_remover_defaults_to_user_scope() {
        let command = build_scoped_remover_command(CliMcpClient::ClaudeCode, None);

        assert!(
            command
                .args
                .windows(2)
                .any(|values| values == ["-s", "user"])
        );
    }
}
