use anyhow::{Result, bail};

use crate::runtime_paths::RuntimePaths;

use super::{
    file_secret_store::FileSecretStore, installation::read_broker_metadata,
    keyring_secret_store::KeyringSecretStore, secret_store::SecretStore,
};

const KEYRING_UNAVAILABLE_WITH_EXISTING_INSTALL_MESSAGE: &str = "This Driggsby CLI install already depends on platform secure storage, but that storage is unavailable in this shell. Reopen the original desktop session or restore keyring access before using this install.";
const LOGOUT_FALLBACK_NOTICE: &str = "Platform secure storage is unavailable here, so logout will clear local CLI files only. Any unreachable platform-keyring entries will remain until you return to the original session.";

pub struct ResolvedSecretStore {
    pub backend: &'static str,
    pub notice: Option<String>,
    pub store: Box<dyn SecretStore>,
}

pub fn resolve_secret_store(runtime_paths: &RuntimePaths) -> Result<ResolvedSecretStore> {
    let file_store = FileSecretStore::new(runtime_paths);
    if file_store.has_stored_secrets()? {
        return Ok(ResolvedSecretStore {
            backend: "file",
            notice: None,
            store: Box::new(file_store),
        });
    }

    let keyring_store = KeyringSecretStore::default();
    if keyring_store.is_available() {
        return Ok(ResolvedSecretStore {
            backend: "keyring",
            notice: None,
            store: Box::new(keyring_store),
        });
    }

    if read_broker_metadata(runtime_paths)?.is_some() {
        bail!(KEYRING_UNAVAILABLE_WITH_EXISTING_INSTALL_MESSAGE);
    }

    Ok(ResolvedSecretStore {
        backend: "file",
        notice: Some(format!(
            "Platform secure storage is unavailable here. Driggsby will use an owner-only file-backed secret store under {}.",
            runtime_paths.config_dir.display()
        )),
        store: Box::new(file_store),
    })
}

pub fn resolve_secret_store_for_logout(
    runtime_paths: &RuntimePaths,
) -> Result<ResolvedSecretStore> {
    match resolve_secret_store(runtime_paths) {
        Ok(store) => Ok(store),
        Err(_) => Ok(ResolvedSecretStore {
            backend: "file",
            notice: Some(LOGOUT_FALLBACK_NOTICE.to_string()),
            store: Box::new(FileSecretStore::new(runtime_paths)),
        }),
    }
}
