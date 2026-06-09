/**
 * collab/referee.ts — the deterministic loop-closer.
 *
 * The referee is NOT an agent and holds NO context. It reads the board, runs the
 * acceptance command ITSELF (so the verdict has executable provenance — a worker
 * can't fake "done"), and writes back a typed verdict. On 'done' it closes the
 * run; if the budget breaker has tripped it stops the run instead. That's the
 * whole point of acceptance test ④: progress can't be claimed, only proven.
 *
 * It is code, not an LLM, so it spends ~no budget; LLM control-plane spend
 * (intake NLU) is what uses BudgetSpent.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  CollabBoard,
  CollabEventDraft,
  RefereeVerdict,
} from './contract.js';

const pexec = promisify(execFile);

export interface RefereeResult {
  verdict: RefereeVerdict | 'budget-exhausted' | 'no-op';
  exitCode?: number;
  metricValue?: number;
}

export interface RefereeOptions {
  /** Working directory the acceptance command runs in. */
  cwd?: string;
  /** Idempotency discriminator; defaults to the board revision so one verdict
   *  is recorded per board state. */
  idemSuffix?: string;
}

export async function runReferee(board: CollabBoard, opts: RefereeOptions = {}): Promise<RefereeResult> {
  const snap = await board.snapshot();
  const idem = opts.idemSuffix ?? `rev${snap.revision}`;

  // Budget breaker first — it is the incorruptible circuit-breaker and outranks
  // any verdict the referee might otherwise reach.
  if (snap.budget?.exhausted && snap.status === 'running') {
    await board.append(finish(snap.runId, idem, 'budget-exhausted', 'budget exhausted before evaluation'));
    return { verdict: 'budget-exhausted' };
  }
  if (!snap.acceptanceCriteria || !snap.task || snap.status !== 'running') {
    return { verdict: 'no-op' };
  }

  // Self-gate so runReferee is safe to call on a heartbeat: only (re)run the
  // acceptance command when something evaluable happened since the last verdict.
  // The causal trigger is a finished worker turn / new artifact / changed goal;
  // a worker merely flipping status to in_progress is not new work.
  const history = await board.history();
  let lastVerdictSeq = -1;
  for (const e of history) if (e.type === 'RefereeEvaluated') lastVerdictSeq = e.seq;
  if (lastVerdictSeq >= 0) {
    const TRIGGERS = new Set(['WorkerTurnFinished', 'ArtifactRecorded', 'GoalChanged', 'AcceptanceCriteriaChanged']);
    const changedSince = history.some((e) => e.seq > lastVerdictSeq && TRIGGERS.has(e.type));
    if (!changedSince) return { verdict: 'no-op' };
  }

  const { command } = snap.acceptanceCriteria;
  let exitCode = 0;
  let output = '';
  const start = Date.now();
  try {
    const { stdout, stderr } = await pexec('bash', ['-lc', command], {
      cwd: opts.cwd,
      maxBuffer: 16 * 1024 * 1024,
    });
    output = String(stdout) + String(stderr);
  } catch (err) {
    const e = err as { code?: unknown; stdout?: unknown; stderr?: unknown };
    exitCode = typeof e.code === 'number' ? e.code : 1;
    output = String(e.stdout ?? '') + String(e.stderr ?? '');
  }
  const durationMs = Date.now() - start;
  const summary = output.trim().slice(-300);

  // Extract the progress metric, if the criteria says how to measure it.
  let signal: { metric: string; value: number; prevValue?: number } | undefined;
  const pm = snap.acceptanceCriteria.progressMetric;
  if (pm) {
    const m = output.match(new RegExp(pm.pattern));
    if (m && m[1] != null && !Number.isNaN(Number(m[1]))) {
      const value = Number(m[1]);
      const prevValue = [...snap.progressLog].reverse().find((p) => p.metric === pm.name)?.value;
      signal = { metric: pm.name, value, prevValue };
    }
  }

  // Verdict: exit 0 ⇒ done. Otherwise grade by the metric gradient when we have
  // one (lower = progress), else we can only say "not done" ⇒ stuck.
  let verdict: RefereeVerdict;
  if (exitCode === 0) {
    verdict = 'done';
  } else if (signal && signal.prevValue !== undefined) {
    verdict =
      signal.value < signal.prevValue ? 'progressing'
      : signal.value > signal.prevValue ? 'regressed'
      : 'stuck';
  } else if (signal) {
    verdict = 'progressing'; // first measurement establishes a baseline
  } else {
    verdict = 'stuck';
  }

  await board.append({
    type: 'RefereeEvaluated',
    runId: snap.runId,
    actor: 'referee',
    idempotencyKey: `referee:${idem}`,
    affectedPaths: ['progressLog'],
    taskId: snap.task.taskId,
    payload: {
      taskId: snap.task.taskId,
      verdict,
      provenance: { command, exitCode, durationMs, summary },
      signal,
    },
  } as CollabEventDraft);

  if (verdict === 'done') {
    await board.append({
      type: 'TaskStatusChanged',
      runId: snap.runId,
      actor: 'referee',
      idempotencyKey: `done-task:${idem}`,
      affectedPaths: ['task'],
      taskId: snap.task.taskId,
      payload: { taskId: snap.task.taskId, status: 'done' },
    } as CollabEventDraft);
    await board.append(finish(snap.runId, idem, 'succeeded', 'acceptance criteria met'));
  }

  return { verdict, exitCode, metricValue: signal?.value };
}

function finish(
  runId: string,
  idem: string,
  outcome: 'succeeded' | 'failed' | 'stopped' | 'budget-exhausted',
  summary: string,
): CollabEventDraft {
  return {
    type: 'RunFinished',
    runId,
    actor: outcome === 'budget-exhausted' ? 'system' : 'referee',
    idempotencyKey: `finish:${outcome}:${idem}`,
    affectedPaths: ['status'],
    payload: { outcome, summary },
  } as CollabEventDraft;
}
