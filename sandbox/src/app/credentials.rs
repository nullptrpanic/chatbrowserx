use super::{AppState, error, is_authorized};
use axum::Json;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use std::path::PathBuf;
use tokio::io::AsyncReadExt;

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CredentialRequest {
    path: String,
    field_path: Vec<String>,
}

/// Trusted control-plane read: never create a shell execution or an audit output record.
pub(super) async fn read_credential(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if !is_authorized(&headers, &state.secret) {
        return error(StatusCode::UNAUTHORIZED, "unauthorized");
    }
    let Ok(request) = serde_json::from_slice::<CredentialRequest>(&body) else {
        return error(StatusCode::BAD_REQUEST, "invalid credential request");
    };
    match tokio::time::timeout(
        std::time::Duration::from_secs(5),
        credential(&request.path, &request.field_path),
    )
    .await
    {
        Ok(Some(token)) => (
            [(header::CACHE_CONTROL, "no-store")],
            Json(serde_json::json!({ "value": token })),
        )
            .into_response(),
        _ => error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "credential unavailable; use manual authentication",
        ),
    }
}

async fn credential(path: &str, field_path: &[String]) -> Option<String> {
    if path.is_empty()
        || path.len() > 4096
        || path.contains('\0')
        || field_path.is_empty()
        || field_path.len() > 16
        || field_path
            .iter()
            .any(|part| part.is_empty() || part.len() > 128)
    {
        return None;
    }
    let path = if let Some(relative) = path.strip_prefix("~/") {
        PathBuf::from(std::env::var_os("HOME")?).join(relative)
    } else {
        let path = PathBuf::from(path);
        if !path.is_absolute() {
            return None;
        }
        path
    };
    let file = tokio::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(path)
        .await
        .ok()?;
    let metadata = file.metadata().await.ok()?;
    if !metadata.is_file() || metadata.len() > 1_048_576 {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(1_048_577).read_to_end(&mut bytes).await.ok()?;
    if bytes.len() > 1_048_576 {
        return None;
    }
    let json: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    let mut selected = &json;
    for part in field_path {
        selected = selected.as_object()?.get(part)?;
    }
    let token = selected.as_str()?.trim();
    if token.is_empty() || token.len() > 20_000 {
        return None;
    }
    Some(token.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    #[tokio::test]
    async fn returns_only_access_token_without_recording_an_execution() {
        let file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(file.path(), r#"{"tokens":{"access_token":"synthetic-access","refresh_token":"never-return-refresh"},"extra":"never-return-extra"}"#).unwrap();
        let secret = "0123456789abcdef0123456789abcdef";
        let audit = crate::audit::AuditLog::in_memory();
        let executor = crate::execution::ExecutionService::new(
            std::sync::Arc::new(crate::execution::DirectRuntime),
            audit.clone(),
            std::time::Duration::from_secs(1),
            4096,
            4096,
        );
        let app = super::super::router_with_service(
            secret.into(),
            executor,
            1,
            "http://localhost".into(),
        );
        let response = app
            .oneshot(
                Request::post("/credentials/read")
                    .header(
                        "authorization",
                        format!(
                            "Bearer {}",
                            crate::auth::issue(secret, "fixture", 1).unwrap()
                        ),
                    )
                    .body(Body::from(
                        serde_json::json!({"path": file.path(), "fieldPath": ["tokens", "access_token"]}).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        let bytes = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&bytes).unwrap(),
            serde_json::json!({"value":"synthetic-access"})
        );
        assert!(audit.snapshot().executions.is_empty());
    }

    #[tokio::test]
    async fn rejects_unauthenticated_reads_and_invalid_files() {
        let app = super::super::router(
            "0123456789abcdef0123456789abcdef".into(),
            std::time::Duration::from_secs(1),
        );
        let response = app
            .oneshot(
                Request::post("/credentials/read")
                    .body(Body::from(r#"{"path":"/private"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            credential("relative/auth.json", &["token".into()]).await,
            None
        );
        assert_eq!(
            credential("/nonexistent/auth.json", &["token".into()]).await,
            None
        );
        let file = tempfile::NamedTempFile::new().unwrap();
        for data in [
            "not json",
            r#"{"tokens":{"refresh_token":"private"}}"#,
            r#"{"tokens":{"access_token":""}}"#,
        ] {
            std::fs::write(file.path(), data).unwrap();
            assert_eq!(
                credential(
                    file.path().to_str().unwrap(),
                    &["tokens".into(), "access_token".into()]
                )
                .await,
                None
            );
        }
    }
}
