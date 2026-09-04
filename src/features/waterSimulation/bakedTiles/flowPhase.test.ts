import { describe, expect, it } from 'vitest'
import { WaterFlowPhase } from './flowPhase'

const wet = (x: number, y: number) => [0.5, x, y, 0]

describe('hydraulic atlas phase', () => {
  it('preserves phase across stopping, pause and reversal', () => {
    const phase = new WaterFlowPhase(1, 1)
    phase.update(wet(0, -0.12), 1)
    expect(phase.data[1]).toBeCloseTo(-0.75)
    phase.update(wet(0, 0), 2)
    expect(phase.data[1]).toBeCloseTo(-0.75)
    phase.update(wet(0, 0.12), 2)
    expect(phase.data[1]).toBeCloseTo(-0.75)
    phase.update(wet(0, 0.12), 3)
    expect(phase.data[1]).toBeCloseTo(0)
  })

  it('depends on traveled distance, not render frequency', () => {
    const one = new WaterFlowPhase(1, 1)
    const many = new WaterFlowPhase(1, 1)
    one.update(wet(0.04, -0.12), 1)
    for (let i = 1; i <= 120; i++) many.update(wet(0.04, -0.12), i / 120)
    expect(Array.from(many.data)).toEqual(Array.from(one.data))
    const slower = new WaterFlowPhase(1, 1)
    slower.update(wet(0.02, -0.06), 1)
    expect(slower.data[1]).toBeCloseTo(one.data[1] / 2)
  })

  it('clears stale travel when dry or restarted, and isolates cells', () => {
    const phase = new WaterFlowPhase(2, 1)
    phase.update([...wet(0.12, 0), ...wet(0, -0.12)], 1)
    phase.update([0, 0, 0, 0, ...wet(0, -0.12)], 2)
    expect(Array.from(phase.data.slice(0, 4))).toEqual([0, 0, 0, 0])
    expect(phase.data[5]).toBeCloseTo(-1.5)
    phase.update([...wet(0, 0), ...wet(0, 0)], 0)
    expect(Array.from(phase.data)).toEqual(Array(8).fill(0))
  })
})
