/**
 * Cross-process advisory lock for a single file. Used to serialize
 * read-modify-write of shared JSON config (e.g. `bots.json` from multiple
 * daemon processes + the dashboard).
 *
 * Acquisition: atomic `open(path + '.lock', 'wx')`. The filesystem makes
 * O_CREAT|O_EXCL atomic, so exactly one waiter wins.
 *
 * Stale-break: a holder that crashes mid-section leaves the lock file
 * behind with its PID + process-start identity (legacy plain PIDs remain
 * readable). A crash before the payload write leaves an empty lock, reclaimed
 * only after a longer grace. To reclaim either shape we use the atomic POSIX
 * `rename(lock, lock.stale-<random>)`: rename succeeds for exactly ONE
 * caller (the source has to exist), so only ONE waiter is the rightful
 * stale-breaker. Everyone else gets ENOENT and loops back to acquire.
 * This avoids the classic "two waiters both unlink, one deletes the other's
 * just-acquired live lock" race that read+unlink-based schemes have.
 *
 * Not reentrant. Don't nest `withFileLock` calls on the same path within
 * the same process — the inner call would wait MAX_WAIT_MS and then time
 * out. (We could allow reentrancy via PID-equal check, but our callers
 * don't need it and the equality check would re-open the stale-break race.)
 */
import {
  closeSync,
  openSync,
  promises as fsp,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { readProcessStartIdentity } from '../core/session-marker.js';
import { logger } from './logger.js';

const MAX_WAIT_MS = 5_000;
const RETRY_BASE_MS = 25;
// Minimum age before we'll consider stale-breaking a lock with a dead PID.
// Prevents racing on freshly-acquired locks where the holder might not have
// finished writing its PID file yet.
const MIN_STALE_AGE_MS = 100;
// `open(..., 'wx')` creates the inode before the holder PID is written. A
// crash in that tiny window leaves an empty/invalid lock. Never steal a live
// writer's freshly-created file, but do reclaim an invalid holder after a more
// conservative grace period so crash recovery cannot deadlock forever.
const MIN_INVALID_HOLDER_STALE_AGE_MS = 1_000;

interface LockHolder {
  pid: number;
  procStart?: string;
}

let selfProcStartResolved = false;
let selfProcStart: string | undefined;

function currentLockHolderPayload(): string {
  if (!selfProcStartResolved) {
    selfProcStart = readProcessStartIdentity(process.pid);
    selfProcStartResolved = true;
  }
  return selfProcStart
    ? JSON.stringify({ pid: process.pid, procStart: selfProcStart })
    : String(process.pid);
}

function parseLockHolder(raw: string): LockHolder | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  if (/^\d+$/.test(text)) {
    const pid = Number(text);
    return Number.isSafeInteger(pid) && pid > 1 ? { pid } : undefined;
  }
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (
      !Number.isSafeInteger(record.pid) || (record.pid as number) <= 1 ||
      typeof record.procStart !== 'string' || !record.procStart || record.procStart.length > 256
    ) return undefined;
    return { pid: record.pid as number, procStart: record.procStart };
  } catch {
    return undefined;
  }
}

