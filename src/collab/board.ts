/**
 * collab/board.ts — the CollabBoard implementation + factory.
 *
 * This is the typed write API the integration面 imports. It is a thin policy
 * layer over the event-log (write-model) and materialize (read-model):
 *   - append(): decides baseRevision and applies the section conflict policy —
 *     exclusive sections (EXCLUSIVE_BOARD_PATHS) reject stale claimed writes
 *     (CAS, checked under the log's file lock); everything else keeps P0.0
 *     last-write-wins with a ConflictRaised audit marker. Returns AppendResult.
 *   - snapshot()/revision()/history(): read side, always derived from the log.
 *
 * Construction (which runId, where the log lives) is the core's concern; the
 * integration面 only ever receives the CollabBoard interface from the factory.
 */
import { join } from 'node:path';
import { config } from '../config.js';
import {
  EXCLUSIVE_BOARD_PATHS,
  type CollabBoard,
  type CollabEventDraft,
  type AppendResult,
  type BoardSnapshot,
} from './contract.js';
import { CollabEventLog, type EventLogDraft } from './event-log.js';
import { materialize } from './materialize.js';

class CollabBoardImpl implements CollabBoard {
  readonly runId: string;
  private readonly log: CollabEventLog;

  constructor(runId: string, log: CollabEventLog) {
    this.runId = runId;
    this.log = log;
  }

  async append(draft: CollabEventDraft): Promise<AppendResult> {
    const rev = await this.log.currentSeq();
    const base = draft.baseRevision ?? rev;
    const persistDraft = { ...draft, baseRevision: base } as EventLogDraft;

    // P3 minimal CAS: a write touching an exclusive section with an explicit
    // baseRevision claim must be fresh — staleness is checked under the log's
    // file lock and a stale write is REJECTED, never applied. Writes that omit
    // baseRevision make no claim and fall through to LWW below (today's
    // control-plane GoalChanged path; tightening that to mandatory claims is
    // the integration side's follow-up).
    const exclusive = draft.affectedPaths.some((p) => EXCLUSIVE_BOARD_PATHS.has(p));
    if (exclusive && draft.baseRevision != null) {
      const res = await this.log.appendUnlessStale(persistDraft);
      if ('staleAtSeq' in res) {
        const marker = await this.log.append({
          type: 'ConflictRaised',
          runId: this.runId,
          actor: 'system',
          // keyed by the draft's own idempotencyKey: retrying the same stale
          // write dedupes to one marker; a fresh-based retry of the same op
          // uses the draft key untouched and applies normally.
          idempotencyKey: `${draft.idempotencyKey}:rejected`,
          baseRevision: res.staleAtSeq,
          affectedPaths: draft.affectedPaths,
          payload: {
            staleBaseRevision: base,
            currentRevision: res.staleAtSeq,
            resolution: 'rejected',
          },
        } as EventLogDraft);
        return {
          ok: true,
          event: marker.event,
          revision: marker.event.seq,
          deduped: marker.deduped,
          conflictLogged: true,
          rejected: true,
        };
      }
      return {
        ok: true,
        event: res.event,
        revision: res.event.seq,
        deduped: res.deduped,
        conflictLogged: false,
        rejected: false,
      };
    }

    const stale = draft.baseRevision != null && draft.baseRevision < rev;
    const res = await this.log.append(persistDraft);

    // P0.0 last-write-wins: the write always lands. If the caller reasoned about
    // a stale revision (and this wasn't an idempotent retry), drop an audit
    // marker. Marker-after keeps dedupe correct — a retried stale write returns
    // the prior event and emits no spurious conflict.
    let conflictLogged = false;
    if (!res.deduped && stale) {
      await this.log.append({
        type: 'ConflictRaised',
        runId: this.runId,
        actor: 'system',
        idempotencyKey: `${res.event.eventId}:conflict`,
        baseRevision: rev,
        affectedPaths: draft.affectedPaths,
        payload: {
          staleBaseRevision: base,
          currentRevision: rev,
          resolution: 'last-write-wins',
        },
      } as EventLogDraft);
      conflictLogged = true;
    }

    return {
      ok: true,
      event: res.event,
      revision: res.event.seq,
      deduped: res.deduped,
      conflictLogged,
      rejected: false,
    };
  }

  async snapshot(): Promise<BoardSnapshot> {
    return materialize(this.runId, await this.log.readAll());
  }

  async revision(): Promise<number> {
    return this.log.currentSeq();
  }

  async history() {
    return this.log.readAll();
  }
}

// ─── factory ─────────────────────────────────────────────────────────────────

/** Where collab event logs live; mirrors workflows' runs-dir convention. */
export function getCollabRunsDir(): string {
  return process.env.BOTMUX_COLLAB_RUNS_DIR ?? join(config.session.dataDir, 'collab-runs');
}

export interface CollabBoardOptions {
  /** Override the base directory for the run's event log. */
  baseDir?: string;
}

/**
 * Open (or create) the board for a run. The event log is created lazily on the
 * first append; opening an existing run replays its log on read. The integration
 *面 calls this with a runId and holds only the returned CollabBoard.
 */
export function openCollabBoard(runId: string, opts: CollabBoardOptions = {}): CollabBoard {
  const baseDir = opts.baseDir ?? getCollabRunsDir();
  return new CollabBoardImpl(runId, new CollabEventLog(runId, baseDir));
}
