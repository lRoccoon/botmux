import { promises as fs, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  INLINE_PAYLOAD_MAX_BYTES,
  PayloadRefSchema,
  isPayloadRef,
  parseEvent,
} from './schema.js';
import type { WorkflowEvent } from './schema.js';

// ─── Mutex (per-runId append serialization) ─────────────────────────────────

/**
 * Minimal promise-chain mutex.  v0 botmux is single-process per bot daemon,
 * so cross-process file locking is out of scope — we only need to serialize
 * concurrent in-process appends to the same run log.  Cross-process writers
 * (external CLI like `botmux schedule add`) must proxy through the daemon
 * process; they do not write workflow event logs directly.
 */
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

// ─── Event draft (what callers pass into append) ────────────────────────────

/**
 * What the runtime supplies to `append`.  The append path fills in
 * `eventId`, `schemaVersion`, and conditionally `payloadHash`/payload-ref
 * conversion.  Callers must supply `runId`, `type`, `actor`, `payload`, and
 * may optionally pass `timestamp` (defaults to Date.now()).
 *
 * The discriminated union over WorkflowEvent distributes through Omit, so
 * each event type's payload shape is preserved at the call site.
 */
export type EventDraft = Omit<WorkflowEvent, 'eventId' | 'schemaVersion' | 'payloadHash'> & {
  timestamp?: number;
};

// ─── EventLog ───────────────────────────────────────────────────────────────

const SHA256_HEX = (buf: Buffer | string): string =>
  createHash('sha256')
    .update(typeof buf === 'string' ? Buffer.from(buf, 'utf-8') : buf)
    .digest('hex');

export class EventLog {
  readonly runId: string;
  readonly runDir: string;
  readonly eventsFile: string;
  readonly blobDir: string;

  private mutex = new Mutex();
  private seq = 0;
  private seqLoaded = false;

  constructor(runId: string, baseDir: string) {
    if (!runId) throw new Error('EventLog: runId required');
    if (!baseDir) throw new Error('EventLog: baseDir required');
    this.runId = runId;
    this.runDir = join(baseDir, runId);
    this.eventsFile = join(this.runDir, 'events.ndjson');
    this.blobDir = join(this.runDir, 'blobs');
    if (!existsSync(this.runDir)) mkdirSync(this.runDir, { recursive: true });
    if (!existsSync(this.blobDir)) mkdirSync(this.blobDir, { recursive: true });
  }

  /**
   * Append one event.  Atomic with respect to other appends to the same
   * EventLog instance (in-process mutex).  Side effects:
   *  - assigns the next seq, fills eventId = `<runId>-<seq>`
   *  - if payload JSON exceeds INLINE_PAYLOAD_MAX_BYTES, writes a
   *    content-addressed blob first and replaces payload with a ref +
   *    payloadHash.  Blob is written before the event line, so a recovered
   *    event always points to an existing blob (events doc §4.1).
   *  - validates the final shape against EventSchema, returning the parsed
   *    event.
   */
  async append(draft: EventDraft): Promise<WorkflowEvent> {
    return this.mutex.run(async () => {
      await this.ensureSeqLoaded();

      const nextSeq = this.seq + 1;
      const timestamp = draft.timestamp ?? Date.now();
      const candidate: Record<string, unknown> = {
        eventId: `${this.runId}-${nextSeq}`,
        runId: this.runId,
        timestamp,
        type: draft.type,
        schemaVersion: 1,
        actor: draft.actor,
        payload: draft.payload,
      };

      // Inline-vs-ref decision: if caller already passed a PayloadRef, keep
      // it (caller is responsible for the blob); otherwise measure and spill
      // automatically when too large.
      const payloadIsRef = isPayloadRef(draft.payload);
      if (!payloadIsRef) {
        const inlineJson = JSON.stringify(draft.payload);
        const inlineBytes = Buffer.byteLength(inlineJson, 'utf-8');
        if (inlineBytes > INLINE_PAYLOAD_MAX_BYTES) {
          const buf = Buffer.from(inlineJson, 'utf-8');
          const hash = SHA256_HEX(buf);
          const blobPath = join(this.blobDir, hash);
          // Write blob FIRST.  Content-addressed: same hash → same content,
          // so re-writes are idempotent and safe under crash-replay.
          if (!existsSync(blobPath)) {
            await fs.writeFile(blobPath, buf);
          }
          candidate.payload = {
            ref: blobPath,
            bytes: buf.length,
            schemaVersion: 1,
          };
          candidate.payloadHash = `sha256:${hash}`;
        }
      } else {
        // Caller-provided ref must come with payloadHash (events doc §1.1
        // invariant).  Validator will reject if missing; we don't synth one
        // here because we'd have to read+hash the blob, which the caller
        // already did.
      }

      const parsed = parseEvent(candidate);

      // Append a single line to the NDJSON log.  Single-write append on
      // Linux ext4 is atomic for our sizes (kernel write() syscall holds
      // the inode lock for the duration of the write under O_APPEND).
      const line = JSON.stringify(parsed) + '\n';
      await fs.appendFile(this.eventsFile, line, 'utf-8');

      this.seq = nextSeq;
      return parsed;
    });
  }

  /**
   * Read all events in append order.  Used by replay (events doc §5.2)
   * and seq recovery on restart.  Returns [] if the log doesn't exist
   * yet.
   *
   * Throws if any line fails schema validation — events doc treats the
   * log as authoritative and corruption should fail loud, not silently
   * skip lines.
   */
  async readAll(): Promise<WorkflowEvent[]> {
    if (!existsSync(this.eventsFile)) return [];
    const content = await fs.readFile(this.eventsFile, 'utf-8');
    const events: WorkflowEvent[] = [];
    let lineNo = 0;
    for (const raw of content.split('\n')) {
      lineNo++;
      if (!raw) continue;
      try {
        const obj = JSON.parse(raw);
        events.push(parseEvent(obj));
      } catch (err) {
        throw new Error(
          `EventLog(${this.runId}): corrupt event at line ${lineNo}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return events;
  }

  /**
   * Read the blob referenced by a ref-payload event.  `ref` is the full
   * path stored on the event (we use absolute paths so callers don't have
   * to know the run dir).  The replay path uses this to materialize
   * ref-payloads into in-memory state.
   */
  async readBlob(ref: string): Promise<Buffer> {
    return fs.readFile(ref);
  }

  /** Current seq counter — exposed for tests / dashboard. */
  async currentSeq(): Promise<number> {
    await this.ensureSeqLoaded();
    return this.seq;
  }

  private async ensureSeqLoaded(): Promise<void> {
    if (this.seqLoaded) return;
    if (!existsSync(this.eventsFile)) {
      this.seq = 0;
      this.seqLoaded = true;
      return;
    }
    const events = await this.readAll();
    let maxSeq = 0;
    for (const e of events) {
      const m = e.eventId.match(/-(\d+)$/);
      if (m) {
        const s = parseInt(m[1], 10);
        if (s > maxSeq) maxSeq = s;
      }
    }
    this.seq = maxSeq;
    this.seqLoaded = true;
  }
}

// ─── Reexport schemas the EventLog returns, for ergonomic call sites ────────

export { PayloadRefSchema, INLINE_PAYLOAD_MAX_BYTES };
export type { WorkflowEvent };
