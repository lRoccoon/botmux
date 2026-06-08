import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DesktopPetRowState } from './rows.js';

export interface BotmuxPetSession {
  sessionId: string;
  status?: 'starting' | 'working' | 'idle' | 'analyzing' | 'limited' | 'closed' | string;
  pendingRepo?: boolean;
  tuiPromptActive?: boolean;
  lastMessageAt?: number;
  closedAt?: number;
}

export interface BotmuxPetStatusInput {
  nowMs?: number;
  onlineDaemons: number;
  sessions: BotmuxPetSession[];
  source?: 'live' | 'disk' | 'offline';
}

export interface BotmuxPetStatus {
  source: 'live' | 'disk' | 'offline';
  onlineDaemons: number;
  activeSessions: number;
  busySessions: number;
  analyzingSessions: number;
  limitedSessions: number;
  attentionSessions: number;
  idleSessions: number;
  recentClosedSessions: number;
  action: DesktopPetRowState;
  message: string;
  signature: string;
  updatedAt: string;
}

interface DaemonDescriptor {
  larkAppId: string;
  ipcPort: number;
  lastHeartbeat?: number;
}

const STALE_DAEMON_MS = 90_000;
const RECENT_CLOSED_MS = 2 * 60_000;

export function summarizeBotmuxPetStatus(input: BotmuxPetStatusInput): BotmuxPetStatus {
  const nowMs = input.nowMs ?? Date.now();
  const onlineDaemons = input.onlineDaemons;
  const sessions = input.sessions;
  const active = sessions.filter((session) => session.status !== 'closed');
  const attention = active.filter((session) => session.pendingRepo || session.tuiPromptActive);
  const limited = active.filter((session) => session.status === 'limited');
  const working = active.filter((session) => session.status === 'working' || session.status === 'starting');
  const analyzing = active.filter((session) => session.status === 'analyzing');
  const idle = active.filter((session) => session.status === 'idle' || !session.status);
  const recentClosed = sessions.filter((session) =>
    session.status === 'closed'
    && typeof session.closedAt === 'number'
    && nowMs - session.closedAt <= RECENT_CLOSED_MS
  );

  let action: DesktopPetRowState = 'idle';
  let message = 'Ready to help';

  if (onlineDaemons === 0) {
    action = 'side-sleep';
    message = 'Botmux is offline';
  } else if (attention.length > 0) {
    action = 'alert-surprise';
    message = 'Needs your choice';
  } else if (limited.length > 0) {
    action = 'plug-charging';
    message = 'Waiting for more energy';
  } else if (working.length > 0) {
    action = 'running-right';
    message = `Working on ${working.length} session${working.length === 1 ? '' : 's'}`;
  } else if (analyzing.length > 0) {
    action = 'idea-thinking';
    message = 'Thinking through a session';
  } else if (recentClosed.length > 0) {
    action = 'review';
    message = 'Session wrapped up';
  } else if (active.length > 0) {
    action = idle.length > 0 ? 'waiting' : 'idle';
    message = `${active.length} session${active.length === 1 ? '' : 's'} standing by`;
  }

  const source = onlineDaemons === 0 ? 'offline' : (input.source ?? 'live');
  return {
    source,
    onlineDaemons,
    activeSessions: active.length,
    busySessions: working.length,
    analyzingSessions: analyzing.length,
    limitedSessions: limited.length,
    attentionSessions: attention.length,
    idleSessions: idle.length,
    recentClosedSessions: recentClosed.length,
    action,
    message,
    signature: [
      source,
      onlineDaemons,
      active.length,
      working.length,
      analyzing.length,
      limited.length,
      attention.length,
      recentClosed.length,
      action,
    ].join(':'),
    updatedAt: new Date(nowMs).toISOString(),
  };
}

export async function readBotmuxPetStatus(options: {
  dataDir?: string;
  nowMs?: number;
  fetchImpl?: typeof fetch;
} = {}): Promise<BotmuxPetStatus> {
  const nowMs = options.nowMs ?? Date.now();
  const dataDir = options.dataDir ?? resolveBotmuxDataDir();
  const daemons = listOnlineDaemonDescriptors(dataDir, nowMs);
  const fetchImpl = options.fetchImpl ?? fetch;
  const liveSessions = await fetchLiveSessions(daemons, fetchImpl);

  if (liveSessions.length > 0 || daemons.length > 0) {
    return summarizeBotmuxPetStatus({
      nowMs,
      onlineDaemons: daemons.length,
      sessions: liveSessions,
      source: 'live',
    });
  }

  const diskSessions = readDiskSessions(dataDir);
  return summarizeBotmuxPetStatus({
    nowMs,
    onlineDaemons: 0,
    sessions: diskSessions,
    source: diskSessions.length > 0 ? 'disk' : 'offline',
  });
}

