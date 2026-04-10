use std::{path::Path, process::Stdio, time::Duration};

use anyhow::{Result, bail};
use tokio::{process::Command, time::sleep};

use crate::{runtime_paths::RuntimePaths, user_guidance::build_broker_investigation_message};

use super::{
    client::{get_broker_status, ping_broker},
    secret_store::SecretStore,
};

pub async fn ensure_broker_running(
    runtime_paths: &RuntimePaths,
    secret_store: &dyn SecretStore,
    current_exe: &Path,
) -> Result<()> {
    if ping_broker(runtime_paths, secret_store).await?.is_some() {
        return Ok(());
    }
    Command::new(current_exe)
        .arg("cli-daemon")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    if wait_for_broker(runtime_paths, secret_store, Duration::from_secs(4)).await? {
        return Ok(());
    }
    bail!(build_broker_investigation_message(
        "The local Driggsby CLI service did not start cleanly"
    ))
}

async fn wait_for_broker(
    runtime_paths: &RuntimePaths,
    secret_store: &dyn SecretStore,
    timeout_window: Duration,
) -> Result<bool> {
    let deadline = tokio::time::Instant::now() + timeout_window;
    while tokio::time::Instant::now() < deadline {
        if get_broker_status(runtime_paths, secret_store)
            .await?
            .is_some()
        {
            return Ok(true);
        }
        sleep(Duration::from_millis(100)).await;
    }
    Ok(false)
}
