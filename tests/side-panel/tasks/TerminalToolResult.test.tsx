import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTranslator } from '../../../src/shared/i18n/i18n';
import { TerminalToolResult } from '../../../src/side-panel/tasks/TerminalToolResult';

const t = createTranslator('zh-CN');
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

afterEach(() => {
  if (originalClipboard === undefined) Reflect.deleteProperty(navigator, 'clipboard');
  else Object.defineProperty(navigator, 'clipboard', originalClipboard);
});

describe('TerminalToolResult', () => {
  it('renders the persisted Bash command and output without inventing an exit code', async () => {
    const user = userEvent.setup();
    render(
      <TerminalToolResult
        result={{
          callId: 'call_1',
          toolName: 'Bash',
          argumentsJson: JSON.stringify({ cmd: 'npm run test:run' }),
          output: '37 tests passed',
          resultRef: 'result_1',
        }}
        t={t}
      />,
    );

    expect(screen.getByText('执行完成')).toBeVisible();
    expect(screen.queryByText(/exit\s*0/i)).not.toBeInTheDocument();
    expect(screen.queryByText('npm run test:run')).not.toBeInTheDocument();
    expect(screen.queryByText('37 tests passed')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '展开终端输出' }));
    expect(screen.getByText('npm run test:run').closest('.terminal-command')).toHaveTextContent(
      '$npm run test:run',
    );
    expect(screen.getByText('37 tests passed')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '收起终端输出' }));
    expect(screen.queryByText('npm run test:run')).not.toBeInTheDocument();
    expect(screen.queryByText('37 tests passed')).not.toBeInTheDocument();
  });

  it('falls back to rendering malformed arguments as plain text', async () => {
    const user = userEvent.setup();
    render(
      <TerminalToolResult
        result={{
          callId: 'call_2',
          toolName: 'shell',
          argumentsJson: '<script>alert("unsafe")</script>',
          output: '',
          resultRef: 'result_2',
        }}
        t={t}
      />,
    );

    expect(screen.queryByText('<script>alert("unsafe")</script>')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '展开终端输出' }));
    expect(screen.getByText('<script>alert("unsafe")</script>')).toBeVisible();
    expect(document.querySelector('script')).toBeNull();
  });

  it('copies the displayed command and terminal output independently', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    render(
      <TerminalToolResult
        result={{
          callId: 'call_copy',
          toolName: 'bash',
          argumentsJson: JSON.stringify({ cmd: 'npm run test:run' }),
          output: '42 tests passed',
          resultRef: 'result_copy',
        }}
        t={t}
      />,
    );

    expect(screen.queryByRole('button', { name: '复制命令' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '展开终端输出' }));
    await user.click(screen.getByRole('button', { name: '复制命令' }));
    await user.click(screen.getByRole('button', { name: '复制输出' }));

    expect(writeText).toHaveBeenNthCalledWith(1, 'npm run test:run');
    expect(writeText).toHaveBeenNthCalledWith(2, '42 tests passed');
  });
});
