/**
 * Public types for `botmux ask` (v0.1.7).
 *
 * See `/tmp/botmux-ask.md` for the full design. This module is import-safe for
 * both the daemon side (broker, card builder, click handler) and the CLI side
 * (`botmux ask buttons` subcommand) — no runtime cross-imports.
 */

/** A single selectable option on an ask card. `key` is the stable identifier
 *  returned via stdout; `label` is the human-facing button text. When the user
 *  writes `--options "yes,no"`, `key === label`. With `--options "yes=继续"`,
 *  `key="yes"` and `label="继续"`. */
export interface AskOption {
  key: string;
  label: string;
}

/** Terminal result of an ask, returned to the CLI caller. Discriminated by
 *  `kind` so the CLI can map straight to stdout shape + exit code. */
export type AskResult =
  | {
      kind: 'answered';
      selected: string;
      by: string;
      comment: null;
      timedOut: false;
    }
  | {
      kind: 'timedOut';
      selected: null;
      by: null;
      comment: null;
      timedOut: true;
    }
  | {
      kind: 'invalidated';
      reason: string;
      selected: null;
      by: null;
      comment: null;
      timedOut: false;
    };

/** JSON envelope emitted by `botmux ask buttons --json`. Keeps `comment` as a
 *  forward-compat `null` slot — v0.1.8 may flip it to `string`. */
export interface AskJsonOutput {
  selected: string | null;
  by: string | null;
  comment: null;
  timedOut: boolean;
}

/** Input accepted by broker.registerAsk. Caller (CLI subcommand → daemon IPC
 *  handler) is responsible for env validation, parameter parsing, and resolving
 *  the approver allowlist before reaching the broker. */
export interface CreateAskInput {
  larkAppId: string;
  chatId: string;
  /** thread-scope ask → root message_id; chat-scope ask → null. */
  rootMessageId: string | null;
  /** Session that issued the ask — used for audit + future replay scoping. */
  sessionId: string;
  /** Pre-resolved open_id allowlist. Empty set means no one can answer; the
   *  caller (not the broker) must enforce the §6 approver fallback chain so the
   *  broker stays IM-agnostic. */
  approvers: ReadonlySet<string>;
  /** Already deduplicated + validated. Caller guarantees `options.length ≥ 2`
   *  and unique `key`s. */
  options: ReadonlyArray<AskOption>;
  prompt: string;
  /** Absolute deadline; computed by caller from `--timeout`. Broker won't
   *  re-compute. */
  timeoutMs: number;
}

/** Daemon-internal state for a pending ask. Not exported on the IPC boundary —
 *  the CLI side only sees `AskResult`. */
export interface PendingAsk {
  askId: string;
  /** Anti-replay nonce embedded in each button's action value. Click events
   *  whose nonce doesn't match → treated as stale (e.g. card from a previous
   *  daemon process before restart). */
  nonce: string;
  larkAppId: string;
  chatId: string;
  rootMessageId: string | null;
  sessionId: string;
  approvers: ReadonlySet<string>;
  options: ReadonlyArray<AskOption>;
  prompt: string;
  createdAt: number;
  deadlineAt: number;
  /** Set after the card dispatch succeeds. Until then, the ask is "registered
   *  but not visible" — clicks can't physically arrive yet. */
  cardMessageId?: string;
  /** Once true, subsequent click attempts return `already_settled`. */
  settled: boolean;
}

/** Outcome of a click-resolution attempt. Card click handler maps these to
 *  user-visible toasts. */
export type AskClickOutcome =
  /** First valid click — caller's Promise resolves with `kind:'answered'`. */
  | 'accepted'
  /** Clicker's open_id not in approvers — caller shows "你没有权限". */
  | 'unauthorized'
  /** No such askId, nonce mismatch, or unknown option — caller shows
   *  "此 ask 已失效（daemon 重启）". Covers the §8 stale-card case. */
  | 'stale'
  /** Ask already settled (race winner exists or timed out). */
  | 'already_settled';

/** Card dispatcher contract. The im/lark side registers a dispatcher via
 *  `setCardDispatcher`; the broker is otherwise IM-agnostic. */
export interface AskCardDispatcher {
  send(ask: PendingAsk): Promise<{ messageId: string }>;
  /** Called when an ask settles (answered / timedOut / invalidated). Card
   *  builder uses this to PATCH the card into a terminal state. Best-effort —
   *  the broker does not block on it. */
  onSettle?(
    ask: PendingAsk,
    result: AskResult,
  ): void | Promise<void>;
}
