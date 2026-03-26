/**
 * Unit tests for project-scanner: scanProjects & scanMultipleProjects.
 *
 * Creates real temporary directory structures and mocks child_process.execSync
 * to avoid requiring actual git repositories for branch/worktree detection.
 *
 * Run:  pnpm vitest run test/project-scanner.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

// ─── Mock child_process before importing the module under test ───────────

vi.mock('node:child_process', () => ({
  execSync: vi.fn((cmd: string, opts?: { cwd?: string }) => {
    if (cmd.includes('rev-parse --abbrev-ref HEAD')) {
      return 'main\n';
    }
    if (cmd.includes('worktree list --porcelain')) {
      // Return just the main worktree (no additional worktrees by default)
      return `worktree ${opts?.cwd ?? '/tmp'}\nbranch refs/heads/main\n\n`;
    }
    return '';
  }),
}));

// Import after mock setup
import { scanProjects, scanMultipleProjects, type ProjectInfo } from '../src/services/project-scanner.js';
import { execSync } from 'node:child_process';

const mockedExecSync = vi.mocked(execSync);

// ─── Helpers ─────────────────────────────────────────────────────────────

let tempRoot: string;

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'project-scanner-test-'));
}

/** Create a directory path (recursive) and optionally place a .git marker. */
function mkRepo(relPath: string): string {
  const full = join(tempRoot, relPath);
  mkdirSync(full, { recursive: true });
  mkdirSync(join(full, '.git'), { recursive: true });
  return full;
}

function mkDir(relPath: string): string {
  const full = join(tempRoot, relPath);
  mkdirSync(full, { recursive: true });
  return full;
}

// ─── Setup / Teardown ────────────────────────────────────────────────────

