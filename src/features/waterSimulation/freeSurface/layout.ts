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
  // Select ports on the same active-mask island. Walls remain independent:
  // an intentionally closed basin must still be rendered and simulated.
  const globalTopY = topY, globalBottomY = bottomY
  const active = (row: number, col: number) => row >= 0 && row < rows && col >= 0 && col < cols && activeCells[row * cols + col] === 1
  const islands: number[][] = []
  const islandAt = new Int32Array(activeCells.length).fill(-1)
  for (let index = 0; index < activeCells.length; index++) {
    if (!activeCells[index] || islandAt[index] !== -1) continue
    const island = [index], id = islands.length
    islandAt[index] = id
    for (let cursor = 0; cursor < island.length; cursor++) {
      const current = island[cursor], row = Math.floor(current / cols), col = current % cols
      for (const [nextRow, nextCol] of [[row - 1, col], [row + 1, col], [row, col - 1], [row, col + 1]]) {
        if (!active(nextRow, nextCol)) continue
        const next = nextRow * cols + nextCol
        if (islandAt[next] !== -1) continue
        islandAt[next] = id; island.push(next)
      }
    }
    islands.push(island)
  }
  const start = project.startCell
  const preferredIsland = active(start.row, start.col) ? islandAt[start.row * cols + start.col] : -1
  const selectedIsland = preferredIsland >= 0 ? preferredIsland : islands.reduce(
    (best, island, index) => island.length > islands[best].length ? index : best, 0,
  )
  topY = rows; bottomY = 0
  for (const index of islands[selectedIsland]) {
    const row = Math.floor(index / cols)
    topY = Math.min(topY, row); bottomY = Math.max(bottomY, row + 1)
  }
  const endpointCol = (row: number, preferred: number): number => {
    let selected = -1, distance = Infinity
    for (let col = 0; col < cols; col++) {
      if (islandAt[row * cols + col] === selectedIsland && Math.abs(col - preferred) < distance) {
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
  const mazeHalfWall = 0.075
  const horizontal = (x0: number, x1: number, y: number, kind?: 'funnel') => {
    const atEntrance = y === topY && x1 >= sourceCol && x0 <= sourceCol + 1
    const half = kind === 'funnel' || atEntrance ? halfWall : mazeHalfWall
    if (x1 > x0) walls.push({ x0: x0 - half, x1: x1 + half, y0: y - half, y1: y + half, ...(kind ? { kind } : {}) })
  }
  const vertical = (x: number, y0: number, y1: number, kind?: 'funnel') => {
    const atEntrance = y0 <= topY && y1 > topY && (x === sourceCol || x === sourceCol + 1)
    const half = kind === 'funnel' || atEntrance ? halfWall : mazeHalfWall
    if (y1 > y0) walls.push({ x0: x - half, x1: x + half, y0: y0 - half, y1: y1 + half, ...(kind ? { kind } : {}) })
  }
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      if (!active(row, col)) continue
      const cell = graph.cells[row * cols + col]
      // Interior boundaries are emitted once. Either side closing a passage wins.
      if (!active(row - 1, col)) {
        // Side walls already frame the entrance. Extra horizontal lips
        // narrowed the six-lane jet and backed water up into the funnel.
        if (row !== topY || col !== sourceCol) horizontal(col, col + 1, row)
      }
      if (!active(row, col - 1)) vertical(col, row, row + 1)
      if (!active(row + 1, col) || cell.walls.bottom || graph.cells[(row + 1) * cols + col]?.walls.top) {
        if (row === bottomY - 1 && col === exitCol) {
          horizontal(col, col + 0.075, row + 1); horizontal(col + 0.925, col + 1, row + 1)
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
    halfWidth: reservoirHalfWidth, neckHalfWidth: 0.5,
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
    minY: Math.min(globalTopY - 0.4, sourceTop - 0.2),
    maxY: Math.max(globalBottomY + 0.4, bottomY + 2.2),
    radius, particleArea: (radius * 2) ** 2,
    capacity: Math.min(18_000, Math.max(320, Math.ceil(activeCellCount * 48 + reservoirHalfWidth * 150))),
  }
}
