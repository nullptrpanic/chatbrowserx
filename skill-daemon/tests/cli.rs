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
fn startup_rejects_a_missing_bearer_token() {
    let directory = tempfile::tempdir().unwrap();
    let config = directory.path().join("daemon.json");
    std::fs::write(
        &config,
        format!(
            r#"{{
                "host": "127.0.0.1",
                "port": 43129,
                "log_file": {},
                "timeout_seconds": 30
            }}"#,
            serde_json::to_string(&directory.path().join("logs/skill-daemon.log")).unwrap()
        ),
    )
    .unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_chatbrowserx-skill-daemon"))
        .args(["--config", config.to_str().unwrap()])
        .env_remove("CHATBROWSERX_SKILL_TOKEN")
        .output()
        .unwrap();

    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("CHATBROWSERX_SKILL_TOKEN is required")
    );
}

#[test]
fn serves_bash_and_writes_json_logs() {
    let directory = tempfile::tempdir().unwrap();
    let log_file = directory.path().join("logs/daemon.jsonl");
    let port = available_port();
    let config = directory.path().join("daemon.json");
    std::fs::write(
        &config,
        format!(
            r#"{{
                "host": "127.0.0.1",
                "port": {port},
                "log_file": {},
                "timeout_seconds": 30
            }}"#,
            serde_json::to_string(&log_file).unwrap()
        ),
    )
    .unwrap();
    let child = Command::new(env!("CARGO_BIN_EXE_chatbrowserx-skill-daemon"))
        .args(["--config", config.to_str().unwrap()])
        .env("CHATBROWSERX_SKILL_TOKEN", "live-token")
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
        "POST /bash HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer live-token\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    )
    .unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();

    assert!(response.starts_with("HTTP/1.1 200 OK"), "{response}");
    assert!(response.contains(r#""exit_code":0"#), "{response}");
    assert!(response.contains(r#""stdout":"live""#), "{response}");
    let log = std::fs::read_to_string(log_file).unwrap();
    assert!(log.contains(r#""message":"skill daemon starting"#));
    assert!(log.contains(r#""message":"bash command completed""#));
    assert!(log.contains(r#""exit_code":0"#));
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
    panic!("skill daemon did not start on port {port}");
}
