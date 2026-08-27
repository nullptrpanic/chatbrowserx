use super::{AuditEventData, AuditLog, ExecutionFinish, ExecutionStatus};

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
fn ignores_a_malformed_partial_tail_when_reloading() {
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
    assert!(command.contains("https://example.test"));
}
