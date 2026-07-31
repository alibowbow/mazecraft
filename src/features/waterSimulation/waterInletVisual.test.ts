import { describe, expect, it } from 'vitest'
import {
  getWaterFlowElapsedMs,
  resolveWaterInletLayout,
  sampleWaterHandoff,
  sampleWaterInlet,
  WATER_INLET_IMPACT_MS,
} from './waterInletVisual'

describe('water inlet visual timing', () => {
  it('keeps a clearly readable free-fall gap above a top-row entrance', () => {
    const layout = resolveWaterInletLayout(10, 4.5)

    expect(layout.nozzleY).toBeGreaterThan(layout.boardTopY + 1.5)
    expect(layout.dropHeight).toBeGreaterThan(2)
    expect(layout.impactY).toBe(4.5)
    expect(layout.reservoirY).toBeGreaterThan(layout.nozzleY)
  })

  it('lets the falling stream reach the board before maze flow begins', () => {
    expect(sampleWaterInlet(0, 10_000).state).toBe('off')
    expect(sampleWaterInlet(240, 10_000).state).toBe('falling')
    expect(
      sampleWaterInlet(WATER_INLET_IMPACT_MS - 1, 10_000).impactStrength,
    ).toBe(0)
    expect(
      sampleWaterInlet(WATER_INLET_IMPACT_MS - 1, 10_000).state,
    ).toBe('falling')
    expect(
      sampleWaterInlet(WATER_INLET_IMPACT_MS + 100, 10_000).state,
    ).toBe('impact')
    expect(getWaterFlowElapsedMs(WATER_INLET_IMPACT_MS - 1)).toBe(0)
    expect(getWaterFlowElapsedMs(WATER_INLET_IMPACT_MS + 250)).toBe(250)
  })

  it('ramps, holds, then fades without invalid values', () => {
    const samples = [0, 100, 400, 1_000, 5_000, 9_700, 10_000].map((time) =>
      sampleWaterInlet(time, 10_000),
    )

    for (const sample of samples) {
      expect(sample.strength).toBeGreaterThanOrEqual(0)
      expect(sample.strength).toBeLessThanOrEqual(1)
      expect(sample.frontProgress).toBeGreaterThanOrEqual(0)
      expect(sample.frontProgress).toBeLessThanOrEqual(1)
      expect(sample.impactStrength).toBeGreaterThanOrEqual(0)
      expect(sample.impactStrength).toBeLessThanOrEqual(1)
    }
    expect(samples.at(-1)?.state).toBe('off')
  })

  it('couples the jet, impact energy, and channel surface in one handoff', () => {
    expect(
      sampleWaterHandoff(WATER_INLET_IMPACT_MS - 1, 10_000).surfaceGate,
    ).toBe(0)

    for (let offset = 4; offset <= 240; offset += 4) {
      const handoff = sampleWaterHandoff(
        WATER_INLET_IMPACT_MS + offset,
        10_000,
      )
      expect(handoff.strength).toBeGreaterThan(0.8)
      expect(handoff.impactStrength).toBeGreaterThan(0)
      expect(handoff.surfaceGate).toBeGreaterThan(0)
    }
  })

  it('rejects invalid scene dimensions', () => {
    expect(() => resolveWaterInletLayout(0, 0)).toThrow(RangeError)
    expect(() => resolveWaterInletLayout(10, Number.NaN)).toThrow(RangeError)
  })

  it('keeps a masked entrance jet compact even when inactive rows sit above it', () => {
    const layout = resolveWaterInletLayout(100, 12.5)

    expect(layout.dropHeight).toBeGreaterThanOrEqual(2.08)
    expect(layout.dropHeight).toBeLessThanOrEqual(2.65)
    expect(layout.nozzleY).toBeCloseTo(layout.impactY + layout.dropHeight)
    expect(layout.nozzleY).toBeLessThan(layout.boardTopY)
  })
})
