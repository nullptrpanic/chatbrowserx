mod app;
mod auth;
mod bash;
mod config;
pub mod logger;

use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand};
use std::fs::{File, OpenOptions};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

#[derive(Parser)]
#[command(name = "chatbrowserx-skill-daemon")]
struct Arguments {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Daemon {
        #[arg(short = 'c', long)]
        config: PathBuf,
    },
    Key {
        #[arg(short = 'c', long)]
        config: PathBuf,
        #[arg(short = 'g', long = "generate")]
        plugin_identifier: String,
        #[arg(
            short = 'e',
            long = "expire",
            default_value_t = 7,
            value_name = "DAYS",
            help = "Token lifetime in days"
        )]
        expiration_days: u64,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    run(Arguments::parse()).await
}

async fn run(arguments: Arguments) -> Result<()> {
    match arguments.command {
        Command::Daemon { config } => run_daemon(&config).await,
        Command::Key {
            config,
            plugin_identifier,
            expiration_days,
        } => issue_key(&config, &plugin_identifier, expiration_days),
    }
}

async fn run_daemon(config_path: &Path) -> Result<()> {
    let config = config::Config::load(config_path)?;
    logger::init(open_log(config.log_file())?, logger::LevelFilter::Info)?;
    logger::info!(
        "skill daemon starting listen={} timeout_seconds={}",
        config.listen(),
        config.timeout().as_secs()
    );
    let listener = tokio::net::TcpListener::bind(config.listen())
        .await
        .with_context(|| format!("failed to bind skill daemon to {}", config.listen()))?;
    axum::serve(
        listener,
        app::router(config.secret().to_owned(), config.timeout()),
    )
    .await
    .context("skill daemon server failed")?;
    Ok(())
}

fn issue_key(config_path: &Path, plugin_identifier: &str, expiration_days: u64) -> Result<()> {
    let config = config::Config::load(config_path)?;
    let token = auth::issue(config.secret(), plugin_identifier, expiration_days)?;
    println!("{token}");
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
