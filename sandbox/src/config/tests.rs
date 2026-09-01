use super::{Config, LocalFilesystemSettings, TlsSettings};
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
                    "filesystem": {{
                        "local": {{ "encrypt": "plain" }}
                    }},
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
    assert_eq!(
        sandbox.filesystem().local(),
        &LocalFilesystemSettings::Plain
    );
    assert!(sandbox.filesystem().bypass().is_empty());
    assert!(sandbox.filesystem().nfs().is_empty());
    assert_eq!(sandbox.tls(), TlsSettings::Off);
}

#[test]
fn loads_encrypted_sandbox_with_bypass_and_smb_remote() {
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
                        "bypass": [
                            "/Users/bytedance/Library/Application Support/lark-cli",
                            "/Users/bytedance/.lark-cli",
                            "/Users/bytedance/.lark-cli"
                        ],
                        "local": {{
                            "encrypt": "encrypted",
                            "key": "test-only-key"
                        }},
                        "nfs": [
                            {{
                                "type": "smb",
                                "dir": "/Users/bytedance/smb",
                                "server": "smb://127.0.0.1:10445/workspace/team",
                                "username": "openclaw",
                                "password": "test-only-password"
                            }}
                        ]
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
        sandbox.filesystem().local(),
        &LocalFilesystemSettings::Encrypted {
            key: "test-only-key".to_owned()
        }
    );
    assert_eq!(
        sandbox.filesystem().bypass(),
        &[
            std::path::PathBuf::from("/Users/bytedance/.lark-cli"),
            std::path::PathBuf::from("/Users/bytedance/Library/Application Support/lark-cli"),
        ]
    );
    let remote = &sandbox.filesystem().nfs()[0];
    assert_eq!(remote.dir(), std::path::Path::new("/Users/bytedance/smb"));
    assert_eq!(remote.server(), "127.0.0.1:10445");
    assert_eq!(remote.share(), "workspace");
    assert_eq!(remote.remote_path(), "team");
    assert_eq!(remote.username(), "openclaw");
    assert_eq!(remote.password(), "test-only-password");
    assert_eq!(sandbox.tls(), TlsSettings::Auto);
    assert!(!format!("{:?}", sandbox.filesystem()).contains("test-only-key"));
    assert!(!format!("{:?}", sandbox.filesystem()).contains("test-only-password"));
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
fn rejects_invalid_local_filesystem_options() {
    for filesystem in [
        r#"{ "local": { "encrypt": "plain", "key": "not-allowed" } }"#,
        r#"{ "local": { "encrypt": "encrypted" } }"#,
        r#"{ "mode": "encrypted", "key": "legacy-format" }"#,
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
fn rejects_relative_bypass_and_invalid_smb_locations() {
    for filesystem in [
        r#"{ "bypass": ["relative/path"] }"#,
        r#"{ "nfs": [{ "type": "smb", "dir": "relative", "server": "smb://host/share" }] }"#,
        r#"{ "nfs": [{ "type": "smb", "dir": "/remote", "server": "https://host/share" }] }"#,
        r#"{ "nfs": [{ "type": "smb", "dir": "/remote", "server": "smb://host" }] }"#,
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

        assert!(Config::load(&path).is_err(), "accepted {filesystem}");
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
