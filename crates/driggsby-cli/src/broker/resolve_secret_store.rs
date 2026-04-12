use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use anyhow::{Result, bail};

use crate::runtime_paths::RuntimePaths;

use super::{
    file_secret_store::FileSecretStore,
    installation::read_broker_metadata,
    keyring_secret_store::{KeyringAvailability, KeyringSecretStore},
    secret_store::SecretStore,
};

const KEYRING_UNAVAILABLE_WITH_EXISTING_INSTALL_MESSAGE: &str = "This Driggsby CLI install already depends on platform secure storage, but that storage is unavailable in this shell. Reopen the original desktop session or restore keyring access before using this install.";
const LOGOUT_FALLBACK_NOTICE: &str = "Platform secure storage is unavailable here, so logout will clear local CLI files only. Any unreachable platform-keyring entries will remain until you return to the original session.";

pub struct ResolvedSecretStore {
    pub backend: &'static str,
    fallback: Option<ActivatedFallbackNotice>,
    pub notice: Option<String>,
    pub store: Box<dyn SecretStore>,
}

impl ResolvedSecretStore {
    pub fn activated_fallback_notice(&self) -> Option<&str> {
        let fallback = self.fallback.as_ref()?;
        fallback
            .active
            .load(Ordering::Acquire)
            .then_some(fallback.message.as_str())
    }
}

struct ActivatedFallbackNotice {
    active: Arc<AtomicBool>,
    message: String,
}

pub fn resolve_secret_store(runtime_paths: &RuntimePaths) -> Result<ResolvedSecretStore> {
    let file_store = FileSecretStore::new(runtime_paths);
    if file_store.has_stored_secrets()? {
        return Ok(ResolvedSecretStore {
            backend: "file",
            fallback: None,
            notice: None,
            store: Box::new(file_store),
        });
    }

    let keyring_store = KeyringSecretStore::default();
    let keyring_availability = keyring_store.availability();
    let prefer_keyring_for_fresh_install = keyring_store.is_preferred_for_fresh_install();
    resolve_secret_store_without_file_secrets(
        runtime_paths,
        file_store,
        keyring_availability,
        prefer_keyring_for_fresh_install,
    )
}

#[cfg(test)]
fn resolve_secret_store_with_keyring_policy(
    runtime_paths: &RuntimePaths,
    keyring_availability: KeyringAvailability,
    prefer_keyring_for_fresh_install: bool,
) -> Result<ResolvedSecretStore> {
    let file_store = FileSecretStore::new(runtime_paths);
    if file_store.has_stored_secrets()? {
        return Ok(ResolvedSecretStore {
            backend: "file",
            fallback: None,
            notice: None,
            store: Box::new(file_store),
        });
    }

    resolve_secret_store_without_file_secrets(
        runtime_paths,
        file_store,
        keyring_availability,
        prefer_keyring_for_fresh_install,
    )
}

fn resolve_secret_store_without_file_secrets(
    runtime_paths: &RuntimePaths,
    file_store: FileSecretStore,
    keyring_availability: KeyringAvailability,
    prefer_keyring_for_fresh_install: bool,
) -> Result<ResolvedSecretStore> {
    let metadata_present = read_broker_metadata(runtime_paths)?.is_some();
    if metadata_present && !matches!(keyring_availability, KeyringAvailability::Available) {
        bail!(KEYRING_UNAVAILABLE_WITH_EXISTING_INSTALL_MESSAGE);
    }

    if matches!(keyring_availability, KeyringAvailability::Available)
        && (metadata_present || prefer_keyring_for_fresh_install)
    {
        let (store, fallback): (Box<dyn SecretStore>, Option<ActivatedFallbackNotice>) =
            if metadata_present {
                (Box::new(KeyringSecretStore::default()), None)
            } else {
                let fallback_active = Arc::new(AtomicBool::new(false));
                let fallback = ActivatedFallbackNotice {
                    active: fallback_active.clone(),
                    message: fallback_notice(runtime_paths),
                };
                (
                    Box::new(FreshInstallSecretStore::new(
                        Box::new(KeyringSecretStore::default()),
                        file_store,
                        fallback_active,
                    )),
                    Some(fallback),
                )
            };
        return Ok(ResolvedSecretStore {
            backend: "keyring",
            fallback,
            notice: None,
            store,
        });
    }

    Ok(ResolvedSecretStore {
        backend: "file",
        fallback: None,
        notice: Some(fallback_notice(runtime_paths)),
        store: Box::new(file_store),
    })
}

