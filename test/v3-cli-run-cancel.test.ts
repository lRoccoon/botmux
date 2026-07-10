import { describe, expect, it, vi } from 'vitest';

import {
  V3RunCancelDaemonError,
  formatV3RunCancelCliSuccess,
  parseV3RunCancelCliOptions,
  postV3RunCancel,
} from '../src/cli/v3-run-cancel.js';

const auth = { ts: '123', nonce: 'nonce', sig: 'signature' };

describe('v3 workflow cancel CLI transport', () => {
  it('strictly parses only reason/bot flags and rejects flag confusion or extras', () => {
    expect(parseV3RunCancelCliOptions([
      '--reason', 'stop now', '--bot=cli_owner',
    ])).toEqual({ ok: true, reason: 'stop now', larkAppId: 'cli_owner' });
    expect(parseV3RunCancelCliOptions(['--reason', '--bot', 'cli_owner']))
      .toEqual({ ok: false, error: '--reason 需要非空值' });
    expect(parseV3RunCancelCliOptions(['--reason=a', '--reason=b']))
      .toEqual({ ok: false, error: '参数重复：--reason' });
    expect(parseV3RunCancelCliOptions(['surprise']))
      .toEqual({ ok: false, error: '未知或多余参数：surprise' });
  });

  it('POSTs the encoded run to the owning daemon with the optional reason', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      runId: 'run.a',
      status: 'cancelling',
      cancelRequestId: 'cancel-1',
      alreadyRequested: false,
    }), { status: 202 }));

    await expect(postV3RunCancel({
      ipcPort: 12345,
      runId: 'run.a',
      reason: 'stop now',
      auth,
      fetchImpl,
    })).resolves.toMatchObject({ status: 'cancelling', cancelRequestId: 'cancel-1' });
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:12345/api/v3/runs/run.a/cancel',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ reason: 'stop now' }),
        headers: expect.objectContaining({
          'X-Botmux-Cli-Ts': auth.ts,
          'X-Botmux-Cli-Nonce': auth.nonce,
          'X-Botmux-Cli-Auth': auth.sig,
        }),
      }),
    );
  });

  it('fails loudly on daemon rejection or malformed success instead of claiming cancellation', async () => {
    await expect(postV3RunCancel({
      ipcPort: 1,
      runId: 'r',
      auth,
      fetchImpl: vi.fn().mockResolvedValue(new Response('{"error":"wrong_daemon"}', { status: 409 })),
    })).rejects.toBeInstanceOf(V3RunCancelDaemonError);

    await expect(postV3RunCancel({
      ipcPort: 1,
      runId: 'r',
      auth,
      fetchImpl: vi.fn().mockResolvedValue(new Response('{}', { status: 200 })),
    })).rejects.toThrow(/无效的成功响应/);
  });

  it('distinguishes durable acceptance, idempotent replay, and pre-existing terminal state', () => {
    expect(formatV3RunCancelCliSuccess({
      ok: true, runId: 'r', status: 'cancelling', cancelRequestId: 'c1',
    })).toContain('取消请求已持久化');
    expect(formatV3RunCancelCliSuccess({
      ok: true, runId: 'r', status: 'cancelling', cancelRequestId: 'c1', alreadyRequested: true,
    })).toContain('取消请求已存在');
    expect(formatV3RunCancelCliSuccess({
      ok: true, runId: 'r', status: 'succeeded', alreadyTerminal: true,
    })).toContain('未写入取消请求');
    expect(formatV3RunCancelCliSuccess({
      ok: true, runId: 'r', status: 'cancelled', alreadyTerminal: true,
    })).toContain('已取消');
  });
});
