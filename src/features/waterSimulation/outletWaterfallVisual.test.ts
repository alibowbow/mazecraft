import { describe, expect, it } from 'vitest'
import {
  advanceOutletWaterfallVisualState,
  createOutletWaterfallGeometry,
  createOutletWaterfallVisualState,
  resetOutletWaterfallVisualState,
  resolveOutletTargetStrength,
  updateOutletWaterfallGeometry,
} from './outletWaterfallVisual'

describe('outlet waterfall visual state', () => {
  it('maps discharge continuously into a bounded visual strength', () => {
    expect(resolveOutletTargetStrength(0)).toBe(0)
    expect(resolveOutletTargetStrength(0.003)).toBeGreaterThan(0)
    expect(resolveOutletTargetStrength(0.006)).toBeGreaterThan(
      resolveOutletTargetStrength(0.003),
    )
    expect(resolveOutletTargetStrength(0.012)).toBe(1)
    expect(resolveOutletTargetStrength(0.05)).toBe(1)
  })

  it('smooths snapshot jumps and grows stream length independently', () => {
    const state = createOutletWaterfallVisualState()
    advanceOutletWaterfallVisualState(state, {
      targetStrength: 1,
      deltaSeconds: 1 / 60,
    })
    expect(state.strength).toBeGreaterThan(0)
    expect(state.strength).toBeLessThan(1)
    expect(state.frontProgress).toBeGreaterThan(0)
    expect(state.frontProgress).toBeLessThan(0.1)

    for (let frame = 0; frame < 120; frame += 1) {
      advanceOutletWaterfallVisualState(state, {
        targetStrength: 1,
        deltaSeconds: 1 / 60,
      })
    }
    expect(state.strength).toBeGreaterThan(0.99)
    expect(state.frontProgress).toBe(1)

    const beforeFall = state.strength
    advanceOutletWaterfallVisualState(state, {
      targetStrength: 0,
      deltaSeconds: 1 / 60,
    })
    expect(state.strength).toBeGreaterThan(0)
    expect(state.strength).toBeLessThan(beforeFall)
  })

  it('pauses exactly and resets all visual history', () => {
    const state = createOutletWaterfallVisualState()
    advanceOutletWaterfallVisualState(state, {
      targetStrength: 0.8,
      deltaSeconds: 0.1,
    })
    const snapshot = { ...state }
    advanceOutletWaterfallVisualState(state, {
      targetStrength: 1,
      deltaSeconds: 0.1,
      paused: true,
    })
    expect(state).toEqual(snapshot)
    resetOutletWaterfallVisualState(state)
    expect(state).toEqual({
      strength: 0,
      frontProgress: 0,
      timeSeconds: 0,
    })
  })
})

describe('outlet waterfall ribbon geometry', () => {
  it('creates a finite subdivided sheet and updates it without blocks', () => {
    const geometry = createOutletWaterfallGeometry('low')
    const state = createOutletWaterfallVisualState()
    state.strength = 0.72
    state.frontProgress = 1
    state.timeSeconds = 1.25
    updateOutletWaterfallGeometry(geometry, {
      dropHeight: 1.58,
      state,
    })

    const position = geometry.getAttribute('position')
    expect(position.count).toBe(30 * 5)
    for (let index = 0; index < position.count; index += 1) {
      expect(Number.isFinite(position.getX(index))).toBe(true)
      expect(Number.isFinite(position.getY(index))).toBe(true)
      expect(Number.isFinite(position.getZ(index))).toBe(true)
    }
    const topY = position.getY(0)
    const bottomY = position.getY(position.count - 1)
    expect(topY).toBeCloseTo(0)
    expect(bottomY).toBeCloseTo(-1.58)
    geometry.dispose()
  })
})
