/**
 * Per-chat reply mode for regular groups. The setting is bot-scoped and keyed
 * by chat_id: Bot A can prefer topic replies in one group while Bot B or another
 * group stays on the legacy flat chat replies.
 */
import { rmwBotEntry } from './config-store.js';
import { getBot, type ChatReplyMode } from '../bot-registry.js';
import { logger } from '../utils/logger.js';

export type { ChatReplyMode } from '../bot-registry.js';

export function normalizeChatReplyMode(raw: string | undefined): ChatReplyMode | undefined {
  const v = raw?.trim().toLowerCase();
  if (!v || v === 'status') return undefined;
  if (v === 'chat') return 'chat';
  if (v === 'topic' || v === 'topic_alias') return 'topic_alias';
  return undefined;
}

export function getChatReplyMode(larkAppId: string, chatId: string | undefined): ChatReplyMode {
  if (!chatId) return 'chat';
  try {
    return getBot(larkAppId).config.chatReplyModes?.[chatId] ?? 'chat';
  } catch {
    return 'chat';
  }
}

export async function setChatReplyMode(
  larkAppId: string,
  chatId: string,
  mode: ChatReplyMode,
): Promise<{ ok: true; mode: ChatReplyMode } | { ok: false; reason: string }> {
  let bot;
  try { bot = getBot(larkAppId); } catch { return { ok: false, reason: 'bot_not_registered' }; }

  const r = await rmwBotEntry<ChatReplyMode>(larkAppId, (entry) => {
    if (!entry.chatReplyModes || typeof entry.chatReplyModes !== 'object' || Array.isArray(entry.chatReplyModes)) {
      entry.chatReplyModes = {};
    }
    if (mode === 'chat') {
      delete entry.chatReplyModes[chatId];
      if (Object.keys(entry.chatReplyModes).length === 0) delete entry.chatReplyModes;
    } else {
      entry.chatReplyModes[chatId] = mode;
    }
    return { write: true, result: mode };
  });
  if (!r.ok) return { ok: false, reason: r.reason };

  const next = { ...(bot.config.chatReplyModes ?? {}) };
  if (mode === 'chat') delete next[chatId];
  else next[chatId] = mode;
  bot.config.chatReplyModes = Object.keys(next).length > 0 ? next : undefined;
  logger.info(`[reply-mode:${larkAppId}] chat=${chatId} mode=${mode}`);
  return { ok: true, mode };
}
