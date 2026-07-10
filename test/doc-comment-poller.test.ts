import { describe, expect, it } from 'vitest';
import type { DocComment } from '../src/im/lark/doc-comment.js';
import {
  docCommentRepliesAfterCursor,
  flattenDocCommentReplies,
  latestDocCommentPollCursor,
} from '../src/core/doc-comment-poller.js';

const comments: DocComment[] = [
  {
    commentId: 'comment-1',
    isSolved: false,
    quote: '选中的正文',
    isWhole: false,
    replies: [
      { replyId: '100', userId: 'ou_a', text: '历史问题', mentions: [], createdAt: 10 },
      { replyId: '102', userId: 'ou_b', text: '同秒的新回复', mentions: [], createdAt: 20 },
    ],
  },
  {
    commentId: 'comment-2',
    isSolved: false,
    isWhole: true,
    replies: [
      { replyId: '101', userId: 'ou_c', text: '普通评论，不含 @', mentions: [], createdAt: 20 },
      { replyId: '103', userId: 'ou_c', text: '最后一条', mentions: [], createdAt: 21 },
    ],
  },
];

describe('doc comment polling cursor', () => {
  it('orders replies by timestamp and numeric reply id while preserving thread context', () => {
    const replies = flattenDocCommentReplies(comments);
    expect(replies.map(reply => reply.replyId)).toEqual(['100', '101', '102', '103']);
    expect(replies.find(reply => reply.replyId === '102')?.priorReplies).toEqual([
      { authorOpenId: 'ou_a', text: '历史问题' },
    ]);
    expect(replies.find(reply => reply.replyId === '101')?.mentions).toEqual([]);
  });

  it('returns only replies after the persisted cursor, including same-second ids', () => {
    expect(docCommentRepliesAfterCursor(comments, { createdAt: 20, replyId: '101' })
      .map(reply => reply.replyId)).toEqual(['102', '103']);
    expect(latestDocCommentPollCursor(comments)).toMatchObject({ createdAt: 21, replyId: '103' });
  });
});
