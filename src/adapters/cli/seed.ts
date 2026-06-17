import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { resolveCommand } from './registry.js';
import { createClaudeFamilyAdapter } from './claude-code.js';
import { logger } from '../../utils/logger.js';
import type { CliAdapter } from './types.js';

/** Seed CLI (binary `seed`) is a fork of Claude Code. It has since been
 *  rebranded as **Relay CLI** (binary `relay`).
 *
 *  Both share identical flags, slash commands, and on-disk session layout
 *  (per-project JSONL transcripts, `sessions/<pid>.json`, `tasks/` fd locks,
 *  keybindings.json, settings.json hooks). They differ only in the binary name
 *  and the data root — each isolates its `.claude-runtime` directory *inside
 *  its own install package* (rather than `~/.claude`), respecting
 *  `CLAUDE_CONFIG_DIR` when set.
 *
 *  **Fallback behavior**: this adapter prefers the newer `relay` binary when
 *  available on PATH (since Seed has been superseded by Relay). If `relay` is
 *  not found it falls back to the legacy `seed` binary. The adapter's `id`
 *  remains `'seed'` for backward compatibility with existing bot configs —
 *  users don't need to reconfigure anything to get the new binary.
 *
 *  So Seed reuses the entire Claude-family adapter; the only work here is
 *  locating the right `.claude-runtime` so botmux watches exactly where the
 *  CLI writes. */

/** Derive the `.claude-runtime` data root from the resolved binary.
 *
 *  Works for both Seed and Relay — same package layout: `dist/cli.js` → two
 *  levels up is the package root → `.claude-runtime` inside it.
 *
 *  `which <bin>` returns an ephemeral fnm/nvm shim (e.g.
 *  `/run/user/.../fnm_multishells/<pid>_.../bin/<bin>`); realpath follows the
 *  symlink chain to the package's `dist/cli.js`, whose package root is two
 *  levels up. Deriving from the binary on every spawn means a node/fnm switch
 *  auto-tracks to the matching runtime dir — and it equals the path a bare
 *  `<bin>` uses by default, so botmux-spawned and hand-started sessions
 *  share one config (settings, history, cross-resume).
 *
 *  Falls back to `~/.claude-runtime` only if realpath fails (unusual install
 *  layout) — the CLI still runs, but the JSONL bridge may target the wrong dir;
 *  we log so it's diagnosable rather than silently degraded. */
export function deriveSeedDataDir(bin: string): string {
  try {
    const real = realpathSync(bin);          // <pkg>/dist/cli.js
    const pkgRoot = dirname(dirname(real));   // <pkg>
    return join(pkgRoot, '.claude-runtime');
  } catch (err) {
    const fallback = join(homedir(), '.claude-runtime');
    logger.warn(`[seed] could not resolve .claude-runtime from binary "${bin}" (${err instanceof Error ? err.message : String(err)}); falling back to ${fallback}`);
    return fallback;
  }
}

/** Given a resolved binary path (may be a shim symlink or the real cli.js),
 *  determine whether it's the Seed or Relay variant.
 *
 *  Heuristics (in order), checked against the realpath-resolved binary:
 *    1. If the binary's own basename is `relay` → relay
 *    2. If the binary's own basename is `seed` → seed
 *    3. Walk up from the binary and look for a path component exactly named
 *       `relay` (unscoped package)
 *    4. Walk up and look for a `@*` scope directory whose name *ends with*
 *       `-relay` (scoped package, e.g. `@scope-relay/claude-code`)
 *    5. Otherwise → seed (safe default)
 *
 *  We walk the realpath components so symlinks / shims don't hide the
 *  underlying package. We only match whole path segments (not substrings)
 *  to avoid false positives from parent directories that happen to contain
 *  the string "relay" (e.g. temp dirs, project names).
 */
function detectBinName(bin: string): 'relay' | 'seed' {
  const base = bin.split('/').pop() ?? '';
  if (base === 'relay') return 'relay';
  if (base === 'seed') return 'seed';
  try {
    const real = realpathSync(bin);
    const parts = real.split('/');
    // Check each path segment
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      if (part === 'relay') return 'relay';
      if (part.startsWith('@') && part.endsWith('-relay')) return 'relay';
    }
  } catch {
    // realpath failed — fall through to default
  }
  return 'seed';
}

export function createSeedAdapter(pathOverride?: string): CliAdapter {
  // When no explicit path is given, prefer the newer `relay` binary (Seed has
  // been rebranded to Relay). Fall back to legacy `seed` if relay is not
  // installed. An explicit pathOverride always wins as-is.
  let bin: string;
  let binName: 'relay' | 'seed';

  if (pathOverride) {
    bin = resolveCommand(pathOverride);
    binName = detectBinName(bin);
  } else {
    const relayBin = resolveCommand('relay');
    if (isAbsolute(relayBin)) {
      bin = relayBin;
      binName = 'relay';
    } else {
      bin = resolveCommand('seed');
      binName = 'seed';
    }
  }

  const dataDir = deriveSeedDataDir(bin);

  if (!pathOverride) {
    logger.info(`[seed] using ${binName} binary at ${bin}`);
  } else {
    logger.info(`[seed] using override binary at ${bin} (detected as ${binName})`);
  }

  return createClaudeFamilyAdapter({
    id: 'seed',
    // Seed / Relay both use bytedcli login state — keep the bytedcli dir
    // real + writable inside the file sandbox so token refresh/login persist.
    authPaths: ['~/.local/share/bytedcli'],
    resumeBin: binName,
    dataDir,
    // Seed / Relay keeps `.claude.json` inside its data root (CLAUDE_CONFIG_DIR
    // layout), unlike Claude Code which puts it at `~/.claude.json`.
    stateJsonPath: join(dataDir, '.claude.json'),
    // Pin CLAUDE_CONFIG_DIR to the CLI's own default so the dir botmux watches
    // and the dir the CLI writes to are provably identical — and still equal
    // to what a hand-started `seed` / `relay` resolves, preserving config
    // alignment.
    spawnEnv: { CLAUDE_CONFIG_DIR: dataDir },
    // Seed/Relay's model set is gateway-defined, not the Anthropic aliases —
    // skip the setup model prompt; users pick via /model.
    modelChoices: undefined,
  }, bin);
}

export const create = createSeedAdapter;
