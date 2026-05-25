import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PendingAsk } from '../src/core/ask-types.js';
import {
  _getPending,
  _resetForTest,
  registerAsk,
  setCardDispatcher,
} from '../src/core/ask-broker.js';
import {
  ASK_SELECT_ACTION,
  ASK_SUBMIT_ACTION,
  buildAskCard,
  createLarkAskCardDispatcher,
  handleAskCardAction,
} from '../src/im/lark/ask-card.js';

afterEach(() => {
  _resetForTest();
});

/** 构造一个带 questions/askId/nonce/deadlineAt/approvers 的 PendingAsk。 */
function makePending(overrides: Partial<PendingAsk> = {}): PendingAsk {
  return {
    askId: 'ask-1',
    nonce: 'nonce-1',
    larkAppId: 'cli_ask',
    chatId: 'oc_chat',
    rootMessageId: 'om_root',
    sessionId: 'sess-1',
    approvers: new Set(['ou_owner']),
    questions: [
      {
        prompt: '线上 latency 涨了 30%，下一步怎么处理？',
        options: [
          { key: 'deploy', label: '继续发布' },
          { key: 'rollback', label: '回滚' },
          { key: 'abort', label: '中止' },
        ],
        multiSelect: false,
      },
    ],
    createdAt: 1_000,
    deadlineAt: 1_000 + 300_000,
    settled: false,
    ...overrides,
  };
}

describe('buildAskCard', () => {
  it('多问卡片：每问一个分区 + 选项组件 + 一个 submit', () => {
    const ask = makePending({
      questions: [
        { prompt: 'q1', multiSelect: false, options: [{ key: 'y', label: '是' }, { key: 'n', label: '否' }] },
        { prompt: 'q2', multiSelect: true, options: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }] },
      ],
    });
    const json = JSON.parse(buildAskCard(ask));
    const blob = JSON.stringify(json);

    // 每问的 prompt 文本出现在卡片中
    expect(blob).toContain('q1');
    expect(blob).toContain('q2');

    // submit 按钮 action 存在
    expect(blob).toContain(ASK_SUBMIT_ACTION);

    // 每问的选项 value 编码 questionIndex::key
    expect(blob).toContain('0::y');
    expect(blob).toContain('1::a');
  });

  it('单问卡片：渲染 prompt、approver、ask_id、nonce', () => {
    const card = JSON.parse(buildAskCard(makePending()));
    const text = JSON.stringify(card);

    expect(card.header.title.content).toBe('botmux ask');
    expect(text).toContain('线上 latency');
    // approver 应在卡片的 meta div fields 中（经 escapeMd 处理后 _ 被转义为 \_）
    const metaDiv = card.elements[0];
    expect(metaDiv.fields[1].text.content).toContain('ou\\_owner');
    expect(text).toContain('"ask_id":"ask-1"');
    expect(text).toContain('"nonce":"nonce-1"');
    // 单选：select_static
    expect(text).toContain('select_static');
    expect(text).toContain('继续发布');
  });

  it('单问单选：使用 select_static，多问多选：使用 multi_select_static', () => {
    const ask = makePending({
      questions: [
        { prompt: 'single', multiSelect: false, options: [{ key: 'y', label: '是' }, { key: 'n', label: '否' }] },
        { prompt: 'multi', multiSelect: true, options: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }] },
      ],
    });
    const blob = buildAskCard(ask);
    expect(blob).toContain('"select_static"');
    expect(blob).toContain('"multi_select_static"');
  });

  it('settled 态（answered）：渲染答案摘要、无可点组件', () => {
    const ask = makePending({
      questions: [{ prompt: 'q', multiSelect: false, options: [{ key: 'y', label: '是' }, { key: 'n', label: '否' }] }],
    });
    const json = JSON.parse(buildAskCard(ask, {
      kind: 'answered',
      answers: [['y']],
      by: 'ou_u',
      comment: null,
      timedOut: false,
    }));
    const text = JSON.stringify(json);

    expect(json.header.template).toBe('green');
    // 答案摘要包含"已选择"文字
    expect(text).toContain('已选择');
    // 选中标签"是"出现在卡片中
    expect(text).toContain('是');
    // 不含任何 action 动作（无可交互组件）
    expect(text).not.toContain(ASK_SELECT_ACTION);
    expect(text).not.toContain(ASK_SUBMIT_ACTION);
  });

  it('settled 态（answered）：多问多选答案各问均渲染', () => {
    const ask = makePending({
      questions: [
        { prompt: 'q1', multiSelect: false, options: [{ key: 'y', label: '是' }, { key: 'n', label: '否' }] },
        { prompt: 'q2', multiSelect: true, options: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }] },
      ],
    });
    const text = buildAskCard(ask, {
      kind: 'answered',
      answers: [['y'], ['a', 'b']],
      by: 'ou_u',
      comment: null,
      timedOut: false,
    });
    // 两问的标签均出现
    expect(text).toContain('是');
    expect(text).toContain('A');
    expect(text).toContain('B');
  });

  it('settled 态（timedOut）：渲染超时文字', () => {
    const text = buildAskCard(makePending(), {
      kind: 'timedOut',
      selected: null,
      by: null,
      comment: null,
      timedOut: true,
    });
    expect(text).toContain('超时');
  });
});