struct FreshInstallSecretStore {
    fallback_active: Arc<AtomicBool>,
    primary_write_succeeded: AtomicBool,
    fallback: FileSecretStore,
    primary: Box<dyn SecretStore>,
}

impl FreshInstallSecretStore {
    fn new(
        primary: Box<dyn SecretStore>,
        fallback: FileSecretStore,
        fallback_active: Arc<AtomicBool>,
    ) -> Self {
        Self {
            fallback_active,
            primary_write_succeeded: AtomicBool::new(false),
            fallback,
            primary,
        }
    }
}

impl SecretStore for FreshInstallSecretStore {
    fn set_secret(&self, account: &str, secret: &str) -> Result<()> {
        if self.fallback_active.load(Ordering::Acquire) {
            return self.fallback.set_secret(account, secret);
        }
        match self.primary.set_secret(account, secret) {
            Ok(()) => {
                self.primary_write_succeeded.store(true, Ordering::Release);
                Ok(())
            }
            Err(_) if !self.primary_write_succeeded.load(Ordering::Acquire) => {
                self.fallback_active.store(true, Ordering::Release);
                self.fallback.set_secret(account, secret)
            }
            Err(error) => Err(error),
        }
    }

    fn get_secret(&self, account: &str) -> Result<Option<String>> {
        if self.fallback_active.load(Ordering::Acquire) {
            return self.fallback.get_secret(account);
        }
        self.primary.get_secret(account)
    }

    fn delete_secret(&self, account: &str) -> Result<bool> {
        if self.fallback_active.load(Ordering::Acquire) {
            return self.fallback.delete_secret(account);
        }
        self.primary.delete_secret(account)
    }
}

fn fallback_notice(runtime_paths: &RuntimePaths) -> String {
    format!(
        "Platform secure storage is unavailable here. Driggsby will use an owner-only file-backed secret store under {}.",
        runtime_paths.config_dir.display()
    )
}

