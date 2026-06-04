import { describe, it, expect } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { parseWorkerRequestUrl, resolveWorkerHttpHost } from '../src/utils/worker-http.js';

function req(url: string | undefined, host?: string): Pick<IncomingMessage, 'url' | 'headers'> {
  return {
    url,
    headers: host === undefined ? {} : { host },
  } as Pick<IncomingMessage, 'url' | 'headers'>;
}

describe('parseWorkerRequestUrl', () => {
  it('parses normal worker HTTP paths and query params', () => {
    const url = parseWorkerRequestUrl(req('/?token=secret', '127.0.0.1:1234'));

    expect(url?.pathname).toBe('/');
    expect(url?.searchParams.get('token')).toBe('secret');
  });

  it('returns null instead of throwing for invalid protocol-relative URLs', () => {
    const url = parseWorkerRequestUrl(req('//..%252f..%252fetc%252fpasswd', '10.0.0.1:1234'));

    expect(url).toBeNull();
  });

  it('uses localhost as a safe base when Host is missing', () => {
    const url = parseWorkerRequestUrl(req('/terminal'));

    expect(url?.host).toBe('localhost');
    expect(url?.pathname).toBe('/terminal');
  });
});

describe('resolveWorkerHttpHost', () => {
  it('keeps the historical default of listening on all interfaces', () => {
    expect(resolveWorkerHttpHost({})).toBe('0.0.0.0');
  });

  it('follows WEB_HOST when worker HTTP host is not configured', () => {
    expect(resolveWorkerHttpHost({ WEB_HOST: '192.0.2.10' })).toBe('192.0.2.10');
  });

  it('allows explicit worker HTTP host override', () => {
    expect(resolveWorkerHttpHost({ BOTMUX_WORKER_HTTP_HOST: '127.0.0.1' })).toBe('127.0.0.1');
  });

  it('falls back to BOTMUX_WORKER_HOST for shorter deployments', () => {
    expect(resolveWorkerHttpHost({ BOTMUX_WORKER_HOST: '::1' })).toBe('::1');
  });

  it('ignores blank overrides', () => {
    expect(resolveWorkerHttpHost({ BOTMUX_WORKER_HTTP_HOST: '  ' })).toBe('0.0.0.0');
  });
});
