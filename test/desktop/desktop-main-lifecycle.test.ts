import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('desktop main lifecycle', () => {
  it('prevents duplicate app instances and focuses the existing window', () => {
    const source = readFileSync('src/desktop/main.ts', 'utf-8');
    const lockIndex = source.indexOf('app.requestSingleInstanceLock()');
    const bootstrapIndex = source.indexOf('void bootstrap()');

    expect(lockIndex).toBeGreaterThan(-1);
    expect(bootstrapIndex).toBeGreaterThan(-1);
    expect(lockIndex).toBeLessThan(bootstrapIndex);
    expect(source).toContain("app.on('second-instance'");
    expect(source).toContain('mainWindow.show()');
    expect(source).toContain('mainWindow.focus()');
  });
});
