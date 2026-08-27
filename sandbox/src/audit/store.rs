#[cfg(any(target_os = "macos", test))]
use super::model::AuditEventData;
use super::model::{
    AuditEvent, AuditSnapshot, AuditUpdate, ExecutionFinish, ExecutionId, ExecutionRecord,
    ExecutionStatus, PersistedRecord,
};
use anyhow::{Context, Result, bail};
use std::collections::{HashSet, VecDeque};
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
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
    executions: VecDeque<ExecutionRecord>,
    events: VecDeque<AuditEvent>,
    suppressed_execution_ids: HashSet<ExecutionId>,
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
        state.file = Some(
            OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
                .with_context(|| format!("failed to open audit log {}", path.display()))?,
        );
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

    pub(crate) fn start_execution(
        &self,
        command: impl Into<String>,
        cwd: Option<PathBuf>,
    ) -> Result<ExecutionId> {
        let execution = ExecutionRecord {
            id: Uuid::new_v4(),
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
        {
            let mut state = self.lock()?;
            state.append(&PersistedRecord::Execution(execution.clone()))?;
            state.executions.push_back(execution.clone());
            trim_front(&mut state.executions, MAX_EXECUTIONS_IN_MEMORY);
            let _ = self.updates.send(AuditUpdate::Execution {
                execution: execution.clone(),
            });
        }
        Ok(id)
    }

    pub(crate) fn record_process_identity(
        &self,
        id: ExecutionId,
        pid: Option<u32>,
        ppid: Option<u32>,
    ) -> Result<()> {
        let mut state = self.lock()?;
        let Some(position) = state.executions.iter().position(|item| item.id == id) else {
            if state.suppressed_execution_ids.contains(&id) {
                return Ok(());
            }
            bail!("unknown audit execution {id}");
        };
        let mut execution = state.executions[position].clone();
        execution.pid = pid;
        execution.ppid = ppid;
        state.append(&PersistedRecord::Execution(execution.clone()))?;
        state.executions[position] = execution.clone();
        let _ = self.updates.send(AuditUpdate::Execution { execution });
        Ok(())
    }

    pub(crate) fn record_user_command_started(
        &self,
        id: ExecutionId,
        timestamp_ms: u64,
    ) -> Result<()> {
        let mut state = self.lock()?;
        let Some(position) = state.executions.iter().position(|item| item.id == id) else {
            if state.suppressed_execution_ids.contains(&id) {
                return Ok(());
            }
            bail!("unknown audit execution {id}");
        };
        let mut execution = state.executions[position].clone();
        execution.user_command_started_at_ms = Some(timestamp_ms);
        state.append(&PersistedRecord::Execution(execution.clone()))?;
        state.executions[position] = execution.clone();
        let _ = self.updates.send(AuditUpdate::Execution { execution });
        Ok(())
    }

    pub(crate) fn finish_execution(&self, id: ExecutionId, finish: ExecutionFinish) -> Result<()> {
        {
            let mut state = self.lock()?;
            let Some(position) = state.executions.iter().position(|item| item.id == id) else {
                if state.suppressed_execution_ids.remove(&id) {
                    return Ok(());
                }
                bail!("unknown audit execution {id}");
            };
            let mut execution = state.executions[position].clone();
            execution.status = finish.status;
            execution.exit_code = finish.exit_code;
            execution.duration_ms = Some(finish.duration_ms);
            execution.finished_at_ms = Some(unix_time_ms()?);
            execution.stdout = finish.stdout;
            execution.stderr = finish.stderr;
            execution.stdout_truncated = finish.stdout_truncated;
            execution.stderr_truncated = finish.stderr_truncated;
            state.append(&PersistedRecord::Execution(execution.clone()))?;
            state.executions[position] = execution.clone();
            let _ = self.updates.send(AuditUpdate::Execution {
                execution: execution.clone(),
            });
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
                if state.suppressed_execution_ids.contains(&execution_id) {
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
        let running = state
            .executions
            .iter()
            .filter(|execution| execution.status == ExecutionStatus::Running)
            .map(|execution| execution.id)
            .collect::<Vec<_>>();
        state.suppressed_execution_ids.extend(running);
        state.executions.clear();
        state.events.clear();
        let _ = self.updates.send(AuditUpdate::ExecutionsCleared);
        Ok(())
    }

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
            executions: VecDeque::new(),
            events: VecDeque::new(),
            suppressed_execution_ids: HashSet::new(),
            next_sequence: 1,
        }
    }
}

fn load(path: &Path) -> Result<State> {
    let mut state = State::default();
    if !path.exists() {
        return Ok(state);
    }
    let file =
        File::open(path).with_context(|| format!("failed to read audit log {}", path.display()))?;
    for (index, line) in BufReader::new(file)
        .lines()
        .map_while(Result::ok)
        .enumerate()
    {
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
            PersistedRecord::Execution(mut execution) => {
                if execution.status == ExecutionStatus::Running {
                    execution.status = ExecutionStatus::Interrupted;
                }
                if let Some(position) = state
                    .executions
                    .iter()
                    .position(|item| item.id == execution.id)
                {
                    state.executions[position] = execution;
                } else {
                    state.executions.push_back(execution);
                    trim_front(&mut state.executions, MAX_EXECUTIONS_IN_MEMORY);
                }
            }
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
            PersistedRecord::ExecutionsCleared => {
                state.executions.clear();
                state.events.clear();
            }
        }
    }
    for execution in &mut state.executions {
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
    redact_arguments(&arguments)
        .join(" ")
        .chars()
        .take(MAX_COMMAND_CHARS)
        .collect()
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
