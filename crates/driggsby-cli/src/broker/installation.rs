use std::fs;

use crate::{
    auth::dpop::{Jwk, generate_dpop_key_material},
    json_file::{read_json_file, remove_file_if_present, write_json_file},
    runtime_paths::RuntimePaths,
};
use anyhow::Result;
use rand::Rng;

use super::{
    file_secret_store::FileSecretStore,
    remote_session::inspect_remote_session_readiness,
    secret_store::SecretStore,
    session::{
        clear_broker_remote_session, clear_broker_remote_session_snapshot,
        read_broker_remote_session, read_broker_remote_session_snapshot,
    },
    types::{
        BrokerDpopMetadata, BrokerMetadata, BrokerReadiness, BrokerRemoteAccessState, BrokerStatus,
    },
};

const LOCAL_AUTH_TOKEN_ACCOUNT_SUFFIX: &str = "local-auth-token";
const PRIVATE_KEY_ACCOUNT_SUFFIX: &str = "dpop-private-jwk";

pub async fn ensure_broker_installation(
    runtime_paths: &RuntimePaths,
    secret_store: &dyn SecretStore,
) -> Result<BrokerMetadata> {
    let readiness = inspect_broker_readiness(runtime_paths, secret_store)?;
    if readiness.installed
        && readiness.private_key_present
        && let Some(metadata) = read_broker_metadata(runtime_paths)?
    {
        return Ok(metadata);
    }

    let broker_id = uuid::Uuid::now_v7().to_string();
    let dpop = generate_dpop_key_material()?;
    let metadata = BrokerMetadata {
        schema_version: 1,
        broker_id: broker_id.clone(),
        created_at: time::OffsetDateTime::now_utc()
            .format(&time::format_description::well_known::Rfc3339)?,
        dpop: BrokerDpopMetadata {
            algorithm: dpop.algorithm.clone(),
            public_jwk: dpop.public_jwk.clone(),
            thumbprint: dpop.thumbprint.clone(),
        },
    };

    secret_store.set_secret(
        &local_auth_token_account_name(&broker_id),
        &generate_local_auth_token(),
    )?;
    secret_store.set_secret(
        &private_key_account_name(&broker_id),
        &serde_json::to_string(&dpop.private_jwk)?,
    )?;
    write_json_file(&runtime_paths.metadata_path, &metadata)?;

    Ok(metadata)
}

pub fn inspect_broker_readiness(
    runtime_paths: &RuntimePaths,
    secret_store: &dyn SecretStore,
) -> Result<BrokerReadiness> {
    let Some(metadata) = read_broker_metadata(runtime_paths)? else {
        return Ok(BrokerReadiness {
            installed: false,
            broker_id: None,
            dpop_thumbprint: None,
            local_auth_token_present: false,
            private_key_present: false,
            remote_session_present: false,
        });
    };

    let local_auth_token_present = secret_store
        .get_secret(&local_auth_token_account_name(&metadata.broker_id))?
        .is_some();
    let private_key_present = secret_store
        .get_secret(&private_key_account_name(&metadata.broker_id))?
        .is_some();
    let remote_session_present =
        read_broker_remote_session(secret_store, &metadata.broker_id)?.is_some();

    Ok(BrokerReadiness {
        installed: local_auth_token_present && private_key_present,
        broker_id: Some(metadata.broker_id.clone()),
        dpop_thumbprint: Some(metadata.dpop.thumbprint.clone()),
        local_auth_token_present,
        private_key_present,
        remote_session_present,
    })
}

pub async fn build_broker_status(
    runtime_paths: &RuntimePaths,
    secret_store: &dyn SecretStore,
    broker_running: bool,
) -> Result<BrokerStatus> {
    let readiness = inspect_broker_readiness(runtime_paths, secret_store)?;
    let remote = match &readiness.broker_id {
        Some(broker_id) => {
            inspect_remote_session_readiness(runtime_paths, secret_store, broker_id, true).await?
        }
        None => inspect_remote_session_readiness(runtime_paths, secret_store, "", false).await?,
    };

    Ok(BrokerStatus {
        installed: readiness.installed && readiness.private_key_present,
        broker_running,
        broker_id: readiness.broker_id,
        dpop_thumbprint: readiness.dpop_thumbprint,
        remote_mcp_ready: remote.ready,
        remote_access_detail: Some(remote.detail),
        remote_access_state: Some(remote.state),
        next_step_command: remote.next_step_command,
        remote_session: remote.session,
        socket_path: runtime_paths.socket_path.display().to_string(),
    })
}

pub fn resolve_broker_status_for_display(
    runtime_paths: &RuntimePaths,
    live_status: Option<BrokerStatus>,
    local_server_running: bool,
) -> Result<BrokerStatus> {
    if let Some(ref status) = live_status
        && status.remote_access_detail.is_some()
        && status.remote_access_state.is_some()
    {
        return Ok(status.clone());
    }
    build_display_status_from_local_state(runtime_paths, local_server_running)
}

