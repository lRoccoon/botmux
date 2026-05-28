import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

export type ManagedTaskStatus = 'active' | 'closed';

export interface ManagedTask {
  taskId: string;
  externalTaskId?: string;
  externalTaskUrl?: string;
  externalSyncError?: string;
  name: string;
  status: ManagedTaskStatus;
  chatId: string;
  anchor: string;
  sessionId: string;
  larkAppId: string;
  ownerOpenId?: string;
  assigneeOpenId?: string;
  createdAt: string;
  updatedAt: string;
}

let tasks: Map<string, ManagedTask> = new Map();
let loaded = false;

function getFilePath(): string {
  return join(config.session.dataDir, 'tasks.json');
}

function ensureDir(): void {
  const dir = dirname(getFilePath());
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function load(): void {
  if (loaded) return;
  ensureDir();
  const fp = getFilePath();
  if (existsSync(fp)) {
    try {
      const data = JSON.parse(readFileSync(fp, 'utf-8')) as Record<string, ManagedTask>;
      tasks = new Map(Object.entries(data));
      logger.info(`Loaded ${tasks.size} managed tasks from ${fp}`);
    } catch (err) {
      logger.error(`Failed to load managed tasks: ${err}`);
      tasks = new Map();
    }
  }
  loaded = true;
}

function save(): void {
  ensureDir();
  const fp = getFilePath();
  const tmpFp = fp + '.tmp';
  const obj: Record<string, ManagedTask> = {};
  for (const [k, v] of tasks) obj[k] = v;
  writeFileSync(tmpFp, JSON.stringify(obj, null, 2), 'utf-8');
  renameSync(tmpFp, fp);
}

export function init(): void {
  loaded = false;
  tasks = new Map();
}

function shortId(): string {
  return `task-${randomUUID().slice(0, 8)}`;
}

function nextTaskId(): string {
  let id = shortId();
  while (tasks.has(id)) id = shortId();
  return id;
}

export function createTask(input: {
  name: string;
  chatId: string;
  anchor: string;
  sessionId: string;
  larkAppId: string;
  ownerOpenId?: string;
  assigneeOpenId?: string;
}): ManagedTask {
  load();
  const now = new Date().toISOString();
  const task: ManagedTask = {
    taskId: nextTaskId(),
    name: input.name,
    status: 'active',
    chatId: input.chatId,
    anchor: input.anchor,
    sessionId: input.sessionId,
    larkAppId: input.larkAppId,
    ownerOpenId: input.ownerOpenId,
    assigneeOpenId: input.assigneeOpenId,
    createdAt: now,
    updatedAt: now,
  };
  tasks.set(task.taskId, task);
  save();
  return task;
}

export function getTask(taskId: string): ManagedTask | undefined {
  load();
  return tasks.get(taskId);
}

export function listTasks(filter?: { chatId?: string; status?: ManagedTaskStatus }): ManagedTask[] {
  load();
  let out = [...tasks.values()];
  if (filter?.chatId) out = out.filter(t => t.chatId === filter.chatId);
  if (filter?.status) out = out.filter(t => t.status === filter.status);
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function updateTask(task: ManagedTask): ManagedTask {
  load();
  const next = { ...task, updatedAt: new Date().toISOString() };
  tasks.set(next.taskId, next);
  save();
  return next;
}

export function updateTaskFields(taskId: string, patch: Partial<ManagedTask>): ManagedTask | undefined {
  const task = getTask(taskId);
  if (!task) return undefined;
  return updateTask({ ...task, ...patch, taskId });
}

export function closeTask(taskId: string): ManagedTask | undefined {
  const task = getTask(taskId);
  if (!task) return undefined;
  return updateTask({ ...task, status: 'closed' });
}

export function assignTask(taskId: string, assigneeOpenId: string): ManagedTask | undefined {
  const task = getTask(taskId);
  if (!task) return undefined;
  return updateTask({ ...task, assigneeOpenId });
}
