/**
 * cmd-hook.test.ts
 *
 * 测试 runHook 核心逻辑（依赖注入方式，不依赖真实 daemon / env / stdin）。
 * cmdHook 本身仅作薄包装（读 stdin + 调 runHook），不在本文件中直接测试。
 */

import { describe, it, expect, vi } from 'vitest';
import { runHook } from '../src/cli.js';
import type { AskResult } from '../src/core/ask-types.js';
import claudeAdapter from '../src/core/ask-hook/claude-code.js';

// ── Claude AskUserQuestion payload fixture ─────────────────────────────────────

const claudeAskPayload = {
  hook_event_name: 'PermissionRequest',
  tool_name: 'AskUserQuestion',
  tool_input: {
    questions: [
      {
        question: '继续还是取消？',
        multiSelect: false,
        options: [{ label: '继续' }, { label: '取消' }],
      },
    ],
  },
};

// 非 askUserQuestion 的 Claude payload（PreToolUse）
const claudePreToolPayload = {
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'echo hi' },
};

// 完整的 botmux env
const FULL_ENV: Record<string, string | undefined> = {
  BOTMUX_SESSION_ID: 'sess_test_1',
  BOTMUX_CHAT_ID: 'oc_chatxxx',
  BOTMUX_LARK_APP_ID: 'cli_appxxx',
  BOTMUX_ROOT_MESSAGE_ID: 'om_rootxxx',
};

// 构造一个正常返回 answered 的 postAskFn stub
function makeAnsweredStub(answers: string[][]): () => Promise<AskResult> {
  return async () => ({
    kind: 'answered',
    answers: answers as ReadonlyArray<ReadonlyArray<string>>,
    by: 'ou_user1',
    comment: null,
    timedOut: false,
  });
}

// 构造一个抛出错误的 postAskFn stub
function makeThrowingStub(msg = 'daemon unreachable'): () => Promise<AskResult> {
  return async () => {
    throw Object.assign(new Error(msg), { exitCode: 3 });
  };
}

// ── 测试 ───────────────────────────────────────────────────────────────────────

