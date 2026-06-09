import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openCollabBoard } from '../src/collab/board.js';
import type { CollabEventDraft } from '../src/collab/contract.js';

const RUN = 'run-test-1';

function draft(partial: Partial<CollabEventDraft> & Pick<CollabEventDraft, 'type' | 'payload'>): CollabEventDraft {
  return {
    runId: RUN,
    actor: 'control-plane',
    idempotencyKey: `k-${Math.round(performance.now() * 1000)}-${partial.type}`,
    affectedPaths: [],
    ...partial,
  } as CollabEventDraft;
}

describe('collab core', () => {
  let baseDir: string;
  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'collab-'));
  });
  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it('materializes a run end-to-end', async () => {
    const board = openCollabBoard(RUN, { baseDir });
    await board.append(draft({
      type: 'RunCreated', actor: 'control-plane', affectedPaths: ['goal', 'acceptanceCriteria', 'budget', 'status'],
      idempotencyKey: 'run-created', topicId: 't1',
      payload: { goal: 'make the test pass', acceptanceCriteria: { command: 'npm test', doneWhen: 'exitZero' }, budgetLimit: 1000, budgetUnit: 'tokens', controlTopicId: 't1' },
    }));
    await board.append(draft({ type: 'TaskCreated', affectedPaths: ['task'], idempotencyKey: 'task-created', taskId: 'task-1', payload: { taskId: 'task-1', title: 'fix', spec: 'do it' } }));
    await board.append(draft({ type: 'WorkerAllocated', affectedPaths: ['worker'], idempotencyKey: 'wa', workerId: 'w1', taskId: 'task-1', payload: { workerId: 'w1', taskId: 'task-1' } }));
    await board.append(draft({ type: 'TaskAssigned', affectedPaths: ['task'], idempotencyKey: 'ta', taskId: 'task-1', payload: { taskId: 'task-1', workerId: 'w1' } }));
    await board.append(draft({ type: 'WorkerTurnStarted', affectedPaths: ['worker'], actor: 'worker', idempotencyKey: 'wts', workerId: 'w1', payload: { workerId: 'w1' } }));
    await board.append(draft({ type: 'ArtifactRecorded', affectedPaths: ['artifacts'], actor: 'worker', idempotencyKey: 'ar1', workerId: 'w1', payload: { artifactId: 'a1', kind: 'file', path: 'src/x.ts' } }));
    // worker turn cost rides on WorkerTurnFinished.budgetDelta (main-account rule)
    await board.append(draft({ type: 'WorkerTurnFinished', affectedPaths: ['worker', 'budget'], actor: 'worker', idempotencyKey: 'wtf', workerId: 'w1', budgetDelta: -300, payload: { workerId: 'w1', reason: 'completed' } }));
    // referee runs the command itself; cost has no natural host → BudgetSpent
    await board.append(draft({ type: 'RefereeEvaluated', affectedPaths: ['progressLog', 'budget'], actor: 'referee', idempotencyKey: 're1', taskId: 'task-1', budgetDelta: -50, payload: { taskId: 'task-1', verdict: 'progressing', provenance: { command: 'npm test', exitCode: 1, summary: '2 failing' }, signal: { metric: 'failing', value: 2, prevValue: 5 } } }));

    const snap = await board.snapshot();
    expect(snap.goal).toBe('make the test pass');
    expect(snap.status).toBe('running');
    expect(snap.task).toMatchObject({ taskId: 'task-1', status: 'open', assignedWorkerId: 'w1' });
    expect(snap.worker).toMatchObject({ workerId: 'w1', phase: 'allocated' }); // turn finished → idle/leased
    expect(snap.artifacts).toHaveLength(1);
    expect(snap.progressLog).toHaveLength(1);
    expect(snap.progressLog[0]).toMatchObject({ verdict: 'progressing', metric: 'failing', value: 2, prevValue: 5 });
    expect(snap.budget).toMatchObject({ limit: 1000, spent: 350, remaining: 650, exhausted: false });
    expect(snap.revision).toBe(8);
  });

  it('replay is deterministic across a fresh board (acceptance test ②)', async () => {
    const b1 = openCollabBoard(RUN, { baseDir });
    await b1.append(draft({ type: 'RunCreated', affectedPaths: ['goal'], idempotencyKey: 'rc', topicId: 't1', payload: { goal: 'g', acceptanceCriteria: { command: 'true', doneWhen: 'exitZero' }, budgetLimit: 500, budgetUnit: 'tokens', controlTopicId: 't1' } }));
    await b1.append(draft({ type: 'TaskCreated', affectedPaths: ['task'], idempotencyKey: 'tc', taskId: 'x', payload: { taskId: 'x', title: 't', spec: 's' } }));
    await b1.append(draft({ type: 'GoalChanged', affectedPaths: ['goal'], idempotencyKey: 'gc', payload: { goal: 'g2' } }));
    const snap1 = await b1.snapshot();

    // brand-new board object over the same on-disk log = a daemon restart
    const b2 = openCollabBoard(RUN, { baseDir });
    const snap2 = await b2.snapshot();

    expect(snap2).toEqual(snap1);
    expect(JSON.stringify(snap2)).toBe(JSON.stringify(snap1)); // byte-identical
    expect(snap2.goal).toBe('g2');
  });

  it('dedupes on idempotencyKey', async () => {
    const board = openCollabBoard(RUN, { baseDir });
    const d = draft({ type: 'StopRequested', actor: 'human', affectedPaths: ['interventions'], idempotencyKey: 'same-key', payload: { reason: 'stop' } });
    const r1 = await board.append(d);
    const r2 = await board.append(d); // human double-clicked the card
    expect(r1.deduped).toBe(false);
    expect(r2.deduped).toBe(true);
    expect(r2.event.eventId).toBe(r1.event.eventId);
    expect((await board.history())).toHaveLength(1);
  });

  it('applies last-write-wins and logs ConflictRaised on stale baseRevision', async () => {
    const board = openCollabBoard(RUN, { baseDir });
    await board.append(draft({ type: 'RunCreated', affectedPaths: ['goal'], idempotencyKey: 'rc', topicId: 't1', payload: { goal: 'g', acceptanceCriteria: { command: 'true', doneWhen: 'exitZero' }, budgetLimit: 100, budgetUnit: 'tokens', controlTopicId: 't1' } }));
    // caller reasoned about revision 0 but log is already at 1 → stale
    const res = await board.append(draft({ type: 'GoalChanged', affectedPaths: ['goal'], idempotencyKey: 'gc', baseRevision: 0, payload: { goal: 'g2' } }));
    expect(res.ok).toBe(true);
    expect(res.conflictLogged).toBe(true);
    const hist = await board.history();
    expect(hist.some((e) => e.type === 'ConflictRaised')).toBe(true);
    expect((await board.snapshot()).goal).toBe('g2'); // write still landed
  });

  it('budget breaker: BudgetExhausted forces exhausted', async () => {
    const board = openCollabBoard(RUN, { baseDir });
    await board.append(draft({ type: 'RunCreated', affectedPaths: ['budget'], idempotencyKey: 'rc', topicId: 't1', payload: { goal: 'g', acceptanceCriteria: { command: 'true', doneWhen: 'exitZero' }, budgetLimit: 100, budgetUnit: 'tokens', controlTopicId: 't1' } }));
    await board.append(draft({ type: 'BudgetExhausted', actor: 'system', affectedPaths: ['budget'], idempotencyKey: 'be', budgetDelta: -100, payload: { limit: 100, spent: 100 } }));
    const snap = await board.snapshot();
    expect(snap.budget).toMatchObject({ remaining: 0, exhausted: true });
  });

  it('intervention receipt lifecycle delivered→read→applied (acceptance test ③ shape)', async () => {
    const board = openCollabBoard(RUN, { baseDir });
    const req = await board.append(draft({ type: 'GoalChangeRequested', actor: 'human', affectedPaths: ['interventions'], idempotencyKey: 'gcr', payload: { proposedGoal: 'new goal' } }));
    const id = req.event.eventId;
    for (const state of ['delivered', 'read', 'applied'] as const) {
      await board.append(draft({ type: 'InterventionReceiptUpdated', actor: state === 'delivered' ? 'control-plane' : 'worker', affectedPaths: ['interventions'], idempotencyKey: `r-${state}`, payload: { interventionId: id, state } }));
    }
    const snap = await board.snapshot();
    expect(snap.interventions).toHaveLength(1);
    expect(snap.interventions[0]).toMatchObject({ interventionId: id, kind: 'goal-change', receipt: 'applied' });
  });
});
