/**
 * collab/event-log.ts — the single write-model. Append-only NDJSON per runId.
 *
 * Mirrors src/workflows/events/append.ts for the concurrency story:
 *   - in-process serialization via a module-level per-runId mutex, and
 *   - cross-process serialization via withFileLock over the events file.
 * Adds: idempotency dedupe on (runId, idempotencyKey), and seq recovery on
 * restart by re-scanning the log (so a daemon restart replays cleanly).
 *
 * This module knows NOTHING about board materialization or conflict policy —
 * it just durably appends validated events and hands them back. Revision /
 * snapshot / LWW live in board.ts; the read-model lives in materialize.ts.
 */
import { promises as fs, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { withFileLock } from '../utils/file-lock.js';
import {
  CollabEventSchema,
  COLLAB_SCHEMA_VERSION,
  type CollabEvent,
} from './contract.js';

// ─── per-runId in-process mutex (mirrors workflows/events/append.ts) ─────────
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const prior = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((r) => {
      release = r;
    });
    try {
      await prior;
      return await fn();
    } finally {
      release();
    }
  }
}
const RUN_MUTEXES = new Map<string, Mutex>();
function getRunMutex(runId: string): Mutex {
  let m = RUN_MUTEXES.get(runId);
  if (!m) {
    m = new Mutex();
    RUN_MUTEXES.set(runId, m);
  }
  return m;
}

/**
 * What a caller hands the log. The log fills eventId/seq/schemaVersion and
 * (if omitted) timestamp. Unlike the public CollabEventDraft, baseRevision is
 * REQUIRED here — board.ts decides it before persisting.
 */
export type EventLogDraft = Omit<
  CollabEvent,
  'eventId' | 'seq' | 'schemaVersion' | 'timestamp'
> & { timestamp?: number };

export interface AppendOutcome {
  event: CollabEvent;
  /** true ⇒ idempotencyKey already present; `event` is the prior one, nothing written. */
  deduped: boolean;
}

export class CollabEventLog {
  readonly runId: string;
  readonly runDir: string;
  readonly eventsFile: string;

  private seq = 0;
  private seqLoaded = false;
  private cachedMtimeMs = 0;
  private cachedSize = 0;
  /** idempotencyKey → eventId, rebuilt from disk on stale. */
  private idemIndex = new Map<string, string>();

  constructor(runId: string, baseDir: string) {
    if (!runId) throw new Error('CollabEventLog: runId required');
    if (!baseDir) throw new Error('CollabEventLog: baseDir required');
    this.runId = runId;
    this.runDir = join(baseDir, runId);
    this.eventsFile = join(this.runDir, 'events.ndjson');
    if (!existsSync(this.runDir)) mkdirSync(this.runDir, { recursive: true });
  }

  /** Append one event, atomic in-process (mutex) and cross-process (file lock). */
  async append(draft: EventLogDraft): Promise<AppendOutcome> {
    return getRunMutex(this.runId).run(() =>
      withFileLock(this.eventsFile, () => this.appendLocked(draft)),
    );
  }

  /**
   * Like append(), but if the draft carries a baseRevision BEHIND the log's
   * authoritative seq, nothing is written and `{ staleAtSeq }` is returned.
   * The check runs under the same mutex+file lock as the write, so it is
   * race-free across processes (no TOCTOU window). An idempotent retry of an
   * already-applied write still dedupes and returns the prior event — dedupe
   * is checked before staleness, so retrying a write that landed earlier never
   * reads as a conflict.
   */
  async appendUnlessStale(draft: EventLogDraft): Promise<AppendOutcome | { staleAtSeq: number }> {
    return getRunMutex(this.runId).run(() =>
      withFileLock(this.eventsFile, async () => {
        await this.refreshIfStale();
        const isRetry = this.idemIndex.has(draft.idempotencyKey);
        if (!isRetry && typeof draft.baseRevision === 'number' && draft.baseRevision < this.seq) {
          return { staleAtSeq: this.seq };
        }
        return this.appendLocked(draft);
      }),
    );
  }

  private async appendLocked(draft: EventLogDraft): Promise<AppendOutcome> {
    await this.refreshIfStale();

    // idempotency: (runId, idempotencyKey) is unique. A retry returns the prior.
    const priorId = this.idemIndex.get(draft.idempotencyKey);
    if (priorId) {
      const all = await this.readAll();
      const prior = all.find((e) => e.eventId === priorId);
      if (prior) return { event: prior, deduped: true };
    }

    const nextSeq = this.seq + 1;
    const timestamp = draft.timestamp ?? Date.now();
    const candidate = {
      ...draft,
      eventId: `${this.runId}-${nextSeq}`,
      seq: nextSeq,
      schemaVersion: COLLAB_SCHEMA_VERSION,
      timestamp,
    };

    // Authoritative validation — the log is the source of truth; fail loud.
    const parsed = CollabEventSchema.parse(candidate);

    await fs.appendFile(this.eventsFile, JSON.stringify(parsed) + '\n', 'utf-8');

    const stat = await fs.stat(this.eventsFile);
    this.seq = nextSeq;
    this.idemIndex.set(parsed.idempotencyKey, parsed.eventId);
    this.cachedMtimeMs = stat.mtimeMs;
    this.cachedSize = stat.size;
    this.seqLoaded = true;
    return { event: parsed, deduped: false };
  }

  /** All events in append order. Throws on corruption (log is authoritative). */
  async readAll(): Promise<CollabEvent[]> {
    if (!existsSync(this.eventsFile)) return [];
    const content = await fs.readFile(this.eventsFile, 'utf-8');
    const events: CollabEvent[] = [];
    let lineNo = 0;
    for (const raw of content.split('\n')) {
      lineNo++;
      if (!raw) continue;
      try {
        events.push(CollabEventSchema.parse(JSON.parse(raw)));
      } catch (err) {
        throw new Error(
          `CollabEventLog(${this.runId}): corrupt event at line ${lineNo}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return events;
  }

  /** Current seq (= revision). Locked so it's consistent with appends. */
  async currentSeq(): Promise<number> {
    return getRunMutex(this.runId).run(() =>
      withFileLock(this.eventsFile, async () => {
        await this.refreshIfStale();
        return this.seq;
      }),
    );
  }

  /** Re-scan if the file changed under us (another process appended). */
  private async refreshIfStale(): Promise<void> {
    if (!existsSync(this.eventsFile)) {
      this.seq = 0;
      this.seqLoaded = true;
      this.cachedMtimeMs = 0;
      this.cachedSize = 0;
      this.idemIndex.clear();
      return;
    }
    const stat = await fs.stat(this.eventsFile);
    if (this.seqLoaded && stat.mtimeMs === this.cachedMtimeMs && stat.size === this.cachedSize) {
      return;
    }
    const events = await this.readAll();
    let maxSeq = 0;
    this.idemIndex.clear();
    for (const e of events) {
      if (e.seq > maxSeq) maxSeq = e.seq;
      this.idemIndex.set(e.idempotencyKey, e.eventId);
    }
    this.seq = maxSeq;
    this.cachedMtimeMs = stat.mtimeMs;
    this.cachedSize = stat.size;
    this.seqLoaded = true;
  }
}
