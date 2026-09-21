import { describe, expect, it } from 'vitest'
import { createWaterStudioProject } from '../../waterStudio/presets'
import { buildFluidLayout } from './layout'
import { FreeSurfaceSolver } from './solver'

describe('studio default physical flow', () => {
  it.each([0.65, 2.5])('keeps the funnel jet visible and drains the cascade at %s× supply', supply => {
    const layout = buildFluidLayout(createWaterStudioProject('cascade', 'atelier-01'))
    const solver = new FreeSurfaceSolver(layout)
    for (let second = 0; second < 6; second++) {
      solver.step(1, supply)
      const state = solver.snapshot()
      let standingAboveBowl = 0
      for (let i = 0; i < state.count; i++) {
        const y = state.positions[i * 2 + 1]
        const speed = Math.hypot(state.velocities[i * 2], state.velocities[i * 2 + 1])
        if (y > layout.funnel.sourceY && y < layout.funnel.mouthY && speed < 1.5) standingAboveBowl++
      }
      expect(standingAboveBowl).toBeLessThanOrEqual(3)
      expect(state.diagnostics.massError).toBe(0)
      expect(state.diagnostics.escaped).toBe(0)
    }
    const flowing = solver.snapshot().diagnostics
    expect(flowing.reachedExit).toBe(true)
    expect(flowing.discharged).toBeGreaterThan(0)
    solver.step(2, 0)
    const draining = solver.snapshot().diagnostics
    expect(draining.injected).toBe(flowing.injected)
    expect(draining.discharged).toBeGreaterThan(flowing.discharged)
    expect(draining.stored).toBeLessThan(flowing.stored)
    expect(draining.massError).toBe(0)
    expect(draining.escaped).toBe(0)
  }, 15_000)
})
