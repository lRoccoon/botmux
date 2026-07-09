/**
 * 文档评论「待授权」注册表 —— 非 owner 用户在未订阅文档里 @bot 时，
 * 先记录在这里，等 owner 授权后才正式订阅。
 *
 * 键：fileToken；值：待授权信息（谁请求的、什么时候、文档类型）。
 */
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

export interface PendingDocApproval {
  fileToken: string;
  fileType: string;
  /** 请求授权的用户 open_id（在文档里 @bot 的那个人）。 */
  requesterOpenId: string;
  requestedAt: number;
  /** 文档标题快照（best-effort）。 */
  docTitle?: string;
}

type FileShape = Record<string, PendingDocApproval>;

function filePath(dataDir: string, larkAppId: string): string {
  return join(dataDir, `doc-pending-approvals-${larkAppId}.json`);
}

function readFile(dataDir: string, larkAppId: string): FileShape {
  const fp = filePath(dataDir, larkAppId);
  if (!existsSync(fp)) return {};
  try {
    const parsed = JSON.parse(readFileSync(fp, 'utf-8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as FileShape;
  } catch { /* corrupt — 当空处理 */ }
  return {};
}

function writeFile(dataDir: string, larkAppId: string, data: FileShape): void {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  atomicWriteFileSync(filePath(dataDir, larkAppId), JSON.stringify(data, null, 2) + '\n');
}

/** 新增一条待授权（fileToken 主键，重复覆盖）。 */
export function putPendingApproval(
  dataDir: string,
  larkAppId: string,
  approval: PendingDocApproval,
): void {
  const data = readFile(dataDir, larkAppId);
  data[approval.fileToken] = approval;
  writeFile(dataDir, larkAppId, data);
}

/** 查某文档的待授权记录。 */
export function getPendingApproval(
  dataDir: string,
  larkAppId: string,
  fileToken: string,
): PendingDocApproval | null {
  return readFile(dataDir, larkAppId)[fileToken] ?? null;
}

/** 移除某文档的待授权（授权通过或拒绝后）。 */
export function removePendingApproval(
  dataDir: string,
  larkAppId: string,
  fileToken: string,
): PendingDocApproval | undefined {
  const data = readFile(dataDir, larkAppId);
  const removed = data[fileToken];
  if (!removed) return undefined;
  delete data[fileToken];
  writeFile(dataDir, larkAppId, data);
  return removed;
}

/** 列所有待授权。 */
export function listPendingApprovals(dataDir: string, larkAppId: string): PendingDocApproval[] {
  return Object.values(readFile(dataDir, larkAppId));
}
