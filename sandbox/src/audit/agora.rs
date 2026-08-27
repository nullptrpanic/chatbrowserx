use super::store::redact_arguments;
use super::{AuditEvent, AuditEventData, AuditLog, ExecutionId};
use agora_sandbox::callback::{
    Event, EventStatus, EventType, FileAccessMode, FileEvent, NetworkEvent, ProcessEvent,
    ProcessOperation,
};
use anyhow::{Context, Result};

pub(crate) struct UserCommandBoundary {
    pub(crate) timestamp_ms: u64,
    pub(crate) marker_pid: u32,
}

pub(crate) fn user_command_boundary(
    event: &Event,
    marker: &str,
) -> Result<Option<UserCommandBoundary>> {
    let Event::Process(event) = event else {
        return Ok(None);
    };
    if event.event_type != EventType::ProcessExecAttempt
        || event.command.executable != "/usr/bin/true"
        || event.command.arguments.len() != 2
        || event.command.arguments[1] != marker
    {
        return Ok(None);
    }
    Ok(Some(UserCommandBoundary {
        timestamp_ms: timestamp_ms(&event.occurred_at)?,
        marker_pid: event.process.pid,
    }))
}

pub(crate) fn event_pid(event: &Event) -> u32 {
    match event {
        Event::Process(event) => event.process.pid,
        Event::File(event) => event.process.pid,
        Event::Network(event) => event.process.pid,
    }
}

pub(crate) fn record(
    execution_id: ExecutionId,
    event: Event,
    audit: &AuditLog,
) -> Result<AuditEvent> {
    let (occurred_at, data) = match event {
        Event::Process(event) => process(event),
        Event::File(event) => file(event),
        Event::Network(event) => network(event),
    };
    audit.record_event(execution_id, timestamp_ms(&occurred_at)?, data)
}

fn timestamp_ms(occurred_at: &str) -> Result<u64> {
    chrono::DateTime::parse_from_rfc3339(occurred_at)
        .with_context(|| format!("invalid Agora event timestamp {occurred_at}"))?
        .timestamp_millis()
        .try_into()
        .context("Agora event timestamp is before the Unix epoch")
}

fn process(event: ProcessEvent) -> (String, AuditEventData) {
    let executable = if event.command.executable.is_empty() {
        event.process.executable.clone()
    } else {
        event.command.executable.clone()
    };
    (
        event.occurred_at,
        AuditEventData::Process {
            event: event_type(event.event_type),
            pid: event.process.pid,
            ppid: nonzero(event.process.ppid),
            executable,
            operation: Some(process_operation(event.command.operation).to_owned()),
            arguments: redact_arguments(&event.command.arguments),
            current_dir: (!event.command.current_dir.is_empty())
                .then_some(event.command.current_dir),
            status: Some(event_status(event.result.status).to_owned()),
            error_code: event.result.error_code,
            error_message: event.result.error_message,
        },
    )
}

fn file(event: FileEvent) -> (String, AuditEventData) {
    (
        event.occurred_at,
        AuditEventData::File {
            event: event_type(event.event_type),
            pid: event.process.pid,
            ppid: nonzero(event.process.ppid),
            executable: event.process.executable,
            path: event.file.path,
            access: Some(
                match event.file.mode.access {
                    FileAccessMode::Read => "read",
                    FileAccessMode::Write => "write",
                    FileAccessMode::ReadWrite => "read_write",
                }
                .to_owned(),
            ),
        },
    )
}

fn network(event: NetworkEvent) -> (String, AuditEventData) {
    let process = event.process;
    let (host, ip, port) = match event.network {
        Some(network) => {
            let host = network
                .domain
                .or(network.tls_sni)
                .or(network.http_host)
                .or_else(|| network.target.map(|target| target.host));
            (
                host,
                Some(network.destination_ip.to_string()),
                Some(network.destination_port),
            )
        }
        None => (None, None, None),
    };
    (
        event.occurred_at,
        AuditEventData::Network {
            event: event_type(event.event_type),
            pid: process.pid,
            ppid: nonzero(process.ppid),
            executable: process.executable,
            host,
            ip,
            port,
            result: Some(event_status(event.result.status).to_owned()),
        },
    )
}

fn event_type(event: EventType) -> String {
    match event {
        EventType::NetworkConnectAttempt => "connect_attempt",
        EventType::NetworkConnectDenied => "connect_denied",
        EventType::NetworkConnectEstablished => "connect_established",
        EventType::NetworkConnectFailed => "connect_failed",
        EventType::NetworkConnectionClosed => "connection_closed",
        EventType::FilesystemOpen => "open",
        EventType::FilesystemClose => "close",
        EventType::ProcessStarted => "started",
        EventType::ProcessExecAttempt => "exec",
        EventType::ProcessExited => "exited",
    }
    .to_owned()
}

fn event_status(status: EventStatus) -> &'static str {
    match status {
        EventStatus::Started => "started",
        EventStatus::Succeeded => "succeeded",
        EventStatus::Failed => "failed",
        EventStatus::Denied => "denied",
        EventStatus::Interrupted => "interrupted",
    }
}

