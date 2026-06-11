/**
 * atomic-write.ts — 原子写文件统一入口（tmp + rename）。
 *
 * 为什么需要它：裸 writeFileSync 在「写一半时被并发读 / 进程崩溃」下会让读者
 * 看到半截内容（torn read），对跨进程共享的 JSON 状态文件、被 watcher 当触发
 * 器消费的文件、被并发 exec 的脚本都是真实事故源（参考 cjadk settings.json
 * 覆盖事故）。POSIX rename(2) 同文件系统内原子替换：读者要么看到旧文件、要么
 * 看到完整新文件，永远不会看到中间态。
 *
 * tmp 命名带 pid + 随机后缀：多个进程并发写同一目标（如 30 个 daemon 齐写
 * bots-info.json）时，固定 `.tmp` 名会互相撕对方的半成品再 rename 上去——
 * 唯一名让每个写者各写各的，rename 收敛为 last-writer-wins。
 *
 * 约束：tmp 与目标同目录（同 fs 才保证 rename 原子且不跨设备失败）；失败时
 * best-effort 清理 tmp，绝不破坏旧文件。
 */
import { writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { randomBytes } from 'node:crypto';

export interface AtomicWriteOptions {
  /** 文件权限（如 0o600 密钥 / 0o755 可执行脚本）。设置在 tmp 上，rename 后保留。 */
  mode?: number;
  /** 文本编码，默认 utf-8（data 为 Buffer 时忽略）。 */
  encoding?: BufferEncoding;
}

/** 生成与目标同目录的唯一 tmp 路径。 */
function tmpPathFor(filePath: string): string {
  return `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
}

/**
 * 原子写（同步）：写同目录唯一 tmp → rename 覆盖目标。
 * 任何失败都不会影响目标文件的旧内容；tmp 残留会被 best-effort 清理。
 */
export function atomicWriteFileSync(
  filePath: string,
  data: string | Buffer,
  options: AtomicWriteOptions = {},
): void {
  const tmp = tmpPathFor(filePath);
  try {
    writeFileSync(tmp, data, {
      encoding: typeof data === 'string' ? (options.encoding ?? 'utf-8') : undefined,
      ...(options.mode !== undefined ? { mode: options.mode } : {}),
    });
    renameSync(tmp, filePath);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* tmp 可能根本没写出来 */ }
    throw err;
  }
}

/**
 * 原子写（异步）：语义同 atomicWriteFileSync，给 async 调用链（workflow 运行时等）。
 */
export async function atomicWriteFile(
  filePath: string,
  data: string | Buffer,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const tmp = tmpPathFor(filePath);
  try {
    await fsp.writeFile(tmp, data, {
      encoding: typeof data === 'string' ? (options.encoding ?? 'utf-8') : undefined,
      ...(options.mode !== undefined ? { mode: options.mode } : {}),
    });
    await fsp.rename(tmp, filePath);
  } catch (err) {
    try { await fsp.unlink(tmp); } catch { /* tmp 可能根本没写出来 */ }
    throw err;
  }
}
