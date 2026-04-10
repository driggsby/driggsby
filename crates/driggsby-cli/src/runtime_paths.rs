use std::{
    env, fs,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, bail};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimePaths {
    pub config_dir: PathBuf,
    pub state_dir: PathBuf,
    pub metadata_path: PathBuf,
    pub session_snapshot_path: PathBuf,
    pub socket_path: PathBuf,
    pub lock_path: PathBuf,
}

pub fn resolve_runtime_paths(allow_env_overrides: bool) -> Result<RuntimePaths> {
    let home_dir = home_dir()?;
    let username = username()?;

    let config_dir = if allow_env_overrides {
        env::var_os("DRIGGSBY_CONFIG_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| default_config_dir(&home_dir))
    } else {
        default_config_dir(&home_dir)
    };
    let state_dir = if allow_env_overrides {
        env::var_os("DRIGGSBY_STATE_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| default_state_dir(&home_dir))
    } else {
        default_state_dir(&home_dir)
    };

    Ok(RuntimePaths {
        metadata_path: config_dir.join("cli-metadata.json"),
        session_snapshot_path: config_dir.join("cli-session.json"),
        socket_path: default_socket_path(&state_dir, &username),
        lock_path: state_dir.join("cli.lock"),
        config_dir,
        state_dir,
    })
}

pub fn ensure_runtime_directories(runtime_paths: &RuntimePaths) -> Result<()> {
    create_owner_only_directory(&runtime_paths.config_dir)?;
    create_owner_only_directory(&runtime_paths.state_dir)?;
    Ok(())
}

fn create_owner_only_directory(path: &Path) -> Result<()> {
    fs::create_dir_all(path)
        .with_context(|| format!("Could not create runtime directory at {}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).with_context(|| {
            format!(
                "Could not apply secure permissions to runtime directory at {}",
                path.display()
            )
        })?;
    }
    Ok(())
}

fn home_dir() -> Result<PathBuf> {
    env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| env::var_os("USERPROFILE").map(PathBuf::from))
        .context("Driggsby could not determine the current home directory.")
}

fn username() -> Result<String> {
    for key in ["USER", "USERNAME"] {
        if let Some(value) = env::var_os(key) {
            let value = value.to_string_lossy().trim().to_string();
            if !value.is_empty() {
                return Ok(value);
            }
        }
    }

    bail!("Driggsby could not determine the current username.")
}

fn default_config_dir(home_dir: &Path) -> PathBuf {
    if cfg!(target_os = "macos") {
        return home_dir
            .join("Library")
            .join("Application Support")
            .join("driggsby");
    }
    if cfg!(windows) {
        return env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home_dir.join("AppData").join("Roaming"))
            .join("Driggsby");
    }

    env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir.join(".config"))
        .join("driggsby")
}

fn default_state_dir(home_dir: &Path) -> PathBuf {
    if cfg!(target_os = "macos") {
        return home_dir
            .join("Library")
            .join("Application Support")
            .join("driggsby");
    }
    if cfg!(windows) {
        return env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home_dir.join("AppData").join("Local"))
            .join("Driggsby");
    }

    env::var_os("XDG_STATE_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir.join(".local").join("state"))
        .join("driggsby")
}

fn default_socket_path(state_dir: &Path, username: &str) -> PathBuf {
    if cfg!(windows) {
        let mut hash = Sha256::new();
        hash.update(username.as_bytes());
        let digest = hex_string(&hash.finalize());
        return PathBuf::from(format!(r"\\.\pipe\driggsby-cli-{}", &digest[..16]));
    }

    state_dir.join("cli.sock")
}

fn hex_string(bytes: &[u8]) -> String {
    let mut rendered = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(rendered, "{byte:02x}");
    }
    rendered
}

#[cfg(test)]
mod tests {
    use super::hex_string;

    #[test]
    fn hex_string_renders_lowercase_hex() {
        assert_eq!(hex_string(&[0xab, 0xcd, 0x09]), "abcd09");
    }
}
