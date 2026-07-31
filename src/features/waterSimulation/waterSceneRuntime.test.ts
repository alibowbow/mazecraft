import { describe, expect, it } from 'vitest'
import {
  resolveFallingJetContactGap,
  sampleFallingJetCenterOffset,
} from './waterSceneRuntime'

describe('falling-water spatial continuity', () => {
  it('keeps the moving terminal ring intersecting the unified surface', () => {
    for (let elapsedMs = 0; elapsedMs <= 12_000; elapsedMs += 37) {
      const terminal = sampleFallingJetCenterOffset(elapsedMs, 1)
      expect(Number.isFinite(terminal.x)).toBe(true)
      expect(Number.isFinite(terminal.z)).toBe(true)
      expect(Math.abs(terminal.x)).toBeLessThan(0.07)
      expect(resolveFallingJetContactGap(elapsedMs)).toBeLessThanOrEqual(0.001)
    }
  })

  it('moves continuously from the nozzle depth to the contact depth', () => {
    const elapsedMs = 1_240
    const top = sampleFallingJetCenterOffset(elapsedMs, 0)
    const middle = sampleFallingJetCenterOffset(elapsedMs, 0.5)
    const terminal = sampleFallingJetCenterOffset(elapsedMs, 1)

    expect(top.z).toBeGreaterThan(middle.z)
    expect(middle.z).toBeGreaterThan(terminal.z)
  })
})
