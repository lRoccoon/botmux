import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openCollabBoard } from '../src/collab/board.js';
import { runReferee } from '../src/collab/referee.js';
import type { CollabEventDraft } from '../src/collab/contract.js';

const RUN = 'run-ref-1';

function d(p: Partial<CollabEventDraft> & Pick<CollabEventDraft, 'type' | 'payload'>): CollabEventDraft {
  return { runId: RUN, actor: 'control-plane', affectedPaths: [], ...p } as CollabEventDraft;
}

async function seed(board: ReturnType<typeof openCollabBoard>, command: string) {
  await board.append(d({
    type: 'RunCreated', idempotencyKey: 'rc', topicId: 't1', affectedPaths: ['goal', 'budget', 'status'],
    payload: {
      goal: 'make it pass', budgetLimit: 100000, budgetUnit: 'tokens', controlTopicId: 't1',
      acceptanceCriteria: { command, doneWhen: 'exitZero', progressMetric: { name: 'failing', pattern: 'FAILING=(\\d+)' } },
    },
  }));
  await board.append(d({ type: 'TaskCreated', idempotencyKey: 'tc', taskId: 'task-1', affectedPaths: ['task'], payload: { taskId: 'task-1', title: 'fix', spec: 'do it' } }));
}

describe('referee', () => {
  let baseDir: string;
  let cwd: string;
  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'collab-ref-'));
    cwd = mkdtempSync(join(tmpdir(), 'collab-cwd-'));
  });
  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it('runs the command itself: fail→progress→pass closes the run with provenance', async () => {
    const board = openCollabBoard(RUN, { baseDir });
    // a "test" command that reads a counter file and prints FAILING=<n>, exit nonzero unless 0
    const flag = join(cwd, 'failing.txt');
    const cmd = `n=$(cat ${flag} 2>/dev/null || echo 5); echo "FAILING=$n"; [ "$n" -eq 0 ]`;
    await seed(board, cmd);

    // each evaluation is preceded by a worker turn finishing (the causal trigger)
    let turn = 0;
    const workerTurn = () =>
      board.append(d({ type: 'WorkerTurnFinished', actor: 'worker', idempotencyKey: `wtf${turn++}`, affectedPaths: ['worker'], workerId: 'w1', payload: { workerId: 'w1', reason: 'yielded' } }));

    writeFileSync(flag, '5');
    let r = await runReferee(board, { cwd }); // first eval, gate is open
    expect(r.verdict).toBe('progressing'); // first measurement, baseline 5
    expect(r.metricValue).toBe(5);

    await workerTurn();
    writeFileSync(flag, '2');
    r = await runReferee(board, { cwd });
    expect(r.verdict).toBe('progressing'); // 2 < 5
    expect(r.metricValue).toBe(2);

    await workerTurn();
    writeFileSync(flag, '3');
    r = await runReferee(board, { cwd });
    expect(r.verdict).toBe('regressed'); // 3 > 2

    await workerTurn();
    writeFileSync(flag, '0');
    r = await runReferee(board, { cwd });
    expect(r.verdict).toBe('done'); // exit 0

    const snap = await board.snapshot();
    expect(snap.status).toBe('succeeded');
    expect(snap.task?.status).toBe('done');
    expect(snap.progressLog).toHaveLength(4);
    // the 'done' verdict carries real provenance: the command actually ran, exit 0
    const last = snap.progressLog[snap.progressLog.length - 1];
    expect(last.verdict).toBe('done');
  });

  it('self-gates: a heartbeat with no new work since the last verdict is a no-op', async () => {
    const board = openCollabBoard(RUN, { baseDir });
    const flag = join(cwd, 'failing.txt');
    const cmd = `n=$(cat ${flag} 2>/dev/null || echo 5); echo "FAILING=$n"; [ "$n" -eq 0 ]`;
    await seed(board, cmd);
    writeFileSync(flag, '3');

    const r1 = await runReferee(board, { cwd });
    expect(r1.verdict).toBe('progressing');
    // no new WorkerTurnFinished / ArtifactRecorded / Goal change → nothing to judge
    const r2 = await runReferee(board, { cwd });
    expect(r2.verdict).toBe('no-op');
    expect((await board.snapshot()).progressLog).toHaveLength(1); // only one verdict recorded
  });

  it('budget exhausted outranks evaluation and stops the run', async () => {
    const board = openCollabBoard(RUN, { baseDir });
    await board.append(d({ type: 'RunCreated', idempotencyKey: 'rc', topicId: 't1', affectedPaths: ['budget'], payload: { goal: 'g', budgetLimit: 100, budgetUnit: 'tokens', controlTopicId: 't1', acceptanceCriteria: { command: 'true', doneWhen: 'exitZero' } } }));
    await board.append(d({ type: 'TaskCreated', idempotencyKey: 'tc', taskId: 'task-1', affectedPaths: ['task'], payload: { taskId: 'task-1', title: 't', spec: 's' } }));
    await board.append(d({ type: 'BudgetExhausted', actor: 'system', idempotencyKey: 'be', budgetDelta: -100, affectedPaths: ['budget'], payload: { limit: 100, spent: 100 } }));

    const r = await runReferee(board, { cwd });
    expect(r.verdict).toBe('budget-exhausted');
    expect((await board.snapshot()).status).toBe('failed'); // budget-exhausted maps to failed
  });
});
