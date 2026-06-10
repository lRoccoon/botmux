import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  configureCollabControlPlane,
  handleCollabControlCardAction,
  handleCollabControlMessage,
  handleCollabWorkerLost,
  type PushCollabWorkerInput,
  type SpawnCollabWorkerInput,
} from '../src/core/control-plane.js';
import { openCollabBoard } from '../src/collab/index.js';
import { addCollabWorker, readCollabWorkerPool } from '../src/collab/worker-pool-store.js';
import type { RoutingContext } from '../src/im/lark/event-dispatcher.js';

type Reply = { anchor: string; msgType?: string; larkAppId?: string; content: string };

function rawTextEvent(text: string, messageId: string) {
  return {
    sender: {
      sender_id: { open_id: 'ou_human' },
      sender_type: 'user',
    },
    message: {
      message_id: messageId,
      message_type: 'text',
      content: JSON.stringify({ text }),
      chat_id: 'oc_collab',
      chat_type: 'group',
      create_time: String(Date.now()),
    },
  };
}

function ctx(anchor = 'om_topic_root'): RoutingContext {
  return {
    chatId: 'oc_collab',
    messageId: 'om_msg',
    chatType: 'group',
    scope: 'thread',
    anchor,
    larkAppId: 'cli_control',
  };
}