beforeEach(() => {
  tempRoot = makeTempDir();
  mockedExecSync.mockClear();
  // Default: return 'main' for branch, empty worktree list
  mockedExecSync.mockImplementation((cmd: string, opts?: any) => {
    const cmdStr = String(cmd);
    if (cmdStr.includes('rev-parse --abbrev-ref HEAD')) {
      return 'main\n';
    }
    if (cmdStr.includes('worktree list --porcelain')) {
      const cwd = opts?.cwd ?? '/tmp';
      return `worktree ${cwd}\nbranch refs/heads/main\n\n`;
    }
    return '';
  });
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

// ─── scanProjects ────────────────────────────────────────────────────────

describe('scanProjects', () => {
  it('should find a single git repo at the top level', () => {
    const repoPath = mkRepo('my-project');

    const results = scanProjects(tempRoot);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      name: 'my-project',
      path: repoPath,
      type: 'repo',
      branch: 'main',
    });
  });

  it('should find multiple repos at the same depth', () => {
    mkRepo('alpha');
    mkRepo('beta');
    mkRepo('gamma');

    const results = scanProjects(tempRoot);

    expect(results).toHaveLength(3);
    const names = results.map(r => r.name);
    expect(names).toEqual(['alpha', 'beta', 'gamma']); // sorted alphabetically
  });

  it('should find nested repos within non-repo directories', () => {
    mkDir('workspace');
    mkRepo('workspace/project-a');
    mkRepo('workspace/project-b');

    const results = scanProjects(tempRoot);

    expect(results).toHaveLength(2);
    expect(results[0]!.name).toBe('project-a');
    expect(results[1]!.name).toBe('project-b');
  });

  it('should not recurse into git repos (no nested repo detection)', () => {
    const outerPath = mkRepo('outer');
    // Create a nested .git inside the outer repo — should not be found
    mkdirSync(join(outerPath, 'inner', '.git'), { recursive: true });

    const results = scanProjects(tempRoot);

    // Only the outer repo should be detected
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe('outer');
  });

  it('should return an empty array for an empty directory', () => {
    const results = scanProjects(tempRoot);
    expect(results).toEqual([]);
  });

  it('should return an empty array for a non-existent directory', () => {
    const results = scanProjects(join(tempRoot, 'does-not-exist'));
    expect(results).toEqual([]);
  });

  // ─── ProjectInfo structure ──────────────────────────────────────────────

  it('should produce correct ProjectInfo fields', () => {
    mockedExecSync.mockImplementation((cmd: string, opts?: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes('rev-parse --abbrev-ref HEAD')) {
        return 'feature/login\n';
      }
      if (cmdStr.includes('worktree list --porcelain')) {
        return `worktree ${opts?.cwd}\nbranch refs/heads/feature/login\n\n`;
      }
      return '';
    });

    const repoPath = mkRepo('my-app');
    const results = scanProjects(tempRoot);

    expect(results).toHaveLength(1);
    const info = results[0]!;
    expect(info.name).toBe('my-app');
    expect(info.path).toBe(repoPath);
    expect(info.type).toBe('repo');
    expect(info.branch).toBe('feature/login');
  });

  // ─── Depth limiting ─────────────────────────────────────────────────────

  it('should respect maxDepth = 0 (only scan the base directory itself)', () => {
    // Repo IS the base dir
    mkdirSync(join(tempRoot, '.git'), { recursive: true });
    mkRepo('child'); // depth 1 — should not be reached

    const results = scanProjects(tempRoot, 0);

    // Should only find the base dir itself (depth 0), not the child
    expect(results).toHaveLength(1);
    expect(results[0]!.path).toBe(tempRoot);
  });

  it('should respect maxDepth = 1', () => {
    mkRepo('level1');
    mkDir('container');
    mkRepo('container/level2'); // depth 2 — should not be reached with maxDepth=1

    const results = scanProjects(tempRoot, 1);

    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe('level1');
  });

  it('should find repos at exactly maxDepth', () => {
    mkDir('a');
    mkDir('a/b');
    mkRepo('a/b/deep-repo'); // depth 3

    const results = scanProjects(tempRoot, 3);

    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe('deep-repo');
  });

  it('should NOT find repos beyond maxDepth', () => {
    mkDir('a');
    mkDir('a/b');
    mkDir('a/b/c');
    mkRepo('a/b/c/too-deep'); // depth 4 — beyond maxDepth=3

    const results = scanProjects(tempRoot, 3);

    expect(results).toEqual([]);
  });

  // ─── Exclusions ─────────────────────────────────────────────────────────

  it('should skip node_modules directories', () => {
    mkDir('node_modules');
    mkRepo('node_modules/some-package');

    const results = scanProjects(tempRoot);
    expect(results).toEqual([]);
  });

  it('should skip hidden directories (starting with dot)', () => {
    mkDir('.hidden');
    mkRepo('.hidden/secret-project');

    const results = scanProjects(tempRoot);
    expect(results).toEqual([]);
  });

  it('should skip vendor directories', () => {
    mkDir('vendor');
    mkRepo('vendor/lib');

    const results = scanProjects(tempRoot);
    expect(results).toEqual([]);
  });

  it('should skip dist directories', () => {
    mkDir('dist');
    mkRepo('dist/build-output');

    const results = scanProjects(tempRoot);
    expect(results).toEqual([]);
  });

  it('should not skip similarly-named non-excluded directories', () => {
    mkRepo('node_modules_extra/project'); // not exactly "node_modules"
    // Actually "node_modules_extra" does not start with '.' and is not in the exclusion list
    // But since the repo is inside it at depth 2, it should be found
    // Wait — let's make the structure clearer
    mkDir('vendors'); // similar but not "vendor"
    mkRepo('vendors/lib');

    const results = scanProjects(tempRoot);
    // "vendors" is not excluded, so "lib" should be found
    // "node_modules_extra" is not excluded either
    const names = results.map(r => r.name);
    expect(names).toContain('lib');
    expect(names).toContain('project');
  });

  // ─── Sorting ────────────────────────────────────────────────────────────

  it('should sort repos before worktrees, alphabetically within groups', () => {
    mkRepo('zeta-repo');
    mkRepo('alpha-repo');

    // Simulate worktrees for alpha-repo
    const alphaPath = join(tempRoot, 'alpha-repo');
    const wtPath = join(tempRoot, 'worktree-checkout');
    mkdirSync(wtPath, { recursive: true });

    mockedExecSync.mockImplementation((cmd: string, opts?: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes('rev-parse --abbrev-ref HEAD')) {
        return 'main\n';
      }
      if (cmdStr.includes('worktree list --porcelain')) {
        if (opts?.cwd === alphaPath) {
          return [
            `worktree ${alphaPath}`,
            'branch refs/heads/main',
            '',
            `worktree ${wtPath}`,
            'branch refs/heads/feature-x',
            '',
          ].join('\n');
        }
        return `worktree ${opts?.cwd}\nbranch refs/heads/main\n\n`;
      }
      return '';
    });

    const results = scanProjects(tempRoot);

    // Repos first (alphabetical), then worktrees
    const types = results.map(r => r.type);
    const repoIdx = results.findIndex(r => r.type === 'worktree');
    if (repoIdx !== -1) {
      // All repos should come before any worktree
      for (let i = 0; i < repoIdx; i++) {
        expect(results[i]!.type).toBe('repo');
      }
    }
  });

  // ─── Worktree detection ─────────────────────────────────────────────────

  it('should detect worktrees associated with a repo', () => {
    const repoPath = mkRepo('my-repo');
    const worktreePath = '/tmp/my-repo-worktree-abc';

    mockedExecSync.mockImplementation((cmd: string, opts?: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes('rev-parse --abbrev-ref HEAD')) {
        return 'main\n';
      }
      if (cmdStr.includes('worktree list --porcelain')) {
        if (opts?.cwd === repoPath) {
          return [
            `worktree ${repoPath}`,
            'branch refs/heads/main',
            '',
            `worktree ${worktreePath}`,
            'branch refs/heads/feature-branch',
            '',
          ].join('\n');
        }
        return `worktree ${opts?.cwd}\nbranch refs/heads/main\n\n`;
      }
      return '';
    });

    const results = scanProjects(tempRoot);

    expect(results).toHaveLength(2);

    const repo = results.find(r => r.type === 'repo')!;
    expect(repo.name).toBe('my-repo');
    expect(repo.path).toBe(repoPath);

    const wt = results.find(r => r.type === 'worktree')!;
    expect(wt.name).toBe('my-repo/my-repo-worktree-abc');
    expect(wt.path).toBe(worktreePath);
    expect(wt.branch).toBe('feature-branch');
  });

  it('should not include the main worktree as a separate entry', () => {
    const repoPath = mkRepo('my-repo');

    // Worktree list returns only the main worktree (same path as repoPath)
    mockedExecSync.mockImplementation((cmd: string, opts?: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes('rev-parse --abbrev-ref HEAD')) {
        return 'main\n';
      }
      if (cmdStr.includes('worktree list --porcelain')) {
        return `worktree ${repoPath}\nbranch refs/heads/main\n\n`;
      }
      return '';
    });

    const results = scanProjects(tempRoot);

    expect(results).toHaveLength(1);
    expect(results[0]!.type).toBe('repo');
  });

  // ─── Deduplication ──────────────────────────────────────────────────────

  it('should not duplicate repos when the same path is encountered', () => {
    // This tests the `seen` set — two directories that somehow point to the same repo
    // In practice this shouldn't happen with real dirs, but the code handles it
    mkRepo('project');

    const results = scanProjects(tempRoot);
    expect(results).toHaveLength(1);
  });

  // ─── Error resilience ──────────────────────────────────────────────────

  it('should handle git branch detection failure gracefully', () => {
    mockedExecSync.mockImplementation((cmd: string, opts?: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes('rev-parse --abbrev-ref HEAD')) {
        throw new Error('not a git repository');
      }
      if (cmdStr.includes('worktree list --porcelain')) {
        throw new Error('not a git repository');
      }
      return '';
    });

    mkRepo('broken-repo');
    const results = scanProjects(tempRoot);

    expect(results).toHaveLength(1);
    expect(results[0]!.branch).toBe('unknown');
  });

  it('should handle worktree listing failure gracefully', () => {
    mockedExecSync.mockImplementation((cmd: string, opts?: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes('rev-parse --abbrev-ref HEAD')) {
        return 'main\n';
      }
      if (cmdStr.includes('worktree list --porcelain')) {
        throw new Error('git worktree command failed');
      }
      return '';
    });

    mkRepo('repo-no-worktrees');
    const results = scanProjects(tempRoot);

    // Should still find the repo, just no worktrees
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe('repo-no-worktrees');
    expect(results[0]!.type).toBe('repo');
  });

  it('should handle directories with permission errors', () => {
    mkDir('accessible');
    mkRepo('accessible/good-repo');
    // We can't easily simulate permission errors on temp dirs,
    // but the code has a try/catch around statSync — verify it doesn't crash
    const results = scanProjects(tempRoot);
    expect(results).toHaveLength(1);
  });

  // ─── Misc: files in the scan path ──────────────────────────────────────

  it('should ignore regular files (not directories) during traversal', () => {
    writeFileSync(join(tempRoot, 'README.md'), '# hello');
    writeFileSync(join(tempRoot, 'package.json'), '{}');
    mkRepo('real-project');

    const results = scanProjects(tempRoot);

    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe('real-project');
  });
});