async function isHolderAlive(holder: LockHolder): Promise<boolean> {
  if (holder.procStart) {
    const liveStart = readProcessStartIdentity(holder.pid);
    if (liveStart !== undefined) return liveStart === holder.procStart;
  }
  const pid = holder.pid;
  if (!pid) return false;
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function isHolderAliveSync(holder: LockHolder): boolean {
  if (holder.procStart) {
    const liveStart = readProcessStartIdentity(holder.pid);
    if (liveStart !== undefined) return liveStart === holder.procStart;
  }
  const pid = holder.pid;
  if (!pid) return false;
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export interface FileLockOptions {
  /** Max time to wait for the lock before throwing (default MAX_WAIT_MS). */
  maxWaitMs?: number;
  /** Min lock age before a dead-PID lock is stale-breakable (default MIN_STALE_AGE_MS). */
  minStaleAgeMs?: number;
}

export async function withFileLock<T>(
  targetPath: string,
  fn: () => Promise<T>,
  opts: FileLockOptions = {},
): Promise<T> {
  const maxWaitMs = opts.maxWaitMs ?? MAX_WAIT_MS;
  const minStaleAgeMs = opts.minStaleAgeMs ?? MIN_STALE_AGE_MS;
  const lockPath = targetPath + '.lock';
  const start = Date.now();
  // Resolve the (potentially ps-backed on non-Linux) birth identity before
  // publishing an empty O_EXCL inode. The cached payload makes open→write a
  // tiny synchronous step rather than a seconds-long stale-break window.
  const holderPayload = currentLockHolderPayload();
  while (true) {
    try {
      const fh = await fsp.open(lockPath, 'wx');
      try {
        // Synchronous fd write avoids yielding with a publicly-visible empty
        // lock between O_EXCL creation and holder publication.
        writeFileSync(fh.fd, holderPayload);
        await fh.close();
      } catch (writeErr) {
        try { await fh.close(); } catch { /* tolerate */ }
        try { await fsp.unlink(lockPath); } catch { /* tolerate */ }
        throw writeErr;
      }
      try {
        return await fn();
      } finally {
        try { await fsp.unlink(lockPath); } catch { /* already gone, tolerate */ }
      }
    } catch (e: any) {
      if (e.code !== 'EEXIST') throw e;

      // EEXIST: someone holds the lock. Check whether it's stale (dead PID
      // + old enough). If so, attempt an atomic rename — POSIX guarantees
      // exactly one caller succeeds.
      let holder: LockHolder | undefined;
      let lockAgeMs = Infinity;
      try {
        const [raw, stat] = await Promise.all([
          fsp.readFile(lockPath, 'utf-8'),
          fsp.stat(lockPath),
        ]);
        holder = parseLockHolder(raw);
        lockAgeMs = Date.now() - stat.mtimeMs;
      } catch (re: any) {
        if (re.code === 'ENOENT') continue; // released between EEXIST and read
        throw re;
      }

      const staleAge = holder
        ? minStaleAgeMs
        : Math.max(minStaleAgeMs, MIN_INVALID_HOLDER_STALE_AGE_MS);
      const breakable = lockAgeMs >= staleAge &&
        (!holder || !(await isHolderAlive(holder)));
      if (breakable) {
        // Atomic rename: only ONE caller wins. The winner is responsible
        // for cleaning up the stale carcass; losers get ENOENT and retry
        // the lock acquisition on the next iteration.
        const stalePath = `${lockPath}.stale.${process.pid}.${randomBytes(4).toString('hex')}`;
        try {
          await fsp.rename(lockPath, stalePath);
          logger.warn(
            `[file-lock] broke stale lock at ${lockPath} ` +
            `(${holder ? `dead/reused pid ${holder.pid}` : 'empty/invalid holder'}, age ${lockAgeMs}ms)`,
          );
          try { await fsp.unlink(stalePath); } catch { /* tolerate */ }
          continue;
        } catch (renameErr: any) {
          if (renameErr.code === 'ENOENT') continue; // another waiter beat us
          throw renameErr;
        }
      }

      if (Date.now() - start > maxWaitMs) {
        throw new Error(
          `file-lock timeout waiting for ${lockPath} ` +
          `(held by pid ${holder?.pid || '?'}, age ${Math.round(lockAgeMs)}ms)`,
        );
      }
      await new Promise(r => setTimeout(r, RETRY_BASE_MS + Math.random() * RETRY_BASE_MS));
    }
  }
}

export function withFileLockSync<T>(
  targetPath: string,
  fn: () => T,
  opts: FileLockOptions = {},
): T {
  const maxWaitMs = opts.maxWaitMs ?? MAX_WAIT_MS;
  const minStaleAgeMs = opts.minStaleAgeMs ?? MIN_STALE_AGE_MS;
  const lockPath = targetPath + '.lock';
  const start = Date.now();
  const holderPayload = currentLockHolderPayload();
  while (true) {
    let fd: number | null = null;
    try {
      fd = openSync(lockPath, 'wx');
      writeFileSync(fd, holderPayload);
      closeSync(fd);
      fd = null;
      try {
        return fn();
      } finally {
        try { unlinkSync(lockPath); } catch { /* already gone, tolerate */ }
      }
    } catch (e: any) {
      if (fd !== null) {
        try { closeSync(fd); } catch { /* tolerate */ }
      }
      if (e.code !== 'EEXIST') throw e;

      let holder: LockHolder | undefined;
      let lockAgeMs = Infinity;
      try {
        holder = parseLockHolder(readFileSync(lockPath, 'utf-8'));
        lockAgeMs = Date.now() - statSync(lockPath).mtimeMs;
      } catch (re: any) {
        if (re.code === 'ENOENT') continue;
        throw re;
      }

      const staleAge = holder
        ? minStaleAgeMs
        : Math.max(minStaleAgeMs, MIN_INVALID_HOLDER_STALE_AGE_MS);
      const breakable = lockAgeMs >= staleAge &&
        (!holder || !isHolderAliveSync(holder));
      if (breakable) {
        const stalePath = `${lockPath}.stale.${process.pid}.${randomBytes(4).toString('hex')}`;
        try {
          renameSync(lockPath, stalePath);
          logger.warn(
            `[file-lock] broke stale lock at ${lockPath} ` +
            `(${holder ? `dead/reused pid ${holder.pid}` : 'empty/invalid holder'}, age ${lockAgeMs}ms)`,
          );
          try { unlinkSync(stalePath); } catch { /* tolerate */ }
          continue;
        } catch (renameErr: any) {
          if (renameErr.code === 'ENOENT') continue;
          throw renameErr;
        }
      }

      if (Date.now() - start > maxWaitMs) {
        throw new Error(
          `file-lock timeout waiting for ${lockPath} ` +
          `(held by pid ${holder?.pid || '?'}, age ${Math.round(lockAgeMs)}ms)`,
        );
      }
      sleepSync(RETRY_BASE_MS + Math.random() * RETRY_BASE_MS);
    }
  }
}
