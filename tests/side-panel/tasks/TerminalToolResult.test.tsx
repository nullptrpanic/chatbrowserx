import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createTranslator } from '../../../src/shared/i18n/i18n';
import { TerminalToolResult } from '../../../src/side-panel/tasks/TerminalToolResult';

const t = createTranslator('zh-CN');

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

    expect(screen.getByText('npm run test:run').closest('.terminal-command')).toHaveTextContent(
      '$npm run test:run',
    );
    expect(screen.getByText('37 tests passed')).toBeVisible();
    expect(screen.getByText('执行完成')).toBeVisible();
    expect(screen.queryByText(/exit\s*0/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '收起终端输出' }));
    expect(screen.queryByText('37 tests passed')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '展开终端输出' }));
    expect(screen.getByText('37 tests passed')).toBeVisible();
  });

  it('falls back to rendering malformed arguments as plain text', () => {
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

    expect(screen.getByText('<script>alert("unsafe")</script>')).toBeVisible();
    expect(document.querySelector('script')).toBeNull();
  });
});
