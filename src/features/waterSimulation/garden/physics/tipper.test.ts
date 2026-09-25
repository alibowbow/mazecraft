import { describe, expect, it } from 'vitest'
import { TipperBody, tubeWater } from './tipper'
import { TIPPER_ARM, TIPPER_RADIUS, TIPPER_REST, TIPPER_TAIL, TIPPER_TIPPED } from '../mechanics'

const shape = { arm: TIPPER_ARM, tail: TIPPER_TAIL, radius: TIPPER_RADIUS, rest: TIPPER_REST, tipped: TIPPER_TIPPED }

describe('shishi-odoshi mechanics', () => {
  it('holds the water it is given, at a level surface', () => {
    for (const angle of [0.3, 0, -0.4]) for (const volume of [0.001, 0.004, 0.008]) {
      const water = tubeWater(shape, angle, volume)
      expect(Number.isFinite(water.surface)).toBe(true)
    }
    // The node keeps the water on the mouth side of the pivot: the fuller
    // the chamber, the harder its weight pulls the mouth down.
    const a = tubeWater(shape, TIPPER_REST, 0.001).torque, b = tubeWater(shape, TIPPER_REST, 0.004).torque
    expect(a).toBeLessThan(0)
    expect(b).toBeLessThan(a)
  })

  it('tips when full, pours, and knocks back onto its stone, over and over', () => {
    const tube = new TipperBody(shape)
    expect(tube.tipVolume).toBeGreaterThan(0.001)
    let tips = 0, knocks = 0, poured = 0, supplied = 0, wasTipped = false
    const dt = 1 / 120
    for (let n = 0; n < 120 * 40; n++) {
      const caught = 0.004 * dt * tube.catchShare(0.3)
      supplied += caught
      tube.step(dt, caught)
      poured += tube.poured
      const tipped = tube.angle < 0
      if (tipped && !wasTipped) tips++
      if (tube.knock > 0.5) knocks++
      wasTipped = tipped
    }
    expect(tips).toBeGreaterThanOrEqual(5)
    expect(knocks).toBeGreaterThanOrEqual(5)
    // Everything that went in came out, or is still in the tube.
    expect(Math.abs(supplied - poured - tube.volume)).toBeLessThan(1e-9)
  })
})