pub fn clear_broker_installation(
    runtime_paths: &RuntimePaths,
    secret_store: &dyn SecretStore,
) -> Result<()> {
    if let Some(metadata) = read_broker_metadata(runtime_paths).ok().flatten() {
        clear_broker_remote_session(secret_store, &metadata.broker_id)?;
        let _ = secret_store.delete_secret(&local_auth_token_account_name(&metadata.broker_id))?;
        let _ = secret_store.delete_secret(&private_key_account_name(&metadata.broker_id))?;
    }
    clear_broker_remote_session_snapshot(runtime_paths)?;
    FileSecretStore::new(runtime_paths).clear_all_files()?;
    remove_file_if_present(&runtime_paths.metadata_path)?;
    #[cfg(not(windows))]
    remove_file_if_present(&runtime_paths.socket_path)?;
    remove_empty_directory(&runtime_paths.config_dir)?;
    remove_empty_directory(&runtime_paths.state_dir)?;
    Ok(())
}

pub fn read_broker_metadata(runtime_paths: &RuntimePaths) -> Result<Option<BrokerMetadata>> {
    read_json_file(&runtime_paths.metadata_path)
}

pub fn read_broker_local_auth_token(
    secret_store: &dyn SecretStore,
    broker_id: &str,
) -> Result<Option<String>> {
    secret_store.get_secret(&local_auth_token_account_name(broker_id))
}

pub fn read_broker_private_jwk(
    secret_store: &dyn SecretStore,
    broker_id: &str,
) -> Result<Option<String>> {
    secret_store.get_secret(&private_key_account_name(broker_id))
}

pub fn read_broker_dpop_key_pair(
    runtime_paths: &RuntimePaths,
    secret_store: &dyn SecretStore,
    broker_id: &str,
) -> Result<Option<BrokerDpopKeyPair>> {
    let Some(metadata) = read_broker_metadata(runtime_paths)? else {
        return Ok(None);
    };
    if metadata.broker_id != broker_id {
        return Ok(None);
    }
    let Some(private_jwk) = read_broker_private_jwk(secret_store, broker_id)? else {
        return Ok(None);
    };
    Ok(Some(BrokerDpopKeyPair {
        private_jwk: serde_json::from_str(&private_jwk)?,
        public_jwk: metadata.dpop.public_jwk,
    }))
}

#[derive(Debug, Clone)]
pub struct BrokerDpopKeyPair {
    pub private_jwk: Jwk,
    pub public_jwk: Jwk,
}

fn generate_local_auth_token() -> String {
    let mut bytes = [0_u8; 16];
    rand::rng().fill_bytes(&mut bytes);
    let mut rendered = String::with_capacity(bytes.len() * 2);
    for byte in &bytes {
        use std::fmt::Write as _;
        let _ = write!(rendered, "{byte:02x}");
    }
    rendered
}

fn local_auth_token_account_name(broker_id: &str) -> String {
    format!("driggsby__{broker_id}__{LOCAL_AUTH_TOKEN_ACCOUNT_SUFFIX}")
}

fn private_key_account_name(broker_id: &str) -> String {
    format!("driggsby__{broker_id}__{PRIVATE_KEY_ACCOUNT_SUFFIX}")
}

fn build_display_status_from_local_state(
    runtime_paths: &RuntimePaths,
    local_server_running: bool,
) -> Result<BrokerStatus> {
    let metadata = read_broker_metadata(runtime_paths)?;
    let snapshot = read_broker_remote_session_snapshot(runtime_paths)?;
    let remote_session = snapshot.map(|stored| stored.session);
    let (remote_mcp_ready, remote_access_state, remote_access_detail, next_step_command) =
        match remote_session.as_ref() {
            None => (
                false,
                BrokerRemoteAccessState::NotConnected,
                "The CLI does not have a saved session yet.".to_string(),
                Some("npx driggsby@latest login".to_string()),
            ),
            Some(session) if session_has_comfortable_headroom(session.access_token_expires_at.as_str()) => (
                true,
                BrokerRemoteAccessState::Ready,
                "The CLI is connected and remote MCP access is ready to use.".to_string(),
                None,
            ),
            Some(_) => (
                false,
                BrokerRemoteAccessState::TemporarilyUnavailable,
                "The CLI has a saved session. The next MCP launch will refresh it automatically before forwarding runs.".to_string(),
                Some("npx -y driggsby@latest mcp-server".to_string()),
            ),
        };

    Ok(BrokerStatus {
        installed: metadata.is_some(),
        broker_running: local_server_running,
        broker_id: metadata.as_ref().map(|value| value.broker_id.clone()),
        dpop_thumbprint: metadata.as_ref().map(|value| value.dpop.thumbprint.clone()),
        remote_mcp_ready,
        remote_access_detail: Some(remote_access_detail),
        remote_access_state: Some(remote_access_state),
        next_step_command,
        remote_session,
        socket_path: runtime_paths.socket_path.display().to_string(),
    })
}

fn session_has_comfortable_headroom(expires_at: &str) -> bool {
    let Ok(expires_at) =
        time::OffsetDateTime::parse(expires_at, &time::format_description::well_known::Rfc3339)
    else {
        return false;
    };

    let remaining_seconds = (expires_at - time::OffsetDateTime::now_utc()).whole_seconds();
    remaining_seconds > 60
}

fn remove_empty_directory(path: &std::path::Path) -> Result<()> {
    match fs::remove_dir(path) {
        Ok(()) => Ok(()),
        Err(error)
            if error.kind() == std::io::ErrorKind::NotFound
                || error.kind() == std::io::ErrorKind::DirectoryNotEmpty =>
        {
            Ok(())
        }
        Err(error) => Err(error.into()),
    }
}
