import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  configureCollabControlPlane,
  handleCollabControlCardAction,
  handleCollabControlMessage,
  type PushCollabWorkerInput,
  type SpawnCollabWorkerInput,
} from '../src/core/control-plane.js';
import { openCollabBoard } from '../src/collab/index.js';
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

  it('handles control-card goal changes as typed events, delivered receipt, and worker push', async () => {
    await handleCollabControlMessage(rawTextEvent('/collab old goal', 'om_seed_goal'), ctx());
    const { runId, baseDir, workerId } = spawns[0];

    const card = await handleCollabControlCardAction({
      operator: { open_id: 'ou_human' },
      context: { open_message_id: 'om_card_goal' },
      action: {
        value: { action: 'collab_goal_change', run_id: runId },
        form_value: { goal: 'new goal from card' },
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
    expect(types.slice(-3)).toEqual([
      'GoalChangeRequested',
      'GoalChanged',
      'InterventionReceiptUpdated',
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