export function resolveBotmuxDataDir(home = homedir()): string {
  if (process.env.SESSION_DATA_DIR) return process.env.SESSION_DATA_DIR;
  const configDir = join(home, '.botmux');
  const breadcrumb = join(configDir, '.data-dir');
  if (existsSync(breadcrumb)) {
    try {
      const dir = readFileSync(breadcrumb, 'utf-8').trim();
      if (dir) return dir;
    } catch { /* ignore */ }
  }
  return join(configDir, 'data');
}

function listOnlineDaemonDescriptors(dataDir: string, nowMs: number): DaemonDescriptor[] {
  const dir = join(dataDir, 'dashboard-daemons');
  if (!existsSync(dir)) return [];
  const out: DaemonDescriptor[] = [];
  for (const file of safeReaddir(dir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const descriptor = JSON.parse(readFileSync(join(dir, file), 'utf-8')) as Partial<DaemonDescriptor>;
      if (typeof descriptor.larkAppId !== 'string' || typeof descriptor.ipcPort !== 'number') continue;
      if (nowMs - (descriptor.lastHeartbeat ?? 0) > STALE_DAEMON_MS) continue;
      out.push({
        larkAppId: descriptor.larkAppId,
        ipcPort: descriptor.ipcPort,
        lastHeartbeat: descriptor.lastHeartbeat,
      });
    } catch { /* skip malformed descriptors */ }
  }
  return out;
}

async function fetchLiveSessions(daemons: DaemonDescriptor[], fetchImpl: typeof fetch): Promise<BotmuxPetSession[]> {
  const sessions = new Map<string, BotmuxPetSession>();
  await Promise.all(daemons.map(async (daemon) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 450);
    try {
      const response = await fetchImpl(`http://127.0.0.1:${daemon.ipcPort}/api/sessions`, {
        signal: controller.signal,
      });
      if (!response.ok) return;
      const payload = await response.json() as { sessions?: unknown[] };
      for (const row of payload.sessions ?? []) {
        const session = normalizeLiveSession(row);
        if (session) sessions.set(session.sessionId, session);
      }
    } catch { /* a stale descriptor can still fail between heartbeat checks */ }
    finally {
      clearTimeout(timer);
    }
  }));
  return [...sessions.values()];
}

function normalizeLiveSession(row: unknown): BotmuxPetSession | null {
  if (!row || typeof row !== 'object') return null;
  const value = row as Record<string, unknown>;
  if (typeof value.sessionId !== 'string') return null;
  return {
    sessionId: value.sessionId,
    status: typeof value.status === 'string' ? value.status : undefined,
    pendingRepo: Boolean(value.pendingRepo),
    tuiPromptActive: Boolean(value.tuiPromptActive),
    lastMessageAt: typeof value.lastMessageAt === 'number' ? value.lastMessageAt : undefined,
    closedAt: typeof value.closedAt === 'number' ? value.closedAt : undefined,
  };
}

function readDiskSessions(dataDir: string): BotmuxPetSession[] {
  const sessions = new Map<string, BotmuxPetSession>();
  for (const file of safeReaddir(dataDir)) {
    if (!file.startsWith('sessions') || !file.endsWith('.json')) continue;
    try {
      const data = JSON.parse(readFileSync(join(dataDir, file), 'utf-8')) as Record<string, Record<string, unknown>>;
      for (const raw of Object.values(data)) {
        if (!raw || typeof raw.sessionId !== 'string') continue;
        sessions.set(raw.sessionId, {
          sessionId: raw.sessionId,
          status: typeof raw.status === 'string' ? raw.status : undefined,
          lastMessageAt: parseTime(raw.lastMessageAt),
          closedAt: parseTime(raw.closedAt),
        });
      }
    } catch { /* skip malformed session files */ }
  }
  return [...sessions.values()];
}

function parseTime(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
