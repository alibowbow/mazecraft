import { describe, expect, it } from 'vitest'
import { DRY, OVERFALL, ShallowWaterGrid } from './shallowWater'

function channel(nx: number, ny: number, dx = 0.1) {
  const grid = new ShallowWaterGrid({ x0: 0, y0: 0, dx, nx, ny })
  for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) grid.solid[j * nx + i] = 0
  return grid
}

describe('shallow-water grid', () => {
  it('keeps a lake at rest over an uneven bed (well balanced)', () => {
    const grid = channel(30, 12)
    for (let c = 0; c < grid.count; c++) {
      grid.bed[c] = 0.1 * Math.sin(c * 0.37) + 0.05 * Math.cos(c * 1.3)
      if (!grid.solid[c]) grid.h[c] = Math.max(0, 0.4 - grid.bed[c])
    }
    const before = grid.volume()
    for (let n = 0; n < 600; n++) grid.step(1 / 120)
    let speed = 0
    for (const value of grid.u) speed = Math.max(speed, Math.abs(value))
    for (const value of grid.v) speed = Math.max(speed, Math.abs(value))
    expect(speed).toBeLessThan(1e-6)
    expect(Math.abs(grid.volume() - before)).toBeLessThan(1e-10)
  })

  it('conserves water exactly while a dam breaks over a dry bed with walls', () => {
    const grid = channel(40, 20)
    grid.solid[10 * 40 + 20] = 1; grid.solid[11 * 40 + 20] = 1
    for (let j = 1; j < 19; j++) for (let i = 1; i < 12; i++) grid.h[j * 40 + i] = 0.5
    const before = grid.volume()
    for (let n = 0; n < 1200; n++) grid.step(1 / 240)
    expect(Math.abs(grid.volume() - before) / before).toBeLessThan(1e-12)
    for (let c = 0; c < grid.count; c++) {
      expect(grid.h[c]).toBeGreaterThanOrEqual(0)
      if (grid.solid[c]) expect(grid.h[c]).toBe(0)
    }
    // The front has run the length of the dry channel within five seconds.
    expect(grid.h[10 * 40 + 37]).toBeGreaterThan(DRY)
  })

  it('passes the broad-crested weir discharge over a step, Q = 1.705·w·H^1.5', () => {
    // A 1 m wide flume: reservoir, a crest 0.25 m high, then a steep drop.
    const nx = 60, ny = 12, dx = 0.1
    const grid = channel(nx, ny, dx)
    const crest = 30
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      grid.bed[j * nx + i] = i < crest ? 0 : i === crest ? 0.25 : -0.5
    }
    const q = 0.03, width = (ny - 2) * dx
    const outlet = Int32Array.from({ length: ny - 2 }, (_, k) => (k + 1) * nx + nx - 2)
    let head = 0
    for (let n = 0; n < 120 * 90; n++) {
      // Constant inflow at the upstream end, free outflow at the downstream end.
      for (let j = 1; j < ny - 1; j++) grid.h[j * nx + 1] += q / 120 / (ny - 2) / (dx * dx)
      grid.step(1 / 120)
      grid.withdraw(outlet, 1e9)
    }
    // Upstream head over the crest, well back from the brink.
    let sum = 0
    for (let j = 1; j < ny - 1; j++) sum += grid.bed[j * nx + 15] + grid.h[j * nx + 15]
    head = sum / (ny - 2) - 0.25
    const expected = Math.pow(q / (OVERFALL * width), 2 / 3)
    expect(head).toBeGreaterThan(expected * 0.85)
    expect(head).toBeLessThan(expected * 1.2)
  })
})
