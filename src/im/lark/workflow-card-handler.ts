import { logger } from '../../utils/logger.js';
import { loadFrozenCards, saveFrozenCards } from '../../services/frozen-card-store.js';
import { EventLog } from '../../workflows/events/append.js';
import { getRunsDir } from '../../workflows/runs-dir.js';
import {
  resolveWait,
  type ResolveWaitInput,
  type ResolveWaitResult,
} from '../../workflows/wait.js';
import {
  requestCancel,
  type RequestCancelInput,
} from '../../workflows/cancel.js';
import type { CancelRequestedEvent } from '../../workflows/events/types.js';
import type { FrozenCard } from '../../core/types.js';
import {
  WORKFLOW_APPROVE_ACTION,
  WORKFLOW_CANCEL_ACTION,
  WORKFLOW_COMMENT_FIELD,
  WORKFLOW_REJECT_ACTION,
} from './workflow-cards.js';

export type WorkflowCardActionData = {
  operator?: { open_id?: string };
  action?: {
    value?: Record<string, string>;
    form_value?: Record<string, string>;
  };
  context?: { open_message_id?: string };
  open_message_id?: string;
};

export type WorkflowApprovalHandlerDeps = {
  runsDir?: string;
  makeEventLog?: (runId: string, runsDir: string) => EventLog;
  resolveWaitFn?: (log: EventLog, input: ResolveWaitInput) => Promise<ResolveWaitResult>;
  requestCancelFn?: (
    log: EventLog,
    input: RequestCancelInput,
    actor: 'human',
  ) => Promise<CancelRequestedEvent>;
  loadFrozenCardsFn?: (storeId: string) => Map<string, FrozenCard>;
  saveFrozenCardsFn?: (storeId: string, cards: Map<string, FrozenCard>) => void;
};

export type WorkflowApprovalHandlerResult =
  | { ok: true; duplicate: true; cardNonce: string }
  | {
      ok: true;
      duplicate: false;
      cardNonce: string;
      result: ResolveWaitResult | CancelRequestedEvent;
    };

export function isWorkflowApprovalAction(action?: string): boolean {
  return (
    action === WORKFLOW_APPROVE_ACTION ||
    action === WORKFLOW_REJECT_ACTION ||
    action === WORKFLOW_CANCEL_ACTION
  );
}

export function workflowRunsDir(): string {
  return getRunsDir();
}

export function workflowFrozenStoreId(runId: string): string {
  return `workflow-${runId.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
}

export async function handleWorkflowApprovalAction(
  data: WorkflowCardActionData,
  deps: WorkflowApprovalHandlerDeps = {},
): Promise<WorkflowApprovalHandlerResult | undefined> {
  const value = data.action?.value;
  const action = value?.action;
  if (!isWorkflowApprovalAction(action)) return undefined;

  const runId = requiredValue(value, 'run_id');
  const activityId = requiredValue(value, 'activity_id');
  const attemptId = requiredValue(value, 'attempt_id');
  const cardNonce = requiredValue(value, 'card_nonce');
  const by = data.operator?.open_id;
  if (!by) throw new Error('workflow approval action missing operator.open_id');

  const storeId = workflowFrozenStoreId(runId);
  const loadCards = deps.loadFrozenCardsFn ?? loadFrozenCards;
  const saveCards = deps.saveFrozenCardsFn ?? saveFrozenCards;
  const frozenCards = loadCards(storeId);
  if (frozenCards.has(cardNonce)) {
    logger.info(`[workflow:${runId}] duplicate approval card click ignored: ${cardNonce}`);
    return { ok: true, duplicate: true, cardNonce };
  }

  const runsDir = deps.runsDir ?? workflowRunsDir();
  const makeEventLog = deps.makeEventLog ?? ((rid, base) => new EventLog(rid, base));
  const log = makeEventLog(runId, runsDir);
  const comment = cleanComment(data.action?.form_value?.[WORKFLOW_COMMENT_FIELD]);
  const result =
    action === WORKFLOW_CANCEL_ACTION
      ? await (deps.requestCancelFn ?? requestCancel)(
          log,
          {
            target: { kind: 'run', runId },
            reason: cancelReason(comment),
            by,
          },
          'human',
        )
      : await (deps.resolveWaitFn ?? resolveWait)(log, {
          activityId,
          attemptId,
          resolution: action === WORKFLOW_APPROVE_ACTION ? 'approved' : 'rejected',
          by,
          comment,
        });

  frozenCards.set(cardNonce, {
    messageId: data.context?.open_message_id ?? data.open_message_id ?? '',
    title: `workflow approval ${runId}/${activityId}`,
    content: JSON.stringify({
      runId,
      activityId,
      attemptId,
      resolution:
        action === WORKFLOW_APPROVE_ACTION
          ? 'approved'
          : action === WORKFLOW_REJECT_ACTION
            ? 'rejected'
            : 'cancelled',
      by,
      ...(comment ? { comment } : {}),
    }),
  });
  saveCards(storeId, frozenCards);
  if (action === WORKFLOW_CANCEL_ACTION) {
    logger.info(`[workflow:${runId}] run cancel requested from approval card by ${by}`);
  } else {
    logger.info(`[workflow:${runId}] wait ${activityId}/${attemptId} resolved by ${by}`);
  }

  return { ok: true, duplicate: false, cardNonce, result };
}

function requiredValue(value: Record<string, string> | undefined, key: string): string {
  const v = value?.[key];
  if (!v) throw new Error(`workflow approval action missing ${key}`);
  return v;
}

function cleanComment(s: string | undefined): string | undefined {
  const trimmed = s?.trim();
  return trimmed ? trimmed : undefined;
}

function cancelReason(comment: string | undefined): string {
  return comment ? `cancelled from approval card: ${comment}` : 'cancelled from approval card';
}
