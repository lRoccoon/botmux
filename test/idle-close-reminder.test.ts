import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/config.js', () => ({
  config: {
    idleCloseReminder: {
      enabled: true,
      thresholdHours: 24,
      scanIntervalMs: 30 * 60 * 1000,
      snoozeHours: 24,
    },
  },
}));

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({ config: { cliId: 'codex' } })),
}));

vi.mock('../src/i18n/index.js', () => ({
  localeForBot: vi.fn(() => 'zh'),
  t: (key: string, vars?: Record<string, any>) => {
    const dict: Record<string, string> = {
      'card.idle_close.title': 'Idle reminder',
      'card.idle_close.body': 'idle {idleFor} title {title} {adoptNote}',
      'card.idle_close.adopt_note': 'adopt note',
      'card.btn.close_session': 'close',
      'card.btn.keep_session': 'keep',
      'card.btn.remind_later': 'later',
    };
    return (dict[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => String(vars?.[k] ?? ''));
  },
}));

vi.mock('../src/services/session-store.js', () => ({
  updateSession: vi.fn(),
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { scanIdleCloseReminders, shouldSendIdleCloseReminder, startIdleCloseReminderScanner } from '../src/core/idle-close-reminder.js';
import * as sessionStore from '../src/services/session-store.js';
import type { DaemonSession } from '../src/core/types.js';

const NOW = Date.parse('2026-06-08T12:00:00.000Z');

function makeDs(overrides: Partial<DaemonSession> & { session?: Partial<DaemonSession['session']> } = {}): DaemonSession {
  const session: DaemonSession['session'] = {
    sessionId: 'sid-1',
    chatId: 'oc_chat',
    rootMessageId: 'om_root',
    title: 'Test Session',
    status: 'active',
    createdAt: new Date(NOW - 48 * 60 * 60 * 1000).toISOString(),
    lastMessageAt: new Date(NOW - 25 * 60 * 60 * 1000).toISOString(),
    larkAppId: 'app_test',
    cliId: 'codex',
    ...overrides.session,
  };
  const rest = { ...overrides };
  delete rest.session;
  return {
    worker: null,
    workerPort: null,
    workerToken: null,
    larkAppId: 'app_test',
    chatId: session.chatId,
    chatType: 'group',
    scope: 'thread',
    spawnedAt: NOW - 48 * 60 * 60 * 1000,
    cliVersion: 'test',
    lastMessageAt: Date.parse(session.lastMessageAt ?? session.createdAt),
    hasHistory: true,
    ...rest,
    session,
  } as DaemonSession;
}

describe('idle close reminder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('selects idle sessions older than the threshold', () => {
    const ds = makeDs({ lastScreenStatus: 'idle' });
    expect(shouldSendIdleCloseReminder(ds, { thresholdMs: 24 * 60 * 60 * 1000, snoozeMs: 24 * 60 * 60 * 1000, now: NOW })).toBe(true);
  });

  it('skips live working sessions', () => {
    const ds = makeDs({ worker: { killed: false } as any, lastScreenStatus: 'working' });
    expect(shouldSendIdleCloseReminder(ds, { thresholdMs: 24 * 60 * 60 * 1000, snoozeMs: 24 * 60 * 60 * 1000, now: NOW })).toBe(false);
  });

  it('skips snoozed sessions', () => {
    const ds = makeDs({ session: { idleCloseSnoozedUntil: new Date(NOW + 60_000).toISOString() } });
    expect(shouldSendIdleCloseReminder(ds, { thresholdMs: 24 * 60 * 60 * 1000, snoozeMs: 24 * 60 * 60 * 1000, now: NOW })).toBe(false);
  });

  it('skips duplicate reminders until new activity or snooze expiry', () => {
    const ds = makeDs({ session: { idleCloseReminderSentAt: new Date(NOW - 60_000).toISOString() } });
    expect(shouldSendIdleCloseReminder(ds, { thresholdMs: 24 * 60 * 60 * 1000, snoozeMs: 24 * 60 * 60 * 1000, now: NOW })).toBe(false);

    const snoozed = makeDs({
      session: {
        idleCloseReminderSentAt: new Date(NOW - 24 * 60 * 60 * 1000).toISOString(),
        idleCloseSnoozedUntil: new Date(NOW - 60_000).toISOString(),
      },
    });
    expect(shouldSendIdleCloseReminder(snoozed, { thresholdMs: 24 * 60 * 60 * 1000, snoozeMs: 24 * 60 * 60 * 1000, now: NOW })).toBe(true);
  });

  it('sends card and persists sent timestamp', async () => {
    const ds = makeDs();
    const sessionReply = vi.fn(async () => 'om_card');
    const sent = await scanIdleCloseReminders(new Map([['k', ds]]), { sessionReply }, {
      thresholdMs: 24 * 60 * 60 * 1000,
      snoozeMs: 24 * 60 * 60 * 1000,
      now: NOW,
    });

    expect(sent).toBe(1);
    expect(sessionReply).toHaveBeenCalledWith('om_root', expect.stringContaining('idle 1d1h'), 'interactive', 'app_test');
    expect(ds.session.idleCloseReminderSentAt).toBe(new Date(NOW).toISOString());
    expect(sessionStore.updateSession).toHaveBeenCalledWith(ds.session);
  });

  it('stops both startup and interval timers', () => {
    vi.useFakeTimers();
    try {
      const ds = makeDs();
      const sessionReply = vi.fn(async () => 'om_card');
      const handle = startIdleCloseReminderScanner(new Map([['k', ds]]), { sessionReply });
      handle?.stop();

      vi.advanceTimersByTime(31 * 60 * 1000);

      expect(sessionReply).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
