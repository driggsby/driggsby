use std::sync::Arc;

use anyhow::{Result, bail};
use serde_json::json;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::{UnixListener, UnixStream},
    sync::Mutex,
};

use crate::runtime_paths::RuntimePaths;

use super::{
    installation::{
        BrokerDpopKeyPair, BrokerInstallation, read_broker_installation,
        write_broker_installation_secrets,
    },
    public_error::PublicBrokerError,
    remote_mcp::RemoteMcpClient,
    remote_session::{refresh_remote_session, session_needs_refresh},
    secret_store::SecretStore,
    session::{
        BrokerRemoteSession, read_broker_remote_session_snapshot, summarize_broker_remote_session,
        write_broker_remote_session_snapshot,
    },
    types::{BrokerRemoteAccessState, BrokerRequest, BrokerResponse, BrokerStatus},
};

pub struct LocalBrokerServer {
    auth_token: String,
    listener: UnixListener,
    remote_client: RemoteMcpClient,
    runtime_paths: RuntimePaths,
    secret_store: Arc<dyn SecretStore>,
    installation: Mutex<BrokerInstallation>,
}

impl LocalBrokerServer {
    pub async fn bind(
        remote_client: RemoteMcpClient,
        runtime_paths: RuntimePaths,
        secret_store: Arc<dyn SecretStore>,
        installation: BrokerInstallation,
    ) -> Result<Self> {
        #[cfg(not(windows))]
        {
            let _ = std::fs::remove_file(&runtime_paths.socket_path);
        }
        let listener = UnixListener::bind(&runtime_paths.socket_path)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(
                &runtime_paths.socket_path,
                std::fs::Permissions::from_mode(0o600),
            )?;
        }
        let auth_token = installation.local_auth_token();
        Ok(Self {
            auth_token,
            listener,
            remote_client,
            runtime_paths,
            secret_store,
            installation: Mutex::new(installation),
        })
    }

    pub async fn run(self) -> Result<()> {
        let shared = Arc::new(self);
        loop {
            let (stream, _) = shared.listener.accept().await?;
            let shared = shared.clone();
            tokio::spawn(async move {
                let _ = shared.handle_stream(stream).await;
            });
        }
    }

    async fn handle_stream(&self, stream: UnixStream) -> Result<()> {
        let (reader, mut writer) = stream.into_split();
        let mut reader = BufReader::new(reader);
        let mut line = String::new();
        if reader.read_line(&mut line).await? == 0 {
            return Ok(());
        }
        let request: BrokerRequest = serde_json::from_str(line.trim_end())?;
        let request_id = request.id.clone();
        let response = match self.dispatch_request(request).await {
            Ok(response) => response,
            Err(error) => BrokerResponse {
                broker_proof: String::new(),
                id: request_id,
                ok: false,
                result: None,
                error: Some(public_broker_error_message(&error)),
            },
        };
        writer
            .write_all(format!("{}\n", serde_json::to_string(&response)?).as_bytes())
            .await?;
        Ok(())
    }

    async fn dispatch_request(&self, request: BrokerRequest) -> Result<BrokerResponse> {
        if request.auth_token != self.auth_token {
            return Ok(BrokerResponse {
                broker_proof: String::new(),
                id: request.id,
                ok: false,
                result: None,
                error: Some("CLI authentication failed.".to_string()),
            });
        }

        let result = match request.method.as_str() {
            "ping" => json!({
                "ok": true,
                "broker_id": self.broker_id().await,
                "cli_version": env!("CARGO_PKG_VERSION")
            }),
            "get_status" => json!({
                "status": self.broker_status().await?
            }),
            "shutdown" => {
                std::process::exit(0);
            }
            "list_tools" => {
                let resource_url = self.remote_resource_url()?;
                let (session, dpop_keys) = self.fresh_remote_session(&resource_url).await?;
                json!({
                    "tools": self.remote_client.list_tools(&session, &dpop_keys, &resource_url).await?
                })
            }
            "call_tool" => {
                let resource_url = self.remote_resource_url()?;
                let (session, dpop_keys) = self.fresh_remote_session(&resource_url).await?;
                let tool_name = request
                    .tool_name
                    .ok_or_else(|| anyhow::anyhow!("Missing tool name."))?;
                self.remote_client
                    .call_tool(
                        &session,
                        &dpop_keys,
                        &resource_url,
                        &tool_name,
                        request.args,
                    )
                    .await?
            }
            _ => bail!("CLI request failed."),
        };

        Ok(BrokerResponse {
            broker_proof: String::new(),
            id: request.id,
            ok: true,
            result: Some(result),
            error: None,
        })
    }

    async fn broker_id(&self) -> String {
        self.installation.lock().await.broker_id().to_string()
    }

    async fn broker_status(&self) -> Result<BrokerStatus> {
        let (metadata, session) = {
            let installation = self.installation.lock().await;
            (installation.metadata.clone(), installation.remote_session())
        };
        let (remote_mcp_ready, remote_access_state, remote_access_detail, next_step_command) =
            match session.as_ref() {
                None => (
                    false,
                    BrokerRemoteAccessState::NotConnected,
                    "The CLI is not signed in to Driggsby yet.".to_string(),
                    Some("npx driggsby@latest login".to_string()),
                ),
                Some(session) if !session_needs_refresh(session) => (
                    true,
                    BrokerRemoteAccessState::Ready,
                    "The CLI is connected and remote MCP access is ready to use.".to_string(),
                    None,
                ),
                Some(_) => {
                    let refreshed = match self.remote_resource_url() {
                        Ok(resource_url) => self
                            .fresh_remote_session(&resource_url)
                            .await
                            .map(|(session, _)| (session, resource_url)),
                        Err(error) => Err(error),
                    };
                    match refreshed {
                        Ok((session, resource_url)) => {
                        return Ok(BrokerStatus {
                            installed: true,
                            broker_running: true,
                            broker_id: Some(metadata.broker_id),
                            dpop_thumbprint: Some(metadata.dpop.thumbprint),
                            remote_mcp_ready: true,
                            remote_access_detail: Some(
                                "The CLI is connected and remote MCP access is ready to use."
                                    .to_string(),
                            ),
                            remote_access_state: Some(BrokerRemoteAccessState::Ready),
                            next_step_command: None,
                            remote_session: Some(summarize_broker_remote_session(
                                &session,
                                &resource_url,
                            )),
                            socket_path: self.runtime_paths.socket_path.display().to_string(),
                        });
                        }
                        Err(_) => (
                            false,
                            BrokerRemoteAccessState::TemporarilyUnavailable,
                            "Driggsby could not refresh remote MCP access right now. The CLI will stay blocked until the refresh succeeds.".to_string(),
                            Some("npx driggsby@latest status".to_string()),
                        ),
                    }
                }
            };

        Ok(BrokerStatus {
            installed: true,
            broker_running: true,
            broker_id: Some(metadata.broker_id),
            dpop_thumbprint: Some(metadata.dpop.thumbprint),
            remote_mcp_ready,
            remote_access_detail: Some(remote_access_detail),
            remote_access_state: Some(remote_access_state),
            next_step_command,
            remote_session: session.as_ref().and_then(|session| {
                self.remote_resource_url()
                    .ok()
                    .map(|resource_url| summarize_broker_remote_session(session, &resource_url))
            }),
            socket_path: self.runtime_paths.socket_path.display().to_string(),
        })
    }

    async fn fresh_remote_session(
        &self,
        resource_url: &str,
    ) -> Result<(BrokerRemoteSession, BrokerDpopKeyPair)> {
        self.reload_installation_if_not_connected().await?;
        let mut installation = self.installation.lock().await;
        let Some(session) = installation.remote_session() else {
            return Err(PublicBrokerError::new(
                crate::user_guidance::build_reauthentication_required_message(
                    "The Driggsby CLI is not connected",
                ),
            )
            .into());
        };
        let dpop_keys = installation.dpop_key_pair();
        if !session_needs_refresh(&session) {
            return Ok((session, dpop_keys));
        }
        let refreshed = refresh_remote_session(&session, &dpop_keys, resource_url).await?;
        installation.set_remote_session(refreshed.clone());
        write_broker_installation_secrets(self.secret_store.as_ref(), &installation)?;
        write_broker_remote_session_snapshot(&self.runtime_paths, &refreshed, resource_url)?;
        Ok((refreshed, dpop_keys))
    }

    fn remote_resource_url(&self) -> Result<String> {
        let snapshot = read_broker_remote_session_snapshot(&self.runtime_paths)?;
        let Some(snapshot) = snapshot else {
            return Err(PublicBrokerError::new(
                crate::user_guidance::build_reauthentication_required_message(
                    "Driggsby remote access metadata is missing",
                ),
            )
            .into());
        };
        Ok(snapshot.session.resource)
    }

    async fn reload_installation_if_not_connected(&self) -> Result<()> {
        if self.installation.lock().await.remote_session().is_some() {
            return Ok(());
        }
        let Some(reloaded) =
            read_broker_installation(&self.runtime_paths, self.secret_store.as_ref())?
        else {
            return Ok(());
        };
        let mut installation = self.installation.lock().await;
        if installation.remote_session().is_none() {
            *installation = reloaded;
        }
        Ok(())
    }
}

fn public_broker_error_message(error: &anyhow::Error) -> String {
    if let Some(public_error) = error.downcast_ref::<PublicBrokerError>() {
        return public_error.message().to_string();
    }

    "Driggsby could not complete that request. Check the input and try again.\n\nNext:\n  npx driggsby@latest status".to_string()
}
