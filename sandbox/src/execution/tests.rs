use super::{DirectRuntime, ExecutionAttempt, ExecutionService, ShellCommand, ShellError};
use crate::audit::{AuditLog, ExecutionStatus};
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

fn service(
    audit: AuditLog,
    timeout: Duration,
    stdout_limit: usize,
    stderr_limit: usize,
) -> ExecutionService {
    ExecutionService::new(
        Arc::new(DirectRuntime),
        audit,
        timeout,
        stdout_limit,
        stderr_limit,
    )
}

#[tokio::test]
async fn direct_execution_preserves_shell_behavior_and_records_completion() {
    let directory = tempfile::tempdir().unwrap();
    let audit = AuditLog::in_memory();
    let executor = service(audit.clone(), Duration::from_secs(2), 4096, 4096);
    let mut env = BTreeMap::new();
    env.insert("SANDBOX_TEST_VALUE".to_owned(), "present".to_owned());

    let output = executor
        .execute(ShellCommand {
            command: "printf '%s:%s' \"$PWD\" \"$SANDBOX_TEST_VALUE\"; printf error >&2".to_owned(),
            cwd: Some(directory.path().to_path_buf()),
            env,
        })
        .await
        .unwrap();

    assert_eq!(output.code, 0);
    assert_eq!(
        output.stdout,
        format!(
            "{}:present",
            directory.path().canonicalize().unwrap().display()
        )
    );
    assert_eq!(output.stderr, "error");
    let snapshot = audit.snapshot();
    assert_eq!(snapshot.executions.len(), 1);
    assert_eq!(snapshot.executions[0].status, ExecutionStatus::Succeeded);
    assert_eq!(snapshot.executions[0].exit_code, Some(0));
    assert_eq!(snapshot.executions[0].stdout, output.stdout);
    assert_eq!(snapshot.executions[0].stderr, output.stderr);
    let record = serde_json::to_value(&snapshot.executions[0]).unwrap();
    assert!(record["pid"].as_u64().is_some());
    assert_eq!(record["ppid"], serde_json::json!(std::process::id()));
}

#[tokio::test]
async fn concurrent_duplicate_execution_ids_dispatch_only_once() {
    let directory = tempfile::tempdir().unwrap();
    let marker = directory.path().join("marker");
    let audit = AuditLog::in_memory();
    let executor = service(audit.clone(), Duration::from_secs(2), 4096, 4096);
    let command = ShellCommand::new(format!("printf x >> '{}'; sleep 0.1", marker.display()));
    let first_executor = executor.clone();
    let first_command = command.clone();
    let first = tokio::spawn(async move {
        first_executor
            .execute_once(first_command, Some("sandboxExecution_concurrent"))
            .await
    });
    tokio::time::sleep(Duration::from_millis(20)).await;

    let duplicate = executor
        .execute_once(command, Some("sandboxExecution_concurrent"))
        .await
        .unwrap();
    let original = first.await.unwrap().unwrap();

    assert!(matches!(duplicate, ExecutionAttempt::Existing(_)));
    assert!(matches!(original, ExecutionAttempt::Completed(_)));
    assert_eq!(std::fs::read_to_string(marker).unwrap(), "x");
    assert_eq!(audit.snapshot().executions.len(), 1);
}

#[tokio::test]
async fn records_timeout_and_output_limit_terminal_states() {
    let timeout_audit = AuditLog::in_memory();
    let timeout = service(timeout_audit.clone(), Duration::from_millis(30), 4096, 4096);
    let error = timeout
        .execute(ShellCommand::new("sleep 10"))
        .await
        .unwrap_err();
    assert!(matches!(error, ShellError::Timeout));
    assert_eq!(
        timeout_audit.snapshot().executions[0].status,
        ExecutionStatus::TimedOut
    );

    let output_audit = AuditLog::in_memory();
    let output = service(output_audit.clone(), Duration::from_secs(2), 4, 4096);
    let error = output
        .execute(ShellCommand::new("printf 12345"))
        .await
        .unwrap_err();
    assert!(matches!(error, ShellError::OutputLimit));
    assert_eq!(
        output_audit.snapshot().executions[0].status,
        ExecutionStatus::OutputLimit
    );
}

#[tokio::test]
async fn records_non_zero_exit_as_a_completed_failed_command() {
    let audit = AuditLog::in_memory();
    let executor = service(audit.clone(), Duration::from_secs(2), 4096, 4096);

    let output = executor
        .execute(ShellCommand::new("printf nope >&2; exit 7"))
        .await
        .unwrap();

    assert_eq!(output.code, 7);
    assert_eq!(output.stderr, "nope");
    assert_eq!(
        audit.snapshot().executions[0].status,
        ExecutionStatus::Failed
    );
    assert_eq!(audit.snapshot().executions[0].stderr, "nope");
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn agora_runtime_executes_and_records_detailed_events() {
    let directory = tempfile::tempdir().unwrap();
    let audit = AuditLog::in_memory();
    let runtime = super::AgoraRuntime::new_for_test(directory.path()).unwrap();
    let executor = ExecutionService::new(
        Arc::new(runtime),
        audit.clone(),
        Duration::from_secs(20),
        4096,
        4096,
    );

    let output = executor
        .execute(ShellCommand::new("/usr/bin/printf sandbox-ready"))
        .await
        .unwrap();

    assert_eq!(output.code, 0);
    assert_eq!(output.stdout, "sandbox-ready");
    let snapshot = audit.snapshot();
    assert_eq!(snapshot.executions[0].status, ExecutionStatus::Succeeded);
    let boundary = snapshot.executions[0]
        .user_command_started_at_ms
        .expect("Agora should record the user-command boundary");
    assert!(snapshot.events.iter().any(|event| {
        event.timestamp_ms >= boundary
            && matches!(
                &event.data,
                crate::audit::AuditEventData::Process { executable, .. }
                    if executable == "/usr/bin/printf"
            )
    }));
    assert!(
        !serde_json::to_string(&snapshot.events)
            .unwrap()
            .contains("chatbrowserx-user-command-")
    );
    assert!(snapshot.executions[0].process_events > 0);
}
