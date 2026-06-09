import { describe, it, expect } from 'vitest';
import { parseCollabIntake, buildAcceptanceCriteria } from '../src/collab/intake.js';

describe('collab intake parser', () => {
  it('plain goal → placeholder acceptance (true)', () => {
    const r = parseCollabIntake('reduce failing tests to zero');
    expect(r.goal).toBe('reduce failing tests to zero');
    expect(r.acceptanceCriteria.command).toBe('true');
    expect(r.placeholderAcceptance).toBe(true);
    expect(r.acceptanceCriteria.progressMetric).toBeUndefined();
  });

  it('strips /collab prefix', () => {
    const r = parseCollabIntake('/collab make it green');
    expect(r.goal).toBe('make it green');
  });

  it('parses test: into a real acceptance command', () => {
    const r = parseCollabIntake('make tests pass | test: npm test');
    expect(r.goal).toBe('make tests pass');
    expect(r.acceptanceCriteria.command).toBe('npm test');
    expect(r.placeholderAcceptance).toBe(false);
  });

  it('preserves pipes inside the shell test command', () => {
    const r = parseCollabIntake('fix the parser | test: npm test 2>&1 | grep -c PASS | tail -n1');
    expect(r.goal).toBe('fix the parser');
    expect(r.acceptanceCriteria.command).toBe('npm test 2>&1 | grep -c PASS | tail -n1');
  });

  it('parses metric: regex with default name failing', () => {
    const r = parseCollabIntake('drive failures down | test: ./run.sh | metric: FAILING=(\\d+)');
    expect(r.acceptanceCriteria.command).toBe('./run.sh');
    expect(r.acceptanceCriteria.progressMetric).toEqual({ name: 'failing', pattern: 'FAILING=(\\d+)' });
  });

  it('is order-independent (metric before test)', () => {
    const r = parseCollabIntake('goal here | metric: F=(\\d+) | test: make check');
    expect(r.goal).toBe('goal here');
    expect(r.acceptanceCriteria.command).toBe('make check');
    expect(r.acceptanceCriteria.progressMetric).toMatchObject({ pattern: 'F=(\\d+)' });
  });

  it('accepts newline separators', () => {
    const r = parseCollabIntake('multi line goal\ntest: pytest -q\nmetric: (\\d+) failed');
    expect(r.goal).toBe('multi line goal');
    expect(r.acceptanceCriteria.command).toBe('pytest -q');
    expect(r.acceptanceCriteria.progressMetric).toMatchObject({ pattern: '(\\d+) failed' });
  });

  it('buildAcceptanceCriteria is reusable for a card form', () => {
    const ac = buildAcceptanceCriteria({ goal: 'g', test: 'cargo test', metricPattern: '(\\d+) failed', metricName: 'failures' });
    expect(ac.command).toBe('cargo test');
    expect(ac.progressMetric).toEqual({ name: 'failures', pattern: '(\\d+) failed' });
  });
});
