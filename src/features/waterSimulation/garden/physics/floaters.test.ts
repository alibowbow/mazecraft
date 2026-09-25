import { beforeAll, describe, expect, it } from 'vitest'
import { createGardenDesign } from '../designs'
import { compileGarden } from '../layout'
import { GardenSimulation } from '../simulation'
import { loadRapier, type Rapier } from './floaters'

const grid = { rows: 8, cols: 8, activeCellCount: 64 }
let rapier: Rapier

describe('floating bodies (Rapier)', () => {
  beforeAll(async () => { rapier = await loadRapier() })

  it('float at the water surface, drift with the current and stay inside the garden', () => {
    const layout = compileGarden(createGardenDesign('atelier'))
    const simulation = new GardenSimulation(layout, grid)
    // Let the water arrive first.
    for (let t = 0; t < 40; t += 0.25) simulation.advance(0.25, 1)
    simulation.enableFloaters(rapier)
    simulation.dropFloater('duck')
    simulation.dropFloater('block')
    const start = simulation.snapshot().garden.floaters.slice()
    expect(start.length).toBe(16)
    const level = simulation.world.poolLevel(layout.source.pool)
    let lowest = Infinity
    for (let t = 0; t < 20; t += 0.1) {
      simulation.advance(0.1, 1)
      const bodies = simulation.snapshot().garden.floaters
      for (let k = 0; k < bodies.length; k += 8) lowest = Math.min(lowest, bodies[k + 2])
    }
    const end = simulation.snapshot().garden.floaters
    expect(end.length).toBe(16)
    const { bounds } = layout
    for (let k = 0; k < end.length; k += 8) {
      // Still in the garden, not sunk to the ground or thrown out.
      expect(end[k]).toBeGreaterThan(bounds.minX - 1); expect(end[k]).toBeLessThan(bounds.maxX + 1)
      expect(end[k + 1]).toBeGreaterThan(bounds.minY - 1); expect(end[k + 1]).toBeLessThan(bounds.maxY + 1)
      expect(end[k + 2]).toBeGreaterThan(0.05)
    }
    // The duck rode the water: it settled near the surface and moved with the current.
    expect(Math.abs(end[2] - (simulation.world.poolLevel(layout.source.pool)))).toBeLessThan(1.5)
    expect(Math.hypot(end[0] - start[0], end[1] - start[1])).toBeGreaterThan(0.2)
    expect(lowest).toBeGreaterThan(Math.min(level, 0) - 0.5)
    simulation.dispose()
  }, 120_000)
})
