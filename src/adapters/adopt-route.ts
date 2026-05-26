/**
 * adopt-route.ts
 *
 * 为没有 BOTMUX_* 环境变量的"孤立" Claude 进程（即通过 /adopt 接管的外部 CLI）
 * 提供 askUserQuestion hook 的路由解析逻辑。
 *
 * 通过以下步骤确定目标 Lark 会话：
 *   1. 收集 hook 进程的祖先 PID 链
 *   2. 遍历在线 daemon，查询每个 daemon 是否有以某祖先 PID 启动的 adopt 会话
 *   3. 首个命中即返回路由信息
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// ── 类型 ───────────────────────────────────────────────────────────────────────

/** 从 daemon 取回的 adopt 会话路由信息 */
export interface AdoptRoute {
  sessionId: string;
  chatId: string;
  larkAppId: string;
  rootMessageId: string;
}

// ── 祖先 PID 收集 ──────────────────────────────────────────────────────────────

/**
 * 读取某进程的父 PID。
 *
 * 默认实现：
 *   1. 优先从 /proc/<pid>/stat 读取（Linux），第 4 字段（0-based）是 ppid。
 *      注意 stat 第 2 字段 comm 可以含括号和空格，所以从最后一个 `)` 之后的子串解析。
 *   2. 失败时回退到 `ps -o ppid= -p <pid>`（macOS/Linux 通用）。
 *
 * 失败/进程不存在 → 返回 null。
 */
function defaultReadParent(pid: number): number | null {
  // 先尝试 /proc（Linux 最快）
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
    // stat 格式: "<pid> (<comm>) <state> <ppid> ..."
    // comm 字段可能含空格和括号，取最后一个 ')' 之后的部分
    const lastParen = stat.lastIndexOf(')');
    if (lastParen === -1) throw new Error('unexpected /proc stat format');
    const tail = stat.slice(lastParen + 1).trim();
    // tail: "<state> <ppid> ..."
    const parts = tail.split(' ');
    // parts[0] = state, parts[1] = ppid
    const ppid = parseInt(parts[1], 10);
    if (Number.isInteger(ppid) && ppid > 0) return ppid;
  } catch {
    // /proc 不可用或解析失败，回退到 ps
  }

  // 回退到 ps（macOS / 无 /proc 的 Linux）
  try {
    const out = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], {
      encoding: 'utf-8',
    });
    const ppid = parseInt(out.trim(), 10);
    if (Number.isInteger(ppid) && ppid > 0) return ppid;
  } catch {
    // 进程不存在或 ps 调用失败
  }

  return null;
}

/**
 * 沿进程祖先链向上收集 PID（不含 startPid 自己）。
 *
 * @param startPid    起始进程 PID（自身不包含在结果中）
 * @param readParent  注入式父 PID 读取函数（默认使用 /proc 或 ps）
 * @param maxDepth    最大深度，防止意外无限循环（默认 40）
 * @returns           祖先 PID 数组，从最近父进程到最远祖先
 */
export function getAncestorPids(
  startPid: number,
  readParent?: (pid: number) => number | null,
  maxDepth?: number,
): number[] {
  const reader = readParent ?? defaultReadParent;
  const depth = maxDepth ?? 40;
  const ancestors: number[] = [];
  const visited = new Set<number>([startPid]);

  let current = startPid;
  for (let i = 0; i < depth; i++) {
    const parent = reader(current);
    if (parent === null || parent <= 1) break;  // 到 init 或读不到，停止
    if (visited.has(parent)) break;             // 防环
    visited.add(parent);
    ancestors.push(parent);
    current = parent;
  }

  return ancestors;
}

// ── Daemon 查询辅助 ─────────────────────────────────────────────────────────────

/**
 * 查询某个 daemon 是否有以指定 PID 启动的活跃 adopt 会话。
 *
 * GET http://127.0.0.1:<ipcPort>/api/adopt-session/<pid>
 *   200 → 解析 AdoptRoute；其它状态码或异常 → null（不抛）。
 * 超时：2 秒（AbortController）。
 */
export async function queryAdoptSession(
  ipcPort: number,
  pid: number,
): Promise<AdoptRoute | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const res = await fetch(
      `http://127.0.0.1:${ipcPort}/api/adopt-session/${pid}`,
      { signal: controller.signal },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as unknown;
    if (!body || typeof body !== 'object') return null;
    const b = body as Record<string, unknown>;
    if (
      typeof b.sessionId !== 'string' ||
      typeof b.chatId !== 'string' ||
      typeof b.larkAppId !== 'string' ||
      typeof b.rootMessageId !== 'string'
    ) {
      return null;
    }
    return {
      sessionId: b.sessionId,
      chatId: b.chatId,
      larkAppId: b.larkAppId,
      rootMessageId: b.rootMessageId,
    };
  } catch {
    // 超时、网络错误、JSON 解析失败等 → null
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── 主逻辑 ─────────────────────────────────────────────────────────────────────

/**
 * 通过祖先 PID 匹配在线 adopt 会话。
 *
 * 遍历每个 daemon × 每个祖先 pid，首个命中即返回；都不中返回 null。
 *
 * @param deps.startPid      hook 进程自身的 PID
 * @param deps.listDaemons   列出在线 daemon（ipcPort）
 * @param deps.queryDaemon   查询某 daemon 是否有该 pid 的活跃 adopt 会话
 * @param deps.getAncestors  取祖先 PID（默认使用 getAncestorPids）
 */
export async function resolveAdoptRoute(deps: {
  startPid: number;
  listDaemons: () => Array<{ ipcPort: number }>;
  queryDaemon: (ipcPort: number, pid: number) => Promise<AdoptRoute | null>;
  getAncestors?: (startPid: number) => number[];
}): Promise<AdoptRoute | null> {
  const { startPid, listDaemons, queryDaemon } = deps;
  const getAncestors = deps.getAncestors ?? ((pid) => getAncestorPids(pid));
  const ancestors = getAncestors(startPid);
  if (ancestors.length === 0) return null;

  const daemons = listDaemons();
  if (daemons.length === 0) return null;

  // 外层遍历 daemon，内层遍历祖先（减少对同一 daemon 的重复连接）。
  // 命中顺序确定：daemon 列表序 × 祖先链序（由近及远），首个 active match 即返回。
  // 同一个外部 Claude 理论上不会被多个 bot 同时 adopt，故首个命中即正解。
  for (const daemon of daemons) {
    for (const pid of ancestors) {
      const route = await queryDaemon(daemon.ipcPort, pid);
      if (route) {
        // 排障用：默认静默，置 BOTMUX_HOOK_DEBUG=1 时打到 stderr（不污染 hook stdout）。
        if (process.env.BOTMUX_HOOK_DEBUG === '1') {
          process.stderr.write(
            `[adopt-route] matched pid=${pid} daemon=${daemon.ipcPort} session=${route.sessionId}\n`,
          );
        }
        return route;
      }
    }
  }

  return null;
}
