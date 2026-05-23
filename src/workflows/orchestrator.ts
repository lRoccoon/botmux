/**
 * Workflow orchestrator (pure decision layer).
 *
 * Given a current `Snapshot` and the `WorkflowDefinition`, decide what
 * the runtime should do next.  Returns a list of `OrchestratorAction`
 * descriptors — the executor (Slice D) is responsible for translating
 * those into event-log writes and side-effect dispatches.  Keeping the
 * decision function pure makes the critical-path semantics easy to test
 * without spinning up workers / IM / file IO.
 *
 * v0 scope (UI doc §7 landing #1): focus on the humanGate.stage='before'
 * loop.  Retries / cancel coordination / reconcile already live in
 * `resume.ts`; the orchestrator only emits forward-progress decisions
 * and lets resume own recovery.
 *
 * ────────────────────────────────────────────────────────────────────
 * Activity ID convention
 *
 *   gate activity: `<runId>::gate::<nodeId>`
 *   work activity: `<runId>::work::<nodeId>`
 *
 * One node may own at most one gate (before-gate) and one work
 * activity in v0.  After-gates and re-runs are deferred.
 *
 * v0.2 loop body activities are scoped by a `loop::<loopId>.<N>` segment:
 *
 *   loop work activity: `<runId>::loop::<loopId>.<N>::work::<bodyNodeId>`
 *   loop gate activity: `<runId>::loop::<loopId>.<N>::gate::<bodyNodeId>`
 *
 * `<N>` is the 1-indexed iteration; `<loopId>` is the loop block's
 * nodeId.  All segments stay within `SEGMENT_RE` (allows
 * `[A-Za-z0-9._:-]`), so existing `isValidPathSegment` / attempt-
 * sidecar path guards continue to apply without modification.
 * ────────────────────────────────────────────────────────────────────
 */

import {
  topologicalOrder,
  type HumanGate,
  type WorkflowDefinition,
  type WorkflowNode,
} from './definition.js';
import type { ErrorClass, OutputRef } from './events/payloads.js';
import type { Snapshot } from './events/replay.js';

// ─── Activity ID helpers ──────────────────────────────────────────────────

export function gateActivityId(runId: string, nodeId: string): string {
  return `${runId}::gate::${nodeId}`;
}

export function workActivityId(runId: string, nodeId: string): string {
  return `${runId}::work::${nodeId}`;
}

// ─── Loop iteration activity IDs (v0.2) ───────────────────────────────────
//
// See /tmp/wf-loop-v02.md §4.2 and the top-of-file ASCII spec.
//
// Iteration `N` is 1-indexed.  We refuse to encode `N < 1` so callers
// never accidentally emit `loop::foo.0` ids (the iteration counter is a
// real loop-state position, not a placeholder).

export function loopWorkActivityId(
  runId: string,
  loopId: string,
  iteration: number,
  bodyNodeId: string,
): string {
  if (!Number.isInteger(iteration) || iteration < 1) {
    throw new Error(
      `loopWorkActivityId: iteration must be a positive integer (got ${iteration})`,
    );
  }
  return `${runId}::loop::${loopId}.${iteration}::work::${bodyNodeId}`;
}

export function loopGateActivityId(
  runId: string,
  loopId: string,
  iteration: number,
  bodyNodeId: string,
): string {
  if (!Number.isInteger(iteration) || iteration < 1) {
    throw new Error(
      `loopGateActivityId: iteration must be a positive integer (got ${iteration})`,
    );
  }
  return `${runId}::loop::${loopId}.${iteration}::gate::${bodyNodeId}`;
}

/**
 * Parsed activity id.  `kind: 'plain'` corresponds to the v0.1 forms
 * (`<runId>::work::<nodeId>` / `<runId>::gate::<nodeId>`).  `kind:
 * 'loop'` corresponds to v0.2 loop-iteration forms.  Returns `undefined`
 * if `s` doesn't match any known shape — callers can treat that as
 * "not a workflow activity id" without throwing.
 */
export type ParsedActivityId =
  | {
      kind: 'plain';
      runId: string;
      activityKind: 'work' | 'gate';
      nodeId: string;
    }
  | {
      kind: 'loop';
      runId: string;
      loopId: string;
      iteration: number;
      activityKind: 'work' | 'gate';
      nodeId: string;
    };

const PLAIN_RE = /^([^:]+(?:::?[^:]+)*?)::(work|gate)::([A-Za-z0-9_.-]+)$/;
const LOOP_RE = /^(.+)::loop::([A-Za-z0-9_.-]+)\.(\d+)::(work|gate)::([A-Za-z0-9_.-]+)$/;

