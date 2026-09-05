import { describe, expect, it } from 'vitest'
import { createEmptyGraph } from '../../../core/maze'
import { createTestProject } from '../../../test/projectFixture'
import { buildFluidLayout } from './layout'

describe('free surface maze geometry', () => {
  it('seals asymmetric passages and inactive cells and chooses mask boundary endpoints', () => {
    const graph = createEmptyGraph(4, 3)
    graph.cells.forEach(cell => { cell.active = cell.row === 1 || cell.row === 2 })
    graph.cells[4].active = false
    graph.cells[3].walls.right = false
    graph.cells[6].walls.right = false
    const layout = buildFluidLayout(createTestProject({ mazeGraph: graph }))
    expect(layout.topY).toBe(1)
    expect(layout.bottomY).toBe(3)
    expect(layout.inletY).toBeCloseTo(-0.3)
    expect(layout.outletY).toBe(3)
    expect(layout.activeCellCount).toBe(5)
    expect(layout.walls.some(wall => wall.x0 < 1 && wall.x1 > 1 && wall.y0 < 1.5 && wall.y1 > 1.5)).toBe(true)
    expect(layout.walls.some(wall => wall.x0 < 1 && wall.x1 > 1 && wall.y0 < 2.5 && wall.y1 > 2.5)).toBe(true)
    expect(layout.maxY).toBeGreaterThan(layout.outletY + 2)
  })

  it('caps particle memory for very large mazes while retaining sub-cell sampling', () => {
    const layout = buildFluidLayout(createTestProject({ mazeGraph: createEmptyGraph(150, 150) }))
    expect(layout.capacity).toBe(18_000)
    expect(layout.radius).toBeLessThan(0.1)
    expect(layout.activeCells).toHaveLength(22_500)
  })
})
