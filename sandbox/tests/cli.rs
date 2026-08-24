use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::Value;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

struct ChildGuard(Child);

impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn startup_rejects_a_missing_configured_secret() {
    let directory = tempfile::tempdir().unwrap();
    let config = directory.path().join("sandbox.json");
    std::fs::write(
        &config,
        format!(
            r#"{{
                "host": "127.0.0.1",
                "port": 43129,
                "log_file": {},
                "timeout_seconds": 30
            }}"#,
            serde_json::to_string(&directory.path().join("logs/sandbox.log")).unwrap()
        ),
    )
    .unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_chatbrowserx-sandbox"))
        .args(["daemon", "--config", config.to_str().unwrap()])
        .output()
        .unwrap();

    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("missing field `secret`"));
}

#[test]
fn serves_exec_and_writes_json_logs() {
    let directory = tempfile::tempdir().unwrap();
    let log_file = directory.path().join("logs/sandbox.jsonl");
    let port = available_port();
    let config = directory.path().join("sandbox.json");
    std::fs::write(
        &config,
        format!(
            r#"{{
                "host": "127.0.0.1",
                "port": {port},
                "secret": "0123456789abcdef0123456789abcdef",
                "log_file": {},
                "timeout_seconds": 30
            }}"#,
            serde_json::to_string(&log_file).unwrap()
        ),
    )
    .unwrap();
    let key_output = Command::new(env!("CARGO_BIN_EXE_chatbrowserx-sandbox"))
        .args(["key", "-c", config.to_str().unwrap(), "-g", "test-plugin"])
        .output()
        .unwrap();
    assert!(key_output.status.success());
    assert!(key_output.stderr.is_empty());
    let token = String::from_utf8(key_output.stdout).unwrap();
    let token = token.trim();
    assert_eq!(token.split('.').count(), 3);

    let child = Command::new(env!("CARGO_BIN_EXE_chatbrowserx-sandbox"))
        .args(["daemon", "-c", config.to_str().unwrap()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let _child = ChildGuard(child);
    wait_for_server(port);

    let body = r#"{"command":"printf live"}"#;
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    write!(
        stream,
        "POST /exec HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    )
    .unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();

    assert!(response.starts_with("HTTP/1.1 200 OK"), "{response}");
    assert!(response.contains(r#""code":0"#), "{response}");
    assert!(response.contains(r#""stdout":"live""#), "{response}");
    let log = std::fs::read_to_string(log_file).unwrap();
    assert!(log.contains(r#""message":"sandbox starting"#));
    assert!(log.contains(r#""message":"bash command completed""#));
    assert!(log.contains(r#""code":0"#));
    assert!(!log.contains(token));
}

#[test]
fn key_defaults_expiration_to_seven_days() {
    let directory = tempfile::tempdir().unwrap();
    let config = write_config(directory.path(), 43129);

    let token = issue_key(&config, &[]);
    let claims = decode_claims(&token);

    assert_eq!(claims["sub"], "test-plugin");
    assert_eq!(
        claims["exp"].as_u64().unwrap() - claims["iat"].as_u64().unwrap(),
        604_800
    );
}

#[test]
fn key_accepts_custom_expiration_in_days() {
    let directory = tempfile::tempdir().unwrap();
    let config = write_config(directory.path(), 43129);

    let token = issue_key(&config, &["--expire", "30"]);
    let claims = decode_claims(&token);

    assert_eq!(
        claims["exp"].as_u64().unwrap() - claims["iat"].as_u64().unwrap(),
        2_592_000
    );
}

#[test]
fn key_rejects_zero_expiration_days() {
    let directory = tempfile::tempdir().unwrap();
    let config = write_config(directory.path(), 43129);

    let output = Command::new(env!("CARGO_BIN_EXE_chatbrowserx-sandbox"))
        .args([
            "key",
            "-c",
            config.to_str().unwrap(),
            "-g",
            "test-plugin",
            "-e",
            "0",
        ])
        .output()
        .unwrap();

    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("expire must be greater than zero"));
}

#[test]
fn key_rejects_an_empty_plugin_identifier() {
    let directory = tempfile::tempdir().unwrap();
    let config = write_config(directory.path(), 43129);

    let output = Command::new(env!("CARGO_BIN_EXE_chatbrowserx-sandbox"))
        .args(["key", "-c", config.to_str().unwrap(), "-g", "   "])
        .output()
        .unwrap();

    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("plugin identifier must not be empty")
    );
}

fn write_config(directory: &std::path::Path, port: u16) -> std::path::PathBuf {
    let config = directory.join("sandbox.json");
    std::fs::write(
        &config,
        format!(
            r#"{{
                "host": "127.0.0.1",
                "port": {port},
                "secret": "0123456789abcdef0123456789abcdef",
                "log_file": {},
                "timeout_seconds": 30
            }}"#,
            serde_json::to_string(&directory.join("sandbox.log")).unwrap()
        ),
    )
    .unwrap();
    config
}

fn issue_key(config: &std::path::Path, extra_arguments: &[&str]) -> String {
    let mut command = Command::new(env!("CARGO_BIN_EXE_chatbrowserx-sandbox"));
    command.args(["key", "-c", config.to_str().unwrap(), "-g", "test-plugin"]);
    command.args(extra_arguments);
    let output = command.output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().to_string()
}

fn decode_claims(token: &str) -> Value {
    let payload = token
        .split('.')
        .nth(1)
        .expect("token must contain a payload");
    let payload = URL_SAFE_NO_PAD.decode(payload).unwrap();
    serde_json::from_slice(&payload).unwrap()
}

fn available_port() -> u16 {
    TcpListener::bind(("127.0.0.1", 0))
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn wait_for_server(port: u16) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return;
        }
        thread::sleep(Duration::from_millis(20));
    }
    panic!("sandbox did not start on port {port}");
}
