import type {
  CellPosition,
  MazeAlgorithm,
  MazeCell,
  MazeGraph,
  MazeMask,
  WallDirection,
} from './types'
import { MAZE_GRAPH_VERSION } from './types'

export const WALL_DIRECTIONS: readonly WallDirection[] = [
  'top',
  'right',
  'bottom',
  'left',
]

export const DIRECTION_DELTAS: Readonly<
  Record<WallDirection, Readonly<{ row: number; col: number }>>
> = {
  top: { row: -1, col: 0 },
  right: { row: 0, col: 1 },
  bottom: { row: 1, col: 0 },
  left: { row: 0, col: -1 },
}

export const OPPOSITE_DIRECTION: Readonly<Record<WallDirection, WallDirection>> = {
  top: 'bottom',
  right: 'left',
  bottom: 'top',
  left: 'right',
}

export interface CellNeighbor {
  direction: WallDirection
  cell: MazeCell
}

export function assertGridDimensions(rows: number, cols: number): void {
  if (
    !Number.isInteger(rows) ||
    !Number.isInteger(cols) ||
    rows < 1 ||
    cols < 1 ||
    rows > 500 ||
    cols > 500
  ) {
    throw new RangeError('Maze dimensions must be integers between 1 and 500.')
  }
}

export function getCellIndex(cols: number, position: CellPosition): number {
  return position.row * cols + position.col
}

export function positionFromIndex(cols: number, index: number): CellPosition {
  return {
    row: Math.floor(index / cols),
    col: index % cols,
  }
}

export function isPositionInside(
  rows: number,
  cols: number,
  position: CellPosition,
): boolean {
  return (
    Number.isInteger(position.row) &&
    Number.isInteger(position.col) &&
    position.row >= 0 &&
    position.row < rows &&
    position.col >= 0 &&
    position.col < cols
  )
}

export function positionsEqual(left: CellPosition, right: CellPosition): boolean {
  return left.row === right.row && left.col === right.col
}

/**
 * Picks one boundary-facing wall that renderers may hide as a visual entrance.
 * The graph is never mutated, so game movement remains constrained to the grid.
 */
export function getVisualOpeningDirection(
  graph: MazeGraph,
  position: CellPosition,
): WallDirection | null {
  const cell = getActiveCell(graph, position)
  if (!cell) return null

  const available = WALL_DIRECTIONS.filter((direction) => {
    const delta = DIRECTION_DELTAS[direction]
    const neighbor = getCell(graph, {
      row: position.row + delta.row,
      col: position.col + delta.col,
    })
    return !neighbor?.active
  })
  if (!available.length) return null

  const outerPriority: WallDirection[] = []
  if (position.row === 0) outerPriority.push('top')
  if (position.row === graph.rows - 1) outerPriority.push('bottom')
  if (position.col === graph.cols - 1) outerPriority.push('right')
  if (position.col === 0) outerPriority.push('left')
  return outerPriority.find((direction) => available.includes(direction)) ?? available[0]
}

export function createFullMask(rows: number, cols: number): MazeMask {
  assertGridDimensions(rows, cols)
  return { rows, cols, cells: new Array<boolean>(rows * cols).fill(true) }
}

export function normalizeMask(
  rows: number,
  cols: number,
  input?: MazeMask | boolean[][] | boolean[],
): MazeMask {
  assertGridDimensions(rows, cols)
  if (!input) {
    return createFullMask(rows, cols)
  }

  if (!Array.isArray(input) && 'cells' in input) {
    if (input.rows !== rows || input.cols !== cols || input.cells.length !== rows * cols) {
      throw new RangeError('Mask dimensions must match the requested maze dimensions.')
    }
    return { rows, cols, cells: input.cells.map(Boolean) }
  }

  if (Array.isArray(input) && input.length > 0 && Array.isArray(input[0])) {
    const matrix = input as boolean[][]
    if (matrix.length !== rows || matrix.some((line) => line.length !== cols)) {
      throw new RangeError('Mask matrix dimensions do not match the maze.')
    }
    return { rows, cols, cells: matrix.flatMap((line) => line.map(Boolean)) }
  }

  const cells = input as boolean[]
  if (cells.length !== rows * cols) {
    throw new RangeError('Mask bitmap dimensions do not match the maze.')
  }
  return { rows, cols, cells: cells.map(Boolean) }
}

export function createMaskFromPredicate(
  rows: number,
  cols: number,
  predicate: (position: CellPosition) => boolean,
): MazeMask {
  assertGridDimensions(rows, cols)
  const cells = new Array<boolean>(rows * cols)
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      cells[getCellIndex(cols, { row, col })] = Boolean(predicate({ row, col }))
    }
  }
  return { rows, cols, cells }
}

export function createEmptyGraph(
  rows: number,
  cols: number,
  options: {
    mask?: MazeMask | boolean[][] | boolean[]
    algorithm?: MazeAlgorithm
    seed?: string
  } = {},
): MazeGraph {
  const mask = normalizeMask(rows, cols, options.mask)
  const cells: MazeCell[] = []

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const index = getCellIndex(cols, { row, col })
      cells.push({
        index,
        row,
        col,
        active: mask.cells[index],
        walls: { top: true, right: true, bottom: true, left: true },
      })
    }
  }

  return {
    version: MAZE_GRAPH_VERSION,
    rows,
    cols,
    cells,
    algorithm: options.algorithm ?? 'dfs',
    seed: options.seed ?? 'maze',
  }
}