fn process_operation(operation: ProcessOperation) -> &'static str {
    match operation {
        ProcessOperation::PosixSpawn => "posix_spawn",
        ProcessOperation::PosixSpawnp => "posix_spawnp",
        ProcessOperation::Execve => "execve",
        ProcessOperation::Execv => "execv",
        ProcessOperation::Execvp => "execvp",
    }
}

fn nonzero(value: u32) -> Option<u32> {
    (value != 0).then_some(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use agora_sandbox::callback::{FileEvent, NetworkEvent, ProcessEvent};
    use serde_json::json;

    #[test]
    fn recognizes_only_the_exact_internal_user_command_marker() {
        let marker = "chatbrowserx-user-command-run-123";
        let process = json!({
            "schema_version": 9,
            "event_id": "event",
            "occurred_at": "2026-08-25T08:00:00.123Z",
            "subsystem": "process",
            "event_type": "process.exec.attempt",
            "sandbox_id": "sandbox",
            "run_id": "run",
            "trace_id": "trace",
            "process": {"pid": 42, "ppid": 10, "executable": "/bin/bash"},
            "command": {
                "executable": "/usr/bin/true",
                "arguments": ["true", marker],
                "current_dir": "/workspace",
                "operation": "execve"
            },
            "result": {"status": "started", "error_code": null, "error_message": null}
        });
        let event = Event::Process(serde_json::from_value::<ProcessEvent>(process).unwrap());

        let boundary = user_command_boundary(&event, marker).unwrap().unwrap();
        assert_eq!(boundary.timestamp_ms, 1_787_644_800_123);
        assert_eq!(boundary.marker_pid, 42);
        assert!(
            user_command_boundary(&event, "different-marker")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn normalizes_process_file_and_network_events() {
        let audit = AuditLog::in_memory();
        let execution = audit.start_execution("true", None).unwrap();
        let common = json!({
            "schema_version": 9,
            "event_id": "event",
            "occurred_at": "2026-08-25T08:00:00Z",
            "sandbox_id": "sandbox",
            "run_id": "run",
            "trace_id": "trace",
            "process": {"pid": 42, "ppid": 10, "executable": "/bin/bash"},
            "result": {"status": "succeeded", "error_code": null, "error_message": null}
        });
        let mut process = common.clone();
        process["subsystem"] = json!("process");
        process["event_type"] = json!("process.exec.attempt");
        process["command"] = json!({
            "executable": "/usr/bin/curl",
            "arguments": ["curl", "https://example.com"],
            "current_dir": "/workspace",
            "operation": "execve"
        });
        record(
            execution,
            Event::Process(serde_json::from_value::<ProcessEvent>(process).unwrap()),
            &audit,
        )
        .unwrap();

        let mut file = common.clone();
        file["subsystem"] = json!("filesystem");
        file["event_type"] = json!("filesystem.open");
        file["file"] = json!({
            "path": "/workspace/input.txt",
            "mode": {
                "access": "read",
                "create": false,
                "truncate": false,
                "append": false,
                "exclusive": false
            }
        });
        record(
            execution,
            Event::File(serde_json::from_value::<FileEvent>(file).unwrap()),
            &audit,
        )
        .unwrap();

        let mut network = common;
        network["subsystem"] = json!("network");
        network["event_type"] = json!("network.connect.established");
        network["connection_id"] = json!("connection");
        network["sequence"] = json!(1);
        network["network"] = json!({
            "protocol": "tcp",
            "destination_ip": "93.184.216.34",
            "destination_port": 443,
            "target_host": "example.com",
            "target_port": 443,
            "http_host": null,
            "tls_sni": "example.com",
            "domain": "example.com",
            "domain_source": "tls_sni"
        });
        network["tls"] = serde_json::Value::Null;
        network["decision"] = serde_json::Value::Null;
        network["metrics"] = serde_json::Value::Null;
        record(
            execution,
            Event::Network(serde_json::from_value::<NetworkEvent>(network).unwrap()),
            &audit,
        )
        .unwrap();

        let snapshot = audit.snapshot();
        assert_eq!(snapshot.events.len(), 3);
        let file = serde_json::to_value(&snapshot.events[1]).unwrap();
        let network = serde_json::to_value(&snapshot.events[2]).unwrap();
        assert_eq!(file["pid"], 42);
        assert_eq!(file["ppid"], 10);
        assert_eq!(file["executable"], "/bin/bash");
        assert_eq!(network["pid"], 42);
        assert_eq!(network["ppid"], 10);
        assert_eq!(network["executable"], "/bin/bash");
        assert!(matches!(
            &snapshot.events[0].data,
            AuditEventData::Process {
                pid: 42,
                executable,
                operation,
                arguments,
                current_dir,
                status,
                ..
            } if executable == "/usr/bin/curl"
                && operation.as_deref() == Some("execve")
                && arguments == &["curl", "https://example.com"]
                && current_dir.as_deref() == Some("/workspace")
                && status.as_deref() == Some("succeeded")
        ));
        assert!(matches!(
            &snapshot.events[1].data,
            AuditEventData::File { pid: 42, path, access, .. }
                if path == "/workspace/input.txt" && access.as_deref() == Some("read")
        ));
        assert!(matches!(
            &snapshot.events[2].data,
            AuditEventData::Network { pid: 42, host, port, .. }
                if host.as_deref() == Some("example.com") && *port == Some(443)
        ));
    }
}
