import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tempDir: string;

vi.mock('../src/config.js', () => ({
  config: {
    session: {
      get dataDir() { return tempDir; },
    },
  },
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

import * as taskStore from '../src/services/task-store.js';

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'botmux-task-store-test-'));
  taskStore.init();
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('task-store', () => {
  it('creates, lists, assigns, closes, and reloads tasks', () => {
    const task = taskStore.createTask({
      name: 'Fix A',
      chatId: 'oc_chat',
      anchor: 'om_root_a',
      sessionId: 'sess-a',
      larkAppId: 'app-a',
      ownerOpenId: 'ou_owner',
    });

    expect(task.taskId).toMatch(/^task-/);
    expect(task.status).toBe('active');
    expect(taskStore.getTask(task.taskId)?.name).toBe('Fix A');
    expect(taskStore.listTasks({ chatId: 'oc_chat' })).toHaveLength(1);
    expect(taskStore.listTasks({ chatId: 'oc_other' })).toHaveLength(0);

    const assigned = taskStore.assignTask(task.taskId, 'ou_bot')!;
    expect(assigned.assigneeOpenId).toBe('ou_bot');
    expect(assigned.updatedAt >= task.updatedAt).toBe(true);

    const linked = taskStore.updateTaskFields(task.taskId, {
      externalTaskId: 'feishu-guid-1',
      externalTaskUrl: 'https://example.com/task/1',
    })!;
    expect(linked.externalTaskId).toBe('feishu-guid-1');

    const closed = taskStore.closeTask(task.taskId)!;
    expect(closed.status).toBe('closed');
    expect(taskStore.listTasks({ chatId: 'oc_chat', status: 'active' })).toHaveLength(0);

    taskStore.init();
    const reloaded = taskStore.getTask(task.taskId)!;
    expect(reloaded.status).toBe('closed');
    expect(reloaded.assigneeOpenId).toBe('ou_bot');
    expect(reloaded.externalTaskId).toBe('feishu-guid-1');
  });

  it('keeps multiple tasks in the same chat bound to different sessions', () => {
    const a = taskStore.createTask({ name: 'A', chatId: 'oc_chat', anchor: 'om_a', sessionId: 'sess-a', larkAppId: 'app-a' });
    const b = taskStore.createTask({ name: 'B', chatId: 'oc_chat', anchor: 'om_b', sessionId: 'sess-b', larkAppId: 'app-a' });

    const tasks = taskStore.listTasks({ chatId: 'oc_chat' });
    expect(tasks.map(t => t.taskId)).toEqual([a.taskId, b.taskId]);
    expect(tasks.map(t => t.sessionId)).toEqual(['sess-a', 'sess-b']);
    expect(tasks.map(t => t.anchor)).toEqual(['om_a', 'om_b']);
  });
});
