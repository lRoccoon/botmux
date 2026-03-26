/**
 * Unit tests for CLI adapters: factory, buildArgs, patterns, properties, ensureMcpConfig.
 *
 * Run:  pnpm vitest run test/cli-adapters.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock external dependencies BEFORE importing adapters
// ---------------------------------------------------------------------------

// Mock child_process.execSync so resolveCommand() returns the command as-is
// and ensureMcpConfig() calls that shell out don't actually run.
vi.mock('node:child_process', () => ({
  execSync: vi.fn(() => ''),
}));

// Virtual fs for adapters that read/write JSON config files
import { vol } from 'memfs';
vi.mock('node:fs', async () => {
  const memfs = await import('memfs');
  return memfs.fs;
});

import { createCliAdapterSync } from '../src/adapters/cli/registry.js';
import { createClaudeCodeAdapter } from '../src/adapters/cli/claude-code.js';
import { createAidenAdapter } from '../src/adapters/cli/aiden.js';
import { createCocoAdapter } from '../src/adapters/cli/coco.js';
import { createCodexAdapter } from '../src/adapters/cli/codex.js';
import { createGeminiAdapter } from '../src/adapters/cli/gemini.js';
import { createOpenCodeAdapter } from '../src/adapters/cli/opencode.js';
import { execSync } from 'node:child_process';
import type { CliAdapter, CliId, McpServerEntry } from '../src/adapters/cli/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ALL_CLI_IDS: CliId[] = ['claude-code', 'aiden', 'coco', 'codex', 'gemini', 'opencode'];

function makeMcpEntry(overrides?: Partial<McpServerEntry>): McpServerEntry {
  return {
    name: 'botmux',
    command: 'node',
    args: ['/path/to/server.js'],
    env: { LARK_APP_ID: 'app1', LARK_APP_SECRET: 'secret1' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Factory: createCliAdapterSync
// ---------------------------------------------------------------------------

describe('createCliAdapterSync factory', () => {
  it.each(ALL_CLI_IDS)('returns an adapter for "%s"', (id) => {
    const adapter = createCliAdapterSync(id, `/mock/bin/${id}`);
    expect(adapter).toBeDefined();
    expect(adapter.id).toBe(id);
  });

  it('throws for unknown CLI id', () => {
    expect(() => createCliAdapterSync('unknown-cli' as CliId)).toThrow(/Unknown CLI adapter/);
  });

  it.each(ALL_CLI_IDS)('adapter for "%s" has resolvedBin set', (id) => {
    const adapter = createCliAdapterSync(id, `/opt/${id}`);
    expect(adapter.resolvedBin).toBe(`/opt/${id}`);
  });
});

// ---------------------------------------------------------------------------
// 2. buildArgs
// ---------------------------------------------------------------------------

describe('claude-code buildArgs', () => {
  const adapter = createClaudeCodeAdapter('/usr/bin/claude');

  it('new session passes --session-id and permission flags', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-1', resume: false });
    expect(args).toContain('--session-id');
    expect(args).toContain('sess-1');
    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('--resume');
  });

  it('resume session passes --resume', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-1', resume: true });
    expect(args).toContain('--resume');
    expect(args).toContain('sess-1');
    expect(args).not.toContain('--session-id');
  });

  it('disallows plan mode tools', () => {
    const args = adapter.buildArgs({ sessionId: 's', resume: false });
    const idx = args.indexOf('--disallowed-tools');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toContain('EnterPlanMode');
    expect(args[idx + 1]).toContain('ExitPlanMode');
  });

  it('ignores initialPrompt (not passed via args)', () => {
    const args = adapter.buildArgs({ sessionId: 's', resume: false, initialPrompt: 'hello' });
    expect(args).not.toContain('hello');
    expect(adapter.passesInitialPromptViaArgs).toBeFalsy();
  });
});

describe('aiden buildArgs', () => {
  const adapter = createAidenAdapter('/usr/bin/aiden');

  it('new session does not include --resume or session id', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-2', resume: false });
    expect(args).not.toContain('--resume');
    expect(args).not.toContain('sess-2');
    expect(args).toContain('--permission-mode');
    expect(args).toContain('agentFull');
  });

  it('resume session passes --resume with session id', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-2', resume: true });
    expect(args).toContain('--resume');
    expect(args).toContain('sess-2');
  });
});

describe('coco buildArgs', () => {
  const adapter = createCocoAdapter('/usr/bin/coco');

  it('new session passes --session-id', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-3', resume: false });
    expect(args).toContain('--session-id');
    expect(args).toContain('sess-3');
    expect(args).toContain('--yolo');
  });

  it('resume session passes --resume', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-3', resume: true });
    expect(args).toContain('--resume');
    expect(args).toContain('sess-3');
    expect(args).not.toContain('--session-id');
  });

  it('disallows plan mode tools', () => {
    const args = adapter.buildArgs({ sessionId: 's', resume: false });
    // CoCo uses repeated --disallowed-tool flags
    const indices = args.reduce<number[]>((acc, v, i) => v === '--disallowed-tool' ? [...acc, i] : acc, []);
    expect(indices.length).toBe(2);
    expect(args[indices[0] + 1]).toBe('EnterPlanMode');
    expect(args[indices[1] + 1]).toBe('ExitPlanMode');
  });
});

describe('codex buildArgs', () => {
  const adapter = createCodexAdapter('/usr/bin/codex');

  it('always returns fixed args regardless of session/resume', () => {
    const args1 = adapter.buildArgs({ sessionId: 'sess-4', resume: false });
    const args2 = adapter.buildArgs({ sessionId: 'sess-4', resume: true });
    expect(args1).toEqual(args2);
    expect(args1).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(args1).toContain('--no-alt-screen');
  });

  it('does not include session id', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-4', resume: false });
    expect(args).not.toContain('sess-4');
  });
});

describe('gemini buildArgs', () => {
  const adapter = createGeminiAdapter('/usr/bin/gemini');

  it('basic args include --yolo', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-5', resume: false });
    expect(args).toContain('--yolo');
    expect(args).not.toContain('-i');
  });

  it('passes initialPrompt via -i flag', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-5', resume: false, initialPrompt: 'do something' });
    expect(args).toContain('-i');
    const idx = args.indexOf('-i');
    expect(args[idx + 1]).toBe('do something');
  });

  it('passesInitialPromptViaArgs is true', () => {
    expect(adapter.passesInitialPromptViaArgs).toBe(true);
  });

  it('does not include session id', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-5', resume: false });
    expect(args).not.toContain('sess-5');
  });
});

describe('opencode buildArgs', () => {
  const adapter = createOpenCodeAdapter('/usr/bin/opencode');

  it('returns empty args for basic case', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-6', resume: false });
    expect(args).toEqual([]);
  });

  it('passes initialPrompt via --prompt flag', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-6', resume: false, initialPrompt: 'hello world' });
    expect(args).toContain('--prompt');
    const idx = args.indexOf('--prompt');
    expect(args[idx + 1]).toBe('hello world');
  });

  it('passesInitialPromptViaArgs is true', () => {
    expect(adapter.passesInitialPromptViaArgs).toBe(true);
  });

  it('does not include session id or resume', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-6', resume: true });
    expect(args).not.toContain('sess-6');
    expect(args).not.toContain('--resume');
  });
});

// ---------------------------------------------------------------------------
// 3. completionPattern and readyPattern
// ---------------------------------------------------------------------------

describe('completionPattern', () => {
  it('claude-code matches "Worked for" completion line', () => {
    const adapter = createClaudeCodeAdapter('/bin/claude');
    const lines = [
      '\u2733 Worked for 12s',
      '\u2733 Crunched for 3m',
      '\u2733 Cogitated for 1h',
      '\u2733 Cooked for 45s',
      '\u2733 Churned for 8s',
      '\u2733 Sauteed for 2s',
      '\u2733 Sautéed for 2s',
    ];
    for (const line of lines) {
      expect(adapter.completionPattern!.test(line), `should match: ${line}`).toBe(true);
    }
  });

  it('claude-code does not match unrelated text', () => {
    const adapter = createClaudeCodeAdapter('/bin/claude');
    expect(adapter.completionPattern!.test('Processing...')).toBe(false);
    expect(adapter.completionPattern!.test('Worked on it')).toBe(false);
  });

  it('aiden has no completionPattern', () => {
    expect(createAidenAdapter('/bin/aiden').completionPattern).toBeUndefined();
  });

  it('coco has no completionPattern', () => {
    expect(createCocoAdapter('/bin/coco').completionPattern).toBeUndefined();
  });

  it('codex has no completionPattern', () => {
    expect(createCodexAdapter('/bin/codex').completionPattern).toBeUndefined();
  });

  it('gemini has no completionPattern', () => {
    expect(createGeminiAdapter('/bin/gemini').completionPattern).toBeUndefined();
  });

  it('opencode has no completionPattern', () => {
    expect(createOpenCodeAdapter('/bin/opencode').completionPattern).toBeUndefined();
  });
});

describe('readyPattern', () => {
  it('claude-code matches prompt indicator', () => {
    const adapter = createClaudeCodeAdapter('/bin/claude');
    expect(adapter.readyPattern).toBeDefined();
    expect(adapter.readyPattern!.test('❯')).toBe(true);
    expect(adapter.readyPattern!.test('some prefix ❯ suffix')).toBe(true);
  });

  it('coco matches status bar indicator', () => {
    const adapter = createCocoAdapter('/bin/coco');
    expect(adapter.readyPattern).toBeDefined();
    expect(adapter.readyPattern!.test('⏵⏵')).toBe(true);
    expect(adapter.readyPattern!.test('line with ⏵⏵ status')).toBe(true);
  });

  it('codex matches prompt indicator', () => {
    const adapter = createCodexAdapter('/bin/codex');
    expect(adapter.readyPattern).toBeDefined();
    expect(adapter.readyPattern!.test('›')).toBe(true);
    expect(adapter.readyPattern!.test('97% left')).toBe(true);
  });

  it('aiden has no readyPattern', () => {
    expect(createAidenAdapter('/bin/aiden').readyPattern).toBeUndefined();
  });

  it('gemini has no readyPattern', () => {
    expect(createGeminiAdapter('/bin/gemini').readyPattern).toBeUndefined();
  });

  it('opencode has no readyPattern', () => {
    expect(createOpenCodeAdapter('/bin/opencode').readyPattern).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 4. systemHints
// ---------------------------------------------------------------------------

describe('systemHints', () => {
  it('claude-code has empty systemHints', () => {
    expect(createClaudeCodeAdapter('/bin/claude').systemHints).toEqual([]);
  });

  it('aiden has empty systemHints', () => {
    expect(createAidenAdapter('/bin/aiden').systemHints).toEqual([]);
  });

  it('coco has non-empty systemHints', () => {
    const hints = createCocoAdapter('/bin/coco').systemHints;
    expect(Array.isArray(hints)).toBe(true);
    expect(hints.length).toBeGreaterThan(0);
    // Verify hints mention send_to_thread (key integration guidance)
    expect(hints.some(h => h.includes('send_to_thread'))).toBe(true);
  });

  it('codex has empty systemHints', () => {
    expect(createCodexAdapter('/bin/codex').systemHints).toEqual([]);
  });

  it('gemini has empty systemHints', () => {
    expect(createGeminiAdapter('/bin/gemini').systemHints).toEqual([]);
  });

  it('opencode has empty systemHints', () => {
    expect(createOpenCodeAdapter('/bin/opencode').systemHints).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5. id property
// ---------------------------------------------------------------------------

describe('id property', () => {
  const expected: [CliId, () => CliAdapter][] = [
    ['claude-code', () => createClaudeCodeAdapter('/bin/claude')],
    ['aiden', () => createAidenAdapter('/bin/aiden')],
    ['coco', () => createCocoAdapter('/bin/coco')],
    ['codex', () => createCodexAdapter('/bin/codex')],
    ['gemini', () => createGeminiAdapter('/bin/gemini')],
    ['opencode', () => createOpenCodeAdapter('/bin/opencode')],
  ];

  it.each(expected)('adapter id is "%s"', (expectedId, factory) => {
    expect(factory().id).toBe(expectedId);
  });
});

// ---------------------------------------------------------------------------
// 6. altScreen property
// ---------------------------------------------------------------------------

describe('altScreen property', () => {
  it('gemini uses alt screen', () => {
    expect(createGeminiAdapter('/bin/gemini').altScreen).toBe(true);
  });

  it('opencode uses alt screen', () => {
    expect(createOpenCodeAdapter('/bin/opencode').altScreen).toBe(true);
  });

  it('claude-code does not use alt screen', () => {
    expect(createClaudeCodeAdapter('/bin/claude').altScreen).toBe(false);
  });

  it('aiden does not use alt screen', () => {
    expect(createAidenAdapter('/bin/aiden').altScreen).toBe(false);
  });

  it('coco does not use alt screen', () => {
    expect(createCocoAdapter('/bin/coco').altScreen).toBe(false);
  });

  it('codex does not use alt screen', () => {
    expect(createCodexAdapter('/bin/codex').altScreen).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. ensureMcpConfig — file-based adapters (claude-code, aiden, opencode)
// ---------------------------------------------------------------------------

describe('ensureMcpConfig: claude-code (writes ~/.claude.json)', () => {
  const homedir = process.env.HOME || '/root';

  beforeEach(() => {
    vol.reset();
    // Ensure the home directory exists in memfs
    vol.mkdirSync(homedir, { recursive: true });
  });

  it('creates config file when it does not exist', () => {
    const adapter = createClaudeCodeAdapter('/bin/claude');
    const entry = makeMcpEntry();
    adapter.ensureMcpConfig(entry);

    const configPath = `${homedir}/.claude.json`;
    const data = JSON.parse(vol.readFileSync(configPath, 'utf-8') as string);
    expect(data.mcpServers.botmux).toBeDefined();
    expect(data.mcpServers.botmux.command).toBe('node');
    expect(data.mcpServers.botmux.args).toEqual(['/path/to/server.js']);
    expect(data.mcpServers.botmux.env).toEqual({ LARK_APP_ID: 'app1', LARK_APP_SECRET: 'secret1' });
  });

  it('is idempotent — skips write when config matches', () => {
    const adapter = createClaudeCodeAdapter('/bin/claude');
    const entry = makeMcpEntry();
    adapter.ensureMcpConfig(entry);
    adapter.ensureMcpConfig(entry);

    // Just verify no error and config is still correct
    const configPath = `${homedir}/.claude.json`;
    const data = JSON.parse(vol.readFileSync(configPath, 'utf-8') as string);
    expect(data.mcpServers.botmux).toBeDefined();
  });

  it('updates config when env changes', () => {
    const adapter = createClaudeCodeAdapter('/bin/claude');
    adapter.ensureMcpConfig(makeMcpEntry());
    adapter.ensureMcpConfig(makeMcpEntry({ env: { LARK_APP_ID: 'app2', LARK_APP_SECRET: 'secret2' } }));

    const configPath = `${homedir}/.claude.json`;
    const data = JSON.parse(vol.readFileSync(configPath, 'utf-8') as string);
    expect(data.mcpServers.botmux.env).toEqual({ LARK_APP_ID: 'app2', LARK_APP_SECRET: 'secret2' });
  });

  it('removes stale entries pointing to the same server script', () => {
    const adapter = createClaudeCodeAdapter('/bin/claude');
    const configPath = `${homedir}/.claude.json`;

    // Pre-populate with a stale entry
    const existing = {
      mcpServers: {
        'claude-code-robot': { command: 'node', args: ['/path/to/server.js'], env: {} },
      },
    };
    vol.writeFileSync(configPath, JSON.stringify(existing));

    adapter.ensureMcpConfig(makeMcpEntry());

    const data = JSON.parse(vol.readFileSync(configPath, 'utf-8') as string);
    expect(data.mcpServers['claude-code-robot']).toBeUndefined();
    expect(data.mcpServers.botmux).toBeDefined();
  });
});

describe('ensureMcpConfig: aiden (writes ~/.aiden/.mcp.json)', () => {
  const homedir = process.env.HOME || '/root';

  beforeEach(() => {
    vol.reset();
    vol.mkdirSync(homedir, { recursive: true });
  });

  it('creates config file when it does not exist', () => {
    const adapter = createAidenAdapter('/bin/aiden');
    adapter.ensureMcpConfig(makeMcpEntry());

    const configPath = `${homedir}/.aiden/.mcp.json`;
    const data = JSON.parse(vol.readFileSync(configPath, 'utf-8') as string);
    expect(data.mcpServers.botmux).toBeDefined();
    expect(data.mcpServers.botmux.command).toBe('node');
  });

  it('removes stale entries pointing to same server script', () => {
    const adapter = createAidenAdapter('/bin/aiden');
    const configPath = `${homedir}/.aiden/.mcp.json`;

    vol.mkdirSync(`${homedir}/.aiden`, { recursive: true });
    const existing = {
      mcpServers: {
        'claude-code-robot': { command: 'node', args: ['/path/to/server.js'], env: {} },
      },
    };
    vol.writeFileSync(configPath, JSON.stringify(existing));

    adapter.ensureMcpConfig(makeMcpEntry());

    const data = JSON.parse(vol.readFileSync(configPath, 'utf-8') as string);
    expect(data.mcpServers['claude-code-robot']).toBeUndefined();
    expect(data.mcpServers.botmux).toBeDefined();
  });
});

describe('ensureMcpConfig: opencode (writes ~/.config/opencode/opencode.json)', () => {
  const homedir = process.env.HOME || '/root';

  beforeEach(() => {
    vol.reset();
    vol.mkdirSync(homedir, { recursive: true });
  });

  it('creates config file when it does not exist', () => {
    const adapter = createOpenCodeAdapter('/bin/opencode');
    adapter.ensureMcpConfig(makeMcpEntry());

    const configPath = `${homedir}/.config/opencode/opencode.json`;
    const data = JSON.parse(vol.readFileSync(configPath, 'utf-8') as string);
    expect(data.mcp.botmux).toBeDefined();
    expect(data.mcp.botmux.type).toBe('local');
    expect(data.mcp.botmux.command).toEqual(['node', '/path/to/server.js']);
    expect(data.mcp.botmux.environment).toEqual({ LARK_APP_ID: 'app1', LARK_APP_SECRET: 'secret1' });
  });

  it('is idempotent — skips write when config matches', () => {
    const adapter = createOpenCodeAdapter('/bin/opencode');
    const entry = makeMcpEntry();
    adapter.ensureMcpConfig(entry);
    adapter.ensureMcpConfig(entry);

    const configPath = `${homedir}/.config/opencode/opencode.json`;
    const data = JSON.parse(vol.readFileSync(configPath, 'utf-8') as string);
    expect(data.mcp.botmux).toBeDefined();
  });

  it('removes stale entries pointing to same server script', () => {
    const adapter = createOpenCodeAdapter('/bin/opencode');
    const configPath = `${homedir}/.config/opencode/opencode.json`;

    vol.mkdirSync(`${homedir}/.config/opencode`, { recursive: true });
    const existing = {
      mcp: {
        'claude-code-robot': { type: 'local', command: ['node', '/path/to/server.js'], environment: {} },
      },
    };
    vol.writeFileSync(configPath, JSON.stringify(existing));

    adapter.ensureMcpConfig(makeMcpEntry());

    const data = JSON.parse(vol.readFileSync(configPath, 'utf-8') as string);
    expect(data.mcp['claude-code-robot']).toBeUndefined();
    expect(data.mcp.botmux).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 8. ensureMcpConfig — shell-based adapters (coco, codex, gemini)
// ---------------------------------------------------------------------------

describe('ensureMcpConfig: coco (shells out to coco mcp add-json)', () => {
  const mockedExecSync = vi.mocked(execSync);

  beforeEach(() => {
    mockedExecSync.mockReset();
    mockedExecSync.mockReturnValue('');
  });

  it('calls coco mcp remove then add-json', () => {
    const adapter = createCocoAdapter('/usr/bin/coco');
    adapter.ensureMcpConfig(makeMcpEntry());

    const calls = mockedExecSync.mock.calls.map(c => c[0] as string);
    // Should remove stale "claude-code-robot" entry
    expect(calls.some(c => c.includes('mcp remove claude-code-robot'))).toBe(true);
    // Should remove existing entry
    expect(calls.some(c => c.includes('mcp remove botmux'))).toBe(true);
    // Should add new entry
    expect(calls.some(c => c.includes('mcp add-json botmux'))).toBe(true);
  });
});

describe('ensureMcpConfig: codex (shells out to codex mcp add)', () => {
  const mockedExecSync = vi.mocked(execSync);

  beforeEach(() => {
    mockedExecSync.mockReset();
    mockedExecSync.mockReturnValue('');
  });

  it('calls codex mcp remove then add with env args', () => {
    const adapter = createCodexAdapter('/usr/bin/codex');
    adapter.ensureMcpConfig(makeMcpEntry());

    const calls = mockedExecSync.mock.calls.map(c => c[0] as string);
    expect(calls.some(c => c.includes('mcp remove claude-code-robot'))).toBe(true);
    expect(calls.some(c => c.includes('mcp remove botmux'))).toBe(true);
    const addCall = calls.find(c => c.includes('mcp add botmux'));
    expect(addCall).toBeDefined();
    expect(addCall).toContain('--env LARK_APP_ID=app1');
    expect(addCall).toContain('--env LARK_APP_SECRET=secret1');
    expect(addCall).toContain('-- node /path/to/server.js');
  });
});

describe('ensureMcpConfig: gemini (shells out to gemini mcp add)', () => {
  const mockedExecSync = vi.mocked(execSync);

  beforeEach(() => {
    mockedExecSync.mockReset();
    mockedExecSync.mockReturnValue('');
  });

  it('calls gemini mcp remove then add with -e env args', () => {
    const adapter = createGeminiAdapter('/usr/bin/gemini');
    adapter.ensureMcpConfig(makeMcpEntry());

    const calls = mockedExecSync.mock.calls.map(c => c[0] as string);
    expect(calls.some(c => c.includes('mcp remove claude-code-robot'))).toBe(true);
    expect(calls.some(c => c.includes('mcp remove botmux'))).toBe(true);
    const addCall = calls.find(c => c.includes('mcp add botmux'));
    expect(addCall).toBeDefined();
    expect(addCall).toContain('-e LARK_APP_ID=app1');
    expect(addCall).toContain('-e LARK_APP_SECRET=secret1');
    expect(addCall).toContain('--trust');
    expect(addCall).toContain('--scope user');
    expect(addCall).toContain('node /path/to/server.js');
  });
});
