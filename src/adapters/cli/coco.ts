import { existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { resolveCommand } from './registry.js';
import { BOTMUX_SHELL_HINTS } from './shared-hints.js';
import { cocoCacheRoot } from '../../services/coco-paths.js';
import { logger } from '../../utils/logger.js';
import type { CliAdapter, PtyHandle } from './types.js';

/** Global submit log — CoCo appends one JSON line here on every successful
 *  user submit across all sessions (mode:"user"). Format observed:
 *  `{"content":"...","mode":"user","timestamp":"..."}`. Used the same way
 *  the Codex adapter uses ~/.codex/history.jsonl: write → poll for our
 *  marker → retry Enter if missing → return {submitted:false, recheck}
 *  on final failure so worker can surface a Lark warning. */
const HISTORY_PATH = join(cocoCacheRoot(), 'history.jsonl');

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function currentFileSize(path: string): number {
  if (!existsSync(path)) return 0;
  try { return statSync(path).size; } catch { return 0; }
}

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 12);
}

function historyState(path: string, baseByte: number): { exists: boolean; size: number; delta: number } {
  const size = currentFileSize(path);
  return { exists: existsSync(path), size, delta: Math.max(0, size - baseByte) };
}

function cocoDiag(id: string, event: string, fields: Record<string, unknown> = {}): void {
  // Intentionally never log raw content/prefix. The hash+length are enough to
  // correlate paste/Enter/history polling across a real failure without
  // leaking user prompts into daemon logs.
  logger.info(`[coco-submit:${id}] ${event}`, fields);
}

/** Scan `path` for a JSON line newer than `fromByte` that's a user-submit
 *  whose decoded `content` starts with `prefix`. Parses each candidate line
 *  with JSON.parse — substring match on the raw bytes is unreliable here
 *  because CoCo's Go marshaller HTML-escapes `<`, `>`, `&` into `<`,
 *  `>`, `&`, which our string-form prefix won't match. Decoding
 *  the field and comparing JS strings sidesteps all of that. */
function historyDeltaContains(path: string, fromByte: number, prefix: string): boolean {
  if (!existsSync(path)) return false;
  let size: number;
  try { size = statSync(path).size; } catch { return false; }
  if (size <= fromByte) return false;
  const len = size - fromByte;
  const buf = Buffer.alloc(len);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buf, 0, len, fromByte);
  } finally {
    closeSync(fd);
  }
  const delta = buf.toString('utf8');
  for (const line of delta.split('\n')) {
    if (!line || !line.includes('"mode":"user"')) continue;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed.content === 'string' && parsed.content.startsWith(prefix)) {
        return true;
      }
    } catch {
      // Truncated tail / non-JSON line — keep scanning the rest.
    }
  }
  return false;
}

async function waitForHistoryAppend(
  path: string,
  fromByte: number,
  prefix: string,
  timeoutMs: number,
  diag?: { id: string; phase: string },
): Promise<boolean> {
  const startedAt = Date.now();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (historyDeltaContains(path, fromByte, prefix)) {
      if (diag) {
        cocoDiag(diag.id, 'history-hit', {
          phase: diag.phase,
          elapsedMs: Date.now() - startedAt,
          history: historyState(path, fromByte),
        });
      }
      return true;
    }
    await delay(100);
  }
  if (diag) {
    cocoDiag(diag.id, 'history-timeout', {
      phase: diag.phase,
      timeoutMs,
      elapsedMs: Date.now() - startedAt,
      history: historyState(path, fromByte),
    });
  }
  return false;
}

/** First 40 chars of the original content — used as a prefix match against
 *  the JSON-decoded `content` field of each user-mode line in history.jsonl.
 *  Compare against decoded strings, NOT against raw file bytes: CoCo's Go
 *  marshaller HTML-escapes `<`, `>`, `&` so a JSON-encoded marker wouldn't
 *  match the stored bytes. 40 chars is unique enough across concurrent bots. */
function submitPrefix(content: string): string {
  return content.slice(0, 40);
}

