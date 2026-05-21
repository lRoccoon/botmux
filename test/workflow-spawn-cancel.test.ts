import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';

import {
  createWorkflowDaemonSpawn,
  type WorkerHandle,
  type WorkerProcessFactory,
} from '../src/workflows/daemon-spawn.js';
import {
  WorkflowSpawnCancelledError,
  type DaemonRunOneShotInput,
} from '../src/workflows/spawn-bot.js';
import type { AbortCancelReason } from '../src/workflows/runtime.js';

// Fake WorkerHandle that records kill signals + exposes message emitter
// so the tests can simulate the worker's IPC lifecycle (ready /
// final_output / claude_exit).
function makeFakeWorker(): { worker: WorkerHandle; emitter: EventEmitter; kills: NodeJS.Signals[]; sent: unknown[] } {
  const emitter = new EventEmitter();
  const kills: NodeJS.Signals[] = [];
  const sent: unknown[] = [];
  let killed = false;
  const worker: WorkerHandle = {
    send: (msg) => { sent.push(msg); },
    on: ((event: any, cb: any) => emitter.on(event, cb)) as WorkerHandle['on'],
    kill: (sig) => {
      const s = (sig ?? 'SIGTERM') as NodeJS.Signals;
      kills.push(s);
      // Simulate exit after SIGKILL or SIGTERM
      if (s === 'SIGKILL' || s === 'SIGTERM') {
        if (!killed) {
          killed = true;
          setImmediate(() => emitter.emit('exit', null));
        }
      }
    },
    pid: 12345,
    stdout: null,
    stderr: null,
  };
  return { worker, emitter, kills, sent };
}

function makeFactory(handle: WorkerHandle): WorkerProcessFactory {
  return { spawn: () => handle };
}

let tempDir: string;
beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'wf-spawn-cancel-'));
});
afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

const baseInput = (): DaemonRunOneShotInput => ({
  botName: 'cli_x',
  prompt: 'do',
  runId: 'spawn-cancel-test',
  nodeId: 'n',
  activityId: 'spawn-cancel-test::work::n',
  attemptId: 'spawn-cancel-test::work::n::1',
  attemptLogPath: join(tempDir, 'attempt.log'),
});

