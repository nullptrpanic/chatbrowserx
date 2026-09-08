#[cfg(any(target_os = "macos", test))]
use super::model::AuditEventData;
use super::model::{
    AuditEvent, AuditSnapshot, AuditUpdate, ExecutionFinish, ExecutionId, ExecutionRecord,
    ExecutionStart, ExecutionStatus, PersistedRecord,
};
use anyhow::{Context, Result, bail};
use std::collections::{HashMap, VecDeque};
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::broadcast;
use uuid::Uuid;

const MAX_EXECUTIONS_IN_MEMORY: usize = 2_048;
const MAX_EVENTS_IN_MEMORY: usize = 65_536;
const UPDATE_CAPACITY: usize = 1_024;

#[derive(Clone)]
pub(crate) struct AuditLog {
    inner: Arc<Mutex<State>>,
    updates: broadcast::Sender<AuditUpdate>,
}

struct State {
    file: Option<File>,
    path: Option<PathBuf>,
    executions: VecDeque<ExecutionRecord>,
    receipts: HashMap<String, ExecutionId>,
    events: VecDeque<AuditEvent>,
    hidden_executions: HashMap<ExecutionId, ExecutionRecord>,
    next_sequence: u64,
}

impl AuditLog {
    pub(crate) fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent().filter(|path| !path.as_os_str().is_empty()) {
            std::fs::create_dir_all(parent).with_context(|| {
                format!("failed to create audit log directory {}", parent.display())
            })?;
        }
        let mut state = load(path)?;
        let mut file = OpenOptions::new()
            .create(true)
            .read(true)
            .append(true)
            .open(path)
            .with_context(|| format!("failed to open audit log {}", path.display()))?;
        // Preserve an unterminated record (valid or partial), but never join the next record to it.
        if file.metadata()?.len() > 0 {
            file.seek(SeekFrom::End(-1))?;
            let mut last = [0];
            file.read_exact(&mut last)?;
            if last[0] != b'\n' {
                file.write_all(b"\n")
                    .context("failed to repair audit log boundary")?;
                file.flush()?;
            }
        }
        state.file = Some(file);
        Ok(Self::from_state(state))
    }

    #[cfg(test)]
    pub(crate) fn in_memory() -> Self {
        Self::from_state(State::default())
    }

    fn from_state(state: State) -> Self {
        let (updates, _) = broadcast::channel(UPDATE_CAPACITY);
        Self {
            inner: Arc::new(Mutex::new(state)),
            updates,
        }
    }

    #[cfg(test)]
    pub(crate) fn start_execution(
        &self,
        command: impl Into<String>,
        cwd: Option<PathBuf>,
    ) -> Result<ExecutionId> {
        match self.start_execution_once(command, cwd, None)? {
            ExecutionStart::Started(id) => Ok(id),
            ExecutionStart::Existing(_) => {
                unreachable!("an execution without a request ID is unique")
            }
        }
    }

    pub(crate) fn start_execution_once(
        &self,
        command: impl Into<String>,
        cwd: Option<PathBuf>,
        request_id: Option<String>,
    ) -> Result<ExecutionStart> {
        let mut state = self.lock()?;
        if let Some(request_id) = request_id.as_deref()
            && let Some(execution) = state.receipt(request_id)?
        {
            return Ok(ExecutionStart::Existing(Box::new(execution)));
        }
        let execution = ExecutionRecord {
            id: Uuid::new_v4(),
            request_id,
            command: redact_command(&command.into()),
            cwd,
            pid: None,
            ppid: None,
            user_command_started_at_ms: None,
            started_at_ms: unix_time_ms()?,
            finished_at_ms: None,
            duration_ms: None,
            status: ExecutionStatus::Running,
            exit_code: None,
            stdout: String::new(),
            stderr: String::new(),
            stdout_truncated: false,
            stderr_truncated: false,
            process_events: 0,
            file_events: 0,
            network_events: 0,
        };
        let id = execution.id;
        state.append(&PersistedRecord::Execution(execution.clone()))?;
        state.remember(execution.clone());
        let _ = self.updates.send(AuditUpdate::Execution { execution });
        Ok(ExecutionStart::Started(id))
    }

    pub(crate) fn execution_by_request_id(
        &self,
        request_id: &str,
    ) -> Result<Option<ExecutionRecord>> {
        self.lock()?.receipt(request_id)
    }

    pub(crate) fn record_process_identity(
        &self,
        id: ExecutionId,
        pid: Option<u32>,
        ppid: Option<u32>,
    ) -> Result<()> {
        self.update_execution(id, |execution| {
            execution.pid = pid;
            execution.ppid = ppid;
        })
    }

    pub(crate) fn record_user_command_started(
        &self,
        id: ExecutionId,
        timestamp_ms: u64,
    ) -> Result<()> {
        self.update_execution(id, |execution| {
            execution.user_command_started_at_ms = Some(timestamp_ms);
        })
    }

    pub(crate) fn finish_execution(&self, id: ExecutionId, finish: ExecutionFinish) -> Result<()> {
        let finished_at_ms = unix_time_ms()?;
        self.update_execution(id, |execution| {
            execution.status = finish.status;
            execution.exit_code = finish.exit_code;
            execution.duration_ms = Some(finish.duration_ms);
            execution.finished_at_ms = Some(finished_at_ms);
            execution.stdout = finish.stdout;
            execution.stderr = finish.stderr;
            execution.stdout_truncated = finish.stdout_truncated;
            execution.stderr_truncated = finish.stderr_truncated;
        })
    }

    fn update_execution(
        &self,
        id: ExecutionId,
        update: impl FnOnce(&mut ExecutionRecord),
    ) -> Result<()> {
        let mut state = self.lock()?;
        let mut execution = state
            .execution(id)
            .cloned()
            .context("unknown audit execution")?;
        update(&mut execution);
        state.append(&PersistedRecord::Execution(execution.clone()))?;
        let visible = !state.hidden_executions.contains_key(&id);
        state.remember(execution.clone());
        if visible {
            let _ = self.updates.send(AuditUpdate::Execution { execution });
        }
        Ok(())
    }

    #[cfg(any(target_os = "macos", test))]
    pub(crate) fn record_event(
        &self,
        execution_id: ExecutionId,
        timestamp_ms: u64,
        data: AuditEventData,
    ) -> Result<AuditEvent> {
        let event = {
            let mut state = self.lock()?;
            let Some(position) = state
                .executions
                .iter()
                .position(|item| item.id == execution_id)
            else {
                if state.hidden_executions.contains_key(&execution_id) {
                    let event = AuditEvent {
                        sequence: state.next_sequence,
                        execution_id,
                        timestamp_ms,
                        data,
                    };
                    state.next_sequence += 1;
                    return Ok(event);
                }
                bail!("unknown audit execution {execution_id}");
            };
            let event = AuditEvent {
                sequence: state.next_sequence,
                execution_id,
                timestamp_ms,
                data,
            };
            state.append(&PersistedRecord::Event(event.clone()))?;
            state.next_sequence += 1;
            event.data.increment_count(&mut state.executions[position]);
            state.events.push_back(event.clone());
            trim_front(&mut state.events, MAX_EVENTS_IN_MEMORY);
            let _ = self.updates.send(AuditUpdate::Event {
                event: event.clone(),
            });
            event
        };
        Ok(event)
    }

    pub(crate) fn clear_executions(&self) -> Result<()> {
        let mut state = self.lock()?;
        state.append(&PersistedRecord::ExecutionsCleared)?;
        state.hide_executions();
        let _ = self.updates.send(AuditUpdate::ExecutionsCleared);
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn snapshot(&self) -> AuditSnapshot {
        let state = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        AuditSnapshot {
            executions: state.executions.iter().cloned().collect(),
            events: state.events.iter().cloned().collect(),
        }
    }

    pub(crate) fn subscribe_with_snapshot(
        &self,
    ) -> (broadcast::Receiver<AuditUpdate>, AuditSnapshot) {
        let state = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let receiver = self.updates.subscribe();
        let snapshot = AuditSnapshot {
            executions: state.executions.iter().cloned().collect(),
            events: state.events.iter().cloned().collect(),
        };
        (receiver, snapshot)
    }

    fn lock(&self) -> Result<MutexGuard<'_, State>> {
        self.inner
            .lock()
            .map_err(|_| anyhow::anyhow!("audit log lock is poisoned"))
    }
}

