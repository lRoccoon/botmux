import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDesktopPetSnapshot, type DesktopPetSnapshot } from './snapshot.js';

export const desktopPetCookieName = 'botmux_desktop_pet';
export const desktopPetTokenHeader = 'x-botmux-desktop-pet-token';

export interface DesktopPetServerOptions {
  token?: string;
  assetRoot?: string;
  snapshot?: () => DesktopPetSnapshot | Promise<DesktopPetSnapshot>;
  quit?: () => void;
}

export interface DesktopPetServerHandle {
  url: string;
  browserUrl: string;
  token: string;
  close: () => Promise<void>;
}

type RequestHandler = (request: Request) => Promise<Response>;

const assetRoot = fileURLToPath(new URL('./assets/', import.meta.url));

export function createDesktopPetRequestHandler(options: DesktopPetServerOptions = {}): RequestHandler {
  const token = options.token ?? generateDesktopPetToken();
  const root = options.assetRoot ?? assetRoot;
  const snapshot = options.snapshot ?? (() => buildDesktopPetSnapshot());

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (!hasValidToken(request, token, url)) {
      return new Response('forbidden', { status: 403 });
    }

    if (url.pathname === '/api/snapshot') {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response('method not allowed', { status: 405 });
      }
      return jsonResponse(await snapshot(), tokenFromQueryCookie(url, token));
    }

    if (url.pathname === '/api/quit') {
      if (request.method !== 'POST') {
        return new Response('method not allowed', { status: 405 });
      }
      options.quit?.();
      return jsonResponse({ ok: true }, tokenFromQueryCookie(url, token));
    }

    return fileResponse(root, url.pathname, tokenFromQueryCookie(url, token));
  };
}

export async function startDesktopPetServer(options: DesktopPetServerOptions = {}): Promise<DesktopPetServerHandle> {
  const token = options.token ?? generateDesktopPetToken();
  const handler = createDesktopPetRequestHandler({ ...options, token });
  const server = createServer((req, res) => {
    handleNodeRequest(req, res, handler).catch((err) => {
      res.statusCode = 500;
      res.end(err instanceof Error ? err.message : String(err));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    server.close();
    throw new Error('desktop pet server did not bind to a TCP address');
  }
  return {
    token,
    url: `http://127.0.0.1:${addr.port}/`,
    browserUrl: `http://127.0.0.1:${addr.port}/?token=${encodeURIComponent(token)}`,
    close: () => new Promise((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
    }),
  };
}

export function generateDesktopPetToken(): string {
  return randomBytes(24).toString('base64url');
}

function hasValidToken(request: Request, expected: string, url: URL): boolean {
  const fromHeader = request.headers.get(desktopPetTokenHeader);
  if (constantEqual(fromHeader, expected)) return true;
  if (constantEqual(url.searchParams.get('token'), expected)) return true;
  const cookieHeader = request.headers.get('cookie') ?? '';
  return constantEqual(parseCookie(cookieHeader)[desktopPetCookieName], expected);
}

function tokenFromQueryCookie(url: URL, token: string): string | undefined {
  return url.searchParams.get('token') === token ? token : undefined;
}

function constantEqual(candidate: string | null | undefined, expected: string): boolean {
  if (!candidate) return false;
  const left = createHash('sha256').update(candidate).digest();
  const right = createHash('sha256').update(expected).digest();
  return timingSafeEqual(left, right);
}

function parseCookie(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    if (!key) continue;
    out[key] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

function jsonResponse(payload: unknown, setCookieToken?: string): Response {
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-cache',
  });
  if (setCookieToken) setCookie(headers, setCookieToken);
  return new Response(JSON.stringify(payload, null, 2), { status: 200, headers });
}

function fileResponse(root: string, rawPath: string, setCookieToken?: string): Response {
  let relative = rawPath === '/' ? 'index.html' : rawPath.replace(/^\/+/, '');
  if (relative.startsWith('assets/')) {
    relative = relative.slice('assets/'.length);
  }
  const normalized = normalize(relative);
  if (normalized.startsWith('..') || normalized.includes('/../')) {
    return new Response('not found', { status: 404 });
  }
  const path = join(root, normalized);
  if (!existsSync(path) || !statSync(path).isFile()) {
    return new Response('not found', { status: 404 });
  }
  const body = createReadStream(path) as unknown as BodyInit;
  const headers = new Headers({
    'content-type': contentType(path),
    'cache-control': 'no-store',
  });
  if (setCookieToken) setCookie(headers, setCookieToken);
  return new Response(body, { status: 200, headers });
}

function setCookie(headers: Headers, token: string): void {
  headers.set('set-cookie', `${desktopPetCookieName}=${encodeURIComponent(token)}; Path=/; SameSite=Strict; HttpOnly`);
}

function contentType(path: string): string {
  if (path.endsWith('.html')) return 'text/html; charset=utf-8';
  if (path.endsWith('.css')) return 'text/css; charset=utf-8';
  if (path.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.webp')) return 'image/webp';
  if (path.endsWith('.gif')) return 'image/gif';
  return 'application/octet-stream';
}

async function handleNodeRequest(req: IncomingMessage, res: ServerResponse, handler: RequestHandler): Promise<void> {
  const host = req.headers.host ?? '127.0.0.1';
  const request = new Request(`http://${host}${req.url ?? '/'}`, {
    method: req.method,
    headers: req.headers as Record<string, string>,
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req as unknown as BodyInit,
    duplex: req.method === 'GET' || req.method === 'HEAD' ? undefined : 'half',
  } as RequestInit);
  const response = await handler(request);
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  if (request.method === 'HEAD' || !response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    res.write(value);
  }
  res.end();
}
