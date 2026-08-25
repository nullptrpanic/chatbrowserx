use super::store::redact_arguments;
use super::{AuditEvent, AuditEventData, AuditLog, ExecutionId};
use agora_sandbox::callback::{
    Event, EventStatus, EventType, FileAccessMode, FileEvent, NetworkEvent, ProcessEvent,
    ProcessOperation,
};
use anyhow::{Context, Result};

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
    let timestamp_ms = chrono::DateTime::parse_from_rfc3339(&occurred_at)
        .with_context(|| format!("invalid Agora event timestamp {occurred_at}"))?
        .timestamp_millis()
        .try_into()
        .context("Agora event timestamp is before the Unix epoch")?;
    audit.record_event(execution_id, timestamp_ms, data)
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
            pid: event.process.pid,
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
