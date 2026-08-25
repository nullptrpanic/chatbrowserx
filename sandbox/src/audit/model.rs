use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use uuid::Uuid;

pub(crate) type ExecutionId = Uuid;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ExecutionStatus {
    Running,
    Interrupted,
    Succeeded,
    Failed,
    TimedOut,
    OutputLimit,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ExecutionRecord {
    pub(crate) id: ExecutionId,
    pub(crate) command: String,
    pub(crate) cwd: Option<PathBuf>,
    pub(crate) started_at_ms: u64,
    pub(crate) finished_at_ms: Option<u64>,
    pub(crate) duration_ms: Option<u64>,
    pub(crate) status: ExecutionStatus,
    pub(crate) exit_code: Option<i32>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub(crate) stdout: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub(crate) stderr: String,
    #[serde(default, skip_serializing_if = "is_false")]
    pub(crate) stdout_truncated: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub(crate) stderr_truncated: bool,
    pub(crate) process_events: u64,
    pub(crate) file_events: u64,
    pub(crate) network_events: u64,
}

#[derive(Clone, Debug)]
pub(crate) struct ExecutionFinish {
    pub(crate) status: ExecutionStatus,
    pub(crate) exit_code: Option<i32>,
    pub(crate) duration_ms: u64,
    pub(crate) stdout: String,
    pub(crate) stderr: String,
    pub(crate) stdout_truncated: bool,
    pub(crate) stderr_truncated: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum AuditEventData {
    Process {
        event: String,
        pid: u32,
        ppid: Option<u32>,
        executable: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        operation: Option<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        arguments: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        current_dir: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        status: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error_code: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error_message: Option<String>,
    },
    File {
        event: String,
        pid: u32,
        path: String,
        access: Option<String>,
    },
    Network {
        event: String,
        pid: u32,
        host: Option<String>,
        ip: Option<String>,
        port: Option<u16>,
        result: Option<String>,
    },
}

impl AuditEventData {
    pub(super) fn increment_count(&self, execution: &mut ExecutionRecord) {
        match self {
            Self::Process { .. } => execution.process_events += 1,
            Self::File { .. } => execution.file_events += 1,
            Self::Network { .. } => execution.network_events += 1,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct AuditEvent {
    pub(crate) sequence: u64,
    pub(crate) execution_id: ExecutionId,
    pub(crate) timestamp_ms: u64,
    #[serde(flatten)]
    pub(crate) data: AuditEventData,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct AuditSnapshot {
    pub(crate) executions: Vec<ExecutionRecord>,
    pub(crate) events: Vec<AuditEvent>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum AuditUpdate {
    Execution {
        execution: ExecutionRecord,
    },
    #[cfg(any(target_os = "macos", test))]
    Event {
        event: AuditEvent,
    },
    EventsCleared {
        execution_id: ExecutionId,
    },
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "record", content = "data", rename_all = "snake_case")]
pub(super) enum PersistedRecord {
    Execution(ExecutionRecord),
    Event(AuditEvent),
    EventsCleared { execution_id: ExecutionId },
}

fn is_false(value: &bool) -> bool {
    !value
}
