import type { MazeProject } from '../../../core/maze'
import type { FluidFunnel, FluidLayout, FluidWall } from './types'

/** Geometry and sampling are independent of the renderer's quality setting. */
export function buildFluidLayout(project: MazeProject): FluidLayout {
  const graph = project.mazeGraph
  const { rows, cols } = graph
  if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 1 || cols < 1 || graph.cells.length !== rows * cols) {
    throw new RangeError('Invalid fluid maze dimensions.')
  }
  const activeCells = Uint8Array.from(graph.cells, cell => Number(cell.active))
  let activeCellCount = 0
  let left = cols, right = 0, topY = rows, bottomY = 0
  for (let i = 0; i < activeCells.length; i++) {
    if (!activeCells[i]) continue
    const row = Math.floor(i / cols), col = i % cols
    activeCellCount++
    left = Math.min(left, col); right = Math.max(right, col + 1)
    topY = Math.min(topY, row); bottomY = Math.max(bottomY, row + 1)
  }
  if (!activeCellCount) throw new RangeError('The fluid maze needs an active cell.')
  const endpointCol = (row: number, preferred: number): number => {
    let selected = -1, distance = Infinity
    for (let col = 0; col < cols; col++) {
      if (activeCells[row * cols + col] && Math.abs(col - preferred) < distance) {
        selected = col; distance = Math.abs(col - preferred)
      }
    }
    return selected
  }
  const sourceCol = endpointCol(topY, project.startCell.col)
  const exitCol = endpointCol(bottomY - 1, project.endCell.col)
  const inletX = sourceCol + 0.5, outletX = exitCol + 0.5
  const walls: FluidWall[] = []
  const halfWall = 0.05
  const horizontal = (x0: number, x1: number, y: number, kind?: 'funnel') => {
    if (x1 > x0) walls.push({ x0: x0 - halfWall, x1: x1 + halfWall, y0: y - halfWall, y1: y + halfWall, ...(kind ? { kind } : {}) })
  }
  const vertical = (x: number, y0: number, y1: number, kind?: 'funnel') => {
    if (y1 > y0) walls.push({ x0: x - halfWall, x1: x + halfWall, y0: y0 - halfWall, y1: y1 + halfWall, ...(kind ? { kind } : {}) })
  }
  const active = (row: number, col: number) => row >= 0 && row < rows && col >= 0 && col < cols && activeCells[row * cols + col] === 1
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      if (!active(row, col)) continue
      const cell = graph.cells[row * cols + col]
      // Interior boundaries are emitted once. Either side closing a passage wins.
      if (!active(row - 1, col)) {
        if (row === topY && col === sourceCol) {
          horizontal(col, col + 0.1, row); horizontal(col + 0.9, col + 1, row)
        } else horizontal(col, col + 1, row)
      }
      if (!active(row, col - 1)) vertical(col, row, row + 1)
      if (!active(row + 1, col) || cell.walls.bottom || graph.cells[(row + 1) * cols + col]?.walls.top) {
        if (row === bottomY - 1 && col === exitCol) {
          horizontal(col, col + 0.1, row + 1); horizontal(col + 0.9, col + 1, row + 1)
        } else horizontal(col, col + 1, row + 1)
      }
      if (!active(row, col + 1) || cell.walls.right || graph.cells[row * cols + col + 1]?.walls.left) vertical(col + 1, row, row + 1)
    }
  }
  // A physical funnel directs the real source stream into the existing entrance.
  // Thin AABB slices approximate the sloped bowl without changing the solver.
  const reservoirHalfWidth = Math.min(1.5, Math.max(0.7, (right - left) * 0.32))
  const reservoirLeft = inletX - reservoirHalfWidth
  const reservoirRight = inletX + reservoirHalfWidth
  const funnel: FluidFunnel = {
    mouthY: topY - 0.95, neckY: topY - 0.16,
    halfWidth: reservoirHalfWidth, neckHalfWidth: 0.4,
    sourceY: topY - 1.3, collarTopY: topY - 1.6,
  }
  const slices = 20
  for (let i = 0; i < slices; i++) {
    const y0 = funnel.mouthY + (funnel.neckY - funnel.mouthY) * i / slices
    const y1 = funnel.mouthY + (funnel.neckY - funnel.mouthY) * (i + 1) / slices
    const half = funnel.halfWidth + (funnel.neckHalfWidth - funnel.halfWidth) * (i + 1) / slices
    walls.push({ x0: reservoirLeft - halfWall, x1: inletX - half + halfWall, y0: y0 - 0.002, y1: y1 + 0.002, kind: 'funnel' })
    walls.push({ x0: inletX + half - halfWall, x1: reservoirRight + halfWall, y0: y0 - 0.002, y1: y1 + 0.002, kind: 'funnel' })
  }
  vertical(inletX - funnel.neckHalfWidth, funnel.neckY, topY, 'funnel')
  vertical(inletX + funnel.neckHalfWidth, funnel.neckY, topY, 'funnel')

  // A clear splash collar contains backpressure in a closed maze. Its top has a
  // genuine source port into the nozzle: no water is drawn through a solid cap.
  vertical(reservoirLeft, funnel.collarTopY, funnel.mouthY, 'funnel')
  vertical(reservoirRight, funnel.collarTopY, funnel.mouthY, 'funnel')
  horizontal(reservoirLeft, inletX - 0.5, funnel.collarTopY, 'funnel')
  horizontal(inletX + 0.5, reservoirRight, funnel.collarTopY, 'funnel')
  const sourceTop = funnel.collarTopY - 0.25
  vertical(inletX - 0.5, sourceTop, funnel.sourceY - 0.15, 'funnel')
  vertical(inletX + 0.5, sourceTop, funnel.sourceY - 0.15, 'funnel')
  horizontal(inletX - 0.5, inletX + 0.5, sourceTop, 'funnel')
  const radius = 0.07
  return {
    rows, cols, activeCells, activeCellCount, walls, funnel,
    inletX, inletY: funnel.sourceY, outletX, outletY: bottomY, topY, bottomY,
    minX: Math.min(left - 0.4, reservoirLeft - 0.3),
    maxX: Math.max(right + 0.4, reservoirRight + 0.3),
    minY: sourceTop - 0.2, maxY: bottomY + 2.2,
    radius, particleArea: (radius * 2) ** 2,
    capacity: Math.min(18_000, Math.max(320, Math.ceil(activeCellCount * 48 + reservoirHalfWidth * 150))),
  }
}
