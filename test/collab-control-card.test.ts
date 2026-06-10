import { describe, it, expect } from 'vitest';
import { buildCollabControlCard } from '../src/im/lark/card-builder.js';
import type { BoardSnapshot, RunStatus } from '../src/collab/contract.js';

function snap(status: RunStatus, over: Partial<BoardSnapshot> = {}): BoardSnapshot {
  return {
    runId: 'collab_r1',
    revision: 7,
    status,
    goal: 'do the thing',
    acceptanceCriteria: { command: 'true', doneWhen: 'exitZero' },
    task: { taskId: 'task-1', title: 'T', spec: 'do the thing', status: 'in_progress', assignedWorkerId: 'w1' },
    worker: { workerId: 'w1', taskId: 'task-1', phase: 'running', larkAppId: 'cli_worker', topicId: 'ocworker1' },
    artifacts: [],
    progressLog: [],
    stall: null,
    budget: { limit: 20, unit: 'turns', spent: 1, remaining: 19, exhausted: false },
    interventions: [],
    controlTopicId: 'oc-control',
    ...over,
  };
}

function parse(s: string): any {
  return JSON.parse(s);
}

function hasGoalForm(card: any): boolean {
  return card.elements.some((e: any) => e.tag === 'form' && e.name === 'collab_goal_form');
}

function actionButtons(card: any): string[] {
  const action = card.elements.find((e: any) => e.tag === 'action');
  return (action?.actions ?? []).map((b: any) => b.value?.action).filter(Boolean);
}

describe('collab control card gating', () => {
  it('active run renders the goal form + Stop button', () => {
    const card = parse(buildCollabControlCard(snap('running')));
    expect(hasGoalForm(card)).toBe(true);
    expect(actionButtons(card)).toContain('collab_stop');
    expect(actionButtons(card)).toContain('collab_refresh');
  });

  it('terminal run drops the goal form and the Stop button (only Refresh stays)', () => {
    for (const status of ['succeeded', 'failed', 'stopped'] as RunStatus[]) {
      const card = parse(buildCollabControlCard(snap(status)));
      expect(hasGoalForm(card), `${status} must not render goal form`).toBe(false);
      expect(actionButtons(card), `${status} must not offer Stop`).not.toContain('collab_stop');
      expect(actionButtons(card)).toContain('collab_refresh');
    }
  });

  it('surfaces the worker topic anchor when set', () => {
    const card = parse(buildCollabControlCard(snap('running')));
    const body = card.elements.find((e: any) => e.tag === 'markdown').content;
    expect(body).toContain('@ocworker1');
  });

  it('surfaces an active stall state', () => {
    const card = parse(buildCollabControlCard(snap('running', {
      stall: { streak: 3, threshold: 3, raisedAtSeq: 12 },
    })));
    const body = card.elements.find((e: any) => e.tag === 'markdown').content;
    expect(body).toContain('**Stall**');
    expect(body).toContain('3 no-improvement checks');
  });
});
