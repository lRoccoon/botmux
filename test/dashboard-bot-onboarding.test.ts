import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BotOnboardingManager } from '../src/dashboard/bot-onboarding.js';
import type { RegisterAppOptions, RegisterAppResult } from '../src/setup/register-app.js';
import type { OpenPlatformAutomationResult } from '../src/setup/open-platform-automation.js';

const { userGetMock } = vi.hoisted(() => ({
  userGetMock: vi.fn(),
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class {
    contact = {
      v3: {
        user: {
          get: userGetMock,
        },
      },
    };
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}

// 默认注入的 automation 桩: 缓存命中 → 静默成功, 不出第二个二维码.
const autoOk = (): OpenPlatformAutomationResult => ({
  ok: true,
  sessionFile: '/tmp/feishu-session.json',
  sessionSource: 'botmux_cache',
  cookieCount: 3,
  scopeCount: 9,
  skippedScopeCount: 0,
});

describe('BotOnboardingManager', () => {
  beforeEach(() => {
    userGetMock.mockReset();
    userGetMock.mockResolvedValue({ code: 99992361, msg: 'user is not visible to this app' });
  });

  it('publishes a scannable QR status while registration is waiting', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-onboard-'));
    const pending = deferred<RegisterAppResult>();
    const manager = new BotOnboardingManager({
      botsJsonPath: join(dir, 'bots.json'),
      registerApp: async (opts?: RegisterAppOptions) => {
        opts?.onQRCodeReady?.({ url: 'https://open.feishu.cn/scan-me', expireIn: 600 });
        return pending.promise;
      },
      validateCredentials: async () => ({ ok: true }),
      automateOpenPlatform: async () => autoOk(),
      renderQrDataUrl: (url) => `data:image/svg+xml;base64,${Buffer.from(url).toString('base64')}`,
    });

    const job = manager.start();
    await Promise.resolve();

    const status = manager.get(job.id);
    expect(status?.status).toBe('waiting_for_scan');
    expect(status?.qrUrl).toBe('https://open.feishu.cn/scan-me');
    expect(status?.qrDataUrl).toContain('data:image/svg+xml;base64,');

    pending.resolve({ ok: false, error: 'aborted', message: 'cancelled' });
    await job.done;
    rmSync(dir, { recursive: true, force: true });
  });

  it('does not write the scanner open_id when the new app cannot resolve it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-onboard-'));
    const manager = new BotOnboardingManager({
      botsJsonPath: join(dir, 'bots.json'),
      registerApp: async () => ({
        ok: true,
        appId: 'cli_new',
        appSecret: 'super-secret-value',
        brand: 'feishu',
        userOpenId: 'ou_owner',
      }),
      validateCredentials: async () => ({ ok: true }),
      automateOpenPlatform: async () => autoOk(),
      renderQrDataUrl: () => 'data:image/svg+xml;base64,qr',
    });

    const job = manager.start();
    await job.done;

    const status = manager.get(job.id);
    expect(status).toMatchObject({
      status: 'completed',
      appId: 'cli_new',
      addedBotIndex: 0,
      permission: { ok: true, scopeCount: 9 },
    });
    expect(JSON.stringify(status)).not.toContain('super-secret-value');

    const bots = JSON.parse(readFileSync(join(dir, 'bots.json'), 'utf-8'));
    expect(bots).toEqual([{
      larkAppId: 'cli_new',
      larkAppSecret: 'super-secret-value',
      cliId: 'claude-code',
      workingDir: '~',
    }]);
    expect(bots[0]).not.toHaveProperty('allowedUsers');
    expect(userGetMock).toHaveBeenCalledWith({
      path: { user_id: 'ou_owner' },
      params: { user_id_type: 'open_id' },
    });

    rmSync(dir, { recursive: true, force: true });
  });

  it('writes the scanner union_id to allowedUsers when the new app can resolve it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-onboard-'));
    userGetMock.mockResolvedValueOnce({
      code: 0,
      data: {
        user: {
          union_id: 'on_scanner',
          name: 'Scanner',
        },
      },
    });
    const manager = new BotOnboardingManager({
      botsJsonPath: join(dir, 'bots.json'),
      registerApp: async () => ({
        ok: true,
        appId: 'cli_new',
        appSecret: 'super-secret-value',
        brand: 'feishu',
        userOpenId: 'ou_scanner',
      }),
      validateCredentials: async () => ({ ok: true }),
      automateOpenPlatform: async () => autoOk(),
      renderQrDataUrl: () => 'data:image/svg+xml;base64,qr',
    });

    const job = manager.start({ cliId: 'traex', workingDir: dir });
    await job.done;

    const bots = JSON.parse(readFileSync(join(dir, 'bots.json'), 'utf-8'));
    expect(bots[0]).toMatchObject({
      larkAppId: 'cli_new',
      cliId: 'traex',
      allowedUsers: ['on_scanner'],
    });
    expect(userGetMock).toHaveBeenCalledWith({
      path: { user_id: 'ou_scanner' },
      params: { user_id_type: 'open_id' },
    });

    rmSync(dir, { recursive: true, force: true });
  });

  it('writes the CLI / workingDir / model chosen in the form', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-onboard-'));
    const manager = new BotOnboardingManager({
      botsJsonPath: join(dir, 'bots.json'),
      registerApp: async () => ({ ok: true, appId: 'cli_x', appSecret: 's', brand: 'feishu' }),
      validateCredentials: async () => ({ ok: true }),
      automateOpenPlatform: async () => autoOk(),
      renderQrDataUrl: () => 'data:image/svg+xml;base64,qr',
    });

    // 工作目录用 tmp 目录的真实路径——manager 本身不校验存在性 (dashboard 层校验),
    // 但用真实目录更贴近实际写入的样子.
    const job = manager.start({ cliId: 'codex', workingDir: dir, model: 'gpt-5' });
    await job.done;

    const status = manager.get(job.id);
    expect(status?.status).toBe('completed');
    expect(status).toMatchObject({ cliId: 'codex', workingDir: dir });

    const bots = JSON.parse(readFileSync(join(dir, 'bots.json'), 'utf-8'));
    expect(bots[0]).toMatchObject({
      larkAppId: 'cli_x',
      cliId: 'codex',
      workingDir: dir,
      model: 'gpt-5',
    });

    rmSync(dir, { recursive: true, force: true });
  });

  it('surfaces the second (open-platform) QR and finishes with a permission summary', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-onboard-'));
    const gate = deferred<void>();
    const manager = new BotOnboardingManager({
      botsJsonPath: join(dir, 'bots.json'),
      registerApp: async () => ({ ok: true, appId: 'cli_q', appSecret: 's', brand: 'feishu' }),
      validateCredentials: async () => ({ ok: true }),
      automateOpenPlatform: async (opts) => {
        // 模拟无缓存会话 → 先抛第二个二维码, 再发轮询进度, 最后被 gate 放行才完成.
        await opts.onQrCode?.({ qrText: 'ascii', qrPayload: '{"qrlogin":{"token":"tok"}}' });
        await opts.onStatus?.('等待飞书扫码');
        await gate.promise;
        return { ...autoOk(), sessionSource: 'qr_login', scopeCount: 7, skippedScopeCount: 2, versionId: '0.0.1' };
      },
      renderQrDataUrl: (payload) => `data:image/svg+xml;base64,${Buffer.from(payload).toString('base64')}`,
    });

    const job = manager.start({ cliId: 'claude-code', workingDir: '~' });
    // onQrCode + onStatus 都跑过后的中间态: 第二个二维码必须还在 (onStatus 不能盖掉它).
    await new Promise(r => setTimeout(r, 0));
    const mid = manager.get(job.id);
    expect(mid?.status).toBe('waiting_for_platform_scan');
    expect(mid?.platformQrDataUrl).toContain('data:image/svg+xml;base64,');
    expect(mid?.permissionStatusMsg).toBe('等待飞书扫码');

    gate.resolve();
    await job.done;

    const status = manager.get(job.id);
    expect(status).toMatchObject({
      status: 'completed',
      permission: { ok: true, scopeCount: 7, skippedScopeCount: 2, versionId: '0.0.1' },
    });
    // 完成态清掉第二个二维码, 不残留在完成页.
    expect(status?.platformQrDataUrl).toBeUndefined();

    rmSync(dir, { recursive: true, force: true });
  });

  it('still adds the bot but falls back to manual steps when auto-permission fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-onboard-'));
    const manager = new BotOnboardingManager({
      botsJsonPath: join(dir, 'bots.json'),
      registerApp: async () => ({ ok: true, appId: 'cli_f', appSecret: 's', brand: 'feishu' }),
      validateCredentials: async () => ({ ok: true }),
      automateOpenPlatform: async () => ({ ok: false, reason: 'missing_csrf', message: 'no csrf' }),
      renderQrDataUrl: () => 'data:image/svg+xml;base64,qr',
    });

    const job = manager.start();
    await job.done;

    const status = manager.get(job.id);
    // bot 仍写入 (核心成功), 仅权限需手动补 → 给出深链步骤.
    expect(status?.status).toBe('completed');
    expect(status?.permission).toMatchObject({ ok: false, reason: 'missing_csrf' });
    expect(Array.isArray(status?.remainingSteps)).toBe(true);
    expect(status!.remainingSteps!.length).toBeGreaterThan(0);
    expect(status!.remainingSteps!.every(s => typeof s.url === 'string' && s.url.includes('cli_f'))).toBe(true);

    const bots = JSON.parse(readFileSync(join(dir, 'bots.json'), 'utf-8'));
    expect(bots[0]).toMatchObject({ larkAppId: 'cli_f', cliId: 'claude-code' });

    rmSync(dir, { recursive: true, force: true });
  });
});
