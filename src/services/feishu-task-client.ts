import { getBot } from '../bot-registry.js';
import { logger } from '../utils/logger.js';
import { resolveUserToken } from '../utils/user-token.js';

const FEISHU_TASK_API_BASE = 'https://open.feishu.cn/open-apis/task/v2';

export interface FeishuTaskRef {
  guid: string;
  url?: string;
}

export class FeishuTaskUnavailableError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'FeishuTaskUnavailableError';
  }
}

interface FeishuApiResponse<T = any> {
  code?: number;
  msg?: string;
  data?: T;
}

async function resolveToken(larkAppId: string): Promise<string> {
  const bot = getBot(larkAppId);
  const token = await resolveUserToken(bot.config.larkAppId, bot.config.larkAppSecret);
  if (!token) {
    throw new FeishuTaskUnavailableError('missing_user_token');
  }
  return token;
}

async function requestFeishuTask<T>(larkAppId: string, path: string, init: RequestInit): Promise<T> {
  const token = await resolveToken(larkAppId);
  const res = await fetch(`${FEISHU_TASK_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
      ...(init.headers ?? {}),
    },
  });

  let body: FeishuApiResponse<T> | undefined;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text) as FeishuApiResponse<T>;
    } catch (err) {
      throw new FeishuTaskUnavailableError(`invalid_response:${res.status}`, err);
    }
  }

  if (!res.ok || (body?.code ?? 0) !== 0) {
    const code = body?.code ?? res.status;
    const msg = body?.msg ?? res.statusText;
    throw new FeishuTaskUnavailableError(`feishu_task_api_error:${code}:${msg}`);
  }

  return (body?.data ?? {}) as T;
}

function trimDescription(description: string): string {
  // Feishu task description supports up to 3000 UTF-8 chars. Keep a little
  // room in case multi-byte chars are counted differently by the gateway.
  return description.length <= 2800 ? description : `${description.slice(0, 2790)}...`;
}

export function buildBotmuxTaskDescription(input: {
  localTaskId: string;
  sessionId: string;
  chatId: string;
  anchor: string;
  larkAppId: string;
  ownerOpenId?: string;
}): string {
  return trimDescription([
    'Created by botmux.',
    '',
    `botmux task id: ${input.localTaskId}`,
    `session id: ${input.sessionId}`,
    `chat id: ${input.chatId}`,
    `thread/anchor: ${input.anchor}`,
    `lark app id: ${input.larkAppId}`,
    input.ownerOpenId ? `owner open_id: ${input.ownerOpenId}` : undefined,
    '',
    'Use the botmux /task commands in the original chat to inspect, assign, or close the linked CLI task.',
  ].filter(Boolean).join('\n'));
}

function extractTaskGuid(data: any): string | undefined {
  return data?.task?.guid ?? data?.task?.task_guid ?? data?.guid ?? data?.task_guid;
}

function extractTaskUrl(data: any): string | undefined {
  return data?.task?.url ?? data?.task?.origin?.href?.url ?? data?.url;
}

export async function createFeishuTask(input: {
  larkAppId: string;
  summary: string;
  localTaskId: string;
  sessionId: string;
  chatId: string;
  anchor: string;
  ownerOpenId?: string;
}): Promise<FeishuTaskRef> {
  const description = buildBotmuxTaskDescription(input);
  const payload = {
    summary: input.summary,
    description,
    origin: {
      platform_i18n_name: { zh_cn: 'botmux', en_us: 'botmux' },
      href: {
        url: 'https://github.com/deepcoldy/botmux',
        title: `botmux ${input.localTaskId}`,
      },
    },
    extra: JSON.stringify({
      source: 'botmux',
      localTaskId: input.localTaskId,
      sessionId: input.sessionId,
      chatId: input.chatId,
      anchor: input.anchor,
      larkAppId: input.larkAppId,
    }),
  };

  const data = await requestFeishuTask<any>(input.larkAppId, '/tasks', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  const guid = extractTaskGuid(data);
  if (!guid) throw new FeishuTaskUnavailableError('missing_task_guid');
  logger.info(`[feishu-task] Created task ${guid} for local task ${input.localTaskId}`);
  return { guid, url: extractTaskUrl(data) };
}

export async function completeFeishuTask(larkAppId: string, taskGuid: string): Promise<void> {
  await requestFeishuTask(larkAppId, `/tasks/${encodeURIComponent(taskGuid)}`, {
    method: 'PATCH',
    body: JSON.stringify({
      update_fields: ['completed_at'],
      task: { completed_at: String(Date.now()) },
    }),
  });
  logger.info(`[feishu-task] Completed task ${taskGuid}`);
}

export async function addFeishuTaskAssignee(larkAppId: string, taskGuid: string, openId: string): Promise<void> {
  await requestFeishuTask(larkAppId, `/tasks/${encodeURIComponent(taskGuid)}/add_members`, {
    method: 'POST',
    body: JSON.stringify({
      members: [{ id: openId, type: 'user', role: 'assignee' }],
    }),
  });
  logger.info(`[feishu-task] Added assignee ${openId} to task ${taskGuid}`);
}
