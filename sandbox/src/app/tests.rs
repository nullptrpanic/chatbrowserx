use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::Value;
use std::time::Duration;
use tower::ServiceExt;

use super::{router, router_with_limits};

const TEST_SECRET: &str = "0123456789abcdef0123456789abcdef";
const TEST_TOKEN: &str = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0LXBsdWdpbiIsImlhdCI6MTcyNDMyODAwMCwiZXhwIjo0MTAyNDQ0ODAwfQ.J2vAPeluNLAT2qx8vVNLuhXY7JZ5uhMaHi64Nkmwuj0";
const EXPIRED_AUTHORIZATION: &str = "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0LXBsdWdpbiIsImlhdCI6MTcyNDMyODAwMCwiZXhwIjoxNzI0MzI4MDAxfQ.xkAv72l71CwyBlXfpCKSbYb-5k_nj2uGsAx685MEbl8";
const LEGACY_AUTHORIZATION_WITHOUT_EXPIRATION: &str = "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0LXBsdWdpbiIsImlhdCI6MTcyNDMyODAwMH0.gzXZPhR9NajLbPblME61DooewJjRB5CLrtBjtu1PgAw";

#[tokio::test]
async fn rejects_missing_or_incorrect_bearer_token() {
    let app = router(TEST_SECRET.to_string(), Duration::from_secs(1));

    for authorization in [
        None,
        Some("Bearer wrong-token"),
        Some(EXPIRED_AUTHORIZATION),
        Some(LEGACY_AUTHORIZATION_WITHOUT_EXPIRATION),
        Some(
            "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0LXBsdWdpbiIsImlhdCI6MTcyNDMyODAwMCwiZXhwIjo0MTAyNDQ0ODAwfQ.J2vAPeluNLAT2qx8vVNLuhXY7JZ5uhMaHi64Nkmwuj1",
        ),
    ] {
        let mut request = Request::post("/exec")
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
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap(),
            serde_json::json!({"code": 1, "message": "unauthorized"})
        );
    }
}

#[tokio::test]
async fn executes_bash_with_cwd_and_environment() {
    let directory = tempfile::tempdir().unwrap();
    let app = router(TEST_SECRET.to_string(), Duration::from_secs(2));
    let body = serde_json::json!({
        "command": "pwd; printf '%s' \"$SKILL_VALUE\"; printf '%s' 'problem' >&2",
        "cwd": directory.path(),
        "env": {"SKILL_VALUE": "configured"}
    });
    let request = Request::post("/exec")
        .header("authorization", format!("Bearer {TEST_TOKEN}"))
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();

    let response = app.oneshot(request).await.unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let output: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(output["code"], 0);
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
    let app = router(TEST_SECRET.to_string(), Duration::from_secs(1));
    let request = Request::post("/exec")
        .header("authorization", format!("Bearer {TEST_TOKEN}"))
        .header("content-type", "application/json")
        .body(Body::from(r#"{"command":"  \n "}"#))
        .unwrap();

    let response = app.oneshot(request).await.unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn returns_non_zero_command_exit_and_output() {
    let app = router(TEST_SECRET.to_string(), Duration::from_secs(1));
    let request = Request::post("/exec")
        .header("authorization", format!("Bearer {TEST_TOKEN}"))
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
    assert_eq!(output["code"], 7);
    assert_eq!(output["stdout"], "output");
    assert_eq!(output["stderr"], "problem");
}

#[tokio::test]
async fn stops_commands_at_the_configured_timeout() {
    let app = router(TEST_SECRET.to_string(), Duration::from_millis(50));
    let request = Request::post("/exec")
        .header("authorization", format!("Bearer {TEST_TOKEN}"))
        .header("content-type", "application/json")
        .body(Body::from(r#"{"command":"sleep 2"}"#))
        .unwrap();

    let response = app.oneshot(request).await.unwrap();

    assert_eq!(response.status(), StatusCode::GATEWAY_TIMEOUT);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap(),
        serde_json::json!({"code": 1, "message": "command timed out"})
    );
}

#[tokio::test]
async fn rejects_invalid_json_and_unknown_fields() {
    let app = router(TEST_SECRET.to_string(), Duration::from_secs(1));
    for body in ["not json", r#"{"command":"true","unknown":true}"#] {
        let request = Request::post("/exec")
            .header("authorization", format!("Bearer {TEST_TOKEN}"))
            .body(Body::from(body))
            .unwrap();

        let response = app.clone().oneshot(request).await.unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
}

#[tokio::test]
async fn rejects_oversized_request_bodies_before_dispatch() {
    let app = router(TEST_SECRET.to_string(), Duration::from_secs(1));
    let request = Request::post("/exec")
        .header("authorization", format!("Bearer {TEST_TOKEN}"))
        .header("content-type", "application/json")
        .body(Body::from(format!(
            "{{\"command\":\"{}\"}}",
            "x".repeat(300_000)
        )))
        .unwrap();

    let response = app.oneshot(request).await.unwrap();

    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
}

#[tokio::test]
async fn rejects_saturated_command_concurrency_without_dispatching() {
    let app = router_with_limits(
        TEST_SECRET.to_string(),
        Duration::from_secs(1),
        1,
        1024,
        1024,
    );
    let first = Request::post("/exec")
        .header("authorization", format!("Bearer {TEST_TOKEN}"))
        .body(Body::from(r#"{"command":"sleep 0.2"}"#))
        .unwrap();
    let first_run = tokio::spawn(app.clone().oneshot(first));
    tokio::time::sleep(Duration::from_millis(20)).await;
    let second = Request::post("/exec")
        .header("authorization", format!("Bearer {TEST_TOKEN}"))
        .body(Body::from(r#"{"command":"true"}"#))
        .unwrap();

    let response = app.clone().oneshot(second).await.unwrap();

    assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(first_run.await.unwrap().unwrap().status(), StatusCode::OK);
}

#[tokio::test]
async fn terminates_commands_that_exceed_the_output_limit() {
    let app = router_with_limits(TEST_SECRET.to_string(), Duration::from_secs(1), 1, 64, 64);
    let request = Request::post("/exec")
        .header("authorization", format!("Bearer {TEST_TOKEN}"))
        .body(Body::from(
            r#"{"command":"head -c 4096 /dev/zero | tr '\\0' x"}"#,
        ))
        .unwrap();

    let response = app.oneshot(request).await.unwrap();

    assert_eq!(response.status(), StatusCode::INSUFFICIENT_STORAGE);
}

#[tokio::test]
async fn reports_command_start_failures_without_exposing_details() {
    let directory = tempfile::tempdir().unwrap();
    let missing = directory.path().join("missing");
    let app = router(TEST_SECRET.to_string(), Duration::from_secs(1));
    let body = serde_json::json!({"command": "true", "cwd": missing});
    let request = Request::post("/exec")
        .header("authorization", format!("Bearer {TEST_TOKEN}"))
        .body(Body::from(body.to_string()))
        .unwrap();

    let response = app.oneshot(request).await.unwrap();

    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap(),
        serde_json::json!({"code": 1, "message": "command execution failed"})
    );
}

#[tokio::test]
async fn does_not_expose_the_retired_bash_route() {
    let app = router(TEST_SECRET.to_string(), Duration::from_secs(1));
    let request = Request::post("/bash")
        .header("authorization", format!("Bearer {TEST_TOKEN}"))
        .header("content-type", "application/json")
        .body(Body::from(r#"{"command":"true"}"#))
        .unwrap();

    let response = app.oneshot(request).await.unwrap();

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}
