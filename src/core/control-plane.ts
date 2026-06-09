import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AcceptanceCriteria, CollabBoard, CollabEventDraft } from '../collab/contract.js';
import { getWorkerProtocolText, parseCollabIntake } from '../collab/index.js';
import { leaseCollabWorker, readCollabWorkerPool, releaseCollabWorker } from '../collab/worker-pool-store.js';
import { buildCollabControlCard } from '../im/lark/card-builder.js';
import { parseEventMessage, resolveNonsupportMessage, stripLeadingMentions } from '../im/lark/message-parser.js';
import type { RoutingContext } from '../im/lark/event-dispatcher.js';
import { localeForBot } from '../i18n/index.js';
import { logger } from '../utils/logger.js';

type ReplyFn = (anchor: string, content: string, msgType?: string, larkAppId?: string) => Promise<string>;
type BoardFactory = (runId: string, baseDir: string) => Promise<CollabBoard> | CollabBoard;
export type SpawnCollabWorkerInput = {
  runId: string;
  workerId: string;
  taskId: string;
  baseDir: string;
  larkAppId: string;
  chatId: string;
  topicId: string;
  goal: string;
  prompt: string;
  ownerOpenId?: string;
};
export type PushCollabWorkerInput = {
  runId: string;
  workerId?: string;
  taskId?: string;
  larkAppId: string;
  topicId: string;
  content: string;
};
export type CollabWorkerLostInput = {
  runId: string;
  workerId: string;
  taskId: string;
  baseDir?: string;
  larkAppId: string;
  chatId: string;
  topicId: string;
  ownerOpenId?: string;
  sessionId?: string;
  workerPid?: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
};

type ControlPlaneConfig = {
  dataDir: string;
  reply: ReplyFn;
  boardFactory?: BoardFactory;
  spawnWorker?: (input: SpawnCollabWorkerInput) => Promise<void>;
  pushWorker?: (input: PushCollabWorkerInput) => Promise<void>;
  maxWorkerReallocations?: number;
};

type TopicIndex = {
  topics: Record<string, string>;
};

let configured: ControlPlaneConfig | null = null;
const boards = new Map<string, Promise<CollabBoard>>();
const DEFAULT_MAX_WORKER_REALLOCATIONS = 3;

export function configureCollabControlPlane(cfg: ControlPlaneConfig): void {
  configured = cfg;
}

function requireConfig(): ControlPlaneConfig {
  if (!configured) throw new Error('collab control-plane is not configured');
  return configured;
}

/** A terminal run accepts no further goal-change / stop interventions. Gating on
 *  this is what stops the operator from re-triggering the card form on a
 *  finished run and re-pushing turns into a (re-forked) worker. */
function isTerminalStatus(status: string): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'stopped';
}

