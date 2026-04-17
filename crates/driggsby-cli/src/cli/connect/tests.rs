use crate::cli::{McpScope, known_client::KnownClient};

#[test]
fn parses_supported_clients() -> anyhow::Result<()> {
    let cases = [
        ("claude-code", KnownClient::ClaudeCode),
        ("codex", KnownClient::Codex),
        ("other", KnownClient::Other),
    ];
    for (input, expected) in cases {
        assert_eq!(super::parse_client(input)?, expected);
    }
    Ok(())
}

#[test]
fn rejects_unsupported_clients() {
    for value in ["   ", "raycast", "claude-desktop"] {
        assert!(super::parse_client(value).is_err());
    }
}

#[test]
fn mcp_scope_is_only_supported_for_claude_code() {
    let scope = Some(McpScope::User);
    assert!(super::validate_mcp_scope(KnownClient::ClaudeCode, scope).is_ok());
    assert!(super::validate_mcp_scope(KnownClient::Codex, scope).is_err());
    assert!(super::validate_mcp_scope(KnownClient::Other, scope).is_err());
}

#[test]
fn next_steps_are_client_specific() {
    assert_eq!(
        super::next_step_lines(KnownClient::ClaudeCode, false),
        ["  Open Claude Code, run /mcp, and authenticate Driggsby to get started."]
    );
    assert_eq!(
        super::next_step_lines(KnownClient::Codex, false),
        [
            "  Complete the Driggsby sign-in in the browser window opened by Codex.",
            "  If no browser window opened, run:",
            "    codex mcp login driggsby",
        ]
    );
    assert_eq!(
        super::next_step_lines(KnownClient::Codex, true),
        ["  Open Codex and ask it to use Driggsby."]
    );
    assert_eq!(
        super::next_step_lines(KnownClient::Other, false),
        [
            "  Add a remote MCP server named driggsby.",
            "  Set its URL to https://app.driggsby.com/mcp.",
            "  Choose OAuth authentication if the client asks.",
            "  Complete the Driggsby browser sign-in when prompted.",
            "",
            "Requirement:",
            "  The MCP client must support OAuth-based MCP authentication.",
        ]
    );
}

#[test]
fn only_codex_streams_client_setup_output() {
    assert!(!super::stream_config_output(KnownClient::ClaudeCode));
    assert!(super::stream_config_output(KnownClient::Codex));
    assert!(!super::stream_config_output(KnownClient::Other));
}

#[test]
fn remote_sign_in_hint_waits_for_loopback_redirect_and_browser_failure() {
    let mut state = super::RemoteSignInHintState::default();

    assert!(!state.observe(b"Authorize by opening this URL: "));
    assert!(!state.observe(
        b"https://app.driggsby.com/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A44489%2Fcallback",
    ));
    assert!(state.observe(b"(Browser launch failed; please copy the URL above manually.)"));
}

#[test]
fn remote_sign_in_hint_prints_once() {
    let mut state = super::RemoteSignInHintState::default();

    assert!(
        state.observe(
            b"redirect_uri=http%3A%2F%2F127.0.0.1%3A44489%2Fcallback Browser launch failed",
        )
    );
    assert!(!state.observe(b"Browser launch failed"));
}

#[test]
fn remote_sign_in_hint_does_not_trigger_for_non_loopback_redirects() {
    let mut state = super::RemoteSignInHintState::default();

    assert!(
        !state.observe(b"redirect_uri=https%3A%2F%2Fexample.com%2Fcallback Browser launch failed",)
    );
}

#[cfg(unix)]
#[tokio::test]
async fn streaming_config_command_still_captures_output() -> anyhow::Result<()> {
    let command = super::McpConfigCommand {
        program: "sh".to_string(),
        args: vec![
            "-c".to_string(),
            "printf 'already exists'; printf 'No MCP server found' >&2".to_string(),
        ],
    };

    let output = super::run_config_command_inner(&command, true).await?;

    assert!(output.status.success());
    assert!(super::command_reports_existing_config(&output));
    assert!(super::command_reports_missing_config(&output));
    Ok(())
}

#[cfg(unix)]
#[test]
fn detects_codex_completed_login_output() {
    let output = std::process::Output {
        status: success_status(),
        stdout: b"Successfully logged in.".to_vec(),
        stderr: Vec::new(),
    };

    assert!(super::codex_completed_login(&output));
}

#[cfg(unix)]
fn success_status() -> std::process::ExitStatus {
    use std::os::unix::process::ExitStatusExt;
    std::process::ExitStatus::from_raw(0)
}

#[cfg(unix)]
#[tokio::test]
async fn config_command_does_not_wait_for_output_inherited_by_grandchildren() -> anyhow::Result<()>
{
    let command = super::McpConfigCommand {
        program: "sh".to_string(),
        args: vec![
            "-c".to_string(),
            "printf 'already exists'; (sleep 3) &".to_string(),
        ],
    };

    let start = std::time::Instant::now();
    let output = super::run_config_command_inner(&command, true).await?;

    assert!(start.elapsed() < std::time::Duration::from_secs(2));
    assert!(output.status.success());
    assert!(super::command_reports_existing_config(&output));
    Ok(())
}