pub fn resolve_secret_store_for_logout(
    runtime_paths: &RuntimePaths,
) -> Result<ResolvedSecretStore> {
    match resolve_secret_store(runtime_paths) {
        Ok(store) => Ok(store),
        Err(_) => Ok(ResolvedSecretStore {
            backend: "file",
            fallback: None,
            notice: Some(LOGOUT_FALLBACK_NOTICE.to_string()),
            store: Box::new(FileSecretStore::new(runtime_paths)),
        }),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    };

    use anyhow::Result;

    use crate::{
        auth::dpop::Jwk,
        broker::{
            file_secret_store::FileSecretStore,
            keyring_secret_store::KeyringAvailability,
            secret_store::SecretStore,
            types::{BrokerDpopMetadata, BrokerMetadata},
        },
        json_file::write_json_file,
        runtime_paths::RuntimePaths,
    };

    use super::{FreshInstallSecretStore, resolve_secret_store_with_keyring_policy};

    struct FailingSecretStore;

    impl SecretStore for FailingSecretStore {
        fn set_secret(&self, _account: &str, _secret: &str) -> Result<()> {
            anyhow::bail!("keyring unavailable")
        }

        fn get_secret(&self, _account: &str) -> Result<Option<String>> {
            anyhow::bail!("keyring unavailable")
        }

        fn delete_secret(&self, _account: &str) -> Result<bool> {
            anyhow::bail!("keyring unavailable")
        }
    }

    struct OneSuccessThenFailSecretStore {
        writes: AtomicUsize,
    }

    impl OneSuccessThenFailSecretStore {
        fn new() -> Self {
            Self {
                writes: AtomicUsize::new(0),
            }
        }
    }

    impl SecretStore for OneSuccessThenFailSecretStore {
        fn set_secret(&self, _account: &str, _secret: &str) -> Result<()> {
            if self.writes.fetch_add(1, Ordering::AcqRel) == 0 {
                return Ok(());
            }
            anyhow::bail!("keyring unavailable")
        }

        fn get_secret(&self, _account: &str) -> Result<Option<String>> {
            Ok(None)
        }

        fn delete_secret(&self, _account: &str) -> Result<bool> {
            Ok(false)
        }
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

    fn write_metadata(runtime_paths: &RuntimePaths) -> Result<()> {
        write_json_file(
            &runtime_paths.metadata_path,
            &BrokerMetadata {
                schema_version: 1,
                broker_id: "019d754f-2ca2-73b0-bf51-3c689d49c469".to_string(),
                created_at: "2026-04-10T02:15:54Z".to_string(),
                dpop: BrokerDpopMetadata {
                    algorithm: "ES256".to_string(),
                    public_jwk: Jwk {
                        kty: "EC".to_string(),
                        crv: "P-256".to_string(),
                        x: "x".to_string(),
                        y: "y".to_string(),
                        d: None,
                    },
                    thumbprint: "thumbprint".to_string(),
                },
            },
        )
    }

    #[test]
    fn fresh_install_falls_back_to_file_store_when_keyring_is_unavailable() -> Result<()> {
        let temp_dir = tempfile::tempdir()?;
        let runtime_paths = test_runtime_paths(&temp_dir);

        let resolved = resolve_secret_store_with_keyring_policy(
            &runtime_paths,
            KeyringAvailability::Unavailable,
            false,
        )?;

        assert_eq!(resolved.backend, "file");
        assert!(
            resolved
                .notice
                .as_deref()
                .is_some_and(|notice| notice.contains("Platform secure storage is unavailable"))
        );
        Ok(())
    }

    #[test]
    fn existing_install_does_not_fork_state_when_keyring_is_unavailable() -> Result<()> {
        let temp_dir = tempfile::tempdir()?;
        let runtime_paths = test_runtime_paths(&temp_dir);
        write_metadata(&runtime_paths)?;

        let error = resolve_secret_store_with_keyring_policy(
            &runtime_paths,
            KeyringAvailability::Unavailable,
            false,
        )
        .err()
        .map(|error| error.to_string());

        assert!(error.is_some_and(|message| {
            message.contains("already depends on platform secure storage")
                && message.contains("unavailable in this shell")
        }));
        Ok(())
    }

    #[test]
    fn existing_file_store_wins_over_keyring_availability() -> Result<()> {
        let temp_dir = tempfile::tempdir()?;
        let runtime_paths = test_runtime_paths(&temp_dir);
        let file_store = FileSecretStore::new(&runtime_paths);
        file_store.set_secret("account", "secret")?;

        let resolved = resolve_secret_store_with_keyring_policy(
            &runtime_paths,
            KeyringAvailability::Available,
            true,
        )?;

        assert_eq!(resolved.backend, "file");
        assert!(resolved.notice.is_none());
        Ok(())
    }

    #[test]
    fn fresh_install_uses_file_store_when_keyring_is_not_preferred() -> Result<()> {
        let temp_dir = tempfile::tempdir()?;
        let runtime_paths = test_runtime_paths(&temp_dir);

        let resolved = resolve_secret_store_with_keyring_policy(
            &runtime_paths,
            KeyringAvailability::Available,
            false,
        )?;

        assert_eq!(resolved.backend, "file");
        Ok(())
    }

    #[test]
    fn fresh_install_store_falls_back_when_first_keyring_write_fails() -> Result<()> {
        let temp_dir = tempfile::tempdir()?;
        let runtime_paths = test_runtime_paths(&temp_dir);
        let fallback_active = Arc::new(AtomicBool::new(false));
        let store = FreshInstallSecretStore::new(
            Box::new(FailingSecretStore),
            FileSecretStore::new(&runtime_paths),
            fallback_active.clone(),
        );

        store.set_secret("account", "secret")?;

        assert!(fallback_active.load(Ordering::Acquire));
        assert_eq!(store.get_secret("account")?.as_deref(), Some("secret"));
        Ok(())
    }

    #[test]
    fn fresh_install_store_does_not_fallback_after_primary_write_succeeds() -> Result<()> {
        let temp_dir = tempfile::tempdir()?;
        let runtime_paths = test_runtime_paths(&temp_dir);
        let fallback_active = Arc::new(AtomicBool::new(false));
        let store = FreshInstallSecretStore::new(
            Box::new(OneSuccessThenFailSecretStore::new()),
            FileSecretStore::new(&runtime_paths),
            fallback_active.clone(),
        );

        store.set_secret("first", "secret")?;
        let second = store.set_secret("second", "secret");

        assert!(second.is_err());
        assert!(!fallback_active.load(Ordering::Acquire));
        assert!(!FileSecretStore::new(&runtime_paths).has_stored_secrets()?);
        Ok(())
    }

    #[test]
    fn existing_install_uses_keyring_when_available_even_if_not_fresh_preferred() -> Result<()> {
        let temp_dir = tempfile::tempdir()?;
        let runtime_paths = test_runtime_paths(&temp_dir);
        write_metadata(&runtime_paths)?;

        let resolved = resolve_secret_store_with_keyring_policy(
            &runtime_paths,
            KeyringAvailability::Available,
            false,
        )?;

        assert_eq!(resolved.backend, "keyring");
        Ok(())
    }
}