function collabBaseDir(cfg = requireConfig()): string {
  const dir = join(cfg.dataDir, 'collab-runs');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function indexPath(cfg = requireConfig()): string {
  const dir = join(cfg.dataDir, 'collab');
  mkdirSync(dir, { recursive: true });
  return join(dir, 'control-topic-index.json');
}

function readIndex(): TopicIndex {
  const file = indexPath();
  if (!existsSync(file)) return { topics: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8'));
    return parsed && typeof parsed === 'object' && parsed.topics && typeof parsed.topics === 'object'
      ? { topics: parsed.topics }
      : { topics: {} };
  } catch {
    return { topics: {} };
  }
}

function writeIndex(index: TopicIndex): void {
  writeFileSync(indexPath(), JSON.stringify(index, null, 2) + '\n', 'utf-8');
}

function topicKey(larkAppId: string, topicId: string): string {
  return `${larkAppId}::${topicId}`;
}

function safeIdPart(s: string): string {
  return s.replace(/[^a-zA-Z0-9]+/g, '').slice(0, 32) || 'topic';
}

function makeRunId(topicId: string): string {
  return `collab_${safeIdPart(topicId)}_${Date.now().toString(36)}`;
}

async function resolveBoardFactory(): Promise<BoardFactory> {
  const cfg = requireConfig();
  if (cfg.boardFactory) return cfg.boardFactory;

  const modulePath = '../collab/index.js';
  const mod: any = await import(modulePath).catch((err) => {
    throw new Error(`collab_core_unavailable: ${err instanceof Error ? err.message : String(err)}`);
  });
  const factory = mod.openCollabBoard;
  if (typeof factory !== 'function') {
    throw new Error('collab_core_unavailable: expected openCollabBoard export');
  }
  return (runId, baseDir) => factory(runId, { baseDir });
}

async function boardForRun(runId: string): Promise<CollabBoard> {
  let pending = boards.get(runId);
  if (!pending) {
    pending = (async () => {
      const factory = await resolveBoardFactory();
      return factory(runId, collabBaseDir());
    })();
    boards.set(runId, pending);
  }
  return pending;
}

async function boardForTopic(larkAppId: string, topicId: string): Promise<{ board: CollabBoard; created: boolean }> {
  const index = readIndex();
  const key = topicKey(larkAppId, topicId);
  let runId = index.topics[key];
  let created = false;
  if (!runId) {
    runId = makeRunId(topicId);
    index.topics[key] = runId;
    writeIndex(index);
    created = true;
  }
  return { board: await boardForRun(runId), created };
}

function workerIdForRun(runId: string): string {
  return `${runId}-worker-1`;
}

async function allocateWorkerTarget(runId: string, fallback: { larkAppId: string; chatId: string; topicId: string }) {
  const cfg = requireConfig();
  const pool = readCollabWorkerPool(cfg.dataDir);
  if (pool.workers.length === 0) {
    return {
      workerId: workerIdForRun(runId),
      larkAppId: fallback.larkAppId,
      chatId: fallback.chatId,
      topicId: fallback.topicId,
      pooled: false,
      leaseExpiresAt: Date.now() + 30 * 60 * 1000,
    };
  }
  const leased = await leaseCollabWorker(cfg.dataDir, { runId });
  if (!leased) {
    throw new Error('collab worker pool has no available worker');
  }
  return {
    workerId: leased.id,
    larkAppId: leased.larkAppId,
    chatId: leased.chatId,
    topicId: leased.topicId ?? leased.chatId,
    pooled: true,
    leaseExpiresAt: leased.leaseExpiresAt,
  };
}

function topicIdForRun(larkAppId: string, runId: string): string | undefined {
  const index = readIndex();
  for (const [key, value] of Object.entries(index.topics)) {
    if (value !== runId) continue;
    const [appId, topicId] = key.split('::');
    if (appId === larkAppId && topicId) return topicId;
  }
  return undefined;
}

async function append(board: CollabBoard, draft: CollabEventDraft): Promise<string> {
  const res = await board.append(draft);
  return res.event.eventId;
}

function workerAssignmentPrompt(goal: string, task: { title: string; taskId: string }, prefix?: string): string {
  return `${getWorkerProtocolText()}\n\n` +
    `---\n${prefix ? `${prefix}\n\n` : ''}` +
    `Assigned task: ${task.title}\n` +
    `Task id: ${task.taskId}\n\n` +
    `Goal:\n${goal}`;
}

async function ensureRunCreated(board: CollabBoard, input: {
  goal: string;
  acceptanceCriteria: AcceptanceCriteria;
  topicId: string;
}): Promise<void> {
  const snapshot = await board.snapshot().catch(() => null);
  if (snapshot?.goal) return;
  await append(board, {
    runId: board.runId,
    type: 'RunCreated',
    actor: 'control-plane',
    idempotencyKey: `run-created:${input.topicId}`,
    affectedPaths: ['goal', 'acceptanceCriteria', 'budget', 'status'],
    topicId: input.topicId,
    payload: {
      goal: input.goal,
      acceptanceCriteria: input.acceptanceCriteria,
      budgetLimit: 20,
      budgetUnit: 'turns',
      controlTopicId: input.topicId,
    },
  });
  await append(board, {
    runId: board.runId,
    type: 'TaskCreated',
    actor: 'control-plane',
    idempotencyKey: `task-created:${input.topicId}`,
    affectedPaths: ['task'],
    topicId: input.topicId,
    taskId: 'task-1',
    payload: {
      taskId: 'task-1',
      title: 'Initial task',
      spec: input.goal,
    },
  });
}

function lostEventSuffix(input: CollabWorkerLostInput): string {
  return [
    input.sessionId ?? 'session',
    input.workerPid ?? 'pid',
    input.exitCode ?? 'null',
    input.signal ?? 'none',
  ].join(':');
}

export async function handleCollabWorkerLost(input: CollabWorkerLostInput): Promise<'ignored' | 'reallocated' | 'failed'> {
  const cfg = requireConfig();
  const board = await boardForRun(input.runId);
  const before = await board.snapshot();
  if (isTerminalStatus(before.status)) {
    logger.info(`[collab-control] ignore worker loss on terminal run ${input.runId} (${before.status})`);
    return 'ignored';
  }
  if (!before.task || !before.worker || before.worker.workerId !== input.workerId) {
    logger.info(`[collab-control] ignore stale worker loss run=${input.runId} worker=${input.workerId}`);
    return 'ignored';
  }

  const suffix = lostEventSuffix(input);
  await append(board, {
    runId: input.runId,
    type: 'WorkerLost',
    actor: 'system',
    idempotencyKey: `worker-lost:${input.runId}:${input.workerId}:${suffix}`,
    affectedPaths: ['worker'],
    topicId: input.topicId,
    taskId: input.taskId,
    workerId: input.workerId,
    payload: {
      workerId: input.workerId,
      detectedBy: 'crash',
      reason: input.signal ? `signal:${input.signal}` : `exit_code:${input.exitCode ?? 'null'}`,
    },
  });

  const history = await board.history();
  const lostCount = history.filter((e) => e.type === 'WorkerLost').length;
  const current = await board.snapshot();
  const maxReallocations = cfg.maxWorkerReallocations ?? DEFAULT_MAX_WORKER_REALLOCATIONS;
  if (current.budget?.exhausted) {
    await append(board, {
      runId: input.runId,
      type: 'RunFinished',
      actor: 'system',
      idempotencyKey: `worker-lost-budget-exhausted:${input.runId}:${suffix}`,
      affectedPaths: ['status'],
      topicId: input.topicId,
      payload: {
        outcome: 'budget-exhausted',
        summary: `Worker ${input.workerId} was lost and budget is exhausted.`,
      },
    });
    await releaseCollabWorker(cfg.dataDir, input.runId);
    return 'failed';
  }
  if (lostCount > maxReallocations) {
    await append(board, {
      runId: input.runId,
      type: 'RunFinished',
      actor: 'system',
      idempotencyKey: `worker-unrecoverable:${input.runId}:${suffix}`,
      affectedPaths: ['status'],
      topicId: input.topicId,
      payload: {
        outcome: 'failed',
        summary: `Worker ${input.workerId} was lost ${lostCount} times; reallocation cap ${maxReallocations} exceeded.`,
      },
    });
    await releaseCollabWorker(cfg.dataDir, input.runId);
    return 'failed';
  }

  // Reuse the current lease/identity for P0. This proves process-level recovery
  // with a fresh worker reading the board, and works even with a one-worker pool.
  const isPooledWorker = !!before.worker.larkAppId;
  const renewedLease = isPooledWorker
    ? await leaseCollabWorker(cfg.dataDir, { runId: input.runId }).catch(() => null)
    : null;
  const worker = {
    workerId: input.workerId,
    taskId: before.task.taskId,
    larkAppId: before.worker.larkAppId ?? input.larkAppId,
    chatId: input.chatId,
    topicId: before.worker.topicId ?? input.topicId,
    leaseExpiresAt: renewedLease?.leaseExpiresAt ?? before.worker.leaseExpiresAt ?? Date.now() + 30 * 60 * 1000,
    pooled: isPooledWorker,
  };
  await append(board, {
    runId: input.runId,
    type: 'WorkerAllocated',
    actor: 'control-plane',
    idempotencyKey: `worker-reallocated:${input.runId}:${input.workerId}:${suffix}`,
    affectedPaths: ['worker'],
    topicId: worker.topicId,
    taskId: before.task.taskId,
    workerId: input.workerId,
    payload: {
      workerId: input.workerId,
      taskId: before.task.taskId,
      leaseExpiresAt: worker.leaseExpiresAt,
      larkAppId: worker.pooled ? worker.larkAppId : undefined,
      topicId: worker.pooled ? worker.topicId : undefined,
    },
  });
  await append(board, {
    runId: input.runId,
    type: 'TaskAssigned',
    actor: 'control-plane',
    idempotencyKey: `task-reassigned:${input.runId}:${input.workerId}:${suffix}`,
    affectedPaths: ['task'],
    topicId: worker.topicId,
    taskId: before.task.taskId,
    workerId: input.workerId,
    payload: {
      taskId: before.task.taskId,
      workerId: input.workerId,
    },
  });
  try {
    await cfg.spawnWorker?.({
      runId: input.runId,
      workerId: input.workerId,
      taskId: before.task.taskId,
      baseDir: input.baseDir ?? collabBaseDir(),
      larkAppId: worker.larkAppId,
      chatId: worker.chatId,
      topicId: worker.topicId,
      goal: current.goal,
      prompt: workerAssignmentPrompt(
        current.goal,
        before.task,
        `Previous worker ${input.workerId} was lost. Read the board and resume from the latest snapshot/history.`,
      ),
      ownerOpenId: input.ownerOpenId,
    });
  } catch (err) {
    await append(board, {
      runId: input.runId,
      type: 'RunFinished',
      actor: 'system',
      idempotencyKey: `worker-respawn-failed:${input.runId}:${input.workerId}:${suffix}`,
      affectedPaths: ['status'],
      topicId: worker.topicId,
      payload: {
        outcome: 'failed',
        summary: `Worker ${input.workerId} was lost and respawn failed: ${err instanceof Error ? err.message : String(err)}`,
      },
    });
    await releaseCollabWorker(cfg.dataDir, input.runId);
    return 'failed';
  }
  await append(board, {
    runId: input.runId,
    type: 'WorkerTurnStarted',
    actor: 'control-plane',
    idempotencyKey: `worker-turn-restarted:${input.runId}:${input.workerId}:${suffix}`,
    affectedPaths: ['worker'],
    topicId: worker.topicId,
    taskId: before.task.taskId,
    workerId: input.workerId,
    payload: { workerId: input.workerId },
  });
  logger.info(`[collab-control] reallocated worker ${input.workerId} for run ${input.runId} after loss (${lostCount}/${maxReallocations})`);
  return 'reallocated';
}

async function requestGoalChange(board: CollabBoard, input: {
  goal: string;
  topicId?: string;
  workerId?: string;
  idempotencyPrefix: string;
  actor: 'human' | 'control-plane';
}): Promise<void> {
  const requestId = await append(board, {
    runId: board.runId,
    type: 'GoalChangeRequested',
    actor: input.actor,
    idempotencyKey: `${input.idempotencyPrefix}:request`,
    affectedPaths: ['interventions'],
    topicId: input.topicId,
    workerId: input.workerId,
    payload: { proposedGoal: input.goal },
  });
  await append(board, {
    runId: board.runId,
    type: 'GoalChanged',
    actor: 'control-plane',
    idempotencyKey: `${input.idempotencyPrefix}:apply`,
    affectedPaths: ['goal'],
    topicId: input.topicId,
    workerId: input.workerId,
    payload: { goal: input.goal, fromRequest: requestId },
  });
  await append(board, {
    runId: board.runId,
    type: 'InterventionReceiptUpdated',
    actor: 'control-plane',
    idempotencyKey: `${input.idempotencyPrefix}:delivered`,
    affectedPaths: ['interventions'],
    topicId: input.topicId,
    workerId: input.workerId,
    payload: { interventionId: requestId, state: 'delivered' },
  });
}

async function requestStop(board: CollabBoard, input: {
  reason?: string;
  topicId?: string;
  idempotencyPrefix: string;
  actor: 'human' | 'control-plane';
}): Promise<void> {
  const requestId = await append(board, {
    runId: board.runId,
    type: 'StopRequested',
    actor: input.actor,
    idempotencyKey: `${input.idempotencyPrefix}:request`,
    affectedPaths: ['interventions'],
    topicId: input.topicId,
    payload: { reason: input.reason },
  });
  await append(board, {
    runId: board.runId,
    type: 'RunFinished',
    actor: 'control-plane',
    idempotencyKey: `${input.idempotencyPrefix}:finish`,
    affectedPaths: ['status'],
    topicId: input.topicId,
    payload: { outcome: 'stopped', summary: input.reason ?? 'Stopped from control plane' },
  });
  await append(board, {
    runId: board.runId,
    type: 'InterventionReceiptUpdated',
    actor: 'control-plane',
    idempotencyKey: `${input.idempotencyPrefix}:delivered`,
    affectedPaths: ['interventions'],
    topicId: input.topicId,
    payload: { interventionId: requestId, state: 'delivered' },
  });
}

async function renderCard(board: CollabBoard, locale?: string): Promise<string> {
  return buildCollabControlCard(await board.snapshot(), locale === 'en' || locale === 'zh' ? locale : undefined);
}

export async function handleCollabControlMessage(data: any, ctx: RoutingContext): Promise<void> {
  const cfg = requireConfig();
  await resolveNonsupportMessage(data, ctx.larkAppId);
  const { parsed } = parseEventMessage(data);
  const topicId = ctx.anchor;
  const raw = stripLeadingMentions(parsed.content.trim(), parsed.mentions).trim();
  if (!raw) return;

  try {
    const { board } = await boardForTopic(ctx.larkAppId, topicId);
    const intake = parseCollabIntake(raw);
    await ensureRunCreated(board, {
      goal: intake.goal || raw,
      acceptanceCriteria: intake.acceptanceCriteria,
      topicId,
    });
    const snapshotAfterCreate = await board.snapshot();
    if (!snapshotAfterCreate.worker && snapshotAfterCreate.task) {
      const worker = await allocateWorkerTarget(board.runId, {
        larkAppId: ctx.larkAppId,
        chatId: ctx.chatId,
        topicId,
      });
      await append(board, {
        runId: board.runId,
        type: 'WorkerAllocated',
        actor: 'control-plane',
        idempotencyKey: `worker-allocated:${board.runId}`,
        affectedPaths: ['worker'],
        topicId: worker.topicId,
        taskId: snapshotAfterCreate.task.taskId,
        workerId: worker.workerId,
        payload: {
          workerId: worker.workerId,
          taskId: snapshotAfterCreate.task.taskId,
          leaseExpiresAt: worker.leaseExpiresAt,
          larkAppId: worker.pooled ? worker.larkAppId : undefined,
          topicId: worker.pooled ? worker.topicId : undefined,
        },
      });
      await append(board, {
        runId: board.runId,
        type: 'TaskAssigned',
        actor: 'control-plane',
        idempotencyKey: `task-assigned:${board.runId}`,
        affectedPaths: ['task'],
        topicId: worker.topicId,
        taskId: snapshotAfterCreate.task.taskId,
        workerId: worker.workerId,
        payload: {
          taskId: snapshotAfterCreate.task.taskId,
          workerId: worker.workerId,
        },
      });
      if (cfg.spawnWorker) {
        await cfg.spawnWorker({
          runId: board.runId,
          workerId: worker.workerId,
          taskId: snapshotAfterCreate.task.taskId,
          baseDir: collabBaseDir(),
          larkAppId: worker.larkAppId,
          chatId: worker.chatId,
          topicId: worker.topicId,
          goal: snapshotAfterCreate.goal,
          prompt: workerAssignmentPrompt(snapshotAfterCreate.goal, snapshotAfterCreate.task),
          ownerOpenId: parsed.senderId || undefined,
        });
        await append(board, {
          runId: board.runId,
          type: 'WorkerTurnStarted',
          actor: 'control-plane',
          idempotencyKey: `worker-turn-started:${board.runId}`,
          affectedPaths: ['worker'],
          topicId: worker.topicId,
          taskId: snapshotAfterCreate.task.taskId,
          workerId: worker.workerId,
          payload: { workerId: worker.workerId },
        });
      }
    }

    const goalMatch = raw.match(/^\/(?:goal|set-goal)\s+([\s\S]+)$/i);
    const stopMatch = raw.match(/^\/(?:stop|collab-stop)\b\s*([\s\S]*)$/i);
    if (goalMatch || stopMatch) {
      const current = await board.snapshot();
      if (isTerminalStatus(current.status)) {
        // Terminal run: refuse further goal/stop; just re-render the (now
        // control-disabled) card below.
        logger.info(`[collab-control] ignoring ${goalMatch ? 'goal' : 'stop'} on terminal run ${board.runId} (${current.status})`);
      } else if (goalMatch) {
        const newGoal = goalMatch[1].trim();
        if (newGoal === current.goal) {
          // No-op goal: don't write a redundant intervention or re-push the worker.
          logger.info(`[collab-control] goal unchanged on run ${board.runId}; skip push`);
        } else {
          await requestGoalChange(board, {
            goal: newGoal,
            topicId,
            idempotencyPrefix: `msg:${parsed.messageId}:goal`,
            actor: parsed.senderType === 'app' || parsed.senderType === 'bot' ? 'control-plane' : 'human',
          });
          const after = await board.snapshot();
          const pushTopicId = after.worker?.topicId ?? topicId;
          if (pushTopicId) {
            await cfg.pushWorker?.({
              runId: board.runId,
              workerId: after.worker?.workerId,
              taskId: after.task?.taskId,
              larkAppId: after.worker?.larkAppId ?? ctx.larkAppId,
              topicId: pushTopicId,
              content: `Goal changed. Read BOTMUX_COLLAB_RUN_ID from the collab board, acknowledge the intervention receipt, and adjust your work.\n\nNew goal:\n${newGoal}`,
            });
          }
        }
      } else if (stopMatch) {
        await requestStop(board, {
          reason: stopMatch[1]?.trim() || undefined,
          topicId,
          idempotencyPrefix: `msg:${parsed.messageId}:stop`,
          actor: parsed.senderType === 'app' || parsed.senderType === 'bot' ? 'control-plane' : 'human',
        });
        await releaseCollabWorker(cfg.dataDir, board.runId);
      }
    }

    await cfg.reply(topicId, await renderCard(board, localeForBot(ctx.larkAppId)), 'interactive', ctx.larkAppId);
  } catch (err) {
    logger.error(`[collab-control] message handling failed: ${err}`);
    await cfg.reply(
      topicId,
      `collab control-plane failed: ${err instanceof Error ? err.message : String(err)}`,
      'text',
      ctx.larkAppId,
    ).catch(() => undefined);
  }
}

export function isCollabControlAction(action?: string): boolean {
  return action === 'collab_goal_change' || action === 'collab_stop' || action === 'collab_refresh';
}

export async function handleCollabControlCardAction(data: any, larkAppId: string): Promise<any> {
  const value = data?.action?.value ?? {};
  const action = value.action;
  if (!isCollabControlAction(action)) return null;
  const runId = value.run_id;
  if (typeof runId !== 'string' || !runId) {
    return { toast: { type: 'error', content: 'Missing run_id' } };
  }

  try {
    const board = await boardForRun(runId);
    const snapshot = await board.snapshot();
    const cardMessageId = data?.context?.open_message_id ?? data?.open_message_id ?? 'card';
    if (action === 'collab_goal_change') {
      const goal = String(data?.action?.form_value?.goal ?? '').trim();
      if (!goal) return { toast: { type: 'error', content: 'Goal is empty' } };
      if (isTerminalStatus(snapshot.status)) {
        return { toast: { type: 'info', content: `Run already ${snapshot.status}` } };
      }
      if (goal === snapshot.goal) {
        return { toast: { type: 'info', content: 'Goal unchanged' } };
      }
      const topicId = topicIdForRun(larkAppId, runId);
      await requestGoalChange(board, {
        goal,
        topicId,
        workerId: snapshot.worker?.workerId,
        idempotencyPrefix: `card:${cardMessageId}:goal:${goal}`,
        actor: 'human',
      });
      const pushTopicId = snapshot.worker?.topicId ?? topicId;
      if (pushTopicId) {
        await requireConfig().pushWorker?.({
          runId,
          workerId: snapshot.worker?.workerId,
          taskId: snapshot.task?.taskId,
          larkAppId: snapshot.worker?.larkAppId ?? larkAppId,
          topicId: pushTopicId,
          content: `Goal changed from the control card. Read BOTMUX_COLLAB_RUN_ID from the collab board, acknowledge the intervention receipt, and adjust your work.\n\nNew goal:\n${goal}`,
        });
      }
    } else if (action === 'collab_stop') {
      if (isTerminalStatus(snapshot.status)) {
        return { toast: { type: 'info', content: `Run already ${snapshot.status}` } };
      }
      await requestStop(board, {
        reason: 'Stopped from control card',
        idempotencyPrefix: `card:${cardMessageId}:stop`,
        actor: 'human',
      });
      await releaseCollabWorker(requireConfig().dataDir, runId);
    }
    return JSON.parse(await renderCard(board, localeForBot(larkAppId)));
  } catch (err) {
    logger.error(`[collab-control] card action failed: ${err}`);
    return { toast: { type: 'error', content: err instanceof Error ? err.message : String(err) } };
  }
}
