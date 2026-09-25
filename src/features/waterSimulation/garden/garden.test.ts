import { describe, expect, it } from 'vitest'
import { GARDEN_IDS, createGardenDesign } from './designs'
import { compileGarden, type GardenLayout } from './layout'
import { GardenSimulation } from './simulation'
import { tipperLowest } from './mechanics'
import { regionContains } from './polygon'
import { CHANNEL_BOTTOM, resample } from './geometry'

const grid = { rows: 8, cols: 8, activeCellCount: 64 }
/** Seconds of the shared run at the default supply. */
const JOURNEY = 150

interface Journey {
  simulation: GardenSimulation
  arrival: number
  firstWet: number[]
  highest: Float64Array
  tips: number[]
  turned: number[]
  lifted: number[]
  primes: number
  discharge: Float32Array
  massError: number
  injected: number
  escaped: number
}

const journeys = new Map<GardenLayout, Journey>()

/** One physical run per garden, shared by the tests that read it. */
function journey(layout: GardenLayout): Journey {
  const cached = journeys.get(layout)
  if (cached) return cached
  const simulation = new GardenSimulation(layout, grid)
  const firstWet = new Array(layout.pools.length).fill(Infinity)
  const highest = new Float64Array(layout.pools.length).fill(-Infinity)
  const tips = new Array(layout.tippers.length).fill(0), tipped = new Array(layout.tippers.length).fill(false)
  const turned = new Array(layout.wheels.length).fill(0), last = new Array(layout.wheels.length).fill(0)
  let arrival = -1, primes = 0, primed = false
  const lifted = new Array(layout.lifts.length).fill(0)
  for (let step = 0; step < JOURNEY * 4; step++) {
    simulation.advance(0.25, 1)
    const { diagnostics, garden } = simulation.snapshot()
    const time = (step + 1) * 0.25
    if (arrival < 0 && diagnostics.discharged > 1e-4) arrival = time
    garden.fronts.forEach((front, i) => { if (front >= 0) firstWet[i] = Math.min(firstWet[i], time) })
    garden.levels.forEach((level, i) => { if (garden.fronts[i] >= 0) highest[i] = Math.max(highest[i], level) })
    garden.tipperAngles.forEach((angle, i) => { if (angle < 0 && !tipped[i]) tips[i]++; tipped[i] = angle < 0 })
    garden.wheelAngles.forEach((angle, i) => {
      let delta = angle - last[i]
      delta = ((delta + Math.PI * 3) % (Math.PI * 2)) - Math.PI
      turned[i] += Math.abs(delta); last[i] = angle
    })
    garden.liftLoads.forEach((rate, i) => { lifted[i] = Math.max(lifted[i], rate) })
    const now = garden.siphonPrimed[0] > 0
    if (now && !primed) primes++
    primed = now
  }
  const end = simulation.snapshot()
  const run: Journey = {
    simulation, arrival, firstWet, highest, tips, turned, lifted, primes,
    discharge: Float32Array.from(end.garden.discharge), massError: end.diagnostics.massError,
    injected: end.diagnostics.injected, escaped: end.diagnostics.escaped,
  }
  journeys.set(layout, run)
  return run
}

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

