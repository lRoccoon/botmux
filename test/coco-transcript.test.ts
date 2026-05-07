import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drainCocoEvents } from '../src/services/coco-transcript.js';

let dir: string;
let path: string;

function line(obj: any): string { return JSON.stringify(obj) + '\n'; }
function msg(role: 'user' | 'assistant', content: string, extra: any = {}, ts = '2026-04-30T02:33:13.000+08:00') {
  return {
    id: Math.random().toString(36).slice(2),
    created_at: ts,
    message: { message: { role, content, extra } },
  };
}
function originalUser(content: string) { return msg('user', content, { is_original_user_input: true }); }
function assistant(content: string) { return msg('assistant', content, { response_meta: { finish_reason: 'stop' } }); }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'coco-transcript-'));
  path = join(dir, 'events.jsonl');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('drainCocoEvents', () => {
  it('returns empty for missing file', () => {
    const r = drainCocoEvents(join(dir, 'missing.jsonl'), 0);
    expect(r.events).toEqual([]);
    expect(r.newOffset).toBe(0);
  });

  it('extracts original user prompt and assistant final message', () => {
    writeFileSync(path, line(originalUser('just say PONG')) + line(assistant('PONG')));
    const r = drainCocoEvents(path, 0);
    expect(r.events.map(e => [e.kind, e.text])).toEqual([
      ['user', 'just say PONG'],
      ['assistant_final', 'PONG'],
    ]);
  });

  it('skips injected user system reminders', () => {
    writeFileSync(path,
      line(msg('user', '<system-reminder>ignore</system-reminder>', { is_additional_context_input: true })) +
      line(originalUser('real prompt')));
    const r = drainCocoEvents(path, 0);
    expect(r.events).toHaveLength(1);
    expect(r.events[0].text).toBe('real prompt');
  });

  it('ignores malformed and non-message lines', () => {
    writeFileSync(path, 'bad json\n' + line({ state_update: { updates: {} } }) + line(assistant('done')));
    const r = drainCocoEvents(path, 0);
    expect(r.events.map(e => e.text)).toEqual(['done']);
  });

  it('drains incrementally and keeps partial trailing line pending', () => {
    writeFileSync(path, line(originalUser('first')) + '{"message":');
    const r1 = drainCocoEvents(path, 0);
    expect(r1.events).toHaveLength(1);
    expect(r1.pendingTail).toContain('message');
    expect(r1.newOffset).toBeLessThan(statSync(path).size);

    appendFileSync(path, '\n' + line(assistant('reply')));
    const r2 = drainCocoEvents(path, r1.newOffset);
    expect(r2.events.map(e => e.text)).toEqual(['reply']);
  });

  it('re-drains from top after truncation', () => {
    writeFileSync(path, line(originalUser('long original prompt')) + line(assistant('long reply')));
    const r1 = drainCocoEvents(path, 0);
    writeFileSync(path, line(originalUser('new')));
    const r2 = drainCocoEvents(path, r1.newOffset);
    expect(r2.events.map(e => e.text)).toEqual(['new']);
  });
});
