mod assets;
mod protocol;

use crate::audit::{AuditLog, AuditUpdate};
use axum::Router;
use axum::extract::State;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use futures_util::{SinkExt, StreamExt};
use protocol::{ClientMessage, ServerMessage};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;

const AUTH_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone)]
pub(crate) struct ViewerGuard {
    address: SocketAddr,
    token: String,
}

impl ViewerGuard {
    pub(crate) fn new(address: SocketAddr) -> Self {
        Self {
            address,
            token: format!(
                "{}{}",
                uuid::Uuid::new_v4().simple(),
                uuid::Uuid::new_v4().simple()
            ),
        }
    }

    pub(crate) fn token(&self) -> &str {
        &self.token
    }

    pub(crate) fn allows_request(&self, host: &str, origin: &str) -> bool {
        let Ok(host) = host.parse::<axum::http::uri::Authority>() else {
            return false;
        };
        if host.port_u16().unwrap_or(80) != self.address.port() {
            return false;
        }
        let origin = origin
            .strip_prefix("http://")
            .or_else(|| origin.strip_prefix("https://"));
        let Some(origin) = origin else {
            return false;
        };
        let origin = origin.trim_end_matches('/');
        let Ok(origin) = origin.parse::<axum::http::uri::Authority>() else {
            return false;
        };
        if origin != host {
            return false;
        }
        self.address.ip().is_unspecified()
            || host_matches_ip(host.host(), self.address.ip())
            || (self.address.ip().is_loopback() && host.host().eq_ignore_ascii_case("localhost"))
    }

    pub(crate) fn authenticates(&self, message: &str) -> bool {
        matches!(
            serde_json::from_str::<ClientMessage>(message),
            Ok(ClientMessage::Auth { token }) if token == self.token
        )
    }
}

#[derive(Clone)]
struct WebState {
    audit: AuditLog,
    guard: ViewerGuard,
}

pub(crate) fn router(audit: AuditLog, guard: ViewerGuard) -> Router {
    Router::new()
        .route("/", get(assets::index))
        .route("/app.css", get(assets::css))
        .route("/app.js", get(assets::javascript))
        .route("/ws", get(websocket))
        .with_state(WebState { audit, guard })
}

pub(crate) fn launch_url(address: SocketAddr, token: &str) -> String {
    let address = if address.ip().is_unspecified() {
        match address {
            SocketAddr::V4(_) => SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), address.port()),
            SocketAddr::V6(_) => SocketAddr::new(IpAddr::V6(Ipv6Addr::LOCALHOST), address.port()),
        }
    } else {
        address
    };
    format!("http://{address}/#token={token}")
}

async fn websocket(
    State(state): State<WebState>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    let host = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok());
    let origin = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok());
    if !matches!((host, origin), (Some(host), Some(origin)) if state.guard.allows_request(host, origin))
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    upgrade.on_upgrade(move |socket| serve_socket(socket, state))
}

async fn serve_socket(mut socket: WebSocket, state: WebState) {
    let authenticated = tokio::time::timeout(AUTH_TIMEOUT, socket.recv()).await;
    let Ok(Some(Ok(Message::Text(message)))) = authenticated else {
        let _ = socket.close().await;
        return;
    };
    if !state.guard.authenticates(&message) {
        let _ = socket.close().await;
        return;
    }
    let (mut receiver, snapshot) = state.audit.subscribe_with_snapshot();
    if send_json(&mut socket, &ServerMessage::Snapshot { snapshot })
        .await
        .is_err()
    {
        return;
    }
    loop {
        tokio::select! {
            update = receiver.recv() => {
                let message = match update {
                    Ok(AuditUpdate::Execution { execution }) => {
                        ServerMessage::Execution { execution }
                    }
                    #[cfg(any(target_os = "macos", test))]
                    Ok(AuditUpdate::Event { event }) => ServerMessage::Event { event },
                    Ok(AuditUpdate::ExecutionsCleared) => ServerMessage::ExecutionsCleared,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        ServerMessage::Snapshot { snapshot: state.audit.snapshot() }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
                };
                if send_json(&mut socket, &message).await.is_err() {
                    return;
                }
            }
            incoming = socket.next() => {
                match incoming {
                    Some(Ok(Message::Ping(payload))) => {
                        if socket.send(Message::Pong(payload)).await.is_err() {
                            return;
                        }
                    }
                    Some(Ok(Message::Text(message))) => {
                        if let Ok(ClientMessage::ClearExecutions) =
                            serde_json::from_str::<ClientMessage>(&message)
                            && state.audit.clear_executions().is_err()
                            && send_json(
                                &mut socket,
                                &ServerMessage::Error {
                                    message: "Unable to clear execution history.".to_owned(),
                                },
                            )
                            .await
                            .is_err()
                        {
                            return;
                        }
                    }
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return,
                    Some(Ok(_)) => {}
                }
            }
        }
    }
}

async fn send_json(socket: &mut WebSocket, message: &ServerMessage) -> Result<(), axum::Error> {
    let message = serde_json::to_string(message).expect("audit messages must serialize");
    socket.send(Message::Text(message.into())).await
}

fn host_matches_ip(host: &str, ip: IpAddr) -> bool {
    host.trim_matches(['[', ']'])
        .parse::<IpAddr>()
        .is_ok_and(|host| host == ip)
}

#[cfg(test)]
mod tests;
