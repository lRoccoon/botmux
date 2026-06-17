/**
 * seed-adapter.test.ts
 *
 * Seed CLI (binary `seed`) is a Claude Code fork that reuses the
 * entire Claude-family adapter, only relocating its data root to the package's
 * `.claude-runtime` and renaming the binary. These tests lock in the variant
 * wiring: data-root derivation, CLAUDE_CONFIG_DIR injection, the `.claude.json`
 * location, the `seed --resume` handoff, and that it inherits Claude's bridge
 * machinery (claudeDataDir / hook / type-ahead) verbatim.
 */
import { describe, it, expect, vi } from 'vitest';
import { join, dirname } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';

// resolveCommand() shells out to probe for the binary; mock it so an absolute
// pathOverride is returned as-is (resolveCommand short-circuits absolute paths
// before probing anyway).
vi.mock('node:child_process', () => ({
  execSync: vi.fn(() => ''),
  spawnSync: vi.fn(() => ({ stdout: '', status: 0 })),
}));

import { createSeedAdapter, deriveSeedDataDir } from '../src/adapters/cli/seed.js';

describe('deriveSeedDataDir', () => {
  it('derives <pkg>/.claude-runtime from a binary realpath (symlink shim → dist/cli.js)', () => {
    // Mirror the real install layout: <pkg>/dist/cli.js, reached via a shim symlink.
    // realpathSync: on macOS os.tmpdir() is itself a symlink (/var → /private/var),
    // and deriveSeedDataDir realpath-resolves the binary — compare against the
    // resolved root so the expected path isn't missing the /private prefix.
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'seed-pkg-')));
    const pkg = join(root, 'node_modules', '@bytedance-seed', 'claude-code');
    mkdirSync(join(pkg, 'dist'), { recursive: true });
    writeFileSync(join(pkg, 'dist', 'cli.js'), '// seed');
    const shimDir = join(root, 'shim', 'bin');
    mkdirSync(shimDir, { recursive: true });
    const shim = join(shimDir, 'seed');
    symlinkSync(join(pkg, 'dist', 'cli.js'), shim);

    expect(deriveSeedDataDir(shim)).toBe(join(pkg, '.claude-runtime'));
  });

  it('falls back to ~/.claude-runtime when the binary cannot be realpath-resolved', () => {
    expect(deriveSeedDataDir('/nonexistent/path/to/seed')).toBe(join(homedir(), '.claude-runtime'));
  });
});

describe('createSeedAdapter', () => {
  // Use a real on-disk layout so dataDir is the package's .claude-runtime.
  // realpathSync resolves the macOS /var → /private/var tmpdir symlink so the
  // expected paths match what the adapter (which realpaths the binary) returns.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'seed-adapter-')));
  const pkg = join(root, 'pkg', 'claude-code');
  mkdirSync(join(pkg, 'dist'), { recursive: true });
  writeFileSync(join(pkg, 'dist', 'cli.js'), '// seed');
  const bin = join(pkg, 'dist', 'cli.js'); // absolute → resolveCommand returns as-is
  const expectedDataDir = join(pkg, '.claude-runtime');
  const adapter = createSeedAdapter(bin);

  it('has id "seed"', () => {
    expect(adapter.id).toBe('seed');
  });

  it('exposes claudeDataDir at the package .claude-runtime', () => {
    expect(adapter.claudeDataDir).toBe(expectedDataDir);
  });

  it('keeps .claude.json inside the data root (CLAUDE_CONFIG_DIR layout, not ~/.claude.json)', () => {
    expect(adapter.claudeStateJsonPath).toBe(join(expectedDataDir, '.claude.json'));
  });

  it('pins CLAUDE_CONFIG_DIR to the data root so the bridge watches where seed writes', () => {
    expect(adapter.spawnEnv).toEqual({ CLAUDE_CONFIG_DIR: expectedDataDir });
  });

  it('hookInstall targets the data root settings.json (isolated from ~/.claude)', () => {
    expect(adapter.hookInstall).toMatchObject({
      configPath: join(expectedDataDir, 'settings.json'),
      format: 'claude-settings',
    });
    expect(adapter.hookInstall?.sessionStartCommand).toMatch(/session-ready$/);
  });

  it('prints a `seed --resume` handoff, preferring the CLI-native session id', () => {
    expect(adapter.buildResumeCommand?.({ sessionId: 'botmux-sid', cliSessionId: 'cli-sid' }))
      .toBe('seed --resume cli-sid');
    expect(adapter.buildResumeCommand?.({ sessionId: 'botmux-sid' }))
      .toBe('seed --resume botmux-sid');
  });

  it('inherits Claude-family behavior (type-ahead, hook-driven asks, no model curation)', () => {
    expect(adapter.supportsTypeAhead).toBe(true);
    expect(adapter.asksViaHook).toBe(true);
    expect(adapter.injectsSessionContext).toBe(true);
    expect(adapter.modelChoices).toBeUndefined(); // gateway-defined, not Anthropic aliases
  });

  it('buildArgs uses --session-id for fresh and --resume for resume (Claude protocol)', () => {
    const fresh = adapter.buildArgs({ sessionId: 'abc', resume: false });
    expect(fresh).toContain('--session-id');
    expect(fresh).toContain('abc');
    const resumed = adapter.buildArgs({ sessionId: 'abc', resume: true, resumeSessionId: 'xyz' });
    expect(resumed).toContain('--resume');
    expect(resumed).toContain('xyz');
  });

  it('keeps the data root out of ~/.claude (no pollution of the user config)', () => {
    expect(adapter.claudeDataDir).not.toBe(join(homedir(), '.claude'));
    expect(dirname(adapter.claudeStateJsonPath!)).toBe(expectedDataDir);
  });
});