describe.each(GARDEN_IDS)('%s water garden', { timeout: 120_000 }, id => {
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

  it('runs a long journey through chutes, a noria and a siphon', () => {
    for (const edge of layout.edges) if (edge.path) {
      const end = edge.path[edge.path.length - 1]
      if (edge.kind !== 'siphon') expect(end[2], `${edge.kind} ${edge.index} clears the rim it pours over`).toBeGreaterThan(layout.pools[edge.b].brim + 0.1)
    }
    for (const lift of layout.lifts) {
      const edge = layout.edges[lift.edge]
      expect(layout.pools[edge.b].floor, 'the noria lifts water uphill').toBeGreaterThan(layout.pools[edge.a].brim + 1)
      // The whole wheel, frames included, stands inside its own sump.
      const sump = layout.vessels[layout.pools[lift.pool].vessel]
      const [dx, dy] = lift.direction, reach = lift.width / 2 + 0.52
      for (const along of [-lift.radius, lift.radius]) for (const across of [-reach, reach]) {
        const corner: [number, number] = [lift.center[0] + dx * along - dy * across, lift.center[1] + dy * along + dx * across]
        expect(sump.footprint.some(region => regionContains(region, corner)), `noria ${lift.index} fits its sump`).toBe(true)
      }
    }
    // Troughs and chutes pass over every basin wall they cross, never through it.
    for (const edge of layout.edges) if (edge.path && edge.kind !== 'siphon') {
      const start = edge.path[0]
      for (const point of resample(edge.path, 0.1)) {
        if (Math.hypot(point[0] - start[0], point[1] - start[1]) < 0.3) continue
        for (const vessel of layout.vessels) if (vessel.footprint.some(region => regionContains(region, [point[0], point[1]]))) {
          expect(point[2] - CHANNEL_BOTTOM, `${edge.kind} ${edge.index} clears ${vessel.spec.name}`).toBeGreaterThan(vessel.top)
        }
      }
    }
  })

  it('conserves water and keeps it inside its walls', () => {
    const run = journey(layout)
    expect(run.massError / run.injected).toBeLessThan(1e-9)
    expect(run.escaped).toBe(0)
    layout.pools.forEach((pool, i) => expect(run.highest[i], `pool ${i} level`).toBeLessThan(pool.brim - 0.02))
    // Everything but the siphon runs continuously at the default supply.
    for (const edge of layout.edges) if (edge.kind !== 'siphon' && edge.kind !== 'drain') expect(run.discharge[edge.index], `${edge.kind} ${edge.index}`).toBeGreaterThan(0)
  })

  it('reaches the drain stage after stage, never stalling for long', () => {
    const run = journey(layout)
    expect(run.arrival).toBeGreaterThan(40)
    expect(run.arrival).toBeLessThan(JOURNEY)
    const times = run.firstWet.slice().sort((a, b) => a - b)
    expect(times.every(Number.isFinite), 'every pool takes water').toBe(true)
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1], `stage ${i}`).toBeLessThan(45)
  })

  it('moves its machinery with the water: tubes tip, wheels turn, the noria lifts, the siphon rushes', () => {
    const run = journey(layout)
    for (const tipper of layout.tippers) {
      expect(run.tips[tipper.index], `tipper ${tipper.index}`).toBeGreaterThanOrEqual(10)
      expect(tipperLowest(tipper), 'the tipped mouth stays out of the pool below').toBeGreaterThan(run.highest[tipper.pool] + 0.02)
    }
    layout.wheels.forEach((wheel, i) => {
      expect(run.turned[i], `wheel ${i} turns`).toBeGreaterThan(Math.PI)
      expect(wheel.z - wheel.radius, `wheel ${i} clears its bed`).toBeGreaterThan(wheel.base)
    })
    layout.lifts.forEach((_, i) => expect(run.lifted[i], `noria ${i} lifts`).toBeGreaterThan(0.005))
    if (layout.siphons.length) expect(run.primes, 'the siphon primes').toBeGreaterThanOrEqual(1)
  })

  it('starts dry and wets its channels progressively from the source', () => {
    const simulation = new GardenSimulation(layout, grid)
    const dry = simulation.snapshot()
    expect(dry.diagnostics.stored).toBe(0)
    expect(Array.from(dry.garden.fronts).every(front => front < 0)).toBe(true)
    const fronts: number[] = []
    for (let step = 0; step < 12; step++) {
      simulation.advance(0.25, 1)
      const state = simulation.snapshot()
      fronts.push(state.garden.fronts[layout.source.pool])
      // Water has not yet reached the receiving basin in the first seconds.
      const drainPool = layout.edges.find(edge => edge.kind === 'drain')!.a
      expect(state.garden.fronts[drainPool]).toBeLessThan(0)
    }
    // The first water is still falling from the source lip for a moment.
    expect(fronts[0]).toBeLessThan(0)
    const wet = fronts.findIndex(front => front > 0)
    expect(wet).toBeGreaterThan(0)
    expect(wet).toBeLessThan(6)
    for (let k = wet + 1; k < fronts.length; k++) expect(fronts[k]).toBeGreaterThanOrEqual(fronts[k - 1])
  })

  it('drains when the supply stops, then resets exactly', () => {
    const run = journey(layout)
    const { simulation } = run
    const flowing = simulation.snapshot().diagnostics
    for (let step = 0; step < 120; step++) simulation.advance(0.25, 0)
    const draining = simulation.snapshot().diagnostics
    expect(draining.injected).toBe(flowing.injected)
    expect(draining.stored).toBeLessThan(flowing.stored)
    expect(draining.massError / draining.injected).toBeLessThan(1e-9)
    simulation.reset()
    const reset = simulation.snapshot()
    expect(reset.diagnostics.time).toBe(0)
    expect(reset.diagnostics.stored).toBe(0)
  })
})
