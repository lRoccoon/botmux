/**
 * Sender-name resolution, layers 3 & 4 — the fallbacks beyond identity-cache's
 * cache (layer 1) and contact.v3.user.get (layer 2). Invoked by the daemon
 * ONLY when layers 1-2 missed AND the sender is a real user (the daemon gates
 * `sender_type === 'user'` so we never probe a bot — see the call site).
 *
 *   Layer 3 — chat members: list ONE page of the chat's members (name source
 *     that needs no 通讯录可见范围). The sender is by definition a member of the
 *     chat it just posted in, so this resolves typical (≤100-member) groups and
 *     seeds the whole page into the cache for free.
 *   Layer 4 — proactive @ probe: when layer 3 misses (big group / not on page
 *     1), @-mention the sender in-place (NEVER a private DM — bots can't DM
 *     strangers), read the name Lark backfills into the sent message, then
 *     recall it. The probe text is `/introduce` so that if the gate ever
 *     misfires onto a bot, the receiver short-circuits via its existing
 *     /introduce handler instead of spawning a CLI turn.
 *
 * Returns the resolved name or undefined; degrades silently (no throws) so the
 * caller can fall through to rendering the open_id.
 */
import { logger } from '../../utils/logger.js';
import { recordIdentity } from './identity-cache.js';
import type { ResolvedSender } from './identity-cache.js';
import {
  listChatMembersWithNames,
  sendMessage,
  replyMessage,
  getMessageDetail,
  deleteMessage,
} from './client.js';

export interface SenderNameCtx {
  chatId: string;
  scope: 'thread' | 'chat';
  /** Thread root message_id (thread-scope) — used so the probe replies inside
   *  the thread rather than spawning a new topic. */
  anchor?: string;
  /** Probe text; MUST keep `/introduce` at command position so a misfired bot
   *  short-circuits. Defaults to `/introduce`. */
  probeText?: string;
}

/**
 * Daemon-facing gate + merge: run the fallback layers ONLY for a nameless real
 * user, then fold the resolved name back into the sender. Keeps the gate
 * (`type === 'user'`, no existing name, has chatId) in one tested place so the
 * daemon call sites stay one-liners. A bot sender is returned untouched — this
 * is what structurally prevents the probe from ever @-ing (and looping with)
 * another bot.
 */
export async function enrichSenderName(
  larkAppId: string,
  sender: ResolvedSender | undefined,
  ctx: SenderNameCtx,
): Promise<ResolvedSender | undefined> {
  if (!sender) return sender;
  if (sender.name) return sender;
  if (sender.type !== 'user') return sender;
  if (!ctx?.chatId) return sender;
  const name = await resolveSenderNameFallback(larkAppId, sender.openId, ctx);
  return name ? { ...sender, name } : sender;
}

export async function resolveSenderNameFallback(
  larkAppId: string,
  openId: string,
  ctx: SenderNameCtx,
): Promise<string | undefined> {
  if (!openId || !ctx?.chatId) return undefined;

  // ── Layer 3: chat members (one page) ──────────────────────────────────────
  const members = await listChatMembersWithNames(larkAppId, ctx.chatId, 1);
  for (const member of members) {
    recordIdentity(larkAppId, { openId: member.openId, name: member.name, type: 'user', source: 'chat_member' });
  }
  const fromMembers = members.find((member) => member.openId === openId)?.name;
  if (fromMembers) return fromMembers;

  // ── Layer 4: proactive @ probe + recall ───────────────────────────────────
  return probeNameViaMention(larkAppId, openId, ctx);
}

async function probeNameViaMention(
  larkAppId: string,
  openId: string,
  ctx: SenderNameCtx,
): Promise<string | undefined> {
  // `<at user_id=...>` is the inline @ form Lark backfills with the display
  // name on send; after the receiver strips the leading @ the text is
  // `/introduce`, matching its INTRODUCE_RE short-circuit.
  const text = `<at user_id="${openId}"></at> ${ctx.probeText ?? '/introduce'}`;

  let messageId: string | undefined;
  try {
    messageId =
      ctx.scope === 'thread' && ctx.anchor
        ? await replyMessage(larkAppId, ctx.anchor, text, 'text', true)
        : await sendMessage(larkAppId, ctx.chatId, text, 'text');
  } catch (err) {
    logger.debug(`[identity] name probe send failed for ${openId.substring(0, 12)}: ${err}`);
    return undefined;
  }

  let name: string | undefined;
  try {
    // userCardContent:false → plain GET (no card_msg_content_type param),
    // matching the verified path for a text message; mentions[].name is what we read.
    const detail = await getMessageDetail(larkAppId, messageId, { userCardContent: false });
    const msg = Array.isArray(detail?.items) ? detail.items[0] : detail;
    const mention = (msg?.mentions ?? []).find((mt: any) => mt?.id === openId);
    if (typeof mention?.name === 'string' && mention.name) {
      name = mention.name;
      recordIdentity(larkAppId, { openId, name, type: 'user', source: 'introduce_probe' });
    }
  } catch (err) {
    logger.debug(`[identity] name probe read failed for ${openId.substring(0, 12)}: ${err}`);
  } finally {
    // Always recall — an un-recalled probe is exactly the visible noise we're
    // trying to avoid. Best-effort: a failed recall just leaves a stray line.
    await deleteMessage(larkAppId, messageId).catch(() => {});
  }
  return name;
}
