use std::{
    fs,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result};
use serde::{Serialize, de::DeserializeOwned};

pub fn read_json_file<T: DeserializeOwned>(path: &Path) -> Result<Option<T>> {
    match fs::read_to_string(path) {
        Ok(contents) => Ok(Some(serde_json::from_str(&contents).with_context(
            || format!("Could not parse JSON file at {}", path.display()),
        )?)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => {
            Err(error).with_context(|| format!("Could not read JSON file at {}", path.display()))
        }
    }
}

pub fn write_json_file<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let temp_path = temporary_path(path);
    let contents = serde_json::to_string_pretty(value)?;

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&temp_path, format!("{contents}\n")).with_context(|| {
        format!(
            "Could not write temporary JSON file at {}",
            temp_path.display()
        )
    })?;
    fs::rename(&temp_path, path).with_context(|| {
        format!(
            "Could not atomically replace JSON file at {}",
            path.display()
        )
    })?;
    Ok(())
}

pub fn remove_file_if_present(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => {
            Err(error).with_context(|| format!("Could not remove file at {}", path.display()))
        }
    }
}

fn temporary_path(path: &Path) -> PathBuf {
    let process_id = std::process::id();
    let name = path
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| "tmp".to_string());
    path.with_file_name(format!("{name}.{process_id}.tmp"))
}
