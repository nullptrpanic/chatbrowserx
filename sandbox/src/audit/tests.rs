use super::{AuditEventData, AuditLog, ExecutionFinish, ExecutionStart, ExecutionStatus};

fn successful_finish() -> ExecutionFinish {
    ExecutionFinish {
        status: ExecutionStatus::Succeeded,
        exit_code: Some(0),
        duration_ms: 12,
        stdout: "completed output".to_owned(),
        stderr: String::new(),
        stdout_truncated: false,
        stderr_truncated: false,
    }
}

#[test]
fn clearing_a_running_command_only_hides_it_and_preserves_its_final_receipt() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("audit.jsonl");
    let log = AuditLog::open(&path).unwrap();
    let ExecutionStart::Started(id) = log
        .start_execution_once("printf done", None, Some("running".into()))
        .unwrap()
    else {
        panic!("expected start")
    };
    log.clear_executions().unwrap();
    assert_eq!(
        log.execution_by_request_id("running")
            .unwrap()
            .unwrap()
            .status,
        ExecutionStatus::Running
    );
    log.record_process_identity(id, Some(123), Some(1)).unwrap();
    log.finish_execution(id, successful_finish()).unwrap();
    assert!(log.snapshot().executions.is_empty());
    let record = log.execution_by_request_id("running").unwrap().unwrap();
    assert_eq!(record.status, ExecutionStatus::Succeeded);
    assert_eq!(record.stdout, "completed output");
    drop(log);
    let reloaded = AuditLog::open(&path).unwrap();
    assert!(reloaded.snapshot().executions.is_empty());
    assert_eq!(
        reloaded
            .execution_by_request_id("running")
            .unwrap()
            .unwrap()
            .stdout,
        "completed output"
    );
}

#[test]
fn evicting_visible_history_does_not_forget_execution_ids_or_running_commands() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("audit.jsonl");
    let log = AuditLog::open(&path).unwrap();
    let ExecutionStart::Started(id) = log
        .start_execution_once("printf done", None, Some("old".into()))
        .unwrap()
    else {
        panic!("expected start")
    };
    for index in 0..2_050 {
        let ExecutionStart::Started(new_id) = log
            .start_execution_once("true", None, Some(format!("later_{index}")))
            .unwrap()
        else {
            panic!("expected start")
        };
        log.finish_execution(new_id, successful_finish()).unwrap();
    }
    log.finish_execution(id, successful_finish()).unwrap();
    for log in [log, AuditLog::open(&path).unwrap()] {
        assert_eq!(
            log.execution_by_request_id("old").unwrap().unwrap().stdout,
            "completed output"
        );
        assert!(matches!(
            log.start_execution_once("must not run", None, Some("old".into()))
                .unwrap(),
            ExecutionStart::Existing(_)
        ));
    }
}

#[test]
fn preserves_shell_quotes_and_newlines_in_audited_input() {
    let command = "printf '%s\\n' 'a b'\nvalue=\"hello world\"; printf '%s' \"$value\"";
    let log = AuditLog::in_memory();
    log.start_execution(command, None).unwrap();
    assert_eq!(log.snapshot().executions[0].command, command);
}

#[test]
fn an_unavailable_archived_receipt_never_authorizes_redispatch() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("audit.jsonl");
    let log = AuditLog::open(&path).unwrap();
    let ExecutionStart::Started(id) = log
        .start_execution_once("printf done", None, Some("known".into()))
        .unwrap()
    else {
        panic!("expected start")
    };
    log.finish_execution(id, successful_finish()).unwrap();
    log.clear_executions().unwrap();
    std::fs::rename(&path, directory.path().join("audit.backup")).unwrap();

    assert!(log.execution_by_request_id("known").is_err());
    assert!(
        log.start_execution_once("must not run", None, Some("known".into()))
            .is_err()
    );
    assert!(log.snapshot().executions.is_empty());
}