impl State {
    fn execution(&self, id: ExecutionId) -> Option<&ExecutionRecord> {
        self.executions
            .iter()
            .find(|execution| execution.id == id)
            .or_else(|| self.hidden_executions.get(&id))
    }

    fn receipt(&self, request_id: &str) -> Result<Option<ExecutionRecord>> {
        let Some(&id) = self.receipts.get(request_id) else {
            return Ok(None);
        };
        if let Some(execution) = self.execution(id) {
            return Ok(Some(execution.clone()));
        }
        // Eviction affects the viewer, never idempotency. A missing/unreadable receipt is an
        // error, not permission to dispatch the command again.
        let path = self
            .path
            .as_ref()
            .context("execution receipt is no longer in memory")?;
        let mut latest = None;
        for line in BufReader::new(File::open(path)?).lines() {
            let line = line?;
            if let Ok(PersistedRecord::Execution(execution)) = serde_json::from_str(&line)
                && execution.id == id
            {
                latest = Some(execution);
            }
        }
        let mut execution = latest.context("persisted execution receipt is missing")?;
        if execution.status == ExecutionStatus::Running {
            execution.status = ExecutionStatus::Interrupted;
        }
        Ok(Some(execution))
    }

    fn remember(&mut self, execution: ExecutionRecord) {
        if let Some(request_id) = &execution.request_id {
            self.receipts.insert(request_id.clone(), execution.id);
        }
        if self.hidden_executions.contains_key(&execution.id) {
            if execution.status == ExecutionStatus::Running {
                self.hidden_executions.insert(execution.id, execution);
            } else {
                self.hidden_executions.remove(&execution.id);
            }
        } else if let Some(position) = self
            .executions
            .iter()
            .position(|item| item.id == execution.id)
        {
            self.executions[position] = execution;
        } else {
            self.executions.push_back(execution);
            while self.executions.len() > MAX_EXECUTIONS_IN_MEMORY {
                let oldest = self
                    .executions
                    .pop_front()
                    .expect("non-empty execution list");
                if oldest.status == ExecutionStatus::Running {
                    self.hidden_executions.insert(oldest.id, oldest);
                }
            }
        }
    }