describe('runHook', () => {
  describe('(a) Claude AskUserQuestion + answered stub → stdout 含答案', () => {
    it('formatAnswer 结果写入 stdout', async () => {
      const stub = makeAnsweredStub([['继续']]);
      const result = await runHook(claudeAskPayload, FULL_ENV, stub, 'claude-code');
      expect(result.stdout).toBeTruthy();
      // 输出应为合法 JSON
      const directive = JSON.parse(result.stdout);
      // Claude directive 应包含 hookSpecificOutput
      expect(JSON.stringify(directive)).toContain('继续');
    });
  });

  describe('(b) postAskFn 抛错 → 输出 passthrough，不抛出', () => {
    it('任何 postAsk 错误均优雅放行', async () => {
      const stub = makeThrowingStub('daemon unreachable');
      // 不应抛出
      let result: Awaited<ReturnType<typeof runHook>>;
      expect(async () => {
        result = await runHook(claudeAskPayload, FULL_ENV, stub, 'claude-code');
      }).not.toThrow();

      result = await runHook(claudeAskPayload, FULL_ENV, stub, 'claude-code');
      // 输出应为 passthrough directive（behavior=allow + 空 answers）
      const expected = claudeAdapter.passthrough(claudeAskPayload);
      expect(result.stdout).toBe(expected);
    });
  });

  describe('(c) 非 askUserQuestion payload → passthrough', () => {
    it('PreToolUse payload → parseQuestions 返回 null → passthrough', async () => {
      const stub = makeAnsweredStub([['继续']]);
      const result = await runHook(claudePreToolPayload, FULL_ENV, stub, 'claude-code');
      // 应为 passthrough（stub 不应被调用）
      const expected = claudeAdapter.passthrough(claudePreToolPayload);
      expect(result.stdout).toBe(expected);
    });
  });

  describe('env 缺失 → passthrough 放行', () => {
    it('BOTMUX_SESSION_ID 缺失 → passthrough', async () => {
      const stub = makeAnsweredStub([['继续']]);
      const env = { ...FULL_ENV, BOTMUX_SESSION_ID: undefined };
      const result = await runHook(claudeAskPayload, env, stub, 'claude-code');
      const expected = claudeAdapter.passthrough(claudeAskPayload);
      expect(result.stdout).toBe(expected);
    });

    it('BOTMUX_CHAT_ID 缺失 → passthrough', async () => {
      const stub = makeAnsweredStub([['继续']]);
      const env = { ...FULL_ENV, BOTMUX_CHAT_ID: undefined };
      const result = await runHook(claudeAskPayload, env, stub, 'claude-code');
      const expected = claudeAdapter.passthrough(claudeAskPayload);
      expect(result.stdout).toBe(expected);
    });
  });

  describe('BOTMUX_WORKFLOW=1 → passthrough（不弹 UI）', () => {
    it('workflow gate → passthrough', async () => {
      const stub = vi.fn(makeAnsweredStub([['继续']]));
      const env = { ...FULL_ENV, BOTMUX_WORKFLOW: '1' };
      const result = await runHook(claudeAskPayload, env, stub, 'claude-code');
      // stub 不应被调用
      expect(stub).not.toHaveBeenCalled();
      const expected = claudeAdapter.passthrough(claudeAskPayload);
      expect(result.stdout).toBe(expected);
    });
  });

  describe('未知 cliId → stdout 为空字符串', () => {
    it('getHookAdapter 返回 undefined → stdout=""', async () => {
      const stub = makeAnsweredStub([['继续']]);
      const result = await runHook(claudeAskPayload, FULL_ENV, stub, 'unknown-cli-xyz');
      expect(result.stdout).toBe('');
    });
  });

  describe('timedOut / invalidated → passthrough', () => {
    it('timedOut → passthrough', async () => {
      const timedOutStub = async (): Promise<AskResult> => ({
        kind: 'timedOut',
        selected: null,
        by: null,
        comment: null,
        timedOut: true,
      });
      const result = await runHook(claudeAskPayload, FULL_ENV, timedOutStub, 'claude-code');
      const expected = claudeAdapter.passthrough(claudeAskPayload);
      expect(result.stdout).toBe(expected);
    });

    it('invalidated → passthrough', async () => {
      const invalidatedStub = async (): Promise<AskResult> => ({
        kind: 'invalidated',
        reason: 'test_invalidated',
        selected: null,
        by: null,
        comment: null,
        timedOut: false,
      });
      const result = await runHook(claudeAskPayload, FULL_ENV, invalidatedStub, 'claude-code');
      const expected = claudeAdapter.passthrough(claudeAskPayload);
      expect(result.stdout).toBe(expected);
    });
  });

  describe('BOTMUX_ASK_TIMEOUT_MS env', () => {
    it('有效正整数 → 覆盖默认 timeout 传给 postAskFn', async () => {
      let capturedBody: Record<string, unknown> | undefined;
      const captureStub = async (body: Record<string, unknown>): Promise<AskResult> => {
        capturedBody = body;
        return { kind: 'answered', answers: [['继续']], by: 'ou_u', comment: null, timedOut: false };
      };
      const env = { ...FULL_ENV, BOTMUX_ASK_TIMEOUT_MS: '7200000' };
      await runHook(claudeAskPayload, env, captureStub, 'claude-code');
      expect(capturedBody?.timeoutMs).toBe(7_200_000);
    });

    it('无效值 → 使用默认 3600000', async () => {
      let capturedBody: Record<string, unknown> | undefined;
      const captureStub = async (body: Record<string, unknown>): Promise<AskResult> => {
        capturedBody = body;
        return { kind: 'answered', answers: [['继续']], by: 'ou_u', comment: null, timedOut: false };
      };
      const env = { ...FULL_ENV, BOTMUX_ASK_TIMEOUT_MS: 'not_a_number' };
      await runHook(claudeAskPayload, env, captureStub, 'claude-code');
      expect(capturedBody?.timeoutMs).toBe(3_600_000);
    });
  });
});
