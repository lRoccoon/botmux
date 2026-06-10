/**
 * P3 contract/board slice: dynamic task proposals + exclusive-section CAS.
 *
 * - TaskProposed / TaskProposalResolved fold into snapshot.proposals; an
 *   accepted proposal followed by TaskCreated lands in snapshot.tasks while
 *   snapshot.task stays the INITIAL task (legacy single-task view).
 * - EXCLUSIVE_BOARD_PATHS (goal/acceptanceCriteria): a write with an explicit
 *   stale baseRevision is rejected — nothing applied, ConflictRaised
 *   resolution:'rejected' logged, AppendResult.rejected=true. Non-exclusive
 *   sections keep P0.0 last-write-wins. Writes without a baseRevision claim
 *   keep LWW even on exclusive sections (today's control-plane path).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openCollabBoard } from '../src/collab/board.js';
import type { CollabEventDraft } from '../src/collab/contract.js';

const RUN = 'run-p3-test';

function draft(partial: Partial<CollabEventDraft> & Pick<CollabEventDraft, 'type' | 'payload'>): CollabEventDraft {
  return {
    runId: RUN,
    actor: 'control-plane',
    idempotencyKey: `k-${Math.round(performance.now() * 1000)}-${partial.type}`,
    affectedPaths: [],
    ...partial,
  } as CollabEventDraft;
}

async function seedRun(board: ReturnType<typeof openCollabBoard>) {
  await board.append(draft({
    type: 'RunCreated', affectedPaths: ['goal', 'acceptanceCriteria', 'budget', 'status'],
    idempotencyKey: 'rc', topicId: 't1',
    payload: { goal: 'initial goal', acceptanceCriteria: { command: 'true', doneWhen: 'exitZero' }, budgetLimit: 100, budgetUnit: 'tokens', controlTopicId: 't1' },
  }));
  await board.append(draft({
    type: 'TaskCreated', affectedPaths: ['task'], idempotencyKey: 'tc-initial', taskId: 'task-1',
    payload: { taskId: 'task-1', title: 'initial', spec: 'the first task' },
  }));
}

describe('P3 task proposals', () => {
  let baseDir: string;
  beforeEach(() => { baseDir = mkdtempSync(join(tmpdir(), 'collab-p3-')); });
  afterEach(() => { rmSync(baseDir, { recursive: true, force: true }); });

  it('proposal → accept → TaskCreated lands in tasks[]; task stays the initial one', async () => {
    const board = openCollabBoard(RUN, { baseDir });
    await seedRun(board);

    await board.append(draft({
      type: 'TaskProposed', actor: 'worker', affectedPaths: ['proposals'],
      idempotencyKey: 'tp-1', workerId: 'w1',
      payload: { proposalId: 'prop-1', title: 'split: add median', spec: 'extend stats.json with median', why: 'goal change asks for median; isolated follow-up', parentTaskId: 'task-1', doneCriteria: 'check2.py exits 0' },
    }));

    let snap = await board.snapshot();
    expect(snap.proposals).toHaveLength(1);
    expect(snap.proposals[0]).toMatchObject({ proposalId: 'prop-1', status: 'pending', parentTaskId: 'task-1' });

    await board.append(draft({
      type: 'TaskProposalResolved', affectedPaths: ['proposals'],
      idempotencyKey: 'tpr-1',
      payload: { proposalId: 'prop-1', resolution: 'accepted', taskId: 'task-2' },
    }));
    await board.append(draft({
      type: 'TaskCreated', affectedPaths: ['task'], idempotencyKey: 'tc-2', taskId: 'task-2',
      payload: { taskId: 'task-2', title: 'split: add median', spec: 'extend stats.json with median' },
    }));
    await board.append(draft({
      type: 'TaskAssigned', affectedPaths: ['task'], idempotencyKey: 'ta-2', taskId: 'task-2',
      payload: { taskId: 'task-2', workerId: 'w1' },
    }));

    snap = await board.snapshot();
    expect(snap.proposals[0]).toMatchObject({ status: 'accepted', taskId: 'task-2' });
    expect(snap.proposals[0].resolvedAtSeq).toBeGreaterThan(snap.proposals[0].proposedAtSeq);
    expect(snap.tasks).toHaveLength(2);
    expect(snap.tasks[1]).toMatchObject({ taskId: 'task-2', assignedWorkerId: 'w1', status: 'open' });
    // legacy single-task view = the INITIAL task, untouched by later creations
    expect(snap.task).toMatchObject({ taskId: 'task-1' });
    // per-task status updates address the right entry
    await board.append(draft({
      type: 'TaskStatusChanged', affectedPaths: ['task'], idempotencyKey: 'ts-2', taskId: 'task-2',
      payload: { taskId: 'task-2', status: 'in_progress' },
    }));
    snap = await board.snapshot();
    expect(snap.tasks[1].status).toBe('in_progress');
    expect(snap.tasks[0].status).toBe('open');
  });

  it('rejected proposal records reason and creates no task', async () => {
    const board = openCollabBoard(RUN, { baseDir });
    await seedRun(board);
    await board.append(draft({
      type: 'TaskProposed', actor: 'worker', affectedPaths: ['proposals'], idempotencyKey: 'tp-r',
      payload: { proposalId: 'prop-r', title: 'rewrite everything', spec: 'big bang', why: 'cleaner' },
    }));
    await board.append(draft({
      type: 'TaskProposalResolved', affectedPaths: ['proposals'], idempotencyKey: 'tpr-r',
      payload: { proposalId: 'prop-r', resolution: 'rejected', reason: 'out of scope for the run goal' },
    }));
    const snap = await board.snapshot();
    expect(snap.proposals[0]).toMatchObject({ status: 'rejected', reason: 'out of scope for the run goal' });
    expect(snap.proposals[0].taskId).toBeUndefined();
    expect(snap.tasks).toHaveLength(1);
  });

  it('resolution invariants: accepted requires taskId, rejected must not carry one', async () => {
    const board = openCollabBoard(RUN, { baseDir });
    await seedRun(board);
    await board.append(draft({
      type: 'TaskProposed', actor: 'worker', affectedPaths: ['proposals'], idempotencyKey: 'tp-i',
      payload: { proposalId: 'prop-i', title: 't', spec: 's', why: 'w' },
    }));
    // the log validates authoritatively — an inconsistent resolution fails loud
    await expect(board.append(draft({
      type: 'TaskProposalResolved', affectedPaths: ['proposals'], idempotencyKey: 'tpr-i1',
      payload: { proposalId: 'prop-i', resolution: 'accepted' }, // no taskId
    }))).rejects.toThrow(/taskId/);
    await expect(board.append(draft({
      type: 'TaskProposalResolved', affectedPaths: ['proposals'], idempotencyKey: 'tpr-i2',
      payload: { proposalId: 'prop-i', resolution: 'rejected', taskId: 'task-9' },
    }))).rejects.toThrow(/taskId/);
  });

  it('pre-P3 logs replay unchanged: proposals empty, task === tasks[0]', async () => {
    const board = openCollabBoard(RUN, { baseDir });
    await seedRun(board);
    const snap = await board.snapshot();
    expect(snap.proposals).toEqual([]);
    expect(snap.tasks).toHaveLength(1);
    expect(snap.task).toEqual(snap.tasks[0]);
  });
});

describe('P3 exclusive-section CAS', () => {
  let baseDir: string;
  beforeEach(() => { baseDir = mkdtempSync(join(tmpdir(), 'collab-cas-')); });
  afterEach(() => { rmSync(baseDir, { recursive: true, force: true }); });

  it('stale claimed write to goal is rejected: nothing applied, audit logged', async () => {
    const board = openCollabBoard(RUN, { baseDir });
    await seedRun(board);
    const revBefore = await board.revision();

    // a competing write moves the board past the stale claimant's base
    await board.append(draft({
      type: 'GoalChanged', affectedPaths: ['goal'], idempotencyKey: 'gc-fresh',
      payload: { goal: 'goal v2' },
    }));

    const res = await board.append(draft({
      type: 'GoalChanged', affectedPaths: ['goal'], idempotencyKey: 'gc-stale',
      baseRevision: revBefore, // observed before the competing write
      payload: { goal: 'goal v2-CONFLICTING' },
    }));

    expect(res.rejected).toBe(true);
    expect(res.conflictLogged).toBe(true);
    expect(res.event.type).toBe('ConflictRaised');
    expect(res.event.payload).toMatchObject({ resolution: 'rejected', staleBaseRevision: revBefore });

    const snap = await board.snapshot();
    expect(snap.goal).toBe('goal v2'); // the stale write never landed
    const history = await board.history();
    expect(history.some((e) => e.type === 'GoalChanged' && e.payload.goal === 'goal v2-CONFLICTING')).toBe(false);
  });

  it('fresh claimed write to goal applies; non-exclusive stale write keeps LWW', async () => {
    const board = openCollabBoard(RUN, { baseDir });
    await seedRun(board);

    const rev = await board.revision();
    const ok = await board.append(draft({
      type: 'GoalChanged', affectedPaths: ['goal'], idempotencyKey: 'gc-ok',
      baseRevision: rev,
      payload: { goal: 'goal v2' },
    }));
    expect(ok.rejected).toBe(false);
    expect(ok.event.type).toBe('GoalChanged');

    // artifacts is append-only: a stale claim still applies, with an LWW marker
    const lww = await board.append(draft({
      type: 'ArtifactRecorded', actor: 'worker', affectedPaths: ['artifacts'], idempotencyKey: 'ar-stale',
      baseRevision: 0,
      payload: { artifactId: 'a1', kind: 'file', path: 'x.txt' },
    }));
    expect(lww.rejected).toBe(false);
    expect(lww.conflictLogged).toBe(true);
    const snap = await board.snapshot();
    expect(snap.goal).toBe('goal v2');
    expect(snap.artifacts).toHaveLength(1);
  });

  it('retrying the same stale write dedupes to one rejection marker; a fresh-based retry applies', async () => {
    const board = openCollabBoard(RUN, { baseDir });
    await seedRun(board);
    const staleBase = await board.revision();
    await board.append(draft({
      type: 'GoalChanged', affectedPaths: ['goal'], idempotencyKey: 'gc-move',
      payload: { goal: 'moved' },
    }));

    const first = await board.append(draft({
      type: 'GoalChanged', affectedPaths: ['goal'], idempotencyKey: 'gc-retry',
      baseRevision: staleBase, payload: { goal: 'mine' },
    }));
    const second = await board.append(draft({
      type: 'GoalChanged', affectedPaths: ['goal'], idempotencyKey: 'gc-retry',
      baseRevision: staleBase, payload: { goal: 'mine' },
    }));
    expect(first.rejected).toBe(true);
    expect(second.rejected).toBe(true);
    expect(second.deduped).toBe(true); // one marker, not two
    const markers = (await board.history()).filter((e) => e.type === 'ConflictRaised');
    expect(markers).toHaveLength(1);

    // same op retried after re-reading the board: fresh base, same key family
    const fresh = await board.append(draft({
      type: 'GoalChanged', affectedPaths: ['goal'], idempotencyKey: 'gc-retry-v2',
      baseRevision: await board.revision(), payload: { goal: 'mine' },
    }));
    expect(fresh.rejected).toBe(false);
    expect((await board.snapshot()).goal).toBe('mine');
  });

  it('idempotent retry of an APPLIED claimed write dedupes, never reads as conflict', async () => {
    const board = openCollabBoard(RUN, { baseDir });
    await seedRun(board);
    const rev = await board.revision();
    const a = await board.append(draft({
      type: 'GoalChanged', affectedPaths: ['goal'], idempotencyKey: 'gc-idem',
      baseRevision: rev, payload: { goal: 'applied once' },
    }));
    // same key replayed later — base is now behind, but it must dedupe (not reject)
    const b = await board.append(draft({
      type: 'GoalChanged', affectedPaths: ['goal'], idempotencyKey: 'gc-idem',
      baseRevision: rev, payload: { goal: 'applied once' },
    }));
    expect(a.rejected).toBe(false);
    expect(b.rejected).toBe(false);
    expect(b.deduped).toBe(true);
    expect(b.event.eventId).toBe(a.event.eventId);
  });
});
