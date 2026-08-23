use anyhow::{Context, Result, bail};
use serde::Deserialize;
use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(Debug)]
pub(crate) struct Config {
    listen: SocketAddr,
    log_file: PathBuf,
    timeout: Duration,
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
            .with_context(|| format!("failed to open daemon config {}", path.display()))?;
        let stored: StoredConfig = serde_json::from_reader(file)
            .with_context(|| format!("failed to parse daemon config {}", path.display()))?;
        if stored.port == 0 {
            bail!("daemon config port must be greater than zero");
        }
        if stored.timeout_seconds == 0 {
            bail!("daemon config timeout_seconds must be greater than zero");
        }
        let directory = path.parent().unwrap_or(Path::new("/"));
        let log_file = if stored.log_file.is_absolute() {
            stored.log_file
        } else {
            directory.join(stored.log_file)
        };
        Ok(Self {
            listen: SocketAddr::new(stored.host, stored.port),
            log_file,
            timeout: Duration::from_secs(stored.timeout_seconds),
        })
    }

    pub(crate) fn listen(&self) -> SocketAddr {
        self.listen
    }

    pub(crate) fn log_file(&self) -> &Path {
        &self.log_file
    }

    pub(crate) fn timeout(&self) -> Duration {
        self.timeout
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredConfig {
    host: IpAddr,
    port: u16,
    log_file: PathBuf,
    timeout_seconds: u64,
}

#[cfg(test)]
mod tests;