describe('collab control-plane integration seam', () => {
  let dataDir: string;
  let replies: Reply[];
  let spawns: SpawnCollabWorkerInput[];
  let pushes: PushCollabWorkerInput[];

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'botmux-collab-control-'));
    replies = [];
    spawns = [];
    pushes = [];
    configureCollabControlPlane({
      dataDir,
      reply: async (anchor, content, msgType, larkAppId) => {
        replies.push({ anchor, content, msgType, larkAppId });
        return `om_reply_${replies.length}`;
      },
      spawnWorker: async (input) => {
        spawns.push(input);
      },
      pushWorker: async (input) => {
        pushes.push(input);
      },
    });
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('creates a run from a control topic and spawns one collab worker with board env context', async () => {
    await handleCollabControlMessage(
      rawTextEvent('/collab reduce failing count to zero | test: test -f done.txt', 'om_seed'),
      ctx(),
    );

    expect(spawns).toHaveLength(1);
    expect(spawns[0]).toMatchObject({
      larkAppId: 'cli_control',
      chatId: 'oc_collab',
      topicId: 'om_topic_root',
      taskId: 'task-1',
      workerId: `${spawns[0].runId}-worker-1`,
      baseDir: join(dataDir, 'collab-runs'),
      goal: 'reduce failing count to zero',
      ownerOpenId: 'ou_human',
    });
    expect(spawns[0].prompt).toContain('Collab worker protocol');
    expect(spawns[0].prompt).toContain('botmux collab snapshot');

    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ anchor: 'om_topic_root', msgType: 'interactive', larkAppId: 'cli_control' });

    const board = openCollabBoard(spawns[0].runId, { baseDir: spawns[0].baseDir });
    const snapshot = await board.snapshot();
    expect(snapshot.goal).toBe('reduce failing count to zero');
    expect(snapshot.acceptanceCriteria).toMatchObject({
      command: 'test -f done.txt',
      doneWhen: 'exitZero',
    });
    expect(snapshot.status).toBe('running');
    expect(snapshot.task).toMatchObject({
      taskId: 'task-1',
      assignedWorkerId: spawns[0].workerId,
      status: 'open',
    });
    expect(snapshot.worker).toMatchObject({
      workerId: spawns[0].workerId,
      taskId: 'task-1',
      phase: 'running',
    });

    const types = (await board.history()).map((e) => e.type);
    expect(types).toEqual([
      'RunCreated',
      'TaskCreated',
      'WorkerAllocated',
      'TaskAssigned',
      'WorkerTurnStarted',
    ]);

    const index = JSON.parse(readFileSync(join(dataDir, 'collab/control-topic-index.json'), 'utf-8'));
    expect(index.topics['cli_control::om_topic_root']).toBe(spawns[0].runId);
  });

  it('leases a pooled collab-worker identity and writes its route into WorkerAllocated', async () => {
    await addCollabWorker(dataDir, {
      id: 'coder-1',
      larkAppId: 'worker_app',
      label: 'Coder 1',
      cliId: 'codex',
    });

    await handleCollabControlMessage(rawTextEvent('/collab use pool | test: test -f done.txt', 'om_seed_pool'), ctx());

    expect(spawns).toHaveLength(1);
    expect(spawns[0]).toMatchObject({
      larkAppId: 'worker_app',
      chatId: 'oc_collab',
      topicId: 'om_topic_root',
      workerId: 'coder-1',
      taskId: 'task-1',
    });

    const board = openCollabBoard(spawns[0].runId, { baseDir: spawns[0].baseDir });
    const snapshot = await board.snapshot();
    expect(snapshot.worker).toMatchObject({
      workerId: 'coder-1',
      larkAppId: 'worker_app',
      topicId: 'om_topic_root',
      phase: 'running',
    });

    let pool = readCollabWorkerPool(dataDir);
    expect(pool.workers[0]).toMatchObject({ id: 'coder-1', status: 'leased', leasedBy: spawns[0].runId });

    await handleCollabControlCardAction({
      operator: { open_id: 'ou_human' },
      context: { open_message_id: 'om_card_stop_pool' },
      action: {
        value: { action: 'collab_stop', run_id: spawns[0].runId },
      },
    }, 'cli_control');

    pool = readCollabWorkerPool(dataDir);
    expect(pool.workers[0]).toMatchObject({ id: 'coder-1', status: 'available' });
    expect(pool.workers[0].leasedBy).toBeUndefined();
  });

  it('reallocates a lost pooled worker by respawning the same lease from the board', async () => {
    await addCollabWorker(dataDir, {
      id: 'coder-1',
      larkAppId: 'worker_app',
      label: 'Coder 1',
      cliId: 'codex',
    });
    await handleCollabControlMessage(rawTextEvent('/collab resume after kill | test: test -f done.txt', 'om_seed_realloc'), ctx());
    const first = spawns[0];

    const result = await handleCollabWorkerLost({
      runId: first.runId,
      workerId: first.workerId,
      taskId: first.taskId,
      baseDir: first.baseDir,
      larkAppId: first.larkAppId,
      chatId: first.chatId,
      topicId: first.topicId,
      ownerOpenId: first.ownerOpenId,
      sessionId: 'sess-worker-1',
      workerPid: 12345,
      exitCode: null,
      signal: 'SIGKILL',
    });

    expect(result).toBe('reallocated');
    expect(spawns).toHaveLength(2);
    expect(spawns[1]).toMatchObject({
      runId: first.runId,
      workerId: 'coder-1',
      larkAppId: 'worker_app',
      chatId: 'oc_collab',
      topicId: 'om_topic_root',
      taskId: 'task-1',
    });
    expect(spawns[1].prompt).toContain('Previous worker coder-1 was lost');
    expect(spawns[1].prompt).toContain('botmux collab snapshot');

    const board = openCollabBoard(first.runId, { baseDir: first.baseDir });
    const snapshot = await board.snapshot();
    expect(snapshot.status).toBe('running');
    expect(snapshot.worker).toMatchObject({ workerId: 'coder-1', phase: 'running' });
    expect(snapshot.task).toMatchObject({ assignedWorkerId: 'coder-1' });
    const types = (await board.history()).map((e) => e.type);
    expect(types.slice(-4)).toEqual([
      'WorkerLost',
      'WorkerAllocated',
      'TaskAssigned',
      'WorkerTurnStarted',
    ]);
    const pool = readCollabWorkerPool(dataDir);
    expect(pool.workers[0]).toMatchObject({ id: 'coder-1', status: 'leased', leasedBy: first.runId });
  });

  it('records watchdog-detected worker loss distinctly', async () => {
    await addCollabWorker(dataDir, {
      id: 'coder-1',
      larkAppId: 'worker_app',
      label: 'Coder 1',
      cliId: 'codex',
    });
    await handleCollabControlMessage(rawTextEvent('/collab watchdog recovery | test: test -f done.txt', 'om_seed_watchdog'), ctx('om_watchdog'));
    const first = spawns[0];

    const result = await handleCollabWorkerLost({
      runId: first.runId,
      workerId: first.workerId,
      taskId: first.taskId,
      baseDir: first.baseDir,
      larkAppId: first.larkAppId,
      chatId: first.chatId,
      topicId: first.topicId,
      sessionId: 'sess-watchdog',
      workerPid: 444,
      exitCode: null,
      signal: null,
      detectedBy: 'watchdog',
      reason: 'lease watchdog found no live worker during test',
    });

    expect(result).toBe('reallocated');
    const board = openCollabBoard(first.runId, { baseDir: first.baseDir });
    const lost = (await board.history()).find((e) => e.type === 'WorkerLost');
    expect(lost?.payload).toMatchObject({
      workerId: 'coder-1',
      detectedBy: 'watchdog',
      reason: 'lease watchdog found no live worker during test',
    });
  });

  it('fails fast instead of orphaning a run when the worker pool is exhausted', async () => {
    await addCollabWorker(dataDir, {
      id: 'coder-1',
      larkAppId: 'worker_app',
      label: 'Coder 1',
      cliId: 'codex',
    });
    await handleCollabControlMessage(rawTextEvent('/collab occupy pool | test: test -f done.txt', 'om_seed_occupy'), ctx('om_pool_a'));
    expect(spawns).toHaveLength(1);

    await handleCollabControlMessage(rawTextEvent('/collab no worker left | test: test -f done.txt', 'om_seed_exhausted'), ctx('om_pool_b'));

    expect(spawns).toHaveLength(1);
    const index = JSON.parse(readFileSync(join(dataDir, 'collab/control-topic-index.json'), 'utf-8'));
    const runId = index.topics['cli_control::om_pool_b'];
    const board = openCollabBoard(runId, { baseDir: join(dataDir, 'collab-runs') });
    const snapshot = await board.snapshot();
    expect(snapshot.status).toBe('failed');
    expect(snapshot.worker).toBeNull();
    const types = (await board.history()).map((e) => e.type);
    expect(types.slice(-1)).toEqual(['RunFinished']);
    expect(replies.at(-1)).toMatchObject({ anchor: 'om_pool_b', msgType: 'interactive' });
  });

  it('fails the run instead of reallocating past the crash-loop cap', async () => {
    configureCollabControlPlane({
      dataDir,
      reply: async (anchor, content, msgType, larkAppId) => {
        replies.push({ anchor, content, msgType, larkAppId });
        return `om_reply_${replies.length}`;
      },
      spawnWorker: async (input) => {
        spawns.push(input);
      },
      pushWorker: async (input) => {
        pushes.push(input);
      },
      maxWorkerReallocations: 0,
    });
    await handleCollabControlMessage(rawTextEvent('/collab cap recovery | test: test -f done.txt', 'om_seed_cap'), ctx('om_cap_topic'));
    const first = spawns[0];

    const result = await handleCollabWorkerLost({
      runId: first.runId,
      workerId: first.workerId,
      taskId: first.taskId,
      baseDir: first.baseDir,
      larkAppId: first.larkAppId,
      chatId: first.chatId,
      topicId: first.topicId,
      sessionId: 'sess-cap',
      workerPid: 222,
      exitCode: 1,
      signal: null,
    });

    expect(result).toBe('failed');
    expect(spawns).toHaveLength(1);
    const board = openCollabBoard(first.runId, { baseDir: first.baseDir });
    const snapshot = await board.snapshot();
    expect(snapshot.status).toBe('failed');
    const types = (await board.history()).map((e) => e.type);
    expect(types.slice(-2)).toEqual(['WorkerLost', 'RunFinished']);
  });

  it('fails and releases the lease when worker respawn itself fails', async () => {
    await addCollabWorker(dataDir, {
      id: 'coder-1',
      larkAppId: 'worker_app',
      label: 'Coder 1',
      cliId: 'codex',
    });
    await handleCollabControlMessage(rawTextEvent('/collab respawn failure | test: test -f done.txt', 'om_seed_respawn_fail'), ctx('om_respawn_fail'));
    const first = spawns[0];
    configureCollabControlPlane({
      dataDir,
      reply: async (anchor, content, msgType, larkAppId) => {
        replies.push({ anchor, content, msgType, larkAppId });
        return `om_reply_${replies.length}`;
      },
      spawnWorker: async () => {
        throw new Error('spawn unavailable');
      },
      pushWorker: async (input) => {
        pushes.push(input);
      },
    });

    const result = await handleCollabWorkerLost({
      runId: first.runId,
      workerId: first.workerId,
      taskId: first.taskId,
      baseDir: first.baseDir,
      larkAppId: first.larkAppId,
      chatId: first.chatId,
      topicId: first.topicId,
      sessionId: 'sess-respawn-fail',
      workerPid: 333,
      exitCode: 1,
      signal: null,
    });

    expect(result).toBe('failed');
    const board = openCollabBoard(first.runId, { baseDir: first.baseDir });
    const snapshot = await board.snapshot();
    expect(snapshot.status).toBe('failed');
    const types = (await board.history()).map((e) => e.type);
    expect(types.slice(-4)).toEqual([
      'WorkerLost',
      'WorkerAllocated',
      'TaskAssigned',
      'RunFinished',
    ]);
    const pool = readCollabWorkerPool(dataDir);
    expect(pool.workers[0]).toMatchObject({ id: 'coder-1', status: 'available' });
    expect(pool.workers[0].leasedBy).toBeUndefined();
  });

  it('handles control-card goal changes as typed events, delivered receipt, and worker push', async () => {
    await handleCollabControlMessage(rawTextEvent('/collab old goal', 'om_seed_goal'), ctx());
    const { runId, baseDir, workerId } = spawns[0];

    const card = await handleCollabControlCardAction({
      operator: { open_id: 'ou_human' },
      context: { open_message_id: 'om_card_goal' },
      action: {
        value: { action: 'collab_goal_change', run_id: runId },
        form_value: { goal: '/goal new goal from card' },
      },
    }, 'cli_control');

    expect(card?.header?.title?.content).toBe('Collab control');
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({
      runId,
      workerId,
      taskId: 'task-1',
      larkAppId: 'cli_control',
      topicId: 'om_topic_root',
    });
    expect(pushes[0].content).toContain('new goal from card');

    const board = openCollabBoard(runId, { baseDir });
    const snapshot = await board.snapshot();
    expect(snapshot.goal).toBe('new goal from card');
    expect(snapshot.interventions).toHaveLength(1);
    expect(snapshot.interventions[0]).toMatchObject({
      kind: 'goal-change',
      receipt: 'delivered',
      payload: { proposedGoal: 'new goal from card' },
    });

    const types = (await board.history()).map((e) => e.type);
    expect(types.slice(-4)).toEqual([
      'GoalChangeRequested',
      'GoalChanged',
      'InterventionReceiptUpdated',
      'WorkerTurnStarted',
    ]);
  });

  it('handles criteria changes as typed events and worker push', async () => {
    await handleCollabControlMessage(rawTextEvent('/collab old criteria | test: test -f old.txt', 'om_seed_criteria'), ctx('om_criteria_topic'));
    const { runId, baseDir, workerId } = spawns[0];

    await handleCollabControlMessage(
      rawTextEvent('/criteria test -f done.txt', 'om_change_criteria'),
      ctx('om_criteria_topic'),
    );

    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({
      runId,
      workerId,
      taskId: 'task-1',
      larkAppId: 'cli_control',
      topicId: 'om_criteria_topic',
    });
    expect(pushes[0].content).toContain('Acceptance criteria changed');
    expect(pushes[0].content).toContain('test -f done.txt');

    const board = openCollabBoard(runId, { baseDir });
    const snapshot = await board.snapshot();
    expect(snapshot.acceptanceCriteria).toMatchObject({
      command: 'test -f done.txt',
      doneWhen: 'exitZero',
    });

    const types = (await board.history()).map((e) => e.type);
    expect(types.slice(-3)).toEqual([
      'AcceptanceCriteriaChanged',
      'InterventionReceiptUpdated',
      'WorkerTurnStarted',
    ]);
  });

  it('handles stop actions as typed events and terminal control card state', async () => {
    await handleCollabControlMessage(rawTextEvent('/collab stop me later', 'om_seed_stop'), ctx('om_stop_topic'));
    const { runId, baseDir } = spawns[0];

    const card = await handleCollabControlCardAction({
      operator: { open_id: 'ou_human' },
      context: { open_message_id: 'om_card_stop' },
      action: {
        value: { action: 'collab_stop', run_id: runId },
      },
    }, 'cli_control');

    expect(card?.header?.template).toBe('grey');
    expect(pushes).toHaveLength(0);

    const board = openCollabBoard(runId, { baseDir });
    const snapshot = await board.snapshot();
    expect(snapshot.status).toBe('stopped');
    expect(snapshot.interventions).toHaveLength(1);
    expect(snapshot.interventions[0]).toMatchObject({
      kind: 'stop',
      receipt: 'delivered',
    });

    const types = (await board.history()).map((e) => e.type);
    expect(types.slice(-3)).toEqual([
      'StopRequested',
      'RunFinished',
      'InterventionReceiptUpdated',
    ]);
  });
});