describe('createSeedAdapter with relay-path pathOverride', () => {
  // When pathOverride points to a Relay binary, the adapter should detect it
  // and use 'relay' as resumeBin so the closed-session card shows the right
  // resume command — not 'seed --resume' which would fail because the
  // transcript lives in relay's runtime dir.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'seed-ovr-test-')));

  // Scoped package layout (mirrors real npm install):
  //   node_modules/@scope-relay/claude-code/dist/cli.js
  //   node_modules/@scope-seed/claude-code/dist/cli.js
  const relayPkg = join(root, 'node_modules', '@scope-relay', 'claude-code');
  const seedPkg = join(root, 'node_modules', '@scope-seed', 'claude-code');
  mkdirSync(join(relayPkg, 'dist'), { recursive: true });
  mkdirSync(join(seedPkg, 'dist'), { recursive: true });
  writeFileSync(join(relayPkg, 'dist', 'cli.js'), '// relay');
  writeFileSync(join(seedPkg, 'dist', 'cli.js'), '// seed');

  // Case 1: direct path to cli.js inside a relay scoped package
  const relayCliJs = join(relayPkg, 'dist', 'cli.js');

  // Case 2: shim symlink named "relay" pointing to cli.js
  const shimDir = join(root, 'shim', 'bin');
  mkdirSync(shimDir, { recursive: true });
  const relayShim = join(shimDir, 'relay');
  symlinkSync(relayCliJs, relayShim);

  // Case 3: shim symlink named "seed" pointing to seed cli.js (baseline)
  const seedShim = join(shimDir, 'seed');
  symlinkSync(join(seedPkg, 'dist', 'cli.js'), seedShim);

  it('detects relay from scoped package path (@scope-relay/claude-code)', () => {
    const a = createSeedAdapter(relayCliJs);
    expect(a.id).toBe('seed');
    expect(a.claudeDataDir).toBe(join(relayPkg, '.claude-runtime'));
    expect(a.buildResumeCommand?.({ sessionId: 'sid', cliSessionId: 'cli-sid' }))
      .toBe('relay --resume cli-sid');
  });

  it('detects relay from a shim symlink whose basename is "relay"', () => {
    const a = createSeedAdapter(relayShim);
    expect(a.id).toBe('seed');
    expect(a.claudeDataDir).toBe(join(relayPkg, '.claude-runtime'));
    expect(a.buildResumeCommand?.({ sessionId: 'sid', cliSessionId: 'cli-sid' }))
      .toBe('relay --resume cli-sid');
  });

  it('keeps seed resumeBin for a seed scoped package path (baseline)', () => {
    const a = createSeedAdapter(join(seedPkg, 'dist', 'cli.js'));
    expect(a.buildResumeCommand?.({ sessionId: 'sid', cliSessionId: 'cli-sid' }))
      .toBe('seed --resume cli-sid');
  });

  it('keeps seed resumeBin for a shim named "seed" (baseline)', () => {
    const a = createSeedAdapter(seedShim);
    expect(a.buildResumeCommand?.({ sessionId: 'sid', cliSessionId: 'cli-sid' }))
      .toBe('seed --resume cli-sid');
  });
});
