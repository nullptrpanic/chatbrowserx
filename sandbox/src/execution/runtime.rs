use super::ShellCommand;
use crate::audit::{AuditLog, ExecutionId};
use async_trait::async_trait;
use std::pin::Pin;
use tokio::io::AsyncRead;

pub(crate) type BoxReader = Pin<Box<dyn AsyncRead + Send>>;

#[derive(Clone)]
pub(crate) struct RuntimeContext {
    #[cfg(target_os = "macos")]
    pub(crate) execution_id: ExecutionId,
    #[cfg(target_os = "macos")]
    pub(crate) audit: AuditLog,
}

impl RuntimeContext {
    pub(crate) fn new(execution_id: ExecutionId, audit: AuditLog) -> Self {
        #[cfg(target_os = "macos")]
        {
            Self {
                execution_id,
                audit,
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (execution_id, audit);
            Self {}
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct RuntimeExit {
    pub(crate) code: i32,
}

#[async_trait]
pub(crate) trait ShellRuntime: Send + Sync {
    async fn spawn(
        &self,
        command: ShellCommand,
        context: RuntimeContext,
    ) -> anyhow::Result<Box<dyn RunningCommand>>;
}

#[async_trait]
pub(crate) trait RunningCommand: Send {
    fn take_stdout(&mut self) -> Option<BoxReader>;
    fn take_stderr(&mut self) -> Option<BoxReader>;
    async fn wait(&mut self) -> anyhow::Result<RuntimeExit>;
    async fn terminate(&mut self) -> anyhow::Result<()>;
}
