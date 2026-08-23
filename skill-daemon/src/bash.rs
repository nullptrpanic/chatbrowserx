use std::collections::BTreeMap;
use std::fmt;
use std::path::PathBuf;
use std::time::Duration;
use tokio::process::Command;

pub(crate) struct BashCommand {
    pub(crate) command: String,
    pub(crate) cwd: Option<PathBuf>,
    pub(crate) env: BTreeMap<String, String>,
}

pub(crate) struct BashOutput {
    pub(crate) exit_code: i32,
    pub(crate) stdout: String,
    pub(crate) stderr: String,
}

#[derive(Debug)]
pub(crate) enum BashError {
    Execute(std::io::Error),
    Timeout,
}

impl fmt::Display for BashError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Execute(error) => write!(formatter, "failed to execute bash: {error}"),
            Self::Timeout => formatter.write_str("bash command timed out"),
        }
    }
}

impl std::error::Error for BashError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Execute(error) => Some(error),
            Self::Timeout => None,
        }
    }
}

pub(crate) async fn execute(
    request: BashCommand,
    timeout: Duration,
) -> Result<BashOutput, BashError> {
    let mut command = Command::new("/bin/bash");
    command
        .args(["-lc", &request.command])
        .envs(request.env)
        .kill_on_drop(true);
    if let Some(cwd) = request.cwd {
        command.current_dir(cwd);
    }
    let output = tokio::time::timeout(timeout, command.output())
        .await
        .map_err(|_| BashError::Timeout)?
        .map_err(BashError::Execute)?;
    Ok(BashOutput {
        exit_code: output.status.code().unwrap_or(1),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}
