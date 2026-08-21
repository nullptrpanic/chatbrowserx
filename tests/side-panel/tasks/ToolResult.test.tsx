import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTranslator } from '../../../src/shared/i18n/i18n';
import { ToolResult } from '../../../src/side-panel/tasks/ToolResult';

const attachments = {
  addFiles: vi.fn(async () => []),
  get: vi.fn(async () => undefined),
};
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalClipboard === undefined) Reflect.deleteProperty(navigator, 'clipboard');
  else Object.defineProperty(navigator, 'clipboard', originalClipboard);
});

function readBlobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(String(reader.result ?? '')));
    reader.addEventListener('error', () => reject(new Error('Test Blob could not be read.')));
    reader.readAsText(blob);
  });
}

describe('ToolResult reviewed labels', () => {
  it.each([
    ['zh-CN', '搜索网页'],
    ['en', 'Search web'],
    ['ja', 'ウェブを検索'],
  ] as const)('localizes Tavily tools in %s', (language, label) => {
    render(
      <ToolResult
        result={{
          callId: 'call_search',
          toolName: 'tavily_search',
          argumentsJson: '{"query":"browser reliability"}',
          output: '{"ok":true}',
          resultRef: 'result_search',
          attachmentIds: [],
        }}
        attachments={attachments}
        t={createTranslator(language)}
      />,
    );

    expect(screen.getByText(label)).toBeVisible();
    expect(screen.queryByText('tavily_search')).not.toBeInTheDocument();
  });

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
    expect(document.querySelectorAll('.tool-result-content code')[1]).toHaveTextContent(
      '{\n  "ok": true\n}',
      { normalizeWhitespace: false },
    );
  });

  it.each([
    ['zh-CN', '设置多个选中状态'],
    ['en', 'Set multiple selections'],
    ['ja', '複数の選択状態を設定'],
  ] as const)('localizes batch selection in %s', (language, label) => {
    render(
      <ToolResult
        result={{
          callId: 'call_batch',
          toolName: 'browser_set_checked_many',
          argumentsJson: '{"items":[{"ref":"ref_1","checked":true}]}',
          output: '{"ok":true}',
          resultRef: 'result_batch',
          attachmentIds: [],
        }}
        attachments={attachments}
        t={createTranslator(language)}
      />,
    );

    expect(screen.getByText(label)).toBeVisible();
    expect(screen.queryByText('browser_set_checked_many')).not.toBeInTheDocument();
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

  it('shows a captured screenshot inside its own expanded tool details', async () => {
    class TestUrl extends URL {
      static override createObjectURL = vi.fn(() => 'blob:test-screenshot');
      static override revokeObjectURL = vi.fn();
    }
    vi.stubGlobal('URL', TestUrl);
    const user = userEvent.setup();
    const screenshotAttachments = {
      addFiles: vi.fn(async () => []),
      get: vi.fn(async (id: string) => ({
        id,
        blob: new Blob(['png'], { type: 'image/png' }),
        mimeType: 'image/png',
        byteSize: 3,
        width: 1440,
        height: 790,
        source: 'viewport_capture' as const,
        createdAt: 1_000,
        fileName: 'chatbrowserx-screenshot.png',
      })),
    };
    render(
      <ToolResult
        result={{
          callId: 'call_capture',
          toolName: 'browser_capture_screenshot',
          argumentsJson: '{"tabId":7}',
          output: '{"ok":true,"data":{"assetId":"result_image"}}',
          resultRef: 'result_capture',
          attachmentIds: ['result_image'],
        }}
        attachments={screenshotAttachments}
        t={createTranslator('zh-CN')}
      />,
    );

    await user.click(screen.getByRole('button', { name: /展开\s*截取页面\s*结果/ }));

    expect(await screen.findByRole('img', { name: 'chatbrowserx-screenshot.png' })).toBeVisible();
    expect(screenshotAttachments.get).toHaveBeenCalledWith('result_image');
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

  it('pretty-prints and separately copies complete JSON invocation arguments and results', async () => {
    let clipboardData: Record<string, ClipboardItemData> | undefined;
    function TestClipboardItem(data: Record<string, ClipboardItemData>) {
      clipboardData = data;
      return { data };
    }
    vi.stubGlobal('ClipboardItem', TestClipboardItem);
    const user = userEvent.setup();
    const write = vi.fn(async () => undefined);
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { write, writeText },
    });
    const imageAttachments = {
      addFiles: vi.fn(async () => []),
      get: vi.fn(async (id: string) => ({
        id,
        blob: new Blob(['png'], { type: 'image/png' }),
        mimeType: 'image/png',
        byteSize: 3,
        width: 10,
        height: 10,
        source: 'visual_fallback' as const,
        createdAt: 1_000,
        fileName: 'result.png',
      })),
    };
    render(
      <ToolResult
        result={{
          callId: 'call_copy',
          toolName: 'browser_inspect',
          argumentsJson: '{"tabId":7,"mode":"interactive"}',
          output: '{"ok":true,"snapshot":"page_1"}',
          resultRef: 'result_copy',
          attachmentIds: ['result_image'],
        }}
        attachments={imageAttachments}
        t={createTranslator('zh-CN')}
      />,
    );

    expect(screen.queryByRole('button', { name: '复制调用参数' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /展开\s*检查页面\s*结果/ }));

    const invocation = '{\n  "tabId": 7,\n  "mode": "interactive"\n}';
    const output = '{\n  "ok": true,\n  "snapshot": "page_1"\n}';
    const payloads = document.querySelectorAll('.tool-result-content code');
    expect(payloads).toHaveLength(2);
    expect(payloads[0]).toHaveTextContent(invocation, { normalizeWhitespace: false });
    expect(payloads[1]).toHaveTextContent(output, { normalizeWhitespace: false });

    await user.click(screen.getByRole('button', { name: '复制调用参数' }));
    expect(writeText).toHaveBeenCalledWith(invocation);
    expect(write).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '复制工具结果' }));
    await screen.findByRole('button', { name: '工具结果已复制' });
    expect(imageAttachments.get).toHaveBeenCalledWith('result_image');
    expect(write).toHaveBeenCalledOnce();
    const plain = clipboardData?.['text/plain'];
    if (!(plain instanceof Blob)) throw new Error('Expected plain clipboard output.');
    expect(await readBlobText(plain)).toBe(output);
    const html = clipboardData?.['text/html'];
    if (!(html instanceof Blob)) throw new Error('Expected rich clipboard output.');
    expect(await readBlobText(html)).not.toContain('browser_inspect');
  });

  it('keeps non-JSON invocation arguments and results unchanged', async () => {
    const user = userEvent.setup();
    render(
      <ToolResult
        result={{
          callId: 'call_text',
          toolName: 'custom_tool',
          argumentsJson: 'query=browser reliability',
          output: 'partial {"ok":true',
          resultRef: 'result_text',
          attachmentIds: [],
        }}
        attachments={attachments}
        t={createTranslator('zh-CN')}
      />,
    );

    await user.click(screen.getByRole('button', { name: /展开\s*custom_tool\s*结果/ }));
    const payloads = document.querySelectorAll('.tool-result-content code');
    expect(payloads[0]).toHaveTextContent('query=browser reliability', {
      normalizeWhitespace: false,
    });
    expect(payloads[1]).toHaveTextContent('partial {"ok":true', {
      normalizeWhitespace: false,
    });
  });
});
