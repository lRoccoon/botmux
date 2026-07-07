import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordObservedBotUnionId, getBotUnionIdByName, listBotUnionIds } from '../src/services/observed-bot-union-ids-store.js';

describe('bot-union-ids-store', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bui-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('records and looks up by name (case-insensitive)', () => {
    expect(recordObservedBotUnionId(dir, 'traex-loopy(d2)', 'on_abc', 'ou_x')).toBe(true);
    expect(getBotUnionIdByName(dir, 'traex-loopy(d2)')).toBe('on_abc');
    // lookup is case-insensitive (cross-ref lowercases; consumers pass display case)
    expect(getBotUnionIdByName(dir, 'TRAEX-LOOPY(D2)')).toBe('on_abc');
  });

  it('returns undefined for unknown / empty names', () => {
    expect(getBotUnionIdByName(dir, 'nope')).toBeUndefined();
    expect(getBotUnionIdByName(dir, '')).toBeUndefined();
    expect(getBotUnionIdByName(dir, '   ')).toBeUndefined();
  });

  it('no-ops on empty name or union_id (no file written)', () => {
    expect(recordObservedBotUnionId(dir, '', 'on_x')).toBe(false);
    expect(recordObservedBotUnionId(dir, 'name', '')).toBe(false);
    expect(existsSync(join(dir, 'observed-bot-union-ids.json'))).toBe(false);
  });

  it('upsert keeps firstSeenAt, bumps lastSeenAt, refreshes union_id', () => {
    recordObservedBotUnionId(dir, 'bot', 'on_old', 'ou_1', 1000);
    const wrote = recordObservedBotUnionId(dir, 'bot', 'on_new', 'ou_2', 5000);
    expect(wrote).toBe(true);
    expect(getBotUnionIdByName(dir, 'bot')).toBe('on_new');
    const data = JSON.parse(readFileSync(join(dir, 'observed-bot-union-ids.json'), 'utf-8'));
    expect(data.byName['bot'].firstSeenAt).toBe(1000);
    expect(data.byName['bot'].lastSeenAt).toBe(5000);
    expect(data.byName['bot'].lastOpenId).toBe('ou_2');
  });

  it('skips a redundant write when unchanged and recently seen', () => {
    recordObservedBotUnionId(dir, 'bot', 'on_x', 'ou_1', 1000);
    // same union_id + open_id, 1 min later → within the 10-min skip window
    expect(recordObservedBotUnionId(dir, 'bot', 'on_x', 'ou_1', 1000 + 60_000)).toBe(false);
    // same union_id but 11 min later → refresh lastSeenAt
    expect(recordObservedBotUnionId(dir, 'bot', 'on_x', 'ou_1', 1000 + 11 * 60_000)).toBe(true);
  });

  it('listBotUnionIds returns all learned pairs (lowercased keys)', () => {
    recordObservedBotUnionId(dir, 'Alpha', 'on_a');
    recordObservedBotUnionId(dir, 'Beta', 'on_b');
    expect(listBotUnionIds(dir)).toEqual({ alpha: 'on_a', beta: 'on_b' });
  });

  it('survives a corrupt file (returns empty, then overwrites)', () => {
    const fp = join(dir, 'observed-bot-union-ids.json');
    writeFileSync(fp, '{ not json');
    expect(getBotUnionIdByName(dir, 'x')).toBeUndefined();
    expect(recordObservedBotUnionId(dir, 'x', 'on_x')).toBe(true);
    expect(getBotUnionIdByName(dir, 'x')).toBe('on_x');
  });
});
