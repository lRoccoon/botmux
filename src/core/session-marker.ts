import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

export interface AncestorSessionContext {
  sessionId: string;
  turnId?: string;
}

export function parseSessionMarker(raw: string): AncestorSessionContext {
  const text = raw.trim();
  if (!text) return { sessionId: '' };
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text) as { sessionId?: unknown; turnId?: unknown };
      return {
        sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : '',
        turnId: typeof parsed.turnId === 'string' ? parsed.turnId : undefined,
      };
    } catch {
      return { sessionId: '' };
    }
  }
  return { sessionId: text };
}

/**
 * Walk the process tree looking for a CLI-pid marker written by the botmux
 * worker. Legacy markers contain just the session id; new markers are JSON and
 * also carry the current inbound turn id so long-lived CLI processes can route
 * `botmux send` to the correct topic alias on the 2nd/Nth turn.
 */
export function findAncestorSessionContext(dataDir: string, startPid: number = process.ppid): AncestorSessionContext | null {
  const markersDir = join(dataDir, '.botmux-cli-pids');
  if (!existsSync(markersDir)) return null;

  let pid = startPid;
  for (let depth = 0; depth < 8 && pid > 1; depth++) {
    const markerPath = join(markersDir, String(pid));
    if (existsSync(markerPath)) {
      try { return parseSessionMarker(readFileSync(markerPath, 'utf-8')); } catch { return { sessionId: '' }; }
    }
    try {
      const out = execSync(`ps -o ppid= -p ${pid}`, { encoding: 'utf-8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      pid = parseInt(out, 10);
      if (isNaN(pid)) break;
    } catch { break; }
  }
  return null;
}
