import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const html = readFileSync(resolve('sandbox/src/web/assets/index.html'), 'utf8');
const script = readFileSync(resolve('sandbox/src/web/assets/app.js'), 'utf8');

class ViewerSocket {
  static instances = [];

  sent = [];
  listeners = new Map();

  constructor(url) {
    this.url = url;
    ViewerSocket.instances.push(this);
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(value) {
    this.sent.push(value);
  }

  open() {
    for (const listener of this.listeners.get('open') ?? []) listener();
  }

  message(update) {
    for (const listener of this.listeners.get('message') ?? []) {
      listener({ data: JSON.stringify(update) });
    }
  }
}

function openViewer(url) {
  ViewerSocket.instances = [];
  const dom = new JSDOM(html, {
    pretendToBeVisual: true,
    runScripts: 'outside-only',
    url,
  });
  Object.defineProperty(dom.window, 'WebSocket', {
    configurable: true,
    value: ViewerSocket,
  });
  dom.window.eval(script);
  return { dom, socket: ViewerSocket.instances[0] };
}

describe('Sandbox audit viewer', () => {
  it('keeps Timeline as the only central audit view', () => {
    const viewer = openViewer('http://127.0.0.1:43130/#token=viewer-token');

    expect(
      [...viewer.dom.window.document.querySelectorAll('.tab')].map((tab) =>
        tab.textContent?.trim(),
      ),
    ).toEqual(['Timeline']);
    expect(viewer.dom.window.document.querySelector('#processes')).toBeNull();
    expect(viewer.dom.window.document.querySelector('#files')).toBeNull();
    expect(viewer.dom.window.document.querySelector('#network')).toBeNull();
    expect(viewer.dom.window.document.querySelector('.related')).toBeNull();

    viewer.dom.window.close();
  });

  it('retains the fragment token so a page refresh can authenticate again', () => {
    const token = 'viewer-refresh-token';
    const first = openViewer(`http://127.0.0.1:43130/#token=${token}`);

    expect(first.dom.window.location.hash).toBe(`#token=${token}`);
    expect(first.socket).toBeDefined();
    first.socket?.open();
    expect(first.socket?.sent).toEqual([JSON.stringify({ type: 'auth', token })]);

    const refreshed = openViewer(first.dom.window.location.href);
    expect(refreshed.socket).toBeDefined();
    refreshed.socket?.open();
    expect(refreshed.socket?.sent).toEqual([JSON.stringify({ type: 'auth', token })]);

    first.dom.window.close();
    refreshed.dom.window.close();
  });

  it('renders the original command as the first timeline row at the execution start time', () => {
    const viewer = openViewer('http://127.0.0.1:43130/#token=viewer-token');
    const command = 'printf "original command"';
    const startedAt = Date.parse('2026-08-25T10:00:00.000Z');

    viewer.socket?.message({
      type: 'snapshot',
      snapshot: {
        executions: [
          {
            id: 'run-1',
            command,
            cwd: '/workspace',
            started_at_ms: startedAt,
            finished_at_ms: startedAt + 100,
            duration_ms: 100,
            status: 'succeeded',
            exit_code: 0,
            process_events: 1,
            file_events: 0,
            network_events: 0,
          },
        ],
        events: [
          {
            sequence: 1,
            execution_id: 'run-1',
            timestamp_ms: startedAt + 10,
            kind: 'process',
            event: 'exec',
            pid: 42,
            ppid: 41,
            executable: '/bin/printf',
          },
        ],
      },
    });

    const firstRow = viewer.dom.window.document.querySelector('#timeline-rows .event-row');
    expect(firstRow?.querySelector('.badge')?.textContent).toBe('COMMAND');
    expect(firstRow?.querySelector('.event-label')?.textContent).toBe(command);
    expect(firstRow?.querySelector('time')?.dateTime).toBe(new Date(startedAt).toISOString());

    viewer.dom.window.close();
  });

  it('labels file lifecycle events explicitly', () => {
    const viewer = openViewer('http://127.0.0.1:43130/#token=viewer-token');
    const startedAt = Date.parse('2026-08-25T10:00:00.000Z');

    viewer.socket?.message({
      type: 'snapshot',
      snapshot: {
        executions: [executionFixture({ started_at_ms: startedAt })],
        events: [
          fileEventFixture(1, 'open', startedAt + 1),
          fileEventFixture(2, 'close', startedAt + 2),
        ],
      },
    });

    expect(
      [...viewer.dom.window.document.querySelectorAll('#timeline-rows .badge')].map(
        (badge) => badge.textContent,
      ),
    ).toEqual(['COMMAND', 'FILE OPEN', 'FILE CLOSE']);

    viewer.dom.window.close();
  });

  it('does not apply the empty-state layout to file and network leaf rows', () => {
    const viewer = openViewer('http://127.0.0.1:43130/#token=viewer-token');
    const startedAt = Date.parse('2026-08-25T10:00:00.000Z');

    viewer.socket?.message({
      type: 'snapshot',
      snapshot: {
        executions: [executionFixture({ started_at_ms: startedAt })],
        events: [fileEventFixture(1, 'open', startedAt + 1)],
      },
    });

    const leafChevron = viewer.dom.window.document.querySelector(
      '#timeline-rows .event-row:not(.command-row) .tree-chevron',
    );
    expect(leafChevron?.classList.contains('empty')).toBe(false);

    viewer.dom.window.close();
  });

  it('shows complete command and exec inputs and outputs in the inspector', () => {
    const viewer = openViewer('http://127.0.0.1:43130/#token=viewer-token');
    const command = 'printf "a complete command that must not be truncated"';
    const startedAt = Date.parse('2026-08-25T10:00:00.000Z');
    viewer.socket?.message({
      type: 'snapshot',
      snapshot: {
        executions: [
          executionFixture({
            command,
            started_at_ms: startedAt,
            stdout: 'command stdout',
            stderr: 'command stderr',
          }),
        ],
        events: [
          {
            sequence: 1,
            execution_id: 'run-1',
            timestamp_ms: startedAt + 1,
            kind: 'process',
            event: 'exec',
            pid: 42,
            ppid: 41,
            executable: '/usr/bin/printf',
            operation: 'execve',
            arguments: ['printf', '%s', 'hello'],
            current_dir: '/workspace',
            status: 'started',
            error_code: null,
            error_message: null,
          },
        ],
      },
    });

    const rows = viewer.dom.window.document.querySelectorAll('#timeline-rows .event-row');
    rows[0]?.click();
    expect(viewer.dom.window.document.querySelector('#detail-primary')?.textContent).toBe(command);
    expect(viewer.dom.window.document.querySelector('#detail-input')?.textContent).toContain(
      command,
    );
    expect(viewer.dom.window.document.querySelector('#detail-output')?.textContent).toContain(
      'command stdout',
    );
    expect(viewer.dom.window.document.querySelector('#detail-output')?.textContent).toContain(
      'command stderr',
    );

    rows[1]?.click();
    expect(viewer.dom.window.document.querySelector('#detail-input')?.textContent).toContain(
      '"operation": "execve"',
    );
    expect(viewer.dom.window.document.querySelector('#detail-input')?.textContent).toContain(
      '"hello"',
    );
    expect(viewer.dom.window.document.querySelector('#detail-output')?.textContent).toContain(
      '"status": "started"',
    );

    viewer.dom.window.close();
  });

  it('keeps the working directory separate from the copyable command input', () => {
    const viewer = openViewer('http://127.0.0.1:43130/#token=viewer-token');
    const command = 'printf "copy only this command"';
    viewer.socket?.message({
      type: 'snapshot',
      snapshot: {
        executions: [executionFixture({ command, cwd: '/workspace/project' })],
        events: [],
      },
    });

    viewer.dom.window.document.querySelector('#timeline-rows .command-row')?.click();

    expect(viewer.dom.window.document.querySelector('#detail-input')?.textContent).toBe(command);
    expect(viewer.dom.window.document.querySelector('#detail-working-directory')?.textContent).toBe(
      '/workspace/project',
    );

    viewer.dom.window.close();
  });

  it('shows the execution start time in every left-side execution card', () => {
    const viewer = openViewer('http://127.0.0.1:43130/#token=viewer-token');
    const startedAt = Date.parse('2026-08-25T10:00:00.000Z');
    viewer.socket?.message({
      type: 'snapshot',
      snapshot: {
        executions: [executionFixture({ started_at_ms: startedAt })],
        events: [],
      },
    });

    const time = viewer.dom.window.document.querySelector('.execution .execution-start-time');
    expect(time?.textContent).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(time?.getAttribute('datetime')).toBe(new Date(startedAt).toISOString());

    viewer.dom.window.close();
  });

  it('clears every left-side execution and its events after confirmation', () => {
    const viewer = openViewer('http://127.0.0.1:43130/#token=viewer-token');
    viewer.dom.window.confirm = () => true;
    viewer.socket?.open();
    const second = executionFixture({ id: 'run-2', command: 'second command' });
    viewer.socket?.message({
      type: 'snapshot',
      snapshot: {
        executions: [executionFixture(), second],
        events: [
          fileEventFixture(1, 'open', Date.now()),
          {
            ...fileEventFixture(2, 'open', Date.now() + 1),
            execution_id: 'run-2',
          },
        ],
      },
    });

    const clear = viewer.dom.window.document.querySelector('.section-heading #clear-executions');
    clear?.click();
    expect(viewer.socket?.sent.at(-1)).toBe(JSON.stringify({ type: 'clear_executions' }));

    viewer.socket?.message({ type: 'executions_cleared' });
    expect(viewer.dom.window.document.querySelectorAll('.execution')).toHaveLength(0);
    expect(viewer.dom.window.document.querySelector('#selected-command')?.textContent).toBe(
      'No execution selected',
    );
    expect(viewer.dom.window.document.querySelector('#event-total')?.textContent).toBe('0 events');

    viewer.dom.window.close();
  });

  it('renders command activity as a collapsible PID and PPID hierarchy', () => {
    const viewer = openViewer('http://127.0.0.1:43130/#token=viewer-token');
    const startedAt = Date.parse('2026-08-25T10:00:00.000Z');
    viewer.socket?.message({
      type: 'snapshot',
      snapshot: {
        executions: [executionFixture({ pid: 10, ppid: 1, started_at_ms: startedAt })],
        events: [
          {
            ...fileEventFixture(1, 'open', startedAt + 1),
            pid: 10,
            path: '/root-file',
          },
          processEventFixture(2, startedAt + 2, 20, 10, '/usr/bin/find'),
          {
            ...fileEventFixture(3, 'open', startedAt + 3),
            pid: 20,
            path: '/child-file',
          },
          processEventFixture(4, startedAt + 4, 30, 20, '/usr/bin/head'),
          {
            sequence: 5,
            execution_id: 'run-1',
            timestamp_ms: startedAt + 5,
            kind: 'network',
            event: 'connect_established',
            pid: 30,
            host: 'example.test',
            ip: '192.0.2.10',
            port: 443,
            result: 'succeeded',
          },
        ],
      },
    });

    const rows = () => [
      ...viewer.dom.window.document.querySelectorAll('#timeline-rows [role="treeitem"]'),
    ];
    expect(rows().map((row) => row.querySelector('.event-label')?.textContent)).toEqual([
      'printf test',
      '/root-file',
      '/usr/bin/find',
      '/child-file',
      '/usr/bin/head',
      'example.test',
    ]);
    expect(rows().map((row) => row.getAttribute('aria-level'))).toEqual([
      '1',
      '2',
      '2',
      '3',
      '3',
      '4',
    ]);
    expect(rows()[0]?.querySelector('.event-detail')?.textContent).toContain('PID 10 · PPID 1');

    const find = rows().find(
      (row) => row.querySelector('.event-label')?.textContent === '/usr/bin/find',
    );
    expect(find?.getAttribute('aria-expanded')).toBe('true');
    find?.click();
    expect(rows().map((row) => row.querySelector('.event-label')?.textContent)).toEqual([
      'printf test',
      '/root-file',
      '/usr/bin/find',
    ]);

    find?.click();
    expect(rows().map((row) => row.querySelector('.event-label')?.textContent)).toEqual([
      'printf test',
      '/root-file',
      '/usr/bin/find',
      '/child-file',
      '/usr/bin/head',
      'example.test',
    ]);

    viewer.dom.window.close();
  });

  it('hides a trusted shell-initialization process and its complete descendant subtree', () => {
    const viewer = openViewer('http://127.0.0.1:43130/#token=viewer-token');
    const startedAt = Date.parse('2026-08-25T10:00:00.000Z');
    const boundary = startedAt + 50;
    viewer.socket?.message({
      type: 'snapshot',
      snapshot: {
        executions: [
          executionFixture({
            pid: 10,
            ppid: 1,
            started_at_ms: startedAt,
            user_command_started_at_ms: boundary,
          }),
        ],
        events: [
          {
            ...fileEventFixture(1, 'open', startedAt + 1),
            pid: 10,
            ppid: 1,
            executable: '/bin/bash',
            path: '/etc/profile',
          },
          processEventFixture(2, startedAt + 2, 20, 10, '/usr/libexec/path_helper'),
          {
            ...fileEventFixture(3, 'open', startedAt + 3),
            pid: 20,
            ppid: 10,
            executable: '/usr/libexec/path_helper',
            path: '/etc/paths',
          },
          processEventFixture(4, boundary + 10, 30, 20, '/usr/bin/background-child'),
          {
            sequence: 5,
            execution_id: 'run-1',
            timestamp_ms: boundary + 11,
            kind: 'network',
            event: 'connect_established',
            pid: 30,
            ppid: 20,
            executable: '/usr/bin/background-child',
            host: 'initialization.test',
            ip: '192.0.2.30',
            port: 443,
            result: 'succeeded',
          },
          processEventFixture(6, boundary + 1, 40, 10, '/opt/homebrew/bin/lark-cli'),
          {
            ...fileEventFixture(7, 'open', boundary + 3),
            pid: 40,
            ppid: 10,
            executable: '/opt/homebrew/bin/lark-cli',
            path: '/workspace/actual-input',
          },
          {
            ...fileEventFixture(8, 'open', boundary + 2),
            pid: 10,
            ppid: 1,
            executable: '/bin/bash',
            path: '/etc/profile',
          },
        ],
      },
    });

    expect(
      [...viewer.dom.window.document.querySelectorAll('#timeline-rows .event-label')].map(
        (label) => label.textContent,
      ),
    ).toEqual([
      'printf test',
      '/opt/homebrew/bin/lark-cli',
      '/workspace/actual-input',
      '/etc/profile',
    ]);
    expect(viewer.dom.window.document.querySelector('#process-count')?.textContent).toBe('2');
    expect(viewer.dom.window.document.querySelector('#file-count')?.textContent).toBe('2');
    expect(viewer.dom.window.document.querySelector('#host-count')?.textContent).toBe('0');

    viewer.dom.window.close();
  });

  it('keeps initialization-looking activity when no trusted boundary was recorded', () => {
    const viewer = openViewer('http://127.0.0.1:43130/#token=viewer-token');
    const startedAt = Date.parse('2026-08-25T10:00:00.000Z');
    viewer.socket?.message({
      type: 'snapshot',
      snapshot: {
        executions: [executionFixture({ pid: 10, ppid: 1, started_at_ms: startedAt })],
        events: [
          processEventFixture(1, startedAt + 1, 20, 10, '/usr/libexec/path_helper'),
          {
            ...fileEventFixture(2, 'open', startedAt + 2),
            pid: 20,
            ppid: 10,
            executable: '/usr/libexec/path_helper',
            path: '/etc/paths',
          },
        ],
      },
    });

    expect(
      [...viewer.dom.window.document.querySelectorAll('#timeline-rows .event-label')].map(
        (label) => label.textContent,
      ),
    ).toEqual(['printf test', '/usr/libexec/path_helper', '/etc/paths']);

    viewer.dom.window.close();
  });

  it('keeps events at the exact boundary timestamp because their phase is ambiguous', () => {
    const viewer = openViewer('http://127.0.0.1:43130/#token=viewer-token');
    const boundary = Date.parse('2026-08-25T10:00:00.050Z');
    viewer.socket?.message({
      type: 'snapshot',
      snapshot: {
        executions: [executionFixture({ user_command_started_at_ms: boundary })],
        events: [
          {
            ...fileEventFixture(1, 'open', boundary),
            path: '/etc/profile',
          },
        ],
      },
    });

    expect(
      [...viewer.dom.window.document.querySelectorAll('#timeline-rows .event-label')].map(
        (label) => label.textContent,
      ),
    ).toEqual(['printf test', '/etc/profile']);

    viewer.dom.window.close();
  });

  it('associates events by exact PID and marks only unmatched ownership as abnormal', () => {
    const viewer = openViewer('http://127.0.0.1:43130/#token=viewer-token');
    const startedAt = Date.parse('2026-08-25T10:00:00.000Z');
    viewer.socket?.message({
      type: 'snapshot',
      snapshot: {
        executions: [executionFixture({ pid: 10, ppid: 1, started_at_ms: startedAt })],
        events: [
          {
            sequence: 8,
            execution_id: 'run-1',
            timestamp_ms: startedAt + 13,
            kind: 'network',
            event: 'connect_established',
            pid: 20,
            ppid: 10,
            executable: '/usr/bin/find',
            host: 'find.test',
            ip: '192.0.2.20',
            port: 443,
            result: 'succeeded',
          },
          processEventFixture(6, startedAt + 12, 30, 20, '/usr/bin/head'),
          {
            ...fileEventFixture(5, 'open', startedAt + 11),
            pid: 20,
            ppid: 10,
            executable: '/usr/bin/find',
            path: '/find-file',
          },
          {
            sequence: 3,
            execution_id: 'run-1',
            timestamp_ms: startedAt + 7,
            kind: 'network',
            event: 'connect_established',
            pid: 99,
            ppid: 77,
            executable: '/usr/bin/curl',
            host: 'unmatched.test',
            ip: '192.0.2.99',
            port: 443,
            result: 'succeeded',
          },
          {
            ...fileEventFixture(7, 'open', startedAt + 14),
            pid: 30,
            ppid: 20,
            executable: '/usr/bin/head',
            path: '/head-file',
          },
          {
            ...fileEventFixture(2, 'open', startedAt + 5),
            pid: 10,
            ppid: 1,
            executable: '/bin/bash',
            path: '/root-file',
          },
          processEventFixture(4, startedAt + 10, 20, 10, '/usr/bin/find'),
        ],
      },
    });

    const rows = [
      ...viewer.dom.window.document.querySelectorAll('#timeline-rows [role="treeitem"]'),
    ];
    expect(rows.map((row) => row.querySelector('.event-label')?.textContent)).toEqual([
      'printf test',
      '/root-file',
      'unmatched.test',
      '/usr/bin/find',
      '/find-file',
      '/usr/bin/head',
      '/head-file',
      'find.test',
    ]);
    expect(rows.map((row) => row.getAttribute('aria-level'))).toEqual([
      '1',
      '2',
      '2',
      '2',
      '3',
      '3',
      '4',
      '3',
    ]);
    const unmatched = rows.find(
      (row) => row.querySelector('.event-label')?.textContent === 'unmatched.test',
    );
    expect(unmatched?.classList.contains('unmatched')).toBe(true);
    expect(unmatched?.querySelector('.event-detail')?.textContent).toContain('PID 99');
    expect(unmatched?.querySelector('.event-detail')?.textContent).toContain('UNMATCHED PID');
    unmatched?.click();
    const ownership = viewer.dom.window.document.querySelector('#detail-ownership-block');
    expect(ownership?.hidden).toBe(false);
    expect(ownership?.querySelector('label')?.textContent).toBe('Error');
    expect(ownership?.textContent).toContain('UNMATCHED PID');

    const matched = [
      ...viewer.dom.window.document.querySelectorAll('#timeline-rows [role="treeitem"]'),
    ].find((row) => row.querySelector('.event-label')?.textContent === '/root-file');
    matched?.click();
    expect(ownership?.hidden).toBe(true);
    expect(
      rows
        .find((row) => row.querySelector('.event-label')?.textContent === '/root-file')
        ?.classList.contains('unmatched'),
    ).toBe(false);
    expect(rows.some((row) => row.textContent?.includes('Observed process'))).toBe(false);

    viewer.dom.window.close();
  });

  it('filters a hierarchical timeline without breaking command ancestry', () => {
    const viewer = openViewer('http://127.0.0.1:43130/#token=viewer-token');
    const startedAt = Date.parse('2026-08-25T10:00:00.000Z');
    viewer.socket?.message({
      type: 'snapshot',
      snapshot: {
        executions: [executionFixture({ pid: 10, ppid: 1, started_at_ms: startedAt })],
        events: [
          processEventFixture(1, startedAt + 1, 20, 10, '/usr/bin/find'),
          {
            ...fileEventFixture(2, 'open', startedAt + 2),
            pid: 20,
            path: '/tmp/result',
          },
          processEventFixture(3, startedAt + 3, 30, 20, '/usr/bin/head'),
        ],
      },
    });

    const search = viewer.dom.window.document.querySelector('#search');
    search.value = 'find';
    search.dispatchEvent(new viewer.dom.window.Event('input'));

    expect(
      [...viewer.dom.window.document.querySelectorAll('#timeline-rows .event-label')].map(
        (label) => label.textContent,
      ),
    ).toEqual(['printf test', '/usr/bin/find']);

    viewer.dom.window.close();
  });

  it('preserves collapsed command nodes while live child events arrive', () => {
    const viewer = openViewer('http://127.0.0.1:43130/#token=viewer-token');
    const startedAt = Date.parse('2026-08-25T10:00:00.000Z');
    viewer.socket?.message({
      type: 'snapshot',
      snapshot: {
        executions: [executionFixture({ pid: 10, ppid: 1, started_at_ms: startedAt })],
        events: [processEventFixture(1, startedAt + 1, 20, 10, '/usr/bin/find')],
      },
    });
    const find = [...viewer.dom.window.document.querySelectorAll('[role="treeitem"]')].find(
      (row) => row.querySelector('.event-label')?.textContent === '/usr/bin/find',
    );
    find?.click();

    viewer.socket?.message({
      type: 'event',
      event: {
        ...fileEventFixture(2, 'open', startedAt + 2),
        pid: 20,
        path: '/new-child',
      },
    });

    expect(
      [...viewer.dom.window.document.querySelectorAll('[role="treeitem"]')].map(
        (row) => row.querySelector('.event-label')?.textContent,
      ),
    ).not.toContain('/new-child');
    expect(
      [...viewer.dom.window.document.querySelectorAll('[role="treeitem"]')]
        .find((row) => row.querySelector('.event-label')?.textContent === '/usr/bin/find')
        ?.getAttribute('aria-expanded'),
    ).toBe('false');

    viewer.dom.window.close();
  });

  it('keeps legacy events whose sequence numbers repeat across executions', () => {
    const viewer = openViewer('http://127.0.0.1:43130/#token=viewer-token');
    const first = executionFixture({
      id: 'run-1',
      command: 'first',
      started_at_ms: 100,
    });
    const second = executionFixture({
      id: 'run-2',
      command: 'second',
      started_at_ms: 200,
    });
    viewer.socket?.message({
      type: 'snapshot',
      snapshot: {
        executions: [first, second],
        events: [
          { ...fileEventFixture(1, 'open', 101), path: '/tmp/first' },
          {
            ...fileEventFixture(1, 'open', 201),
            execution_id: 'run-2',
            path: '/tmp/second',
          },
        ],
      },
    });

    expect(viewer.dom.window.document.querySelector('#event-total')?.textContent).toBe('2 events');
    const firstExecution = [...viewer.dom.window.document.querySelectorAll('.execution')].find(
      (row) => row.textContent?.includes('first'),
    );
    firstExecution?.click();
    expect(
      [...viewer.dom.window.document.querySelectorAll('#timeline-rows .event-label')].map(
        (label) => label.textContent,
      ),
    ).toContain('/tmp/first');

    viewer.dom.window.close();
  });
});

function executionFixture(overrides = {}) {
  return {
    id: 'run-1',
    command: 'printf test',
    cwd: '/workspace',
    started_at_ms: Date.parse('2026-08-25T10:00:00.000Z'),
    finished_at_ms: Date.parse('2026-08-25T10:00:00.100Z'),
    duration_ms: 100,
    status: 'succeeded',
    exit_code: 0,
    stdout: '',
    stderr: '',
    stdout_truncated: false,
    stderr_truncated: false,
    process_events: 0,
    file_events: 1,
    network_events: 0,
    ...overrides,
  };
}

function fileEventFixture(sequence, event, timestamp) {
  return {
    sequence,
    execution_id: 'run-1',
    timestamp_ms: timestamp,
    kind: 'file',
    event,
    pid: 42,
    path: '/tmp/example',
    access: 'read',
  };
}

function processEventFixture(sequence, timestamp, pid, ppid, executable) {
  return {
    sequence,
    execution_id: 'run-1',
    timestamp_ms: timestamp,
    kind: 'process',
    event: 'exec',
    pid,
    ppid,
    executable,
    operation: 'execve',
    arguments: [executable],
    current_dir: '/workspace',
    status: 'started',
    error_code: null,
    error_message: null,
  };
}
