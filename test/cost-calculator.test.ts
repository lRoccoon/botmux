/**
 * Unit tests for cost-calculator: getSessionJsonlPath, getSessionCost, formatNumber.
 *
 * Run:  pnpm vitest run test/cost-calculator.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';

// ─── Mocks ────────────────────────────────────────────────────────────────

// Mock os.homedir before importing the module under test
vi.mock('node:os', () => ({ homedir: () => '/home/testuser' }));

// Mock fs so we never touch real disk
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return {
    ...original,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => ''),
  };
});

// Mock the logger to suppress output
vi.mock('../src/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// expandHome is imported by cost-calculator from session-manager; provide a simple impl
vi.mock('../src/core/session-manager.js', () => ({
  expandHome: (p: string) => (p.startsWith('~') ? `/home/testuser${p.slice(1)}` : p),
}));

import { existsSync, readFileSync } from 'node:fs';
import {
  getSessionJsonlPath,
  getSessionCost,
  formatNumber,
  type SessionCost,
} from '../src/core/cost-calculator.js';

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Build a JSONL assistant entry with usage info. */
function assistantLine(opts: {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheCreate?: number;
  model?: string;
}): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      model: opts.model ?? 'claude-sonnet-4-20250514',
      usage: {
        input_tokens: opts.input ?? 0,
        output_tokens: opts.output ?? 0,
        cache_read_input_tokens: opts.cacheRead ?? 0,
        cache_creation_input_tokens: opts.cacheCreate ?? 0,
      },
    },
  });
}

/** Build a non-assistant JSONL entry (should be skipped). */
function userLine(text = 'hello'): string {
  return JSON.stringify({ type: 'human', message: { content: text } });
}

// ─── Tests ────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.mocked(existsSync).mockReset();
  vi.mocked(readFileSync).mockReset();
});

// ── getSessionJsonlPath ──────────────────────────────────────────────────

describe('getSessionJsonlPath', () => {
  it('returns the expected path when the jsonl file exists', () => {
    vi.mocked(existsSync).mockReturnValue(true);

    const result = getSessionJsonlPath('abc-123', '/projects/my-app');
    // cwd resolves to /projects/my-app; project key replaces / with -
    const expectedPath = join(
      '/home/testuser',
      '.claude',
      'projects',
      '-projects-my-app',
      'abc-123.jsonl',
    );
    expect(result).toBe(expectedPath);
    expect(existsSync).toHaveBeenCalledWith(expectedPath);
  });

  it('returns null when the jsonl file does not exist', () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const result = getSessionJsonlPath('abc-123', '/projects/my-app');
    expect(result).toBeNull();
  });

  it('handles cwd with tilde (expandHome)', () => {
    vi.mocked(existsSync).mockReturnValue(true);

    const result = getSessionJsonlPath('sess-1', '~/code/repo');
    // expandHome turns ~/code/repo -> /home/testuser/code/repo
    // project key: -home-testuser-code-repo
    const expectedPath = join(
      '/home/testuser',
      '.claude',
      'projects',
      '-home-testuser-code-repo',
      'sess-1.jsonl',
    );
    expect(result).toBe(expectedPath);
  });
});

// ── getSessionCost ──────────────────────────────────────────────────────

