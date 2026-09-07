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

  it('pours above the tapered funnel and leaves all emission lanes and the neck open', () => {
    const layout = buildFluidLayout(createTestProject({ mazeGraph: createEmptyGraph(4, 4) }))
    expect(layout.funnel.sourceY).toBe(layout.inletY)
    expect(layout.funnel.mouthY).toBeGreaterThan(layout.inletY)
    expect(layout.funnel.neckY).toBeGreaterThan(layout.funnel.mouthY)
    expect(layout.funnel.halfWidth).toBeGreaterThan(layout.funnel.neckHalfWidth)
    const inSolid = (x: number, y: number, clearance: number) => layout.walls.some(wall =>
      x > wall.x0 - clearance && x < wall.x1 + clearance
        && y > wall.y0 - clearance && y < wall.y1 + clearance,
    )
    // This is the solver's actual six-lane footprint, including particle radius.
    for (let lane = 0; lane < 6; lane++) {
      const x = layout.inletX + (lane - 2.5) * layout.radius * 2.12
      expect(inSolid(x, layout.inletY, layout.radius)).toBe(false)
      for (let y = layout.inletY; y <= layout.topY + 0.08; y += 0.02) {
        expect(inSolid(x, y, layout.radius)).toBe(false)
      }
    }
    for (let y = layout.inletY; y <= layout.topY; y += 0.02) {
      expect(inSolid(layout.inletX, y, layout.radius)).toBe(false)
    }
    const taperedY = (layout.funnel.mouthY + layout.funnel.neckY) * 0.5
    const outerX = layout.inletX + layout.funnel.halfWidth - 0.08
    expect(inSolid(outerX, taperedY, 0)).toBe(true)
    expect(layout.walls.some(wall => wall.kind === 'funnel')).toBe(true)
  })
})