    fn hide_executions(&mut self) {
        for execution in self.executions.drain(..) {
            if execution.status == ExecutionStatus::Running {
                self.hidden_executions.insert(execution.id, execution);
            }
        }
        self.events.clear();
    }

    fn append(&mut self, record: &PersistedRecord) -> Result<()> {
        let Some(file) = self.file.as_mut() else {
            return Ok(());
        };
        let mut line = serde_json::to_vec(record).context("failed to serialize audit record")?;
        line.push(b'\n');
        file.write_all(&line)
            .context("failed to append audit record")?;
        file.flush().context("failed to flush audit record")?;
        Ok(())
    }
}

impl Default for State {
    fn default() -> Self {
        Self {
            file: None,
            path: None,
            executions: VecDeque::new(),
            receipts: HashMap::new(),
            events: VecDeque::new(),
            hidden_executions: HashMap::new(),
            next_sequence: 1,
        }
    }
}

fn load(path: &Path) -> Result<State> {
    let mut state = State {
        path: Some(path.to_path_buf()),
        ..State::default()
    };
    if !path.exists() {
        return Ok(state);
    }
    let file =
        File::open(path).with_context(|| format!("failed to read audit log {}", path.display()))?;
    for (index, line) in BufReader::new(file).lines().enumerate() {
        let line = line.with_context(|| format!("failed to read audit log {}", path.display()))?;
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if value.get("record").is_none() {
            continue;
        }
        let record = serde_json::from_value::<PersistedRecord>(value).with_context(|| {
            format!(
                "failed to parse audit record at {}:{}",
                path.display(),
                index + 1
            )
        })?;
        match record {
            PersistedRecord::Execution(execution) => state.remember(execution),
            PersistedRecord::Event(event) => {
                state.next_sequence = state.next_sequence.max(event.sequence + 1);
                state.events.push_back(event);
                trim_front(&mut state.events, MAX_EVENTS_IN_MEMORY);
            }
            PersistedRecord::EventsCleared { execution_id } => {
                state
                    .events
                    .retain(|event| event.execution_id != execution_id);
            }
            PersistedRecord::ExecutionsCleared => state.hide_executions(),
        }
    }
    state.hidden_executions.clear();
    for execution in &mut state.executions {
        if execution.status == ExecutionStatus::Running {
            execution.status = ExecutionStatus::Interrupted;
        }
        execution.process_events = 0;
        execution.file_events = 0;
        execution.network_events = 0;
    }
    for event in &state.events {
        if let Some(execution) = state
            .executions
            .iter_mut()
            .find(|execution| execution.id == event.execution_id)
        {
            event.data.increment_count(execution);
        }
    }
    Ok(state)
}

