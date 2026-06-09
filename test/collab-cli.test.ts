import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openCollabBoard } from '../src/collab/board.js';
import { cmdCollab } from '../src/collab/cli.js';
import type { CollabEventDraft } from '../src/collab/contract.js';
import { readCollabWorkerPool } from '../src/collab/worker-pool-store.js';

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

    await cmdCollab('pool', ['add', '--id', 'coder-1', '--lark-app-id', 'worker_app', '--chat-id', 'oc_worker', '--label', 'Coder']);
    await cmdCollab('pool', ['list', '--json', '--compact']);

    const listed = JSON.parse(log.mock.calls.at(-1)?.[0] as string);
    log.mockRestore();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: 'coder-1', larkAppId: 'worker_app', chatId: 'oc_worker', status: 'available', cliId: 'codex' });
    expect(readCollabWorkerPool(dataDir).workers[0]).toMatchObject({ id: 'coder-1' });
    rmSync(dataDir, { recursive: true, force: true });
  });
});
