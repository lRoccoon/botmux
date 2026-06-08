import { describe, expect, it } from 'vitest';
import { chooseDesktopPetLaunchMode } from '../src/desktop-pet/command.js';
import { summarizeBotmuxPetStatus } from '../src/desktop-pet/botmux-status.js';
import { createDesktopPetRequestHandler, desktopPetCookieName } from '../src/desktop-pet/server.js';
import { buildDesktopPetSnapshot, buildDesktopPetSnapshotFromStatus } from '../src/desktop-pet/snapshot.js';
import { desktopPetRows } from '../src/desktop-pet/rows.js';

describe('desktop pet rows', () => {
  it('appends the nine template actions after the standard review row', () => {
    expect(desktopPetRows.slice(0, 9).map((row) => row.state)).toEqual([
      'idle',
      'running-right',
      'running-left',
      'waving',
      'jumping',
      'failed',
      'waiting',
      'running',
      'review',
    ]);
    expect(desktopPetRows.slice(9).map((row) => row.state)).toEqual([
      'desk-work',
      'checklist-review',
      'idea-thinking',
      'code-explain',
      'tired-seated',
      'side-sleep',
      'plug-charging',
      'alert-surprise',
      'exercise-motion',
    ]);
    expect(desktopPetRows.slice(9).every((row) => row.frames === 8)).toBe(true);
  });
});

describe('desktop pet snapshot', () => {
  it('exposes Robo Buddy atlas metadata for the desktop pet UI', () => {
    const snapshot = buildDesktopPetSnapshot(new Date('2026-06-07T00:00:00.000Z'));

    expect(snapshot.generatedAt).toBe('2026-06-07T00:00:00.000Z');
    expect(snapshot.display.name).toBe('Robo Buddy');
    expect(snapshot.display.atlas.cellWidth).toBe(192);
    expect(snapshot.display.atlas.cellHeight).toBe(208);
    expect(snapshot.display.atlas.rows).toHaveLength(18);
    expect(snapshot.display.atlas.rows[9]).toMatchObject({
      row: 9,
      state: 'desk-work',
      frames: 8,
    });
    expect(snapshot.display.atlas.image).toContain('/assets/robo-buddy-extended-18-row-atlas.png');
  });

  it('exposes independent action strips so desktop animation does not sample neighboring atlas cells', () => {
    const snapshot = buildDesktopPetSnapshot(new Date('2026-06-07T00:00:00.000Z'));
    const deskWork = snapshot.display.actions['desk-work'];

    expect(Object.keys(snapshot.display.actions)).toHaveLength(desktopPetRows.length);
    expect(deskWork).toMatchObject({
      image: '/assets/actions/desk-work.png?v=20260607-desk-work-no-occlusion',
      frames: 8,
      frameWidth: 256,
      frameHeight: 240,
      frameStride: 304,
      frameOffsetX: 24,
    });
    expect(snapshot.display.actions['plug-charging']).toMatchObject({
      frameWidth: 256,
      frameHeight: 240,
      frameStride: 304,
      frameOffsetX: 24,
    });
  });

  it('keeps ambient desktop-pet animation on compact pet actions instead of scene-sized template rows', () => {
    const snapshot = buildDesktopPetSnapshot(new Date('2026-06-07T00:00:00.000Z'));

    expect(snapshot.display.ambientActions).toEqual(['idle', 'running-right', 'review', 'waving']);
    expect(snapshot.display.ambientActions).not.toContain('desk-work');
    expect(snapshot.display.ambientActions).not.toContain('code-explain');
  });

  it('embeds the recommended botmux-linked action in the snapshot', () => {
    const status = summarizeBotmuxPetStatus({
      nowMs: Date.parse('2026-06-07T00:00:00.000Z'),
      onlineDaemons: 1,
      sessions: [{ sessionId: 's1', status: 'working', lastMessageAt: Date.parse('2026-06-07T00:00:00.000Z') }],
    });
    const snapshot = buildDesktopPetSnapshotFromStatus(status, new Date('2026-06-07T00:00:00.000Z'));

    expect(snapshot.display.recommendedAction).toBe('running-right');
    expect(snapshot.display.statusActions).toEqual(['running-right', 'running-left']);
    expect(snapshot.display.message).toBe('Working on 1 session');
    expect(snapshot.display.botmux).toMatchObject({
      onlineDaemons: 1,
      activeSessions: 1,
      busySessions: 1,
      action: 'running-right',
    });
  });
});

