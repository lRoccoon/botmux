import type { IncomingMessage } from 'node:http';

type EnvLike = Partial<Record<string, string | undefined>>;

export function getConfiguredWorkerHttpHost(env: EnvLike = process.env): string | undefined {
  const raw = env.BOTMUX_WORKER_HTTP_HOST ?? env.BOTMUX_WORKER_HOST;
  const host = raw?.trim();
  return host || undefined;
}

export function resolveWorkerHttpHost(env: EnvLike = process.env): string {
  const webHost = env.WEB_HOST?.trim();
  return (getConfiguredWorkerHttpHost(env) ?? webHost) || '0.0.0.0';
}

export function parseWorkerRequestUrl(req: Pick<IncomingMessage, 'url' | 'headers'>): URL | null {
  const host = typeof req.headers.host === 'string' && req.headers.host.trim()
    ? req.headers.host.trim()
    : 'localhost';
  try {
    return new URL(req.url ?? '/', `http://${host}`);
  } catch {
    return null;
  }
}
