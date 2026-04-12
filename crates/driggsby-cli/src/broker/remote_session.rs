use anyhow::Result;

use crate::auth::{
    discovery::fetch_authorization_server_metadata, dpop::create_dpop_proof,
    oauth::refresh_access_token,
};

use super::{public_error::PublicBrokerError, session::BrokerRemoteSession};

const ACCESS_TOKEN_REFRESH_SKEW_MS: i128 = 60_000;

pub fn session_needs_refresh(session: &BrokerRemoteSession) -> bool {
    let expires_at = time::OffsetDateTime::parse(
        &session.access_token_expires_at,
        &time::format_description::well_known::Rfc3339,
    )
    .ok();
    let Some(expires_at) = expires_at else {
        return true;
    };
    let remaining_ms = (expires_at - time::OffsetDateTime::now_utc()).whole_milliseconds();
    remaining_ms <= ACCESS_TOKEN_REFRESH_SKEW_MS
}

pub async fn refresh_remote_session(
    session: &BrokerRemoteSession,
    dpop_key_pair: &super::installation::BrokerDpopKeyPair,
    resource_url: &str,
) -> Result<BrokerRemoteSession> {
    let metadata = fetch_authorization_server_metadata(&session.issuer).await.map_err(|_| {
        PublicBrokerError::new(
            "Driggsby could not refresh the local CLI session right now because it could not reach the authorization server. Wait a moment and try again."
        )
    })?;
    let dpop_proof = create_dpop_proof(
        &dpop_key_pair.private_jwk,
        &dpop_key_pair.public_jwk,
        "POST",
        &metadata.token_endpoint,
        None,
    )?;
    let refreshed = refresh_access_token(
        &metadata,
        &session.client_id,
        &session.refresh_token,
        resource_url,
        &dpop_proof,
    )
    .await?;
    let updated = BrokerRemoteSession {
        access_token: refreshed.access_token,
        access_token_expires_at: refreshed.access_token_expires_at,
        refresh_token: refreshed.refresh_token,
        scope: refreshed.scope,
        token_type: refreshed.token_type,
        ..session.clone()
    };
    Ok(updated)
}
