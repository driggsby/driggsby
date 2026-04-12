use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};

use crate::auth::dpop::Jwk;

use super::{secret_store::SecretStore, session::BrokerRemoteSession};

const BROKER_SECRETS_ACCOUNT_SUFFIX: &str = "broker-secrets";
const BROKER_SECRETS_INVALID_MESSAGE: &str = "The local Driggsby secure storage record is invalid. Run npx driggsby@latest logout and then npx driggsby@latest login.";
const BROKER_SECRETS_SCHEMA_VERSION: u8 = 1;

#[derive(Clone, Serialize, Deserialize)]
pub struct BrokerSecrets {
    schema_version: u8,
    local_auth_token: String,
    dpop_private_jwk: Jwk,
    #[serde(skip_serializing_if = "Option::is_none")]
    remote_session: Option<BrokerRemoteSession>,
}

impl BrokerSecrets {
    pub fn new(local_auth_token: String, dpop_private_jwk: Jwk) -> Self {
        Self {
            schema_version: BROKER_SECRETS_SCHEMA_VERSION,
            local_auth_token,
            dpop_private_jwk,
            remote_session: None,
        }
    }

    pub fn dpop_private_jwk(&self) -> Jwk {
        self.dpop_private_jwk.clone()
    }

    pub fn local_auth_token(&self) -> String {
        self.local_auth_token.clone()
    }

    pub fn remote_session(&self) -> Option<BrokerRemoteSession> {
        self.remote_session.clone()
    }

    pub fn set_remote_session(&mut self, session: Option<BrokerRemoteSession>) {
        self.remote_session = session;
    }
}

pub fn read_broker_secrets(
    secret_store: &dyn SecretStore,
    broker_id: &str,
) -> Result<Option<BrokerSecrets>> {
    let Some(raw) = secret_store.get_secret(&broker_secrets_account_name(broker_id))? else {
        return Ok(None);
    };
    let secrets: BrokerSecrets =
        serde_json::from_str(&raw).map_err(|_| anyhow::anyhow!(BROKER_SECRETS_INVALID_MESSAGE))?;
    if secrets.schema_version != BROKER_SECRETS_SCHEMA_VERSION {
        bail!(BROKER_SECRETS_INVALID_MESSAGE);
    }
    Ok(Some(secrets))
}

pub fn write_broker_secrets(
    secret_store: &dyn SecretStore,
    broker_id: &str,
    secrets: &BrokerSecrets,
) -> Result<()> {
    secret_store.set_secret(
        &broker_secrets_account_name(broker_id),
        &serde_json::to_string(secrets)?,
    )
}

pub fn clear_broker_secrets(secret_store: &dyn SecretStore, broker_id: &str) -> Result<()> {
    let _ = secret_store.delete_secret(&broker_secrets_account_name(broker_id))?;
    Ok(())
}

fn broker_secrets_account_name(broker_id: &str) -> String {
    format!("driggsby__{broker_id}__{BROKER_SECRETS_ACCOUNT_SUFFIX}")
}

#[cfg(test)]
mod tests {
    use anyhow::Result;

    use super::{BrokerSecrets, broker_secrets_account_name, read_broker_secrets};
    use crate::{
        auth::dpop::Jwk,
        broker::{file_secret_store::FileSecretStore, secret_store::SecretStore},
        runtime_paths::RuntimePaths,
    };

    #[test]
    fn broker_secrets_use_one_stable_account_name() -> Result<()> {
        let temp_dir = tempfile::tempdir()?;
        let runtime_paths = test_runtime_paths(&temp_dir);
        let store = FileSecretStore::new(&runtime_paths);
        let broker_id = "019d754f-2ca2-73b0-bf51-3c689d49c469";
        let secrets = BrokerSecrets::new("local-token".to_string(), test_jwk());

        super::write_broker_secrets(&store, broker_id, &secrets)?;

        let account = broker_secrets_account_name(broker_id);
        assert!(store.has_stored_secrets()?);
        assert!(store.get_secret(&account)?.is_some());
        assert_eq!(
            read_broker_secrets(&store, broker_id)?
                .map(|stored| stored.local_auth_token())
                .as_deref(),
            Some("local-token")
        );
        Ok(())
    }

    fn test_runtime_paths(temp_dir: &tempfile::TempDir) -> RuntimePaths {
        let config_dir = temp_dir.path().join("config");
        let state_dir = temp_dir.path().join("state");
        RuntimePaths {
            metadata_path: config_dir.join("cli-metadata.json"),
            session_snapshot_path: config_dir.join("cli-session.json"),
            socket_path: state_dir.join("cli.sock"),
            lock_path: state_dir.join("cli.lock"),
            config_dir,
            state_dir,
        }
    }

    fn test_jwk() -> Jwk {
        Jwk {
            kty: "EC".to_string(),
            crv: "P-256".to_string(),
            x: "x".to_string(),
            y: "y".to_string(),
            d: Some("d".to_string()),
        }
    }
}
