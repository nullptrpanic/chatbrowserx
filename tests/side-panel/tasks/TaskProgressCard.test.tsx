import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createTranslator } from '../../../src/shared/i18n/i18n';
import type { PanelTask } from '../../../src/shared/protocol/panel-types';
import { TaskProgressCard } from '../../../src/side-panel/tasks/TaskProgressCard';

const attachments = {
  addFiles: vi.fn(async () => []),
  get: vi.fn(async () => undefined),
};

function runningTask(completedToolCallCount: number): PanelTask {
  return {
    id: 'task_running',
    detailLevel: 'full',
    status: 'planning',
    goal: 'Inspect the page',
    tabId: 7,
    createdAt: 1_000,
    updatedAt: 2_000,
    sequence: 9,
    completedToolCallCount,
    detailItemCount: completedToolCallCount + 1,
    lastError: null,
    events: [
      { sequence: 1, type: 'planning.started', reason: 'started', at: 1_000 },
      {
        sequence: 2,
        type: 'reasoning.summary-recorded',
        reason: 'model_reasoning_summary_recorded',
        at: 1_100,
      },
      { sequence: 3, type: 'tool.call-recorded', reason: 'inspect_call', at: 1_200 },
      { sequence: 4, type: 'tool.execution-started', reason: 'inspect_started', at: 1_300 },
      { sequence: 5, type: 'tool.result-recorded', reason: 'inspect_done', at: 1_400 },
      {
        sequence: 6,
        type: 'task.supplements-applied',
        reason: 'supplement_applied',
        supplementIds: ['supplement_1'],
        at: 1_500,
      },
      { sequence: 7, type: 'tool.call-recorded', reason: 'commit_call', at: 1_600 },
      { sequence: 8, type: 'tool.execution-started', reason: 'commit_started', at: 1_700 },
      { sequence: 9, type: 'tool.result-recorded', reason: 'commit_done', at: 1_800 },
    ],
    completedToolResults: [
      {
        callId: 'call_inspect',
        toolName: 'browser_inspect',
        argumentsJson: '{"tabId":7}',
        output: '{"ok":true}',
        resultRef: 'result_inspect',
        detailIndex: 1,
      },
      {
        callId: 'call_commit',
        toolName: 'commit_context',
        argumentsJson: '{"state":"Continue from the inspected page."}',
        output: '{"ok":true,"compactedCalls":1,"releasedTextChars":100,"releasedImages":0}',
        resultRef: 'result_commit',
        detailIndex: 3,
      },
    ],
    supplements: [
      {
        id: 'supplement_1',
        text: 'Also check the mobile layout.',
        attachmentIds: [],
        createdAt: 1_450,
        detailIndex: 2,
        applicationState: 'applied',
      },
    ],
  };
}

describe('TaskProgressCard execution details', () => {
  it('counts completed tools and renders only tool results plus user supplements', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <TaskProgressCard
        task={runningTask(2)}
        attachments={attachments}
        t={createTranslator('zh-CN')}
        onPause={vi.fn()}
        onResume={vi.fn()}
        onRetry={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: '查看执行详情(3)' }));
    const details = document.querySelector('.task-detail-content');
    expect(details).not.toBeNull();
    expect(within(details as HTMLElement).getByText('检查页面已完成')).toBeVisible();
    expect(within(details as HTMLElement).getByText('工作状态已提交')).toBeVisible();
    expect(within(details as HTMLElement).getByRole('region', { name: '用户补充' })).toBeVisible();
    expect(within(details as HTMLElement).queryByText('思考摘要已生成')).not.toBeInTheDocument();
    expect(within(details as HTMLElement).queryByText('工具调用已记录')).not.toBeInTheDocument();
    expect(within(details as HTMLElement).queryByText('任务状态已更新')).not.toBeInTheDocument();
    expect(
      [...(details as HTMLElement).querySelectorAll('.task-event-index')].map(
        (element) => element.textContent,
      ),
    ).toEqual(['1', '2', '3']);

    rerender(
      <TaskProgressCard
        task={runningTask(3)}
        attachments={attachments}
        t={createTranslator('zh-CN')}
        onPause={vi.fn()}
        onResume={vi.fn()}
        onRetry={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: '收起执行详情(4)' })).toBeVisible();
  });

  it('labels supplements as applied or waiting for the next turn', async () => {
    const user = userEvent.setup();
    const appliedTask = runningTask(2);
    const { rerender } = render(
      <TaskProgressCard
        task={appliedTask}
        attachments={attachments}
        t={createTranslator('zh-CN')}
        onPause={vi.fn()}
        onResume={vi.fn()}
        onRetry={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: '查看执行详情(3)' }));
    expect(screen.getByText('已应用')).toBeVisible();

    rerender(
      <TaskProgressCard
        task={{
          ...appliedTask,
          supplements: appliedTask.supplements.map((supplement) => ({
            ...supplement,
            applicationState: 'pending' as const,
          })),
        }}
        attachments={attachments}
        t={createTranslator('zh-CN')}
        onPause={vi.fn()}
        onResume={vi.fn()}
        onRetry={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.queryByText('已应用')).not.toBeInTheDocument();
    expect(screen.getByText('待下一轮')).toBeVisible();
  });
});
