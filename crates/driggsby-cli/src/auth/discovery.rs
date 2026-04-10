use anyhow::{Result, bail};
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct ProtectedResourceMetadata {
    pub authorization_server: String,
    pub authorization_servers: Vec<String>,
    pub resource: String,
    pub scopes_supported: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AuthorizationServerMetadata {
    pub authorization_endpoint: String,
    pub code_challenge_methods_supported: Vec<String>,
    pub dpop_signing_alg_values_supported: Vec<String>,
    pub grant_types_supported: Vec<String>,
    pub issuer: String,
    pub registration_endpoint: String,
    pub response_types_supported: Vec<String>,
    pub scopes_supported: Vec<String>,
    pub token_endpoint: String,
    pub token_endpoint_auth_methods_supported: Vec<String>,
}

pub async fn fetch_protected_resource_metadata(url: &str) -> Result<ProtectedResourceMetadata> {
    let response = reqwest::Client::new()
        .get(url)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await?;
    if !response.status().is_success() {
        bail!("Driggsby sign-in could not load the protected-resource metadata.");
    }
    Ok(response.json().await?)
}

pub async fn fetch_authorization_server_metadata(
    issuer: &str,
) -> Result<AuthorizationServerMetadata> {
    let url = format!(
        "{}/.well-known/oauth-authorization-server",
        issuer.trim_end_matches('/')
    );
    let response = reqwest::Client::new()
        .get(&url)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await?;
    if !response.status().is_success() {
        bail!("Driggsby sign-in could not load the authorization-server metadata.");
    }
    Ok(response.json().await?)
}