export function createCocoAdapter(pathOverride?: string): CliAdapter {
  const bin = resolveCommand(pathOverride ?? 'coco');
  return {
    id: 'coco',
    resolvedBin: bin,

    buildArgs({ sessionId, resume }) {
      const args: string[] = [];
      if (resume) {
        args.push('--resume', sessionId);
      } else {
        args.push('--session-id', sessionId);
      }
      args.push('--yolo');
      args.push('--disallowed-tool', 'EnterPlanMode', '--disallowed-tool', 'ExitPlanMode');
      return args;
    },

    buildResumeCommand({ sessionId }) {
      return `coco --resume ${sessionId}`;
    },

    async writeInput(pty: PtyHandle, content: string) {
      // CoCo / Trae CLI is a Claude Code fork (Ink TUI) with two failure modes
      // for multi-line input:
      //   1. tmux `send-keys -l` treats each \n as Enter — multi-line content
      //      either submits line-by-line or paste-burst-coalesces with the
      //      trailing Enter consumed as part of the paste (text stays stuck
      //      in the input box, never submitted).
      //   2. The old adapter had no verification, so the worker never knew
      //      and the user stared at Lark waiting for a reply that never came.
      //
      // Fix: use tmux `load-buffer` + `paste-buffer -d -p` (the `pasteText`
      // path). The `-p` flag is what makes tmux wrap the content in
      // bracketed-paste markers (`\e[200~...\e[201~`) when the Ink TUI has
      // bracketed paste enabled — Ink does by default on fresh spawn. WITHOUT
      // `-p` tmux pastes raw bytes (no markers) and we're back to the burst
      // bug below. CoCo sees an explicit START/END
      // pair, so embedded `\n` stay as content (no per-line submits) and the
      // trailing Enter after submitDelay is unambiguously a submit (not part
      // of an "ongoing paste burst" the way send-keys -l rapid input was).
      //
      // Why not send-keys -l + `\` + Enter soft-newlines (the claude-code
      // pattern): on Trae CLI 0.120.31 (May 2026 build), fresh-spawned CoCo
      // treats the rapid send-keys sequence as an open-ended paste burst and
      // swallows the final Enter as a soft-newline — message stranded in the
      // input box with no submit, no error. Manually pressing Enter 30 min
      // later still works (burst window times out eventually), so the issue
      // is "burst never terminates from CoCo's POV", which an explicit
      // bracketed-paste END marker fixes. claude-code.ts keeps its
      // send-keys-typing path because Claude Code can toggle bracketed paste
      // OFF after slash commands; CoCo on a fresh-spawn message doesn't have
      // that concern.
      //
      // Verification (unchanged): poll CoCo's platform-specific history.jsonl for the
      // user-submit line whose decoded `content` starts with our prefix.
      // Retry Enter up to 3 times, then return {submitted:false, recheck}
      // for the worker's deferred recheck + Lark warning path.
      const hasImagePath = /\.(jpe?g|png|gif|webp|svg|bmp)\b/i.test(content);
      const submitDelay = hasImagePath ? 800 : 500;
      const diagId = randomBytes(4).toString('hex');
      const contentMeta = {
        length: content.length,
        lines: content.length === 0 ? 0 : content.split('\n').length,
        sha256: contentHash(content),
        hasImagePath,
      };

      const trySendEnter = (phase: string): boolean => {
        try {
          if (pty.sendSpecialKeys) pty.sendSpecialKeys('Enter');
          else pty.write('\r');
          cocoDiag(diagId, 'enter-sent', { phase });
          return true;
        } catch (err: any) {
          // tmux session is gone (CLI exited mid-write) — bail cleanly
          // rather than crashing the worker on unhandled execFileSync.
          cocoDiag(diagId, 'enter-failed', { phase, error: err?.message ?? String(err) });
          return false;
        }
      };

      const baseByte = currentFileSize(HISTORY_PATH);
      const prefix = submitPrefix(content);
      cocoDiag(diagId, 'start', {
        content: contentMeta,
        submitDelay,
        historyPath: HISTORY_PATH,
        history: historyState(HISTORY_PATH, baseByte),
        transport: pty.pasteText ? 'tmux-pasteText' : 'raw-pty-bracketed-paste',
      });

      try {
        if (pty.pasteText) {
          // tmux mode: load-buffer + paste-buffer -d -p. The `-p` flag (added
          // in TmuxPipeBackend.pasteText — the real runtime backend) makes tmux
          // emit bracketed-paste markers when the pane has them on (Ink
          // default); without it the trailing Enter is swallowed as a soft
          // newline and the message strands. `-d` deletes the buffer after
          // pasting so it doesn't accumulate across writes.
          pty.pasteText(content);
          cocoDiag(diagId, 'paste-sent', { transport: 'tmux-pasteText', content: contentMeta });
        } else {
          // Non-tmux fallback (raw PTY): wrap markers ourselves.
          pty.write('\x1b[200~' + content + '\x1b[201~');
          cocoDiag(diagId, 'paste-sent', { transport: 'raw-pty-bracketed-paste', content: contentMeta });
        }
      } catch (err: any) {
        cocoDiag(diagId, 'paste-failed', { error: err?.message ?? String(err), content: contentMeta });
        return { submitted: false };
      }
      cocoDiag(diagId, 'submit-delay', { ms: submitDelay });
      await delay(submitDelay);
      if (!trySendEnter('initial')) return { submitted: false };

      // Fresh-install short-wait: when history.jsonl is absent at submit
      // time, give CoCo up to 1.2s to create it. If our marker shows up →
      // success. If the file is still absent → trust the Enter and return
      // (this is the genuine "first run / coco doesn't write history"
      // case). If the file appeared but our marker isn't there → fall
      // through to the normal retry/failure loop — better to warn than to
      // silently mask a real submit failure on a new install.
      if (!existsSync(HISTORY_PATH) && baseByte === 0) {
        cocoDiag(diagId, 'fresh-install-short-wait-start', { history: historyState(HISTORY_PATH, baseByte) });
        if (await waitForHistoryAppend(HISTORY_PATH, baseByte, prefix, 1200, { id: diagId, phase: 'fresh-install' })) {
          cocoDiag(diagId, 'submitted-confirmed', { phase: 'fresh-install' });
          return undefined;
        }
        if (!existsSync(HISTORY_PATH)) {
          cocoDiag(diagId, 'fresh-install-no-history-trust-enter', { history: historyState(HISTORY_PATH, baseByte) });
          return undefined;
        }
        // File appeared during the wait but our marker isn't in it — fall
        // through to the retry loop. baseByte stays 0 so the loop scans
        // the whole file.
      }

      for (let attempt = 0; attempt < 3; attempt++) {
        const phase = `retry-${attempt + 1}-pre-enter`;
        if (await waitForHistoryAppend(HISTORY_PATH, baseByte, prefix, 800, { id: diagId, phase })) {
          cocoDiag(diagId, 'submitted-confirmed', { phase });
          return undefined;
        }
        if (!trySendEnter(`retry-${attempt + 1}`)) return { submitted: false };
      }
      if (await waitForHistoryAppend(HISTORY_PATH, baseByte, prefix, 800, { id: diagId, phase: 'final' })) {
        cocoDiag(diagId, 'submitted-confirmed', { phase: 'final' });
        return undefined;
      }
      // In-band budget exhausted. Hand the worker a recheck closure: a slow
      // CoCo (cold start, large initial prompt, heavy hooks) may still
      // append our marker after retries gave up. Worker re-scans after a
      // delay before deciding whether to warn the user.
      cocoDiag(diagId, 'submitted-unconfirmed-return-recheck', { history: historyState(HISTORY_PATH, baseByte) });
      const recheck = (): boolean => {
        const ok = historyDeltaContains(HISTORY_PATH, baseByte, prefix);
        cocoDiag(diagId, 'deferred-recheck', { ok, history: historyState(HISTORY_PATH, baseByte) });
        return ok;
      };
      return { submitted: false, recheck };
    },

    completionPattern: undefined,
    // `⏵⏵` only shows when CoCo runs with --yolo (bypass permissions). Adopted
    // CoCo processes started by the user manually usually don't have that flag,
    // so the status bar shows just the model badge `⬡ <model>` instead. Match
    // either — without this, idle detection never fires for adopt mode and the
    // transcript bridge never drains.
    readyPattern: /⏵⏵|⬡/,
    systemHints: BOTMUX_SHELL_HINTS,
    altScreen: false,
  };
}

export const create = createCocoAdapter;
