import type { CellPosition, CreatorReplay, ReplayFrame } from '../../core/maze/types'

export const createReplay = (frames: ReplayFrame[], completed: boolean): CreatorReplay => ({
  frames: frames
    .filter((frame, index) => index === 0 || frame.atMs >= frames[index - 1].atMs)
    .map((frame) => ({ ...frame })),
  durationMs: frames.at(-1)?.atMs ?? 0,
  completed,
})

export interface ReplaySample extends CellPosition {
  progress: number
  frameIndex: number
}

export const sampleReplay = (replay: CreatorReplay | null, elapsedMs: number): ReplaySample | null => {
  if (!replay?.frames.length) return null
  const time = replay.durationMs > 0 ? Math.min(Math.max(0, elapsedMs), replay.durationMs) : 0
  let index = replay.frames.findIndex((frame) => frame.atMs > time)
  if (index < 0) index = replay.frames.length
  const previousIndex = Math.max(0, index - 1)
  const previous = replay.frames[previousIndex]
  const next = replay.frames[Math.min(index, replay.frames.length - 1)]
  const span = Math.max(1, next.atMs - previous.atMs)
  const amount = Math.min(1, Math.max(0, (time - previous.atMs) / span))
  return {
    row: previous.row + (next.row - previous.row) * amount,
    col: previous.col + (next.col - previous.col) * amount,
    progress: replay.durationMs ? time / replay.durationMs : 1,
    frameIndex: previousIndex,
  }
}

export const compareReplayTimes = (playerMs: number, creator: CreatorReplay | null) =>
  creator?.completed ? creator.durationMs - playerMs : null