describe('getSessionCost', () => {
  /** Arrange: make the path exist and return the given file content. */
  function setupJsonl(content: string) {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(content);
  }

  it('returns null when the jsonl file does not exist', () => {
    vi.mocked(existsSync).mockReturnValue(false);
    expect(getSessionCost('id', '/tmp')).toBeNull();
  });

  it('parses a single assistant turn', () => {
    setupJsonl(assistantLine({ input: 100, output: 50, cacheRead: 10, cacheCreate: 5, model: 'claude-sonnet-4-20250514' }));

    const cost = getSessionCost('s1', '/tmp')!;
    expect(cost).toEqual<SessionCost>({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 10,
      cacheCreateTokens: 5,
      model: 'claude-sonnet-4-20250514',
      turns: 1,
    });
  });

  it('aggregates multiple assistant turns', () => {
    const lines = [
      assistantLine({ input: 100, output: 50, cacheRead: 10, cacheCreate: 5, model: 'claude-sonnet-4-20250514' }),
      assistantLine({ input: 200, output: 80, cacheRead: 20, cacheCreate: 0 }),
      assistantLine({ input: 300, output: 120, cacheRead: 30, cacheCreate: 15, model: 'claude-opus-4-20250514' }),
    ].join('\n');
    setupJsonl(lines);

    const cost = getSessionCost('s2', '/tmp')!;
    expect(cost.inputTokens).toBe(600);
    expect(cost.outputTokens).toBe(250);
    expect(cost.cacheReadTokens).toBe(60);
    expect(cost.cacheCreateTokens).toBe(20);
    // model is set from the first assistant entry
    expect(cost.model).toBe('claude-sonnet-4-20250514');
    expect(cost.turns).toBe(3);
  });

  it('skips non-assistant entries', () => {
    const lines = [
      userLine('hi'),
      assistantLine({ input: 50, output: 25 }),
      userLine('bye'),
    ].join('\n');
    setupJsonl(lines);

    const cost = getSessionCost('s3', '/tmp')!;
    expect(cost.inputTokens).toBe(50);
    expect(cost.outputTokens).toBe(25);
    expect(cost.turns).toBe(1);
  });

  it('handles empty file', () => {
    setupJsonl('');

    const cost = getSessionCost('s4', '/tmp')!;
    expect(cost).toEqual<SessionCost>({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
      model: '',
      turns: 0,
    });
  });

  it('handles file with only blank lines', () => {
    setupJsonl('\n\n  \n');

    const cost = getSessionCost('s5', '/tmp')!;
    expect(cost.turns).toBe(0);
    expect(cost.inputTokens).toBe(0);
  });

  it('skips malformed JSON lines gracefully', () => {
    const lines = [
      'this is not json',
      assistantLine({ input: 100, output: 50 }),
      '{ broken json',
      assistantLine({ input: 200, output: 100 }),
    ].join('\n');
    setupJsonl(lines);

    const cost = getSessionCost('s6', '/tmp')!;
    expect(cost.inputTokens).toBe(300);
    expect(cost.outputTokens).toBe(150);
    expect(cost.turns).toBe(2);
  });

  it('skips assistant entries without usage field', () => {
    const lines = [
      JSON.stringify({ type: 'assistant', message: { model: 'test' } }),
      assistantLine({ input: 50, output: 25 }),
    ].join('\n');
    setupJsonl(lines);

    const cost = getSessionCost('s7', '/tmp')!;
    // First line is type=assistant but has no usage, so skipped
    expect(cost.turns).toBe(1);
    expect(cost.inputTokens).toBe(50);
  });

  it('skips assistant entries without message field', () => {
    const lines = [
      JSON.stringify({ type: 'assistant' }),
      assistantLine({ input: 40, output: 20, model: 'my-model' }),
    ].join('\n');
    setupJsonl(lines);

    const cost = getSessionCost('s8', '/tmp')!;
    expect(cost.turns).toBe(1);
    expect(cost.model).toBe('my-model');
  });

  it('handles missing token fields by defaulting to 0', () => {
    // usage object present but with only partial fields
    const partial = JSON.stringify({
      type: 'assistant',
      message: {
        model: 'partial-model',
        usage: { input_tokens: 42 },
      },
    });
    setupJsonl(partial);

    const cost = getSessionCost('s9', '/tmp')!;
    expect(cost.inputTokens).toBe(42);
    expect(cost.outputTokens).toBe(0);
    expect(cost.cacheReadTokens).toBe(0);
    expect(cost.cacheCreateTokens).toBe(0);
    expect(cost.turns).toBe(1);
  });

  it('uses model from first assistant entry only', () => {
    const lines = [
      assistantLine({ input: 10, output: 5, model: 'first-model' }),
      assistantLine({ input: 10, output: 5, model: 'second-model' }),
    ].join('\n');
    setupJsonl(lines);

    const cost = getSessionCost('s10', '/tmp')!;
    expect(cost.model).toBe('first-model');
  });

  it('picks up model from a later entry if earlier ones lack model', () => {
    const noModel = JSON.stringify({
      type: 'assistant',
      message: { usage: { input_tokens: 10, output_tokens: 5 } },
    });
    const lines = [
      noModel,
      assistantLine({ input: 20, output: 10, model: 'late-model' }),
    ].join('\n');
    setupJsonl(lines);

    const cost = getSessionCost('s11', '/tmp')!;
    // First entry has no model field, so model comes from the second entry
    expect(cost.model).toBe('late-model');
    expect(cost.turns).toBe(2);
  });

  it('returns null when readFileSync throws', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error('EACCES: permission denied');
    });

    const cost = getSessionCost('s12', '/tmp');
    expect(cost).toBeNull();
  });

  it('handles trailing newline in JSONL file', () => {
    const content = assistantLine({ input: 10, output: 5 }) + '\n';
    setupJsonl(content);

    const cost = getSessionCost('s13', '/tmp')!;
    expect(cost.turns).toBe(1);
    expect(cost.inputTokens).toBe(10);
  });
});

// ── formatNumber ────────────────────────────────────────────────────────

describe('formatNumber', () => {
  it('formats small numbers without commas', () => {
    expect(formatNumber(42)).toBe('42');
  });

  it('formats thousands with commas', () => {
    expect(formatNumber(1_234)).toBe('1,234');
  });

  it('formats millions with commas', () => {
    expect(formatNumber(1_234_567)).toBe('1,234,567');
  });

  it('formats zero', () => {
    expect(formatNumber(0)).toBe('0');
  });
});
