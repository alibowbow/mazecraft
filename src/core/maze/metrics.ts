import {
  countGraphEdges,
  getActiveNeighbors,
  getCellDegree,
  getCellIndex,
  getPassageNeighbors,
  positionFromIndex,
} from './graph'
import {
  calculateDifficultyScore,
  difficultyFromScore,
} from './difficulty'
import { findConnectedComponents, solveMaze } from './solver'
import type { CellPosition, MazeGraph, MazeMetrics } from './types'

export interface MazeMetricOptions {
  shapeRecognition?: number
  minimumPassageWidth?: number
}

export function createEmptyMazeMetrics(): MazeMetrics {
  return {
    difficultyScore: 0,
    difficultyLevel: 'very-easy',
    estimatedSeconds: 0,
    activeCells: 0,
    reachableCells: 0,
    componentCount: 0,
    disconnectedRegions: 0,
    pathLength: 0,
    solutionRatio: 0,
    graphDistance: -1,
    deadEnds: 0,
    deadEndRatio: 0,
    branches: 0,
    intersections: 0,
    turns: 0,
    consecutiveTurns: 0,
    exitDecoys: 0,
    edgeCount: 0,
    loopCount: 0,
    hasLoops: false,
    solutionCount: 0,
    shapeRecognition: 0,
    minimumPassageWidth: 0,
    solvable: false,
  }
}

function directionCode(from: CellPosition, to: CellPosition): number {
  if (to.row < from.row) return 0
  if (to.col > from.col) return 1
  if (to.row > from.row) return 2
  return 3
}

function analyzeTurns(path: readonly CellPosition[]): {
  turns: number
  consecutiveTurns: number
} {
  if (path.length < 3) return { turns: 0, consecutiveTurns: 0 }
  let turns = 0
  let currentRun = 0
  let longestRun = 0
  let previousDirection = directionCode(path[0], path[1])

  for (let index = 2; index < path.length; index += 1) {
    const direction = directionCode(path[index - 1], path[index])
    if (direction !== previousDirection) {
      turns += 1
      currentRun += 1
      longestRun = Math.max(longestRun, currentRun)
    } else {
      currentRun = 0
    }
    previousDirection = direction
  }
  return { turns, consecutiveTurns: longestRun }
}

function countExitDecoys(graph: MazeGraph, path: readonly CellPosition[]): number {
  if (path.length < 2) return 0
  const pathIndices = new Set(path.map((position) => getCellIndex(graph.cols, position)))
  const startIndex = Math.max(0, Math.floor(path.length * 0.7))
  const decoys = new Set<number>()

  for (let index = startIndex; index < path.length; index += 1) {
    for (const { cell: neighbor } of getPassageNeighbors(graph, path[index])) {
      if (!pathIndices.has(neighbor.index)) decoys.add(neighbor.index)
    }
  }
  return decoys.size
}

function estimateShapeRecognition(graph: MazeGraph): number {
  const activeCells = graph.cells.filter((cell) => cell.active)
  if (activeCells.length === 0) return 0
  const seen = new Uint8Array(graph.cells.length)
  let largest = 0

  for (const start of activeCells) {
    if (seen[start.index]) continue
    const queue = [start.index]
    seen[start.index] = 1
    let size = 0
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const index = queue[cursor]
      size += 1
      for (const { cell: neighbor } of getActiveNeighbors(
        graph,
        positionFromIndex(graph.cols, index),
      )) {
        if (!seen[neighbor.index]) {
          seen[neighbor.index] = 1
          queue.push(neighbor.index)
        }
      }
    }
    largest = Math.max(largest, size)
  }

  return Math.round((largest / activeCells.length) * 100)
}

export function calculateMazeMetrics(
  graph: MazeGraph,
  start: CellPosition,
  end: CellPosition,
  options: MazeMetricOptions = {},
): MazeMetrics {
  const activeCells = graph.cells.reduce(
    (count, cell) => count + (cell.active ? 1 : 0),
    0,
  )
  const components = findConnectedComponents(graph)
  const solution = solveMaze(graph, start, end)
  let deadEnds = 0
  let branches = 0
  let intersections = 0

  for (const cell of graph.cells) {
    if (!cell.active) continue
    const degree = getCellDegree(graph, cell)
    if (degree === 1) deadEnds += 1
    if (degree === 3) branches += 1
    if (degree >= 4) intersections += 1
  }

  const pathLength = solution.solved ? solution.path.length : 0
  const graphDistance = solution.solved ? solution.distance : -1
  const solutionRatio = activeCells > 0 ? pathLength / activeCells : 0
  const deadEndRatio = activeCells > 0 ? deadEnds / activeCells : 0
  const { turns, consecutiveTurns } = analyzeTurns(solution.path)
  const edgeCount = countGraphEdges(graph)
  const loopCount = Math.max(0, edgeCount - activeCells + components.length)
  const exitDecoys = countExitDecoys(graph, solution.path)
  const difficultyScore = calculateDifficultyScore({
    activeCells,
    pathLength,
    solutionRatio,
    deadEndRatio,
    branches,
    turns,
    exitDecoys,
    loopCount,
    solvable: solution.solved,
  })
  const estimatedSeconds = solution.solved
    ? Math.max(
        5,
        Math.round(
          graphDistance * 0.16 +
            deadEnds * 0.42 +
            turns * 0.08 +
            exitDecoys * 0.8,
        ),
      )
    : 0

  return {
    difficultyScore,
    difficultyLevel: difficultyFromScore(difficultyScore),
    estimatedSeconds,
    activeCells,
    reachableCells: solution.visitedCount,
    componentCount: components.length,
    disconnectedRegions: Math.max(0, components.length - 1),
    pathLength,
    solutionRatio,
    graphDistance,
    deadEnds,
    deadEndRatio,
    branches,
    intersections,
    turns,
    consecutiveTurns,
    exitDecoys,
    edgeCount,
    loopCount,
    hasLoops: loopCount > 0,
    solutionCount: solution.shortestPathCount,
    shapeRecognition:
      options.shapeRecognition === undefined
        ? estimateShapeRecognition(graph)
        : Math.round(Math.min(100, Math.max(0, options.shapeRecognition))),
    minimumPassageWidth: options.minimumPassageWidth ?? 1,
    solvable: solution.solved,
  }
}
