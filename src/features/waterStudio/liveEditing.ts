import { calculateMazeMetrics, generateMazeGraph, graphToMask, setWall, type MazeProject } from '../../core/maze'

/** Only internal shared edges can be edited; the mask and inlet stay intact. */
export function editWaterMazeWall(project: MazeProject, x: number, y: number): MazeProject | null {
  const graph = structuredClone(project.mazeGraph)
  const vertical = Math.abs(x - Math.round(x)) < Math.abs(y - Math.round(y))
  const row = vertical ? Math.floor(y) : Math.round(y) - 1
  const col = vertical ? Math.round(x) - 1 : Math.floor(x)
  const otherRow = row + (vertical ? 0 : 1), otherCol = col + (vertical ? 1 : 0)
  if (row < 0 || col < 0 || otherRow >= graph.rows || otherCol >= graph.cols) return null
  const cell = graph.cells[row * graph.cols + col], other = graph.cells[otherRow * graph.cols + otherCol]
  if (!cell?.active || !other?.active) return null
  const direction = vertical ? 'right' : 'bottom'
  setWall(graph, { row, col }, direction, !cell.walls[direction])
  return { ...project, mazeGraph: graph, updatedAt: new Date().toISOString(), creatorReplay: null }
}

/** Resolution controls passage density inside the original silhouette. Merely
 * subdividing old passages leaves the visible maze unchanged and adds fluid cost.
 * Reuse a stable source across slider changes so down/up never erodes its mask. */
export function resizeWaterMaze(project: MazeProject, rows: number, cols: number, source = project): MazeProject {
  if (!Number.isFinite(rows) || !Number.isFinite(cols)) throw new RangeError('미로 칸 수를 확인해 주세요.')
  rows = Math.max(4, Math.min(128, Math.round(rows))); cols = Math.max(4, Math.min(128, Math.round(cols)))
  if (rows === project.mazeGraph.rows && cols === project.mazeGraph.cols) return project
  const previous = source.mazeGraph
  if (rows === previous.rows && cols === previous.cols) return source
  const mask = Array.from({ length: rows * cols }, (_, i) => {
    const row = Math.min(previous.rows - 1, Math.floor((Math.floor(i / cols) + 0.5) * previous.rows / rows))
    const col = Math.min(previous.cols - 1, Math.floor((i % cols + 0.5) * previous.cols / cols))
    return previous.cells[row * previous.cols + col].active
  })
  if (!mask.some(Boolean)) throw new Error('이 해상도에서는 이미지 모양이 너무 작습니다. 칸 수를 늘려 주세요.')
  const graph = generateMazeGraph({ rows, cols, mask, seed: previous.seed, algorithm: previous.algorithm })
  const endpoint = (p: { row: number; col: number }) => {
    const mapped = { row: Math.min(rows - 1, Math.floor((p.row + 0.5) * rows / previous.rows)), col: Math.min(cols - 1, Math.floor((p.col + 0.5) * cols / previous.cols)) }
    if (graph.cells[mapped.row * cols + mapped.col].active) return mapped
    const nearest = graph.cells.filter(c => c.active).reduce((best, cell) =>
      Math.hypot(cell.row - mapped.row, cell.col - mapped.col) < Math.hypot(best.row - mapped.row, best.col - mapped.col) ? cell : best)
    return { row: nearest.row, col: nearest.col }
  }
  const startCell = endpoint(source.startCell), endCell = endpoint(source.endCell)
  return { ...project, grid: { ...project.grid, rows, cols }, mazeGraph: graph, mask: graphToMask(graph),
    startCell, endCell, mazeMetrics: calculateMazeMetrics(graph, startCell, endCell), creatorReplay: null, updatedAt: new Date().toISOString() }
}
