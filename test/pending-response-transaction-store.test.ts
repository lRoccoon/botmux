import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tempDir: string;

vi.mock('../src/config.js', () => ({
  config: {
    session: {
      get dataDir() { return tempDir; },
    },
  },
}));

import { shouldTreatPendingCardAsPatchedByMarker } from '../src/core/pending-response.js';
import {
  clearPendingResponsePatchMarker,
  markPendingResponsePatchMarkerPatched,
  readPendingResponsePatchMarker,
  writePendingResponsePatchMarker,
} from '../src/services/pending-response-transaction-store.js';

describe('pending response patch transaction store', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'pending-response-tx-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('persists and clears a patching marker by session id', () => {
    writePendingResponsePatchMarker('s1', 'om_card');

    expect(readPendingResponsePatchMarker('s1')).toMatchObject({
      sessionId: 's1',
      cardId: 'om_card',
      state: 'patching',
    });

    clearPendingResponsePatchMarker('s1');
    expect(readPendingResponsePatchMarker('s1')).toBeUndefined();
  });

  it('clears a marker idempotently after a failed patch path', () => {
    writePendingResponsePatchMarker('s1', 'om_failed_card');

    clearPendingResponsePatchMarker('s1');
    clearPendingResponsePatchMarker('s1');

    expect(readPendingResponsePatchMarker('s1')).toBeUndefined();
  });

  it('does not make daemon treat a pending card as patched after a failed patch marker is cleared', () => {
    writePendingResponsePatchMarker('s1', 'om_failed_card');
    clearPendingResponsePatchMarker('s1');

    const marker = readPendingResponsePatchMarker('s1');

    expect(shouldTreatPendingCardAsPatchedByMarker('om_failed_card', marker)).toBe(false);
  });

  it('does not treat an in-flight patching marker as already patched', () => {
    writePendingResponsePatchMarker('s1', 'om_card');
    const marker = readPendingResponsePatchMarker('s1');

    expect(shouldTreatPendingCardAsPatchedByMarker('om_card', marker)).toBe(false);
  });

  it('only treats the matching pending card as patched after the marker is promoted', () => {
    writePendingResponsePatchMarker('s1', 'om_card');
    markPendingResponsePatchMarkerPatched('s1');
    const marker = readPendingResponsePatchMarker('s1');

    expect(marker?.state).toBe('patched');
    expect(shouldTreatPendingCardAsPatchedByMarker('om_card', marker)).toBe(true);
    expect(shouldTreatPendingCardAsPatchedByMarker('om_other', marker)).toBe(false);
  });
});
