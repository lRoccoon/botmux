/**
 * In-memory broker for `botmux ask` (v0.1.7).
 *
 * Holds the pending-ask registry, runs the deadline timers, and arbitrates
 * click resolution. IM-agnostic: the im/lark side wires a dispatcher via
 * `setCardDispatcher` so the broker doesn't import Lark types.
 *
 * §3 / §6 / §7 / §8 of /tmp/botmux-ask.md.
 */

import { randomUUID } from 'node:crypto';

import { logger } from '../utils/logger.js';
import type {
  AskCardDispatcher,
  AskClickOutcome,
  AskResult,
  CreateAskInput,
  PendingAsk,
} from './ask-types.js';

interface InternalPending extends PendingAsk {
  resolve: (result: AskResult) => void;
  timeoutHandle: NodeJS.Timeout;
}

const pending = new Map<string, InternalPending>();
let dispatcher: AskCardDispatcher | null = null;

/** Wire the IM-side dispatcher. Called once during daemon bootstrap from
 *  daemon.ts after im/lark/ask-card.ts is constructed. */
export function setCardDispatcher(d: AskCardDispatcher): void {
  dispatcher = d;
}

/** Register a new pending ask. Returns a Promise that settles when:
 *   - a valid click arrives (`kind:'answered'`)
 *   - the deadline elapses (`kind:'timedOut'`)
 *   - the broker invalidates the ask (`kind:'invalidated'`)
 *
 *  Side effects:
 *   - generates askId + nonce
 *   - starts the deadline timer
 *   - dispatches the card; if the card send fails, the ask is immediately
 *     invalidated and the Promise settles with `kind:'invalidated'`.
 *
 *  Throws synchronously only if no dispatcher has been wired — that's a
 *  daemon-misconfiguration bug, not a runtime ask failure.
 */
export function registerAsk(input: CreateAskInput): Promise<AskResult> {
  if (!dispatcher) {
    throw new Error('ask-broker: cardDispatcher not wired — daemon bootstrap bug');
  }

  const askId = randomUUID();
  const nonce = randomUUID().slice(0, 8);
  const createdAt = Date.now();
  const deadlineAt = createdAt + input.timeoutMs;

  return new Promise<AskResult>((resolve) => {
    const timeoutHandle = setTimeout(() => {
      settle(askId, {
        kind: 'timedOut',
        selected: null,
        by: null,
        comment: null,
        timedOut: true,
      });
    }, input.timeoutMs);
    // Don't keep the event loop alive just because an ask is pending.
    timeoutHandle.unref?.();

    const ask: InternalPending = {
      askId,
      nonce,
      larkAppId: input.larkAppId,
      chatId: input.chatId,
      rootMessageId: input.rootMessageId,
      sessionId: input.sessionId,
      approvers: input.approvers,
      options: input.options,
      prompt: input.prompt,
      createdAt,
      deadlineAt,
      settled: false,
      resolve,
      timeoutHandle,
    };
    pending.set(askId, ask);

    // Card dispatch is async — store the messageId once it lands.
    void dispatcher!
      .send(snapshot(ask))
      .then(({ messageId }) => {
        const cur = pending.get(askId);
        if (cur && !cur.settled) cur.cardMessageId = messageId;
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn?.(`ask-broker: ${askId} card dispatch failed: ${msg}`);
        settle(askId, {
          kind: 'invalidated',
          reason: `card dispatch failed: ${msg}`,
          selected: null,
          by: null,
          comment: null,
          timedOut: false,
        });
      });
  });
}

/** Resolve attempt from a card-button click. Returns one of the §10 outcomes;
 *  caller (card click handler) maps to user-facing toast.
 *
 *  All four "no-op" outcomes (`unauthorized`/`stale`/`already_settled`) leave
 *  the broker state unchanged so the original CLI Promise keeps waiting for
 *  the real winner or the deadline. */
export function tryResolveAsk(args: {
  askId: string;
  nonce: string;
  selected: string;
  by: string;
}): AskClickOutcome {
  const ask = pending.get(args.askId);
  if (!ask) return 'stale';                       // unknown id (daemon restart, GC'd, etc.)
  if (ask.nonce !== args.nonce) return 'stale';   // replayed click from a previous card
  if (ask.settled) return 'already_settled';      // race loser
  if (!ask.approvers.has(args.by)) return 'unauthorized';
  if (!ask.options.some((o) => o.key === args.selected)) return 'stale';

  settle(args.askId, {
    kind: 'answered',
    selected: args.selected,
    by: args.by,
    comment: null,
    timedOut: false,
  });
  return 'accepted';
}

/** Invalidate every pending ask. Intended for daemon shutdown / restart paths
 *  so CLI subprocesses unblock with `kind:'invalidated'` instead of waiting
 *  forever on a dead daemon. */
export function invalidateAll(reason: string): number {
  const ids = [...pending.keys()];
  for (const id of ids) {
    settle(id, {
      kind: 'invalidated',
      reason,
      selected: null,
      by: null,
      comment: null,
      timedOut: false,
    });
  }
  if (ids.length > 0) {
    logger.info?.(`ask-broker: invalidated ${ids.length} pending ask(s): ${reason}`);
  }
  return ids.length;
}

/** Internal — settle an ask exactly once and notify the dispatcher's onSettle
 *  hook (best-effort, never blocks broker state transitions). */
function settle(askId: string, result: AskResult): void {
  const ask = pending.get(askId);
  if (!ask || ask.settled) return;
  ask.settled = true;
  clearTimeout(ask.timeoutHandle);
  pending.delete(askId);

  try {
    ask.resolve(result);
  } catch (err) {
    logger.warn?.(
      `ask-broker: ${askId} resolve threw: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (dispatcher?.onSettle) {
    try {
      void Promise.resolve(dispatcher.onSettle(snapshot(ask), result)).catch((err) => {
        logger.warn?.(
          `ask-broker: ${askId} onSettle failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    } catch (err) {
      logger.warn?.(
        `ask-broker: ${askId} onSettle threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/** Strip broker-internal fields before handing a snapshot to the IM-side
 *  dispatcher. Keeps the dispatcher contract narrow. */
function snapshot(ask: InternalPending): PendingAsk {
  const { resolve: _r, timeoutHandle: _t, ...rest } = ask;
  return rest;
}

// ---- diagnostics for tests ---------------------------------------------------

/** Pending ask count — for tests and metrics. Not part of the public API. */
export function _pendingCount(): number {
  return pending.size;
}

/** Read a pending ask by id — for tests only. Returns a snapshot; mutating it
 *  has no effect on broker state. */
export function _getPending(askId: string): PendingAsk | undefined {
  const a = pending.get(askId);
  return a ? snapshot(a) : undefined;
}

/** Reset broker state — for tests only. Does NOT resolve outstanding promises,
 *  so tests must not call this while real CLI processes might be waiting. */
export function _resetForTest(): void {
  for (const ask of pending.values()) clearTimeout(ask.timeoutHandle);
  pending.clear();
  dispatcher = null;
}
