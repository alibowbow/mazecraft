import {
  getActiveNeighbors,
  getCellIndex,
} from './graph'
import { breadthFirstSearch, findConnectedComponents } from './solver'
import type {
  CellPosition,
  EndpointOptimizationResult,
  MazeGraph,
} from './types'

function isMaskBoundary(graph: MazeGraph, position: CellPosition): boolean {
  return getActiveNeighbors(graph, position).length < 4
}

function comparePositions(left: CellPosition, right: CellPosition): number {
  return left.row - right.row || left.col - right.col
}

function boundaryRowCandidates(
  graph: MazeGraph,
  component: readonly CellPosition[],
): { starts: CellPosition[]; ends: CellPosition[] } {
  const maskBoundary = component.filter((position) =>
    isMaskBoundary(graph, position),
  )
  // A malformed, passage-disconnected graph can contain a component entirely
  // enclosed by other active cells. Fall back to the component itself so repair
  // and import flows can still choose usable endpoints.
  const available = maskBoundary.length ? maskBoundary : [...component]
  const topRow = available.reduce(
    (minimum, position) => Math.min(minimum, position.row),
    Number.POSITIVE_INFINITY,
  )
  const bottomRow = available.reduce(
    (maximum, position) => Math.max(maximum, position.row),
    Number.NEGATIVE_INFINITY,
  )

  return {
    starts: available
      .filter((position) => position.row === topRow)
      .sort(comparePositions),
    ends: available
      .filter((position) => position.row === bottomRow)
      .sort(comparePositions),
  }
}

/**
 * Places generated-maze entrances on the topmost and bottommost available mask
 * boundary rows of the largest connected component. Among those candidates it
 * maximizes actual graph-path distance. Equal-distance pairs use row/column
 * order for deterministic generation.
 */
export function optimizeEndpoints(graph: MazeGraph): EndpointOptimizationResult {
  const components = findConnectedComponents(graph)
  const largest = components[0]
  if (!largest?.length) {
    throw new Error('Cannot choose endpoints because the maze has no active cells.')
  }
  if (largest.length === 1) {
    return { start: largest[0], end: largest[0], distance: 0, componentSize: 1 }
  }

  const { starts, ends } = boundaryRowCandidates(graph, largest)
  let bestStart = starts[0]
  let bestEnd = ends[0]
  let bestDistance = -1

  for (const start of starts) {
    const search = breadthFirstSearch(graph, start)
    for (const end of ends) {
      const distance = search.distances[getCellIndex(graph.cols, end)]
      if (distance > bestDistance) {
        bestStart = start
        bestEnd = end
        bestDistance = distance
      }
    }
  }

  return {
    start: bestStart,
    end: bestEnd,
    distance: bestDistance,
    componentSize: largest.length,
  }
}