#[test]
fn persists_and_reloads_command_lifecycle() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("audit.jsonl");
    let log = AuditLog::open(&path).unwrap();
    let id = log.start_execution("printf hello", None).unwrap();

    log.finish_execution(
        id,
        ExecutionFinish {
            status: ExecutionStatus::Succeeded,
            exit_code: Some(0),
            duration_ms: 12,
            stdout: "hello".to_owned(),
            stderr: String::new(),
            stdout_truncated: false,
            stderr_truncated: false,
        },
    )
    .unwrap();
    drop(log);

    let reloaded = AuditLog::open(&path).unwrap();
    let snapshot = reloaded.snapshot();
    assert_eq!(snapshot.executions.len(), 1);
    assert_eq!(snapshot.executions[0].id, id);
    assert_eq!(snapshot.executions[0].command, "printf hello");
    assert_eq!(snapshot.executions[0].status, ExecutionStatus::Succeeded);
    assert_eq!(snapshot.executions[0].exit_code, Some(0));
    assert_eq!(snapshot.executions[0].duration_ms, Some(12));
    assert_eq!(snapshot.executions[0].stdout, "hello");
}

#[test]
fn reserves_a_client_execution_id_once_and_recovers_it_after_reload() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("audit.jsonl");
    let log = AuditLog::open(&path).unwrap();
    let id = match log
        .start_execution_once(
            "printf hello",
            None,
            Some("sandboxExecution_stable-1".to_owned()),
        )
        .unwrap()
    {
        ExecutionStart::Started(id) => id,
        ExecutionStart::Existing(_) => panic!("first reservation must start an execution"),
    };
    match log
        .start_execution_once(
            "printf ignored",
            None,
            Some("sandboxExecution_stable-1".to_owned()),
        )
        .unwrap()
    {
        ExecutionStart::Existing(record) => assert_eq!(record.id, id),
        ExecutionStart::Started(_) => panic!("duplicate reservation must not start an execution"),
    }
    log.finish_execution(
        id,
        ExecutionFinish {
            status: ExecutionStatus::Succeeded,
            exit_code: Some(0),
            duration_ms: 12,
            stdout: "hello".to_owned(),
            stderr: String::new(),
            stdout_truncated: false,
            stderr_truncated: false,
        },
    )
    .unwrap();
    drop(log);

    let reloaded = AuditLog::open(&path).unwrap();
    let record = reloaded
        .execution_by_request_id("sandboxExecution_stable-1")
        .unwrap()
        .expect("stable execution receipt should survive restart");
    assert_eq!(record.id, id);
    assert_eq!(record.status, ExecutionStatus::Succeeded);
    assert_eq!(record.stdout, "hello");
}

#[test]
fn clearing_the_visible_audit_keeps_hidden_idempotency_receipts() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("audit.jsonl");
    let log = AuditLog::open(&path).unwrap();
    let id = match log
        .start_execution_once(
            "touch marker",
            None,
            Some("sandboxExecution_cleared".to_owned()),
        )
        .unwrap()
    {
        ExecutionStart::Started(id) => id,
        ExecutionStart::Existing(_) => panic!("first reservation must start an execution"),
    };
    log.finish_execution(
        id,
        ExecutionFinish {
            status: ExecutionStatus::Succeeded,
            exit_code: Some(0),
            duration_ms: 1,
            stdout: String::new(),
            stderr: String::new(),
            stdout_truncated: false,
            stderr_truncated: false,
        },
    )
    .unwrap();
    log.clear_executions().unwrap();
    assert!(log.snapshot().executions.is_empty());
    assert_eq!(
        log.execution_by_request_id("sandboxExecution_cleared")
            .unwrap()
            .unwrap()
            .status,
        ExecutionStatus::Succeeded
    );
    drop(log);

    let reloaded = AuditLog::open(&path).unwrap();
    assert!(reloaded.snapshot().executions.is_empty());
    assert!(matches!(
        reloaded
            .start_execution_once(
                "touch marker again",
                None,
                Some("sandboxExecution_cleared".to_owned()),
            )
            .unwrap(),
        ExecutionStart::Existing(_)
    ));
}

