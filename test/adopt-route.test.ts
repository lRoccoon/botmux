/**
 * adopt-route.test.ts
 *
 * 测试 getAncestorPids 和 resolveAdoptRoute 的纯逻辑。
 * 全部依赖注入，不访问真实 /proc / ps / 网络。
 */

import { describe, it, expect } from 'vitest';
import { getAncestorPids, resolveAdoptRoute, type AdoptRoute } from '../src/adapters/adopt-route.js';

// ── getAncestorPids ────────────────────────────────────────────────────────────

describe('getAncestorPids', () => {
  it('返回祖先链（不含 startPid 自己）', () => {
    // 进程树：child(100) → p1(200) → p2(300) → p3(400)
    const parentMap: Record<number, number> = {
      100: 200,
      200: 300,
      300: 400,
    };
    const readParent = (pid: number): number | null => parentMap[pid] ?? null;
    const result = getAncestorPids(100, readParent);
    expect(result).toEqual([200, 300, 400]);
  });

  it('遇到 pid<=1 时停止', () => {
    const parentMap: Record<number, number> = {
      100: 50,
      50: 1,   // 到 init
    };
    const readParent = (pid: number): number | null => parentMap[pid] ?? null;
    const result = getAncestorPids(100, readParent);
    // pid=1 不加入结果，在 50 处已停
    expect(result).toEqual([50]);
  });

  it('readParent 返回 null 时停止', () => {
    const parentMap: Record<number, number> = {
      100: 200,
    };
    const readParent = (pid: number): number | null => parentMap[pid] ?? null;
    const result = getAncestorPids(100, readParent);
    expect(result).toEqual([200]);
  });

  it('防环：检测到循环时停止，结果有限', () => {
    // 人为制造循环：100→200→300→100（不可能在真实进程树中，但代码要防范）
    const parentMap: Record<number, number> = {
      100: 200,
      200: 300,
      300: 100,  // 指回 startPid
    };
    const readParent = (pid: number): number | null => parentMap[pid] ?? null;
    const result = getAncestorPids(100, readParent);
    // 在遇到 100（startPid，已在 visited 里）时停止
    expect(result).toEqual([200, 300]);
    expect(result.length).toBeLessThan(10);
  });

  it('maxDepth 限制深度', () => {
    // 构造深链：100→101→102→...→200（101 级）
    const readParent = (pid: number): number | null => (pid < 200 ? pid + 1 : null);
    const result = getAncestorPids(100, readParent, 5);
    expect(result).toHaveLength(5);
    expect(result[0]).toBe(101);
    expect(result[4]).toBe(105);
  });

  it('startPid 无父（readParent 立刻返回 null）→ 空数组', () => {
    const result = getAncestorPids(1, () => null);
    expect(result).toEqual([]);
  });
});

// ── resolveAdoptRoute ──────────────────────────────────────────────────────────

const MOCK_ROUTE: AdoptRoute = {
  sessionId: 's-adopt',
  chatId: 'oc_chat1',
  larkAppId: 'cli_apptest',
  rootMessageId: 'om_root1',
};

describe('resolveAdoptRoute', () => {
  it('遍历 daemon × 祖先，首个命中即返回', async () => {
    // 祖先：[100, 200]；两个 daemon
    const getAncestors = () => [100, 200];
    const listDaemons = () => [{ ipcPort: 1 }, { ipcPort: 2 }];

    // 只有 (port=2, pid=200) 命中
    const queryDaemon = async (port: number, pid: number): Promise<AdoptRoute | null> => {
      if (port === 2 && pid === 200) return MOCK_ROUTE;
      return null;
    };

    const result = await resolveAdoptRoute({
      startPid: 999,
      listDaemons,
      queryDaemon,
      getAncestors,
    });
    expect(result).toEqual(MOCK_ROUTE);
  });

  it('首个命中后停止（不再查询后续 daemon/pid）', async () => {
    const getAncestors = () => [100, 200];
    const listDaemons = () => [{ ipcPort: 1 }, { ipcPort: 2 }];
    const calls: Array<{ port: number; pid: number }> = [];

    // (port=1, pid=100) 命中
    const queryDaemon = async (port: number, pid: number): Promise<AdoptRoute | null> => {
      calls.push({ port, pid });
      if (port === 1 && pid === 100) return MOCK_ROUTE;
      return null;
    };

    const result = await resolveAdoptRoute({
      startPid: 999,
      listDaemons,
      queryDaemon,
      getAncestors,
    });
    expect(result).toEqual(MOCK_ROUTE);
    // 命中后不应再查询
    expect(calls).toEqual([{ port: 1, pid: 100 }]);
  });

  it('全部 daemon × 祖先都未命中 → 返回 null', async () => {
    const getAncestors = () => [100, 200];
    const listDaemons = () => [{ ipcPort: 1 }, { ipcPort: 2 }];
    const queryDaemon = async (): Promise<AdoptRoute | null> => null;

    const result = await resolveAdoptRoute({
      startPid: 999,
      listDaemons,
      queryDaemon,
      getAncestors,
    });
    expect(result).toBeNull();
  });

  it('无祖先（getAncestors 返回空数组）→ 返回 null', async () => {
    const getAncestors = () => [];
    const listDaemons = () => [{ ipcPort: 1 }];
    const queryDaemon = async (): Promise<AdoptRoute | null> => MOCK_ROUTE;

    const result = await resolveAdoptRoute({
      startPid: 999,
      listDaemons,
      queryDaemon,
      getAncestors,
    });
    expect(result).toBeNull();
  });

  it('无在线 daemon（listDaemons 返回空数组）→ 返回 null', async () => {
    const getAncestors = () => [100, 200];
    const listDaemons = () => [] as Array<{ ipcPort: number }>;
    const queryDaemon = async (): Promise<AdoptRoute | null> => MOCK_ROUTE;

    const result = await resolveAdoptRoute({
      startPid: 999,
      listDaemons,
      queryDaemon,
      getAncestors,
    });
    expect(result).toBeNull();
  });
});
