import { runLoop, type RunLoopResult } from './loop.js';
import type { WorkflowRuntimeContext } from './runtime.js';
import type { WorkflowDefinition } from './definition.js';
import type { EventLog } from './events/append.js';
import { replay, type Snapshot } from './events/replay.js';
import {
  completeNodeCancel,
  completeRunCancel,
  requestCancel,
  type RequestCancelActor,
} from './cancel.js';

export type CancelWorkflowRunInput = {
  ctx: WorkflowRuntimeContext;
  reason: string;
  by: string;
  actor?: RequestCancelActor;
  maxTicks?: number;
};

export type CancelWorkflowRunResult = {
  snapshot: Snapshot;
  loopResult?: RunLoopResult;
  cancelEventId?: string;
  cancelAlreadyRequested: boolean;
  alreadyTerminal: boolean;
};

/**
 * Shared run-level cancel operation used by CLI and dashboard/daemon IPC.
 *
 * The operation is idempotent:
 * - terminal runs write zero events;
 * - repeated cancels reuse the existing run-level cancel intent;
 * - parent node/run cancel terminal events are written only once by replay
 *   intent markers.
 */
export async function cancelWorkflowRun(
  input: CancelWorkflowRunInput,
): Promise<CancelWorkflowRunResult> {
  const { ctx, reason, by, actor = 'human', maxTicks = 200 } = input;
  let snapshot = replay(await ctx.log.readAll());

  if (isTerminalRunStatus(snapshot.run.status)) {
    return { snapshot, cancelAlreadyRequested: false, alreadyTerminal: true };
  }

  let cancelEventId = snapshot.cancelledRunIntent?.cancelOriginEventId;
  const cancelAlreadyRequested = !!snapshot.cancelledRunIntent;
  if (!snapshot.cancelledRunIntent) {
    const cancel = await requestCancel(
      ctx.log,
      {
        target: { kind: 'run', runId: ctx.log.runId },
        reason,
        by,
      },
      actor,
    );
    cancelEventId = cancel.eventId;
  }

  snapshot = replay(await ctx.log.readAll());
  await finalizeRunCancelIfPossible(ctx.log, ctx.def, snapshot);

  const loopResult = await runLoop(ctx, { maxTicks });

  snapshot = replay(await ctx.log.readAll());
  await finalizeRunCancelIfPossible(ctx.log, ctx.def, snapshot);
  snapshot = replay(await ctx.log.readAll());

  return {
    snapshot,
    loopResult,
    cancelEventId,
    cancelAlreadyRequested,
    alreadyTerminal: false,
  };
}

export async function finalizeRunCancelIfPossible(
  log: EventLog,
  def: WorkflowDefinition,
  snapshot: Snapshot,
): Promise<void> {
  const intent = snapshot.cancelledRunIntent;
  if (!intent) return;

  for (const nodeId of Object.keys(def.nodes)) {
    const nodeStatus = snapshot.nodes.get(nodeId)?.status ?? 'idle';
    if (isTerminalNodeStatus(nodeStatus)) continue;
    const ownedActivities = [...snapshot.activities.values()].filter(
      (activity) => activity.ownerNodeId === nodeId,
    );
    const hasNonTerminalActivity = ownedActivities.some(
      (activity) => !isTerminalActivityStatus(activity.status),
    );
    if (hasNonTerminalActivity) continue;
    await completeNodeCancel(
      log,
      {
        nodeId,
        cancelOriginEventId: intent.cancelOriginEventId,
      },
      'scheduler',
    );
  }

  const afterNodes = replay(await log.readAll());
  if (!afterNodes.cancelledRunIntent) return;
  const allNodesTerminal = Object.keys(def.nodes).every((nodeId) =>
    isTerminalNodeStatus(afterNodes.nodes.get(nodeId)?.status ?? 'idle'),
  );
  if (!allNodesTerminal) return;

  await completeRunCancel(
    log,
    { cancelOriginEventId: afterNodes.cancelledRunIntent.cancelOriginEventId },
    'scheduler',
  );
}

export function isTerminalRunStatus(status: string): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

function isTerminalNodeStatus(status: string): boolean {
  return (
    status === 'succeeded' ||
    status === 'failed' ||
    status === 'skipped' ||
    status === 'cancelled'
  );
}

function isTerminalActivityStatus(status: string): boolean {
  return (
    status === 'succeeded' ||
    status === 'failed' ||
    status === 'timedOut' ||
    status === 'cancelled'
  );
}
