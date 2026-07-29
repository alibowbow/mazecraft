import type {
  CellPosition,
  CellWalls,
  MazeGraph,
  MazeProject,
  MoveDirection,
  PlacedItem,
} from '../core/maze/types'

export type MazeDirection = MoveDirection
export type MazePoint = CellPosition
export type MazeWalls = CellWalls

export interface MazeRenderMarker extends MazePoint {
  id?: string
  collected?: boolean
  label?: string
}

/**
 * The renderer intentionally consumes a small structural view of a maze rather
 * than a whole project. Core MazeGraph values can be passed directly whenever
 * they expose this shape, or adapted without copying the graph.
 */
export interface MazeRenderModel {
  projectId?: string
  graph: MazeGraph
  start: MazePoint
  end: MazePoint
  collectibles?: ReadonlyArray<PlacedItem | MazeRenderMarker>
  checkpoints?: ReadonlyArray<PlacedItem | MazeRenderMarker>
}

export interface MazeRenderTheme {
  canvas: string
  mazeFill: string
  wall: string
  wallShadow: string
  start: string
  end: string
  player: string
  ghost: string
  solution: string
  visited: string
  checkpoint: string
  collectible: string
  invalid: string
}

export interface MazeParticle {
  x: number
  y: number
  radius: number
  opacity: number
  color?: string
}

export interface MazeRevealLayer {
  /**
   * CanvasImageSource is kept outside persisted project data. The feature layer
   * resolves a Blob/Data URL into an ImageBitmap or HTMLImageElement once and
   * reuses it across frames.
   */
  source?: CanvasImageSource
  color?: string
  opacity?: number
  cells: ReadonlyArray<MazePoint>
}

export interface MazeGenerationEdge {
  from: MazePoint
  to: MazePoint
}

export interface MazeRenderFrame {
  player?: MazePoint | null
  /**
   * Ghost row/col may be fractional when replay frames are interpolated.
   */
  ghost?: MazePoint | null
  ghostTrail?: ReadonlyArray<MazePoint>
  solution?: ReadonlyArray<MazePoint>
  solutionProgress?: number
  visited?: ReadonlyArray<MazePoint>
  reveal?: MazeRevealLayer | null
  particles?: ReadonlyArray<MazeParticle>
  water?: {
    cells: ReadonlyArray<MazePoint>
    opacity: number
    color?: string
  } | null
  generation?: {
    edges: ReadonlyArray<MazeGenerationEdge>
    progress: number
    color?: string
  } | null
  activeCheckpointIds?: ReadonlySet<string>
  collectedItemIds?: ReadonlySet<string>
  showLabels?: boolean
}

export interface MazeViewport {
  scale: number
  x: number
  y: number
}

export interface MazeScreenPoint {
  x: number
  y: number
}

export interface MazeCellHit extends MazePoint {
  kind: 'cell'
  x: number
  y: number
}

export interface MazeWallHit extends MazePoint {
  kind: 'wall'
  wall: keyof MazeWalls
  x: number
  y: number
}

export type MazeHit = MazeCellHit | MazeWallHit

export const DEFAULT_MAZE_RENDER_THEME: MazeRenderTheme = {
  canvas: '#f4f7fb',
  mazeFill: '#ffffff',
  wall: '#172033',
  wallShadow: 'rgba(15, 23, 42, 0.08)',
  start: '#0f9f6e',
  end: '#e94c58',
  player: '#4f46e5',
  ghost: '#8b5cf6',
  solution: '#2563eb',
  visited: 'rgba(79, 70, 229, 0.12)',
  checkpoint: '#f59e0b',
  collectible: '#06b6d4',
  invalid: '#f8fafc',
}

export const pointKey = ({ row, col }: MazePoint): string => `${row}:${col}`

export const isMazePointEqual = (a: MazePoint, b: MazePoint): boolean =>
  a.row === b.row && a.col === b.col

export const isPointInMaze = (
  point: MazePoint,
  model: Pick<MazeRenderModel, 'graph'>,
): boolean => {
  const { graph } = model
  if (
    !Number.isInteger(point.row) ||
    !Number.isInteger(point.col) ||
    point.row < 0 ||
    point.col < 0 ||
    point.row >= graph.rows ||
    point.col >= graph.cols
  ) {
    return false
  }
  const cell = graph.cells[point.row * graph.cols + point.col]
  return Boolean(cell?.active)
}

export const renderModelFromProject = (project: MazeProject): MazeRenderModel => ({
  projectId: project.id,
  graph: project.mazeGraph,
  start: project.startCell,
  end: project.endCell,
  collectibles: project.collectibles,
  checkpoints: project.checkpoints,
})
