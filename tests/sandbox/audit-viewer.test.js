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
  const dom = new JSDOM(html, { pretendToBeVisual: true, runScripts: 'outside-only', url });
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

  it('clears only the selected execution events after confirmation', () => {
    const viewer = openViewer('http://127.0.0.1:43130/#token=viewer-token');
    viewer.dom.window.confirm = () => true;
    viewer.socket?.open();
    viewer.socket?.message({
      type: 'snapshot',
      snapshot: {
        executions: [executionFixture()],
        events: [fileEventFixture(1, 'open', Date.now())],
      },
    });

    viewer.dom.window.document.querySelector('#clear-events')?.click();
    expect(viewer.socket?.sent.at(-1)).toBe(
      JSON.stringify({ type: 'clear_events', execution_id: 'run-1' }),
    );

    viewer.socket?.message({ type: 'events_cleared', execution_id: 'run-1' });
    expect(viewer.dom.window.document.querySelectorAll('#timeline-rows .event-row')).toHaveLength(
      1,
    );
    expect(viewer.dom.window.document.querySelector('#timeline-rows .badge')?.textContent).toBe(
      'COMMAND',
    );

    viewer.dom.window.close();
  });

  it('keeps legacy events whose sequence numbers repeat across executions', () => {
    const viewer = openViewer('http://127.0.0.1:43130/#token=viewer-token');
    const first = executionFixture({ id: 'run-1', command: 'first', started_at_ms: 100 });
    const second = executionFixture({ id: 'run-2', command: 'second', started_at_ms: 200 });
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
