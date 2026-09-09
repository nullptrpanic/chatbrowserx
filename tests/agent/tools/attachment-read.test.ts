// @vitest-environment node
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { IndexedDbAttachmentRepository } from '../../../src/persistence/attachment-repository';
import { IndexedDbConversationRepository } from '../../../src/persistence/conversation-repository';
import { IndexedDbTaskRepository } from '../../../src/persistence/task-repository';
import { openChatBrowserDatabase } from '../../../src/persistence/open-database';
import { TaskHistoryReader } from '../../../src/tasks/task-history-reader';
import type { Task } from '../../../src/tasks/task-types';
import { discoverTools } from '../../../src/tools/discover';
import { historyService } from '../../../src/tools/history/service';
import { historyRuntime } from '../../../src/tools/history/tool';
import { bindToolRuntime } from '../../../src/tools/registry';
import { ToolServiceResolver } from '../../../src/tools/service-resolver';
import { createTestDatabaseName } from '../../persistence/test-helpers';

const databases: Awaited<ReturnType<typeof openChatBrowserDatabase>>[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

async function fixture() {
  const database = await openChatBrowserDatabase(createTestDatabaseName('attachment-read'));
  databases.push(database);
  const attachments = new IndexedDbAttachmentRepository(database);
  const previous: Task = {
    id: 'previous',
    conversationId: 'conversation',
    ordinal: 1,
    tabId: 7,
    goal: 'Read images',
    status: 'completed',
    latestRunId: 'run_previous',
    lastEventSequence: 0,
    createdAt: 1,
    updatedAt: 2,
  };
  await database.put('tasks', previous);
  const current: Task = { ...previous, id: 'current', ordinal: 2, status: 'planning' };
  await database.put('tasks', current);
  for (const id of ['message_image', 'tool_image']) {
    await attachments.put({
      id,
      blob: new Blob([id], { type: 'image/png' }),
      mimeType: 'image/png',
      byteSize: id.length,
      width: 1,
      height: 1,
      source: 'file',
      createdAt: 1,
    });
  }
  await database.put('messages', {
    id: 'message',
    taskId: previous.id,
    conversationId: previous.conversationId,
    kind: 'conversation',
    role: 'user',
    status: 'complete',
    text: '',
    attachmentIds: ['message_image'],
    createdAt: 1,
    updatedAt: 1,
  });
  await database.put('tool-results', {
    id: 'result',
    taskId: current.id,
    runId: 'run_current',
    callId: 'capture',
    toolName: 'capture_screenshot',
    output: '{}',
    attachmentIds: ['tool_image'],
    createdAt: 2,
  });
  await attachments.addReference('message_image', 'message:message');
  await attachments.addReference('tool_image', 'result');
  const services = new ToolServiceResolver();
  services.bind(
    historyService,
    new TaskHistoryReader({
      tasks: new IndexedDbTaskRepository(database),
      conversations: new IndexedDbConversationRepository(database),
      attachments,
    }),
  );
  const tools = discoverTools().filter(({ runtime }) => runtime === historyRuntime);
  const runtime = bindToolRuntime(tools, services);
  const context = { task: current, conversationTasks: [previous, current] };
  const contract = await runtime.contract(context);
  expect(contract.definitions.map(({ name }) => name)).toContain('attachment_read');
  const read = (attachmentIds: string[], conversationId = current.conversationId) =>
    runtime.execute(
      contract.parse({
        name: 'attachment_read',
        callId: 'read',
        argumentsJson: JSON.stringify({ attachmentIds }),
      }),
      { ...context, task: { ...current, conversationId } },
      new AbortController().signal,
    );
  return { database, attachments, contract, read, runtime };
}

describe('attachment_read', () => {
  it('returns ordered, deduplicated image references from historical messages and current tool results', async () => {
    const { read, attachments } = await fixture();
    const result = await read(['tool_image', 'message_image', 'tool_image']);
    expect(result.attachmentIds).toEqual(['tool_image', 'message_image']);
    expect(JSON.parse(result.output)).toEqual({ attachmentIds: ['tool_image', 'message_image'] });
    expect(await (await attachments.get('message_image'))?.blob.text()).toBe('message_image');
  });

  it('rejects foreign conversations and missing images without returning a partial batch', async () => {
    const { read } = await fixture();
    for (const result of [
      await read(['message_image', 'missing']),
      await read(['tool_image'], 'other'),
      await read(['message_image'], 'other'),
    ]) {
      expect(result.attachmentIds).toBeUndefined();
      expect(JSON.parse(result.output)).toMatchObject({ ok: false, code: 'ATTACHMENT_NOT_FOUND' });
    }
  });

  it('does not authorize stale owner references or an owner that no longer contains the image', async () => {
    const { read, database } = await fixture();
    await database.delete('messages', 'message');
    const result = await database.get('tool-results', 'result');
    if (!result) throw new Error('Fixture result missing.');
    await database.put('tool-results', { ...result, attachmentIds: [] });
    for (const id of ['message_image', 'tool_image']) {
      expect(JSON.parse((await read([id])).output)).toMatchObject({
        ok: false,
        code: 'ATTACHMENT_NOT_FOUND',
      });
    }
  });

  it('reports unsupported stored images and enforces the existing image-count limit', async () => {
    const { read, database, contract } = await fixture();
    const image = await database.get('attachments', 'message_image');
    if (!image) throw new Error('Fixture image missing.');
    await database.put('attachments', {
      ...image,
      blob: new Blob(['x'], { type: 'text/plain' }),
      byteSize: 1,
      mimeType: 'text/plain',
    });
    const result = await read(['message_image']);
    expect(result.attachmentIds).toBeUndefined();
    expect(JSON.parse(result.output)).toMatchObject({ ok: false, code: 'UNSUPPORTED_TYPE' });
    for (const attachmentIds of [[], Array.from({ length: 9 }, (_, i) => `image_${i}`)]) {
      expect(() =>
        contract.parse({
          name: 'attachment_read',
          callId: 'invalid',
          argumentsJson: JSON.stringify({ attachmentIds }),
        }),
      ).toThrow();
    }
  });

  it('rejects an oversized image or aggregate batch using the shared image policy', async () => {
    const { read, database, attachments } = await fixture();
    const image = await database.get('attachments', 'message_image');
    const owner = await database.get('tool-results', 'result');
    if (!image || !owner) throw new Error('Fixture records missing.');
    const largeBlob = new Blob([new Uint8Array(11 * 1024 * 1024)], { type: 'image/png' });
    await database.put('attachments', { ...image, blob: largeBlob, byteSize: largeBlob.size });
    expect(JSON.parse((await read(['message_image'])).output)).toMatchObject({
      ok: false,
      code: 'IMAGE_TOO_LARGE',
    });
    const batchBlob = new Blob([new Uint8Array(8 * 1024 * 1024)], { type: 'image/png' });
    const attachmentIds = ['batch_1', 'batch_2', 'batch_3', 'batch_4'];
    await database.put('tool-results', { ...owner, attachmentIds });
    for (const id of attachmentIds) {
      await attachments.put({ ...image, id, blob: batchBlob, byteSize: batchBlob.size });
      await attachments.addReference(id, owner.id);
    }
    const result = await read(attachmentIds);
    expect(result.attachmentIds).toBeUndefined();
    expect(JSON.parse(result.output)).toMatchObject({ ok: false, code: 'BATCH_TOO_LARGE' });
  });
});