describe('desktop pet botmux status mapping', () => {
  it('asks for attention when a session is waiting on the user', () => {
    const status = summarizeBotmuxPetStatus({
      nowMs: 1000,
      onlineDaemons: 1,
      sessions: [{ sessionId: 's1', status: 'idle', pendingRepo: true, lastMessageAt: 1000 }],
    });

    expect(status.action).toBe('alert-surprise');
    expect(status.message).toBe('Needs your choice');
  });

  it('charges when a live session is rate limited', () => {
    const status = summarizeBotmuxPetStatus({
      nowMs: 1000,
      onlineDaemons: 1,
      sessions: [{ sessionId: 's1', status: 'limited', lastMessageAt: 1000 }],
    });

    expect(status.action).toBe('plug-charging');
    expect(status.message).toBe('Waiting for more energy');
  });

  it('thinks when sessions are analyzing and patrols when sessions are working', () => {
    expect(summarizeBotmuxPetStatus({
      nowMs: 1000,
      onlineDaemons: 1,
      sessions: [{ sessionId: 's1', status: 'analyzing', lastMessageAt: 1000 }],
    }).action).toBe('idea-thinking');

    expect(summarizeBotmuxPetStatus({
      nowMs: 1000,
      onlineDaemons: 1,
      sessions: [{ sessionId: 's1', status: 'working', lastMessageAt: 1000 }],
    }).action).toBe('running-right');
  });

  it('rests when no botmux daemon is online', () => {
    const status = summarizeBotmuxPetStatus({
      nowMs: 1000,
      onlineDaemons: 0,
      sessions: [],
    });

    expect(status.action).toBe('side-sleep');
    expect(status.message).toBe('Botmux is offline');
  });
});

describe('desktop pet server', () => {
  it('rejects protected endpoints without the desktop pet token', async () => {
    const handler = createDesktopPetRequestHandler({
      token: 'secret-token',
      snapshot: () => buildDesktopPetSnapshot(new Date('2026-06-07T00:00:00.000Z')),
    });

    const response = await handler(new Request('http://127.0.0.1/api/snapshot'));

    expect(response.status).toBe(403);
  });

  it('accepts the desktop pet token from a cookie', async () => {
    const handler = createDesktopPetRequestHandler({
      token: 'secret-token',
      snapshot: () => buildDesktopPetSnapshot(new Date('2026-06-07T00:00:00.000Z')),
    });

    const response = await handler(new Request('http://127.0.0.1/api/snapshot', {
      headers: { cookie: `${desktopPetCookieName}=secret-token` },
    }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.display.name).toBe('Robo Buddy');
  });

  it('serves the atlas path exposed by the desktop pet snapshot', async () => {
    const handler = createDesktopPetRequestHandler({
      token: 'secret-token',
      snapshot: () => buildDesktopPetSnapshot(new Date('2026-06-07T00:00:00.000Z')),
    });

    const imagePath = buildDesktopPetSnapshot().display.atlas.image;
    const response = await handler(new Request(`http://127.0.0.1${imagePath}`, {
      headers: { cookie: `${desktopPetCookieName}=secret-token` },
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
  });

  it('serves independent action strips exposed by the desktop pet snapshot', async () => {
    const handler = createDesktopPetRequestHandler({
      token: 'secret-token',
      snapshot: () => buildDesktopPetSnapshot(new Date('2026-06-07T00:00:00.000Z')),
    });

    const imagePath = buildDesktopPetSnapshot().display.actions['desk-work'].image;
    const response = await handler(new Request(`http://127.0.0.1${imagePath}`, {
      headers: { cookie: `${desktopPetCookieName}=secret-token` },
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
  });
});

describe('desktop pet command launch mode', () => {
  it('uses the Kaboo-style native panel on macOS unless the browser fallback is requested', () => {
    expect(chooseDesktopPetLaunchMode({ platform: 'darwin', browserMode: false, noOpen: false })).toBe('native');
    expect(chooseDesktopPetLaunchMode({ platform: 'darwin', browserMode: true, noOpen: false })).toBe('browser');
    expect(chooseDesktopPetLaunchMode({ platform: 'linux', browserMode: false, noOpen: false })).toBe('browser');
    expect(chooseDesktopPetLaunchMode({ platform: 'darwin', browserMode: false, noOpen: true })).toBe('none');
  });
});
