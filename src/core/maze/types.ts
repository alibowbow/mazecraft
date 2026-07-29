export const MAZE_GRAPH_VERSION = 1 as const
export const CURRENT_SCHEMA_VERSION = 1 as const
export const CURRENT_APP_VERSION = '1.0.0' as const

export type MazeAlgorithm = 'dfs' | 'kruskal' | 'prim'
export type WallDirection = 'top' | 'right' | 'bottom' | 'left'
export type MoveDirection = 'up' | 'right' | 'down' | 'left'

export interface CellPosition {
  row: number
  col: number
}

export interface CellWalls {
  top: boolean
  right: boolean
  bottom: boolean
  left: boolean
}

/**
 * Cells are stored row-major in MazeGraph.cells. `true` means a wall is closed.
 * Inactive cells remain in the array so graph indices are stable across masks.
 */
export interface MazeCell extends CellPosition {
  index: number
  active: boolean
  walls: CellWalls
}

export interface MazeGraph {
  version: typeof MAZE_GRAPH_VERSION
  rows: number
  cols: number
  cells: MazeCell[]
  algorithm: MazeAlgorithm
  seed: string
}

export interface MazeMask {
  rows: number
  cols: number
  /** Row-major bitmap; true means that a cell belongs to the maze. */
  cells: boolean[]
}

export interface MazeGenerationOptions {
  rows: number
  cols: number
  seed: string | number
  algorithm?: MazeAlgorithm
  mask?: MazeMask | boolean[][] | boolean[]
  /**
   * Chance (0..1) of opening an additional wall after spanning-tree generation.
   * Zero preserves a perfect maze.
   */
  braidProbability?: number
  /** Optional in-process hook used to build a deterministic creation replay. */
  onPassageOpened?: (
    from: Readonly<CellPosition>,
    to: Readonly<CellPosition>,
  ) => void
}

export interface MazeGenerationResult {
  graph: MazeGraph
  start: CellPosition
  end: CellPosition
  metrics: MazeMetrics
}

export interface MazeSolution {
  solved: boolean
  /** Ordered path including start and end. Empty when no solution exists. */
  path: CellPosition[]
  distance: number
  visitedCount: number
  /** Number of shortest solutions, capped by the requested solver limit. */
  shortestPathCount: number
}

export interface EndpointOptimizationResult {
  start: CellPosition
  end: CellPosition
  distance: number
  componentSize: number
}

export type DifficultyLevel =
  | 'very-easy'
  | 'easy'
  | 'normal'
  | 'hard'
  | 'expert'
  | 'custom'

export interface DifficultyProfile {
  level: DifficultyLevel
  targetScore: number
  minScore: number
  maxScore: number
  estimatedSecondsRange: readonly [number, number]
}

export interface MazeMetrics {
  difficultyScore: number
  difficultyLevel: Exclude<DifficultyLevel, 'custom'>
  estimatedSeconds: number
  activeCells: number
  reachableCells: number
  componentCount: number
  disconnectedRegions: number
  pathLength: number
  solutionRatio: number
  graphDistance: number
  deadEnds: number
  deadEndRatio: number
  branches: number
  intersections: number
  turns: number
  consecutiveTurns: number
  exitDecoys: number
  edgeCount: number
  loopCount: number
  hasLoops: boolean
  solutionCount: number
  shapeRecognition: number
  minimumPassageWidth: number
  solvable: boolean
}

export interface MazeCandidateRequest
  extends Omit<MazeGenerationOptions, 'onPassageOpened'> {
  difficulty: DifficultyLevel
  candidateCount?: number
  customTargetScore?: number
  shapeRecognition?: number
  minimumPassageWidth?: number
}

export interface MazeCandidate {
  result: MazeGenerationResult
  candidateIndex: number
  targetDistance: number
  generationTrace: MazeGenerationTraceStep[]
}

export interface MazeGenerationTraceStep {
  from: CellPosition
  to: CellPosition
}

export interface MazeCandidateProgress {
  requestId?: string
  completed: number
  total: number
  bestScore?: number
}

export type ValidationSeverity = 'error' | 'warning' | 'info'

export type ValidationIssueCode =
  | 'invalid-dimensions'
  | 'invalid-cell-count'
  | 'invalid-cell-index'
  | 'wall-asymmetry'
  | 'open-outer-wall'
  | 'isolated-cell'
  | 'disconnected-regions'
  | 'inactive-start'
  | 'inactive-end'
  | 'unreachable-end'
  | 'short-solution'
  | 'endpoints-too-close'
  | 'too-few-active-cells'
  | 'narrow-passage'

export interface ValidationIssue {
  code: ValidationIssueCode
  severity: ValidationSeverity
  message: string
  cells: CellPosition[]
  autoFixable: boolean
}

export interface MazeValidationResult {
  valid: boolean
  solvable: boolean
  issues: ValidationIssue[]
  metrics: MazeMetrics
}

export interface MazeRepairResult {
  graph: MazeGraph
  start: CellPosition
  end: CellPosition
  validation: MazeValidationResult
  repairs: ValidationIssueCode[]
}

export type MazeTransform =
  | 'flip-horizontal'
  | 'flip-vertical'
  | 'rotate-clockwise'
  | 'rotate-counterclockwise'

export interface MazeTransformResult {
  graph: MazeGraph
  start?: CellPosition
  end?: CellPosition
}

