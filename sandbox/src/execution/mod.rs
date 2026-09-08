#[cfg(target_os = "macos")]
mod agora;
mod direct;
mod runtime;

#[cfg(target_os = "macos")]
pub(crate) use agora::AgoraRuntime;
pub(crate) use direct::DirectRuntime;
pub(crate) use runtime::{BoxReader, RunningCommand, RuntimeContext, RuntimeExit, ShellRuntime};

use crate::audit::{AuditLog, ExecutionFinish, ExecutionRecord, ExecutionStart, ExecutionStatus};
use std::collections::BTreeMap;
use std::fmt;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::AsyncReadExt;
use tokio::time::{timeout, timeout_at};

const CLEANUP_TIMEOUT: Duration = Duration::from_secs(1);

pub(crate) fn select_runtime(
    sandbox: Option<&crate::config::SandboxSettings>,
) -> anyhow::Result<Arc<dyn ShellRuntime>> {
    #[cfg(target_os = "macos")]
    if let Some(settings) = sandbox {
        return Ok(Arc::new(AgoraRuntime::new(settings)?));
    }
    #[cfg(not(target_os = "macos"))]
    if let Some(settings) = sandbox {
        let _ = (settings.workspace(), settings.filesystem(), settings.tls());
    }
    Ok(Arc::new(DirectRuntime))
}

#[derive(Clone, Debug)]
pub(crate) struct ShellCommand {
    pub(crate) command: String,
    pub(crate) cwd: Option<PathBuf>,
    pub(crate) env: BTreeMap<String, String>,
}

impl ShellCommand {
    #[cfg(test)]
    pub(crate) fn new(command: impl Into<String>) -> Self {
        Self {
            command: command.into(),
            cwd: None,
            env: BTreeMap::new(),
        }
    }
}

#[derive(Debug)]
pub(crate) struct ShellOutput {
    pub(crate) code: i32,
    pub(crate) stdout: String,
    pub(crate) stderr: String,
}

#[derive(Debug)]
pub(crate) enum ExecutionAttempt {
    Completed(ShellOutput),
    Existing(Box<ExecutionRecord>),
}

#[derive(Debug)]
pub(crate) enum ShellError {
    Execute(anyhow::Error),
    Timeout,
    OutputLimit,
}

impl fmt::Display for ShellError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Execute(error) => write!(formatter, "failed to execute bash: {error}"),
            Self::Timeout => formatter.write_str("bash command timed out"),
            Self::OutputLimit => formatter.write_str("bash command output exceeded limit"),
        }
    }
}

impl std::error::Error for ShellError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Execute(error) => Some(error.as_ref()),
            Self::Timeout | Self::OutputLimit => None,
        }
    }
}

#[derive(Clone)]
pub(crate) struct ExecutionService {
    runtime: Arc<dyn ShellRuntime>,
    audit: AuditLog,
    timeout: Duration,
    stdout_limit: usize,
    stderr_limit: usize,
}

impl ExecutionService {
    pub(crate) fn new(
        runtime: Arc<dyn ShellRuntime>,
        audit: AuditLog,
        timeout: Duration,
        stdout_limit: usize,
        stderr_limit: usize,
    ) -> Self {
        Self {
            runtime,
            audit,
            timeout,
            stdout_limit,
            stderr_limit,
        }
    }

    #[cfg(test)]
    pub(crate) async fn execute(&self, command: ShellCommand) -> Result<ShellOutput, ShellError> {
        match self.execute_once(command, None).await? {
            ExecutionAttempt::Completed(output) => Ok(output),
            ExecutionAttempt::Existing(_) => {
                unreachable!("an execution without a request ID cannot already exist")
            }
        }
    }

    pub(crate) fn execution_by_request_id(
        &self,
        request_id: &str,
    ) -> anyhow::Result<Option<ExecutionRecord>> {
        self.audit.execution_by_request_id(request_id)
    }

