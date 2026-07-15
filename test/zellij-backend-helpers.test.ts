import { describe, it, expect } from 'vitest';
import {
  tmuxKeyToBytes,
  kdlString,
  buildLayoutString,
  ZELLIJ_CONFIG_KDL,
  parseZellijServerProcs,
} from '../src/adapters/backend/zellij-backend.js';
import {
  unixPathCounts,
  grownPaths,
} from '../src/adapters/backend/zellij-socket-probe.js';
import {
  parseZellijVersion,
  isZellijVersionSupported,
} from '../src/setup/ensure-zellij.js';

describe('tmuxKeyToBytes', () => {
  it('maps named keys to terminal byte sequences', () => {
    expect(tmuxKeyToBytes('Enter')).toBe('\r');
    expect(tmuxKeyToBytes('Escape')).toBe('\x1b');
    expect(tmuxKeyToBytes('Tab')).toBe('\t');
    expect(tmuxKeyToBytes('BSpace')).toBe('\x7f');
    expect(tmuxKeyToBytes('Up')).toBe('\x1b[A');
    expect(tmuxKeyToBytes('M-Enter')).toBe('\x1b\r');
  });

  it('maps C-<x> control combos to control bytes', () => {
    expect(tmuxKeyToBytes('C-c')).toBe('\x03');
    expect(tmuxKeyToBytes('C-d')).toBe('\x04');
    expect(tmuxKeyToBytes('C-a')).toBe('\x01');
  });

  it('maps M-<x> meta combos to ESC-prefixed bytes', () => {
    expect(tmuxKeyToBytes('M-b')).toBe('\x1bb');
  });

  it('falls back to the literal string for unknown keys (no dropped input)', () => {
    expect(tmuxKeyToBytes('weird')).toBe('weird');
  });
});

describe('kdlString', () => {
  it('escapes backslashes and quotes', () => {
    expect(kdlString('a"b\\c')).toBe('"a\\"b\\\\c"');
  });
});

describe('buildLayoutString', () => {
  it('produces a single command pane with close_on_exit and the CLI args', () => {
    const kdl = buildLayoutString('claude', ['--resume', 'abc'], {
      cwd: '/work/dir',
      cols: 120,
      rows: 40,
      env: {},
    });
    expect(kdl).toContain('layout {');
    expect(kdl).toContain('close_on_exit=true');
    // cwd is passed as a wrapper-script arg (execvp semantics, KDL-quoted).
    expect(kdl).toContain('"/work/dir"');
    expect(kdl).toContain('"claude"');
    expect(kdl).toContain('"--resume"');
    expect(kdl).toContain('"abc"');
  });
});

describe('ZELLIJ_CONFIG_KDL', () => {
  it('locks input and clears keybinds so pty.write passes straight through', () => {
    expect(ZELLIJ_CONFIG_KDL).toContain('default_mode "locked"');
    expect(ZELLIJ_CONFIG_KDL).toContain('clear-defaults=true');
  });
});

describe('zellij version gate', () => {
  it('parses versions', () => {
    expect(parseZellijVersion('zellij 0.44.1')).toEqual({ major: 0, minor: 44, patch: 1 });
    expect(parseZellijVersion('garbage')).toBeUndefined();
  });

  it('requires >= 0.44.0', () => {
    expect(isZellijVersionSupported({ major: 0, minor: 44, patch: 1 })).toBe(true);
    expect(isZellijVersionSupported({ major: 0, minor: 44, patch: 0 })).toBe(true);
    expect(isZellijVersionSupported({ major: 0, minor: 43, patch: 9 })).toBe(false);
    expect(isZellijVersionSupported({ major: 0, minor: 45, patch: 0 })).toBe(true);
    expect(isZellijVersionSupported({ major: 1, minor: 0, patch: 0 })).toBe(true);
  });
});

// Rename-proof server lookup (session-manager rename-session renames the
// socket FILE but the server argv keeps the spawn-time path — verified live).
describe('parseZellijServerProcs', () => {
  const PS = [
    ' 1150415 /root/.local/share/mise/installs/zellij/0.44.1/zellij --server /run/user/0/zellij/contract_version_1/zadopt-ren',
    ' 2836020 /usr/bin/zellij --server /run/user/0/zellij/contract_version_1/other-sess',
    '    4242 grep zellij --server /tmp/fake', // grep noise: argv matches shape → tolerated by design (inode match rejects it)
    '    9999 /usr/bin/zsh',
  ].join('\n');

  it('extracts pid + spawn-time socket path of server processes', () => {
    const servers = parseZellijServerProcs(PS);
    expect(servers.map(s => s.pid)).toContain(1150415);
    expect(servers.find(s => s.pid === 1150415)!.socketPath)
      .toBe('/run/user/0/zellij/contract_version_1/zadopt-ren');
    expect(servers.map(s => s.pid)).not.toContain(9999);
  });
});

describe('zellij-socket-probe pure helpers', () => {
  // Real /proc/net/unix shape (verified live): the bound path column carries
  // the SPAWN-TIME name; listening + accepted rows share it; client ends have
  // no path column. Connecting to the RENAMED socket file makes the stale
  // path's row count grow — that diff is the name→server mapping.
  const DIR = '/run/user/0/zellij/contract_version_1';
  const BEFORE = [
    'Num       RefCount Protocol Flags    Type St Inode Path',
    `ffff0001: 00000002 00000000 00010000 0001 01 111222 ${DIR}/zadopt-ren`,
    `ffff0003: 00000002 00000000 00010000 0001 01 444555 ${DIR}/other-sess`,
    'ffff0004: 00000002 00000000 00000000 0001 03 666777',
    'ffff0005: 00000002 00000000 00010000 0001 01 888999 /run/user/0/other-app/sock',
  ].join('\n');
  const AFTER = [
    BEFORE,
    `ffff0006: 00000003 00000000 00000000 0001 03 111333 ${DIR}/zadopt-ren`,
  ].join('\n');

  it('counts rows per bound path scoped to the socket dir', () => {
    const counts = unixPathCounts(BEFORE, DIR);
    expect(counts.get(`${DIR}/zadopt-ren`)).toBe(1);
    expect(counts.get(`${DIR}/other-sess`)).toBe(1);
    expect(counts.has('/run/user/0/other-app/sock')).toBe(false);
  });

  it('reveals exactly the stale bound path whose count grew on connect', () => {
    const grown = grownPaths(unixPathCounts(BEFORE, DIR), unixPathCounts(AFTER, DIR));
    expect(grown).toEqual([`${DIR}/zadopt-ren`]);
  });

  it('reports nothing when no accept happened', () => {
    expect(grownPaths(unixPathCounts(BEFORE, DIR), unixPathCounts(BEFORE, DIR))).toEqual([]);
  });
});
