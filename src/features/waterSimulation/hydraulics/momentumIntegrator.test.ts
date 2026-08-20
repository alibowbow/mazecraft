import { describe, expect, it } from 'vitest'
import {
  integrateEdgeMomentumImplicit,
  resolveShallowWaterResistanceMultiplier,
  resolveShallowWaterVelocityLimit,
} from './solver'

describe('implicit hydraulic edge momentum', () => {
  it('damps drag without reversing the discharge sign', () => {
    const positive = integrateEdgeMomentumImplicit({
      discharge: 2,
      acceleration: 0,
      linearDamping: 1,
      quadraticResistance: 10,
      deltaSeconds: 1,
    })
    const negative = integrateEdgeMomentumImplicit({
      discharge: -2,
      acceleration: 0,
      linearDamping: 1,
      quadraticResistance: 10,
      deltaSeconds: 1,
    })
    expect(positive).toBeGreaterThan(0)
    expect(positive).toBeLessThan(2)
    expect(negative).toBeLessThan(0)
    expect(negative).toBeCloseTo(-positive, 12)
  })

  it('remains finite under a large pressure impulse and drag coefficient', () => {
    const discharge = integrateEdgeMomentumImplicit({
      discharge: 0.1,
      acceleration: 400,
      linearDamping: 8,
      quadraticResistance: 25_000,
      deltaSeconds: 0.5,
    })
    expect(Number.isFinite(discharge)).toBe(true)
    expect(discharge).toBeGreaterThan(0)
  })

  it('rejects invalid coefficients and time steps', () => {
    expect(() =>
      integrateEdgeMomentumImplicit({
        discharge: 0,
        acceleration: 0,
        linearDamping: -1,
        quadraticResistance: 0,
        deltaSeconds: 1 / 120,
      }),
    ).toThrow(/linearDamping/)
    expect(() =>
      integrateEdgeMomentumImplicit({
        discharge: 0,
        acceleration: 0,
        linearDamping: 0,
        quadraticResistance: 0,
        deltaSeconds: 0,
      }),
    ).toThrow(/deltaSeconds/)
  })
})

describe('wetting and drying stabilization', () => {
  it('raises the local velocity ceiling continuously with depth', () => {
    const dry = resolveShallowWaterVelocityLimit(9.81, 0, 7.5)
    const thin = resolveShallowWaterVelocityLimit(9.81, 0.01, 7.5)
    const channel = resolveShallowWaterVelocityLimit(9.81, 0.18, 7.5)
    const deep = resolveShallowWaterVelocityLimit(9.81, 10, 7.5)
    expect(dry).toBe(0)
    expect(thin).toBeGreaterThan(dry)
    expect(channel).toBeGreaterThan(thin)
    expect(deep).toBe(7.5)
  })

  it('adds resistance to thin films and converges to full-depth drag', () => {
    expect(resolveShallowWaterResistanceMultiplier(0)).toBeGreaterThan(3)
    expect(resolveShallowWaterResistanceMultiplier(0.5)).toBeGreaterThan(1)
    expect(resolveShallowWaterResistanceMultiplier(1)).toBe(1)
    expect(() => resolveShallowWaterResistanceMultiplier(1.01)).toThrow(
      /openingFraction/,
    )
  })
})
