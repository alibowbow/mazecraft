import {
  getCellIndex,
  getPassageNeighbors,
  isPositionInside,
  positionFromIndex,
} from './graph'
import type { CellPosition, MazeGraph, MazeSolution } from './types'

export interface BreadthFirstSearchResult {
  distances: Int32Array
  parents: Int32Array
  shortestPathCounts: Uint32Array
  visitedIndices: number[]
}
export function breadthFirstSearch(
  graph: MazeGraph,
  start: CellPosition,
  shortestPathCountCap = 2,
): BreadthFirstSearchResult {
  const size = graph.rows * graph.cols
  const distances = new Int32Array(size)
  distances.fill(-1)
  const parents = new Int32Array(size)
  parents.fill(-1)
  const shortestPathCounts = new Uint32Array(size)
  const visitedIndices: number[] = []

  if (!isPositionInside(graph.rows, graph.cols, start)) {
    return { distances, parents, shortestPathCounts, visitedIndices }
  }
  const startIndex = getCellIndex(graph.cols, start)
  if (!graph.cells[startIndex]?.active) {
    return { distances, parents, shortestPathCounts, visitedIndices }
  }

  const queue = new Int32Array(size)
  let head = 0
  let tail = 0
  queue[tail++] = startIndex
  distances[startIndex] = 0
  shortestPathCounts[startIndex] = 1

  while (head < tail) {
    const index = queue[head++]
    visitedIndices.push(index)
    const position = positionFromIndex(graph.cols, index)
    for (const { cell: neighbor } of getPassageNeighbors(graph, position)) {
      if (distances[neighbor.index] < 0) {
        distances[neighbor.index] = distances[index] + 1
        parents[neighbor.index] = index
        shortestPathCounts[neighbor.index] = shortestPathCounts[index]
        queue[tail++] = neighbor.index
      } else if (distances[neighbor.index] === distances[index] + 1) {
        shortestPathCounts[neighbor.index] = Math.min(
          shortestPathCountCap,
          shortestPathCounts[neighbor.index] + shortestPathCounts[index],
        )
      }
    }
  }

  return { distances, parents, shortestPathCounts, visitedIndices }
}

export function solveMaze(
  graph: MazeGraph,
  start: CellPosition,
  end: CellPosition,
  shortestPathCountCap = 2,
): MazeSolution {
  if (!isPositionInside(graph.rows, graph.cols, end)) {
    return {
      solved: false,
      path: [],
      distance: -1,
      visitedCount: 0,
      shortestPathCount: 0,
    }
  }

  const search = breadthFirstSearch(graph, start, shortestPathCountCap)
  const endIndex = getCellIndex(graph.cols, end)
  if (search.distances[endIndex] < 0) {
    return {
      solved: false,
      path: [],
      distance: -1,
      visitedCount: search.visitedIndices.length,
      shortestPathCount: 0,
    }
  }

  const reversedPath: CellPosition[] = []
  let current = endIndex
  while (current >= 0) {
    reversedPath.push(positionFromIndex(graph.cols, current))
    if (search.distances[current] === 0) break
    current = search.parents[current]
  }

  return {
    solved: true,
    path: reversedPath.reverse(),
    distance: search.distances[endIndex],
    visitedCount: search.visitedIndices.length,
    shortestPathCount: search.shortestPathCounts[endIndex],
  }
}

export function findConnectedComponents(graph: MazeGraph): CellPosition[][] {
  const seen = new Uint8Array(graph.cells.length)
  const components: CellPosition[][] = []

  for (const start of graph.cells) {
    if (!start.active || seen[start.index]) continue
    const search = breadthFirstSearch(graph, start)
    const component = search.visitedIndices.map((index) =>
      positionFromIndex(graph.cols, index),
    )
    for (const index of search.visitedIndices) seen[index] = 1
    components.push(component)
  }

  return components.sort((left, right) => right.length - left.length)
}

export function isMazeSolvable(
  graph: MazeGraph,
  start: CellPosition,
  end: CellPosition,
): boolean {
  return solveMaze(graph, start, end).solved
}
