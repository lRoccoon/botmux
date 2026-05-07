/**
 * Reader for CoCo's per-session events JSONL.
 *
 * CoCo stores each session under:
 *   ~/.cache/coco/sessions/<sessionId>/events.jsonl
 *
 * The bridge fallback only needs the original user prompt and the final
 * assistant message. Those appear as event objects containing
 * `message.message.role === "user" | "assistant"`. CoCo also writes
 * additional user-shaped system reminders; we intentionally keep only
 * user messages whose `extra.is_original_user_input === true` so a Lark
 * turn fingerprints against the user's prompt, not injected context.
 */
import { existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface CocoBridgeEvent {
  /** Synthetic uuid for dedup: `<absPath>:<byteOffset>` of the line start. */
  uuid: string;
  /** Wall-clock ms parsed from `created_at`, falling back to Date.now(). */
  timestampMs: number;
  /** 'user' starts a pending Lark turn; 'assistant_final' closes it. */
  kind: 'user' | 'assistant_final';
  /** Message text. */
  text: string;
}

export interface CocoDrainResult {
  events: CocoBridgeEvent[];
  newOffset: number;
  pendingTail: string;
}

export function cocoEventsPathForSession(sessionId: string): string {
  return join(homedir(), '.cache', 'coco', 'sessions', sessionId, 'events.jsonl');
}

function messageText(content: unknown): string {
  return typeof content === 'string' ? content : '';
}

/** Increment-read a CoCo events.jsonl from `fromOffset`. */
export function drainCocoEvents(path: string, fromOffset: number): CocoDrainResult {
  if (!existsSync(path)) return { events: [], newOffset: 0, pendingTail: '' };
  let size: number;
  try { size = statSync(path).size; } catch { return { events: [], newOffset: fromOffset, pendingTail: '' }; }
  let start = fromOffset;
  if (size < start) start = 0;
  if (size === start) return { events: [], newOffset: start, pendingTail: '' };

  const len = size - start;
  const buf = Buffer.alloc(len);
  const fd = openSync(path, 'r');
  try { readSync(fd, buf, 0, len, start); } finally { closeSync(fd); }

  const text = buf.toString('utf8');
  const lastNl = text.lastIndexOf('\n');
  const completeText = lastNl >= 0 ? text.slice(0, lastNl + 1) : '';
  const pendingTail = lastNl >= 0 ? text.slice(lastNl + 1) : text;
  const newOffset = start + Buffer.byteLength(completeText, 'utf8');

  const events: CocoBridgeEvent[] = [];
  let cursor = start;
  for (const line of completeText.split('\n')) {
    if (line.length === 0) {
      cursor += 1;
      continue;
    }
    const lineStart = cursor;
    cursor += Buffer.byteLength(line, 'utf8') + 1;

    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }
    const msg = obj?.message?.message;
    if (!msg || typeof msg !== 'object') continue;
    const ts = typeof obj.created_at === 'string' ? Date.parse(obj.created_at) : NaN;
    const timestampMs = Number.isFinite(ts) ? ts : Date.now();

    if (msg.role === 'user') {
      if (msg.extra?.is_original_user_input !== true) continue;
      const content = messageText(msg.content);
      if (!content) continue;
      events.push({ uuid: `${path}:${lineStart}`, timestampMs, kind: 'user', text: content });
    } else if (msg.role === 'assistant') {
      const content = messageText(msg.content);
      if (!content) continue;
      events.push({ uuid: `${path}:${lineStart}`, timestampMs, kind: 'assistant_final', text: content });
    }
  }

  return { events, newOffset, pendingTail };
}
