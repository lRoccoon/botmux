/**
 * Decision logic for "should the worker suppress its transcript-driven
 * fallback emit for this Lark turn?"
 *
 * Pure function with no I/O — kept separate from worker.ts so the rules
 * (including the type-ahead window and the adopt-vs-non-adopt branching)
 * can be tested deterministically. The worker reads marker entries from
 * disk and threads them through here.
 *
 * Rules:
 *   - Adopt mode never suppresses: in /adopt the model in the adopted
 *     session is unaware of botmux, so transcript drain is the ONLY
 *     channel from model to Lark. There's no `botmux send` to compete
 *     with, hence no marker to gate on.
 *   - Non-adopt + isLocal: suppress. A local-typing turn means the
 *     attribution queue saw a user event whose content didn't match any
 *     pending Lark fingerprint. In a worker-spawned CLI that's a Web
 *     terminal hand-typed input — the user is already looking at it, no
 *     reason to push it back to the Lark thread.
 *   - Non-adopt + send observed in window: suppress. The window is
 *     [turn.markTimeMs, nextBoundaryMs). Legacy markers only carry time,
 *     so any marker in the window still suppresses. Newer markers also
 *     carry a fingerprint/length of the explicit `botmux send` body; when
 *     the transcript final is available, suppress only if the explicit
 *     send appears to cover that final. This prevents progress updates
 *     from hiding a later substantive final answer. Boundary handling
 *     intentionally also considers
 *     queue items that haven't reached "ready" yet (passed in via
 *     nextBoundaryMs) — without that, a model that's still mid-tool-use
 *     for turn N+1 could leak a send credit into turn N's window.
 */
import { normaliseForFingerprint } from './bridge-turn-queue.js';

export interface BridgeSendMarker {
  sentAtMs: number;
  messageId?: string;
  contentFingerprint?: string;
  contentLength?: number;
}

export interface BridgeGateInput {
  /** When the user message was queued — defines the lower bound of the
   *  send window. Undefined for legacy turns; the gate degrades to
   *  "never suppress" in that case. */
  markTimeMs: number | undefined;
  /** Whether the queue synthesised this turn from a local-terminal event
   *  (no fingerprint match for a Lark message). */
  isLocal: boolean | undefined;
  /** Transcript final text for this turn, when available. Lets structured
   *  send markers distinguish final-answer sends from earlier progress sends. */
  finalText?: string;
}

function markerSetCoversFinal(markers: readonly BridgeSendMarker[], finalText: string | undefined): boolean {
  if (markers.length === 0) return false;

  // Back-compat: old marker files only have sentAtMs/messageId. Keep the old
  // conservative behavior for those entries instead of risking duplicates.
  if (markers.some(m => typeof m.contentFingerprint !== 'string' || typeof m.contentLength !== 'number')) {
    return true;
  }

  const finalNormalized = normaliseForFingerprint(finalText ?? '');
  if (!finalNormalized) return true;

  if (markers.some(m => m.contentFingerprint && finalNormalized.includes(m.contentFingerprint))) {
    return true;
  }

  const sentLength = markers.reduce((sum, m) => sum + Math.max(0, m.contentLength ?? 0), 0);
  return sentLength >= Math.floor(finalNormalized.length * 0.8);
}

export function shouldSuppressBridgeEmit(
  turn: BridgeGateInput,
  nextBoundaryMs: number | undefined,
  markers: readonly BridgeSendMarker[],
  adoptMode: boolean,
): boolean {
  if (adoptMode) return false;
  if (turn.isLocal) return true;
  if (turn.markTimeMs === undefined) return false;
  const lower = turn.markTimeMs;
  const upper = nextBoundaryMs ?? Number.POSITIVE_INFINITY;
  const markersInWindow = markers.filter(m => m.sentAtMs >= lower && m.sentAtMs < upper);
  return markerSetCoversFinal(markersInWindow, turn.finalText);
}
