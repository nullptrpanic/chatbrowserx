#[cfg(target_os = "macos")]
pub(crate) mod agora;
mod model;
mod store;

#[cfg(any(target_os = "macos", test))]
pub(crate) use model::{AuditEvent, AuditEventData};
pub(crate) use model::{
    AuditSnapshot, AuditUpdate, ExecutionFinish, ExecutionId, ExecutionRecord, ExecutionStatus,
};
pub(crate) use store::AuditLog;

#[cfg(test)]
mod tests;