#[test]
fn persists_and_reloads_the_trusted_user_command_boundary() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("audit.jsonl");
    let log = AuditLog::open(&path).unwrap();
    let id = log.start_execution("printf hello", None).unwrap();

    log.record_user_command_started(id, 123).unwrap();
    drop(log);

    let reloaded = AuditLog::open(&path).unwrap();
    assert_eq!(
        reloaded.snapshot().executions[0].user_command_started_at_ms,
        Some(123)
    );
}

#[test]
fn persists_and_reloads_detailed_events() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("audit.jsonl");
    let log = AuditLog::open(&path).unwrap();
    let id = log.start_execution("cat /tmp/example", None).unwrap();
    log.record_event(
        id,
        100,
        AuditEventData::File {
            event: "open".to_owned(),
            pid: 10,
            ppid: Some(1),
            executable: "/bin/cat".to_owned(),
            path: "/tmp/example".to_owned(),
            access: Some("read".to_owned()),
        },
    )
    .unwrap();
    drop(log);

    let reloaded = AuditLog::open(&path).unwrap();
    let snapshot = reloaded.snapshot();

    assert_eq!(snapshot.events.len(), 1);
    assert_eq!(snapshot.events[0].execution_id, id);
    assert!(matches!(
        &snapshot.events[0].data,
        AuditEventData::File { event, path, .. }
            if event == "open" && path == "/tmp/example"
    ));
    assert_eq!(snapshot.executions[0].file_events, 1);
}

#[test]
fn reloads_process_context_from_detailed_events_without_rejecting_legacy_records() {
    use std::io::Write;

    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("audit.jsonl");
    let log = AuditLog::open(&path).unwrap();
    let id = log.start_execution("cat /tmp/example", None).unwrap();
    drop(log);

    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap();
    for event in [
        serde_json::json!({
            "record": "event",
            "data": {
                "sequence": 1,
                "execution_id": id,
                "timestamp_ms": 100,
                "kind": "file",
                "event": "open",
                "pid": 10,
                "ppid": 1,
                "executable": "/bin/cat",
                "path": "/tmp/example",
                "access": "read"
            }
        }),
        serde_json::json!({
            "record": "event",
            "data": {
                "sequence": 2,
                "execution_id": id,
                "timestamp_ms": 101,
                "kind": "network",
                "event": "connect_attempt",
                "pid": 11,
                "host": "legacy.test",
                "ip": "192.0.2.11",
                "port": 443,
                "result": "started"
            }
        }),
    ] {
        serde_json::to_writer(&mut file, &event).unwrap();
        file.write_all(b"\n").unwrap();
    }
    drop(file);

    let reloaded = AuditLog::open(&path).unwrap();
    let events = serde_json::to_value(reloaded.snapshot().events).unwrap();
    assert_eq!(events[0]["ppid"], 1);
    assert_eq!(events[0]["executable"], "/bin/cat");
    assert!(events[1].get("ppid").is_none());
    assert!(events[1].get("executable").is_none());
}

#[test]
fn assigns_monotonic_event_sequences_and_counts_by_kind() {
    let log = AuditLog::in_memory();
    let id = log.start_execution("true", None).unwrap();

    let first = log
        .record_event(
            id,
            100,
            AuditEventData::Process {
                event: "started".to_owned(),
                pid: 10,
                ppid: Some(1),
                executable: "/bin/bash".to_owned(),
                operation: None,
                arguments: Vec::new(),
                current_dir: None,
                status: None,
                error_code: None,
                error_message: None,
            },
        )
        .unwrap();
    let second = log
        .record_event(
            id,
            101,
            AuditEventData::File {
                event: "open".to_owned(),
                pid: 10,
                ppid: Some(1),
                executable: "/bin/bash".to_owned(),
                path: "/tmp/example".to_owned(),
                access: Some("read".to_owned()),
            },
        )
        .unwrap();

    assert_eq!(second.sequence, first.sequence + 1);
    let snapshot = log.snapshot();
    assert_eq!(snapshot.executions[0].process_events, 1);
    assert_eq!(snapshot.executions[0].file_events, 1);
    assert_eq!(snapshot.executions[0].network_events, 0);
}

