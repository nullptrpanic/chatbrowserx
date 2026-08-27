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
    collapsedNodes: new Set(),
    socket: null,
  };

  const elements = {
    connection: document.querySelector('.connection'),
    connectionLabel: document.querySelector('#connection-label'),
    search: document.querySelector('#search'),
    eventTotal: document.querySelector('#event-total'),
    executionList: document.querySelector('#execution-list'),
    clearExecutions: document.querySelector('#clear-executions'),
    selectedCommand: document.querySelector('#selected-command'),
    selectedStatus: document.querySelector('#selected-status'),
    selectedCwd: document.querySelector('#selected-cwd'),
    selectedRunId: document.querySelector('#selected-run-id'),
    monitoringMode: document.querySelector('#monitoring-mode'),
    processCount: document.querySelector('#process-count'),
    fileCount: document.querySelector('#file-count'),
    hostCount: document.querySelector('#host-count'),
    duration: document.querySelector('#duration'),
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
    detailOwnershipBlock: document.querySelector('#detail-ownership-block'),
    detailOwnership: document.querySelector('#detail-ownership'),
    detailWorkingDirectoryBlock: document.querySelector('#detail-working-directory-block'),
    detailWorkingDirectory: document.querySelector('#detail-working-directory'),
    detailInputBlock: document.querySelector('#detail-input-block'),
    detailInput: document.querySelector('#detail-input'),
    detailOutputBlock: document.querySelector('#detail-output-block'),
    detailOutput: document.querySelector('#detail-output'),
    detailPayload: document.querySelector('#detail-payload'),
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
      if (update.type === 'executions_cleared') applyExecutionsCleared();
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

  function applyExecutionsCleared() {
    state.executions.clear();
    state.events.clear();
    state.collapsedNodes.clear();
    state.selectedExecutionId = null;
    state.selectedEventSequence = null;
    state.selectedCommand = false;
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

  function visibleEvents(execution, events) {
    const boundary = execution?.user_command_started_at_ms;
    if (!Number.isFinite(boundary)) return events;
    const rootPid = inferRootIdentity(execution, events).pid;
    const hiddenProcessIds = new Set(
      events
        .filter(
          (event) =>
            event.kind === 'process' &&
            Number.isFinite(event.pid) &&
            event.pid !== rootPid &&
            event.timestamp_ms < boundary,
        )
        .map((event) => event.pid),
    );
    let changed = true;
    while (changed) {
      changed = false;
      for (const event of events) {
        if (
          event.kind !== 'process' ||
          !Number.isFinite(event.pid) ||
          event.pid === rootPid ||
          !hiddenProcessIds.has(event.ppid) ||
          hiddenProcessIds.has(event.pid)
        ) {
          continue;
        }
        hiddenProcessIds.add(event.pid);
        changed = true;
      }
    }
    return events.filter(
      (event) =>
        event.timestamp_ms >= boundary &&
        (!Number.isFinite(event.pid) || !hiddenProcessIds.has(event.pid)),
    );
  }

  function activeVisibleEvents() {
    const execution = activeExecution();
    return execution ? visibleEvents(execution, activeEvents()) : [];
  }

  function queryMatches(value) {
    const query = elements.search.value.trim().toLocaleLowerCase();
    return !query || JSON.stringify(value).toLocaleLowerCase().includes(query);
  }

  function isSystemFile(event) {
    if (event.kind !== 'file') return false;
    return /^\/(System|Library|usr\/lib|private\/var\/db)(\/|$)/.test(event.path || '');
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
      const timing = create('span', 'execution-timing');
      timing.append(
        timestampElement(execution.started_at_ms, 'execution-start-time'),
        document.createTextNode('· ' + formatDuration(duration)),
      );
      firstMeta.append(
        timing,
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
    elements.clearExecutions.disabled = state.executions.size === 0;
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
      return;
    }
    const events = activeVisibleEvents();
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
    const events = activeVisibleEvents();
    const root = pruneTimelineTree(buildTimelineTree(execution, events), true);
    const rows = [];
    if (root) renderTimelineNode(root, 1, rows, processIndex(events));
    elements.timeline.replaceChildren(...(rows.length ? rows : [empty()]));
  }

  function inferRootIdentity(execution, events) {
    const pids = new Set(events.map((event) => event.pid).filter(Number.isFinite));
    const parent = events
      .filter((event) => event.kind === 'process' && Number.isFinite(event.ppid))
      .map((event) => event.ppid)
      .find((pid) => pids.has(pid));
    const pid = execution.pid ?? parent ?? events[0]?.pid ?? null;
    const process = events.find((event) => event.kind === 'process' && event.pid === pid);
    return { pid, ppid: execution.ppid ?? process?.ppid ?? null };
  }

  function buildTimelineTree(execution, events) {
    const ordered = [...events].sort(
      (left, right) => left.timestamp_ms - right.timestamp_ms || left.sequence - right.sequence,
    );
    const identity = inferRootIdentity(execution, ordered);
    const root = {
      id: 'command:' + execution.id,
      type: 'command',
      execution,
      primaryEvent: null,
      pid: identity.pid,
      ppid: identity.ppid,
      executable: execution.command,
      timestamp: execution.started_at_ms,
      sequence: 0,
      children: [],
      root: true,
    };
    const processes = new Map();
    const eventNodes = new Map();

    for (const event of ordered.filter((candidate) => candidate.kind === 'process')) {
      if (event.pid === root.pid) {
        eventNodes.set(eventKey(event), root);
        continue;
      }
      let node = processes.get(event.pid);
      const executable = event.executable || 'Process ' + event.pid;
      if (!node) {
        node = {
          id: 'process:' + execution.id + ':' + event.sequence,
          type: 'command',
          execution,
          primaryEvent: event,
          pid: event.pid,
          ppid: event.ppid ?? null,
          executable,
          timestamp: event.timestamp_ms,
          sequence: event.sequence,
          processEvents: [],
          children: [],
        };
        processes.set(event.pid, node);
      }
      node.processEvents.push(event);
      if (event.event === 'exec') {
        node.primaryEvent = event;
        node.executable = executable;
        node.ppid = event.ppid ?? node.ppid;
      }
      eventNodes.set(eventKey(event), node);
    }

    for (const node of processes.values()) {
      const parent = node.ppid === root.pid ? root : (processes.get(node.ppid) ?? root);
      (parent === node ? root : parent).children.push(node);
    }

    for (const event of ordered) {
      if (event.kind === 'process') {
        const node = eventNodes.get(eventKey(event));
        if (node === root) {
          node.children.push(eventLeaf(event));
          continue;
        }
        if (node?.primaryEvent === event) continue;
        node?.children.push(eventLeaf(event));
      } else {
        const unmatched = hasUnmatchedPid(event, root.pid, processes);
        const owner = unmatched || event.pid === root.pid ? root : processes.get(event.pid);
        owner.children.push(eventLeaf(event, unmatched));
      }
    }
    sortTreeChildren(root);
    return root;
  }

  function eventLeaf(event, unmatched = false) {
    return {
      id: 'event:' + eventKey(event),
      type: 'event',
      event,
      unmatched,
      timestamp: event.timestamp_ms,
      sequence: event.sequence,
      children: [],
    };
  }

  function hasUnmatchedPid(event, rootPid, processes) {
    return event.kind !== 'process' && event.pid !== rootPid && !processes.has(event.pid);
  }

  function sortTreeChildren(node) {
    node.children.sort(
      (left, right) => left.timestamp - right.timestamp || left.sequence - right.sequence,
    );
    for (const child of node.children) sortTreeChildren(child);
  }

  function pruneTimelineTree(node, isRoot) {
    if (node.type === 'event') {
      if (!state.showSystemFiles && isSystemFile(node.event)) return null;
      return queryMatches(node.event) ? node : null;
    }
    const children = node.children.map((child) => pruneTimelineTree(child, false)).filter(Boolean);
    if (!isRoot && elements.search.value.trim() && !queryMatches(node) && children.length === 0) {
      return null;
    }
    return { ...node, children };
  }

  function renderTimelineNode(node, level, rows, processes) {
    if (node.type === 'command') {
      rows.push(commandRow(node, level));
      if (state.collapsedNodes.has(node.id)) return;
    } else {
      rows.push(eventRow(node, processes, level));
    }
    for (const child of node.children) renderTimelineNode(child, level + 1, rows, processes);
  }

  function commandRow(node, level) {
    const execution = node.execution;
    const root = node.root === true;
    const selected = root
      ? state.selectedCommand
      : node.primaryEvent?.sequence === state.selectedEventSequence;
    const row = create(
      'button',
      'event-row command-row' + (root ? ' root-command' : '') + (selected ? ' selected' : ''),
    );
    row.type = 'button';
    row.setAttribute('role', 'treeitem');
    row.setAttribute('aria-level', String(level));
    row.dataset.treeId = node.id;
    row.style.setProperty('--depth', String(level - 1));
    row.setAttribute('aria-expanded', String(!state.collapsedNodes.has(node.id)));
    row.addEventListener('click', () => {
      if (root || node.primaryEvent) {
        state.selectedCommand = root;
        state.selectedEventSequence = root ? null : node.primaryEvent.sequence;
      }
      if (state.collapsedNodes.has(node.id)) state.collapsedNodes.delete(node.id);
      else state.collapsedNodes.add(node.id);
      render();
    });
    const main = create('span', 'event-main');
    const label = create('span', 'event-label', node.executable);
    label.title = node.executable;
    main.append(
      create('span', 'tree-chevron', state.collapsedNodes.has(node.id) ? '▶' : '▼'),
      create('span', 'badge ' + (root ? 'command' : 'process'), root ? 'COMMAND' : 'EXEC'),
      label,
    );
    const identity = 'PID ' + (node.pid ?? '—') + ' · PPID ' + (node.ppid ?? '—');
    row.append(
      main,
      create('span', 'event-detail', identity + (root ? ' · ' + statusText(execution.status) : '')),
      eventTime(node.timestamp),
    );
    return row;
  }

  function eventTime(timestamp) {
    return timestampElement(timestamp, 'event-time');
  }

  function timestampElement(timestamp, className) {
    const time = create('time', className, formatTime(timestamp));
    time.dateTime = new Date(timestamp).toISOString();
    return time;
  }

  function eventRow(node, processes, level) {
    const event = node.event;
    const description = eventDescription(event, processes);
    const row = create(
      'button',
      'event-row' +
        (node.unmatched ? ' unmatched' : '') +
        (event.sequence === state.selectedEventSequence ? ' selected' : ''),
    );
    row.type = 'button';
    row.setAttribute('role', 'treeitem');
    row.setAttribute('aria-level', String(level));
    row.style.setProperty('--depth', String(level - 1));
    row.addEventListener('click', () => {
      state.selectedEventSequence = event.sequence;
      state.selectedCommand = false;
      render();
    });
    const main = create('span', 'event-main');
    main.append(
      create('span', 'tree-chevron spacer', '▶'),
      create('span', 'badge ' + event.kind, description.badge),
      create('span', 'event-label', description.primary),
    );
    row.append(
      main,
      create(
        'span',
        'event-detail',
        description.secondary + (node.unmatched ? ' · UNMATCHED PID' : ''),
      ),
      eventTime(event.timestamp_ms),
    );
    return row;
  }

  function processIndex(events) {
    const processes = new Map();
    for (const event of events) {
      if (event.executable && !processes.has(event.pid)) processes.set(event.pid, event);
    }
    for (const event of events) {
      if (event.kind === 'process' && event.executable) processes.set(event.pid, event);
    }
    return processes;
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
      secondary:
        (endpoint || event.event || 'network') +
        ' · PID ' +
        event.pid +
        ownerSuffix(processes.get(event.pid)),
    };
  }

  function ownerSuffix(owner) {
    if (!owner || !owner.executable) return '';
    const pieces = owner.executable.split('/');
    return ' · ' + pieces[pieces.length - 1];
  }

  function renderInspector() {
    const execution = activeExecution();
    const events = activeVisibleEvents();
    if (state.selectedCommand && execution) {
      renderCommandInspector(execution, events);
      return;
    }
    const event = events.find((candidate) => candidate.sequence === state.selectedEventSequence);
    if (!event) {
      elements.detailEmpty.hidden = false;
      elements.detailContent.hidden = true;
      state.detailPayload = '';
      elements.detailOwnershipBlock.hidden = true;
      elements.detailWorkingDirectoryBlock.hidden = true;
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
    const processPids = new Set(
      events.filter((candidate) => candidate.kind === 'process').map((candidate) => candidate.pid),
    );
    const unmatched =
      execution && hasUnmatchedPid(event, inferRootIdentity(execution, events).pid, processPids);
    elements.detailOwnershipBlock.hidden = !unmatched;
    elements.detailOwnership.textContent = unmatched ? 'UNMATCHED PID' : '';
    elements.detailWorkingDirectoryBlock.hidden = true;
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
  }

  function renderCommandInspector(execution, events) {
    elements.detailEmpty.hidden = true;
    elements.detailContent.hidden = false;
    elements.detailBadge.className = 'badge command';
    elements.detailBadge.textContent = 'COMMAND';
    elements.detailTitle.textContent = statusText(execution.status);
    elements.detailPrimaryLabel.textContent = 'Command';
    elements.detailPrimary.textContent = execution.command;
    const identity = inferRootIdentity(execution, events);
    elements.detailPid.textContent = String(identity.pid ?? '—');
    elements.detailPpid.textContent = String(identity.ppid ?? '—');
    elements.detailRunId.textContent = shortId(execution.id);
    elements.detailOwnershipBlock.hidden = true;
    elements.detailOwnership.textContent = '';
    elements.detailWorkingDirectoryBlock.hidden = !execution.cwd;
    elements.detailWorkingDirectory.textContent = execution.cwd || 'default working directory';
    setInspectorIo(
      execution.command,
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
  elements.clearExecutions.addEventListener('click', () => {
    if (state.executions.size === 0 || !state.socket) return;
    if (
      !window.confirm('Clear all execution tasks and events? Running commands are not stopped.')
    ) {
      return;
    }
    state.socket.send(JSON.stringify({ type: 'clear_executions' }));
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
