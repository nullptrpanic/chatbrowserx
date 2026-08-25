mod app;
mod audit;
mod auth;
mod config;
mod execution;
pub mod logger;
mod web;

use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand};
use std::fs::{File, OpenOptions};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

#[derive(Parser)]
#[command(name = "chatbrowserx-sandbox")]
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
        Command::Daemon { config } => run_sandbox(&config).await,
        Command::Key {
            config,
            plugin_identifier,
            expiration_days,
        } => issue_key(&config, &plugin_identifier, expiration_days),
    }
}

async fn run_sandbox(config_path: &Path) -> Result<()> {
    let config = config::Config::load(config_path)?;
    logger::init(open_log(config.log_file())?, logger::LevelFilter::Info)?;
    logger::info!(
        "sandbox starting address={} web_address={} timeout_seconds={}",
        config.address(),
        config.web_address(),
        config.timeout().as_secs()
    );
    let execution_listener = tokio::net::TcpListener::bind(config.address())
        .await
        .with_context(|| format!("failed to bind sandbox to {}", config.address()))?;
    let web_listener = tokio::net::TcpListener::bind(config.web_address())
        .await
        .with_context(|| format!("failed to bind sandbox web to {}", config.web_address()))?;
    let audit_path = config
        .sandbox()
        .map(config::SandboxSettings::log_file)
        .unwrap_or_else(|| config.log_file());
    let audit = audit::AuditLog::open(audit_path)?;
    let runtime = execution::select_runtime(config.sandbox())?;
    let executor = execution::ExecutionService::new(
        runtime,
        audit.clone(),
        config.timeout(),
        4 * 1024 * 1024,
        1024 * 1024,
    );
    let viewer = web::ViewerGuard::new(config.web_address());
    println!(
        "Sandbox audit: {}",
        web::launch_url(config.web_address(), viewer.token())
    );
    let execution_server = axum::serve(
        execution_listener,
        app::router_with_service(config.secret().to_owned(), executor, 4),
    );
    let web_server = axum::serve(web_listener, web::router(audit, viewer));
    tokio::try_join!(execution_server, web_server).context("sandbox server failed")?;
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
