import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { TriggerRequest, TriggerResponse } from '../services/trigger-types.js';
import type { VcMeetingWorkflowPayload } from './types.js';

export interface OnlineDaemonRef {
  ipcPort: number;
  larkAppId: string;
  lastHeartbeat?: number;
}

export function defaultBotmuxDataDir(): string {
  return process.env.SESSION_DATA_DIR ?? join(homedir(), '.botmux', 'data');
}

export function listOnlineDaemons(dataDir: string = defaultBotmuxDataDir()): OnlineDaemonRef[] {
  const regDir = join(dataDir, 'dashboard-daemons');
  if (!existsSync(regDir)) return [];
  const staleMs = 90_000;
  const now = Date.now();
  const out: OnlineDaemonRef[] = [];
  for (const name of readdirSync(regDir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(readFileSync(join(regDir, name), 'utf-8')) as Partial<OnlineDaemonRef>;
      if (typeof raw.ipcPort !== 'number' || typeof raw.larkAppId !== 'string') continue;
      if (now - (raw.lastHeartbeat ?? 0) > staleMs) continue;
      out.push({ ipcPort: raw.ipcPort, larkAppId: raw.larkAppId, lastHeartbeat: raw.lastHeartbeat });
    } catch {
      // Ignore malformed stale descriptors.
    }
  }
  return out;
}

export function findOnlineDaemon(larkAppId?: string, dataDir: string = defaultBotmuxDataDir()): OnlineDaemonRef | null {
  const daemons = listOnlineDaemons(dataDir);
  if (larkAppId) return daemons.find((d) => d.larkAppId === larkAppId) ?? null;
  return daemons[0] ?? null;
}

export function buildVcMeetingTriggerRequest(input: {
  larkAppId: string;
  workflowId: string;
  chatId: string;
  payload: VcMeetingWorkflowPayload;
  requestId?: string;
  instruction?: string;
}): TriggerRequest {
  return {
    source: {
      type: 'vc_meeting',
      requestId: input.requestId ?? `vc_${input.payload.meeting.id}_${input.payload.poll.ordinal}`,
      receivedAt: new Date().toISOString(),
    },
    target: {
      kind: 'workflow',
      botId: input.larkAppId,
      chatId: input.chatId,
      workflowId: input.workflowId,
    },
    envelope: {
      format: 'botmux.vc-meeting.v1',
      sourceName: input.payload.source === 'lark:vc.bot.meeting_activity_v1'
        ? 'lark-vc-agent-push'
        : 'lark-vc-agent-polling',
      trusted: false,
      payload: input.payload,
    },
    ...(input.instruction ? { instruction: input.instruction } : {}),
  };
}

export async function dispatchVcMeetingWorkflow(input: {
  daemon: OnlineDaemonRef;
  trigger: TriggerRequest;
}): Promise<TriggerResponse> {
  const res = await fetch(`http://127.0.0.1:${input.daemon.ipcPort}/api/trigger`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input.trigger),
  });
  const text = await res.text();
  let body: TriggerResponse;
  try {
    body = JSON.parse(text) as TriggerResponse;
  } catch {
    body = { ok: false, errorCode: 'trigger_failed', error: `non-json trigger response (${res.status}): ${text.slice(0, 200)}` };
  }
  if (!res.ok && body.ok) {
    return { ok: false, errorCode: 'trigger_failed', error: `trigger HTTP ${res.status}` };
  }
  return body;
}