#[test]
fn clearing_after_a_partial_tail_stays_cleared_after_another_restart() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("audit.jsonl");
    let log = AuditLog::open(&path).unwrap();
    let id = log.start_execution("true", None).unwrap();
    drop(log);
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap();
    file.write_all(b"{\"record\":\"event\"").unwrap();
    drop(file);

    let reloaded = AuditLog::open(&path).unwrap();

    assert_eq!(reloaded.snapshot().executions[0].id, id);
    assert_eq!(
        reloaded.snapshot().executions[0].status,
        ExecutionStatus::Interrupted
    );
    reloaded.clear_executions().unwrap();
    drop(reloaded);

    assert!(
        AuditLog::open(&path)
            .unwrap()
            .snapshot()
            .executions
            .is_empty()
    );
}

#[test]
fn a_receipt_written_after_a_partial_tail_survives_another_restart() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("audit.jsonl");
    std::fs::write(&path, b"{\"record\":\"execution\"").unwrap();
    let log = AuditLog::open(&path).unwrap();
    let ExecutionStart::Started(id) = log
        .start_execution_once("touch marker", None, Some("request-after-tail".to_owned()))
        .unwrap()
    else {
        panic!("first reservation must start an execution");
    };
    drop(log);

    let reloaded = AuditLog::open(&path).unwrap();
    let ExecutionStart::Existing(record) = reloaded
        .start_execution_once("touch marker", None, Some("request-after-tail".to_owned()))
        .unwrap()
    else {
        panic!("persisted reservation must not be dispatched twice");
    };
    assert_eq!(record.id, id);
    assert_eq!(record.status, ExecutionStatus::Interrupted);
}

#[test]
fn preserves_a_complete_unterminated_record_before_appending() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("audit.jsonl");
    let log = AuditLog::open(&path).unwrap();
    let first = log.start_execution("first", None).unwrap();
    drop(log);
    let bytes = std::fs::read(&path).unwrap();
    std::fs::write(&path, &bytes[..bytes.len() - 1]).unwrap();

    let log = AuditLog::open(&path).unwrap();
    let second = log.start_execution("second", None).unwrap();
    drop(log);

    let ids: Vec<_> = AuditLog::open(&path)
        .unwrap()
        .snapshot()
        .executions
        .iter()
        .map(|execution| execution.id)
        .collect();
    assert_eq!(ids, [first, second]);
}

#[test]
fn fails_closed_when_the_audit_log_cannot_be_fully_read() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("audit.jsonl");
    std::fs::write(&path, b"\xff\n").unwrap();

    // Returning an empty index here could authorize a previously dispatched request again.
    assert!(AuditLog::open(&path).is_err());
}

#[test]
fn subscribe_with_snapshot_does_not_miss_the_next_update() {
    let log = AuditLog::in_memory();
    let (_receiver, snapshot) = log.subscribe_with_snapshot();
    assert!(snapshot.executions.is_empty());

    let id = log.start_execution("true", None).unwrap();
    let (mut receiver, snapshot) = log.subscribe_with_snapshot();
    assert_eq!(snapshot.executions[0].id, id);

    log.finish_execution(
        id,
        ExecutionFinish {
            status: ExecutionStatus::Succeeded,
            exit_code: Some(0),
            duration_ms: 1,
            stdout: String::new(),
            stderr: String::new(),
            stdout_truncated: false,
            stderr_truncated: false,
        },
    )
    .unwrap();
    assert!(receiver.try_recv().is_ok());
}

#[test]
fn redacts_common_credentials_from_persisted_commands() {
    let log = AuditLog::in_memory();

    log.start_execution(
        "TOKEN=private curl --api-key secret -H 'Authorization: Bearer credential' https://example.test",
        None,
    )
    .unwrap();

    let command = &log.snapshot().executions[0].command;
    assert!(!command.contains("private"));
    assert!(!command.contains("secret"));
    assert!(!command.contains("credential"));
    assert!(command.contains("[redacted]"));
    assert!(command.starts_with("[redacted preview; not executable]"));
    assert!(command.contains("https://example.test"));
}
