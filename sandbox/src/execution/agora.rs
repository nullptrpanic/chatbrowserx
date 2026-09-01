use super::{BoxReader, RunningCommand, RuntimeContext, RuntimeExit, ShellCommand, ShellRuntime};
use crate::config::{FilesystemSettings, LocalFilesystemSettings, SandboxSettings, TlsSettings};
use agora_sandbox::callback::{Decision, Event};
use agora_sandbox::network::TlsMode;
use agora_sandbox::runner::{
    Sandbox, SandboxChild, SandboxCommand, SandboxConfig, SmbRemoteConfig,
};
use anyhow::{Context, Result};
use async_trait::async_trait;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};

pub(crate) struct AgoraRuntime {
    config: SandboxConfig,
}

impl AgoraRuntime {
    pub(crate) fn new(settings: &SandboxSettings) -> Result<Self> {
        let hook = agora_sandbox::hook_library::materialize(settings.workspace())
            .context("failed to prepare Agora sandbox hook")?;
        Ok(Self {
            config: sandbox_config(settings, hook)?,
        })
    }

    #[cfg(test)]
    fn from_parts(
        workspace: &Path,
        filesystem: &FilesystemSettings,
        tls: TlsSettings,
    ) -> Result<Self> {
        let hook = agora_sandbox::hook_library::materialize(workspace)
            .context("failed to prepare Agora sandbox hook")?;
        Ok(Self {
            config: filesystem_config(workspace, filesystem, tls, hook)?,
        })
    }

    #[cfg(test)]
    pub(crate) fn new_for_test(workspace: &Path) -> Result<Self> {
        Self::from_parts(workspace, &FilesystemSettings::default(), TlsSettings::Off)
    }
}

fn sandbox_config(settings: &SandboxSettings, hook: PathBuf) -> Result<SandboxConfig> {
    filesystem_config(
        settings.workspace(),
        settings.filesystem(),
        settings.tls(),
        hook,
    )
}

fn filesystem_config(
    workspace: &Path,
    filesystem: &FilesystemSettings,
    tls: TlsSettings,
    hook: PathBuf,
) -> Result<SandboxConfig> {
    let mut config = SandboxConfig::new(hook).with_workdir(workspace);
    config = match filesystem.local() {
        LocalFilesystemSettings::Plain => config.with_plain_workspace(),
        LocalFilesystemSettings::Encrypted { key } => config.with_encrypted_workspace(key),
    };
    for root in filesystem.bypass() {
        config = config.with_native_passthrough_root(root);
    }
    for remote in filesystem.nfs() {
        let remote = SmbRemoteConfig::new(remote.dir(), remote.server(), remote.share())?
            .with_remote_path(remote.remote_path())?
            .with_credentials(remote.username(), remote.password());
        config = config.with_smb_remote(remote);
    }
    config.network.tls = match tls {
        TlsSettings::Off => TlsMode::Off,
        TlsSettings::Auto => TlsMode::Auto,
    };
    config.validate().context("invalid Agora sandbox config")?;
    Ok(config)
}

#[async_trait]
impl ShellRuntime for AgoraRuntime {
    async fn spawn(
        &self,
        request: ShellCommand,
        context: RuntimeContext,
    ) -> Result<Box<dyn RunningCommand>> {
        let marker = format!("chatbrowserx-user-command-{}", context.execution_id);
        let shell_command = format!("/usr/bin/true {marker}; {}", request.command);
        let mut command = SandboxCommand::new("/bin/bash")
            .args(["-lc", shell_command.as_str()])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (name, value) in request.env {
            command = command.env(name, value);
        }
        if let Some(cwd) = request.cwd {
            command = command.current_dir(cwd);
        }
        let marker_pid = Arc::new(AtomicU32::new(0));
        let callback = move |event: Event| {
            let context = context.clone();
            let marker = marker.clone();
            let marker_pid = Arc::clone(&marker_pid);
            async move {
                match crate::audit::agora::user_command_boundary(&event, &marker) {
                    Ok(Some(boundary)) => {
                        if marker_pid
                            .compare_exchange(
                                0,
                                boundary.marker_pid,
                                Ordering::AcqRel,
                                Ordering::Acquire,
                            )
                            .is_ok()
                        {
                            if let Err(error) = context.audit.record_user_command_started(
                                context.execution_id,
                                boundary.timestamp_ms,
                            ) {
                                let _ = marker_pid.compare_exchange(
                                    boundary.marker_pid,
                                    0,
                                    Ordering::AcqRel,
                                    Ordering::Acquire,
                                );
                                crate::logger::error!(
                                    "failed to record user command boundary: {error}"
                                );
                            } else {
                                return Decision::Allow;
                            }
                        }
                    }
                    Ok(None) => {}
                    Err(error) => {
                        crate::logger::error!("failed to inspect Agora audit marker: {error}");
                    }
                }
                let internal_pid = marker_pid.load(Ordering::Acquire);
                if internal_pid != 0 && crate::audit::agora::event_pid(&event) == internal_pid {
                    return Decision::Allow;
                }
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

#[cfg(test)]
mod tests {
    use crate::config::Config;

    const SECRET: &str = "0123456789abcdef0123456789abcdef";

    #[test]
    fn maps_local_bypass_and_smb_filesystems_into_agora() {
        let directory = tempfile::tempdir().unwrap();
        let workspace = directory.path().join("workspace");
        let bypass = directory.path().join("bypass");
        let remote_root = directory.path().join("remote");
        let hook = directory.path().join("hook.dylib");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&bypass).unwrap();
        std::fs::write(&hook, []).unwrap();
        let path = directory.path().join("sandbox.json");
        std::fs::write(
            &path,
            format!(
                r#"{{
                    "address": "127.0.0.1:43129",
                    "web_address": "127.0.0.1:43130",
                    "secret": "{SECRET}",
                    "log_file": "sandbox.log",
                    "timeout_seconds": 45,
                    "sandbox": {{
                        "workspace": "{}",
                        "log_file": "audit.jsonl",
                        "filesystem": {{
                            "bypass": ["{}"],
                            "local": {{
                                "encrypt": "encrypted",
                                "key": "test-only-key"
                            }},
                            "nfs": [{{
                                "type": "smb",
                                "dir": "{}",
                                "server": "smb://127.0.0.1:10445/workspace/team",
                                "username": "openclaw",
                                "password": "test-only-password"
                            }}]
                        }},
                        "tls": "off"
                    }}
                }}"#,
                workspace.display(),
                bypass.display(),
                remote_root.display(),
            ),
        )
        .unwrap();
        let config = Config::load(&path).unwrap();

        let agora = super::sandbox_config(config.sandbox().unwrap(), hook).unwrap();

        assert_eq!(
            agora.encrypted_workspace_key(),
            Some(b"test-only-key".as_slice())
        );
        assert!(agora.native_passthrough_roots().contains(&bypass));
        let remote = &agora.smb_remotes()[0];
        assert_eq!(remote.logical_root(), remote_root);
        assert_eq!(remote.server(), "127.0.0.1:10445");
        assert_eq!(remote.share(), "workspace");
        assert_eq!(remote.remote_path(), "team");
        assert_eq!(remote.username(), "openclaw");
    }
}
