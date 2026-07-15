/**
 * Zellij socket probe — reveal the SPAWN-TIME bound path of a (possibly
 * renamed) zellij session socket file. Runs as a standalone child script
 * (`node zellij-socket-probe.js <socketPath>`) so the parent's sync
 * findServerPid can spawnSync it.
 *
 * Why this exists: `zellij action rename-session` (what the session-manager
 * plugin drives) renames the session's socket FILE, but both the server's
 * argv AND the kernel's bound-address string (/proc/net/unix Path column)
 * keep the spawn-time path forever (verified live on 0.44.1). So there is no
 * passive way to map "current session name" → "server process" after a
 * rename. Actively connecting to the renamed socket file, however, makes the
 * server accept() a new socket that shows up in /proc/net/unix under the
 * STALE bound path — diffing per-path row counts across the connect reveals
 * exactly which spawn-time path (= server argv) backs the renamed file.
 *
 * Output: the revealed bound path on stdout, exit 0. Non-zero exit on any
 * failure (connect refused / no diff / ambiguous concurrent-connect race —
 * callers treat all of these as "not found"). Linux-only (/proc).
 */
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Rows-per-bound-path under `dir` from /proc/net/unix content. Pure. */
export function unixPathCounts(procNetUnix: string, dir: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of procNetUnix.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length >= 8 && cols[7]!.startsWith(`${dir}/`)) {
      counts.set(cols[7]!, (counts.get(cols[7]!) ?? 0) + 1);
    }
  }
  return counts;
}

/** Paths whose row count grew from `before` to `after`. Pure. */
export function grownPaths(before: Map<string, number>, after: Map<string, number>): string[] {
  return [...after.entries()]
    .filter(([path, n]) => n > (before.get(path) ?? 0))
    .map(([path]) => path);
}

function main(socketPath: string): void {
  const dir = dirname(socketPath);
  const snapshot = () => unixPathCounts(readFileSync('/proc/net/unix', 'utf-8'), dir);
  const before = snapshot();
  const client = connect(socketPath, () => {
    // Give the server a beat to accept() so the new row is visible.
    setTimeout(() => {
      const grown = grownPaths(before, snapshot());
      client.destroy();
      if (grown.length === 1) {
        process.stdout.write(grown[0]!);
        process.exit(0);
      }
      // 0 = server never accepted; >1 = another client connected concurrently
      // to a sibling session (rare race) — refuse rather than guess.
      process.exit(3);
    }, 150);
  });
  client.on('error', () => process.exit(1));
  setTimeout(() => { client.destroy(); process.exit(2); }, 3000).unref();
}

// Only run when executed directly (the pure helpers are also imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sock = process.argv[2];
  if (!sock) process.exit(64);
  main(sock);
}
