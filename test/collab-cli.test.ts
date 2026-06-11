import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openCollabBoard } from '../src/collab/board.js';
import { cmdCollab } from '../src/collab/cli.js';
import { getWorkerProtocolText } from '../src/collab/worker-protocol.js';
import type { CollabEventDraft } from '../src/collab/contract.js';
import {
  addCollabWorker,
  leaseCollabWorker,
  readCollabWorkerPool,
  renewCollabWorkerLease,
  sweepExpiredCollabWorkerLeases,
} from '../src/collab/worker-pool-store.js';

const RUN = 'run-cli-1';

function d(p: Partial<CollabEventDraft> & Pick<CollabEventDraft, 'type' | 'payload'>): CollabEventDraft {
  return { runId: RUN, actor: 'control-plane', affectedPaths: [], ...p } as CollabEventDraft;
}

describe('collab CLI (worker board access)', () => {
  let baseDir: string;
  const env = process.env;
  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'collab-cli-'));
    process.env = {
      ...env,
      BOTMUX_COLLAB_RUN_ID: RUN,
      BOTMUX_COLLAB_RUNS_DIR: baseDir,
      BOTMUX_COLLAB_WORKER_ID: 'w1',
      BOTMUX_COLLAB_TASK_ID: 'task-1',
    };
  });
  afterEach(() => {
    process.env = env;
    rmSync(baseDir, { recursive: true, force: true });
  });

  it('reads context from env and drives artifact/status/receipt → snapshot', async () => {
    // seed via the core (stands in for the control-plane)
    const board = openCollabBoard(RUN, { baseDir });
    await board.append(d({ type: 'RunCreated', idempotencyKey: 'rc', topicId: 't1', affectedPaths: ['goal'], payload: { goal: 'g', budgetLimit: 1000, budgetUnit: 'tokens', controlTopicId: 't1', acceptanceCriteria: { command: 'true', doneWhen: 'exitZero' } } }));
    await board.append(d({ type: 'TaskCreated', idempotencyKey: 'tc', taskId: 'task-1', affectedPaths: ['task'], payload: { taskId: 'task-1', title: 't', spec: 's' } }));
    await board.append(d({ type: 'WorkerAllocated', idempotencyKey: 'wa', workerId: 'w1', taskId: 'task-1', affectedPaths: ['worker'], payload: { workerId: 'w1', taskId: 'task-1' } }));
    const req = await board.append(d({ type: 'GoalChangeRequested', actor: 'human', idempotencyKey: 'gcr', affectedPaths: ['interventions'], payload: { proposedGoal: 'g2' } }));
    const interventionId = req.event.eventId;

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    // worker, via the CLI, using ONLY env for context:
    await cmdCollab('status', ['--status', 'in_progress']);
    await cmdCollab('artifact', ['--path', 'src/x.ts', '--note', 'created x']);
    await cmdCollab('receipt', ['--intervention', interventionId, '--state', 'read']);
    await cmdCollab('receipt', ['--intervention', interventionId, '--state', 'applied']);

    log.mockClear();
    await cmdCollab('snapshot', ['--compact']);
    const printed = log.mock.calls[0][0] as string;
    log.mockRestore();

    const snap = JSON.parse(printed);
    expect(snap.task).toMatchObject({ taskId: 'task-1', status: 'in_progress' });
    expect(snap.artifacts).toHaveLength(1);
    expect(snap.artifacts[0]).toMatchObject({ path: 'src/x.ts', kind: 'file', note: 'created x' });
    expect(snap.interventions[0]).toMatchObject({ interventionId, kind: 'goal-change', receipt: 'applied' });
  });

  it('receipt idempotency key is stable (re-emit is deduped)', async () => {
    const board = openCollabBoard(RUN, { baseDir });
    await board.append(d({ type: 'RunCreated', idempotencyKey: 'rc', topicId: 't1', affectedPaths: ['goal'], payload: { goal: 'g', budgetLimit: 1000, budgetUnit: 'tokens', controlTopicId: 't1', acceptanceCriteria: { command: 'true', doneWhen: 'exitZero' } } }));
    const req = await board.append(d({ type: 'StopRequested', actor: 'human', idempotencyKey: 'sr', affectedPaths: ['interventions'], payload: { reason: 'x' } }));
    const id = req.event.eventId;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await cmdCollab('receipt', ['--intervention', id, '--state', 'read']);
    await cmdCollab('receipt', ['--intervention', id, '--state', 'read']); // retry
    log.mockRestore();
    const hist = await board.history();
    expect(hist.filter((e) => e.type === 'InterventionReceiptUpdated')).toHaveLength(1);
  });

  it('propose writes TaskProposed from env context; resolution lands in snapshot.proposals', async () => {
    const board = openCollabBoard(RUN, { baseDir });
    await board.append(d({ type: 'RunCreated', idempotencyKey: 'rc', topicId: 't1', affectedPaths: ['goal'], payload: { goal: 'g', budgetLimit: 1000, budgetUnit: 'tokens', controlTopicId: 't1', acceptanceCriteria: { command: 'true', doneWhen: 'exitZero' } } }));
    await board.append(d({ type: 'TaskCreated', idempotencyKey: 'tc', taskId: 'task-1', affectedPaths: ['task'], payload: { taskId: 'task-1', title: 't', spec: 's' } }));

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await cmdCollab('propose', ['--title', 'split parser', '--spec', 'extract tokenizer into its own module', '--why', 'goal needs it', '--deps', 'a, b']);
    const out = JSON.parse(log.mock.calls.at(-1)?.[0] as string);
    log.mockRestore();
    expect(out.ok).toBe(true);
    expect(out.proposalId).toBeTruthy();

    let snap = await board.snapshot();
    expect(snap.proposals).toHaveLength(1);
    expect(snap.proposals[0]).toMatchObject({
      proposalId: out.proposalId,
      title: 'split parser',
      why: 'goal needs it',
      parentTaskId: 'task-1', // defaults to the worker's own task from env
      deps: ['a', 'b'],
      status: 'pending',
    });

    // planner resolution (stands in for codex's control-plane slice)
    await board.append(d({ type: 'TaskProposalResolved', actor: 'control-plane', idempotencyKey: 'res', affectedPaths: ['proposals'], payload: { proposalId: out.proposalId, resolution: 'accepted', taskId: 'task-2' } }));
    snap = await board.snapshot();
    expect(snap.proposals[0]).toMatchObject({ status: 'accepted', taskId: 'task-2' });
    expect(snap.task).toMatchObject({ taskId: 'task-1' }); // initial task untouched
  });

  it('propose with explicit --id is retry-idempotent', async () => {
    const board = openCollabBoard(RUN, { baseDir });
    await board.append(d({ type: 'RunCreated', idempotencyKey: 'rc', topicId: 't1', affectedPaths: ['goal'], payload: { goal: 'g', budgetLimit: 1000, budgetUnit: 'tokens', controlTopicId: 't1', acceptanceCriteria: { command: 'true', doneWhen: 'exitZero' } } }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await cmdCollab('propose', ['--id', 'p-fixed', '--title', 't', '--spec', 's', '--why', 'w']);
    await cmdCollab('propose', ['--id', 'p-fixed', '--title', 't', '--spec', 's', '--why', 'w']); // crash-retry
    const retry = JSON.parse(log.mock.calls.at(-1)?.[0] as string);
    log.mockRestore();
    expect(retry.deduped).toBe(true);
    const hist = await board.history();
    expect(hist.filter((e) => e.type === 'TaskProposed')).toHaveLength(1);
    expect((await board.snapshot()).proposals).toHaveLength(1);
  });

  it('worker protocol teaches propose-not-create', () => {
    const text = getWorkerProtocolText();
    expect(text).toContain('botmux collab propose');
    expect(text).toContain('never self-create or switch');
  });

  it('pool add validates collab-worker config and writes the pool store', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'collab-pool-'));
    const botsFile = join(dataDir, 'bots.json');
    writeFileSync(botsFile, JSON.stringify([
      { larkAppId: 'worker_app', larkAppSecret: 'secret', handler: 'collab-worker', cliId: 'codex' },
    ]));
    process.env = {
      ...process.env,
      SESSION_DATA_DIR: dataDir,
      BOTS_CONFIG: botsFile,
    };
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await cmdCollab('pool', ['add', '--id', 'coder-1', '--lark-app-id', 'worker_app', '--label', 'Coder']);
    await cmdCollab('pool', ['list', '--json', '--compact']);

    const listed = JSON.parse(log.mock.calls.at(-1)?.[0] as string);
    log.mockRestore();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: 'coder-1', larkAppId: 'worker_app', status: 'available', cliId: 'codex' });
    expect(listed[0].chatId).toBeUndefined();
    expect(readCollabWorkerPool(dataDir).workers[0]).toMatchObject({ id: 'coder-1' });
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('pool lease sweep releases expired dead leases while preserving renewed active runs', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'collab-pool-sweep-'));
    await addCollabWorker(dataDir, { id: 'coder-1', larkAppId: 'worker_app_1' });
    await addCollabWorker(dataDir, { id: 'coder-2', larkAppId: 'worker_app_2' });

    const leasedActive = await leaseCollabWorker(dataDir, { runId: 'run-active', now: 1_000, ttlMs: 10 });
    const leasedDead = await leaseCollabWorker(dataDir, { runId: 'run-dead', now: 1_000, ttlMs: 10 });
    expect(leasedActive?.id).toBe('coder-1');
    expect(leasedDead?.id).toBe('coder-2');

    await renewCollabWorkerLease(dataDir, { runId: 'run-active', now: 2_000, ttlMs: 10_000 });
    const released = await sweepExpiredCollabWorkerLeases(dataDir, {
      now: 2_000,
      protectedRunIds: ['run-active'],
    });

    expect(released.map((w) => w.id)).toEqual(['coder-2']);
    const pool = readCollabWorkerPool(dataDir);
    expect(pool.workers.find((w) => w.id === 'coder-1')).toMatchObject({ status: 'leased', leasedBy: 'run-active' });
    expect(pool.workers.find((w) => w.id === 'coder-2')).toMatchObject({ status: 'available' });
    expect(pool.workers.find((w) => w.id === 'coder-2')?.leasedBy).toBeUndefined();
    rmSync(dataDir, { recursive: true, force: true });
  });
});
