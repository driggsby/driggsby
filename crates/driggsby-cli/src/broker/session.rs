use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::{
    json_file::{read_json_file, remove_file_if_present, write_json_file},
    runtime_paths::RuntimePaths,
};

use super::{
    secret_store::SecretStore,
    secrets::{read_broker_secrets, write_broker_secrets},
};

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
    let Some(secrets) = read_broker_secrets(secret_store, broker_id)? else {
        return Ok(None);
    };
    let Some(mut session) = secrets.remote_session() else {
        return Ok(None);
    };
    if session.token_type.is_empty() {
        session.token_type = "Bearer".to_string();
    }
    Ok(Some(session))
}

pub fn write_broker_remote_session(
    secret_store: &dyn SecretStore,
    broker_id: &str,
    session: &BrokerRemoteSession,
) -> Result<()> {
    let mut secrets = read_broker_secrets(secret_store, broker_id)?.ok_or_else(|| {
        anyhow::anyhow!("The local Driggsby secure storage record is incomplete.")
    })?;
    secrets.set_remote_session(Some(session.clone()));
    write_broker_secrets(secret_store, broker_id, &secrets)
}

pub fn clear_broker_remote_session(secret_store: &dyn SecretStore, broker_id: &str) -> Result<()> {
    if let Some(mut secrets) = read_broker_secrets(secret_store, broker_id)? {
        secrets.set_remote_session(None);
        write_broker_secrets(secret_store, broker_id, &secrets)?;
    }
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
    resource: &str,
) -> Result<()> {
    write_json_file(
        &runtime_paths.session_snapshot_path,
        &BrokerRemoteSessionSnapshot {
            schema_version: SESSION_SNAPSHOT_SCHEMA_VERSION,
            session: summarize_broker_remote_session(session, resource),
        },
    )
}

pub fn clear_broker_remote_session_snapshot(runtime_paths: &RuntimePaths) -> Result<()> {
    remove_file_if_present(&runtime_paths.session_snapshot_path)
}

pub fn summarize_broker_remote_session(
    session: &BrokerRemoteSession,
    resource: &str,
) -> BrokerRemoteSessionSummary {
    BrokerRemoteSessionSummary {
        access_token_expires_at: session.access_token_expires_at.clone(),
        authenticated_at: session.authenticated_at.clone(),
        client_id: session.client_id.clone(),
        issuer: session.issuer.clone(),
        resource: resource.to_string(),
        scope: session.scope.clone(),
    }
}
