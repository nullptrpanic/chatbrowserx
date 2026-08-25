#[cfg(any(target_os = "macos", test))]
use crate::audit::AuditEvent;
use crate::audit::{AuditSnapshot, ExecutionId, ExecutionRecord};
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(super) enum ClientMessage {
    Auth { token: String },
    ClearEvents { execution_id: ExecutionId },
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(super) enum ServerMessage {
    Snapshot {
        snapshot: AuditSnapshot,
    },
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
    Error {
        message: String,
    },
}
