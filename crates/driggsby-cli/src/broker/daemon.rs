use std::sync::Arc;

use anyhow::Result;

use crate::runtime_paths::RuntimePaths;

use super::{
    installation::ensure_broker_installation, remote_mcp::RemoteMcpClient,
    resolve_secret_store::resolve_secret_store, server::LocalBrokerServer,
};

pub async fn run_broker_daemon(runtime_paths: &RuntimePaths) -> Result<()> {
    let resolved_secret_store = resolve_secret_store(runtime_paths)?;
    let secret_store = resolved_secret_store.store;
    let installation = ensure_broker_installation(runtime_paths, secret_store.as_ref()).await?;
    let server = LocalBrokerServer::bind(
        RemoteMcpClient::new()?,
        runtime_paths.clone(),
        Arc::from(secret_store),
        installation,
    )
    .await?;
    server.run().await
}
