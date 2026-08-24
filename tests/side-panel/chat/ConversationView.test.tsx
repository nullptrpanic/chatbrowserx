import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createTranslator } from '../../../src/shared/i18n/i18n';
import type { PanelMessage, PanelTask } from '../../../src/shared/protocol/panel-types';
import { ConversationView } from '../../../src/side-panel/chat/ConversationView';

const t = createTranslator('zh-CN');
const attachments = {
  addFiles: vi.fn(async () => []),
  get: vi.fn(async () => undefined),
};

function completedTask(id: string, goal: string, updatedAt: number): PanelTask {
  return {
    id,
    status: 'completed',
    goal,
    tabId: 7,
    createdAt: updatedAt - 4_600,
    updatedAt,
    sequence: 3,
    lastError: null,
    events: [
      {
        sequence: 1,
        type: 'planning.started',
        reason: 'started',
        at: updatedAt - 4_600,
      },
      {
        sequence: 2,
        type: 'task.retried',
        reason: 'continued',
        at: updatedAt - 2_000,
      },
      { sequence: 3, type: 'task.completed', reason: 'done', at: updatedAt },
    ],
    completedToolResults: [],
    supplements: [],
  };
}

describe('ConversationView answer execution details', () => {
  it('does not rewrite the scroll position for an unchanged polling snapshot', () => {
    const task = completedTask('task_poll', 'Polling task', 1_300);
    const message: PanelMessage = {
      id: 'assistant_poll',
      taskId: task.id,
      role: 'assistant',
      status: 'complete',
      text: 'Stable answer',
      attachmentIds: [],
      createdAt: 1_300,
      updatedAt: 1_300,
    };
    const props = {
      attachments,
      t,
      onSuggestion: vi.fn(),
      onPause: vi.fn(),
      onResume: vi.fn(),
      onRetry: vi.fn(),
      onCancel: vi.fn(),
    };
    const { container, rerender } = render(
      <ConversationView messages={[message]} tasks={[task]} task={task} {...props} />,
    );
    const scroller = container.querySelector('.conversation-scroller');
    if (!(scroller instanceof HTMLDivElement)) throw new Error('Conversation scroller is missing.');
    const setScrollTop = vi.fn();
    Object.defineProperties(scroller, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 500 },
      scrollTop: { configurable: true, get: () => 500, set: setScrollTop },
    });

    rerender(
      <ConversationView
        messages={[{ ...message }]}
        tasks={[{ ...task, events: [...task.events] }]}
        task={{ ...task, events: [...task.events] }}
        {...props}
      />,
    );

    expect(setScrollTop).not.toHaveBeenCalled();
  });

  it('requests complete persisted details when a historical answer is expanded', async () => {
    const user = userEvent.setup();
    const task: PanelTask = {
      ...completedTask('task_history', 'Historical request', 1_300),
      detailLevel: 'summary',
    };
    const loadTaskDetails = vi.fn(async () => undefined);

    render(
      <ConversationView
        messages={[
          {
            id: 'assistant_history',
            taskId: task.id,
            role: 'assistant',
            status: 'complete',
            text: 'Historical answer',
            attachmentIds: [],
            createdAt: 1_300,
            updatedAt: 1_300,
          },
        ]}
        tasks={[task]}
        task={task}
        attachments={attachments}
        t={t}
        onSuggestion={vi.fn()}
        onLoadTaskDetails={loadTaskDetails}
        onPause={vi.fn()}
        onResume={vi.fn()}
        onRetry={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: '任务已完成 0 步 · 4.6 秒' }));

    expect(loadTaskDetails).toHaveBeenCalledOnce();
    expect(loadTaskDetails).toHaveBeenCalledWith(task.id);
  });

  it('attaches independently expandable task details to each assistant answer', async () => {
    const user = userEvent.setup();
    const firstTask = completedTask('task_1', 'First request', 1_100);
    const secondTask: PanelTask = {
      ...completedTask('task_2', 'Second request', 1_300),
      completedToolResults: [
        {
          callId: 'call_bash_1',
          toolName: 'Bash',
          argumentsJson: '{"cmd":"npm run test:run"}',
          output: 'All tests passed',
          resultRef: 'result_1',
        },
      ],
    };
    const messages: PanelMessage[] = [
      {
        id: 'user_1',
        taskId: firstTask.id,
        role: 'user',
        status: 'complete',
        text: 'First request',
        attachmentIds: [],
        createdAt: 1_000,
        updatedAt: 1_000,
      },
      {
        id: 'assistant_1_older',
        taskId: firstTask.id,
        role: 'assistant',
        status: 'complete',
        text: 'First draft',
        attachmentIds: [],
        createdAt: 1_050,
        updatedAt: 1_050,
      },
      {
        id: 'assistant_1',
        taskId: firstTask.id,
        role: 'assistant',
        status: 'complete',
        text: 'First answer',
        attachmentIds: [],
        createdAt: 1_100,
        updatedAt: 1_100,
      },
      {
        id: 'user_2',
        taskId: secondTask.id,
        role: 'user',
        status: 'complete',
        text: 'Second request',
        attachmentIds: [],
        createdAt: 1_200,
        updatedAt: 1_200,
      },
      {
        id: 'assistant_2',
        taskId: secondTask.id,
        role: 'assistant',
        status: 'complete',
        text: 'Second answer',
        attachmentIds: [],
        createdAt: 1_300,
        updatedAt: 1_300,
      },
    ];

    render(
      <ConversationView
        messages={messages}
        tasks={[firstTask, secondTask]}
        task={secondTask}
        attachments={attachments}
        t={t}
        onSuggestion={vi.fn()}
        onPause={vi.fn()}
        onResume={vi.fn()}
        onRetry={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const firstAnswer = screen.getByText('First answer').closest('article');
    const firstDraft = screen.queryByText('First draft');
    const secondAnswer = screen.getByText('Second answer').closest('article');
    expect(firstAnswer).not.toBeNull();
    expect(firstDraft).not.toBeInTheDocument();
    expect(secondAnswer).not.toBeNull();
    expect(
      within(firstAnswer as HTMLElement).getByRole('button', {
        name: '任务已完成 0 步 · 4.6 秒',
      }),
    ).toBeVisible();
    expect(
      within(secondAnswer as HTMLElement).getByRole('button', {
        name: '任务已完成 1 步 · 4.6 秒',
      }),
    ).toBeVisible();
    expect(within(firstAnswer as HTMLElement).queryByText('查看执行详情')).not.toBeInTheDocument();
    expect(
      within(firstAnswer as HTMLElement).queryByText('任务已完成', { selector: 'p' }),
    ).not.toBeInTheDocument();

    await user.click(
      within(secondAnswer as HTMLElement).getByRole('button', {
        name: '任务已完成 1 步 · 4.6 秒',
      }),
    );
    const terminal = within(secondAnswer as HTMLElement).getByRole('region', {
      name: 'Bash: 执行完成',
    });
    expect(terminal).toBeVisible();
    expect(within(terminal).queryByText('All tests passed')).not.toBeInTheDocument();
    await user.click(within(terminal).getByRole('button', { name: '展开终端输出' }));
    expect(within(terminal).getByText('All tests passed')).toBeVisible();
    expect(
      within(firstAnswer as HTMLElement).queryByRole('region', { name: 'Bash: 执行完成' }),
    ).not.toBeInTheDocument();
    expect(
      within(firstAnswer as HTMLElement).getByRole('button', {
        name: '任务已完成 0 步 · 4.6 秒',
      }),
    ).toBeVisible();
    expect(
      within(secondAnswer as HTMLElement).getByRole('button', {
        name: '任务已完成 1 步 · 4.6 秒',
      }),
    ).toHaveAttribute('aria-expanded', 'true');
  });

  it('reveals a checkpointed Tavily result and its localized event only after expansion', async () => {
    const user = userEvent.setup();
    const task: PanelTask = {
      ...completedTask('task_tavily', 'Research request', 1_300),
      events: [
        { sequence: 1, type: 'planning.started', reason: 'started', at: 1_000 },
        {
          sequence: 2,
          type: 'tool.result-recorded',
          reason: 'tavily_search_result_recorded',
          at: 1_200,
        },
        { sequence: 3, type: 'task.completed', reason: 'done', at: 1_300 },
      ],
      completedToolResults: [
        {
          callId: 'call_search_1',
          toolName: 'tavily_search',
          argumentsJson: '{"query":"browser reliability"}',
          output: '{"ok":true,"results":[{"title":"Reliable browsing"}]}',
          resultRef: 'result_search_1',
        },
      ],
    };
    const messages: PanelMessage[] = [
      {
        id: 'assistant_tavily',
        taskId: task.id,
        role: 'assistant',
        status: 'complete',
        text: 'Research answer',
        attachmentIds: [],
        createdAt: 1_300,
        updatedAt: 1_300,
      },
    ];

    render(
      <ConversationView
        messages={messages}
        tasks={[task]}
        task={task}
        attachments={attachments}
        t={t}
        onSuggestion={vi.fn()}
        onPause={vi.fn()}
        onResume={vi.fn()}
        onRetry={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const answer = screen.getByText('Research answer').closest('article');
    expect(answer).not.toBeNull();
    expect(within(answer as HTMLElement).queryByText('tavily_search')).not.toBeInTheDocument();
    expect(within(answer as HTMLElement).queryByText('搜索结果已记录')).not.toBeInTheDocument();

    await user.click(
      within(answer as HTMLElement).getByRole('button', {
        name: '任务已完成 1 步 · 4.6 秒',
      }),
    );

    expect(within(answer as HTMLElement).getByText('搜索网页已完成')).toBeVisible();
    expect(within(answer as HTMLElement).getByText('搜索网页')).toBeVisible();
    expect(within(answer as HTMLElement).queryByText(/Reliable browsing/)).not.toBeInTheDocument();

    await user.click(
      within(answer as HTMLElement).getByRole('button', { name: '展开 搜索网页 结果' }),
    );
    expect(within(answer as HTMLElement).getByText(/Reliable browsing/)).toBeVisible();

    await user.click(
      within(answer as HTMLElement).getByRole('button', { name: '收起 搜索网页 结果' }),
    );
    expect(within(answer as HTMLElement).queryByText(/Reliable browsing/)).not.toBeInTheDocument();
  });

  it('shows a context-specific completion event instead of the generic search label', async () => {
    const user = userEvent.setup();
    const task: PanelTask = {
      ...completedTask('task_commit', 'Preserve working state', 1_300),
      events: [
        { sequence: 1, type: 'planning.started', reason: 'started', at: 1_000 },
        {
          sequence: 2,
          type: 'tool.result-recorded',
          reason: 'commit_context_result_recorded',
          at: 1_200,
        },
        { sequence: 3, type: 'task.completed', reason: 'done', at: 1_300 },
      ],
      completedToolResults: [
        {
          callId: 'call_commit',
          toolName: 'commit_context',
          argumentsJson: '{"state":"Goal: continue."}',
          output: '{"ok":true,"compactedCalls":2,"releasedTextChars":100,"releasedImages":1}',
          resultRef: 'result_commit',
          attachmentIds: [],
        },
      ],
    };

    render(
      <ConversationView
        messages={[
          {
            id: 'assistant_commit',
            taskId: task.id,
            role: 'assistant',
            status: 'complete',
            text: 'Continued from the saved state.',
            attachmentIds: [],
            createdAt: 1_300,
            updatedAt: 1_300,
          },
        ]}
        tasks={[task]}
        task={task}
        attachments={attachments}
        t={t}
        onSuggestion={vi.fn()}
        onPause={vi.fn()}
        onResume={vi.fn()}
        onRetry={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: '任务已完成 1 步 · 4.6 秒' }));

    expect(screen.getByText('工作状态已提交')).toBeVisible();
    expect(screen.getByText('提交工作状态')).toBeVisible();
    expect(screen.queryByText('搜索结果已记录')).not.toBeInTheDocument();
    expect(screen.queryByText('commit_context')).not.toBeInTheDocument();
  });

  it('loads a screenshot only inside its expanded browser tool result', async () => {
    const user = userEvent.setup();
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:tool-screenshot');
    const screenshotAttachments = {
      addFiles: vi.fn(async () => []),
      get: vi.fn(async (id: string) =>
        id === 'attachment_screenshot'
          ? {
              id,
              blob: new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }),
              mimeType: 'image/png',
              byteSize: 4,
              width: 800,
              height: 600,
              source: 'visual_fallback' as const,
              fileName: 'page-screenshot.png',
              createdAt: 1_200,
            }
          : undefined,
      ),
    };
    const task: PanelTask = {
      ...completedTask('task_screenshot', 'Inspect the page', 1_300),
      events: [
        { sequence: 1, type: 'planning.started', reason: 'started', at: 1_000 },
        {
          sequence: 2,
          type: 'tool.result-recorded',
          reason: 'browser_inspect_result_recorded',
          at: 1_200,
        },
        { sequence: 3, type: 'task.completed', reason: 'done', at: 1_300 },
      ],
      completedToolResults: [
        {
          callId: 'call_screenshot',
          toolName: 'browser_inspect',
          argumentsJson: '{"tabId":7,"mode":"screenshot"}',
          output: '{"ok":true}',
          resultRef: 'result_screenshot',
          attachmentIds: ['attachment_screenshot'],
        },
      ],
    };
    const preview = vi.fn(async () => true);

    render(
      <ConversationView
        messages={[
          {
            id: 'assistant_screenshot',
            taskId: task.id,
            role: 'assistant',
            status: 'complete',
            text: 'I inspected the page.',
            attachmentIds: [],
            createdAt: 1_300,
            updatedAt: 1_300,
          },
        ]}
        tasks={[task]}
        task={task}
        attachments={screenshotAttachments}
        t={t}
        onSuggestion={vi.fn()}
        onOpenImagePreview={preview}
        onPause={vi.fn()}
        onResume={vi.fn()}
        onRetry={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.queryByAltText('page-screenshot.png')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '任务已完成 1 步 · 4.6 秒' }));
    expect(screen.getByText('检查页面已完成')).toBeVisible();
    expect(screen.queryByAltText('page-screenshot.png')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '展开 检查页面 结果' }));
    const image = await screen.findByAltText('page-screenshot.png');
    expect(image).toHaveAttribute('src', 'blob:tool-screenshot');
    await user.click(image.closest('button') as HTMLButtonElement);
    expect(preview).toHaveBeenCalledWith('attachment_screenshot');
  });

  it('places each completed tool result beneath its corresponding task event', async () => {
    const user = userEvent.setup();
    const task: PanelTask = {
      ...completedTask('task_multiple_tools', 'Research and extract', 1_300),
      sequence: 4,
      events: [
        { sequence: 1, type: 'planning.started', reason: 'started', at: 1_000 },
        {
          sequence: 2,
          type: 'tool.result-recorded',
          reason: 'tavily_search_result_recorded',
          at: 1_100,
        },
        {
          sequence: 3,
          type: 'tool.result-recorded',
          reason: 'tavily_extract_result_recorded',
          at: 1_200,
        },
        { sequence: 4, type: 'task.completed', reason: 'done', at: 1_300 },
      ],
      completedToolResults: [
        {
          callId: 'call_search',
          toolName: 'tavily_search',
          argumentsJson: '{"query":"browser reliability"}',
          output: '{"ok":true}',
          resultRef: 'result_search',
        },
        {
          callId: 'call_extract',
          toolName: 'tavily_extract',
          argumentsJson: '{"urls":["https://example.com"]}',
          output: '{"ok":true}',
          resultRef: 'result_extract',
        },
      ],
    };
    const messages: PanelMessage[] = [
      {
        id: 'assistant_multiple_tools',
        taskId: task.id,
        role: 'assistant',
        status: 'complete',
        text: 'Combined research answer',
        attachmentIds: [],
        createdAt: 1_300,
        updatedAt: 1_300,
      },
    ];

    render(
      <ConversationView
        messages={messages}
        tasks={[task]}
        task={task}
        attachments={attachments}
        t={t}
        onSuggestion={vi.fn()}
        onPause={vi.fn()}
        onResume={vi.fn()}
        onRetry={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const answer = screen.getByText('Combined research answer').closest('article');
    expect(answer).not.toBeNull();
    await user.click(
      within(answer as HTMLElement).getByRole('button', {
        name: '任务已完成 2 步 · 4.6 秒',
      }),
    );

    const searchEvent = within(answer as HTMLElement)
      .getByText('搜索网页已完成')
      .closest('li');
    const extractEvent = within(answer as HTMLElement)
      .getByText('提取网页已完成')
      .closest('li');
    expect(searchEvent).not.toBeNull();
    expect(extractEvent).not.toBeNull();
    expect(
      within(searchEvent as HTMLElement).getByRole('region', {
        name: '搜索网页: 执行完成',
      }),
    ).toBeVisible();
    expect(
      within(extractEvent as HTMLElement).getByRole('region', {
        name: '提取网页: 执行完成',
      }),
    ).toBeVisible();
  });

  it('hides provider reasoning summaries from execution details', async () => {
    const user = userEvent.setup();
    const task: PanelTask = {
      ...completedTask('task_reasoning', 'Reason before answering', 1_300),
      events: [
        { sequence: 1, type: 'planning.started', reason: 'started', at: 1_000 },
        {
          sequence: 2,
          type: 'reasoning.summary-recorded',
          reason: 'model_reasoning_summary_recorded',
          at: 1_200,
        },
        { sequence: 3, type: 'task.completed', reason: 'done', at: 1_300 },
      ],
    };
    const messages: PanelMessage[] = [
      {
        id: 'assistant_reasoning',
        taskId: task.id,
        role: 'assistant',
        status: 'complete',
        text: 'Reasoned answer',
        attachmentIds: [],
        createdAt: 1_300,
        updatedAt: 1_300,
      },
    ];

    render(
      <ConversationView
        messages={messages}
        tasks={[task]}
        task={task}
        attachments={attachments}
        t={t}
        onSuggestion={vi.fn()}
        onPause={vi.fn()}
        onResume={vi.fn()}
        onRetry={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const answer = screen.getByText('Reasoned answer').closest('article');
    expect(answer).not.toBeNull();
    await user.click(
      within(answer as HTMLElement).getByRole('button', {
        name: '任务已完成 0 步 · 4.6 秒',
      }),
    );

    expect(within(answer as HTMLElement).queryByText('思考摘要已生成')).not.toBeInTheDocument();
    expect(
      within(answer as HTMLElement).queryByRole('region', { name: '思考摘要' }),
    ).not.toBeInTheDocument();
  });

  it('attaches a failed task to its retained empty assistant reply', () => {
    const task: PanelTask = {
      id: 'task_failed',
      status: 'failed',
      goal: 'Failed request',
      tabId: 7,
      createdAt: 1_000,
      updatedAt: 1_300,
      sequence: 2,
      lastError: {
        code: 'TaskInputError',
        retryable: false,
        userMessage: 'Task input could not be prepared.',
      },
      events: [
        { sequence: 1, type: 'planning.started', reason: 'started', at: 1_000 },
        {
          sequence: 2,
          type: 'task.failed',
          reason: 'task_input_preparation_failed',
          at: 1_300,
        },
      ],
      completedToolResults: [],
      supplements: [],
    };
    const messages: PanelMessage[] = [
      {
        id: 'assistant_failed',
        taskId: task.id,
        role: 'assistant',
        status: 'error',
        text: '',
        attachmentIds: [],
        createdAt: 1_300,
        updatedAt: 1_300,
      },
    ];

    render(
      <ConversationView
        messages={messages}
        tasks={[task]}
        task={task}
        attachments={attachments}
        t={t}
        onSuggestion={vi.fn()}
        onPause={vi.fn()}
        onResume={vi.fn()}
        onRetry={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const reply = screen.getByText('任务执行失败，未生成回复。').closest('article');
    expect(reply).not.toBeNull();
    expect(
      within(reply as HTMLElement).getByText('Task input could not be prepared.'),
    ).toBeVisible();
    expect(within(reply as HTMLElement).getByRole('button', { name: '重试' })).toBeVisible();
    expect(screen.getAllByText('Task input could not be prepared.')).toHaveLength(1);
  });

  it('renders a retained empty cancelled reply as a message bubble', () => {
    const task: PanelTask = {
      id: 'task_cancelled',
      status: 'cancelled',
      goal: 'Cancelled request',
      tabId: 7,
      createdAt: 1_000,
      updatedAt: 1_300,
      sequence: 2,
      lastError: null,
      events: [
        { sequence: 1, type: 'planning.started', reason: 'started', at: 1_000 },
        { sequence: 2, type: 'task.cancelled', reason: 'user_cancel', at: 1_300 },
      ],
      completedToolResults: [],
      supplements: [],
    };
    const messages: PanelMessage[] = [
      {
        id: 'assistant_cancelled',
        taskId: task.id,
        role: 'assistant',
        status: 'interrupted',
        text: '',
        attachmentIds: [],
        createdAt: 1_300,
        updatedAt: 1_300,
      },
    ];

    render(
      <ConversationView
        messages={messages}
        tasks={[task]}
        task={task}
        attachments={attachments}
        t={t}
        onSuggestion={vi.fn()}
        onPause={vi.fn()}
        onResume={vi.fn()}
        onRetry={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const reply = screen.getByText('任务已取消，未生成回复。').closest('article');
    expect(reply).not.toBeNull();
    expect(
      within(reply as HTMLElement).getByRole('button', {
        name: '任务已取消 0 步 · 0.3 秒',
      }),
    ).toBeVisible();
  });

  it('shows runtime text and image supplements only inside the owning answer details', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:runtime-supplement');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const user = userEvent.setup();
    const supplementImage = new File(['png'], 'runtime-detail.png', { type: 'image/png' });
    const supplementAttachments = {
      addFiles: vi.fn(async () => []),
      get: vi.fn(async (id: string) =>
        id === 'attachment_runtime'
          ? {
              id,
              blob: supplementImage,
              mimeType: supplementImage.type,
              byteSize: supplementImage.size,
              width: 20,
              height: 20,
              source: 'paste' as const,
              createdAt: 1_150,
              fileName: supplementImage.name,
            }
          : undefined,
      ),
    };
    const task: PanelTask = {
      ...completedTask('task_supplement', 'Analyze the layout', 1_300),
      sequence: 4,
      events: [
        { sequence: 1, type: 'planning.started', reason: 'started', at: 1_000 },
        {
          sequence: 2,
          type: 'task.supplements-applied',
          reason: 'user_supplements_applied',
          at: 1_200,
          supplementIds: ['supplement_1', 'supplement_2'],
        },
        {
          sequence: 3,
          type: 'task.supplements-applied',
          reason: 'user_supplements_applied',
          at: 1_250,
          supplementIds: ['supplement_3'],
        },
        { sequence: 4, type: 'task.completed', reason: 'done', at: 1_300 },
      ],
      supplements: [
        {
          id: 'supplement_1',
          text: 'Please also inspect the mobile navigation.',
          attachmentIds: ['attachment_runtime'],
          createdAt: 1_150,
        },
        {
          id: 'supplement_2',
          text: 'Compare the compact breakpoint too.',
          attachmentIds: [],
          createdAt: 1_160,
        },
        {
          id: 'supplement_3',
          text: 'Keep the desktop navigation unchanged.',
          attachmentIds: [],
          createdAt: 1_230,
        },
      ],
    };
    const messages: PanelMessage[] = [
      {
        id: 'assistant_supplement',
        taskId: task.id,
        role: 'assistant',
        status: 'complete',
        text: 'The navigation now works on both layouts.',
        attachmentIds: [],
        createdAt: 1_300,
        updatedAt: 1_300,
      },
    ];

    render(
      <ConversationView
        messages={messages}
        tasks={[task]}
        task={task}
        attachments={supplementAttachments}
        t={t}
        onSuggestion={vi.fn()}
        onPause={vi.fn()}
        onResume={vi.fn()}
        onRetry={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(
      screen.queryByText('Please also inspect the mobile navigation.'),
    ).not.toBeInTheDocument();
    expect(document.querySelector('.message-user')).not.toBeInTheDocument();

    await user.click(
      screen.getByRole('button', {
        name: '任务已完成 3 步 · 4.6 秒',
      }),
    );

    expect(
      screen.queryByText('Please also inspect the mobile navigation.'),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('已应用用户补充')).not.toBeInTheDocument();
    const supplements = screen.getAllByRole('region', { name: '用户补充' });
    expect(supplements).toHaveLength(3);

    await user.click(
      within(supplements[0] as HTMLElement).getByRole('button', { name: '展开用户补充' }),
    );
    const supplement = supplements[0] as HTMLElement;
    expect(
      within(supplement).getByText('Please also inspect the mobile navigation.'),
    ).toBeVisible();
    expect(within(supplement).getByRole('img', { name: 'runtime-detail.png' })).toBeVisible();
    expect(within(supplement).getByRole('time')).toHaveAttribute(
      'datetime',
      new Date(1_150).toISOString(),
    );
    expect(document.querySelector('.message-user')).not.toBeInTheDocument();
  });
});
