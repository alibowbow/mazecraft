import type { CellPosition, MazeGraph, WallDirection } from '../../core/maze/types'
import { cloneMazeGraph, getActiveCell, setWall } from '../../core/maze/graph'

export type EditorTool =
  | 'select'
  | 'open-wall'
  | 'close-wall'
  | 'set-start'
  | 'set-end'
  | 'collectible'
  | 'checkpoint'
  | 'eraser'
  | 'pan'
  | 'zoom'

export interface WallTarget {
  cell: CellPosition
  direction: WallDirection
  key: string
}

export const wallTargetAt = (
  graph: MazeGraph,
  row: number,
  col: number,
  localX: number,
  localY: number,
): WallTarget | null => {
  const cell = getActiveCell(graph, { row, col })
  if (!cell) return null
  const distances: Array<[WallDirection, number]> = [
    ['top', localY],
    ['right', 1 - localX],
    ['bottom', 1 - localY],
    ['left', localX],
  ]
  distances.sort((a, b) => a[1] - b[1])
  const direction = distances[0][0]
  const canonical =
    direction === 'left' && col > 0
      ? `${row}:${col - 1}:right`
      : direction === 'top' && row > 0
        ? `${row - 1}:${col}:bottom`
        : `${row}:${col}:${direction}`
  return { cell: { row, col }, direction, key: canonical }
}

export const applyWallTool = (
  graph: MazeGraph,
  target: WallTarget,
  tool: 'open-wall' | 'close-wall',
): MazeGraph => {
  const next = cloneMazeGraph(graph)
  setWall(next, target.cell, target.direction, tool === 'close-wall')
  return next
}

export class DragWallSession {
  private readonly touched = new Set<string>()

  apply(graph: MazeGraph, target: WallTarget, tool: 'open-wall' | 'close-wall') {
    if (this.touched.has(target.key)) return graph
    this.touched.add(target.key)
    return applyWallTool(graph, target, tool)
  }

  reset() {
    this.touched.clear()
  }
}
