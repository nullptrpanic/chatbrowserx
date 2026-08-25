use anyhow::{Context, Result, bail};
use serde::Deserialize;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::time::Duration;

pub(crate) struct Config {
    address: SocketAddr,
    web_address: SocketAddr,
    secret: String,
    log_file: PathBuf,
    timeout: Duration,
    sandbox: Option<SandboxSettings>,
}

impl Config {
    pub(crate) fn load(path: &Path) -> Result<Self> {
        let path = if path.is_absolute() {
            path.to_path_buf()
        } else {
            std::env::current_dir()
                .context("failed to resolve current directory")?
                .join(path)
        };
        let file = std::fs::File::open(&path)
            .with_context(|| format!("failed to open sandbox config {}", path.display()))?;
        let stored: StoredConfig = serde_json::from_reader(file)
            .with_context(|| format!("failed to parse sandbox config {}", path.display()))?;
        if stored.timeout_seconds == 0 {
            bail!("sandbox config timeout_seconds must be greater than zero");
        }
        crate::auth::validate_secret(&stored.secret)?;
        let directory = path.parent().unwrap_or(Path::new("/"));
        let log_file = if stored.log_file.is_absolute() {
            stored.log_file
        } else {
            directory.join(stored.log_file)
        };
        let sandbox = stored
            .sandbox
            .map(|sandbox| SandboxSettings::resolve(directory, sandbox))
            .transpose()?;
        Ok(Self {
            address: stored.address,
            web_address: stored.web_address,
            secret: stored.secret,
            log_file,
            timeout: Duration::from_secs(stored.timeout_seconds),
            sandbox,
        })
    }

    pub(crate) fn address(&self) -> SocketAddr {
        self.address
    }

    pub(crate) fn web_address(&self) -> SocketAddr {
        self.web_address
    }

    pub(crate) fn log_file(&self) -> &Path {
        &self.log_file
    }

    pub(crate) fn secret(&self) -> &str {
        &self.secret
    }

    pub(crate) fn timeout(&self) -> Duration {
        self.timeout
    }

    pub(crate) fn sandbox(&self) -> Option<&SandboxSettings> {
        self.sandbox.as_ref()
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredConfig {
    address: SocketAddr,
    web_address: SocketAddr,
    secret: String,
    log_file: PathBuf,
    timeout_seconds: u64,
    #[serde(default)]
    sandbox: Option<StoredSandboxSettings>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredSandboxSettings {
    workspace: PathBuf,
    log_file: PathBuf,
    filesystem: StoredFilesystemSettings,
    tls: TlsSettings,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredFilesystemSettings {
    mode: FilesystemMode,
    #[serde(default)]
    key: Option<String>,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum FilesystemMode {
    Plain,
    Encrypted,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TlsSettings {
    Off,
    Auto,
}

#[derive(Clone, Eq, PartialEq)]
pub(crate) enum FilesystemSettings {
    Plain,
    Encrypted { key: String },
}

impl std::fmt::Debug for FilesystemSettings {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Plain => formatter.write_str("Plain"),
            Self::Encrypted { .. } => formatter
                .debug_struct("Encrypted")
                .field("key", &"[redacted]")
                .finish(),
        }
    }
}

pub(crate) struct SandboxSettings {
    workspace: PathBuf,
    log_file: PathBuf,
    filesystem: FilesystemSettings,
    tls: TlsSettings,
}

impl SandboxSettings {
    fn resolve(config_directory: &Path, stored: StoredSandboxSettings) -> Result<Self> {
        let workspace = resolve_path(config_directory, stored.workspace);
        let log_file = resolve_path(&workspace, stored.log_file);
        let filesystem = match (stored.filesystem.mode, stored.filesystem.key) {
            (FilesystemMode::Plain, None) => FilesystemSettings::Plain,
            (FilesystemMode::Plain, Some(_)) => {
                bail!("sandbox plain filesystem must not specify a key")
            }
            (FilesystemMode::Encrypted, Some(key)) if !key.is_empty() => {
                FilesystemSettings::Encrypted { key }
            }
            (FilesystemMode::Encrypted, _) => {
                bail!("sandbox encrypted filesystem requires a non-empty key")
            }
        };
        Ok(Self {
            workspace,
            log_file,
            filesystem,
            tls: stored.tls,
        })
    }

    pub(crate) fn workspace(&self) -> &Path {
        &self.workspace
    }

    pub(crate) fn log_file(&self) -> &Path {
        &self.log_file
    }

    pub(crate) fn filesystem(&self) -> &FilesystemSettings {
        &self.filesystem
    }

    pub(crate) fn tls(&self) -> TlsSettings {
        self.tls
    }
}

fn resolve_path(directory: &Path, path: PathBuf) -> PathBuf {
    if path.is_absolute() {
        path
    } else {
        directory.join(path)
    }
}

#[cfg(test)]
mod tests;
