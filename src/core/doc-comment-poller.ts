import type { DocComment } from '../im/lark/doc-comment.js';

export interface DocCommentPollCursor {
  createdAt: number;
  replyId: string;
}

export interface PolledDocReply extends DocCommentPollCursor {
  commentId: string;
  isWhole: boolean;
  selectedText?: string;
  authorOpenId?: string;
  text: string;
  mentions: string[];
  priorReplies: Array<{ authorOpenId?: string; text: string }>;
}

function compareReplyIds(a: string, b: string): number {
  try {
    const aa = BigInt(a);
    const bb = BigInt(b);
    return aa < bb ? -1 : aa > bb ? 1 : 0;
  } catch {
    return a.localeCompare(b);
  }
}

export function compareDocCommentPollCursor(a: DocCommentPollCursor, b: DocCommentPollCursor): number {
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return compareReplyIds(a.replyId, b.replyId);
}

export function flattenDocCommentReplies(comments: DocComment[]): PolledDocReply[] {
  return comments.flatMap(comment => comment.replies.map((reply, index) => ({
    commentId: comment.commentId,
    replyId: reply.replyId,
    createdAt: reply.createdAt ?? 0,
    isWhole: comment.isWhole === true,
    selectedText: comment.quote,
    authorOpenId: reply.userId,
    text: reply.text,
    mentions: reply.mentions,
    priorReplies: comment.replies.slice(0, index).map(previous => ({
      authorOpenId: previous.userId,
      text: previous.text,
    })),
  }))).filter(reply => reply.replyId && reply.createdAt > 0)
    .sort(compareDocCommentPollCursor);
}

export function latestDocCommentPollCursor(comments: DocComment[]): DocCommentPollCursor | undefined {
  return flattenDocCommentReplies(comments).at(-1);
}

export function docCommentRepliesAfterCursor(
  comments: DocComment[],
  cursor: DocCommentPollCursor,
): PolledDocReply[] {
  return flattenDocCommentReplies(comments).filter(reply => compareDocCommentPollCursor(reply, cursor) > 0);
}