export function parseActivityId(s: string): ParsedActivityId | undefined {
  // Loop form first — the `::loop::` segment is unambiguous and would
  // also accidentally satisfy a greedy plain match if we tried plain
  // first (`runId` would absorb `::loop::<id>.<N>::work`).
  const loopMatch = LOOP_RE.exec(s);
  if (loopMatch) {
    const [, runId, loopId, iterStr, activityKind, nodeId] = loopMatch;
    const iteration = Number(iterStr);
    if (!Number.isFinite(iteration) || iteration < 1) return undefined;
    return {
      kind: 'loop',
      runId,
      loopId,
      iteration,
      activityKind: activityKind as 'work' | 'gate',
      nodeId,
    };
  }
  const plainMatch = PLAIN_RE.exec(s);
  if (plainMatch) {
    const [, runId, activityKind, nodeId] = plainMatch;
    return {
      kind: 'plain',
      runId,
      activityKind: activityKind as 'work' | 'gate',
      nodeId,
    };
  }
  return undefined;
}

// ─── Actions ──────────────────────────────────────────────────────────────

/**
 * `dispatchGate` — caller writes `attemptCreated` (for the gate activity)
 * + `waitCreated{waitKind:'human-gate'}` + (optionally) `nodeWaiting`.
 */
export type DispatchGateAction = {
  kind: 'dispatchGate';
  nodeId: string;
  activityId: string;
  humanGate: HumanGate;
};

/**
 * `dispatchWork` — caller writes `attemptCreated` for the work activity
 * and spawns the bot worker (subagent) or invokes the executor
 * (hostExecutor).
 */
export type DispatchWorkAction = {
  kind: 'dispatchWork';
  nodeId: string;
  activityId: string;
  node: WorkflowNode;
};

/**
 * `completeNodeSucceeded` — work activity reached terminal success.
 * Caller writes `nodeSucceeded{nodeId, lastActivityId}`.
 */
export type CompleteNodeSucceededAction = {
  kind: 'completeNodeSucceeded';
  nodeId: string;
  lastActivityId: string;
  outputRef: OutputRef;
};

/**
 * `completeNodeFailed` — work activity or gate activity reached terminal
 * failure (incl. gate rejection / deadline).  Caller writes
 * `nodeFailed{nodeId, lastActivityId, errorClass}` and locates
 * `rootCauseEventId` from the underlying terminal event.
 */
export type CompleteNodeFailedAction = {
  kind: 'completeNodeFailed';
  nodeId: string;
  lastActivityId: string;
  errorClass: ErrorClass;
};

/**
 * `completeRunSucceeded` — every node is succeeded and there's a single
 * sink whose output represents the run's product.  Multi-sink workflows
 * are deferred (caller can refuse / extend).
 */
export type CompleteRunSucceededAction = {
  kind: 'completeRunSucceeded';
  outputRef: OutputRef;
  sinkNodeId: string;
};

/**
 * `completeRunFailed` — at least one node failed; the run cannot proceed.
 * Caller writes `runFailed{failedNodeId, rootCauseEventId}` after
 * locating the original failure event.
 */
export type CompleteRunFailedAction = {
  kind: 'completeRunFailed';
  failedNodeId: string;
};

export type OrchestratorAction =
  | DispatchGateAction
  | DispatchWorkAction
  | CompleteNodeSucceededAction
  | CompleteNodeFailedAction
  | CompleteRunSucceededAction
  | CompleteRunFailedAction;

// ─── Decision function ───────────────────────────────────────────────────

/**
 * Pure decision function.  Read-only — never throws on graph cycles
 * (the caller is responsible for using `parseWorkflowDefinition` to
 * validate the graph upstream).  Returns `[]` when:
 *   - run is already terminal (succeeded / failed / cancelled)
 *   - all nodes are pending on dependencies / open waits / in-flight
 *     activities and no advancement is possible
 *
 * Ordering: node-scoped actions follow topological order so callers
 * see deps-ready nodes first.  Run-scoped actions (completeRun*) come
 * only if no per-node actions remain — they're the terminal sweep.
 */
