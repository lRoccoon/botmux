import { config } from '../config.js';
import { getBot } from '../bot-registry.js';
import { buildIdleCloseReminderCard } from '../im/lark/card-builder.js';
import { localeForBot } from '../i18n/index.js';
import * as sessionStore from '../services/session-store.js';
import { logger } from '../utils/logger.js';
import { sessionAnchorId } from './types.js';
import type { DaemonSession } from './types.js';

const STARTUP_SCAN_DELAY_MS = 10_000;
const MIN_SCAN_INTERVAL_MS = 60_000;

export interface IdleCloseReminderOptions {
  enabled?: boolean;
  thresholdMs: number;
  snoozeMs: number;
  now?: number;
}

export interface IdleCloseReminderDeps {
  sessionReply: (rootId: string, content: string, msgType?: string, larkAppId?: string) => Promise<string>;
}

export interface IdleCloseReminderScannerHandle {
  interval: ReturnType<typeof setInterval>;
  startup?: ReturnType<typeof setTimeout>;
  stop: () => void;
}

function parseTime(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : undefined;
}

export function sessionLastActivityAt(ds: DaemonSession): number {
  return parseTime(ds.session.lastMessageAt)
    ?? parseTime(ds.session.createdAt)
    ?? ds.lastMessageAt
    ?? ds.spawnedAt;
}

export function shouldSendIdleCloseReminder(ds: DaemonSession, opts: IdleCloseReminderOptions): boolean {
  if (opts.enabled === false) return false;
  if (opts.thresholdMs <= 0) return false;
  if (ds.session.status !== 'active') return false;

  const now = opts.now ?? Date.now();
  const lastActivityAt = sessionLastActivityAt(ds);
  if (now - lastActivityAt < opts.thresholdMs) return false;

  const liveWorker = !!ds.worker && !ds.worker.killed;
  const status = ds.lastScreenStatus ?? 'idle';
  if (liveWorker && status !== 'idle' && status !== 'limited') return false;

  const snoozedUntil = parseTime(ds.session.idleCloseSnoozedUntil);
  if (snoozedUntil && snoozedUntil > now) return false;

  const sentAt = parseTime(ds.session.idleCloseReminderSentAt);
  if (sentAt && sentAt >= lastActivityAt && (!snoozedUntil || sentAt >= snoozedUntil)) return false;

  return true;
}

export async function scanIdleCloseReminders(
  activeSessions: Map<string, DaemonSession>,
  deps: IdleCloseReminderDeps,
  opts: IdleCloseReminderOptions = {
    enabled: config.idleCloseReminder.enabled,
    thresholdMs: config.idleCloseReminder.thresholdHours * 60 * 60 * 1000,
    snoozeMs: config.idleCloseReminder.snoozeHours * 60 * 60 * 1000,
  },
): Promise<number> {
  if (opts.enabled === false) return 0;
  const now = opts.now ?? Date.now();
  let sent = 0;
  for (const ds of activeSessions.values()) {
    if (!shouldSendIdleCloseReminder(ds, { ...opts, now })) continue;
    const larkAppId = ds.larkAppId;
    const cliId = ds.session.cliId ?? getBot(larkAppId).config.cliId;
    const idleMs = now - sessionLastActivityAt(ds);
    const anchor = sessionAnchorId(ds);
    const card = buildIdleCloseReminderCard(
      ds.session.sessionId,
      anchor,
      ds.session.title,
      idleMs,
      opts.snoozeMs,
      cliId,
      !!ds.session.adoptedFrom || !!ds.adoptedFrom,
      localeForBot(larkAppId),
    );
    try {
      await deps.sessionReply(anchor, card, 'interactive', larkAppId);
      ds.session.idleCloseReminderSentAt = new Date(now).toISOString();
      ds.session.idleCloseSnoozedUntil = undefined;
      sessionStore.updateSession(ds.session);
      sent += 1;
      logger.info(`[${ds.session.sessionId.substring(0, 8)}] idle-close reminder sent after ${Math.round(idleMs / 1000)}s idle`);
    } catch (err) {
      logger.warn(`[${ds.session.sessionId.substring(0, 8)}] idle-close reminder failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return sent;
}

export function startIdleCloseReminderScanner(
  activeSessions: Map<string, DaemonSession>,
  deps: IdleCloseReminderDeps,
): IdleCloseReminderScannerHandle | undefined {
  if (!config.idleCloseReminder.enabled) {
    logger.info('[idle-close-reminder] disabled');
    return undefined;
  }
  const thresholdMs = config.idleCloseReminder.thresholdHours * 60 * 60 * 1000;
  const snoozeMs = config.idleCloseReminder.snoozeHours * 60 * 60 * 1000;
  const scanIntervalMs = Math.max(MIN_SCAN_INTERVAL_MS, config.idleCloseReminder.scanIntervalMs);
  const tick = () => {
    scanIdleCloseReminders(activeSessions, deps, { thresholdMs, snoozeMs }).catch(err =>
      logger.warn(`[idle-close-reminder] scan failed: ${err instanceof Error ? err.message : String(err)}`));
  };
  const startup = setTimeout(tick, STARTUP_SCAN_DELAY_MS);
  startup.unref?.();
  const interval = setInterval(tick, scanIntervalMs);
  interval.unref?.();
  logger.info(`[idle-close-reminder] enabled threshold=${config.idleCloseReminder.thresholdHours}h scan=${scanIntervalMs}ms snooze=${config.idleCloseReminder.snoozeHours}h`);
  return {
    interval,
    startup,
    stop: () => {
      clearTimeout(startup);
      clearInterval(interval);
    },
  };
}
