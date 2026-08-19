import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createTranslator } from '../../../src/shared/i18n/i18n';
import { ToolResult } from '../../../src/side-panel/tasks/ToolResult';

const attachments = {
  addFiles: vi.fn(async () => []),
  get: vi.fn(async () => undefined),
};

describe('ToolResult reviewed labels', () => {
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

  it.each([
    ['zh-CN', '提交工作状态', '压缩 2 次调用 · 释放 100 字符 / 1 张图片'],
    ['en', 'Commit working state', 'Calls compacted: 2 · chars released: 100 · images released: 1'],
    ['ja', '作業状態を保存', '呼び出し 2 件を圧縮 · 100 文字 / 画像 1 枚を解放'],
  ] as const)('uses a localized context commit label in %s', (language, label, summary) => {
    render(
      <ToolResult
        result={{
          callId: 'call_commit',
          toolName: 'commit_context',
          argumentsJson: '{"state":"Goal: continue."}',
          output: '{"ok":true,"compactedCalls":2,"releasedTextChars":100,"releasedImages":1}',
          resultRef: 'result_commit',
          attachmentIds: [],
        }}
        attachments={attachments}
        t={createTranslator(language)}
      />,
    );

    expect(screen.getByText(label)).toBeVisible();
    expect(screen.getByText(summary)).toBeVisible();
    expect(screen.queryByText('commit_context')).not.toBeInTheDocument();
  });
});
