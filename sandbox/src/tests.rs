use super::open_log;
use serde::ser::Error;
use serde::{Serialize, Serializer};
use std::io;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::sync::{Arc, Mutex};

#[derive(Clone)]
struct SharedWriter {
    buffer: Arc<Mutex<Vec<u8>>>,
}

impl SharedWriter {
    fn new() -> Self {
        Self {
            buffer: Arc::new(Mutex::new(Vec::new())),
        }
    }

    fn content(&self) -> String {
        let buffer = self.buffer.lock().unwrap();
        String::from_utf8_lossy(&buffer).to_string()
    }
}

impl Write for SharedWriter {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.buffer.lock().unwrap().extend_from_slice(buffer);
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[derive(Clone)]
struct BrokenValue;

impl Serialize for BrokenValue {
    fn serialize<S>(&self, _: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        Err(S::Error::custom("broken value"))
    }
}

#[test]
fn copied_logger_writes_plain_structured_and_fallback_records() {
    let writer = SharedWriter::new();
    crate::logger::init(writer.clone(), crate::logger::LevelFilter::Debug).unwrap();

    crate::logger::info!("node started");
    crate::logger::debug!("run {}", 1);
    let second_writer = SharedWriter::new();
    crate::logger::init(second_writer.clone(), crate::logger::LevelFilter::Error).unwrap();
    crate::logger::debug!("still debug");

    let arguments = format_args!("external record");
    let record = crate::logger::log::Record::builder()
        .args(arguments)
        .level(crate::logger::log::Level::Warn)
        .file(Some("external.rs"))
        .line(Some(7))
        .build();
    crate::logger::log::logger().log(&record);

    let arguments = format_args!("workspace record");
    let record = crate::logger::log::Record::builder()
        .args(arguments)
        .level(crate::logger::log::Level::Info)
        .file(Some("crates/sandbox/src/main.rs"))
        .build();
    crate::logger::log::logger().log(&record);

    let entry = crate::logger::LoggerEntry::new().with_entry("bad", BrokenValue);
    crate::logger::info!(entry = entry, "bad entry");
    let entry = crate::logger::LoggerEntry::default()
        .with_entry("first", 1_u32)
        .with_entry("second", "two");
    assert!(!entry.is_error());
    assert_eq!(
        serde_json::to_value(entry.clone()).unwrap(),
        serde_json::json!({"first": 1, "second": "two"})
    );
    crate::logger::output!(entry = entry, "structured output");
    let error_entry = crate::logger::LoggerEntry::new().with_error("broken");
    assert!(error_entry.is_error());
    crate::logger::output!(entry = error_entry, "failed output");
    crate::logger::log::logger().flush();

    let content = writer.content();
    assert!(content.contains("\"message\":\"node started\""));
    assert!(content.contains("\"message\":\"run 1\""));
    assert!(content.contains("\"message\":\"external record\""));
    assert!(content.contains("\"file\":\"external.rs\""));
    assert!(content.contains("\"file\":\"sandbox/src/main.rs\""));
    assert!(content.contains("\"line\":7"));
    assert!(content.contains("\"logger_error\""));
    assert!(content.contains("\"first\":1"));
    assert!(content.contains("\"error\":\"broken\""));
    assert_eq!(second_writer.content(), "");
}

#[test]
fn open_log_creates_private_files_and_rejects_symlinks() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("logs/sandbox.log");

    let output = open_log(&path).unwrap();

    assert_eq!(
        std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    drop(output);

    let external = directory.path().join("external.log");
    let symlink = directory.path().join("linked.log");
    std::fs::write(&external, b"external").unwrap();
    std::os::unix::fs::symlink(&external, &symlink).unwrap();
    assert!(open_log(&symlink).is_err());
    assert_eq!(std::fs::read(external).unwrap(), b"external");
}

#[test]
fn open_log_reports_an_unusable_directory() {
    let directory = tempfile::tempdir().unwrap();
    let blocked = directory.path().join("blocked");
    std::fs::write(&blocked, b"not a directory").unwrap();

    let error = open_log(&blocked.join("sandbox.log")).unwrap_err();

    assert!(error.to_string().contains("failed to create log directory"));
}
