import { describe, expect, it } from 'vitest'
import { GARDEN_IDS, createGardenDesign } from './designs'
import { compileGarden, type GardenLayout } from './layout'
import { GardenSimulation } from './simulation'

const grid = { rows: 8, cols: 8, activeCellCount: 64 }

function reachable(layout: GardenLayout, from: number, forward: boolean): Set<number> {
  const seen = new Set([from]), queue = [from]
  while (queue.length) {
    const pool = queue.shift()!
    for (const edge of layout.edges) {
      const [here, there] = forward ? [edge.a, edge.b] : [edge.b, edge.a]
      if (here === pool && there >= 0 && !seen.has(there)) { seen.add(there); queue.push(there) }
    }
  }
  return seen
}

describe.each(GARDEN_IDS)('%s water garden', id => {
  const layout = compileGarden(createGardenDesign(id))

  it('compiles into connected pools that all drain to the receiving basin', () => {
    expect(layout.pools.length).toBeGreaterThanOrEqual(3)
    const downstream = reachable(layout, layout.source.pool, true)
    expect(downstream.size, 'every pool is fed from the source').toBe(layout.pools.length)
    const drains = layout.edges.filter(edge => edge.kind === 'drain')
    expect(drains).toHaveLength(1)
    const upstream = reachable(layout, drains[0].a, false)
    expect(upstream.size, 'every pool reaches the drain').toBe(layout.pools.length)
    for (const pool of layout.pools) {
      expect(pool.area).toBeGreaterThan(0.3)
      expect(pool.brim - pool.floor).toBeGreaterThan(0.25)
    }
  })

  it('places every weir above its upstream bed and every spout over a lower basin', () => {
    for (const edge of layout.edges) {
      const up = layout.pools[edge.a]
      expect(edge.crest, `${edge.kind} ${edge.index}`).toBeGreaterThan(up.floor + (edge.kind === 'drain' ? 0.1 : 0.01))
      expect(edge.crest).toBeLessThan(up.brim - (edge.kind === 'drain' ? 0.2 : 0.3))
      if (edge.kind === 'spout') {
        const down = layout.pools[edge.b]
        expect(down.vessel).not.toBe(up.vessel)
        expect(down.brim, 'the receiving rim stays below the spout slab').toBeLessThan(edge.crest - 0.15)
      }
    }
    expect(layout.source.lipZ).toBeGreaterThan(layout.pools[layout.source.pool].brim + 0.2)
  })

  it.each([0.1, 0.65, 1, 2.5])('conserves water and stays inside its walls at %s× supply', inflow => {
    const simulation = new GardenSimulation(layout, grid)
    for (let second = 0; second < (inflow < 0.5 ? 1500 : 600); second++) simulation.advance(1, inflow)
    const state = simulation.snapshot()
    const available = state.initialStoredVolume + state.diagnostics.injected
    expect(state.diagnostics.massError / available).toBeLessThan(1e-9)
    expect(state.diagnostics.escaped).toBe(0)
    expect(state.diagnostics.reachedExit).toBe(true)
    layout.pools.forEach((pool, i) => {
      expect(state.garden.levels[i], `pool ${i} level`).toBeLessThan(pool.brim - 0.02)
      expect(state.garden.levels[i]).toBeGreaterThan(pool.floor + 0.02)
    })
    // Near steady state the drain returns what the source supplies.
    expect(state.diagnostics.outletRate).toBeGreaterThan(state.sourceRate * 0.9)
    for (const edge of layout.edges) expect(state.garden.discharge[edge.index], `${edge.kind} ${edge.index}`).toBeGreaterThan(0)
  })

  it('starts dry and wets its channels progressively from the source', () => {
    const simulation = new GardenSimulation(layout, grid)
    const dry = simulation.snapshot()
    expect(dry.diagnostics.stored).toBe(0)
    expect(Array.from(dry.garden.fronts).every(front => front < 0)).toBe(true)
    const fronts: number[] = []
    for (let step = 0; step < 8; step++) {
      simulation.advance(0.25, 1)
      const state = simulation.snapshot()
      fronts.push(state.garden.fronts[layout.source.pool])
      // Water has not yet reached the receiving basin in the first seconds.
      const drainPool = layout.edges.find(edge => edge.kind === 'drain')!.a
      expect(state.garden.fronts[drainPool]).toBeLessThan(0)
    }
    expect(fronts[0]).toBeGreaterThan(0)
    for (let k = 1; k < fronts.length; k++) expect(fronts[k]).toBeGreaterThanOrEqual(fronts[k - 1])
  })

  it('drains towards the weir crests when the supply stops, then resets exactly', () => {
    const simulation = new GardenSimulation(layout, grid)
    for (let second = 0; second < 600; second++) simulation.advance(1, 0.65)
    const flowing = simulation.snapshot()
    const flowingLevels = Array.from(flowing.garden.levels)
    for (let second = 0; second < 180; second++) simulation.advance(1, 0)
    const draining = simulation.snapshot()
    expect(draining.diagnostics.injected).toBe(flowing.diagnostics.injected)
    expect(draining.diagnostics.stored).toBeLessThan(flowing.diagnostics.stored)
    expect(draining.diagnostics.massError).toBeLessThan(1e-9)
    layout.pools.forEach((_, i) => expect(draining.garden.levels[i]).toBeLessThanOrEqual(flowingLevels[i] + 1e-9))
    simulation.reset()
    const reset = simulation.snapshot()
    expect(reset.diagnostics.time).toBe(0)
    expect(reset.diagnostics.stored).toBe(0)
  })
})