export function cloneMazeGraph(graph: MazeGraph): MazeGraph {
  return {
    ...graph,
    cells: graph.cells.map((cell) => ({
      ...cell,
      walls: { ...cell.walls },
    })),
  }
}

export function getCell(graph: MazeGraph, position: CellPosition): MazeCell | undefined {
  if (!isPositionInside(graph.rows, graph.cols, position)) {
    return undefined
  }
  return graph.cells[getCellIndex(graph.cols, position)]
}

export function getActiveCell(graph: MazeGraph, position: CellPosition): MazeCell | undefined {
  const cell = getCell(graph, position)
  return cell?.active ? cell : undefined
}

export function getNeighborPosition(
  position: CellPosition,
  direction: WallDirection,
): CellPosition {
  const delta = DIRECTION_DELTAS[direction]
  return { row: position.row + delta.row, col: position.col + delta.col }
}

export function directionBetween(
  from: CellPosition,
  to: CellPosition,
): WallDirection | undefined {
  const rowDelta = to.row - from.row
  const colDelta = to.col - from.col
  if (rowDelta === -1 && colDelta === 0) return 'top'
  if (rowDelta === 0 && colDelta === 1) return 'right'
  if (rowDelta === 1 && colDelta === 0) return 'bottom'
  if (rowDelta === 0 && colDelta === -1) return 'left'
  return undefined
}

export function getActiveNeighbors(
  graph: MazeGraph,
  position: CellPosition,
): CellNeighbor[] {
  const neighbors: CellNeighbor[] = []
  for (const direction of WALL_DIRECTIONS) {
    const neighbor = getActiveCell(graph, getNeighborPosition(position, direction))
    if (neighbor) {
      neighbors.push({ direction, cell: neighbor })
    }
  }
  return neighbors
}

export function getPassageNeighbors(
  graph: MazeGraph,
  position: CellPosition,
): CellNeighbor[] {
  const cell = getActiveCell(graph, position)
  if (!cell) return []
  return getActiveNeighbors(graph, position).filter(
    ({ direction, cell: neighbor }) =>
      !cell.walls[direction] && !neighbor.walls[OPPOSITE_DIRECTION[direction]],
  )
}

/**
 * Sets both halves of an interior wall. Requests to open the outside boundary
 * or an inactive cell are rejected so the player can never leave the array.
 */
export function setWall(
  graph: MazeGraph,
  position: CellPosition,
  direction: WallDirection,
  closed: boolean,
): boolean {
  const cell = getActiveCell(graph, position)
  if (!cell) return false
  const neighborPosition = getNeighborPosition(position, direction)
  const neighbor = getActiveCell(graph, neighborPosition)
  if (!neighbor) {
    cell.walls[direction] = true
    return closed
  }

  cell.walls[direction] = closed
  neighbor.walls[OPPOSITE_DIRECTION[direction]] = closed
  return true
}

export function openPassage(
  graph: MazeGraph,
  from: CellPosition,
  to: CellPosition,
): boolean {
  const direction = directionBetween(from, to)
  return direction ? setWall(graph, from, direction, false) : false
}

export function closePassage(
  graph: MazeGraph,
  from: CellPosition,
  to: CellPosition,
): boolean {
  const direction = directionBetween(from, to)
  return direction ? setWall(graph, from, direction, true) : false
}

export function getCellDegree(graph: MazeGraph, position: CellPosition): number {
  return getPassageNeighbors(graph, position).length
}

export function countGraphEdges(graph: MazeGraph): number {
  let edgeCount = 0
  for (const cell of graph.cells) {
    if (!cell.active) continue
    const right = getActiveCell(graph, { row: cell.row, col: cell.col + 1 })
    const bottom = getActiveCell(graph, { row: cell.row + 1, col: cell.col })
    if (right && !cell.walls.right && !right.walls.left) edgeCount += 1
    if (bottom && !cell.walls.bottom && !bottom.walls.top) edgeCount += 1
  }
  return edgeCount
}

export function graphToMask(graph: MazeGraph): MazeMask {
  return {
    rows: graph.rows,
    cols: graph.cols,
    cells: graph.cells.map((cell) => cell.active),
  }
}

export function normalizeWallSymmetry(graph: MazeGraph): number {
  let changes = 0
  for (const cell of graph.cells) {
    if (!cell.active) {
      for (const direction of WALL_DIRECTIONS) {
        if (!cell.walls[direction]) {
          cell.walls[direction] = true
          changes += 1
        }
      }
      continue
    }

    for (const direction of WALL_DIRECTIONS) {
      const neighbor = getActiveCell(graph, getNeighborPosition(cell, direction))
      if (!neighbor) {
        if (!cell.walls[direction]) {
          cell.walls[direction] = true
          changes += 1
        }
        continue
      }

      const opposite = OPPOSITE_DIRECTION[direction]
      const closed = cell.walls[direction] && neighbor.walls[opposite]
      if (cell.walls[direction] !== closed) {
        cell.walls[direction] = closed
        changes += 1
      }
      if (neighbor.walls[opposite] !== closed) {
        neighbor.walls[opposite] = closed
        changes += 1
      }
    }
  }
  return changes
}
