/**
 * `/reply-mode` is a sessionless, pre-routing command. Keep it out of the
 * generic daemon-command path so status can be canTalk while mutations stay
 * canOperate, and so toggling the group setting never creates a phantom session.
 */
import { isBotMentioned, canOperate, extractMessageTextForRouting } from './event-dispatcher.js';
import { stripLeadingMentions } from './message-parser.js';
import { getChatMode, replyMessage } from './client.js';
import { localeForBot, t } from '../../i18n/index.js';
import { getChatReplyMode, normalizeChatReplyMode, setChatReplyMode } from '../../services/chat-reply-mode-store.js';
import { logger } from '../../utils/logger.js';

export async function tryHandleReplyModeCommand(
  larkAppId: string,
  message: any,
  senderOpenId: string | undefined,
  canTalk: boolean,
): Promise<boolean> {
  const rawText = extractMessageTextForRouting(message);
  if (!rawText) return false;
  const text = stripLeadingMentions(rawText.trim(), message?.mentions ?? []);
  const match = /^\/reply-mode(?:\s+(\S+))?\s*$/i.exec(text);
  if (!match) return false;

  // Multi-bot groups: only the explicitly @mentioned bot owns this command.
  if (!isBotMentioned(larkAppId, message, senderOpenId)) return true;

  const chatId: string | undefined = message.chat_id;
  const messageId: string | undefined = message.message_id;
  const loc = localeForBot(larkAppId);
  const reply = (content: string) => messageId
    ? replyMessage(larkAppId, messageId, content, 'text', false)
        .catch(err => logger.warn(`[reply-mode] reply failed: ${err?.message ?? err}`))
    : Promise.resolve();
  const arg = match[1]?.trim().toLowerCase();
  const isStatus = !arg || arg === 'status';

  if (message.chat_type === 'p2p' || !chatId || (await getChatMode(larkAppId, chatId)) !== 'group') {
    await reply(t('cmd.reply_mode.unsupported', undefined, loc));
    return true;
  }

  if (isStatus) {
    if (!canTalk) return true;
    const mode = getChatReplyMode(larkAppId, chatId);
    await reply(t('cmd.reply_mode.status', { mode: mode === 'topic_alias' ? 'topic' : 'chat' }, loc));
    return true;
  }

  const mode = normalizeChatReplyMode(arg);
  if (!mode) {
    await reply(t('cmd.reply_mode.usage', undefined, loc));
    return true;
  }
  if (!canOperate(larkAppId, chatId, senderOpenId)) {
    await reply(t('cmd.reply_mode.owner_only', undefined, loc));
    return true;
  }
  const res = await setChatReplyMode(larkAppId, chatId, mode);
  if (!res.ok) {
    await reply(t('cmd.reply_mode.failed', { reason: res.reason }, loc));
    return true;
  }
  await reply(t('cmd.reply_mode.updated', { mode: mode === 'topic_alias' ? 'topic' : 'chat' }, loc));
  return true;
}
