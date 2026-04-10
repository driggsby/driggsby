use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::{
    json_file::{read_json_file, remove_file_if_present, write_json_file},
    runtime_paths::RuntimePaths,
};

use super::secret_store::SecretStore;

const REMOTE_SESSION_ACCOUNT_SUFFIX: &str = "remote-session";
const SESSION_SNAPSHOT_SCHEMA_VERSION: u8 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrokerRemoteSession {
    pub schema_version: u8,
    pub access_token: String,
    pub access_token_expires_at: String,
    pub authenticated_at: String,
    pub client_id: String,
    pub issuer: String,
    pub redirect_uri: String,
    pub refresh_token: String,
    pub resource: String,
    pub scope: String,
    pub token_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrokerRemoteSessionSummary {
    pub access_token_expires_at: String,
    pub authenticated_at: String,
    pub client_id: String,
    pub issuer: String,
    pub resource: String,
    pub scope: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrokerRemoteSessionSnapshot {
    pub schema_version: u8,
    pub session: BrokerRemoteSessionSummary,
}

pub fn read_broker_remote_session(
    secret_store: &dyn SecretStore,
    broker_id: &str,
) -> Result<Option<BrokerRemoteSession>> {
    match secret_store.get_secret(&remote_session_account_name(broker_id))? {
        Some(raw) => {
            let mut parsed: BrokerRemoteSession = serde_json::from_str(&raw)?;
            if parsed.token_type.is_empty() {
                parsed.token_type = "Bearer".to_string();
            }
            Ok(Some(parsed))
        }
        None => Ok(None),
    }
}

pub fn write_broker_remote_session(
    secret_store: &dyn SecretStore,
    broker_id: &str,
    session: &BrokerRemoteSession,
) -> Result<()> {
    secret_store.set_secret(
        &remote_session_account_name(broker_id),
        &serde_json::to_string(session)?,
    )
}

pub fn clear_broker_remote_session(secret_store: &dyn SecretStore, broker_id: &str) -> Result<()> {
    let _ = secret_store.delete_secret(&remote_session_account_name(broker_id))?;
    Ok(())
}

pub fn read_broker_remote_session_snapshot(
    runtime_paths: &RuntimePaths,
) -> Result<Option<BrokerRemoteSessionSnapshot>> {
    read_json_file(&runtime_paths.session_snapshot_path)
}

pub fn write_broker_remote_session_snapshot(
    runtime_paths: &RuntimePaths,
    session: &BrokerRemoteSession,
) -> Result<()> {
    write_json_file(
        &runtime_paths.session_snapshot_path,
        &BrokerRemoteSessionSnapshot {
            schema_version: SESSION_SNAPSHOT_SCHEMA_VERSION,
            session: summarize_broker_remote_session(session),
        },
    )
}

pub fn clear_broker_remote_session_snapshot(runtime_paths: &RuntimePaths) -> Result<()> {
    remove_file_if_present(&runtime_paths.session_snapshot_path)
}

pub fn summarize_broker_remote_session(
    session: &BrokerRemoteSession,
) -> BrokerRemoteSessionSummary {
    BrokerRemoteSessionSummary {
        access_token_expires_at: session.access_token_expires_at.clone(),
        authenticated_at: session.authenticated_at.clone(),
        client_id: session.client_id.clone(),
        issuer: session.issuer.clone(),
        resource: session.resource.clone(),
        scope: session.scope.clone(),
    }
}

fn remote_session_account_name(broker_id: &str) -> String {
    format!("driggsby__{broker_id}__{REMOTE_SESSION_ACCOUNT_SUFFIX}")
}
