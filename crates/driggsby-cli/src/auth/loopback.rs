use std::sync::Arc;

use anyhow::Result;
use axum::{
    Router,
    extract::{Query, State},
    response::Html,
    routing::get,
};
use serde::Deserialize;
use tokio::sync::{Mutex, Notify};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoopbackAuthorizationSuccess {
    pub code: String,
    pub state: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoopbackAuthorizationError {
    pub error: String,
    pub error_description: Option<String>,
    pub state: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LoopbackAuthorizationResult {
    Success(LoopbackAuthorizationSuccess),
    Error(LoopbackAuthorizationError),
}

#[derive(Clone)]
pub struct LoopbackAuthListener {
    pub redirect_uri: String,
    state: Arc<ListenerState>,
}

#[derive(Default)]
struct ListenerState {
    result: Mutex<Option<LoopbackAuthorizationResult>>,
    notify: Notify,
}

#[derive(Debug, Deserialize)]
struct CallbackQuery {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

pub async fn start_loopback_auth_listener(timeout_ms: u64) -> Result<LoopbackAuthListener> {
    let state = Arc::new(ListenerState::default());
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
    let address = listener.local_addr()?;
    let redirect_uri = format!("http://127.0.0.1:{}/callback", address.port());
    let app_state = state.clone();
    let app = Router::new()
        .route("/callback", get(handle_callback))
        .with_state(app_state.clone());

    let server = axum::serve(listener, app);
    let shutdown_state = app_state.clone();
    tokio::spawn(async move {
        let timeout = tokio::time::sleep(std::time::Duration::from_millis(timeout_ms));
        tokio::pin!(timeout);
        tokio::select! {
            _ = shutdown_state.notify.notified() => {}
            _ = &mut timeout => {
                let mut slot = shutdown_state.result.lock().await;
                if slot.is_none() {
                    *slot = Some(LoopbackAuthorizationResult::Error(LoopbackAuthorizationError {
                        error: "timeout".to_string(),
                        error_description: Some("Driggsby sign-in timed out before the browser finished connecting.".to_string()),
                        state: None,
                    }));
                    shutdown_state.notify.notify_waiters();
                }
            }
        }
    });
    tokio::spawn(async move {
        let _ = server
            .with_graceful_shutdown(async move {
                app_state.notify.notified().await;
            })
            .await;
    });

    Ok(LoopbackAuthListener {
        redirect_uri,
        state,
    })
}

impl LoopbackAuthListener {
    pub async fn close(&self) -> Result<()> {
        self.state.notify.notify_waiters();
        Ok(())
    }

    pub async fn wait_for_result(&self) -> Result<LoopbackAuthorizationResult> {
        loop {
            if let Some(result) = self.state.result.lock().await.clone() {
                return Ok(result);
            }
            self.state.notify.notified().await;
        }
    }
}

async fn handle_callback(
    State(state): State<Arc<ListenerState>>,
    Query(query): Query<CallbackQuery>,
) -> Result<Html<&'static str>, Html<&'static str>> {
    let result = if let Some(error) = query.error {
        LoopbackAuthorizationResult::Error(LoopbackAuthorizationError {
            error,
            error_description: query.error_description,
            state: query.state,
        })
    } else if let (Some(code), Some(state_value)) = (query.code, query.state) {
        LoopbackAuthorizationResult::Success(LoopbackAuthorizationSuccess {
            code,
            state: state_value,
        })
    } else {
        LoopbackAuthorizationResult::Error(LoopbackAuthorizationError {
            error: "invalid_request".to_string(),
            error_description: Some(
                "The browser callback was missing the authorization code or state.".to_string(),
            ),
            state: None,
        })
    };

    let mut slot = state.result.lock().await;
    if slot.is_some() {
        return Ok(Html(
            "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\" /><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" /><title>Driggsby</title></head><body><main><h1>Driggsby already connected</h1><p>Driggsby sign-in was already completed. You can close this tab.</p></main></body></html>",
        ));
    }
    let success = matches!(result, LoopbackAuthorizationResult::Success(_));
    *slot = Some(result);
    state.notify.notify_waiters();

    if success {
        Ok(Html(
            "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\" /><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" /><title>Driggsby</title></head><body><main><h1>Driggsby connected</h1><p>Driggsby is connected. You can return to your MCP client now.</p></main></body></html>",
        ))
    } else {
        Err(Html(
            "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\" /><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" /><title>Driggsby</title></head><body><main><h1>Driggsby sign-in stopped</h1><p>Driggsby sign-in was not completed. You can close this tab.</p></main></body></html>",
        ))
    }
}
