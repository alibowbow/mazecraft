import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { displayOf, PostGovernor, sceneColorFor } from './post'

describe('garden post pipeline', () => {
  it('finds the scene colour that the grade shows as each page backdrop', () => {
    for (const hex of ['#efe5d6', '#f0dcc4', '#ebe8e3', '#fafafa', '#20303a', '#4b7a3c']) {
      for (const exposure of [1, 1.02]) {
        const display = new THREE.Color(hex)
        const scene = sceneColorFor(display, exposure)
        const shown = displayOf([scene.r, scene.g, scene.b], exposure)
        const target = display.clone().convertLinearToSRGB()
        // Within one 8-bit step of the authored colour.
        expect(Math.abs(shown[0] - target.r)).toBeLessThan(1 / 255)
        expect(Math.abs(shown[1] - target.g)).toBeLessThan(1 / 255)
        expect(Math.abs(shown[2] - target.b)).toBeLessThan(1 / 255)
      }
    }
  })

  it('is monotonic, so the inversion is unique', () => {
    let previous = -1
    for (let value = 0; value <= 4; value += 0.01) {
      const [shown] = displayOf([value, value, value], 1)
      expect(shown).toBeGreaterThanOrEqual(previous - 1e-9)
      previous = shown
    }
  })

  it('steps down only after frames stay slow, ignoring idle gaps', () => {
    const governor = new PostGovernor()
    let now = 0, drops = 0
    for (let frame = 0; frame < 600; frame++) { now += 16; if (governor.frame(now)) drops++ }
    expect(drops).toBe(0)
    // A paused scene redraws rarely: long gaps are not slow frames.
    for (let frame = 0; frame < 50; frame++) { now += 5000; if (governor.frame(now)) drops++ }
    expect(drops).toBe(0)
    for (let frame = 0; frame < 400; frame++) { now += 60; if (governor.frame(now)) drops++ }
    expect(drops).toBeGreaterThanOrEqual(1)
    expect(drops).toBeLessThanOrEqual(3)
  })
})
