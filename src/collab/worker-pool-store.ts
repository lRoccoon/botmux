import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { withFileLock } from '../utils/file-lock.js';

export type CollabWorkerKind = 'botmux-cli';
export type CollabWorkerStatus = 'available' | 'leased';

export interface CollabWorkerPoolEntry {
  id: string;
  kind: CollabWorkerKind;
  label?: string;
  larkAppId: string;
  chatId: string;
  topicId?: string;
  cliId?: string;
  status: CollabWorkerStatus;
  leasedBy?: string;
  leaseExpiresAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface CollabWorkerPoolFile {
  version: 1;
  workers: CollabWorkerPoolEntry[];
}

export interface AddCollabWorkerInput {
  id: string;
  larkAppId: string;
  chatId: string;
  topicId?: string;
  label?: string;
  cliId?: string;
}

export function collabWorkerPoolPath(dataDir: string): string {
  return join(dataDir, 'collab', 'worker-pool.json');
}

export function readCollabWorkerPool(dataDir: string): CollabWorkerPoolFile {
  const file = collabWorkerPoolPath(dataDir);
  if (!existsSync(file)) return { version: 1, workers: [] };
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8'));
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.workers)) return { version: 1, workers: [] };
    return {
      version: 1,
      workers: raw.workers
        .map(normalizeEntry)
        .filter((w: CollabWorkerPoolEntry | null): w is CollabWorkerPoolEntry => !!w),
    };
  } catch {
    return { version: 1, workers: [] };
  }
}

export async function addCollabWorker(dataDir: string, input: AddCollabWorkerInput): Promise<CollabWorkerPoolEntry> {
  validateId(input.id);
  if (!input.larkAppId.trim()) throw new Error('larkAppId is required');
  if (!input.chatId.trim()) throw new Error('chatId is required');
  const file = collabWorkerPoolPath(dataDir);
  return withPoolLock(dataDir, async () => {
    const pool = readCollabWorkerPool(dataDir);
    const now = Date.now();
    const existing = pool.workers.find((w) => w.id === input.id);
    const next: CollabWorkerPoolEntry = {
      id: input.id,
      kind: 'botmux-cli',
      label: input.label?.trim() || existing?.label,
      larkAppId: input.larkAppId.trim(),
      chatId: input.chatId.trim(),
      topicId: input.topicId?.trim() || input.chatId.trim(),
      cliId: input.cliId?.trim() || existing?.cliId,
      status: existing?.status ?? 'available',
      leasedBy: existing?.leasedBy,
      leaseExpiresAt: existing?.leaseExpiresAt,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    const idx = pool.workers.findIndex((w) => w.id === input.id);
    if (idx >= 0) pool.workers[idx] = next;
    else pool.workers.push(next);
    writePoolFile(file, pool);
    return next;
  });
}

export async function removeCollabWorker(dataDir: string, id: string): Promise<boolean> {
  const file = collabWorkerPoolPath(dataDir);
  return withPoolLock(dataDir, async () => {
    const pool = readCollabWorkerPool(dataDir);
    const before = pool.workers.length;
    pool.workers = pool.workers.filter((w) => w.id !== id);
    if (pool.workers.length !== before) writePoolFile(file, pool);
    return pool.workers.length !== before;
  });
}

export async function leaseCollabWorker(
  dataDir: string,
  input: { runId: string; ttlMs?: number; now?: number },
): Promise<CollabWorkerPoolEntry | null> {
  const file = collabWorkerPoolPath(dataDir);
  return withPoolLock(dataDir, async () => {
    const pool = readCollabWorkerPool(dataDir);
    if (pool.workers.length === 0) return null;
    const now = input.now ?? Date.now();
    const ttlMs = input.ttlMs ?? 30 * 60 * 1000;
    const existing = pool.workers.find((w) => w.leasedBy === input.runId);
    const candidate = existing ?? pool.workers.find((w) =>
      w.status !== 'leased' || (typeof w.leaseExpiresAt === 'number' && w.leaseExpiresAt <= now)
    );
    if (!candidate) return null;
    candidate.status = 'leased';
    candidate.leasedBy = input.runId;
    candidate.leaseExpiresAt = now + ttlMs;
    candidate.updatedAt = now;
    writePoolFile(file, pool);
    return { ...candidate };
  });
}

export async function releaseCollabWorker(dataDir: string, runId: string): Promise<void> {
  const file = collabWorkerPoolPath(dataDir);
  await withPoolLock(dataDir, async () => {
    const pool = readCollabWorkerPool(dataDir);
    let changed = false;
    const now = Date.now();
    for (const worker of pool.workers) {
      if (worker.leasedBy !== runId) continue;
      worker.status = 'available';
      worker.leasedBy = undefined;
      worker.leaseExpiresAt = undefined;
      worker.updatedAt = now;
      changed = true;
    }
    if (changed) writePoolFile(file, pool);
  });
}

async function withPoolLock<T>(dataDir: string, fn: () => Promise<T>): Promise<T> {
  const file = collabWorkerPoolPath(dataDir);
  mkdirSync(join(dataDir, 'collab'), { recursive: true });
  return withFileLock(file, fn);
}

function writePoolFile(file: string, pool: CollabWorkerPoolFile): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, workers: pool.workers }, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, file);
}

function validateId(id: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(id)) {
    throw new Error('worker id must match /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/');
  }
}

function normalizeEntry(raw: any): CollabWorkerPoolEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.kind !== 'botmux-cli') return null;
  if (typeof raw.id !== 'string' || typeof raw.larkAppId !== 'string' || typeof raw.chatId !== 'string') return null;
  const now = Date.now();
  return {
    id: raw.id,
    kind: 'botmux-cli',
    label: typeof raw.label === 'string' ? raw.label : undefined,
    larkAppId: raw.larkAppId,
    chatId: raw.chatId,
    topicId: typeof raw.topicId === 'string' ? raw.topicId : raw.chatId,
    cliId: typeof raw.cliId === 'string' ? raw.cliId : undefined,
    status: raw.status === 'leased' ? 'leased' : 'available',
    leasedBy: typeof raw.leasedBy === 'string' ? raw.leasedBy : undefined,
    leaseExpiresAt: typeof raw.leaseExpiresAt === 'number' ? raw.leaseExpiresAt : undefined,
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : now,
  };
}
