use super::Config;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};

#[test]
fn loads_config_and_resolves_relative_log_file() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("sandbox.json");
    std::fs::write(
        &path,
        r#"{
            "host": "127.0.0.1",
            "port": 43129,
            "secret": "0123456789abcdef0123456789abcdef",
            "log_file": "runtime/logs/sandbox.log",
            "timeout_seconds": 45
        }"#,
    )
    .unwrap();

    let config = Config::load(&path).unwrap();

    assert_eq!(
        config.listen(),
        SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 43129)
    );
    assert_eq!(
        config.log_file(),
        directory.path().join("runtime/logs/sandbox.log")
    );
    assert_eq!(config.secret(), "0123456789abcdef0123456789abcdef");
    assert_eq!(config.timeout().as_secs(), 45);
}

#[test]
fn rejects_unknown_fields() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("sandbox.json");
    std::fs::write(
        &path,
        r#"{
            "host": "127.0.0.1",
            "port": 43129,
            "secret": "0123456789abcdef0123456789abcdef",
            "log_file": "logs/sandbox.log",
            "timeout_seconds": 45,
            "extra": true
        }"#,
    )
    .unwrap();

    let error = Config::load(&path).err().expect("unknown fields must fail");

    assert!(error.to_string().contains("failed to parse sandbox config"));
}

#[test]
fn rejects_zero_port_and_timeout() {
    for (port, timeout) in [(0, 45), (43129, 0)] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("sandbox.json");
        std::fs::write(
            &path,
            format!(
                r#"{{
                    "host": "127.0.0.1",
                    "port": {port},
                    "secret": "0123456789abcdef0123456789abcdef",
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
fn rejects_a_secret_shorter_than_32_bytes() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("sandbox.json");
    std::fs::write(
        &path,
        r#"{
            "host": "127.0.0.1",
            "port": 43129,
            "secret": "too-short",
            "log_file": "logs/sandbox.log",
            "timeout_seconds": 45
        }"#,
    )
    .unwrap();

    assert!(Config::load(&path).is_err());
}
