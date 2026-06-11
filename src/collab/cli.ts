/**
 * collab/cli.ts — `botmux collab <sub>`: the worker process's board access.
 *
 * A worker is a separate forked CLI session, so it reaches the board over this
 * thin command surface rather than importing the core. It resolves its context
 * from the env the daemon→worker→child chain injects (codex's contract), with
 * explicit flags as override:
 *   BOTMUX_COLLAB_RUN_ID   (--run)
 *   BOTMUX_COLLAB_WORKER_ID(--worker)
 *   BOTMUX_COLLAB_TASK_ID  (--task)
 *   BOTMUX_COLLAB_RUNS_DIR (--base-dir)
 *
 * Read:  snapshot | history | revision
 * Write: artifact | status | receipt   (high-level, auto-filled)
 *        append --file <draft.json>     (generic, for ops/power use)
 */
import { readFileSync } from 'node:fs';
import { config } from '../config.js';
import { loadBotConfigs } from '../bot-registry.js';
import { openCollabBoard } from './board.js';
import type { CollabEventDraft, TaskStatus, ReceiptState, BoardPath } from './contract.js';
import {
  addCollabWorker,
  collabWorkerPoolPath,
  readCollabWorkerPool,
  removeCollabWorker,
} from './worker-pool-store.js';