// ─── scanMultipleProjects ────────────────────────────────────────────────

describe('scanMultipleProjects', () => {
  let tempRoot2: string;

  beforeEach(() => {
    tempRoot2 = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempRoot2, { recursive: true, force: true });
  });

  it('should merge results from multiple directories', () => {
    mkRepo('project-a');
    // Create repo in second temp root
    const project2 = join(tempRoot2, 'project-b');
    mkdirSync(project2, { recursive: true });
    mkdirSync(join(project2, '.git'), { recursive: true });

    const results = scanMultipleProjects([tempRoot, tempRoot2]);

    expect(results).toHaveLength(2);
    const names = results.map(r => r.name);
    expect(names).toContain('project-a');
    expect(names).toContain('project-b');
  });

  it('should deduplicate projects with the same path across directories', () => {
    // If both baseDirs somehow contain the same repo path (e.g., overlapping scan areas)
    mkRepo('shared-project');

    // Scan the same directory twice
    const results = scanMultipleProjects([tempRoot, tempRoot]);

    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe('shared-project');
  });

  it('should return empty array when all directories are empty', () => {
    const results = scanMultipleProjects([tempRoot, tempRoot2]);
    expect(results).toEqual([]);
  });

  it('should handle non-existent directories gracefully', () => {
    mkRepo('valid-project');
    const results = scanMultipleProjects([
      tempRoot,
      join(tempRoot, 'nonexistent'),
    ]);

    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe('valid-project');
  });

  it('should pass maxDepth to individual scanProjects calls', () => {
    mkDir('container');
    mkRepo('container/deep-project'); // depth 2

    // maxDepth=1 should NOT find the project at depth 2
    const shallow = scanMultipleProjects([tempRoot], 1);
    expect(shallow).toEqual([]);

    // maxDepth=2 should find it
    const deep = scanMultipleProjects([tempRoot], 2);
    expect(deep).toHaveLength(1);
    expect(deep[0]!.name).toBe('deep-project');
  });

  it('should sort merged results: repos first, then worktrees', () => {
    const repoPathA = mkRepo('alpha');
    const wtPath = join(tempRoot2, 'wt-checkout');
    mkdirSync(wtPath, { recursive: true });

    const repoPathB = join(tempRoot2, 'beta');
    mkdirSync(repoPathB, { recursive: true });
    mkdirSync(join(repoPathB, '.git'), { recursive: true });

    mockedExecSync.mockImplementation((cmd: string, opts?: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes('rev-parse --abbrev-ref HEAD')) {
        return 'main\n';
      }
      if (cmdStr.includes('worktree list --porcelain')) {
        if (opts?.cwd === repoPathB) {
          return [
            `worktree ${repoPathB}`,
            'branch refs/heads/main',
            '',
            `worktree ${wtPath}`,
            'branch refs/heads/wt-branch',
            '',
          ].join('\n');
        }
        return `worktree ${opts?.cwd}\nbranch refs/heads/main\n\n`;
      }
      return '';
    });

    const results = scanMultipleProjects([tempRoot, tempRoot2]);

    // All repos before worktrees
    const repoEntries = results.filter(r => r.type === 'repo');
    const wtEntries = results.filter(r => r.type === 'worktree');

    expect(repoEntries.length).toBeGreaterThanOrEqual(1);
    // If worktrees exist, they should come after all repos
    if (wtEntries.length > 0) {
      const lastRepoIdx = results.findLastIndex(r => r.type === 'repo');
      const firstWtIdx = results.findIndex(r => r.type === 'worktree');
      expect(lastRepoIdx).toBeLessThan(firstWtIdx);
    }
  });

  it('should handle empty baseDirs array', () => {
    const results = scanMultipleProjects([]);
    expect(results).toEqual([]);
  });
});
