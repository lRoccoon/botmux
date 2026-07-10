/** Small testable transport seam for `botmux workflow cancel`. */

export interface V3RunCancelDaemonResult {
  ok: true;
  runId: string;
  status: 'cancelling' | 'cancelled' | 'succeeded' | 'failed';
  cancelRequestId?: string;
  alreadyRequested?: boolean;
  alreadyTerminal?: boolean;
}

export class V3RunCancelDaemonError extends Error {
  constructor(
    public readonly status: number,
    public readonly responseBody: string,
  ) {
    super(`cancel 失败 (HTTP ${status}): ${responseBody}`);
    this.name = 'V3RunCancelDaemonError';
  }
}

export type V3RunCancelCliOptions =
  | { ok: true; reason?: string; larkAppId?: string }
  | { ok: false; error: string };

/** Strict parser for the destructive cancel verb. Unknown/duplicate flags and
 * flag-shaped values fail before authority lookup or any durable mutation. */
export function parseV3RunCancelCliOptions(args: string[]): V3RunCancelCliOptions {
  let reason: string | undefined;
  let larkAppId: string | undefined;
  const seen = new Set<'reason' | 'bot'>();
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    const matched = token === '--reason' || token.startsWith('--reason=')
      ? { key: 'reason' as const, flag: '--reason' }
      : token === '--bot' || token.startsWith('--bot=')
        ? { key: 'bot' as const, flag: '--bot' }
        : undefined;
    if (!matched) return { ok: false, error: `未知或多余参数：${token}` };
    if (seen.has(matched.key)) return { ok: false, error: `参数重复：${matched.flag}` };
    seen.add(matched.key);

    const raw = token === matched.flag
      ? args[++i]
      : token.slice(matched.flag.length + 1);
    if (raw === undefined || raw.startsWith('--') || !raw.trim()) {
      return { ok: false, error: `${matched.flag} 需要非空值` };
    }
    if (matched.key === 'reason') reason = raw.trim();
    else larkAppId = raw.trim();
  }
  return {
    ok: true,
    ...(reason ? { reason } : {}),
    ...(larkAppId ? { larkAppId } : {}),
  };
}

export async function postV3RunCancel(input: {
  ipcPort: number;
  runId: string;
  reason?: string;
  auth: { ts: string; nonce: string; sig: string };
  fetchImpl?: typeof fetch;
}): Promise<V3RunCancelDaemonResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(
    `http://127.0.0.1:${input.ipcPort}/api/v3/runs/${encodeURIComponent(input.runId)}/cancel`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Botmux-Cli-Ts': input.auth.ts,
        'X-Botmux-Cli-Nonce': input.auth.nonce,
        'X-Botmux-Cli-Auth': input.auth.sig,
      },
      body: JSON.stringify(input.reason ? { reason: input.reason } : {}),
    },
  );
  const text = await response.text();
  if (!response.ok) throw new V3RunCancelDaemonError(response.status, text);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new V3RunCancelDaemonError(response.status, 'daemon 返回了无法解析的成功响应');
  }
  if (!parsed || typeof parsed !== 'object' || (parsed as { ok?: unknown }).ok !== true) {
    throw new V3RunCancelDaemonError(response.status, 'daemon 返回了无效的成功响应');
  }
  const result = parsed as Partial<V3RunCancelDaemonResult>;
  if (
    typeof result.runId !== 'string' ||
    !['cancelling', 'cancelled', 'succeeded', 'failed'].includes(String(result.status))
  ) {
    throw new V3RunCancelDaemonError(response.status, 'daemon 成功响应缺少有效 runId/status');
  }
  return result as V3RunCancelDaemonResult;
}

export function formatV3RunCancelCliSuccess(result: V3RunCancelDaemonResult): string {
  if (result.alreadyTerminal) {
    return result.status === 'cancelled'
      ? `⏹️ v3 run "${result.runId}" 已取消。`
      : `ℹ️ v3 run "${result.runId}" 已是终态（${result.status}），未写入取消请求。`;
  }
  return result.alreadyRequested
    ? `⏳ v3 run "${result.runId}" 的取消请求已存在，正在收敛。`
    : `⏹️ v3 run "${result.runId}" 的取消请求已持久化，正在中断活动节点并收敛。`;
}
