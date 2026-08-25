use super::{Config, FilesystemSettings, TlsSettings};
use std::net::SocketAddr;

const SECRET: &str = "0123456789abcdef0123456789abcdef";

#[test]
fn loads_complete_addresses_and_resolves_relative_log_file() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("sandbox.json");
    std::fs::write(
        &path,
        format!(
            r#"{{
                "address": "127.0.0.1:43129",
                "web_address": "0.0.0.0:43130",
                "secret": "{SECRET}",
                "log_file": "runtime/logs/sandbox.log",
                "timeout_seconds": 45
            }}"#
        ),
    )
    .unwrap();

    let config = Config::load(&path).unwrap();

    assert_eq!(
        config.address(),
        "127.0.0.1:43129".parse::<SocketAddr>().unwrap()
    );
    assert_eq!(
        config.web_address(),
        "0.0.0.0:43130".parse::<SocketAddr>().unwrap()
    );
    assert_eq!(
        config.log_file(),
        directory.path().join("runtime/logs/sandbox.log")
    );
    assert_eq!(config.secret(), SECRET);
    assert_eq!(config.timeout().as_secs(), 45);
    assert!(config.sandbox().is_none());
}

#[test]
fn loads_plain_sandbox_and_resolves_paths_from_their_owners() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("sandbox.json");
    std::fs::write(
        &path,
        format!(
            r#"{{
                "address": "[::1]:43129",
                "web_address": "127.0.0.1:43130",
                "secret": "{SECRET}",
                "log_file": "runtime/daemon.log",
                "timeout_seconds": 45,
                "sandbox": {{
                    "workspace": "runtime/sandbox",
                    "log_file": "logs/audit.jsonl",
                    "filesystem": {{ "mode": "plain" }},
                    "tls": "off"
                }}
            }}"#
        ),
    )
    .unwrap();

    let config = Config::load(&path).unwrap();
    let sandbox = config.sandbox().unwrap();

    assert_eq!(
        config.address(),
        "[::1]:43129".parse::<SocketAddr>().unwrap()
    );
    assert_eq!(
        sandbox.workspace(),
        directory.path().join("runtime/sandbox")
    );
    assert_eq!(
        sandbox.log_file(),
        directory.path().join("runtime/sandbox/logs/audit.jsonl")
    );
    assert_eq!(sandbox.filesystem(), &FilesystemSettings::Plain);
    assert_eq!(sandbox.tls(), TlsSettings::Off);
}

#[test]
fn loads_encrypted_sandbox() {
    let directory = tempfile::tempdir().unwrap();
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
                    "workspace": "/tmp/chatbrowserx-sandbox",
                    "log_file": "/tmp/chatbrowserx-audit.jsonl",
                    "filesystem": {{
                        "mode": "encrypted",
                        "key": "test-only-key"
                    }},
                    "tls": "auto"
                }}
            }}"#
        ),
    )
    .unwrap();

    let config = Config::load(&path).unwrap();
    let sandbox = config.sandbox().unwrap();

    assert_eq!(
        sandbox.workspace(),
        std::path::Path::new("/tmp/chatbrowserx-sandbox")
    );
    assert_eq!(
        sandbox.log_file(),
        std::path::Path::new("/tmp/chatbrowserx-audit.jsonl")
    );
    assert_eq!(
        sandbox.filesystem(),
        &FilesystemSettings::Encrypted {
            key: "test-only-key".to_owned()
        }
    );
    assert_eq!(sandbox.tls(), TlsSettings::Auto);
    assert!(!format!("{:?}", sandbox.filesystem()).contains("test-only-key"));
}

#[test]
fn rejects_old_or_unknown_address_fields() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("sandbox.json");
    std::fs::write(
        &path,
        format!(
            r#"{{
                "host": "127.0.0.1",
                "port": 43129,
                "web_address": "127.0.0.1:43130",
                "secret": "{SECRET}",
                "log_file": "logs/sandbox.log",
                "timeout_seconds": 45
            }}"#
        ),
    )
    .unwrap();

    let error = Config::load(&path).err().expect("old fields must fail");

    assert!(error.to_string().contains("failed to parse sandbox config"));
}

#[test]
fn rejects_invalid_addresses_and_zero_timeout() {
    for (address, web_address, timeout) in [
        ("localhost:43129", "127.0.0.1:43130", 45),
        ("127.0.0.1:43129", "localhost:43130", 45),
        ("127.0.0.1:43129", "127.0.0.1:43130", 0),
    ] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("sandbox.json");
        std::fs::write(
            &path,
            format!(
                r#"{{
                    "address": "{address}",
                    "web_address": "{web_address}",
                    "secret": "{SECRET}",
                    "log_file": "logs/sandbox.log",
                    "timeout_seconds": {timeout}
                }}"#
            ),
        )
        .unwrap();

        assert!(Config::load(&path).is_err());
    }
}

#[test]
fn rejects_invalid_filesystem_mode_options() {
    for filesystem in [
        r#"{ "mode": "plain", "key": "not-allowed" }"#,
        r#"{ "mode": "encrypted" }"#,
    ] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("sandbox.json");
        std::fs::write(
            &path,
            format!(
                r#"{{
                    "address": "127.0.0.1:43129",
                    "web_address": "127.0.0.1:43130",
                    "secret": "{SECRET}",
                    "log_file": "logs/sandbox.log",
                    "timeout_seconds": 45,
                    "sandbox": {{
                        "workspace": "runtime/sandbox",
                        "log_file": "audit.jsonl",
                        "filesystem": {filesystem},
                        "tls": "off"
                    }}
                }}"#
            ),
        )
        .unwrap();

        assert!(Config::load(&path).is_err());
    }
}

#[test]
fn rejects_a_secret_shorter_than_32_bytes() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("sandbox.json");
    std::fs::write(
        &path,
        r#"{
            "address": "127.0.0.1:43129",
            "web_address": "127.0.0.1:43130",
            "secret": "too-short",
            "log_file": "logs/sandbox.log",
            "timeout_seconds": 45
        }"#,
    )
    .unwrap();

    assert!(Config::load(&path).is_err());
}
