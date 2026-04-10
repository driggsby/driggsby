use std::sync::Arc;

use anyhow::Result;

use crate::runtime_paths::RuntimePaths;

use super::{
    installation::{
        ensure_broker_installation, read_broker_dpop_key_pair, read_broker_local_auth_token,
    },
    remote_mcp::RemoteMcpClient,
    resolve_secret_store::resolve_secret_store,
    server::LocalBrokerServer,
};

pub async fn run_broker_daemon(runtime_paths: &RuntimePaths) -> Result<()> {
    let resolved_secret_store = resolve_secret_store(runtime_paths)?;
    let secret_store = resolved_secret_store.store;
    let metadata = ensure_broker_installation(runtime_paths, secret_store.as_ref()).await?;
    let auth_token = read_broker_local_auth_token(secret_store.as_ref(), &metadata.broker_id)?
        .ok_or_else(|| anyhow::anyhow!("The local CLI auth state is incomplete."))?;
    let dpop_keys =
        read_broker_dpop_key_pair(runtime_paths, secret_store.as_ref(), &metadata.broker_id)?
            .ok_or_else(|| anyhow::anyhow!("The local CLI DPoP key is missing."))?;
    let server = LocalBrokerServer::bind(
        auth_token,
        RemoteMcpClient::new()?,
        runtime_paths.clone(),
        Arc::from(secret_store),
        metadata.broker_id,
    )
    .await?;
    server.run(dpop_keys).await
}
