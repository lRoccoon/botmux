/**
 * collab/intake.ts — deterministic intake: turn a control-topic message into a
 * goal + a REAL acceptance criteria the referee can run.
 *
 * P0.0 is deterministic (no LLM): the human states the goal and, crucially, an
 * acceptance command that starts failing and only passes once the work is done —
 * otherwise the referee's first tick would pass on a placeholder and the run
 * would "succeed" before any work happens. (The LLM intake NLU that infers the
 * command from prose is a later layer; this is the explicit, parse-only floor.)
 *
 * Syntax (pipes OR newlines separate directives; order-independent):
 *   <goal text>
 *   | test: <shell command>           # referee runs this; exit 0 ⇒ done
 *   | metric: <regex>                 # 1st capture group = a number; lower = progress
 *
 * The test command may itself contain `|`, `=`, etc. — directives are located by
 * their `test:` / `metric:` keys at a segment boundary, not by naive splitting.
 */
import { AcceptanceCriteriaSchema, type AcceptanceCriteria } from './contract.js';

export interface AcceptanceParts {
  goal: string;
  /** Shell command the referee runs; falls back to the 'true' placeholder. */
  test?: string;
  /** Regex; first capture group is the progress number. Name defaults to 'failing'. */
  metricPattern?: string;
  metricName?: string;
}

export interface CollabIntake {
  goal: string;
  acceptanceCriteria: AcceptanceCriteria;
  /** true ⇒ no real test command was given; referee will pass immediately. */
  placeholderAcceptance: boolean;
}

/** Build a validated AcceptanceCriteria from parts (usable from a card form too). */
export function buildAcceptanceCriteria(parts: AcceptanceParts): AcceptanceCriteria {
  const command = parts.test?.trim() || 'true';
  const draft: Record<string, unknown> = {
    command,
    doneWhen: 'exitZero',
    description: `Goal: ${parts.goal.trim().slice(0, 200)}`,
  };
  if (parts.metricPattern?.trim()) {
    draft.progressMetric = {
      name: parts.metricName?.trim() || 'failing',
      pattern: parts.metricPattern.trim(),
    };
  }
  return AcceptanceCriteriaSchema.parse(draft);
}

/** Index of a `key:` directive at a segment boundary (start / newline / pipe). */
function directiveIndex(text: string, key: 'test' | 'metric'): { at: number; after: number } | null {
  const re = new RegExp(`(?:^|[\\n|])[ \\t]*${key}[ \\t]*:`, 'i');
  const m = re.exec(text);
  if (!m) return null;
  return { at: m.index, after: m.index + m[0].length };
}

export function parseCollabIntake(input: string): CollabIntake {
  const text = input.replace(/^\/collab\s+/i, '').trim();

  const test = directiveIndex(text, 'test');
  const metric = directiveIndex(text, 'metric');

  // goal ends at the earliest directive
  const dirStarts = [test?.at, metric?.at].filter((n): n is number => typeof n === 'number');
  const goalEnd = dirStarts.length ? Math.min(...dirStarts) : text.length;
  const goal = text.slice(0, goalEnd).replace(/[|\s]+$/, '').trim();

  // each directive's value runs until the *other* directive or end of string
  const sliceDirective = (d: { after: number } | null, otherAt?: number): string | undefined => {
    if (!d) return undefined;
    const end = typeof otherAt === 'number' && otherAt > d.after ? otherAt : text.length;
    return text.slice(d.after, end).replace(/[|\s]+$/, '').trim() || undefined;
  };

  const testCmd = sliceDirective(test, metric?.at);
  const metricPattern = sliceDirective(metric, test?.at);

  const acceptanceCriteria = buildAcceptanceCriteria({ goal, test: testCmd, metricPattern });
  return {
    goal,
    acceptanceCriteria,
    placeholderAcceptance: !testCmd,
  };
}
