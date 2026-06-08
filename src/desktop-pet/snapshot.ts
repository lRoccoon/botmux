import { desktopPetRows, type DesktopPetRow } from './rows.js';
import { readBotmuxPetStatus, summarizeBotmuxPetStatus, type BotmuxPetStatus } from './botmux-status.js';
import type { DesktopPetRowState } from './rows.js';

export interface DesktopPetAtlas {
  image: string;
  cellWidth: number;
  cellHeight: number;
  columns: number;
  rows: DesktopPetRow[];
}

export interface DesktopPetDisplay {
  name: string;
  title: string;
  message: string;
  recommendedAction: DesktopPetRowState;
  botmux: BotmuxPetStatus;
  atlas: DesktopPetAtlas;
  actions: Record<string, DesktopPetActionStrip>;
  ambientActions: string[];
  statusActions: DesktopPetRowState[];
}

export interface DesktopPetActionStrip {
  image: string;
  frames: number;
  frameWidth: number;
  frameHeight: number;
  frameStride: number;
  frameOffsetX: number;
}

export interface DesktopPetSnapshot {
  generatedAt: string;
  display: DesktopPetDisplay;
}

const desktopPetAssetVersion = '20260607-desk-work-no-occlusion';

export function buildDesktopPetSnapshot(now = new Date()): DesktopPetSnapshot {
  return buildDesktopPetSnapshotFromStatus(defaultBotmuxPetStatus(now), now);
}

export async function buildDesktopPetSnapshotWithBotmuxStatus(now = new Date()): Promise<DesktopPetSnapshot> {
  const status = await readBotmuxPetStatus({ nowMs: now.getTime() });
  return buildDesktopPetSnapshotFromStatus(status, now);
}

export function buildDesktopPetSnapshotFromStatus(botmux: BotmuxPetStatus, now = new Date()): DesktopPetSnapshot {
  return {
    generatedAt: now.toISOString(),
    display: {
      name: 'Robo Buddy',
      title: 'Botmux desktop pet',
      message: botmux.message,
      recommendedAction: botmux.action,
      botmux,
      ambientActions: ['idle', 'running-right', 'review', 'waving'],
      statusActions: statusActionsFor(botmux.action),
      atlas: {
        image: '/assets/robo-buddy-extended-18-row-atlas.png',
        cellWidth: 192,
        cellHeight: 208,
        columns: 8,
        rows: desktopPetRows,
      },
      actions: Object.fromEntries(desktopPetRows.map((row) => [
        row.state,
        {
          image: `/assets/actions/${row.state}.png?v=${desktopPetAssetVersion}`,
          frames: row.frames,
          frameWidth: 256,
          frameHeight: 240,
          frameStride: 304,
          frameOffsetX: 24,
        },
      ])),
    },
  };
}

function statusActionsFor(action: DesktopPetRowState): DesktopPetRowState[] {
  if (action === 'running-right') return ['running-right', 'running-left'];
  return [action];
}

function defaultBotmuxPetStatus(now: Date): BotmuxPetStatus {
  return summarizeBotmuxPetStatus({
    nowMs: now.getTime(),
    onlineDaemons: 1,
    sessions: [],
    source: 'live',
  });
}