fn trim_front<T>(items: &mut VecDeque<T>, limit: usize) {
    while items.len() > limit {
        items.pop_front();
    }
}

fn unix_time_ms() -> Result<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("system clock is before the Unix epoch")?
        .as_millis()
        .try_into()
        .context("current timestamp does not fit in u64")
}

fn redact_command(command: &str) -> String {
    const MAX_COMMAND_CHARS: usize = 8_192;
    let Ok(arguments) = shell_words::split(command) else {
        return "[unparseable command omitted]".to_owned();
    };
    let redacted = redact_arguments(&arguments);
    let display = if redacted == arguments {
        command.to_owned()
    } else {
        // shell-words is an argv parser, not a Bash parser. Never present its reconstructed
        // preview as the original executable script; quoted/compound syntax may differ.
        format!(
            "[redacted preview; not executable]\n{}",
            shell_words::join(redacted)
        )
    };
    if display.chars().count() <= MAX_COMMAND_CHARS {
        return display;
    }
    let marker = "\n[command truncated; not executable]";
    display
        .chars()
        .take(MAX_COMMAND_CHARS - marker.len())
        .collect::<String>()
        + marker
}

pub(super) fn redact_arguments(arguments: &[String]) -> Vec<String> {
    let mut output = Vec::with_capacity(arguments.len());
    let mut redact_next = 0_usize;
    for argument in arguments {
        if redact_next > 0 {
            output.push("[redacted]".to_owned());
            redact_next -= 1;
            continue;
        }
        let lowercase = argument.to_ascii_lowercase();
        if sensitive_flag(&lowercase) {
            output.push(argument.clone());
            redact_next = 1;
            continue;
        }
        if let Some((name, _)) = argument.split_once('=')
            && (sensitive_name(name) || sensitive_flag(&name.to_ascii_lowercase()))
        {
            output.push(format!("{name}=[redacted]"));
            continue;
        }
        if let Some(index) = lowercase
            .find("authorization:")
            .or_else(|| lowercase.find("cookie:"))
        {
            let end = index + argument[index..].find(':').unwrap_or(0) + 1;
            output.push(format!("{} [redacted]", &argument[..end]));
            if end == argument.len() {
                redact_next = 2;
            }
            continue;
        }
        output.push(argument.clone());
    }
    output
}

fn sensitive_flag(value: &str) -> bool {
    matches!(
        value,
        "--token"
            | "--access-token"
            | "--password"
            | "--passwd"
            | "--secret"
            | "--client-secret"
            | "--api-key"
            | "--authorization"
            | "--cookie"
            | "--credential"
            | "--private-key"
    )
}

fn sensitive_name(value: &str) -> bool {
    let value = value.to_ascii_lowercase().replace('-', "_");
    [
        "token",
        "password",
        "passwd",
        "secret",
        "api_key",
        "authorization",
        "cookie",
        "credential",
        "private_key",
    ]
    .iter()
    .any(|part| value.contains(part))
}
