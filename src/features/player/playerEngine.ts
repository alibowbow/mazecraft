import type {
  CellPosition,
  GameRules,
  MazeGraph,
  MoveDirection,
  PlacedItem,
  ReplayFrame,
} from '../../core/maze/types'

const DELTAS: Record<MoveDirection, CellPosition> = {
  up: { row: -1, col: 0 },
  right: { row: 0, col: 1 },
  down: { row: 1, col: 0 },
  left: { row: 0, col: -1 },
}

const WALLS: Record<MoveDirection, keyof MazeGraph['cells'][number]['walls']> = {
  up: 'top',
  right: 'right',
  down: 'bottom',
  left: 'left',
}

export const positionKey = ({ row, col }: CellPosition) => `${row}:${col}`

export const samePosition = (a: CellPosition, b: CellPosition) => a.row === b.row && a.col === b.col

export const cellAt = (graph: MazeGraph, position: CellPosition) => {
  if (position.row < 0 || position.col < 0 || position.row >= graph.rows || position.col >= graph.cols) return null
  return graph.cells[position.row * graph.cols + position.col] ?? null
}

export const canMove = (graph: MazeGraph, from: CellPosition, direction: MoveDirection) => {
  const cell = cellAt(graph, from)
  if (!cell?.active || cell.walls[WALLS[direction]]) return false
  const delta = DELTAS[direction]
  const destination = cellAt(graph, { row: from.row + delta.row, col: from.col + delta.col })
  return Boolean(destination?.active)
}

export const movePosition = (graph: MazeGraph, from: CellPosition, direction: MoveDirection): CellPosition => {
  if (!canMove(graph, from, direction)) return from
  const delta = DELTAS[direction]
  return { row: from.row + delta.row, col: from.col + delta.col }
}

export interface PlayerStats {
  moves: number
  wrongTurns: number
  hintsUsed: number
  checkpoints: string[]
  collectibles: string[]
}

export interface PlayerSession {
  position: CellPosition
  startedAt: number
  elapsedMs: number
  pausedAt: number | null
  pausedMs: number
  completed: boolean
  completedAt: number | null
  stats: PlayerStats
  visited: string[]
  frames: ReplayFrame[]
  outsideSolution: boolean
}

export const createPlayerSession = (start: CellPosition, now = performance.now()): PlayerSession => ({
  position: { ...start },
  startedAt: now,
  elapsedMs: 0,
  pausedAt: null,
  pausedMs: 0,
  completed: false,
  completedAt: null,
  stats: { moves: 0, wrongTurns: 0, hintsUsed: 0, checkpoints: [], collectibles: [] },
  visited: [positionKey(start)],
  frames: [{ ...start, atMs: 0 }],
  outsideSolution: false,
})

const collectAt = (items: PlacedItem[], position: CellPosition, collected: string[]) =>
  items
    .filter((item) => samePosition(item, position) && !collected.includes(item.id))
    .map((item) => item.id)

export const applyPlayerMove = (
  session: PlayerSession,
  graph: MazeGraph,
  direction: MoveDirection,
  end: CellPosition,
  solutionPath: CellPosition[],
  checkpoints: PlacedItem[],
  collectibles: PlacedItem[],
  now = performance.now(),
): PlayerSession => {
  if (session.completed || session.pausedAt !== null) return session
  const position = movePosition(graph, session.position, direction)
  if (samePosition(position, session.position)) return session
  const solutionSet = new Set(solutionPath.map(positionKey))
  const outsideSolution = !solutionSet.has(positionKey(position))
  const wrongTurns = session.stats.wrongTurns + (outsideSolution && !session.outsideSolution ? 1 : 0)
  const reachedCheckpoints = collectAt(checkpoints, position, session.stats.checkpoints)
  const reachedCollectibles = collectAt(collectibles, position, session.stats.collectibles)
  const completed = samePosition(position, end)
  const elapsedMs = Math.max(0, now - session.startedAt - session.pausedMs)
  return {
    ...session,
    position,
    elapsedMs,
    completed,
    completedAt: completed ? now : null,
    outsideSolution,
    stats: {
      ...session.stats,
      moves: session.stats.moves + 1,
      wrongTurns,
      checkpoints: [...session.stats.checkpoints, ...reachedCheckpoints],
      collectibles: [...session.stats.collectibles, ...reachedCollectibles],
    },
    visited: session.visited.includes(positionKey(position))
      ? session.visited
      : [...session.visited, positionKey(position)],
    frames: [...session.frames, { ...position, direction, atMs: elapsedMs, checkpointId: reachedCheckpoints[0] }],
  }
}

export const usePlayerHint = (session: PlayerSession, allowedHints: number) => {
  if (session.stats.hintsUsed >= allowedHints || session.completed) return session
  return {
    ...session,
    stats: { ...session.stats, hintsUsed: session.stats.hintsUsed + 1 },
    frames: [...session.frames, { ...session.position, atMs: session.elapsedMs, usedHint: true }],
  }
}

export const setPlayerPaused = (session: PlayerSession, paused: boolean, now = performance.now()): PlayerSession => {
  if (session.completed) return session
  if (paused && session.pausedAt === null) return { ...session, pausedAt: now }
  if (!paused && session.pausedAt !== null) {
    return { ...session, pausedMs: session.pausedMs + (now - session.pausedAt), pausedAt: null }
  }
  return session
}

export const directionFromKey = (key: string): MoveDirection | null => {
  const normalized = key.toLowerCase()
  if (normalized === 'arrowup' || normalized === 'w') return 'up'
  if (normalized === 'arrowright' || normalized === 'd') return 'right'
  if (normalized === 'arrowdown' || normalized === 's') return 'down'
  if (normalized === 'arrowleft' || normalized === 'a') return 'left'
  return null
}

export const formatDuration = (milliseconds: number) => {
  const safe = Math.max(0, milliseconds)
  const minutes = Math.floor(safe / 60_000)
  const seconds = Math.floor((safe % 60_000) / 1_000)
  const hundredths = Math.floor((safe % 1_000) / 10)
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}`
}

export const timeAttackLimitMs = (
  rules: Pick<GameRules, 'mode' | 'timeLimitSeconds'>,
): number | null => {
  if (
    rules.mode !== 'time-attack' ||
    rules.timeLimitSeconds === null ||
    !Number.isFinite(rules.timeLimitSeconds) ||
    rules.timeLimitSeconds <= 0
  ) {
    return null
  }
  return rules.timeLimitSeconds * 1000
}

export const timeAttackRemainingMs = (
  rules: Pick<GameRules, 'mode' | 'timeLimitSeconds'>,
  elapsedMs: number,
): number | null => {
  const limit = timeAttackLimitMs(rules)
  return limit === null ? null : Math.max(0, limit - Math.max(0, elapsedMs))
}

export const isTimeAttackExpired = (
  rules: Pick<GameRules, 'mode' | 'timeLimitSeconds'>,
  elapsedMs: number,
): boolean => {
  const limit = timeAttackLimitMs(rules)
  return limit !== null && elapsedMs >= limit
}
