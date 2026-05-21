import { describe, it, expect } from 'vitest';

import {
  buildWorkflowProgressCard,
  buildWorkflowStartingCard,
  type WorkflowProgressCardTerminalLink,
} from '../src/im/lark/workflow-progress-card.js';
import type { Snapshot } from '../src/workflows/events/replay.js';

function emptySnapshot(over: Partial<Snapshot['run']> = {}): Snapshot {
  return {
    run: {
      runId: 'run-x',
      status: 'pending',
      workflowId: 'wf-demo',
      ...over,
    },
    nodes: new Map(),
    activities: new Map(),
    outputs: new Map(),
    lastSeq: 0,
    danglingActivities: [],
    danglingEffectAttempted: [],
  } as unknown as Snapshot;
}

describe('workflow-progress-card', () => {
  it('starting card contains runId + workflowId + ⏳ starting badge', () => {
    const json = buildWorkflowStartingCard({
      runId: 'run-1234567890-abcdef',
      workflowId: 'cancel-dogfood',
    });
    expect(json).toContain('cancel-dogfood');
    expect(json).toContain('run-1234567890');
    expect(json).toContain('⏳ starting');
    // Detail button must always be present.
    expect(json).toContain('Web 详情');
  });

  it('running card shows the 🏃 progress section listing parallel nodes', () => {
    const snap = emptySnapshot({ status: 'running' });
    snap.nodes.set('root', { nodeId: 'root', status: 'succeeded', retryCount: 0, activityId: 'run-x::work::root' });
    snap.nodes.set('branch_x', { nodeId: 'branch_x', status: 'running', retryCount: 0, activityId: 'run-x::work::branch_x' });
    snap.nodes.set('branch_y', { nodeId: 'branch_y', status: 'running', retryCount: 0, activityId: 'run-x::work::branch_y' });
    snap.nodes.set('join', { nodeId: 'join', status: 'idle', retryCount: 0 });
    snap.activities.set('run-x::work::branch_x', {
      activityId: 'run-x::work::branch_x',
      attempts: [],
      status: 'running',
      currentAttemptId: 'run-x::work::branch_x::1',
      ownerNodeId: 'branch_x',
    });
    snap.activities.set('run-x::work::branch_y', {
      activityId: 'run-x::work::branch_y',
      attempts: [],
      status: 'running',
      currentAttemptId: 'run-x::work::branch_y::1',
      ownerNodeId: 'branch_y',
    });

    const json = buildWorkflowProgressCard(snap);
    const parsed = JSON.parse(json);
    expect(parsed.header.template).toBe('blue');
    expect(parsed.header.title.content).toContain('🔄');
    expect(json).toContain('🏃 进行中** (2)');
    // nodeIds contain `_` which the card escapes for lark_md italics safety.
    // Walk parsed elements so we don't have to count JSON backslashes.
    const allText = parsed.elements
      .flatMap((el: any) => [el?.text?.content, ...(el?.fields ?? []).map((f: any) => f?.text?.content)])
      .filter(Boolean)
      .join('\n');
    expect(allText).toMatch(/branch.+x/);
    expect(allText).toMatch(/branch.+y/);
    expect(json).toContain('1 / 4');
  });

  it('waiting card shows the ⏸ 等待审批 section with orange template', () => {
    const snap = emptySnapshot({ status: 'waiting' });
    snap.nodes.set('finalize', {
      nodeId: 'finalize',
      status: 'waiting',
      retryCount: 0,
      activityId: 'run-x::work::finalize',
    });
    snap.activities.set('run-x::work::finalize', {
      activityId: 'run-x::work::finalize',
      attempts: [],
      status: 'waiting',
      currentAttemptId: 'run-x::work::finalize::1',
      ownerNodeId: 'finalize',
    });

    const json = buildWorkflowProgressCard(snap);
    const parsed = JSON.parse(json);
    expect(parsed.header.template).toBe('orange');
    expect(json).toContain('⏸ 等待审批');
    expect(json).toContain('finalize');
  });

  it('failed run renders failure summary + red template', () => {
    const snap = emptySnapshot({
      status: 'failed',
      failedNodeId: 'analyze',
      rootCauseEventId: 'run-x-4',
    });
    snap.nodes.set('analyze', { nodeId: 'analyze', status: 'failed', retryCount: 0 });
    const json = buildWorkflowProgressCard(snap);
    const parsed = JSON.parse(json);
    expect(parsed.header.template).toBe('red');
    expect(json).toContain('💥 失败摘要');
    expect(json).toContain('analyze');
  });

  it('cancelled run renders cancel origin + grey template', () => {
    const snap = emptySnapshot({
      status: 'cancelled',
      cancelOriginEventId: 'run-x-9',
    });
    snap.nodes.set('only', { nodeId: 'only', status: 'cancelled', retryCount: 0 });
    const json = buildWorkflowProgressCard(snap);
    const parsed = JSON.parse(json);
    expect(parsed.header.template).toBe('grey');
    expect(json).toContain('🛑 已取消');
  });

  it('succeeded run has green template + no progress/waiting sections', () => {
    const snap = emptySnapshot({ status: 'succeeded' });
    snap.nodes.set('a', { nodeId: 'a', status: 'succeeded', retryCount: 0 });
    snap.nodes.set('b', { nodeId: 'b', status: 'succeeded', retryCount: 0 });
    const json = buildWorkflowProgressCard(snap);
    const parsed = JSON.parse(json);
    expect(parsed.header.template).toBe('green');
    expect(json).not.toContain('🏃 进行中');
    expect(json).not.toContain('⏸ 等待审批');
    expect(json).toContain('2 / 2');
  });

  it('enrichWithTerminalLink hook adds link when defined, omits when undefined', () => {
    const snap = emptySnapshot({ status: 'running' });
    snap.nodes.set('only', {
      nodeId: 'only',
      status: 'running',
      retryCount: 0,
      activityId: 'run-x::work::only',
    });
    snap.activities.set('run-x::work::only', {
      activityId: 'run-x::work::only',
      attempts: [],
      status: 'running',
      currentAttemptId: 'run-x::work::only::1',
      ownerNodeId: 'only',
    });
    const calls: Array<[string, string]> = [];
    const hook = (activityId: string, attemptId: string): WorkflowProgressCardTerminalLink | undefined => {
      calls.push([activityId, attemptId]);
      return { kind: 'live-terminal', url: 'http://dash/term/abc' };
    };
    const json = buildWorkflowProgressCard(snap, { enrichWithTerminalLink: hook });
    expect(calls).toEqual([['run-x::work::only', 'run-x::work::only::1']]);
    expect(json).toContain('查看当前终端');
    expect(json).toContain('http://dash/term/abc');
  });

  it('enrichWithTerminalLink throwing does not crash the build (codex boundary 1)', () => {
    const snap = emptySnapshot({ status: 'running' });
    snap.nodes.set('only', {
      nodeId: 'only',
      status: 'running',
      retryCount: 0,
      activityId: 'run-x::work::only',
    });
    snap.activities.set('run-x::work::only', {
      activityId: 'run-x::work::only',
      attempts: [],
      status: 'running',
      currentAttemptId: 'run-x::work::only::1',
      ownerNodeId: 'only',
    });
    const json = buildWorkflowProgressCard(snap, {
      enrichWithTerminalLink: () => {
        throw new Error('codex slice 2 not ready');
      },
    });
    // Renders without the link rather than throwing.
    expect(json).toContain('only');
    expect(json).not.toContain('查看当前终端');
    expect(json).not.toContain('查看执行日志');
  });

  it('inline rows cap at maxInlineRows with "+N more" trailer', () => {
    const snap = emptySnapshot({ status: 'running' });
    for (let i = 0; i < 10; i++) {
      const id = `n${i}`;
      snap.nodes.set(id, {
        nodeId: id,
        status: 'running',
        retryCount: 0,
        activityId: `run-x::work::${id}`,
      });
      snap.activities.set(`run-x::work::${id}`, {
        activityId: `run-x::work::${id}`,
        attempts: [],
        status: 'running',
        ownerNodeId: id,
      });
    }
    const json = buildWorkflowProgressCard(snap, { maxInlineRows: 4 });
    expect(json).toContain('🏃 进行中** (10)');
    expect(json).toContain('+6 more');
  });
});
