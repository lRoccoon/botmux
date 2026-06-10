/**
 * collab/materialize.ts — the read-model. Pure, deterministic fold over the
 * event log → BoardSnapshot.
 *
 * DETERMINISM IS LOAD-BEARING. This function must contain no Date.now(), no
 * randomness, no IO — given the same events it must produce a byte-identical
 * snapshot every time. That property is exactly acceptance test ② (daemon
 * restart → replay → identical state). Keep it pure.
 *
 * Budget model: the wallet starts at `limit` (from RunCreated) and every event's
 * envelope `budgetDelta` (negative = spend, positive = return/top-up) adjusts it.
 *   remaining = limit + Σ budgetDelta ;  spent = max(0, -Σ budgetDelta)
 * A BudgetExhausted event also forces exhausted=true.
 */
import type {
  CollabEvent,
  BoardSnapshot,
  TaskState,
  TaskProposalEntry,
  WorkerState,
  ArtifactRef,
  ProgressEntry,
  BudgetState,
  InterventionState,
  RunStatus,
} from './contract.js';

export function materialize(runId: string, events: CollabEvent[]): BoardSnapshot {
  let goal = '';
  let acceptanceCriteria: BoardSnapshot['acceptanceCriteria'] = null;
  const tasks: TaskState[] = [];
  const proposals: TaskProposalEntry[] = [];
  let worker: WorkerState | null = null;
  const artifacts: ArtifactRef[] = [];
  const progressLog: ProgressEntry[] = [];
  let stall: BoardSnapshot['stall'] = null;
  const interventions = new Map<string, InterventionState>();
  let status: RunStatus = 'pending';
  let controlTopicId: string | null = null;

  let budgetLimit: number | null = null;
  let budgetUnit: BudgetState['unit'] = 'tokens';
  let deltaSum = 0;
  let sawExhausted = false;

  for (const e of events) {
    if (typeof e.budgetDelta === 'number') deltaSum += e.budgetDelta;

    switch (e.type) {
      case 'RunCreated':
        goal = e.payload.goal;
        acceptanceCriteria = e.payload.acceptanceCriteria;
        budgetLimit = e.payload.budgetLimit;
        budgetUnit = e.payload.budgetUnit;
        controlTopicId = e.payload.controlTopicId;
        if (status === 'pending') status = 'running';
        break;
      case 'GoalChanged':
        goal = e.payload.goal;
        break;
      case 'AcceptanceCriteriaChanged':
        acceptanceCriteria = e.payload.acceptanceCriteria;
        break;
      case 'RunFinished':
        status =
          e.payload.outcome === 'succeeded' ? 'succeeded'
          : e.payload.outcome === 'stopped' ? 'stopped'
          : 'failed'; // 'failed' | 'budget-exhausted'
        break;

      case 'TaskCreated': {
        const created: TaskState = {
          taskId: e.payload.taskId,
          title: e.payload.title,
          spec: e.payload.spec,
          status: 'open',
          assignedWorkerId: null,
        };
        // creation order; a same-taskId re-create (replayed dupes) replaces in place
        const at = tasks.findIndex((t) => t.taskId === created.taskId);
        if (at >= 0) tasks[at] = created;
        else tasks.push(created);
        break;
      }
      case 'TaskAssigned': {
        const t = tasks.find((t) => t.taskId === e.payload.taskId);
        if (t) t.assignedWorkerId = e.payload.workerId;
        break;
      }
      case 'TaskStatusChanged': {
        const t = tasks.find((t) => t.taskId === e.payload.taskId);
        if (t) {
          t.status = e.payload.status;
          t.note = e.payload.note;
        }
        break;
      }

      case 'TaskProposed': {
        // first proposal wins the id; log-level idempotency already dedupes retries
        if (!proposals.some((p) => p.proposalId === e.payload.proposalId)) {
          proposals.push({
            proposalId: e.payload.proposalId,
            title: e.payload.title,
            spec: e.payload.spec,
            why: e.payload.why,
            parentTaskId: e.payload.parentTaskId,
            expectedArtifact: e.payload.expectedArtifact,
            doneCriteria: e.payload.doneCriteria,
            deps: e.payload.deps,
            status: 'pending',
            proposedAtSeq: e.seq,
          });
        }
        break;
      }
      case 'TaskProposalResolved': {
        const p = proposals.find((p) => p.proposalId === e.payload.proposalId);
        if (p) {
          p.status = e.payload.resolution;
          p.taskId = e.payload.taskId;
          p.reason = e.payload.reason;
          p.resolvedAtSeq = e.seq;
        }
        break;
      }

      case 'WorkerAllocated':
        worker = {
          workerId: e.payload.workerId,
          taskId: e.payload.taskId,
          phase: 'allocated',
          leaseExpiresAt: e.payload.leaseExpiresAt,
          larkAppId: e.payload.larkAppId,
          topicId: e.payload.topicId,
        };
        break;
      case 'WorkerTurnStarted':
        if (worker && worker.workerId === e.payload.workerId) worker.phase = 'running';
        break;
      case 'WorkerTurnFinished':
        if (worker && worker.workerId === e.payload.workerId) {
          worker.phase = e.payload.reason === 'suspended' ? 'suspended' : 'allocated';
        }
        break;
      case 'WorkerLost':
        if (worker && worker.workerId === e.payload.workerId) worker.phase = 'lost';
        break;

      case 'ArtifactRecorded':
        artifacts.push({
          artifactId: e.payload.artifactId,
          kind: e.payload.kind,
          path: e.payload.path,
          sha256: e.payload.sha256,
          note: e.payload.note,
          recordedAtSeq: e.seq,
        });
        break;
      case 'RefereeEvaluated':
        progressLog.push({
          seq: e.seq,
          timestamp: e.timestamp,
          verdict: e.payload.verdict,
          direction: e.payload.progress?.direction,
          streak: e.payload.progress?.streak,
          metric: e.payload.signal?.metric,
          value: e.payload.signal?.value,
          prevValue: e.payload.signal?.prevValue,
          summary: e.payload.provenance.summary,
        });
        // An improved/done evaluation resolves any active stall.
        if (e.payload.verdict === 'done' || e.payload.progress?.direction === 'improved') stall = null;
        break;
      case 'ProgressStallRaised':
        stall = {
          streak: e.payload.streak,
          threshold: e.payload.threshold,
          raisedAtSeq: e.seq,
        };
        break;

      case 'BudgetExhausted':
        sawExhausted = true;
        break;
      case 'BudgetSpent':
        // cost rides on envelope.budgetDelta (handled above); nothing else.
        break;

      case 'GoalChangeRequested':
        interventions.set(e.eventId, {
          interventionId: e.eventId,
          kind: 'goal-change',
          receipt: null,
          payload: { proposedGoal: e.payload.proposedGoal },
        });
        break;
      case 'StopRequested':
        interventions.set(e.eventId, {
          interventionId: e.eventId,
          kind: 'stop',
          receipt: null,
          payload: { reason: e.payload.reason },
        });
        break;
      case 'InterventionReceiptUpdated': {
        const iv = interventions.get(e.payload.interventionId);
        if (iv) iv.receipt = e.payload.state;
        break;
      }

      case 'ConflictRaised':
        // audit-only under P0.0 last-write-wins; no read-model change.
        break;
    }
  }

  const revision = events.length ? events[events.length - 1].seq : 0;

  let budget: BudgetState | null = null;
  if (budgetLimit !== null) {
    const remaining = budgetLimit + deltaSum;
    budget = {
      limit: budgetLimit,
      unit: budgetUnit,
      spent: Math.max(0, -deltaSum),
      remaining,
      exhausted: sawExhausted || remaining <= 0,
    };
  }

  return {
    runId,
    revision,
    status,
    goal,
    acceptanceCriteria,
    task: tasks[0] ?? null,
    tasks,
    proposals,
    worker,
    artifacts,
    progressLog,
    stall,
    budget,
    interventions: [...interventions.values()],
    controlTopicId,
  };
}
