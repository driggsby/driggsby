use anyhow::Result;

use super::url_security::assert_broker_remote_url;

const DEFAULT_REMOTE_BASE_URL: &str = "https://app.driggsby.com";
const DEFAULT_SCOPE: &str = "driggsby.default";
const DEFAULT_LOGIN_TIMEOUT_MS: u64 = 5 * 60 * 1_000;
const DEFAULT_CLIENT_NAME: &str = "Driggsby CLI";

#[derive(Debug, Clone)]
pub struct BrokerAuthConfig {
    pub client_name: String,
    pub login_timeout_ms: u64,
    pub protected_resource_metadata_url: String,
    pub requested_scope: String,
    pub remote_base_url: String,
}

pub fn resolve_broker_auth_config() -> Result<BrokerAuthConfig> {
    let remote_base_url = std::env::var("DRIGGSBY_REMOTE_BASE_URL")
        .unwrap_or_else(|_| DEFAULT_REMOTE_BASE_URL.to_string());
    let remote_base_url = normalize_base_url(&remote_base_url)?;

    Ok(BrokerAuthConfig {
        protected_resource_metadata_url: format!(
            "{remote_base_url}/.well-known/oauth-protected-resource"
        ),
        client_name: DEFAULT_CLIENT_NAME.to_string(),
        login_timeout_ms: DEFAULT_LOGIN_TIMEOUT_MS,
        requested_scope: DEFAULT_SCOPE.to_string(),
        remote_base_url,
    })
}

fn normalize_base_url(raw_value: &str) -> Result<String> {
    let mut parsed = url::Url::parse(raw_value)?;
    assert_broker_remote_url(parsed.as_str(), "The Driggsby remote base URL")?;
    parsed.set_path("");
    parsed.set_query(None);
    parsed.set_fragment(None);
    Ok(parsed.as_str().trim_end_matches('/').to_string())
}
