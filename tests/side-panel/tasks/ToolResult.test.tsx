import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createTranslator } from '../../../src/shared/i18n/i18n';
import { ToolResult } from '../../../src/side-panel/tasks/ToolResult';

const attachments = {
  addFiles: vi.fn(async () => []),
  get: vi.fn(async () => undefined),
};

describe('ToolResult browser labels', () => {
  it.each([
    ['zh-CN', '检查页面'],
    ['en', 'Inspect page'],
    ['ja', 'ページを確認'],
  ] as const)('uses a compact localized browser label in %s', async (language, label) => {
    const user = userEvent.setup();
    render(
      <ToolResult
        result={{
          callId: 'call_1',
          toolName: 'browser_inspect',
          argumentsJson: '{"tabId":7,"mode":"content"}',
          output: '{"ok":true}',
          resultRef: 'result_1',
          attachmentIds: [],
        }}
        attachments={attachments}
        t={createTranslator(language)}
      />,
    );

    expect(screen.getByText(label)).toBeVisible();
    expect(screen.queryByText('browser_inspect')).not.toBeInTheDocument();
    expect(screen.queryByText('{"ok":true}')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: new RegExp(label) }));
    expect(screen.getByText('{"ok":true}')).toBeVisible();
  });

  it('keeps an unknown tool name visible instead of inventing a label', () => {
    render(
      <ToolResult
        result={{
          callId: 'call_unknown',
          toolName: 'custom_browser_tool',
          argumentsJson: '{}',
          output: '{}',
          resultRef: 'result_unknown',
          attachmentIds: [],
        }}
        attachments={attachments}
        t={createTranslator('zh-CN')}
      />,
    );

    expect(screen.getByText('custom_browser_tool')).toBeVisible();
  });
});
