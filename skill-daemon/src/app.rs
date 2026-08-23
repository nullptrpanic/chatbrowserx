use crate::bash::{self, BashCommand, BashError};
use crate::logger::LoggerEntry;
use axum::Json;
use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Duration;
use std::time::Instant;

#[derive(Clone)]
struct AppState {
    secret: String,
    timeout: Duration,
}

pub(crate) fn router(secret: String, timeout: Duration) -> Router {
    Router::new()
        .route("/bash", post(run_bash))
        .with_state(AppState { secret, timeout })
}

async fn run_bash(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    let token = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));
    if !matches!(token, Some(token) if crate::auth::verify(&state.secret, token)) {
        return error(StatusCode::UNAUTHORIZED, "unauthorized");
    }
    let request: BashRequest = match serde_json::from_slice(&body) {
        Ok(request) => request,
        Err(_) => return error(StatusCode::BAD_REQUEST, "invalid request body"),
    };
    if request.command.trim().is_empty() {
        return error(StatusCode::BAD_REQUEST, "command must not be empty");
    }
    let started = Instant::now();
    let output = match bash::execute(request.into(), state.timeout).await {
        Ok(output) => {
            crate::logger::info!(
                entry = LoggerEntry::new()
                    .with_entry("code", output.code)
                    .with_entry("duration_ms", started.elapsed().as_millis()),
                "bash command completed"
            );
            output
        }
        Err(BashError::Timeout) => {
            crate::logger::error!(
                entry = LoggerEntry::new()
                    .with_entry("duration_ms", started.elapsed().as_millis())
                    .with_error("timeout"),
                "bash command timed out"
            );
            return error(StatusCode::GATEWAY_TIMEOUT, "command timed out");
        }
        Err(BashError::Execute(execution_error)) => {
            crate::logger::error!(
                entry = LoggerEntry::new()
                    .with_entry("duration_ms", started.elapsed().as_millis())
                    .with_error(execution_error),
                "bash command failed"
            );
            return error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "command execution failed",
            );
        }
    };
    Json(BashResponse {
        code: output.code,
        stdout: output.stdout,
        stderr: output.stderr,
    })
    .into_response()
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BashRequest {
    command: String,
    #[serde(default)]
    cwd: Option<PathBuf>,
    #[serde(default)]
    env: BTreeMap<String, String>,
}

impl From<BashRequest> for BashCommand {
    fn from(request: BashRequest) -> Self {
        Self {
            command: request.command,
            cwd: request.cwd,
            env: request.env,
        }
    }
}

#[derive(Serialize)]
struct BashResponse {
    code: i32,
    stdout: String,
    stderr: String,
}

#[derive(Serialize)]
struct ErrorResponse {
    code: i32,
    message: &'static str,
}

fn error(status: StatusCode, message: &'static str) -> Response {
    (status, Json(ErrorResponse { code: 1, message })).into_response()
}

#[cfg(test)]
mod tests;
