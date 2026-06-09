/**
 * collab/board.ts — the CollabBoard implementation + factory.
 *
 * This is the typed write API the integration面 imports. It is a thin policy
 * layer over the event-log (write-model) and materialize (read-model):
 *   - append(): decides baseRevision, applies P0.0 last-write-wins conflict
 *     policy (write the event; if the caller's baseRevision was stale, also log
 *     a ConflictRaised audit marker), returns AppendResult.
 *   - snapshot()/revision()/history(): read side, always derived from the log.
 *
 * Construction (which runId, where the log lives) is the core's concern; the
 * integration面 only ever receives the CollabBoard interface from the factory.
 */
import { join } from 'node:path';
import { config } from '../config.js';
import {
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
    const stale = draft.baseRevision != null && draft.baseRevision < rev;

    const persistDraft = { ...draft, baseRevision: base } as EventLogDraft;
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
