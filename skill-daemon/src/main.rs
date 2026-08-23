mod app;
mod bash;
mod config;
pub mod logger;

use anyhow::{Context, Result, bail};
use clap::Parser;
use std::fs::{File, OpenOptions};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

const TOKEN_ENVIRONMENT: &str = "CHATBROWSERX_SKILL_TOKEN";

#[derive(Parser)]
#[command(name = "chatbrowserx-skill-daemon")]
struct Arguments {
    #[arg(short = 'c', long)]
    config: PathBuf,
}

#[tokio::main]
async fn main() -> Result<()> {
    run(Arguments::parse()).await
}

async fn run(arguments: Arguments) -> Result<()> {
    let config = config::Config::load(&arguments.config)?;
    let token = std::env::var(TOKEN_ENVIRONMENT)
        .with_context(|| format!("{TOKEN_ENVIRONMENT} is required"))?;
    if token.trim().is_empty() {
        bail!("{TOKEN_ENVIRONMENT} must not be empty");
    }
    logger::init(open_log(config.log_file())?, logger::LevelFilter::Info)?;
    logger::info!(
        "skill daemon starting listen={} timeout_seconds={}",
        config.listen(),
        config.timeout().as_secs()
    );
    let listener = tokio::net::TcpListener::bind(config.listen())
        .await
        .with_context(|| format!("failed to bind skill daemon to {}", config.listen()))?;
    axum::serve(listener, app::router(token, config.timeout()))
        .await
        .context("skill daemon server failed")?;
    Ok(())
}

fn open_log(path: &Path) -> Result<File> {
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("failed to create log directory {}", parent.display()))?;
    }
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .with_context(|| format!("failed to open log file {}", path.display()))?;
    let metadata = file
        .metadata()
        .with_context(|| format!("failed to inspect log file {}", path.display()))?;
    if !metadata.is_file() || metadata.uid() != unsafe { libc::geteuid() } {
        bail!("invalid managed log file: {}", path.display());
    }
    Ok(file)
}

#[cfg(test)]
mod tests;