describe('daemon-spawn cancel responsiveness', () => {
  it('case 7: cancel fires SIGINT + sends close to worker', async () => {
    const fake = makeFakeWorker();
    const deps = createWorkflowDaemonSpawn({
      resolveLarkCredentials: () => ({ larkAppId: 'cli_x', larkAppSecret: 'sec' }),
      factory: makeFactory(fake.worker),
      cancelGraceMs: 5000,
      defaultTimeoutMs: 60_000,
      quiesceMs: 100,
    });
    const ac = new AbortController();
    const reason: AbortCancelReason = { cancelOriginEventId: 'evt-1' };
    // Worker emits 'ready' so init message gets sent, then we abort.
    setTimeout(() => fake.emitter.emit('message', { type: 'ready', port: 0 }), 5);
    setTimeout(() => ac.abort(reason), 20);

    const promise = deps.runOneShot({ ...baseInput(), cancelSignal: ac.signal });
    await expect(promise).rejects.toBeInstanceOf(WorkflowSpawnCancelledError);
    try {
      await promise;
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowSpawnCancelledError);
      expect((err as WorkflowSpawnCancelledError).cancelOriginEventId).toBe('evt-1');
    }
    // Verify worker.send({type:'close'}) was called from cancel path.
    expect(fake.sent.some((m: any) => m?.type === 'close')).toBe(true);
    // And SIGINT was sent before any SIGKILL.
    expect(fake.kills[0]).toBe('SIGINT');
  });

  it('case 8: SIGKILL escalation after grace timeout if worker stays alive', async () => {
    vi.useFakeTimers();
    try {
      // Use a custom fake worker that does NOT auto-exit on SIGINT — only
      // exits on SIGKILL.  Forces the grace timer to fire.
      const emitter = new EventEmitter();
      const kills: NodeJS.Signals[] = [];
      const sent: unknown[] = [];
      let killed = false;
      const worker: WorkerHandle = {
        send: (msg) => { sent.push(msg); },
        on: ((event: any, cb: any) => emitter.on(event, cb)) as WorkerHandle['on'],
        kill: (sig) => {
          const s = (sig ?? 'SIGTERM') as NodeJS.Signals;
          kills.push(s);
          if (s === 'SIGKILL' && !killed) {
            killed = true;
            setImmediate(() => emitter.emit('exit', null));
          }
          // SIGINT: ignored (worker stuck)
          // SIGTERM (from cleanup): also ignored until SIGKILL
        },
        pid: 12345,
        stdout: null,
        stderr: null,
      };
      const deps = createWorkflowDaemonSpawn({
        resolveLarkCredentials: () => ({ larkAppId: 'cli_x', larkAppSecret: 'sec' }),
        factory: { spawn: () => worker },
        cancelGraceMs: 5000,
        defaultTimeoutMs: 60_000,
        quiesceMs: 100,
      });
      const ac = new AbortController();
      const reason: AbortCancelReason = { cancelOriginEventId: 'evt-grace' };
      const promise = deps.runOneShot({ ...baseInput(), cancelSignal: ac.signal });
      const settled = promise.catch((err) => err);
      // Let microtasks run so the listener is registered.
      await vi.advanceTimersByTimeAsync(0);
      ac.abort(reason);
      await vi.advanceTimersByTimeAsync(0);
      // SIGINT happens immediately on abort.
      expect(kills[0]).toBe('SIGINT');
      expect(kills).not.toContain('SIGKILL');
      // Advance well into grace but still under it.  (cleanup also fires
      // a SIGTERM at t=250 which our stuck worker ignores.)
      await vi.advanceTimersByTimeAsync(4000);
      expect(kills).not.toContain('SIGKILL');
      // Cross the grace boundary — SIGKILL fires.
      await vi.advanceTimersByTimeAsync(2000);
      expect(kills).toContain('SIGKILL');
      expect(await settled).toBeInstanceOf(WorkflowSpawnCancelledError);
    } finally {
      vi.useRealTimers();
    }
  });

  it('case 9: worker exits voluntarily after SIGINT — no SIGKILL', async () => {
    vi.useFakeTimers();
    try {
      const emitter = new EventEmitter();
      const kills: NodeJS.Signals[] = [];
      const sent: unknown[] = [];
      const worker: WorkerHandle = {
        send: (msg) => { sent.push(msg); },
        on: ((event: any, cb: any) => emitter.on(event, cb)) as WorkerHandle['on'],
        kill: (sig) => {
          const s = (sig ?? 'SIGTERM') as NodeJS.Signals;
          kills.push(s);
          if (s === 'SIGINT') {
            // Worker complies and exits cleanly after a short delay.
            setTimeout(() => emitter.emit('exit', 0), 100);
          }
        },
        pid: 12345,
        stdout: null,
        stderr: null,
      };
      const deps = createWorkflowDaemonSpawn({
        resolveLarkCredentials: () => ({ larkAppId: 'cli_x', larkAppSecret: 'sec' }),
        factory: { spawn: () => worker },
        cancelGraceMs: 5000,
        defaultTimeoutMs: 60_000,
        quiesceMs: 100,
      });
      const ac = new AbortController();
      const reason: AbortCancelReason = { cancelOriginEventId: 'evt-voluntary' };
      const promise = deps.runOneShot({ ...baseInput(), cancelSignal: ac.signal });
      // Suppress unhandled-rejection noise while we drive timers; we
      // await the rejection at the end.
      const settled = promise.catch((err) => err);
      await vi.advanceTimersByTimeAsync(0);
      ac.abort(reason);
      // Advance through worker's voluntary exit (100ms) plus a buffer.
      await vi.advanceTimersByTimeAsync(200);
      expect(kills[0]).toBe('SIGINT');
      expect(kills).not.toContain('SIGKILL');
      // Advance well past grace to confirm SIGKILL never fired.
      await vi.advanceTimersByTimeAsync(6000);
      expect(kills).not.toContain('SIGKILL');
      expect(await settled).toBeInstanceOf(WorkflowSpawnCancelledError);
    } finally {
      vi.useRealTimers();
    }
  });
});
