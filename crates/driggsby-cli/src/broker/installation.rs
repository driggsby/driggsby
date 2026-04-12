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
    secret_store::SecretStore,
    secrets::{BrokerSecrets, clear_broker_secrets, read_broker_secrets, write_broker_secrets},
    session::{clear_broker_remote_session_snapshot, read_broker_remote_session_snapshot},
    types::{BrokerDpopMetadata, BrokerMetadata, BrokerRemoteAccessState, BrokerStatus},
};

pub async fn ensure_broker_installation(
    runtime_paths: &RuntimePaths,
    secret_store: &dyn SecretStore,
) -> Result<BrokerInstallation> {
    if let Some(installation) = read_broker_installation(runtime_paths, secret_store)? {
        return Ok(installation);
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
    let secrets = BrokerSecrets::new(generate_local_auth_token(), dpop.private_jwk);

    write_broker_secrets(secret_store, &broker_id, &secrets)?;
    if let Err(error) = write_json_file(&runtime_paths.metadata_path, &metadata) {
        let _ = clear_broker_secrets(secret_store, &broker_id);
        return Err(error);
    }

    Ok(BrokerInstallation { metadata, secrets })
}

pub fn read_broker_installation(
    runtime_paths: &RuntimePaths,
    secret_store: &dyn SecretStore,
) -> Result<Option<BrokerInstallation>> {
    let Some(metadata) = read_broker_metadata(runtime_paths)? else {
        return Ok(None);
    };
    let Some(secrets) = read_broker_secrets(secret_store, &metadata.broker_id)? else {
        return Ok(None);
    };
    Ok(Some(BrokerInstallation { metadata, secrets }))
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
) -> Result<ClearBrokerInstallationResult> {
    let mut platform_secret_delete_failed = false;
    if let Some(metadata) = read_broker_metadata(runtime_paths).ok().flatten()
        && clear_broker_secrets(secret_store, &metadata.broker_id).is_err()
    {
        platform_secret_delete_failed = true;
    }
    clear_broker_remote_session_snapshot(runtime_paths)?;
    FileSecretStore::new(runtime_paths).clear_all_files()?;
    remove_file_if_present(&runtime_paths.metadata_path)?;
    #[cfg(not(windows))]
    remove_file_if_present(&runtime_paths.socket_path)?;
    remove_empty_directory(&runtime_paths.config_dir)?;
    remove_empty_directory(&runtime_paths.state_dir)?;
    Ok(ClearBrokerInstallationResult {
        platform_secret_delete_failed,
    })
}

#[derive(Debug, Clone, Copy)]
pub struct ClearBrokerInstallationResult {
    pub platform_secret_delete_failed: bool,
}

pub fn read_broker_metadata(runtime_paths: &RuntimePaths) -> Result<Option<BrokerMetadata>> {
    read_json_file(&runtime_paths.metadata_path)
}

pub fn read_broker_local_auth_token(
    secret_store: &dyn SecretStore,
    broker_id: &str,
) -> Result<Option<String>> {
    Ok(read_broker_secrets(secret_store, broker_id)?.map(|secrets| secrets.local_auth_token()))
}

pub fn read_broker_dpop_key_pair(
    runtime_paths: &RuntimePaths,
    secret_store: &dyn SecretStore,
    broker_id: &str,
) -> Result<Option<BrokerDpopKeyPair>> {
    let Some(installation) = read_broker_installation(runtime_paths, secret_store)? else {
        return Ok(None);
    };
    if installation.metadata.broker_id != broker_id {
        return Ok(None);
    }
    Ok(Some(installation.dpop_key_pair()))
}

#[derive(Clone)]
pub struct BrokerInstallation {
    pub metadata: BrokerMetadata,
    secrets: BrokerSecrets,
}

impl BrokerInstallation {
    pub fn broker_id(&self) -> &str {
        &self.metadata.broker_id
    }

    pub fn dpop_key_pair(&self) -> BrokerDpopKeyPair {
        BrokerDpopKeyPair {
            private_jwk: self.secrets.dpop_private_jwk(),
            public_jwk: self.metadata.dpop.public_jwk.clone(),
        }
    }

    pub fn dpop_thumbprint(&self) -> &str {
        &self.metadata.dpop.thumbprint
    }

    pub fn local_auth_token(&self) -> String {
        self.secrets.local_auth_token()
    }

    pub fn remote_session(&self) -> Option<super::session::BrokerRemoteSession> {
        self.secrets.remote_session()
    }

    pub fn set_remote_session(&mut self, session: super::session::BrokerRemoteSession) {
        self.secrets.set_remote_session(Some(session));
    }
}

pub fn write_broker_installation_secrets(
    secret_store: &dyn SecretStore,
    installation: &BrokerInstallation,
) -> Result<()> {
    write_broker_secrets(
        secret_store,
        installation.broker_id(),
        &installation.secrets,
    )
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
                "The CLI is not signed in to Driggsby yet.".to_string(),
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
                "Driggsby access will refresh automatically before the next MCP request is forwarded.".to_string(),
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
