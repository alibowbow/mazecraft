export const APP_STATES = [
  'idle',
  'creating',
  'generating',
  'ready',
  'editing',
  'validating',
  'playing',
  'paused',
  'solving',
  'exporting',
  'error',
] as const

export type AppState = (typeof APP_STATES)[number]

export type AppEvent =
  | { type: 'NEW_PROJECT' }
  | { type: 'OPEN' }
  | { type: 'GENERATE' }
  | { type: 'GENERATED' }
  | { type: 'EDIT' }
  | { type: 'VALIDATE' }
  | { type: 'VALIDATED' }
  | { type: 'PLAY' }
  | { type: 'PAUSE' }
  | { type: 'RESUME' }
  | { type: 'STOP' }
  | { type: 'SOLVE' }
  | { type: 'SOLVED' }
  | { type: 'EXPORT' }
  | { type: 'EXPORTED' }
  | { type: 'FAIL'; message: string }
  | { type: 'RECOVER' }

const transitions: Record<AppState, Partial<Record<AppEvent['type'], AppState>>> = {
  idle: { NEW_PROJECT: 'creating', OPEN: 'ready', FAIL: 'error' },
  creating: { OPEN: 'ready', GENERATE: 'generating', FAIL: 'error', STOP: 'idle' },
  generating: { GENERATED: 'ready', FAIL: 'error', STOP: 'creating' },
  ready: { GENERATE: 'generating', EDIT: 'editing', VALIDATE: 'validating', PLAY: 'playing', SOLVE: 'solving', EXPORT: 'exporting', FAIL: 'error' },
  editing: { GENERATE: 'generating', VALIDATE: 'validating', PLAY: 'playing', STOP: 'ready', FAIL: 'error' },
  validating: { VALIDATED: 'ready', FAIL: 'error' },
  playing: { PAUSE: 'paused', STOP: 'ready', FAIL: 'error' },
  paused: { RESUME: 'playing', STOP: 'ready', FAIL: 'error' },
  solving: { SOLVED: 'ready', STOP: 'ready', FAIL: 'error' },
  exporting: { EXPORTED: 'ready', FAIL: 'error' },
  error: { RECOVER: 'ready', NEW_PROJECT: 'creating', OPEN: 'ready' },
}

export interface MachineSnapshot {
  value: AppState
  previous: AppState | null
  error: string | null
}

export const initialMachineSnapshot: MachineSnapshot = {
  value: 'idle',
  previous: null,
  error: null,
}

export const transitionAppState = (snapshot: MachineSnapshot, event: AppEvent): MachineSnapshot => {
  const next = transitions[snapshot.value][event.type]
  if (!next) return snapshot
  return {
    value: next,
    previous: snapshot.value,
    error: event.type === 'FAIL' ? event.message : next === 'error' ? snapshot.error : null,
  }
}

export const isBusyState = (state: AppState) =>
  state === 'generating' || state === 'validating' || state === 'solving' || state === 'exporting'
