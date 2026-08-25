use super::{BoxReader, RunningCommand, RuntimeContext, RuntimeExit, ShellCommand, ShellRuntime};
use crate::config::{FilesystemSettings, SandboxSettings, TlsSettings};
use agora_sandbox::callback::{Decision, Event};
use agora_sandbox::network::TlsMode;
use agora_sandbox::runner::{Sandbox, SandboxChild, SandboxCommand, SandboxConfig};
use anyhow::{Context, Result};
use async_trait::async_trait;
use std::path::Path;
use std::process::Stdio;

pub(crate) struct AgoraRuntime {
    config: SandboxConfig,
}

impl AgoraRuntime {
    pub(crate) fn new(settings: &SandboxSettings) -> Result<Self> {
        Self::from_parts(settings.workspace(), settings.filesystem(), settings.tls())
    }

    fn from_parts(
        workspace: &Path,
        filesystem: &FilesystemSettings,
        tls: TlsSettings,
    ) -> Result<Self> {
        let hook = agora_sandbox::hook_library::materialize(workspace)
            .context("failed to prepare Agora sandbox hook")?;
        let mut config = SandboxConfig::new(hook).with_workdir(workspace);
        config = match filesystem {
            FilesystemSettings::Plain => config.with_plain_workspace(),
            FilesystemSettings::Encrypted { key } => config.with_encrypted_workspace(key),
        };
        config.network.tls = match tls {
            TlsSettings::Off => TlsMode::Off,
            TlsSettings::Auto => TlsMode::Auto,
        };
        config.validate().context("invalid Agora sandbox config")?;
        Ok(Self { config })
    }

    #[cfg(test)]
    pub(crate) fn new_for_test(workspace: &Path) -> Result<Self> {
        Self::from_parts(workspace, &FilesystemSettings::Plain, TlsSettings::Off)
    }
}

#[async_trait]
impl ShellRuntime for AgoraRuntime {
    async fn spawn(
        &self,
        request: ShellCommand,
        context: RuntimeContext,
    ) -> Result<Box<dyn RunningCommand>> {
        let mut command = SandboxCommand::new("/bin/bash")
            .args(["-lc", request.command.as_str()])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (name, value) in request.env {
            command = command.env(name, value);
        }
        if let Some(cwd) = request.cwd {
            command = command.current_dir(cwd);
        }
        let callback = move |event: Event| {
            let context = context.clone();
            async move {
                if let Err(error) =
                    crate::audit::agora::record(context.execution_id, event, &context.audit)
                {
                    crate::logger::error!("failed to record Agora audit event: {error}");
                }
                Decision::Allow
            }
        };
        let child = Sandbox::new(self.config.clone(), callback)
            .spawn(command)
            .await
            .context("failed to spawn Agora sandbox command")?;
        Ok(Box::new(AgoraCommand { child }))
    }
}

struct AgoraCommand {
    child: SandboxChild,
}

#[async_trait]
impl RunningCommand for AgoraCommand {
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
        let outcome = self.child.wait().await.context("Agora command failed")?;
        Ok(RuntimeExit {
            code: outcome.status().code().unwrap_or(1),
        })
    }

    async fn terminate(&mut self) -> Result<()> {
        let _ = self.child.kill().await;
        let _ = self.child.wait().await;
        Ok(())
    }
}