export function decideNextActions(
  snapshot: Snapshot,
  def: WorkflowDefinition,
): OrchestratorAction[] {
  if (
    snapshot.run.status === 'succeeded' ||
    snapshot.run.status === 'failed' ||
    snapshot.run.status === 'cancelled'
  ) {
    return [];
  }

  // cancel-intent short-circuit (v0.1.4-a): once `cancelRequested` for the
  // whole run has been written, we stop emitting fresh dispatches.  Letting
  // the loop continue would let late `activitySucceeded` from workers that
  // hadn't yet observed the cancel walk the run past the cancel into a
  // terminal-success — exactly the race that parallel dispatch widens.
  // `cancelWorkflowRun` (called from `cancelWorkflowRunOnDaemon` after this
  // returns []) is responsible for fanning out cancelDelivered →
  // activityCanceled → nodeCanceled → runCanceled.
  if (snapshot.cancelledRunIntent) {
    return [];
  }

  const actions: OrchestratorAction[] = [];
  const runId = snapshot.run.runId;
  const order = topologicalOrder(def);

  let failedNodeId: string | undefined;
  let pendingCount = 0;

  for (const nodeId of order) {
    const node = def.nodes[nodeId]!;
    const nstatus = snapshot.nodes.get(nodeId)?.status ?? 'idle';

    // v0.2 loop / decision dispatch is owned by the loop runtime executor
    // (Step 3 of feat/workflow-loop-v02; see /tmp/wf-loop-v02.md §13).
    // Schema has landed but runtime is not yet wired — keep these out of
    // the legacy scheduler so a workflow that mistakenly invokes one in
    // Step 1 stays `pending` rather than silently failing.  Step 3 will
    // intercept these node types upstream and never reach this branch.
    if (node.type === 'loop' || node.type === 'decision') {
      pendingCount++;
      continue;
    }

    // Already settled at the node level — nothing for us to advance.
    if (nstatus === 'succeeded' || nstatus === 'skipped' || nstatus === 'cancelled') {
      continue;
    }
    if (nstatus === 'failed') {
      failedNodeId = failedNodeId ?? nodeId;
      continue;
    }

    // Dependencies gate dispatch.
    const depsOk = (node.depends ?? []).every(
      (dep) => snapshot.nodes.get(dep)?.status === 'succeeded',
    );
    if (!depsOk) {
      pendingCount++;
      continue;
    }

    const gateActId = gateActivityId(runId, nodeId);
    const workActId = workActivityId(runId, nodeId);
    const gateAct = snapshot.activities.get(gateActId);
    const workAct = snapshot.activities.get(workActId);

    if (node.humanGate) {
      if (!gateAct) {
        actions.push({
          kind: 'dispatchGate',
          nodeId,
          activityId: gateActId,
          humanGate: node.humanGate,
        });
        pendingCount++;
        continue;
      }
      if (gateAct.status === 'failed') {
        actions.push({
          kind: 'completeNodeFailed',
          nodeId,
          lastActivityId: gateActId,
          errorClass: 'userFault',
        });
        continue;
      }
      if (gateAct.status !== 'succeeded') {
        // gate in-flight (acquired / running / waiting) — wait.
        pendingCount++;
        continue;
      }
      // gate cleared → fall through to work dispatch / advancement
    }

    if (!workAct) {
      actions.push({
        kind: 'dispatchWork',
        nodeId,
        activityId: workActId,
        node,
      });
      pendingCount++;
      continue;
    }

    if (workAct.status === 'succeeded') {
      const output = snapshot.outputs.get(workActId);
      if (output) {
        actions.push({
          kind: 'completeNodeSucceeded',
          nodeId,
          lastActivityId: workActId,
          outputRef: output,
        });
      } else {
        pendingCount++;
      }
      continue;
    }

    if (workAct.status === 'failed' || workAct.status === 'timedOut') {
      // activityTimedOut payload pins errorClass='retryable' (spec §2.1),
      // but replay doesn't propagate it onto the attempt's `error` field —
      // it only records `runningMs`.  Special-case here so the orchestrator
      // doesn't silently upgrade the class to fatal via `deriveErrorClass`.
      const errorClass: ErrorClass =
        workAct.status === 'timedOut' ? 'retryable' : deriveErrorClass(workAct);
      actions.push({
        kind: 'completeNodeFailed',
        nodeId,
        lastActivityId: workActId,
        errorClass,
      });
      continue;
    }

    // running / waiting / acquired / effectAttempting — pending.
    pendingCount++;
  }

  if (actions.length === 0) {
    if (failedNodeId) {
      // Fail-fast: a node terminal-failed.  Any pending downstream nodes
      // are stuck on the failed dep and will never advance; in-flight
      // peer nodes are caller's problem to cancel-fanout if they want.
      actions.push({ kind: 'completeRunFailed', failedNodeId });
    } else if (pendingCount === 0) {
      const sinks = findSinks(def);
      if (sinks.length === 1) {
        const sinkId = sinks[0]!;
        const sinkOutput = snapshot.outputs.get(workActivityId(runId, sinkId));
        if (sinkOutput) {
          actions.push({
            kind: 'completeRunSucceeded',
            outputRef: sinkOutput,
            sinkNodeId: sinkId,
          });
        }
      }
      // Multi-sink: caller composes the run output (out of v0 scope).
    }
  }

  return actions;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function deriveErrorClass(activity: {
  attempts: Array<{ error?: { errorClass: ErrorClass } }>;
}): ErrorClass {
  const last = activity.attempts[activity.attempts.length - 1];
  return last?.error?.errorClass ?? 'fatal';
}

function findSinks(def: WorkflowDefinition): string[] {
  const referenced = new Set<string>();
  for (const node of Object.values(def.nodes)) {
    for (const dep of node.depends ?? []) referenced.add(dep);
  }
  return Object.keys(def.nodes).filter((id) => !referenced.has(id));
}
