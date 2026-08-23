use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::Value;
use std::time::Duration;
use tower::ServiceExt;

use super::router;

#[tokio::test]
async fn rejects_missing_or_incorrect_bearer_token() {
    let app = router("expected-token".to_string(), Duration::from_secs(1));

    for authorization in [None, Some("Bearer wrong-token")] {
        let mut request = Request::post("/bash")
            .header("content-type", "application/json")
            .body(Body::from(r#"{"command":"true"}"#))
            .unwrap();
        if let Some(value) = authorization {
            request
                .headers_mut()
                .insert("authorization", value.parse().unwrap());
        }

        let response = app.clone().oneshot(request).await.unwrap();

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
}

#[tokio::test]
async fn executes_bash_with_cwd_and_environment() {
    let directory = tempfile::tempdir().unwrap();
    let app = router("expected-token".to_string(), Duration::from_secs(2));
    let body = serde_json::json!({
        "command": "pwd; printf '%s' \"$SKILL_VALUE\"; printf '%s' 'problem' >&2",
        "cwd": directory.path(),
        "env": {"SKILL_VALUE": "configured"}
    });
    let request = Request::post("/bash")
        .header("authorization", "Bearer expected-token")
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();

    let response = app.oneshot(request).await.unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let output: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(output["exit_code"], 0);
    assert_eq!(
        output["stdout"],
        format!(
            "{}\nconfigured",
            directory.path().canonicalize().unwrap().display()
        )
    );
    assert_eq!(output["stderr"], "problem");
}

#[tokio::test]
async fn rejects_empty_commands() {
    let app = router("expected-token".to_string(), Duration::from_secs(1));
    let request = Request::post("/bash")
        .header("authorization", "Bearer expected-token")
        .header("content-type", "application/json")
        .body(Body::from(r#"{"command":"  \n "}"#))
        .unwrap();

    let response = app.oneshot(request).await.unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn returns_non_zero_command_exit_and_output() {
    let app = router("expected-token".to_string(), Duration::from_secs(1));
    let request = Request::post("/bash")
        .header("authorization", "Bearer expected-token")
        .header("content-type", "application/json")
        .body(Body::from(
            r#"{"command":"printf output; printf problem >&2; exit 7"}"#,
        ))
        .unwrap();

    let response = app.oneshot(request).await.unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let output: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(output["exit_code"], 7);
    assert_eq!(output["stdout"], "output");
    assert_eq!(output["stderr"], "problem");
}

#[tokio::test]
async fn stops_commands_at_the_configured_timeout() {
    let app = router("expected-token".to_string(), Duration::from_millis(50));
    let request = Request::post("/bash")
        .header("authorization", "Bearer expected-token")
        .header("content-type", "application/json")
        .body(Body::from(r#"{"command":"sleep 2"}"#))
        .unwrap();

    let response = app.oneshot(request).await.unwrap();

    assert_eq!(response.status(), StatusCode::GATEWAY_TIMEOUT);
}

#[tokio::test]
async fn rejects_invalid_json_and_unknown_fields() {
    let app = router("expected-token".to_string(), Duration::from_secs(1));
    for body in ["not json", r#"{"command":"true","unknown":true}"#] {
        let request = Request::post("/bash")
            .header("authorization", "Bearer expected-token")
            .body(Body::from(body))
            .unwrap();

        let response = app.clone().oneshot(request).await.unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
}

#[tokio::test]
async fn reports_command_start_failures_without_exposing_details() {
    let directory = tempfile::tempdir().unwrap();
    let missing = directory.path().join("missing");
    let app = router("expected-token".to_string(), Duration::from_secs(1));
    let body = serde_json::json!({"command": "true", "cwd": missing});
    let request = Request::post("/bash")
        .header("authorization", "Bearer expected-token")
        .body(Body::from(body.to_string()))
        .unwrap();

    let response = app.oneshot(request).await.unwrap();

    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap(),
        serde_json::json!({"error": "command execution failed"})
    );
}
