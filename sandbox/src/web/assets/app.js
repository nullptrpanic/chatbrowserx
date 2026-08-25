(() => {
  'use strict';

  const state = {
    executions: new Map(),
    events: new Map(),
    selectedExecutionId: null,
    selectedEventSequence: null,
    selectedCommand: false,
    follow: true,
    showSystemFiles: false,
    detailPayload: '',
    detailInput: '',
    detailOutput: '',
    socket: null,
  };

  const elements = {
    connection: document.querySelector('.connection'),
    connectionLabel: document.querySelector('#connection-label'),
    search: document.querySelector('#search'),
    eventTotal: document.querySelector('#event-total'),
    executionList: document.querySelector('#execution-list'),
    selectedCommand: document.querySelector('#selected-command'),
    selectedStatus: document.querySelector('#selected-status'),
    selectedCwd: document.querySelector('#selected-cwd'),
    selectedRunId: document.querySelector('#selected-run-id'),
    monitoringMode: document.querySelector('#monitoring-mode'),
    processCount: document.querySelector('#process-count'),
    fileCount: document.querySelector('#file-count'),
    hostCount: document.querySelector('#host-count'),
    duration: document.querySelector('#duration'),
    clearEvents: document.querySelector('#clear-events'),
    workspace: document.querySelector('.workspace'),
    sidebar: document.querySelector('.sidebar'),
    inspector: document.querySelector('.inspector'),
    sidebarResizer: document.querySelector('[data-resizer="sidebar"]'),
    inspectorResizer: document.querySelector('[data-resizer="inspector"]'),
    content: document.querySelector('#content'),
    timeline: document.querySelector('#timeline-rows'),
    follow: document.querySelector('#follow'),
    systemFiles: document.querySelector('#system-files'),
    detailEmpty: document.querySelector('#event-detail-empty'),
    detailContent: document.querySelector('#event-detail-content'),
    detailBadge: document.querySelector('#detail-badge'),
    detailTitle: document.querySelector('#detail-title'),
    detailPrimaryLabel: document.querySelector('#detail-primary-label'),
    detailPrimary: document.querySelector('#detail-primary'),
    detailPid: document.querySelector('#detail-pid'),
    detailPpid: document.querySelector('#detail-ppid'),
    detailRunId: document.querySelector('#detail-run-id'),
    detailInputBlock: document.querySelector('#detail-input-block'),
    detailInput: document.querySelector('#detail-input'),
    detailOutputBlock: document.querySelector('#detail-output-block'),
    detailOutput: document.querySelector('#detail-output'),
    detailPayload: document.querySelector('#detail-payload'),
    relatedProcesses: document.querySelector('#related-processes'),
    relatedFiles: document.querySelector('#related-files'),
    relatedNetwork: document.querySelector('#related-network'),
    copyEvent: document.querySelector('#copy-event'),
    copyInput: document.querySelector('#copy-input'),
    copyOutput: document.querySelector('#copy-output'),
  };

  const create = (tag, className, text) => {
    const value = document.createElement(tag);
    if (className) value.className = className;
    if (text !== undefined) value.textContent = text;
    return value;
  };

  const shortId = (value) => (value ? value.slice(0, 8) : '—');
  const eventKey = (event) => event.execution_id + ':' + event.sequence;
  const statusText = (value) => (value || 'unknown').replaceAll('_', ' ');
  const formatTime = (value) =>
    new Date(value).toLocaleTimeString([], {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  const formatDuration = (value) => {
    if (!Number.isFinite(value) || value < 0) return '—';
    if (value < 1000) return Math.round(value) + ' ms';
    return (value / 1000).toFixed(value < 10000 ? 1 : 0) + ' s';
  };
  const empty = () =>
    document.querySelector('#empty-template').content.firstElementChild.cloneNode(true);

  function tokenFromFragment() {
    return new URLSearchParams(location.hash.slice(1)).get('token') || '';
  }

  function setConnection(status, label) {
    elements.connection.className = 'connection' + (status ? ' ' + status : '');
    elements.connectionLabel.textContent = label;
  }

  function connect(token, retry) {
    if (!token) {
      setConnection('error', 'MISSING TOKEN');
      return;
    }
    const attempt = retry || 0;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(protocol + '//' + location.host + '/ws');
    state.socket = socket;
    socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'auth', token })));
    socket.addEventListener('message', (message) => {
      const update = JSON.parse(message.data);
      if (update.type === 'snapshot') applySnapshot(update.snapshot);
      if (update.type === 'execution') applyExecution(update.execution);
      if (update.type === 'event') applyEvent(update.event);
      if (update.type === 'events_cleared') applyEventsCleared(update.execution_id);
      if (update.type === 'error') {
        setConnection('error', update.message || 'REQUEST FAILED');
        return;
      }
      setConnection('live', 'LIVE');
    });
    socket.addEventListener('close', () => {
      if (state.socket === socket) state.socket = null;
      setConnection('', 'RECONNECTING');
      window.setTimeout(() => connect(token, attempt + 1), Math.min(1000 * 2 ** attempt, 15000));
    });
    socket.addEventListener('error', () => setConnection('error', 'CONNECTION ERROR'));
  }

  function applySnapshot(snapshot) {
    state.executions = new Map(snapshot.executions.map((item) => [item.id, item]));
    state.events = new Map(snapshot.events.map((item) => [eventKey(item), item]));
    ensureSelection();
    render();
  }

  function applyExecution(execution) {
    const isNew = !state.executions.has(execution.id);
    state.executions.set(execution.id, execution);
    if (state.selectedExecutionId === null || (isNew && state.follow)) {
      selectExecution(execution.id, false);
    }
    render();
  }

  function applyEvent(event) {
    state.events.set(eventKey(event), event);
    render();
  }

  function applyEventsCleared(executionId) {
    for (const [sequence, event] of state.events) {
      if (event.execution_id === executionId) state.events.delete(sequence);
    }
    if (state.selectedExecutionId === executionId) {
      state.selectedEventSequence = null;
      state.selectedCommand = true;
    }
    render();
  }

  function sortedExecutions() {
    return [...state.executions.values()].sort(
      (left, right) => right.started_at_ms - left.started_at_ms,
    );
  }

  function ensureSelection() {
    if (state.selectedExecutionId && state.executions.has(state.selectedExecutionId)) return;
    state.selectedExecutionId = sortedExecutions()[0]?.id || null;
    state.selectedEventSequence = null;
    state.selectedCommand = false;
  }

  function selectExecution(id, rerender) {
    state.selectedExecutionId = id;
    state.selectedEventSequence = null;
    state.selectedCommand = false;
    if (rerender !== false) render();
  }

  function activeExecution() {
    ensureSelection();
    return state.selectedExecutionId
      ? state.executions.get(state.selectedExecutionId) || null
      : null;
  }

  function activeEvents() {
    const execution = activeExecution();
    if (!execution) return [];
    return [...state.events.values()]
      .filter((event) => event.execution_id === execution.id)
      .sort(
        (left, right) => left.timestamp_ms - right.timestamp_ms || left.sequence - right.sequence,
      );
  }

  function queryMatches(value) {
    const query = elements.search.value.trim().toLocaleLowerCase();
    return !query || JSON.stringify(value).toLocaleLowerCase().includes(query);
  }

  function isSystemFile(event) {
    if (event.kind !== 'file') return false;
    return /^\/(System|Library|usr\/lib|private\/var\/db)(\/|$)/.test(event.path || '');
  }

  function visibleEvents(kind) {
    return activeEvents()
      .filter((event) => !kind || event.kind === kind)
      .filter((event) => state.showSystemFiles || !isSystemFile(event))
      .filter(queryMatches);
  }

  function render() {
    const shouldFollow = state.follow && nearBottom();
    renderExecutions();
    renderSummary();
    renderTimeline();
    renderInspector();
    elements.eventTotal.textContent =
      state.events.size + (state.events.size === 1 ? ' event' : ' events');
    if (shouldFollow) {
      requestAnimationFrame(() => {
        elements.content.scrollTop = elements.content.scrollHeight;
      });
    }
  }

  function renderExecutions() {
    const rows = [];
    let group = '';
    for (const execution of sortedExecutions().filter(queryMatches)) {
      const nextGroup = dayLabel(execution.started_at_ms);
      if (nextGroup !== group) {
        group = nextGroup;
        rows.push(create('div', 'execution-group', group));
      }
      const button = create(
        'button',
        'execution' + (execution.id === state.selectedExecutionId ? ' active' : ''),
      );
      button.type = 'button';
      button.addEventListener('click', () => selectExecution(execution.id));
      const title = create('div', 'execution-title');
      const command = create('span', 'execution-command');
      command.append(
        create('i', 'state-dot ' + execution.status),
        document.createTextNode(execution.command),
      );
      title.append(
        command,
        create('span', 'status ' + execution.status, statusText(execution.status)),
      );
      const duration = execution.duration_ms ?? Math.max(0, Date.now() - execution.started_at_ms);
      const firstMeta = create('div', 'execution-meta');
      firstMeta.append(
        create('span', '', '◷ ' + formatDuration(duration)),
        create(
          'span',
          '',
          execution.exit_code === null ? 'running' : 'code ' + execution.exit_code,
        ),
      );
      const secondMeta = create('div', 'execution-meta');
      secondMeta.append(
        create('span', '', execution.cwd || 'default working directory'),
        create('span', '', 'Run ' + shortId(execution.id)),
      );
      button.append(title, firstMeta, secondMeta);
      rows.push(button);
    }
    elements.executionList.replaceChildren(...(rows.length ? rows : [empty()]));
  }

  function dayLabel(timestamp) {
    const date = new Date(timestamp);
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);
    if (date.toDateString() === today.toDateString()) return 'Today';
    if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return date.toLocaleDateString();
  }

  function renderSummary() {
    const execution = activeExecution();
    if (!execution) {
      elements.selectedCommand.textContent = 'No execution selected';
      elements.selectedStatus.textContent = 'idle';
      elements.selectedStatus.className = 'status';
      elements.selectedCwd.textContent = 'default working directory';
      elements.selectedRunId.textContent = '—';
      setMonitoringMode('Command only', true);
      elements.processCount.textContent = '0';
      elements.fileCount.textContent = '0';
      elements.hostCount.textContent = '0';
      elements.duration.textContent = '0 ms';
      elements.clearEvents.disabled = true;
      return;
    }
    const events = activeEvents();
    const processIds = new Set(events.map((event) => event.pid).filter(Number.isFinite));
    const hosts = new Set(
      events
        .filter((event) => event.kind === 'network')
        .map((event) => event.host || event.ip)
        .filter(Boolean),
    );
    elements.selectedCommand.textContent = execution.command;
    elements.selectedStatus.textContent = statusText(execution.status);
    elements.selectedStatus.className = 'status ' + execution.status;
    elements.selectedCwd.textContent = execution.cwd || 'default working directory';
    elements.selectedRunId.textContent = shortId(execution.id);
    if (events.length > 0) setMonitoringMode('Agora telemetry', false);
    else if (execution.status === 'running') setMonitoringMode('Waiting for telemetry', false);
    else setMonitoringMode('Command only', true);
    elements.processCount.textContent = String(processIds.size);
    elements.fileCount.textContent = String(events.filter((event) => event.kind === 'file').length);
    elements.hostCount.textContent = String(hosts.size);
    elements.duration.textContent = formatDuration(
      execution.duration_ms ?? Math.max(0, Date.now() - execution.started_at_ms),
    );
    elements.clearEvents.disabled = events.length === 0;
  }

  function setMonitoringMode(label, commandOnly) {
    elements.monitoringMode.textContent = label;
    elements.monitoringMode.className = 'monitoring-mode' + (commandOnly ? ' command-only' : '');
  }

  function renderTimeline() {
    const execution = activeExecution();
    if (!execution) {
      elements.timeline.replaceChildren(empty());
      return;
    }
    elements.timeline.replaceChildren(commandRow(execution), ...renderEventRows(visibleEvents('')));
  }

  function renderEventRows(events) {
    const processes = processIndex(activeEvents());
    return events.map((event) => eventRow(event, processes));
  }

  function commandRow(execution) {
    const row = create(
      'button',
      'event-row command-row' + (state.selectedCommand ? ' selected' : ''),
    );
    row.type = 'button';
    row.addEventListener('click', () => {
      state.selectedCommand = true;
      state.selectedEventSequence = null;
      render();
    });
    const main = create('span', 'event-main');
    const label = create('span', 'event-label', execution.command);
    label.title = execution.command;
    main.append(create('span', 'badge command', 'COMMAND'), label);
    row.append(
      main,
      create(
        'span',
        'event-detail',
        statusText(execution.status) + ' · ' + (execution.cwd || 'default working directory'),
      ),
      eventTime(execution.started_at_ms),
    );
    return row;
  }

  function eventTime(timestamp) {
    const time = create('time', 'event-time', formatTime(timestamp));
    time.dateTime = new Date(timestamp).toISOString();
    return time;
  }

  function eventRow(event, processes) {
    const description = eventDescription(event, processes);
    const row = create(
      'button',
      'event-row' + (event.sequence === state.selectedEventSequence ? ' selected' : ''),
    );
    row.type = 'button';
    row.style.setProperty('--depth', String(eventDepth(event, processes)));
    row.addEventListener('click', () => {
      state.selectedEventSequence = event.sequence;
      state.selectedCommand = false;
      render();
    });
    const main = create('span', 'event-main');
    main.append(
      create('span', 'badge ' + event.kind, description.badge),
      create('span', 'event-label', description.primary),
    );
    row.append(
      main,
      create('span', 'event-detail', description.secondary),
      eventTime(event.timestamp_ms),
    );
    return row;
  }

  function processIndex(events) {
    const processes = new Map();
    for (const event of events) {
      if (event.kind === 'process') processes.set(event.pid, event);
    }
    for (const event of events) {
      if (!processes.has(event.pid)) {
        processes.set(event.pid, {
          kind: 'process',
          event: 'observed',
          pid: event.pid,
          ppid: null,
          executable: 'Observed process ' + event.pid,
          execution_id: event.execution_id,
          timestamp_ms: event.timestamp_ms,
          sequence: null,
        });
      }
    }
    return processes;
  }

  function eventDepth(event, processes) {
    let depth = 0;
    let process = processes.get(event.pid);
    const visited = new Set();
    while (process && process.ppid && processes.has(process.ppid) && !visited.has(process.pid)) {
      visited.add(process.pid);
      depth += 1;
      process = processes.get(process.ppid);
    }
    return Math.min(depth + (event.kind === 'process' ? 0 : 1), 6);
  }

  function eventDescription(event, processes) {
    if (event.kind === 'process') {
      return {
        badge: event.event === 'exec' ? 'EXEC' : 'PROCESS',
        primary: event.executable || 'Process ' + event.pid,
        secondary: 'PID ' + event.pid + ' · PPID ' + (event.ppid ?? '—'),
      };
    }
    if (event.kind === 'file') {
      const owner = processes.get(event.pid);
      return {
        badge:
          event.event === 'open' ? 'FILE OPEN' : event.event === 'close' ? 'FILE CLOSE' : 'FILE',
        primary: event.path || 'Unknown path',
        secondary:
          (event.access || event.event || 'access') + ' · PID ' + event.pid + ownerSuffix(owner),
      };
    }
    const destination = event.host || event.ip || 'Unknown destination';
    const endpoint = [event.ip, event.port].filter(Boolean).join(':');
    return {
      badge: 'NETWORK',
      primary: destination,
      secondary: (endpoint || event.event || 'network') + ' · PID ' + event.pid,
    };
  }

  function ownerSuffix(owner) {
    if (!owner || !owner.executable) return '';
    const pieces = owner.executable.split('/');
    return ' · ' + pieces[pieces.length - 1];
  }

  function renderInspector() {
    const execution = activeExecution();
    const events = activeEvents();
    if (state.selectedCommand && execution) {
      renderCommandInspector(execution, events);
      return;
    }
    const event = events.find((candidate) => candidate.sequence === state.selectedEventSequence);
    if (!event) {
      elements.detailEmpty.hidden = false;
      elements.detailContent.hidden = true;
      state.detailPayload = '';
      setInspectorIo('', '');
      return;
    }
    const processes = processIndex(events);
    const owner = processes.get(event.pid);
    const description = eventDescription(event, processes);
    elements.detailEmpty.hidden = true;
    elements.detailContent.hidden = false;
    elements.detailBadge.className = 'badge ' + event.kind;
    elements.detailBadge.textContent = description.badge;
    elements.detailTitle.textContent = event.event || event.kind;
    elements.detailPrimaryLabel.textContent =
      event.kind === 'process' ? 'Executable' : event.kind === 'file' ? 'Path' : 'Destination';
    elements.detailPrimary.textContent = description.primary;
    elements.detailPid.textContent = String(event.pid ?? '—');
    elements.detailPpid.textContent = String(
      event.kind === 'process' ? (event.ppid ?? '—') : (owner?.ppid ?? '—'),
    );
    elements.detailRunId.textContent = shortId(event.execution_id);
    if (event.kind === 'process' && (event.event === 'exec' || event.operation)) {
      setInspectorIo(
        JSON.stringify(
          {
            operation: event.operation ?? null,
            executable: event.executable,
            arguments: event.arguments ?? [],
            current_dir: event.current_dir ?? null,
          },
          null,
          2,
        ),
        JSON.stringify(
          {
            status: event.status ?? null,
            error_code: event.error_code ?? null,
            error_message: event.error_message ?? null,
          },
          null,
          2,
        ),
      );
    } else {
      setInspectorIo('', '');
    }
    state.detailPayload = JSON.stringify(event, null, 2);
    elements.detailPayload.textContent = state.detailPayload;
    elements.relatedProcesses.textContent = String(
      [...processes.values()].filter((process) => process.ppid === event.pid).length,
    );
    elements.relatedFiles.textContent = String(
      events.filter((candidate) => candidate.kind === 'file' && candidate.pid === event.pid).length,
    );
    elements.relatedNetwork.textContent = String(
      events.filter((candidate) => candidate.kind === 'network' && candidate.pid === event.pid)
        .length,
    );
  }

  function renderCommandInspector(execution, events) {
    elements.detailEmpty.hidden = true;
    elements.detailContent.hidden = false;
    elements.detailBadge.className = 'badge command';
    elements.detailBadge.textContent = 'COMMAND';
    elements.detailTitle.textContent = statusText(execution.status);
    elements.detailPrimaryLabel.textContent = 'Command';
    elements.detailPrimary.textContent = execution.command;
    elements.detailPid.textContent = '—';
    elements.detailPpid.textContent = '—';
    elements.detailRunId.textContent = shortId(execution.id);
    setInspectorIo(
      execution.command + (execution.cwd ? '\n\nWorking directory: ' + execution.cwd : ''),
      JSON.stringify(
        {
          status: execution.status,
          exit_code: execution.exit_code,
          stdout: execution.stdout ?? '',
          stderr: execution.stderr ?? '',
          stdout_truncated: execution.stdout_truncated ?? false,
          stderr_truncated: execution.stderr_truncated ?? false,
        },
        null,
        2,
      ),
    );
    state.detailPayload = JSON.stringify(execution, null, 2);
    elements.detailPayload.textContent = state.detailPayload;
    elements.relatedProcesses.textContent = String(
      new Set(events.map((event) => event.pid).filter(Number.isFinite)).size,
    );
    elements.relatedFiles.textContent = String(
      events.filter((event) => event.kind === 'file').length,
    );
    elements.relatedNetwork.textContent = String(
      events.filter((event) => event.kind === 'network').length,
    );
  }

  function setInspectorIo(input, output) {
    state.detailInput = input;
    state.detailOutput = output;
    elements.detailInputBlock.hidden = !input;
    elements.detailOutputBlock.hidden = !output;
    elements.detailInput.textContent = input;
    elements.detailOutput.textContent = output;
  }

  function nearBottom() {
    return (
      elements.content.scrollHeight - elements.content.scrollTop - elements.content.clientHeight <
      80
    );
  }

  function installPanelResizer(handle, side) {
    const property = side === 'sidebar' ? '--sidebar-width' : '--inspector-width';
    const panel = side === 'sidebar' ? elements.sidebar : elements.inspector;
    const otherPanel = side === 'sidebar' ? elements.inspector : elements.sidebar;
    const minimum = side === 'sidebar' ? 220 : 240;
    const maximum = 520;
    const mainMinimum = 420;

    const updateAriaValue = () => {
      handle.setAttribute('aria-valuenow', String(Math.round(panel.getBoundingClientRect().width)));
    };
    requestAnimationFrame(updateAriaValue);

    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const bounds = elements.workspace.getBoundingClientRect();
      const startClientX = event.clientX;
      const startWidth = panel.getBoundingClientRect().width;
      const resizerWidth =
        elements.sidebarResizer.getBoundingClientRect().width +
        elements.inspectorResizer.getBoundingClientRect().width;
      const availableMaximum = Math.max(
        minimum,
        Math.min(
          maximum,
          bounds.width - otherPanel.getBoundingClientRect().width - mainMinimum - resizerWidth,
        ),
      );
      handle.classList.add('active');
      document.body.classList.add('is-resizing');

      const move = (moveEvent) => {
        const requested =
          side === 'sidebar'
            ? startWidth + moveEvent.clientX - startClientX
            : startWidth - (moveEvent.clientX - startClientX);
        const width = Math.round(Math.min(availableMaximum, Math.max(minimum, requested)));
        elements.workspace.style.setProperty(property, width + 'px');
        handle.setAttribute('aria-valuenow', String(width));
      };
      const stop = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', stop);
        window.removeEventListener('pointercancel', stop);
        handle.classList.remove('active');
        document.body.classList.remove('is-resizing');
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', stop);
      window.addEventListener('pointercancel', stop);
    });
  }

  installPanelResizer(elements.sidebarResizer, 'sidebar');
  installPanelResizer(elements.inspectorResizer, 'inspector');

  elements.search.addEventListener('input', render);
  elements.follow.addEventListener('click', () => {
    state.follow = !state.follow;
    elements.follow.classList.toggle('active', state.follow);
    if (state.follow) elements.content.scrollTop = elements.content.scrollHeight;
  });
  elements.systemFiles.addEventListener('click', () => {
    state.showSystemFiles = !state.showSystemFiles;
    elements.systemFiles.classList.toggle('active', state.showSystemFiles);
    render();
  });
  elements.content.addEventListener('scroll', () => {
    if (state.follow && !nearBottom()) {
      state.follow = false;
      elements.follow.classList.remove('active');
    }
  });
  elements.clearEvents.addEventListener('click', () => {
    const execution = activeExecution();
    if (!execution || activeEvents().length === 0 || !state.socket) return;
    if (!window.confirm('Clear detailed events for this execution? The command record is kept.')) {
      return;
    }
    state.socket.send(JSON.stringify({ type: 'clear_events', execution_id: execution.id }));
  });

  async function copyDetail(text, button, idleLabel) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = '✓ Copied';
      window.setTimeout(() => {
        button.textContent = idleLabel;
      }, 1200);
    } catch {
      button.textContent = 'Copy unavailable';
    }
  }
  elements.copyInput.addEventListener('click', () =>
    copyDetail(state.detailInput, elements.copyInput, '▣ Copy input'),
  );
  elements.copyOutput.addEventListener('click', () =>
    copyDetail(state.detailOutput, elements.copyOutput, '▣ Copy output'),
  );
  elements.copyEvent.addEventListener('click', () =>
    copyDetail(state.detailPayload, elements.copyEvent, '▣ Copy JSON'),
  );
  window.setInterval(() => {
    if (activeExecution()?.status === 'running') renderSummary();
  }, 1000);

  connect(tokenFromFragment(), 0);
})();