export type BasicShapeName =
  | 'rectangle'
  | 'rounded-rectangle'
  | 'circle'
  | 'ellipse'
  | 'heart'
  | 'star'
  | 'diamond'
  | 'hexagon'
  | 'crescent'
  | 'cloud'
  | 'flower'
  | 'tree'
  | 'house'
  | 'crown'
  | 'lightning'
  | 'speech-bubble'
  | 'puzzle'

export interface TextMaskSettings {
  text: string
  mode: 'obstacle' | 'outline' | 'secret'
  fontFamily: string
  fontWeight: number
  letterSpacing: number
  lineHeight: number
  horizontalAlign: 'left' | 'center' | 'right'
  verticalAlign: 'top' | 'middle' | 'bottom'
  autoFit: boolean
}

export interface ImageMaskSettings {
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/svg+xml'
  dataUrl: string
  crop: { x: number; y: number; width: number; height: number }
  scale: number
  rotation: number
  grayscale: boolean
  threshold: number
  inverted: boolean
  smoothing: number
  noiseRemoval: number
  fillInterior: boolean
  largestComponentOnly: boolean
}

export interface DrawingPoint {
  x: number
  y: number
  pressure: number
}

export type MazeShape =
  | { kind: 'basic'; name: BasicShapeName; inset: number }
  | { kind: 'text'; settings: TextMaskSettings }
  | { kind: 'image'; settings: ImageMaskSettings }
  | { kind: 'drawing'; paths: DrawingPoint[][]; brushSize: number }

export interface MazeCanvasSettings {
  width: number
  height: number
  aspectRatio: '1:1' | '4:3' | '3:4' | '16:9' | '9:16' | 'a4-portrait' | 'a4-landscape'
}

export interface MazeGridSettings {
  rows: number
  cols: number
  minimumCellPixels: number
}

export interface VisualTheme {
  wallColor: string
  pathColor: string
  startColor: string
  endColor: string
  accentColor: string
  wallWidth: number
  cornerRadius: number
}

export type BackgroundSettings =
  | { kind: 'solid'; color: string }
  | { kind: 'grid'; color: string; lineColor: string; spacing: number }
  | { kind: 'paper'; color: string; grain: number }
  | { kind: 'image'; dataUrl: string; opacity: number; fit: 'cover' | 'contain' }

export interface PlacedItem extends CellPosition {
  id: string
  label: string
}

export interface GameRules {
  mode: 'classic' | 'time-attack' | 'checkpoint'
  timeLimitSeconds: number | null
  allowedHints: number
  showDpad: boolean
  soundEnabled: boolean
  ghostAllowed: boolean
}

export type SecretContent =
  | { kind: 'none' }
  | { kind: 'message'; message: string }
  | { kind: 'image'; imageDataUrl: string; alt: string }
  | { kind: 'image-message'; imageDataUrl: string; alt: string; message: string }
  | { kind: 'link'; label: string; url: string }
  | { kind: 'coupon'; code: string; message: string }
  | { kind: 'hint'; message: string; nextLocation: string }

export interface SecretRevealSettings {
  content: SecretContent
  mode: 'visited-cells' | 'solution-path' | 'checkpoints' | 'on-complete'
  animation: 'fade' | 'puzzle' | 'unmask' | 'zoom' | 'none'
}

export interface ReplayFrame extends CellPosition {
  atMs: number
  direction?: MoveDirection
  checkpointId?: string
  usedHint?: boolean
}

export interface CreatorReplay {
  durationMs: number
  frames: ReplayFrame[]
  completed: boolean
}

export interface ExportSettings {
  scale: 1 | 2 | 4
  transparentBackground: boolean
  includeEndpoints: boolean
  includeSolution: boolean
  printOrientation: 'portrait' | 'landscape'
  printTitle: boolean
  printNameField: boolean
  printAnswerSheet: boolean
}

export interface RemixAttribution {
  sourceProjectId: string
  sourceTitle: string
  creatorDisplayName?: string
}

export interface MazeProject {
  schemaVersion: typeof CURRENT_SCHEMA_VERSION
  appVersion: string
  id: string
  title: string
  description: string
  creatorDisplayName: string
  createdAt: string
  updatedAt: string
  seed: string
  canvas: MazeCanvasSettings
  grid: MazeGridSettings
  shape: MazeShape
  mask: MazeMask
  mazeGraph: MazeGraph
  startCell: CellPosition
  endCell: CellPosition
  difficulty: DifficultyLevel
  mazeMetrics: MazeMetrics
  visualTheme: VisualTheme
  background: BackgroundSettings
  gameRules: GameRules
  collectibles: PlacedItem[]
  checkpoints: PlacedItem[]
  secretReveal: SecretRevealSettings
  creatorReplay: CreatorReplay | null
  exportSettings: ExportSettings
  attribution: RemixAttribution | null
  remixAllowed: boolean
}

export interface MazeWorkerGenerateRequest {
  type: 'generate'
  requestId: string
  payload: MazeCandidateRequest
}

export interface MazeWorkerCancelRequest {
  type: 'cancel'
  requestId: string
}

export type MazeWorkerRequest = MazeWorkerGenerateRequest | MazeWorkerCancelRequest

export type MazeWorkerResponse =
  | {
      type: 'progress'
      requestId: string
      progress: MazeCandidateProgress
    }
  | {
      type: 'complete'
      requestId: string
      result: MazeCandidate
    }
  | {
      type: 'cancelled'
      requestId: string
    }
  | {
      type: 'error'
      requestId: string
      message: string
    }