describe('handleAskCardAction', () => {
  it('旧单选路径 ask_select：resolves pending ask，返回 undefined（无 toast）', async () => {
    let askId = '';
    setCardDispatcher({
      async send(ask) {
        askId = ask.askId;
        return { messageId: 'om_ask' };
      },
    });
    const promise = registerAsk({
      larkAppId: 'cli_ask',
      chatId: 'oc_chat',
      rootMessageId: 'om_root',
      sessionId: 'sess-1',
      approvers: new Set(['ou_owner']),
      questions: makePending().questions,
      timeoutMs: 10_000,
    });
    await Promise.resolve();
    const pending = _getPending(askId);
    expect(pending).toBeDefined();

    // nonce 不匹配 → stale
    const stale = handleAskCardAction({
      operator: { open_id: 'ou_owner' },
      action: {
        value: {
          action: ASK_SELECT_ACTION,
          ask_id: askId,
          nonce: 'should-not-match',
          key: 'deploy',
        },
      },
    });
    expect(stale?.toast.content).toContain('失效');

    // 正确 nonce + key → accepted
    const accepted = handleAskCardAction({
      operator: { open_id: 'ou_owner' },
      action: {
        value: {
          action: ASK_SELECT_ACTION,
          ask_id: askId,
          nonce: pending!.nonce,
          key: 'deploy',
        },
      },
    });
    expect(accepted).toBeUndefined();
    await expect(promise).resolves.toMatchObject({ kind: 'answered', answers: [['deploy']], by: 'ou_owner' });
  });

  it('旧单选路径 ask_select：非授权人返回 warning toast', async () => {
    let captured: PendingAsk | undefined;
    setCardDispatcher({
      async send(ask) {
        captured = ask;
        return { messageId: 'om_ask' };
      },
    });
    registerAsk({
      larkAppId: 'cli_ask',
      chatId: 'oc_chat',
      rootMessageId: 'om_root',
      sessionId: 'sess-1',
      approvers: new Set(['ou_owner']),
      questions: makePending().questions,
      timeoutMs: 10_000,
    });
    await Promise.resolve();

    const result = handleAskCardAction({
      operator: { open_id: 'ou_intruder' },
      action: {
        value: {
          action: ASK_SELECT_ACTION,
          ask_id: captured!.askId,
          nonce: captured!.nonce,
          key: 'deploy',
        },
      },
    });
    expect(result?.toast.type).toBe('warning');
    expect(result?.toast.content).toContain('没有权限');
  });
});

describe('createLarkAskCardDispatcher', () => {
  it('replies into the root thread when rootMessageId exists', async () => {
    const reply = vi.fn(async () => 'om_reply');
    const send = vi.fn(async () => 'om_send');
    const dispatcher = createLarkAskCardDispatcher({ replyMessage: reply as any, sendMessage: send as any });

    await expect(dispatcher.send(makePending())).resolves.toEqual({ messageId: 'om_reply' });
    expect(reply).toHaveBeenCalledWith('cli_ask', 'om_root', expect.any(String), 'interactive', true);
    expect(send).not.toHaveBeenCalled();
  });

  it('sends to chat when rootMessageId is absent and patches on settle', async () => {
    const update = vi.fn(async () => undefined);
    const send = vi.fn(async () => 'om_send');
    const dispatcher = createLarkAskCardDispatcher({ sendMessage: send as any, updateMessage: update as any });
    const ask = makePending({ rootMessageId: null, cardMessageId: 'om_card' });

    await expect(dispatcher.send(ask)).resolves.toEqual({ messageId: 'om_send' });
    expect(send).toHaveBeenCalledWith('cli_ask', 'oc_chat', expect.any(String), 'interactive');

    await dispatcher.onSettle?.(ask, {
      kind: 'timedOut',
      selected: null,
      by: null,
      comment: null,
      timedOut: true,
    });
    expect(update).toHaveBeenCalledWith('cli_ask', 'om_card', expect.stringContaining('超时'));
  });
});
