import { describe, expect, it } from 'vitest'
import { createWaterStudioProject } from '../../waterStudio/presets'
import { buildFluidLayout } from './layout'
import { CascadeSimulation } from './cascadeSimulation'
import { CASCADE_AREAS, CASCADE_INITIAL_DEPTH, CASCADE_SILL_DEPTH, CASCADE_WALL_HEIGHT } from './cascadeTypes'

const createCascade = () => new CascadeSimulation(buildFluidLayout(createWaterStudioProject('atelier', 'atelier-01')))
const advance = (simulation: CascadeSimulation, seconds: number, inflow: number) => {
  for (let frame = 0; frame < seconds * 4; frame++) simulation.advance(0.25, inflow)
}

describe('conservative three-basin cascade', () => {
  it('starts all waterfalls from accounted initial water above their real sills', () => {
    const simulation = createCascade(), snapshot = simulation.snapshot()
    for (const depth of snapshot.cascade.depths) expect(depth).toBeCloseTo(CASCADE_INITIAL_DEPTH, 12)
    expect(snapshot.initialStoredVolume).toBeCloseTo(CASCADE_AREAS.reduce((sum, area) => sum + area * CASCADE_INITIAL_DEPTH, 0), 12)
    expect(snapshot.diagnostics.stored).toBe(snapshot.initialStoredVolume)
    expect(snapshot.diagnostics.injected).toBe(0)
    expect(snapshot.diagnostics.discharged).toBe(0)
    expect(snapshot.diagnostics.massError).toBeLessThan(1e-12)
    for (const rate of snapshot.cascade.discharge) expect(rate).toBeGreaterThan(0.15)
    expect(snapshot.diagnostics.wetCells).toBe(98)
    expect(snapshot.depth.filter(depth => depth === 0)).toHaveLength(2)
  })

  it.each([0.1, 0.65, 1, 2.5])('conserves source, stored water and terminal discharge at inflow %s', inflow => {
    const simulation = createCascade()
    advance(simulation, 600, inflow)
    const snapshot = simulation.snapshot(), d = snapshot.diagnostics
    expect(d.injected).toBeGreaterThan(0)
    expect(d.discharged).toBeGreaterThan(0)
    expect(d.escaped).toBe(0)
    expect(d.stored).toBeCloseTo(snapshot.initialStoredVolume + d.injected - d.discharged, 9)
    expect(d.massError).toBeLessThan(1e-9)
    expect(snapshot.sourceRate).toBeCloseTo(0.42 * inflow, 8)
    for (const rate of snapshot.cascade.discharge) expect(rate).toBeGreaterThan(0.001)
    for (const depth of snapshot.cascade.depths) {
      expect(depth).toBeGreaterThanOrEqual(CASCADE_SILL_DEPTH)
      expect(depth).toBeLessThan(CASCADE_WALL_HEIGHT)
    }
  })

  it('passes a supply increase downstream instead of changing all basins together', () => {
    const simulation = createCascade(), initial = simulation.snapshot().cascade
    simulation.advance(0.25, 2.5)
    const snapshot = simulation.snapshot()
    expect(snapshot.cascade.depths[0] - initial.depths[0]).toBeGreaterThan(0.01)
    expect(snapshot.cascade.depths[1] - initial.depths[1]).toBeLessThan(0.001)
    expect(snapshot.cascade.depths[2] - initial.depths[2]).toBeLessThan(0.00001)
    expect(snapshot.cascade.discharge[0]).toBeGreaterThan(snapshot.cascade.discharge[1])
    expect(snapshot.cascade.discharge[1]).toBeGreaterThanOrEqual(snapshot.cascade.discharge[2])
    expect(snapshot.diagnostics.massError).toBeLessThan(1e-9)
  })

  it('drains after the source stops while retaining water below each spill lip', () => {
    const simulation = createCascade()
    advance(simulation, 60, 0.65)
    const before = simulation.snapshot()
    advance(simulation, 1200, 0)
    const after = simulation.snapshot()
    expect(after.sourceRate).toBe(0)
    expect(after.diagnostics.injected).toBe(before.diagnostics.injected)
    expect(after.diagnostics.discharged).toBeGreaterThan(before.diagnostics.discharged)
    expect(after.diagnostics.stored).toBeLessThan(before.diagnostics.stored)
    for (let tier = 0; tier < 3; tier++) {
      expect(after.cascade.depths[tier]).toBeGreaterThanOrEqual(CASCADE_SILL_DEPTH)
      expect(after.cascade.depths[tier]).toBeLessThan(CASCADE_SILL_DEPTH + 0.006)
      expect(after.cascade.discharge[tier]).toBeLessThan(before.cascade.discharge[tier] * 0.01)
    }
    expect(after.diagnostics.massError).toBeLessThan(1e-9)
  })

  it('reserves freeboard even at minimum wall height and maximum inflow', () => {
    const simulation = createCascade()
    simulation.setWallHeight(0.55)
    advance(simulation, 600, 2.5)
    const snapshot = simulation.snapshot()
    for (const depth of snapshot.cascade.depths) expect(depth).toBeLessThanOrEqual(CASCADE_WALL_HEIGHT * 0.55 - 0.04 + 1e-10)
    expect(snapshot.diagnostics.escaped).toBe(0)
    expect(snapshot.cascade.discharge[2]).toBeGreaterThan(0.2)
    expect(snapshot.diagnostics.massError).toBeLessThan(1e-9)
  })

  it('accounts for displaced water when lowering filled walls and resets the complete state', () => {
    const simulation = createCascade()
    advance(simulation, 600, 2.5)
    simulation.setWallHeight(0.55)
    const lowered = simulation.snapshot()
    expect(lowered.diagnostics.escaped).toBeGreaterThan(0)
    for (const depth of lowered.cascade.depths) expect(depth).toBeLessThanOrEqual(CASCADE_WALL_HEIGHT * 0.55 + 1e-10)
    expect(lowered.diagnostics.massError).toBeLessThan(1e-9)
    simulation.reset()
    const reset = simulation.snapshot()
    expect(reset.cascade.time).toBe(0)
    for (const depth of reset.cascade.depths) expect(depth).toBeCloseTo(CASCADE_INITIAL_DEPTH, 12)
    expect(reset.sourceRate).toBe(0)
    expect(reset.diagnostics.injected).toBe(0)
    expect(reset.diagnostics.discharged).toBe(0)
    expect(reset.diagnostics.escaped).toBe(0)
    expect(reset.diagnostics.massError).toBeLessThan(1e-12)
  })

  it('accepts measured basin areas, reuses compatibility buffers and bounds elapsed catch-up', () => {
    const layout = buildFluidLayout(createWaterStudioProject('atelier', 'atelier-01'))
    const simulation = new CascadeSimulation(layout, [8, 12, 9]), initial = simulation.snapshot()
    simulation.advance(Number.NaN, 1)
    simulation.advance(-1, 1)
    expect(simulation.snapshot().cascade.time).toBe(0)
    simulation.advance(40, 0.65)
    const snapshot = simulation.snapshot()
    expect(snapshot.cascade.time).toBeCloseTo(0.5, 10)
    expect(snapshot.initialStoredVolume).toBeCloseTo(29 * CASCADE_INITIAL_DEPTH, 12)
    expect(snapshot.depth).toBe(initial.depth)
    expect(snapshot.velocity).toBe(initial.velocity)
    expect(snapshot.connections).toBe(initial.connections)
    for (let cell = 0; cell < layout.activeCells.length; cell++) {
      expect(snapshot.velocity[cell * 2]).toBe(0)
      if (layout.activeCells[cell]) expect(snapshot.velocity[cell * 2 + 1]).toBeGreaterThan(0)
      else expect(snapshot.connections[cell]).toBe(255)
    }
    expect(snapshot.diagnostics.massError).toBeLessThan(1e-9)
  })
})
