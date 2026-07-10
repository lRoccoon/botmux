import { createHash } from 'node:crypto';
import { canonicalJson } from '../../utils/canonical-input-hash.js';

export { canonicalJson, computeInputHash } from '../../utils/canonical-input-hash.js';

// ─── idempotency key derivation (5-tuple → ≤ 50-char uuid) ──────────────────

/**
 * The 5-tuple that anchors workflow idempotency (events doc §3.2 / §4.2).
 * Each attempt is uniquely identified by this combination; the derived
 * key feeds into provider uuid fields (Feishu IM uuid, schedule-store id).
 */
export type IdempotencyKeyTuple = {
  workflowId: string;
  revisionId: string;
  runId: string;
  nodeId: string;
  attemptId: string;
};

export type DeriveIdempotencyKeyOptions = {
  /**
   * String prefix prepended to the truncated hash.  Defaults to `wf_`,
   * which keeps workflow-generated ids in a separate namespace from
   * randomUUID-derived ids (events doc §2.2 schedule case).  Pass empty
   * string to disable.  Must be ≤ `maxLength - 1`.
   */
  namespace?: string;
  /**
   * Max output length.  Defaults to 50 to match Feishu IM uuid field's
   * documented upper bound (spike report §1.2).
   */
  maxLength?: number;
};

/**
 * Deterministically derive an idempotency key from the 5-tuple.  Same tuple
 * always produces the same key; collisions are bounded by the truncated
 * SHA-256 birthday term.  With default namespace `wf_` and maxLength 50:
 *
 *   key = "wf_" + sha256(workflowId:revisionId:runId:nodeId:attemptId)[:47]
 *
 * 47 hex chars = 188 bits of entropy, ample for collision-free workflow
 * lifetimes.
 */
export function deriveIdempotencyKey(
  tuple: IdempotencyKeyTuple,
  opts: DeriveIdempotencyKeyOptions = {},
): string {
  const namespace = opts.namespace ?? 'wf_';
  const maxLength = opts.maxLength ?? 50;
  if (namespace.length >= maxLength) {
    throw new Error(
      `deriveIdempotencyKey: namespace '${namespace}' (${namespace.length} chars) leaves no room for hash in maxLength ${maxLength}`,
    );
  }
  for (const [k, v] of Object.entries(tuple)) {
    if (typeof v !== 'string' || v.length === 0) {
      throw new Error(`deriveIdempotencyKey: tuple.${k} must be non-empty string, got ${String(v)}`);
    }
  }
  // Codex round 4 minor: original implementation `${a}:${b}:${c}:${d}:${e}`
  // had a theoretical collision: two distinct tuples whose fields happen
  // to span `:` boundaries differently can produce the same seed (e.g.
  // `{a:'x:y', b:'z', ...}` collides with `{a:'x', b:'y:z', ...}`).
  // Hashing canonicalJson(tuple) — same canonical form used everywhere
  // else for hash-stable serialization — closes the hole without any
  // call-site change.
  const seed = canonicalJson(tuple);
  const hash = createHash('sha256').update(seed, 'utf-8').digest('hex');
  return namespace + hash.substring(0, maxLength - namespace.length);
}
