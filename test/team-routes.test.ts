/**
 * Team platform routes: pairing-login flow + authenticated roster, via mock
 * req/res. Underlying stores/handlers are unit-tested separately; this guards
 * the routing + cookie + auth-gate glue.
 * Run: pnpm vitest run test/team-routes.test.ts
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';
import { handleTeamRoute } from '../src/dashboard/team-routes.js';
import { claimPairing } from '../src/services/pairing-store.js';

let dataDir: string;
beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'botmux-teamroutes-')); });

function makeReq(method: string, path: string, opts: { cookie?: string; body?: unknown } = {}): any {
  const req: any = { method, url: path, headers: { cookie: opts.cookie } };
  req[Symbol.asyncIterator] = async function* () {
    if (opts.body !== undefined) yield Buffer.from(JSON.stringify(opts.body));
  };
  return req;
}
function makeRes(): any {
  const res: any = { statusCode: 0, _headers: {} as Record<string, any>, _body: '' };
  res.setHeader = (k: string, v: any) => { res._headers[k.toLowerCase()] = v; };
  res.getHeader = (k: string) => res._headers[k.toLowerCase()];
  res.writeHead = (s: number, h?: Record<string, any>) => {
    res.statusCode = s;
    if (h) for (const [k, v] of Object.entries(h)) res._headers[k.toLowerCase()] = v;
  };
  res.end = (b?: string) => { res._body = b ?? ''; };
  return res;
}
const call = (req: any, res: any, path: string) => handleTeamRoute(req, res, new URL('http://x' + path), { dataDir });
const json = (res: any) => JSON.parse(res._body);
function cookieValue(res: any, name: string): string {
  const sc = res._headers['set-cookie'];
  const arr = Array.isArray(sc) ? sc : [sc];
  const hit = arr.find((c: string) => c?.startsWith(`${name}=`))!;
  return decodeURIComponent(hit.slice(name.length + 1, hit.indexOf(';')));
}

describe('handleTeamRoute', () => {
  it('returns false for unrelated paths', async () => {
    expect(await call(makeReq('GET', '/api/sessions'), makeRes(), '/api/sessions')).toBe(false);
  });

  it('full login flow: start → claim → consume → authed roster', async () => {
    writeFileSync(join(dataDir, 'bots-info.json'), JSON.stringify([
      { larkAppId: 'cli_a', botOpenId: 'ou_a', botName: '后端Bot', cliId: 'codex' },
    ]));

    // start
    let res = makeRes();
    expect(await call(makeReq('POST', '/api/pairing/start'), res, '/api/pairing/start')).toBe(true);
    const { pairingId, code } = json(res);
    const browserToken = cookieValue(res, 'bmx_pair');

    // user sends the code to the bot → daemon claims
    claimPairing(dataDir, code, { openId: 'ou_1', unionId: 'on_1', name: '张三' });

    // consume (first login bootstraps the team) → session cookie
    res = makeRes();
    await call(makeReq('POST', '/api/pairing/consume', { cookie: `bmx_pair=${browserToken}`, body: { pairingId } }), res, '/api/pairing/consume');
    expect(res.statusCode).toBe(200);
    const session = cookieValue(res, 'bmx_session');
    expect(session.length).toBeGreaterThan(20);

    // authed roster
    res = makeRes();
    await call(makeReq('GET', '/api/team/roster', { cookie: `bmx_session=${session}` }), res, '/api/team/roster');
    expect(res.statusCode).toBe(200);
    const roster = json(res);
    expect(roster.bots.map((b: any) => b.name)).toEqual(['后端Bot']);
    expect(roster.team.memberCount).toBe(1);
  });

  it('serves the team SPA page at GET /team (public)', async () => {
    const res = makeRes();
    expect(await call(makeReq('GET', '/team'), res, '/team')).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res._headers['content-type']).toContain('text/html');
    expect(res._body).toContain('botmux 团队平台');
  });

  it('team APIs require a session (401 without bmx_session)', async () => {
    const res = makeRes();
    await call(makeReq('GET', '/api/team/roster'), res, '/api/team/roster');
    expect(res.statusCode).toBe(401);
  });

  async function login(): Promise<string> {
    writeFileSync(join(dataDir, 'bots-info.json'), JSON.stringify([
      { larkAppId: 'cli_a', botOpenId: 'ou_a', botName: '后端Bot', cliId: 'codex' },
    ]));
    let res = makeRes();
    await call(makeReq('POST', '/api/pairing/start'), res, '/api/pairing/start');
    const { pairingId, code } = json(res);
    const browserToken = cookieValue(res, 'bmx_pair');
    claimPairing(dataDir, code, { openId: 'ou_1', unionId: 'on_1', name: '张三' });
    res = makeRes();
    await call(makeReq('POST', '/api/pairing/consume', { cookie: 'bmx_pair=' + browserToken, body: { pairingId } }), res, '/api/pairing/consume');
    return cookieValue(res, 'bmx_session');
  }

  it('PUT capability is reflected in the roster', async () => {
    const session = await login();
    const c = 'bmx_session=' + session;
    let res = makeRes();
    await call(makeReq('PUT', '/api/team/bots/cli_a/capability', { cookie: c, body: { capability: '服务端排查' } }), res, '/api/team/bots/cli_a/capability');
    expect(res.statusCode).toBe(200);
    res = makeRes();
    await call(makeReq('GET', '/api/team/roster', { cookie: c }), res, '/api/team/roster');
    expect(json(res).bots.find((b: any) => b.larkAppId === 'cli_a').capability).toBe('服务端排查');
  });

  it('PUT then GET team role round-trips', async () => {
    const session = await login();
    const c = 'bmx_session=' + session;
    await call(makeReq('PUT', '/api/team/bots/cli_a/role', { cookie: c, body: { role: '# 后端\n严谨' } }), makeRes(), '/api/team/bots/cli_a/role');
    const res = makeRes();
    await call(makeReq('GET', '/api/team/bots/cli_a/role', { cookie: c }), res, '/api/team/bots/cli_a/role');
    expect(json(res).role).toContain('后端');
    // roster shows hasTeamRole now
    const rres = makeRes();
    await call(makeReq('GET', '/api/team/roster', { cookie: c }), rres, '/api/team/roster');
    expect(json(rres).bots.find((b: any) => b.larkAppId === 'cli_a').hasTeamRole).toBe(true);
  });

  it('editing requires a session (401)', async () => {
    const res = makeRes();
    await call(makeReq('PUT', '/api/team/bots/cli_a/capability', { body: { capability: 'x' } }), res, '/api/team/bots/cli_a/capability');
    expect(res.statusCode).toBe(401);
  });

  it('logout clears the session cookie', async () => {
    const res = makeRes();
    await call(makeReq('POST', '/api/team/logout'), res, '/api/team/logout');
    expect(res.statusCode).toBe(200);
    expect(res._headers['set-cookie']).toBeDefined();
  });
});