    pub(crate) async fn execute_once(
        &self,
        command: ShellCommand,
        request_id: Option<&str>,
    ) -> Result<ExecutionAttempt, ShellError> {
        let started = Instant::now();
        let deadline = tokio::time::Instant::now() + self.timeout;
        let execution_id = match self
            .audit
            .start_execution_once(
                command.command.clone(),
                command.cwd.clone(),
                request_id.map(str::to_owned),
            )
            .map_err(ShellError::Execute)?
        {
            ExecutionStart::Started(id) => id,
            ExecutionStart::Existing(record) => return Ok(ExecutionAttempt::Existing(record)),
        };
        let context = RuntimeContext::new(execution_id, self.audit.clone());
        let mut running = match timeout_at(deadline, self.runtime.spawn(command, context)).await {
            Ok(Ok(running)) => running,
            result => {
                let error = match result {
                    Err(_) => ShellError::Timeout,
                    Ok(Err(error)) => ShellError::Execute(error),
                    Ok(Ok(_)) => unreachable!(),
                };
                self.finish(
                    execution_id,
                    if matches!(error, ShellError::Timeout) {
                        ExecutionStatus::TimedOut
                    } else {
                        ExecutionStatus::Failed
                    },
                    None,
                    started.elapsed(),
                    &CapturedOutput::default(),
                )?;
                return Err(error);
            }
        };
        self.audit
            .record_process_identity(execution_id, running.pid(), Some(std::process::id()))
            .map_err(ShellError::Execute)?;
        let Some(stdout) = running.take_stdout() else {
            let _ = timeout(CLEANUP_TIMEOUT, running.terminate()).await;
            self.finish(
                execution_id,
                ExecutionStatus::Failed,
                None,
                started.elapsed(),
                &CapturedOutput::default(),
            )?;
            return Err(ShellError::Execute(anyhow::anyhow!(
                "stdout pipe is unavailable"
            )));
        };
        let Some(stderr) = running.take_stderr() else {
            let _ = timeout(CLEANUP_TIMEOUT, running.terminate()).await;
            self.finish(
                execution_id,
                ExecutionStatus::Failed,
                None,
                started.elapsed(),
                &CapturedOutput::default(),
            )?;
            return Err(ShellError::Execute(anyhow::anyhow!(
                "stderr pipe is unavailable"
            )));
        };
        // All three futures are scoped to this execution. Cancellation drops the pipes,
        // while the borrowed buffers retain output already read; no detached reader tasks.
        let mut stdout_output = BoundedOutput::default();
        let mut stderr_output = BoundedOutput::default();
        let completion = timeout_at(deadline, async {
            let (exit, (), ()) = tokio::try_join!(
                async { running.wait().await.map_err(ShellError::Execute) },
                read_bounded(stdout, self.stdout_limit, &mut stdout_output),
                read_bounded(stderr, self.stderr_limit, &mut stderr_output),
            )?;
            Ok::<_, ShellError>(exit)
        })
        .await
        .unwrap_or(Err(ShellError::Timeout));
        let output = CapturedOutput {
            stdout: String::from_utf8_lossy(&stdout_output.bytes).into_owned(),
            stderr: String::from_utf8_lossy(&stderr_output.bytes).into_owned(),
            stdout_truncated: stdout_output.exceeded,
            stderr_truncated: stderr_output.exceeded,
        };
        let exit = match completion {
            Ok(exit) => exit,
            Err(error) => {
                let _ = timeout(CLEANUP_TIMEOUT, running.terminate()).await;
                self.finish(
                    execution_id,
                    match error {
                        ShellError::Timeout => ExecutionStatus::TimedOut,
                        ShellError::OutputLimit => ExecutionStatus::OutputLimit,
                        ShellError::Execute(_) => ExecutionStatus::Failed,
                    },
                    None,
                    started.elapsed(),
                    &output,
                )?;
                return Err(error);
            }
        };
        let status = if exit.code == 0 {
            ExecutionStatus::Succeeded
        } else {
            ExecutionStatus::Failed
        };
        self.finish(
            execution_id,
            status,
            Some(exit.code),
            started.elapsed(),
            &output,
        )?;
        Ok(ExecutionAttempt::Completed(ShellOutput {
            code: exit.code,
            stdout: output.stdout,
            stderr: output.stderr,
        }))
    }

    fn finish(
        &self,
        execution_id: crate::audit::ExecutionId,
        status: ExecutionStatus,
        exit_code: Option<i32>,
        duration: Duration,
        output: &CapturedOutput,
    ) -> Result<(), ShellError> {
        self.audit
            .finish_execution(
                execution_id,
                ExecutionFinish {
                    status,
                    exit_code,
                    duration_ms: duration.as_millis().try_into().unwrap_or(u64::MAX),
                    stdout: output.stdout.clone(),
                    stderr: output.stderr.clone(),
                    stdout_truncated: output.stdout_truncated,
                    stderr_truncated: output.stderr_truncated,
                },
            )
            .map_err(ShellError::Execute)
    }
}

#[derive(Default)]
struct BoundedOutput {
    bytes: Vec<u8>,
    exceeded: bool,
}

#[derive(Default)]
struct CapturedOutput {
    stdout: String,
    stderr: String,
    stdout_truncated: bool,
    stderr_truncated: bool,
}

async fn read_bounded(
    mut reader: BoxReader,
    limit: usize,
    output: &mut BoundedOutput,
) -> Result<(), ShellError> {
    let mut buffer = [0_u8; 8 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .await
            .map_err(|error| ShellError::Execute(error.into()))?;
        if read == 0 {
            break;
        }
        let remaining = limit.saturating_sub(output.bytes.len());
        output
            .bytes
            .extend_from_slice(&buffer[..read.min(remaining)]);
        if read > remaining {
            output.exceeded = true;
            return Err(ShellError::OutputLimit);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
