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
    #[serde(default)]
    bypass: Vec<PathBuf>,
    #[serde(default)]
    local: StoredLocalFilesystemSettings,
    #[serde(default)]
    nfs: Vec<StoredRemoteFilesystemSettings>,
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredLocalFilesystemSettings {
    #[serde(default)]
    encrypt: StoredEncryption,
    #[serde(default)]
    key: Option<String>,
}

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
enum StoredEncryption {
    #[default]
    Plain,
    Encrypted,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
enum StoredRemoteFilesystemSettings {
    Smb {
        dir: PathBuf,
        server: String,
        #[serde(default)]
        username: String,
        #[serde(default)]
        password: String,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TlsSettings {
    Off,
    Auto,
}

#[derive(Clone, Eq, PartialEq)]
pub(crate) enum LocalFilesystemSettings {
    Plain,
    Encrypted { key: String },
}

impl std::fmt::Debug for LocalFilesystemSettings {
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

#[derive(Clone, Eq, PartialEq)]
pub(crate) struct SmbFilesystemSettings {
    dir: PathBuf,
    server: String,
    share: String,
    remote_path: String,
    username: String,
    password: String,
}

impl std::fmt::Debug for SmbFilesystemSettings {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SmbFilesystemSettings")
            .field("dir", &self.dir)
            .field("server", &self.server)
            .field("share", &self.share)
            .field("remote_path", &self.remote_path)
            .field("username", &self.username)
            .field("password", &"[redacted]")
            .finish()
    }
}

impl SmbFilesystemSettings {
    pub(crate) fn dir(&self) -> &Path {
        &self.dir
    }

    pub(crate) fn server(&self) -> &str {
        &self.server
    }

    pub(crate) fn share(&self) -> &str {
        &self.share
    }

    pub(crate) fn remote_path(&self) -> &str {
        &self.remote_path
    }

    pub(crate) fn username(&self) -> &str {
        &self.username
    }

    pub(crate) fn password(&self) -> &str {
        &self.password
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct FilesystemSettings {
    local: LocalFilesystemSettings,
    bypass: Vec<PathBuf>,
    nfs: Vec<SmbFilesystemSettings>,
}

impl Default for FilesystemSettings {
    fn default() -> Self {
        Self {
            local: LocalFilesystemSettings::Plain,
            bypass: Vec::new(),
            nfs: Vec::new(),
        }
    }
}

impl FilesystemSettings {
    pub(crate) fn local(&self) -> &LocalFilesystemSettings {
        &self.local
    }

    pub(crate) fn bypass(&self) -> &[PathBuf] {
        &self.bypass
    }

    pub(crate) fn nfs(&self) -> &[SmbFilesystemSettings] {
        &self.nfs
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
        let filesystem = resolve_filesystem(stored.filesystem)?;
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

fn resolve_filesystem(stored: StoredFilesystemSettings) -> Result<FilesystemSettings> {
    let local = match (stored.local.encrypt, stored.local.key) {
        (StoredEncryption::Plain, None) => LocalFilesystemSettings::Plain,
        (StoredEncryption::Plain, Some(_)) => {
            bail!("sandbox plain filesystem must not specify a key")
        }
        (StoredEncryption::Encrypted, Some(key)) if !key.is_empty() => {
            LocalFilesystemSettings::Encrypted { key }
        }
        (StoredEncryption::Encrypted, _) => {
            bail!("sandbox encrypted filesystem requires a non-empty key")
        }
    };
    let mut bypass = stored
        .bypass
        .into_iter()
        .map(|root| {
            if !root.is_absolute() {
                bail!(
                    "sandbox filesystem bypass root must be absolute: {}",
                    root.display()
                );
            }
            Ok(root)
        })
        .collect::<Result<Vec<_>>>()?;
    bypass.sort();
    bypass.dedup();
    let nfs = stored
        .nfs
        .into_iter()
        .map(resolve_remote_filesystem)
        .collect::<Result<Vec<_>>>()?;
    Ok(FilesystemSettings { local, bypass, nfs })
}

fn resolve_remote_filesystem(
    stored: StoredRemoteFilesystemSettings,
) -> Result<SmbFilesystemSettings> {
    match stored {
        StoredRemoteFilesystemSettings::Smb {
            dir,
            server,
            username,
            password,
        } => {
            if !dir.is_absolute() {
                bail!(
                    "sandbox filesystem.nfs SMB dir must be absolute: {}",
                    dir.display()
                );
            }
            let location = server
                .strip_prefix("smb://")
                .context("sandbox filesystem.nfs SMB server must start with 'smb://'")?;
            if location.contains(['?', '#', '@']) {
                bail!("sandbox filesystem.nfs SMB server contains unsupported URI components");
            }
            let (server, path) = location
                .split_once('/')
                .context("sandbox filesystem.nfs SMB server must include a share")?;
            if server.is_empty() {
                bail!("sandbox filesystem.nfs SMB server endpoint is empty");
            }
            let (share, remote_path) = path.split_once('/').unwrap_or((path, ""));
            if share.is_empty() {
                bail!("sandbox filesystem.nfs SMB share is empty");
            }
            Ok(SmbFilesystemSettings {
                dir,
                server: server.to_owned(),
                share: share.to_owned(),
                remote_path: remote_path.to_owned(),
                username,
                password,
            })
        }
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
