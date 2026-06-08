export type DesktopPetRowState =
  | 'idle'
  | 'running-right'
  | 'running-left'
  | 'waving'
  | 'jumping'
  | 'failed'
  | 'waiting'
  | 'running'
  | 'review'
  | 'desk-work'
  | 'checklist-review'
  | 'idea-thinking'
  | 'code-explain'
  | 'tired-seated'
  | 'side-sleep'
  | 'plug-charging'
  | 'alert-surprise'
  | 'exercise-motion';

export interface DesktopPetRow {
  row: number;
  state: DesktopPetRowState;
  frames: number;
}

export const desktopPetRows: DesktopPetRow[] = [
  { row: 0, state: 'idle', frames: 6 },
  { row: 1, state: 'running-right', frames: 8 },
  { row: 2, state: 'running-left', frames: 8 },
  { row: 3, state: 'waving', frames: 4 },
  { row: 4, state: 'jumping', frames: 5 },
  { row: 5, state: 'failed', frames: 8 },
  { row: 6, state: 'waiting', frames: 6 },
  { row: 7, state: 'running', frames: 6 },
  { row: 8, state: 'review', frames: 6 },
  { row: 9, state: 'desk-work', frames: 8 },
  { row: 10, state: 'checklist-review', frames: 8 },
  { row: 11, state: 'idea-thinking', frames: 8 },
  { row: 12, state: 'code-explain', frames: 8 },
  { row: 13, state: 'tired-seated', frames: 8 },
  { row: 14, state: 'side-sleep', frames: 8 },
  { row: 15, state: 'plug-charging', frames: 8 },
  { row: 16, state: 'alert-surprise', frames: 8 },
  { row: 17, state: 'exercise-motion', frames: 8 },
];

export function findDesktopPetRow(state: DesktopPetRowState): DesktopPetRow {
  const row = desktopPetRows.find((candidate) => candidate.state === state);
  if (!row) throw new Error(`unknown desktop pet row: ${state}`);
  return row;
}
