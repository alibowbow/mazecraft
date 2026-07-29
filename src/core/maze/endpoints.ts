import {
  getActiveNeighbors,
  getCellIndex,
  positionFromIndex,
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

function boundaryDistance(graph: MazeGraph, position: CellPosition): number {
  return Math.min(
    position.row,
    position.col,
    graph.rows - position.row - 1,
    graph.cols - position.col - 1,
  )
}

function farthestReachable(
  graph: MazeGraph,
  origin: CellPosition,
  allowed?: ReadonlySet<number>,
): { position: CellPosition; distance: number } {
  const search = breadthFirstSearch(graph, origin)
  const reachable = search.visitedIndices.filter(
    (index) => !allowed || allowed.has(index),
  )
  const maximumDistance = reachable.reduce(
    (maximum, index) => Math.max(maximum, search.distances[index]),
    0,
  )
  const boundaryCandidates = reachable.filter((index) => {
    const position = positionFromIndex(graph.cols, index)
    return isMaskBoundary(graph, position)
  })
  const candidates = boundaryCandidates.length
    ? boundaryCandidates
    : reachable.filter((index) => search.distances[index] === maximumDistance)
  const bestIndex =
    candidates.sort((left, right) => {
      const distanceDifference =
        search.distances[right] - search.distances[left]
      if (distanceDifference) return distanceDifference
      const leftPosition = positionFromIndex(graph.cols, left)
      const rightPosition = positionFromIndex(graph.cols, right)
      return (
        boundaryDistance(graph, leftPosition) -
          boundaryDistance(graph, rightPosition) ||
        left - right
      )
    })[0] ?? getCellIndex(graph.cols, origin)
  const bestDistance = search.distances[bestIndex] ?? 0

  return {
    position: positionFromIndex(graph.cols, bestIndex),
    distance: bestDistance,
  }
}

/**
 * Uses a double-BFS sweep while preferring the farthest reachable mask-boundary
 * cell on each pass. This keeps entrances visually external without using
 * straight-line distance or mutating the graph.
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

  const allowed = new Set(
    largest.map((position) => getCellIndex(graph.cols, position)),
  )
  const first = farthestReachable(graph, largest[0], allowed)
  const second = farthestReachable(graph, first.position, allowed)
  return {
    start: first.position,
    end: second.position,
    distance: second.distance,
    componentSize: largest.length,
  }
}
