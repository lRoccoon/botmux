/**
 * Programmatic end-to-end of the P0.0 walking skeleton — no daemon, no Feishu.
 * Drives the REAL board + REAL collab CLI (worker's interface) + REAL referee to
 * prove the three acceptance properties that are the whole point of P0.0:
 *
 *   ① kill a worker mid-task → a fresh worker that knows ONLY the board resumes
 *      and the run reaches the SAME successful result.
 *   ② "daemon restart": a brand-new board over the same log replays byte-identical.
 *   ③ goal change mid-run → the worker adapts, with delivered→read→applied
 *      receipts visible on the board.
 *
 * The control-plane (codex's side) is simulated with direct board writes; the
 * worker (claude's side) acts ONLY through `botmux collab …` so the test exercises
 * the actual cross-process interface.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openCollabBoard } from '../src/collab/board.js';
import { runReferee } from '../src/collab/referee.js';
import { cmdCollab } from '../src/collab/cli.js';
import type { CollabBoard, CollabEventDraft } from '../src/collab/contract.js';

const RUN = 'run-e2e-1';
const TASK = 'task-1';

function cp(p: Partial<CollabEventDraft> & Pick<CollabEventDraft, 'type' | 'payload'>): CollabEventDraft {
  return { runId: RUN, actor: 'control-plane', affectedPaths: [], ...p } as CollabEventDraft;
}

describe('collab P0.0 end-to-end', () => {
  let baseDir: string;
  let cwd: string;
  let flag: string;
  const realEnv = process.env;
  let logSpy: ReturnType<typeof vi.spyOn>;

  // acceptance command: read a counter file, print FAILING=<n>, exit 0 iff n==0
  const ACCEPT = () => `n=$(cat ${flag} 2>/dev/null || echo 5); echo "FAILING=$n"; [ "$n" -eq 0 ]`;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'e2e-board-'));
    cwd = mkdtempSync(join(tmpdir(), 'e2e-cwd-'));
    flag = join(cwd, 'failing.txt');
    writeFileSync(flag, '5'); // 5 failing to start
    process.env = { ...realEnv, BOTMUX_COLLAB_RUN_ID: RUN, BOTMUX_COLLAB_RUNS_DIR: baseDir, BOTMUX_COLLAB_TASK_ID: TASK };
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    process.env = realEnv;
    rmSync(baseDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  // ── control-plane (simulated) ──────────────────────────────────────────────
  async function controlPlaneStart(board: CollabBoard, goal: string) {
    await board.append(cp({ type: 'RunCreated', idempotencyKey: 'rc', topicId: 'tctl', affectedPaths: ['goal', 'budget', 'status'],
      payload: { goal, budgetLimit: 50, budgetUnit: 'turns', controlTopicId: 'tctl',
        acceptanceCriteria: { command: ACCEPT(), doneWhen: 'exitZero', progressMetric: { name: 'failing', pattern: 'FAILING=(\\d+)' } } } }));
    await board.append(cp({ type: 'TaskCreated', idempotencyKey: 'tc', taskId: TASK, affectedPaths: ['task'], payload: { taskId: TASK, title: 'drive failing to 0', spec: goal } }));
  }
  async function allocate(board: CollabBoard, workerId: string) {
    await board.append(cp({ type: 'WorkerAllocated', idempotencyKey: `wa-${workerId}`, workerId, taskId: TASK, affectedPaths: ['worker'], payload: { workerId, taskId: TASK } }));
    await board.append(cp({ type: 'TaskAssigned', idempotencyKey: `ta-${workerId}`, taskId: TASK, workerId, affectedPaths: ['task'], payload: { taskId: TASK, workerId } }));
  }
  // after a worker's turn: control-plane records the turn (spends 1 turn-budget) then runs the referee
  async function endTurnAndJudge(board: CollabBoard, workerId: string, n: number) {
    await board.append(cp({ type: 'WorkerTurnFinished', actor: 'control-plane', idempotencyKey: `wtf-${workerId}-${n}`, workerId, budgetDelta: -1, affectedPaths: ['worker', 'budget'], payload: { workerId, reason: 'yielded' } }));
    return runReferee(board, { cwd });
  }

  // ── worker: acts ONLY through the collab CLI + the env it was given ─────────
  async function workerTurn(workerId: string, opts: { setFailingTo: number }) {
    process.env.BOTMUX_COLLAB_WORKER_ID = workerId;
    // 1. read the board — the worker's entire knowledge of the world
    const board = openCollabBoard(RUN, { baseDir });
    const snap = await board.snapshot();
    // 2. handle any unapplied human intervention first
    for (const iv of snap.interventions) {
      if (iv.receipt !== 'applied') {
        await cmdCollab('receipt', ['--intervention', iv.interventionId, '--state', 'read']);
        await cmdCollab('receipt', ['--intervention', iv.interventionId, '--state', 'applied']);
      }
    }
    // 3. mark working + do the actual on-disk work toward the goal
    await cmdCollab('status', ['--status', 'in_progress']);
    writeFileSync(flag, String(opts.setFailingTo));
    await cmdCollab('artifact', ['--path', `fix-by-${workerId}.txt`, '--note', `set failing=${opts.setFailingTo}`]);
  }

  it('① kill worker mid-task → fresh worker resumes from board alone → identical success', async () => {
    const board = openCollabBoard(RUN, { baseDir });
    await controlPlaneStart(board, 'make the acceptance command pass');

    // worker w1 takes a partial step: 5 → 2, then we KILL it (never call it again)
    await allocate(board, 'w1');
    await workerTurn('w1', { setFailingTo: 2 });
    let verdict = await endTurnAndJudge(board, 'w1', 1);
    expect(verdict.verdict).toBe('progressing');
    expect((await board.snapshot()).status).toBe('running');

    // 💀 w1 is gone. control-plane notices and leases a brand-new worker w2.
    await board.append(cp({ type: 'WorkerLost', actor: 'system', idempotencyKey: 'lost-w1', workerId: 'w1', affectedPaths: ['worker'], payload: { workerId: 'w1', detectedBy: 'watchdog' } }));
    await allocate(board, 'w2');

    // w2 knows NOTHING except the board. It reads it and finishes the job: 2 → 0
    await workerTurn('w2', { setFailingTo: 0 });
    verdict = await endTurnAndJudge(board, 'w2', 1);
    expect(verdict.verdict).toBe('done');

    const snap = await board.snapshot();
    expect(snap.status).toBe('succeeded');
    expect(snap.task?.status).toBe('done');
    // both workers' artifacts survived the handoff
    expect(snap.artifacts.map((a) => a.path).sort()).toEqual(['fix-by-w1.txt', 'fix-by-w2.txt']);
    // the run actually achieved the goal on disk
    expect(readFileSync(flag, 'utf-8')).toBe('0');
    // provenance: the final verdict came from the referee running the command (exit 0), not a worker claim
    const lastVerdict = snap.progressLog[snap.progressLog.length - 1];
    expect(lastVerdict.verdict).toBe('done');
  });

  it('② daemon restart → replay is byte-identical', async () => {
    const board = openCollabBoard(RUN, { baseDir });
    await controlPlaneStart(board, 'g');
    await allocate(board, 'w1');
    await workerTurn('w1', { setFailingTo: 1 });
    await endTurnAndJudge(board, 'w1', 1);
    const before = await board.snapshot();

    // brand-new process/object over the same on-disk log
    const restarted = openCollabBoard(RUN, { baseDir });
    const after = await restarted.snapshot();
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  it('③ goal change mid-run → worker adapts with delivered→read→applied receipts', async () => {
    const board = openCollabBoard(RUN, { baseDir });
    await controlPlaneStart(board, 'original goal');
    await allocate(board, 'w1');
    await workerTurn('w1', { setFailingTo: 3 });
    await endTurnAndJudge(board, 'w1', 1);

    // human edits the goal on the card → control-plane lands the request, applies
    // the new goal, and pushes the worker with a delivered receipt
    const req = await board.append(cp({ type: 'GoalChangeRequested', actor: 'human', idempotencyKey: 'gcr', affectedPaths: ['interventions'], payload: { proposedGoal: 'updated goal: also keep failing at 0' } }));
    const ivId = req.event.eventId;
    await board.append(cp({ type: 'GoalChanged', idempotencyKey: 'gc', affectedPaths: ['goal'], payload: { goal: 'updated goal: also keep failing at 0', fromRequest: ivId } }));
    await board.append(cp({ type: 'InterventionReceiptUpdated', idempotencyKey: `r-delivered`, affectedPaths: ['interventions'], payload: { interventionId: ivId, state: 'delivered' } }));

    // worker's next turn picks up the intervention and acknowledges it
    await workerTurn('w1', { setFailingTo: 0 });
    await endTurnAndJudge(board, 'w1', 2);

    const snap = await board.snapshot();
    expect(snap.goal).toBe('updated goal: also keep failing at 0');
    expect(snap.interventions).toHaveLength(1);
    expect(snap.interventions[0]).toMatchObject({ interventionId: ivId, kind: 'goal-change', receipt: 'applied' });
    expect(snap.status).toBe('succeeded'); // it also drove failing to 0
  });
});
