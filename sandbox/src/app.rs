#[cfg(test)]
use crate::audit::AuditLog;
#[cfg(test)]
use crate::execution::DirectRuntime;
use crate::execution::{ExecutionService, ShellCommand, ShellError};
use crate::logger::LoggerEntry;
use axum::Json;
use axum::Router;
use axum::body::Bytes;
use axum::extract::DefaultBodyLimit;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
#[cfg(test)]
use std::time::Duration;
use std::time::Instant;
use tokio::sync::Semaphore;

const MAX_REQUEST_BODY_BYTES: usize = 256 * 1024;
#[cfg(test)]
const MAX_COMMAND_CONCURRENCY: usize = 4;
#[cfg(test)]
const MAX_STDOUT_BYTES: usize = 4 * 1024 * 1024;
#[cfg(test)]
const MAX_STDERR_BYTES: usize = 1024 * 1024;

#[derive(Clone)]
struct AppState {
    secret: String,
    console_url: String,
    executor: ExecutionService,
    commands: Arc<Semaphore>,
}

#[cfg(test)]
pub(crate) fn router(secret: String, timeout: Duration) -> Router {
    router_with_limits(
        secret,
        timeout,
        MAX_COMMAND_CONCURRENCY,
        MAX_STDOUT_BYTES,
        MAX_STDERR_BYTES,
    )
}

#[cfg(test)]
pub(crate) fn router_with_limits(
    secret: String,
    timeout: Duration,
    max_concurrency: usize,
    stdout_limit: usize,
    stderr_limit: usize,
) -> Router {
    let executor = ExecutionService::new(
        Arc::new(DirectRuntime),
        AuditLog::in_memory(),
        timeout,
        stdout_limit,
        stderr_limit,
    );
    router_with_service(
        secret,
        executor,
        max_concurrency,
        "http://127.0.0.1:43130/#token=test-viewer-token".to_owned(),
    )
}

pub(crate) fn router_with_service(
    secret: String,
    executor: ExecutionService,
    max_concurrency: usize,
    console_url: String,
) -> Router {
    Router::new()
        .route("/exec", post(run_exec))
        .route("/console", get(get_console))
        .layer(DefaultBodyLimit::max(MAX_REQUEST_BODY_BYTES))
        .with_state(AppState {
            secret,
            console_url,
            executor,
            commands: Arc::new(Semaphore::new(max_concurrency.max(1))),
        })
}

async fn run_exec(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    if !is_authorized(&headers, &state.secret) {
        return error(StatusCode::UNAUTHORIZED, "unauthorized");
    }
    let request: BashRequest = match serde_json::from_slice(&body) {
        Ok(request) => request,
        Err(_) => return error(StatusCode::BAD_REQUEST, "invalid request body"),
    };
    if request.command.trim().is_empty() {
        return error(StatusCode::BAD_REQUEST, "command must not be empty");
    }
    let _permit = match state.commands.try_acquire_owned() {
        Ok(permit) => permit,
        Err(_) => return error(StatusCode::TOO_MANY_REQUESTS, "command capacity is full"),
    };
    let started = Instant::now();
    let output = match state.executor.execute(request.into()).await {
        Ok(output) => {
            crate::logger::info!(
                entry = LoggerEntry::new()
                    .with_entry("code", output.code)
                    .with_entry("duration_ms", started.elapsed().as_millis()),
                "bash command completed"
            );
            output
        }
        Err(ShellError::Timeout) => {
            crate::logger::error!(
                entry = LoggerEntry::new()
                    .with_entry("duration_ms", started.elapsed().as_millis())
                    .with_error("timeout"),
                "bash command timed out"
            );
            return error(StatusCode::GATEWAY_TIMEOUT, "command timed out");
        }
        Err(ShellError::OutputLimit) => {
            crate::logger::error!(
                entry = LoggerEntry::new()
                    .with_entry("duration_ms", started.elapsed().as_millis())
                    .with_error("output_limit"),
                "bash command exceeded output limit"
            );
            return error(
                StatusCode::INSUFFICIENT_STORAGE,
                "command output exceeded limit",
            );
        }
        Err(ShellError::Execute(execution_error)) => {
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

async fn get_console(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if !is_authorized(&headers, &state.secret) {
        return error(StatusCode::UNAUTHORIZED, "unauthorized");
    }
    (
        [(header::CACHE_CONTROL, "no-store")],
        Json(ConsoleResponse {
            code: 0,
            url: state.console_url,
        }),
    )
        .into_response()
}

fn is_authorized(headers: &HeaderMap, secret: &str) -> bool {
    let token = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));
    matches!(token, Some(token) if crate::auth::verify(secret, token))
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

impl From<BashRequest> for ShellCommand {
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
struct ConsoleResponse {
    code: i32,
    url: String,
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
