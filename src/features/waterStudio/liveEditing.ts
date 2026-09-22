import { createEmptyGraph, graphToMask, openPassage, setWall, type MazeProject } from '../../core/maze'

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

/** Resample the existing silhouette and passages, rather than generating an
 * unrelated maze each time its resolution changes. */
export function resizeWaterMaze(project: MazeProject, rows: number, cols: number): MazeProject {
  rows = Math.max(4, Math.min(128, Math.round(rows))); cols = Math.max(4, Math.min(128, Math.round(cols)))
  const previous = project.mazeGraph
  const oldCell = (r: number, c: number) => ({ row: Math.min(previous.rows - 1, Math.floor((r + 0.5) * previous.rows / rows)), col: Math.min(previous.cols - 1, Math.floor((c + 0.5) * previous.cols / cols)) })
  const mask = Array.from({ length: rows * cols }, (_, i) => {
    const p = oldCell(Math.floor(i / cols), i % cols)
    return previous.cells[p.row * previous.cols + p.col].active
  })
  const graph = createEmptyGraph(rows, cols, { mask, seed: previous.seed, algorithm: previous.algorithm })
  for (const cell of graph.cells) if (cell.active) {
    for (const [dr, dc] of [[0, 1], [1, 0]]) {
      const r = cell.row + dr, c = cell.col + dc
      if (r >= rows || c >= cols || !graph.cells[r * cols + c].active) continue
      const a = oldCell(cell.row, cell.col), b = oldCell(r, c)
      let clear = true
      for (let rr = a.row; rr <= b.row; rr++) for (let cc = a.col; cc <= b.col; cc++) {
        const old = previous.cells[rr * previous.cols + cc]
        if (!old.active || (cc < b.col && old.walls.right) || (rr < b.row && old.walls.bottom)) clear = false
      }
      if (clear) openPassage(graph, cell, { row: r, col: c })
    }
  }
  const endpoint = (p: { row: number; col: number }) => {
    const mapped = { row: Math.min(rows - 1, Math.floor((p.row + 0.5) * rows / previous.rows)), col: Math.min(cols - 1, Math.floor((p.col + 0.5) * cols / previous.cols)) }
    return graph.cells[mapped.row * cols + mapped.col].active ? mapped : graph.cells.filter(c => c.active).sort((a, b) => Math.hypot(a.row - mapped.row, a.col - mapped.col) - Math.hypot(b.row - mapped.row, b.col - mapped.col))[0]
  }
  if (!mask.some(Boolean)) throw new Error('이 해상도에서는 이미지 모양이 너무 작습니다. 칸 수를 늘려 주세요.')
  return { ...project, grid: { ...project.grid, rows, cols }, mazeGraph: graph, mask: graphToMask(graph),
    startCell: endpoint(project.startCell), endCell: endpoint(project.endCell), creatorReplay: null, updatedAt: new Date().toISOString() }
}
