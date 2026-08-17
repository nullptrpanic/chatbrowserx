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
  };
}

describe('ConversationView answer execution details', () => {
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
    const firstDraft = screen.getByText('First draft').closest('article');
    const secondAnswer = screen.getByText('Second answer').closest('article');
    expect(firstAnswer).not.toBeNull();
    expect(firstDraft).not.toBeNull();
    expect(secondAnswer).not.toBeNull();
    expect(
      within(firstAnswer as HTMLElement).getByRole('button', {
        name: '任务已完成 3 步 · 4.6 秒',
      }),
    ).toBeVisible();
    expect(
      within(secondAnswer as HTMLElement).getByRole('button', {
        name: '任务已完成 3 步 · 4.6 秒',
      }),
    ).toBeVisible();
    expect(screen.getAllByRole('button', { name: '任务已完成 3 步 · 4.6 秒' })).toHaveLength(2);
    expect(within(firstAnswer as HTMLElement).queryByText('查看执行详情')).not.toBeInTheDocument();
    expect(
      within(firstAnswer as HTMLElement).queryByText('任务已完成', { selector: 'p' }),
    ).not.toBeInTheDocument();
    expect(
      within(firstDraft as HTMLElement).queryByRole('button', {
        name: '任务已完成 3 步 · 4.6 秒',
      }),
    ).not.toBeInTheDocument();

    await user.click(
      within(secondAnswer as HTMLElement).getByRole('button', {
        name: '任务已完成 3 步 · 4.6 秒',
      }),
    );
    expect(
      within(secondAnswer as HTMLElement).getByRole('region', { name: 'Bash: 执行完成' }),
    ).toBeVisible();
    expect(within(secondAnswer as HTMLElement).getByText('All tests passed')).toBeVisible();
    expect(
      within(firstAnswer as HTMLElement).queryByRole('region', { name: 'Bash: 执行完成' }),
    ).not.toBeInTheDocument();
    expect(
      within(firstAnswer as HTMLElement).getByRole('button', {
        name: '任务已完成 3 步 · 4.6 秒',
      }),
    ).toBeVisible();
    expect(
      within(secondAnswer as HTMLElement).getByRole('button', {
        name: '任务已完成 3 步 · 4.6 秒',
      }),
    ).toHaveAttribute('aria-expanded', 'true');
  });
});