// ─── tiny flag parser (`--key value` and bare `--flag`) ──────────────────────
function parseFlags(args: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = args[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function str(v: string | boolean | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function fail(msg: string): never {
  console.error(`collab: ${msg}`);
  process.exit(1);
}

function resolveCtx(flags: Record<string, string | boolean>) {
  const runId = str(flags.run) ?? process.env.BOTMUX_COLLAB_RUN_ID;
  if (!runId) fail('missing run id (--run or BOTMUX_COLLAB_RUN_ID)');
  const baseDir = str(flags['base-dir']) ?? process.env.BOTMUX_COLLAB_RUNS_DIR;
  const workerId = str(flags.worker) ?? process.env.BOTMUX_COLLAB_WORKER_ID;
  const taskId = str(flags.task) ?? process.env.BOTMUX_COLLAB_TASK_ID;
  const board = openCollabBoard(runId!, baseDir ? { baseDir } : {});
  return { runId: runId!, baseDir, workerId, taskId, board };
}

export async function cmdCollab(sub: string, args: string[]): Promise<void> {
  const flags = parseFlags(args);

  switch (sub) {
    case 'pool': {
      await cmdPool(args);
      return;
    }
    case 'snapshot': {
      const { board } = resolveCtx(flags);
      console.log(JSON.stringify(await board.snapshot(), null, flags.compact ? 0 : 2));
      return;
    }
    case 'revision': {
      const { board } = resolveCtx(flags);
      console.log(String(await board.revision()));
      return;
    }
    case 'history': {
      const { board } = resolveCtx(flags);
      const events = await board.history();
      for (const e of events) console.log(JSON.stringify(e));
      return;
    }

    case 'artifact': {
      const { board, runId, workerId, taskId } = resolveCtx(flags);
      const path = str(flags.path) ?? fail('artifact: --path required');
      const kind = (str(flags.kind) ?? 'file') as 'file' | 'diff' | 'log' | 'note';
      const rev = await board.revision();
      await board.append(workerDraft({
        type: 'ArtifactRecorded', runId, workerId, taskId,
        idem: str(flags.idem) ?? `artifact:r${rev}:${path}`,
        paths: ['artifacts'],
        payload: {
          artifactId: str(flags.id) ?? `${workerId ?? 'w'}-${rev}`,
          kind, path, sha256: str(flags.sha), note: str(flags.note),
        },
      }));
      console.log('ok');
      return;
    }
    case 'status': {
      const { board, runId, workerId, taskId } = resolveCtx(flags);
      const status = str(flags.status) as TaskStatus | undefined;
      if (!status) fail('status: --status required (open|in_progress|blocked|done|failed)');
      if (!taskId) fail('status: missing task id (--task or BOTMUX_COLLAB_TASK_ID)');
      const rev = await board.revision();
      await board.append(workerDraft({
        type: 'TaskStatusChanged', runId, workerId, taskId,
        idem: str(flags.idem) ?? `status:${status}:r${rev}`,
        paths: ['task'],
        payload: { taskId: taskId!, status: status!, note: str(flags.note) },
      }));
      console.log('ok');
      return;
    }
    case 'receipt': {
      const { board, runId, workerId, taskId } = resolveCtx(flags);
      const intervention = str(flags.intervention) ?? fail('receipt: --intervention <eventId> required');
      const state = str(flags.state) as ReceiptState | undefined;
      if (!state) fail('receipt: --state required (delivered|read|applied|superseded)');
      await board.append(workerDraft({
        type: 'InterventionReceiptUpdated', runId, workerId, taskId,
        // stable key ⇒ re-emitting the same receipt is naturally idempotent
        idem: `receipt:${intervention}:${state}`,
        paths: ['interventions'],
        payload: { interventionId: intervention, state: state! },
      }));
      console.log('ok');
      return;
    }

    case 'propose': {
      const { board, runId, workerId, taskId } = resolveCtx(flags);
      const title = str(flags.title) ?? fail('propose: --title required');
      const spec = str(flags.spec) ?? fail('propose: --spec required');
      const why = str(flags.why) ?? fail('propose: --why required');
      const rev = await board.revision();
      const proposalId = str(flags.id) ?? `${workerId ?? 'w'}-p${rev}`;
      const deps = str(flags.deps)?.split(',').map((s) => s.trim()).filter(Boolean);
      const res = await board.append(workerDraft({
        type: 'TaskProposed', runId, workerId, taskId,
        // explicit --id gives a stable key (true retry idempotency); the rev-based
        // default mirrors `artifact` — distinct sequential proposes get distinct revs
        idem: str(flags.idem) ?? `propose:${proposalId}`,
        paths: ['proposals'],
        payload: {
          proposalId, title, spec, why,
          parentTaskId: str(flags.parent) ?? taskId,
          expectedArtifact: str(flags['expected-artifact']),
          doneCriteria: str(flags['done-criteria']),
          deps: deps && deps.length ? deps : undefined,
        },
      }));
      console.log(JSON.stringify({ ok: res.ok, proposalId, eventId: res.event.eventId, revision: res.revision, deduped: res.deduped }));
      return;
    }

    case 'append': {
      const { board, runId } = resolveCtx(flags);
      const file = str(flags.file);
      const raw = file ? readFileSync(file, 'utf-8') : readFileSync(0, 'utf-8');
      const draft = JSON.parse(raw) as CollabEventDraft;
      if (!draft.runId) (draft as { runId: string }).runId = runId;
      const res = await board.append(draft);
      console.log(JSON.stringify({ ok: res.ok, eventId: res.event.eventId, revision: res.revision, deduped: res.deduped, conflictLogged: res.conflictLogged }));
      return;
    }

    default:
      console.error(
        'usage: botmux collab <pool|snapshot|revision|history|artifact|status|receipt|propose|append> [flags]\n' +
        '  pool: pool add|list|remove|status\n' +
        '  read:  snapshot [--compact] | revision | history\n' +
        '  write: artifact --path <p> [--kind file|diff|log|note] [--sha <h>] [--note <s>]\n' +
        '         status --status <open|in_progress|blocked|done|failed> [--note <s>]\n' +
        '         receipt --intervention <eventId> --state <delivered|read|applied|superseded>\n' +
        '         propose --title <t> --spec <s> --why <w> [--parent <taskId>] [--deps a,b]\n' +
        '                 [--expected-artifact <p>] [--done-criteria <c>] [--id <proposalId>]\n' +
        '         append --file <draft.json>   (generic)\n' +
        '  context: --run/--worker/--task/--base-dir override BOTMUX_COLLAB_* env',
      );
      process.exit(sub ? 1 : 0);
  }
}

async function cmdPool(args: string[]): Promise<void> {
  const sub = args[0] ?? '';
  const flags = parseFlags(args.slice(1));
  const dataDir = config.session.dataDir;

  switch (sub) {
    case 'add': {
      const id = str(flags.id) ?? fail('pool add: --id required');
      const larkAppId = str(flags['lark-app-id']) ?? str(flags.app) ?? fail('pool add: --lark-app-id required');
      const cfg = loadBotConfigs().find((c) => c.larkAppId === larkAppId);
      if (!cfg) fail(`pool add: larkAppId ${larkAppId} not found in bots.json`);
      if (cfg.handler !== 'collab-worker') {
        fail(`pool add: ${larkAppId} must have handler:"collab-worker" in bots.json`);
      }
      const entry = await addCollabWorker(dataDir, {
        id,
        larkAppId,
        label: str(flags.label),
        cliId: cfg.cliId,
      });
      console.log(JSON.stringify(entry, null, flags.compact ? 0 : 2));
      return;
    }
    case 'list':
    case 'status': {
      const pool = readCollabWorkerPool(dataDir);
      if (flags.json) {
        console.log(JSON.stringify(pool.workers, null, flags.compact ? 0 : 2));
        return;
      }
      if (pool.workers.length === 0) {
        console.log(`No collab workers registered (${collabWorkerPoolPath(dataDir)})`);
        return;
      }
      for (const w of pool.workers) {
        const lease = w.leasedBy ? ` leasedBy=${w.leasedBy}${w.leaseExpiresAt ? ` until=${new Date(w.leaseExpiresAt).toISOString()}` : ''}` : '';
        console.log(`${w.id}\t${w.status}\t${w.label ?? '-'}\t${w.larkAppId}${lease}`);
      }
      return;
    }
    case 'remove': {
      const id = str(flags.id) ?? args[1] ?? fail('pool remove: --id required');
      const removed = await removeCollabWorker(dataDir, id);
      console.log(removed ? 'removed' : 'not-found');
      return;
    }
    default:
      console.error(
        'usage: botmux collab pool <register|add|list|remove|status> [flags]\n' +
        '  register  interactive: obtain creds + write bots.json (handler:collab-worker) + pool entry in one go\n' +
        '  add --id <workerId> --lark-app-id <appId> [--label <name>]\n' +
        '      requires the app in bots.json with handler:"collab-worker"\n' +
        '  list [--json] [--compact]\n' +
        '  status [--json] [--compact]\n' +
        '  remove --id <workerId>',
      );
      process.exit(sub ? 1 : 0);
  }
}

function workerDraft(p: {
  type: CollabEventDraft['type'];
  runId: string;
  workerId?: string;
  taskId?: string;
  idem: string;
  paths: BoardPath[];
  payload: unknown;
}): CollabEventDraft {
  return {
    type: p.type,
    runId: p.runId,
    actor: 'worker',
    idempotencyKey: p.idem,
    affectedPaths: p.paths,
    workerId: p.workerId,
    taskId: p.taskId,
    payload: p.payload,
  } as CollabEventDraft;
}
