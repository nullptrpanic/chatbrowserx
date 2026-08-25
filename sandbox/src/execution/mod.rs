#[cfg(target_os = "macos")]
mod agora;
mod direct;
mod runtime;

#[cfg(target_os = "macos")]
pub(crate) use agora::AgoraRuntime;
pub(crate) use direct::DirectRuntime;
pub(crate) use runtime::{BoxReader, RunningCommand, RuntimeContext, RuntimeExit, ShellRuntime};

use crate::audit::{AuditLog, ExecutionFinish, ExecutionStatus};
use std::collections::BTreeMap;
use std::fmt;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::AsyncReadExt;
use tokio::sync::mpsc;

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

    pub(crate) async fn execute(&self, command: ShellCommand) -> Result<ShellOutput, ShellError> {
        let started = Instant::now();
        let execution_id = self
            .audit
            .start_execution(command.command.clone(), command.cwd.clone())
            .map_err(ShellError::Execute)?;
        let context = RuntimeContext::new(execution_id, self.audit.clone());
        let mut running = match self.runtime.spawn(command, context).await {
            Ok(running) => running,
            Err(error) => {
                self.finish(
                    execution_id,
                    ExecutionStatus::Failed,
                    None,
                    started.elapsed(),
                    &CapturedOutput::default(),
                )?;
                return Err(ShellError::Execute(error));
            }
        };
        let Some(stdout) = running.take_stdout() else {
            let _ = running.terminate().await;
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
            let _ = running.terminate().await;
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
        let (overflow_sender, mut overflow_receiver) = mpsc::channel(1);
        let _overflow_guard = overflow_sender.clone();
        let stdout_reader = tokio::spawn(read_bounded(
            stdout,
            self.stdout_limit,
            overflow_sender.clone(),
        ));
        let stderr_reader = tokio::spawn(read_bounded(stderr, self.stderr_limit, overflow_sender));
        enum Completion {
            Exited(RuntimeExit),
            Overflow,
        }
        let completion = tokio::time::timeout(self.timeout, async {
            tokio::select! {
                result = running.wait() => result.map(Completion::Exited),
                _ = overflow_receiver.recv() => Ok(Completion::Overflow),
            }
        })
        .await;
        let exit = match completion {
            Err(_) => {
                let _ = running.terminate().await;
                let output = collect_output(stdout_reader, stderr_reader)
                    .await
                    .unwrap_or_default();
                self.finish(
                    execution_id,
                    ExecutionStatus::TimedOut,
                    None,
                    started.elapsed(),
                    &output,
                )?;
                return Err(ShellError::Timeout);
            }
            Ok(Ok(Completion::Overflow)) => {
                let _ = running.terminate().await;
                let output = collect_output(stdout_reader, stderr_reader)
                    .await
                    .unwrap_or_default();
                self.finish(
                    execution_id,
                    ExecutionStatus::OutputLimit,
                    None,
                    started.elapsed(),
                    &output,
                )?;
                return Err(ShellError::OutputLimit);
            }
            Ok(Ok(Completion::Exited(exit))) => exit,
            Ok(Err(error)) => {
                let _ = running.terminate().await;
                self.finish(
                    execution_id,
                    ExecutionStatus::Failed,
                    None,
                    started.elapsed(),
                    &CapturedOutput::default(),
                )?;
                return Err(ShellError::Execute(error));
            }
        };
        let output = match collect_output(stdout_reader, stderr_reader).await {
            Ok(output) => output,
            Err(error) => {
                self.finish(
                    execution_id,
                    ExecutionStatus::Failed,
                    Some(exit.code),
                    started.elapsed(),
                    &CapturedOutput::default(),
                )?;
                return Err(error);
            }
        };
        if output.stdout_truncated || output.stderr_truncated {
            self.finish(
                execution_id,
                ExecutionStatus::OutputLimit,
                None,
                started.elapsed(),
                &output,
            )?;
            return Err(ShellError::OutputLimit);
        }
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
        Ok(ShellOutput {
            code: exit.code,
            stdout: output.stdout,
            stderr: output.stderr,
        })
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

async fn collect_output(
    stdout: tokio::task::JoinHandle<Result<BoundedOutput, std::io::Error>>,
    stderr: tokio::task::JoinHandle<Result<BoundedOutput, std::io::Error>>,
) -> Result<CapturedOutput, ShellError> {
    let (stdout, stderr) = tokio::join!(join_reader(stdout), join_reader(stderr));
    let stdout = stdout?;
    let stderr = stderr?;
    Ok(CapturedOutput {
        stdout: String::from_utf8_lossy(&stdout.bytes).into_owned(),
        stderr: String::from_utf8_lossy(&stderr.bytes).into_owned(),
        stdout_truncated: stdout.exceeded,
        stderr_truncated: stderr.exceeded,
    })
}

async fn read_bounded(
    mut reader: BoxReader,
    limit: usize,
    overflow: mpsc::Sender<()>,
) -> Result<BoundedOutput, std::io::Error> {
    let mut bytes = Vec::with_capacity(limit.min(64 * 1024));
    let mut buffer = [0_u8; 8 * 1024];
    let mut exceeded = false;
    loop {
        let read = reader.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        if exceeded {
            continue;
        }
        let remaining = limit.saturating_sub(bytes.len());
        bytes.extend_from_slice(&buffer[..read.min(remaining)]);
        if read > remaining {
            exceeded = true;
            let _ = overflow.try_send(());
        }
    }
    Ok(BoundedOutput { bytes, exceeded })
}

async fn join_reader(
    reader: tokio::task::JoinHandle<Result<BoundedOutput, std::io::Error>>,
) -> Result<BoundedOutput, ShellError> {
    reader
        .await
        .map_err(|error| ShellError::Execute(anyhow::Error::new(error)))?
        .map_err(|error| ShellError::Execute(anyhow::Error::new(error)))
}

#[cfg(test)]
mod tests;
