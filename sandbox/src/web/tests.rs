use super::{ViewerGuard, launch_url, router};
use crate::audit::{AuditEventData, AuditLog};
use axum::body::Body;
use axum::http::{Request, StatusCode};
use futures_util::{SinkExt, StreamExt};
use std::net::SocketAddr;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tower::ServiceExt;

#[tokio::test]
async fn serves_embedded_dashboard_assets() {
    let address: SocketAddr = "127.0.0.1:43130".parse().unwrap();
    let app = router(AuditLog::in_memory(), ViewerGuard::new(address));

    for (path, content_type, marker) in [
        ("/", "text/html", "Sandbox Audit"),
        ("/app.css", "text/css", "--surface"),
        ("/app.js", "javascript", "WebSocket"),
    ] {
        let response = app
            .clone()
            .oneshot(Request::get(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(
            response.headers()["content-type"]
                .to_str()
                .unwrap()
                .contains(content_type)
        );
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        assert!(String::from_utf8_lossy(&body).contains(marker));
    }
}

#[tokio::test]
async fn dashboard_uses_the_approved_resizable_timeline_layout() {
    let address: SocketAddr = "127.0.0.1:43130".parse().unwrap();
    let app = router(AuditLog::in_memory(), ViewerGuard::new(address));
    let response = app
        .oneshot(Request::get("/").body(Body::empty()).unwrap())
        .await
        .unwrap();
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let html = String::from_utf8_lossy(&body);

    assert!(html.contains("SANDBOX AUDIT"));
    assert!(html.contains("id=\"execution-list\""));
    assert!(html.contains("id=\"selected-run-id\""));
    assert!(html.contains("id=\"event-details\""));
    assert!(html.contains("data-resizer=\"sidebar\""));
    assert!(html.contains("data-resizer=\"inspector\""));
    assert!(html.contains("Timeline"));
    assert!(!html.contains("Process Tree"));
    assert!(!html.contains("id=\"files\""));
    assert!(!html.contains("id=\"network\""));
    assert!(!html.contains("Process / PID"));
}

#[tokio::test]
async fn dashboard_script_never_labels_an_execution_id_as_a_process() {
    let address: SocketAddr = "127.0.0.1:43130".parse().unwrap();
    let app = router(AuditLog::in_memory(), ViewerGuard::new(address));
    let response = app
        .oneshot(Request::get("/app.js").body(Body::empty()).unwrap())
        .await
        .unwrap();
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let javascript = String::from_utf8_lossy(&body);

    assert!(javascript.contains("command-only"));
    assert!(javascript.contains("selected-run-id"));
    assert!(!javascript.contains("`command ${shortId(execution.id)}`"));
}

#[test]
fn viewer_tokens_are_ephemeral_and_use_a_url_fragment() {
    let address: SocketAddr = "127.0.0.1:43130".parse().unwrap();
    let first = ViewerGuard::new(address);
    let second = ViewerGuard::new(address);

    assert_ne!(first.token(), second.token());
    assert!(!first.token().contains('.'));
    let url = launch_url(address, first.token());
    assert_eq!(
        url,
        format!("http://127.0.0.1:43130/#token={}", first.token())
    );
    assert!(!url.contains("?token="));
}

#[test]
fn viewer_guard_requires_matching_host_origin_and_first_auth_message() {
    let address: SocketAddr = "127.0.0.1:43130".parse().unwrap();
    let guard = ViewerGuard::new(address);

    assert!(guard.allows_request("127.0.0.1:43130", "http://127.0.0.1:43130"));
    assert!(!guard.allows_request("127.0.0.1:43131", "http://127.0.0.1:43131"));
    assert!(!guard.allows_request("127.0.0.1:43130", "http://attacker.invalid"));
    assert!(guard.authenticates(&format!(r#"{{"type":"auth","token":"{}"}}"#, guard.token())));
    assert!(!guard.authenticates(r#"{"type":"auth","token":"wrong"}"#));
    assert!(!guard.authenticates("not json"));
}

#[tokio::test]
async fn websocket_rejects_invalid_auth_and_sends_a_snapshot_after_valid_auth() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let audit = AuditLog::in_memory();
    let execution = audit.start_execution("printf live", None).unwrap();
    let guard = ViewerGuard::new(address);
    let token = guard.token().to_owned();
    let server = tokio::spawn(axum::serve(listener, router(audit, guard)).into_future());

    let mut invalid = websocket_request(address);
    let (mut socket, _) = tokio_tungstenite::connect_async(invalid).await.unwrap();
    socket
        .send(tokio_tungstenite::tungstenite::Message::Text(
            r#"{"type":"auth","token":"wrong"}"#.into(),
        ))
        .await
        .unwrap();
    assert!(matches!(
        socket.next().await,
        Some(Ok(tokio_tungstenite::tungstenite::Message::Close(_))) | None
    ));

    invalid = websocket_request(address);
    let (mut socket, _) = tokio_tungstenite::connect_async(invalid).await.unwrap();
    socket
        .send(tokio_tungstenite::tungstenite::Message::Text(
            format!(r#"{{"type":"auth","token":"{token}"}}"#).into(),
        ))
        .await
        .unwrap();
    let message = socket.next().await.unwrap().unwrap().into_text().unwrap();
    let message: serde_json::Value = serde_json::from_str(&message).unwrap();
    assert_eq!(message["type"], "snapshot");
    assert_eq!(
        message["snapshot"]["executions"][0]["id"],
        execution.to_string()
    );

    server.abort();
}

#[tokio::test]
async fn authenticated_viewer_can_clear_the_selected_execution_events() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let audit = AuditLog::in_memory();
    let execution = audit.start_execution("printf live", None).unwrap();
    audit
        .record_event(
            execution,
            100,
            AuditEventData::File {
                event: "open".to_owned(),
                pid: 42,
                path: "/tmp/example".to_owned(),
                access: Some("read".to_owned()),
            },
        )
        .unwrap();
    let guard = ViewerGuard::new(address);
    let token = guard.token().to_owned();
    let server = tokio::spawn(axum::serve(listener, router(audit.clone(), guard)).into_future());
    let (mut socket, _) = tokio_tungstenite::connect_async(websocket_request(address))
        .await
        .unwrap();
    socket
        .send(tokio_tungstenite::tungstenite::Message::Text(
            format!(r#"{{"type":"auth","token":"{token}"}}"#).into(),
        ))
        .await
        .unwrap();
    let _snapshot = socket.next().await.unwrap().unwrap();

    socket
        .send(tokio_tungstenite::tungstenite::Message::Text(
            format!(r#"{{"type":"clear_events","execution_id":"{execution}"}}"#).into(),
        ))
        .await
        .unwrap();
    let message = socket.next().await.unwrap().unwrap().into_text().unwrap();
    let message: serde_json::Value = serde_json::from_str(&message).unwrap();

    assert_eq!(message["type"], "events_cleared");
    assert_eq!(message["execution_id"], execution.to_string());
    assert!(audit.snapshot().events.is_empty());
    assert_eq!(audit.snapshot().executions[0].file_events, 0);

    server.abort();
}

fn websocket_request(address: SocketAddr) -> axum::http::Request<()> {
    let mut request = format!("ws://{address}/ws").into_client_request().unwrap();
    request
        .headers_mut()
        .insert("origin", format!("http://{address}").parse().unwrap());
    request
}
