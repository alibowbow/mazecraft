import {
  createEmptyGraph,
  getActiveCell,
  openPassage,
} from './graph'
import type {
  CellPosition,
  MazeGraph,
  MazeTransform,
  MazeTransformResult,
} from './types'

function mapPosition(
  graph: MazeGraph,
  position: CellPosition,
  operation: MazeTransform,
): CellPosition {
  if (operation === 'flip-horizontal') {
    return { row: position.row, col: graph.cols - position.col - 1 }
  }
  if (operation === 'flip-vertical') {
    return { row: graph.rows - position.row - 1, col: position.col }
  }
  if (operation === 'rotate-clockwise') {
    return { row: position.col, col: graph.rows - position.row - 1 }
  }
  return { row: graph.cols - position.col - 1, col: position.row }
}

export function transformMaze(
  source: MazeGraph,
  operation: MazeTransform,
  start?: CellPosition,
  end?: CellPosition,
): MazeTransformResult {
  const rotates =
    operation === 'rotate-clockwise' || operation === 'rotate-counterclockwise'
  const rows = rotates ? source.cols : source.rows
  const cols = rotates ? source.rows : source.cols
  const transformedMask = new Array<boolean>(rows * cols).fill(false)

  for (const cell of source.cells) {
    if (!cell.active) continue
    const mapped = mapPosition(source, cell, operation)
    transformedMask[mapped.row * cols + mapped.col] = true
  }

  const graph = createEmptyGraph(rows, cols, {
    mask: transformedMask,
    algorithm: source.algorithm,
    seed: source.seed,
  })

  for (const cell of source.cells) {
    if (!cell.active) continue
    const right = getActiveCell(source, { row: cell.row, col: cell.col + 1 })
    const bottom = getActiveCell(source, { row: cell.row + 1, col: cell.col })
    if (right && !cell.walls.right && !right.walls.left) {
      openPassage(
        graph,
        mapPosition(source, cell, operation),
        mapPosition(source, right, operation),
      )
    }
    if (bottom && !cell.walls.bottom && !bottom.walls.top) {
      openPassage(
        graph,
        mapPosition(source, cell, operation),
        mapPosition(source, bottom, operation),
      )
    }
  }

  return {
    graph,
    start: start ? mapPosition(source, start, operation) : undefined,
    end: end ? mapPosition(source, end, operation) : undefined,
  }
}

export function flipMazeHorizontal(
  graph: MazeGraph,
  start?: CellPosition,
  end?: CellPosition,
): MazeTransformResult {
  return transformMaze(graph, 'flip-horizontal', start, end)
}

export function flipMazeVertical(
  graph: MazeGraph,
  start?: CellPosition,
  end?: CellPosition,
): MazeTransformResult {
  return transformMaze(graph, 'flip-vertical', start, end)
}

export function rotateMaze90(
  graph: MazeGraph,
  start?: CellPosition,
  end?: CellPosition,
): MazeTransformResult {
  return transformMaze(graph, 'rotate-clockwise', start, end)
}

export function swapEndpoints(
  start: CellPosition,
  end: CellPosition,
): { start: CellPosition; end: CellPosition } {
  return { start: { ...end }, end: { ...start } }
}
