use std::collections::BTreeMap;
use std::fmt;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use tokio::sync::mpsc;

pub(crate) struct BashCommand {
    pub(crate) command: String,
    pub(crate) cwd: Option<PathBuf>,
    pub(crate) env: BTreeMap<String, String>,
}

pub(crate) struct BashOutput {
    pub(crate) code: i32,
    pub(crate) stdout: String,
    pub(crate) stderr: String,
}

#[derive(Debug)]
pub(crate) enum BashError {
    Execute(std::io::Error),
    Timeout,
    OutputLimit,
}

impl fmt::Display for BashError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Execute(error) => write!(formatter, "failed to execute bash: {error}"),
            Self::Timeout => formatter.write_str("bash command timed out"),
            Self::OutputLimit => formatter.write_str("bash command output exceeded limit"),
        }
    }
}

impl std::error::Error for BashError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Execute(error) => Some(error),
            Self::Timeout | Self::OutputLimit => None,
        }
    }
}

struct BoundedOutput {
    bytes: Vec<u8>,
    exceeded: bool,
}

async fn read_bounded<R>(
    mut reader: R,
    limit: usize,
    overflow: mpsc::Sender<()>,
) -> Result<BoundedOutput, std::io::Error>
where
    R: AsyncRead + Unpin,
{
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

async fn terminate_process_group(child: &mut tokio::process::Child, process_id: Option<u32>) {
    #[cfg(unix)]
    if let Some(process_id) = process_id {
        unsafe {
            libc::kill(-(process_id as i32), libc::SIGKILL);
        }
    }
    let _ = child.kill().await;
    let _ = child.wait().await;
}

pub(crate) async fn execute(
    request: BashCommand,
    timeout: Duration,
    stdout_limit: usize,
    stderr_limit: usize,
) -> Result<BashOutput, BashError> {
    let mut command = Command::new("/bin/bash");
    command
        .args(["-lc", &request.command])
        .envs(request.env)
        .kill_on_drop(true)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    command.process_group(0);
    if let Some(cwd) = request.cwd {
        command.current_dir(cwd);
    }
    let mut child = command.spawn().map_err(BashError::Execute)?;
    let process_id = child.id();
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| BashError::Execute(std::io::Error::other("stdout pipe is unavailable")))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| BashError::Execute(std::io::Error::other("stderr pipe is unavailable")))?;
    let (overflow_sender, mut overflow_receiver) = mpsc::channel(1);
    // Keep the channel open until the command finishes so EOF on both pipes is
    // not mistaken for an output-overflow notification.
    let _overflow_guard = overflow_sender.clone();
    let stdout_reader = tokio::spawn(read_bounded(stdout, stdout_limit, overflow_sender.clone()));
    let stderr_reader = tokio::spawn(read_bounded(stderr, stderr_limit, overflow_sender));
    enum Completion {
        Exited(std::process::ExitStatus),
        Overflow,
    }
    let completion = tokio::time::timeout(timeout, async {
        tokio::select! {
            status = child.wait() => status.map(Completion::Exited),
            _ = overflow_receiver.recv() => Ok(Completion::Overflow),
        }
    })
    .await;
    let status = match completion {
        Err(_) => {
            terminate_process_group(&mut child, process_id).await;
            let _ = stdout_reader.await;
            let _ = stderr_reader.await;
            return Err(BashError::Timeout);
        }
        Ok(Ok(Completion::Overflow)) => {
            terminate_process_group(&mut child, process_id).await;
            let _ = stdout_reader.await;
            let _ = stderr_reader.await;
            return Err(BashError::OutputLimit);
        }
        Ok(Ok(Completion::Exited(status))) => status,
        Ok(Err(error)) => return Err(BashError::Execute(error)),
    };
    let stdout = stdout_reader
        .await
        .map_err(|error| BashError::Execute(std::io::Error::other(error)))?
        .map_err(BashError::Execute)?;
    let stderr = stderr_reader
        .await
        .map_err(|error| BashError::Execute(std::io::Error::other(error)))?
        .map_err(BashError::Execute)?;
    if stdout.exceeded || stderr.exceeded {
        return Err(BashError::OutputLimit);
    }
    Ok(BashOutput {
        code: status.code().unwrap_or(1),
        stdout: String::from_utf8_lossy(&stdout.bytes).into_owned(),
        stderr: String::from_utf8_lossy(&stderr.bytes).into_owned(),
    })
}
