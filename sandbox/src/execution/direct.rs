use super::{BoxReader, RunningCommand, RuntimeContext, RuntimeExit, ShellCommand, ShellRuntime};
use anyhow::{Context, Result};
use async_trait::async_trait;
use std::process::Stdio;
use tokio::process::{Child, Command};

pub(crate) struct DirectRuntime;

#[async_trait]
impl ShellRuntime for DirectRuntime {
    async fn spawn(
        &self,
        request: ShellCommand,
        _context: RuntimeContext,
    ) -> Result<Box<dyn RunningCommand>> {
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
        let child = command.spawn().context("failed to spawn /bin/bash")?;
        Ok(Box::new(DirectCommand { child }))
    }
}

struct DirectCommand {
    child: Child,
}

#[async_trait]
impl RunningCommand for DirectCommand {
    fn pid(&self) -> Option<u32> {
        self.child.id()
    }

    fn take_stdout(&mut self) -> Option<BoxReader> {
        self.child
            .stdout
            .take()
            .map(|stdout| Box::pin(stdout) as BoxReader)
    }

    fn take_stderr(&mut self) -> Option<BoxReader> {
        self.child
            .stderr
            .take()
            .map(|stderr| Box::pin(stderr) as BoxReader)
    }

    async fn wait(&mut self) -> Result<RuntimeExit> {
        let status = self
            .child
            .wait()
            .await
            .context("failed to wait for command")?;
        Ok(RuntimeExit {
            code: status.code().unwrap_or(1),
        })
    }

    async fn terminate(&mut self) -> Result<()> {
        #[cfg(unix)]
        if let Some(process_id) = self.child.id() {
            unsafe {
                libc::kill(-(process_id as i32), libc::SIGKILL);
            }
        }
        let _ = self.child.kill().await;
        let _ = self.child.wait().await;
        Ok(())
    }
}
