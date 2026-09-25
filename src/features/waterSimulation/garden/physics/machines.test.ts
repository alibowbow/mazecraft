import { describe, expect, it } from 'vitest'
import { BucketWheel, NoriaWheel, PaddleWheel, SiphonPipe } from './machines'

const dt = 1 / 120

describe('water machinery', () => {
  it('turns an overshot wheel with the jet that fills its buckets, conserving the water', () => {
    const wheel = new BucketWheel(0.25, 0.7, 12)
    let spilled = 0, missed = 0, supplied = 0
    const q = 0.02, jet = 2
    for (let n = 0; n < 120 * 20; n++) {
      supplied += q * dt
      missed += wheel.step(dt, q * dt, 0.3, jet)
      for (const v of wheel.spilled) spilled += v
    }
    // It runs steadily, slower than the water that drives it.
    expect(wheel.speed * wheel.radius).toBeGreaterThan(0.3)
    expect(wheel.speed * wheel.radius).toBeLessThan(3)
    expect(Math.abs(supplied - spilled - missed - wheel.held())).toBeLessThan(1e-12)
  })

  it('drags an undershot wheel up to nearly the speed of the sheet under it', () => {
    const wheel = new PaddleWheel(0.24, 0.6)
    for (let n = 0; n < 120 * 20; n++) wheel.step(dt, 1.2, 0.06)
    const rim = wheel.speed * (wheel.radius - 0.03)
    expect(rim).toBeGreaterThan(0.6)
    expect(rim).toBeLessThan(1.2)
  })

  it('lifts what its pots scoop, at a speed set by the motor and the load', () => {
    const noria = new NoriaWheel(1.85, 1.73, 0.24, 0.026, 18, 0.13, 0.85)
    const demand = new Float64Array(18)
    let scooped = 0, poured = 0
    for (let n = 0; n < 120 * 40; n++) {
      noria.demand(dt, 1.95, 0.3, demand)
      noria.step(dt, demand, 1)
      scooped += noria.scooped; poured += noria.poured
    }
    expect(noria.speed * noria.radius).toBeGreaterThan(0.5)
    expect(noria.speed * noria.radius).toBeLessThan(1.6)
    expect(Math.abs(scooped - poured - noria.held())).toBeLessThan(1e-12)
    // A full wheel delivers about one pot per pot spacing turned.
    const rate = poured / 40
    expect(rate).toBeGreaterThan(0.015)
  })

  it('primes a bell siphon at the trigger level and breaks it at the bell rim', () => {
    const area = 1.5, floor = 1
    const pipe = new SiphonPipe(3, 0.21, 0.7, floor + 0.32, floor + 0.1)
    let level = floor, cycles = 0, wasPrimed = false, peak = 0
    for (let n = 0; n < 120 * 200; n++) {
      const q = pipe.step(dt, level)
      peak = Math.max(peak, q)
      level += (0.01 - q) * dt / area
      if (pipe.primed && !wasPrimed) cycles++
      wasPrimed = pipe.primed
      if (cycles) expect(level).toBeGreaterThan(floor + 0.05)
      expect(level).toBeLessThan(floor + 0.35)
    }
    expect(cycles).toBeGreaterThanOrEqual(3)
    expect(peak).toBeGreaterThan(0.03)
  })
})
