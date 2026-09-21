import { createDefaultProject, generateBestMazeCandidate, type BasicShapeName, type DifficultyLevel, type MazeAlgorithm, type MazeProject } from '../../core/maze'
import { createBasicShapeMask } from '../../core/masks/shapeMask'

export interface WaterMazeOptions {
  rows: number; cols: number; shape: BasicShapeName
  algorithm: MazeAlgorithm; difficulty: DifficultyLevel; seed: string
}
export const DEFAULT_WATER_MAZE: WaterMazeOptions = { rows: 12, cols: 12, shape: 'rectangle', algorithm: 'kruskal', difficulty: 'normal', seed: 'atelier-labyrinth-25' }
export const WATER_MAZE_SHAPES = [
  ['rectangle', '사각형'], ['circle', '원형'], ['hexagon', '육각형'], ['heart', '하트'], ['star', '별'], ['diamond', '마름모'],
] as const

export function createGeneratedWaterMaze(options: WaterMazeOptions): MazeProject {
  const rows = Math.max(8, Math.min(32, Math.round(options.rows)))
  const cols = Math.max(8, Math.min(32, Math.round(options.cols)))
  const seed = options.seed.trim().slice(0, 120) || DEFAULT_WATER_MAZE.seed
  const mask = options.shape === 'rectangle' ? { rows, cols, cells: Array<boolean>(rows * cols).fill(true) } : createBasicShapeMask(options.shape, rows, cols, 0.025)
  const candidate = generateBestMazeCandidate({ rows, cols, mask, seed, algorithm: options.algorithm, difficulty: options.difficulty, minimumPassageWidth: 8 })
  const name = WATER_MAZE_SHAPES.find(([id]) => id === options.shape)?.[1] ?? '나의'
  const project = createDefaultProject({ title: `${name} 물 미로`, seed, grid: { rows, cols, minimumCellPixels: 8 }, shape: { kind: 'basic', name: options.shape, inset: 0.025 }, difficulty: options.difficulty,
    mask, mazeGraph: candidate.result.graph, startCell: candidate.result.start, endCell: candidate.result.end, mazeMetrics: candidate.result.metrics })
  return { ...project, seed }
}
