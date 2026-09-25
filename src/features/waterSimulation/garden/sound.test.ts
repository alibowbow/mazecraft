import { describe, expect, it } from 'vitest'
import { compileCraft, craftTemplates } from './craft'
import { compileGarden } from './layout'
import { GardenSimulation } from './simulation'
import { GardenSoundAnalyzer } from './sound'

const grid = { rows: 8, cols: 8, activeCellCount: 64 }

describe('garden sound', () => {
  it('follows the physics: silent when dry, then running water, knocks and drips', () => {
    const design = compileCraft(craftTemplates().find(template => template.id === 'terraced')!.course).design!
    const layout = compileGarden(design)
    const simulation = new GardenSimulation(layout, grid)
    const analyzer = new GardenSoundAnalyzer(layout)
    const dry = analyzer.frame(simulation.snapshot().garden)
    expect(dry.stream).toBe(0)
    expect(dry.splash).toBe(0)
    let knocks = 0, drips = 0, loudest = 0, tips = 0, tipped = false
    for (let step = 0; step < 90 * 20; step++) {
      simulation.advance(1 / 20, 1)
      const state = simulation.snapshot().garden
      const frame = analyzer.frame(state)
      knocks += frame.knocks; drips += frame.drips / 20
      loudest = Math.max(loudest, frame.stream, frame.splash)
      const angle = state.tipperAngles[0]
      if (angle < 0 && !tipped) tips++
      tipped = angle < 0
    }
    expect(loudest).toBeGreaterThan(0.3)
    // One knock for every time the shishi-odoshi tipped and came back.
    expect(tips).toBeGreaterThan(3)
    expect(Math.abs(knocks - tips)).toBeLessThanOrEqual(1)
    expect(drips).toBeGreaterThan(5)
  }, 120_000)
})
