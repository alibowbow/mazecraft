import { describe, expect, it } from 'vitest'
import { createEmptyGraph, openPassage, type MazeGraph } from '../../../core/maze'
import { createTestProject } from '../../../test/projectFixture'
import { buildFluidLayout } from './layout'
import { FreeSurfaceSolver } from './solver'
import type { FluidLayout, FluidSnapshot } from './types'

function layoutFor(graph: MazeGraph, startCol = 0, endCol = graph.cols - 1) {
  return buildFluidLayout(createTestProject({
    mazeGraph: graph,
    startCell: { row: 0, col: startCol },
    endCell: { row: graph.rows - 1, col: endCol },
  }))
}

/** An open-top rectangular tank isolates occupied area from nozzle throughput. */
function tankLayout(width: number, height: number): FluidLayout {
  const base = layoutFor(createEmptyGraph(height, width))
  return {
    ...base, activeCellCount: 16, // 100 particles/s at the explicit 1/3 test inflow.
    inletX: width / 2, inletY: 0, outletX: width + 5,
    minX: -0.2, maxX: width + 0.2, minY: -2, maxY: height + 1,
    walls: [
      { x0: -0.1, x1: 0.05, y0: -2, y1: height + 0.1 },
      { x0: width - 0.05, x1: width + 0.1, y0: -2, y1: height + 0.1 },
      { x0: 0, x1: width, y0: height - 0.05, y1: height + 0.1 },
    ],
  }
}

function quantileDepth(snapshot: FluidSnapshot, floorY: number, quantile: number): number {
  const heights = Array.from(snapshot.positions).filter((_, index) => index % 2 === 1).sort((a, b) => a - b)
  return floorY - heights[Math.floor(heights.length * quantile)]
}

/** Deterministic particle-state fixture; no production seeding API is needed. */
function seededSolver(layout: FluidLayout, particles: number[][]): FreeSurfaceSolver {
  const solver = new FreeSurfaceSolver(layout)
  const state = solver as unknown as {
    count: number; admitted: number; x: Float64Array; y: Float64Array; vx: Float64Array; vy: Float64Array
  }
  state.count = particles.length; state.admitted = particles.length
  particles.forEach(([x, y, vx, vy], index) => {
    state.x[index] = x; state.y[index] = y; state.vx[index] = vx; state.vy[index] = vy
  })
  return solver
}

describe('free surface liquid', () => {
  it('accelerates a falling particle under gravity and admits only actual particles', () => {
    const graph = createEmptyGraph(4, 1)
    for (let row = 0; row < 3; row++) openPassage(graph, { row, col: 0 }, { row: row + 1, col: 0 })
    const layout = layoutFor(graph)
    const solver = new FreeSurfaceSolver(layout)
    solver.step(1 / 60, 1 / 3)
    const before = solver.snapshot()
    expect(before.count).toBe(1)
    solver.step(0.1, 0)
    const after = solver.snapshot()
    expect(after.positions[1]).toBeGreaterThan(before.positions[1])
    expect(after.velocities[1] - before.velocities[1]).toBeCloseTo(1.2, 4)
    expect(after.diagnostics.injected).toBe(layout.particleArea)
    expect(after.diagnostics.massError).toBe(0)
  })

  it('falls through the actual outlet, retains the visible jet, and counts discharge once', () => {
    const graph = createEmptyGraph(3, 1)
    openPassage(graph, { row: 0, col: 0 }, { row: 1, col: 0 })
    openPassage(graph, { row: 1, col: 0 }, { row: 2, col: 0 })
    const layout = layoutFor(graph)
    const solver = new FreeSurfaceSolver(layout)
    solver.step(2)
    const flowing = solver.snapshot()
    expect(flowing.diagnostics.reachedExit).toBe(true)
    expect(flowing.diagnostics.discharged).toBeGreaterThan(0)
    expect(flowing.positions.some((value, index) => index % 2 === 1 && value > layout.outletY)).toBe(true)
    expect(flowing.diagnostics.escaped).toBe(0)
    expect(flowing.diagnostics.massError).toBe(0)
    solver.step(4, 0)
    const drained = solver.snapshot()
    expect(drained.diagnostics.discharged).toBeLessThanOrEqual(drained.diagnostics.injected)
    expect(drained.diagnostics.massError).toBe(0)
    expect(drained.diagnostics.escaped).toBe(0)
  })

  it('delivers the requested flow through an unobstructed nozzle without losing occupied-lane turns', () => {
    const graph = createEmptyGraph(6, 6)
    for (let row = 0; row < 5; row++) openPassage(graph, { row, col: 0 }, { row: row + 1, col: 0 })
    const layout = { ...layoutFor(graph, 0, 0), walls: [] }
    // Isolate source admission from the real tapered funnel's backpressure.
    const solver = new FreeSurfaceSolver(layout)
    solver.step(1)
    const flowing = solver.snapshot()
    // The stronger default requests 330 particles/s in a 36-cell maze. Check
    // actual admitted water, not merely the larger nominal supply budget.
    expect(flowing.diagnostics.injected / layout.particleArea).toBeGreaterThanOrEqual(327)
    expect(flowing.diagnostics.injected / layout.particleArea).toBeLessThanOrEqual(330)
    expect(flowing.diagnostics.maxVelocity).toBeLessThanOrEqual(11 + 1e-10)
    expect(flowing.diagnostics.massError).toBe(0)
    solver.step(0.5, 0)
    expect(solver.snapshot().diagnostics.injected).toBe(flowing.diagnostics.injected)
  })

  it('raises the settled basin level promptly using admitted water', () => {
    const layout = layoutFor(createEmptyGraph(2, 2), 0, 1)
    const solver = new FreeSurfaceSolver(layout)
    solver.step(1)
    const snapshot = solver.snapshot()
    let settledAboveHalfHeight = 0
    for (let i = 0; i < snapshot.count; i++) {
      const x = snapshot.positions[i * 2], y = snapshot.positions[i * 2 + 1]
      if (x < 0 || x >= 1 || y < 0 || y >= 1) continue
      const speed = Math.hypot(snapshot.velocities[i * 2], snapshot.velocities[i * 2 + 1])
      if (y < 0.5 && speed < 0.75) settledAboveHalfHeight++
    }
    // Check geometric rise, excluding the funnel and fast falling jet. Requiring
    // 40 particles per cell here rewarded the former compressed water packing.
    expect(settledAboveHalfHeight).toBeGreaterThanOrEqual(3)
    expect(snapshot.diagnostics.discharged).toBe(0)
    expect(snapshot.diagnostics.escaped).toBe(0)
    expect(snapshot.diagnostics.massError).toBe(0)
  })

  it.each([6, 8])('fills a %i-cell-wide maze basin promptly at the default speed', size => {
    const graph = createEmptyGraph(size, size)
    for (let row = 0; row < size - 1; row++) openPassage(graph, { row, col: 0 }, { row: row + 1, col: 0 })
    for (let col = 0; col < size - 2; col++) openPassage(graph, { row: size - 1, col }, { row: size - 1, col: col + 1 })
    const layout = layoutFor(graph, 0, size - 1)
    const solver = new FreeSurfaceSolver(layout)
    solver.step(1)
    const entering = solver.snapshot()
    let insideMaze = 0
    for (let i = 0; i < entering.count; i++) if (entering.positions[i * 2 + 1] >= 0) insideMaze++
    // The real taper remains in place: particles stuck in the funnel do not
    // count toward this requirement. The old default admitted only 48–54 here.
    expect(insideMaze).toBeGreaterThanOrEqual(140)
    solver.step(2)
    const pooled = solver.snapshot()
    let settledAboveHalfHeight = 0
    for (let i = 0; i < pooled.count; i++) {
      const x = pooled.positions[i * 2], y = pooled.positions[i * 2 + 1]
      const speed = Math.hypot(pooled.velocities[i * 2], pooled.velocities[i * 2 + 1])
      if (x > 1 && y > size - 1 && y < size - 0.5 && speed < 1) settledAboveHalfHeight++
    }
    // Geometric rise in the receiving basin, away from the falling jet.
    expect(settledAboveHalfHeight).toBeGreaterThanOrEqual(12)
    expect(pooled.diagnostics.time).toBe(3)
    expect(pooled.diagnostics.discharged).toBe(0)
    expect(pooled.diagnostics.escaped).toBe(0)
    expect(pooled.diagnostics.massError).toBe(0)
  })

  it('pools above solid walls without tunnelling or inventing outlet discharge', () => {
    const layout = layoutFor(createEmptyGraph(2, 2), 0, 1)
    const solver = new FreeSurfaceSolver(layout)
    solver.step(8, 3)
    const snapshot = solver.snapshot()
    expect(snapshot.diagnostics.wetCells).toBe(1)
    expect(snapshot.diagnostics.reachedExit).toBe(false)
    expect(snapshot.diagnostics.discharged).toBe(0)
    expect(snapshot.diagnostics.escaped).toBe(0)
    expect(snapshot.count).toBeLessThanOrEqual(layout.capacity)
    expect(snapshot.diagnostics.saturated).toBe(true)
    for (let i = 0; i < snapshot.count; i++) {
      const x = snapshot.positions[i * 2], y = snapshot.positions[i * 2 + 1]
      expect(y).toBeLessThanOrEqual(1 - 0.05 - layout.radius + 1e-5)
      if (y > 0) expect(x).toBeLessThan(1)
      for (const wall of layout.walls) {
        expect(x > wall.x0 + 1e-5 && x < wall.x1 - 1e-5 && y > wall.y0 + 1e-5 && y < wall.y1 - 1e-5).toBe(false)
      }
    }
    expect(snapshot.diagnostics.massError).toBe(0)
    solver.step(1, 0)
    const stopped = solver.snapshot()
    expect(stopped.diagnostics.injected).toBe(snapshot.diagnostics.injected)
    solver.step(1 / 120)
    // An actual full nozzle must stay blocked without releasing banked supply.
    expect(solver.snapshot().diagnostics.injected).toBe(stopped.diagnostics.injected)
  }, 20_000)

  it('splits into both open branches when a falling jet hits a basin floor', () => {
    const graph = createEmptyGraph(3, 3)
    openPassage(graph, { row: 0, col: 1 }, { row: 1, col: 1 })
    openPassage(graph, { row: 1, col: 1 }, { row: 1, col: 0 })
    openPassage(graph, { row: 1, col: 1 }, { row: 1, col: 2 })
    const solver = new FreeSurfaceSolver(layoutFor(graph, 1, 1))
    solver.step(4)
    const result = solver.snapshot()
    let left = 0, right = 0
    for (let i = 0; i < result.count; i++) {
      const x = result.positions[i * 2], y = result.positions[i * 2 + 1]
      if (y > 1 && x < 1) left++
      if (y > 1 && x > 2) right++
    }
    expect(left).toBeGreaterThan(15)
    expect(right).toBeGreaterThan(15)
    expect(result.diagnostics.escaped).toBe(0)
    expect(result.diagnostics.massError).toBe(0)
  })

  it('fills a low basin, then climbs the return passage to the outlet', () => {
    const graph = createEmptyGraph(4, 3)
    for (const [a, b] of [
      [[0, 0], [1, 0]], [[1, 0], [2, 0]], [[2, 0], [2, 1]],
      [[2, 1], [1, 1]], [[1, 1], [1, 2]], [[1, 2], [2, 2]], [[2, 2], [3, 2]],
    ]) openPassage(graph, { row: a[0], col: a[1] }, { row: b[0], col: b[1] })
    const solver = new FreeSurfaceSolver(layoutFor(graph, 0, 2))
    solver.step(14)
    const result = solver.snapshot()
    expect(result.diagnostics.wetCells).toBeGreaterThanOrEqual(6)
    expect(result.diagnostics.reachedExit).toBe(true)
    expect(result.diagnostics.escaped).toBe(0)
    expect(result.diagnostics.massError).toBe(0)
  }, 30_000)

  it.each([[2, 8, 100], [2, 8, 300], [1, 10, 300]])(
    'preserves occupied area after supply stops in a %i-wide, %i-high tank with %i particles',
    (width, height, count) => {
      const layout = tankLayout(width, height)
      const solver = new FreeSurfaceSolver(layout)
      while (solver.snapshot().count < count) solver.step(1 / 120, 1 / 3)
      const admitted = solver.snapshot().diagnostics.injected
      solver.step(6, 0)
      // No active jet remains. A uniform pool's median is halfway through
      // area / clear width; the 5% quantile is 95% of that depth. Use quantiles
      // rather than the highest droplet or a density rendering threshold.
      const expectedDepth = admitted / (width - 0.1)
      for (let check = 0; check < 2; check++) {
        const snapshot = solver.snapshot()
        const median = quantileDepth(snapshot, height - 0.05, 0.5)
        const upperSurface = quantileDepth(snapshot, height - 0.05, 0.05)
        expect(median / (expectedDepth * 0.5)).toBeGreaterThan(0.9)
        expect(median / (expectedDepth * 0.5)).toBeLessThan(1.12)
        expect(upperSurface / (expectedDepth * 0.95)).toBeGreaterThan(0.9)
        expect(upperSurface / (expectedDepth * 0.95)).toBeLessThan(1.12)
        expect(snapshot.count).toBe(count)
        expect(snapshot.diagnostics.injected).toBe(admitted)
        expect(snapshot.diagnostics.stored).toBe(admitted)
        expect(snapshot.diagnostics.escaped).toBe(0)
        expect(snapshot.diagnostics.massError).toBe(0)
        if (check === 0) solver.step(2, 0)
      }
    },
  )

  it('does not transmit density or tangential momentum across a thin solid wall', () => {
    const layout = tankLayout(2, 4)
    layout.walls.push({ x0: 0, x1: 2, y0: 0.95, y1: 1.05 })
    // Centres are only .24 apart, inside the .294 kernel, but a .10 wall
    // separates the two chambers. The upper particle slides along the floor.
    const lower = [1, 1.12, 0, 0]
    const isolated = seededSolver(layout, [lower])
    const opposite = seededSolver(layout, [lower, [1, 0.88, 3, 0]])
    isolated.step(0.05, 0); opposite.step(0.05, 0)
    const alone = isolated.snapshot(), withNeighbour = opposite.snapshot()
    expect(withNeighbour.positions.slice(0, 2)).toEqual(alone.positions)
    expect(withNeighbour.velocities.slice(0, 2)).toEqual(alone.velocities)
    expect(withNeighbour.diagnostics.massError).toBe(0)
  })

  it('lets an unsupported sheet fall through an open vertical branch after supply stops', () => {
    const layout = tankLayout(3, 6)
    layout.walls.push(
      { x0: 0, x1: 1.05, y0: 1.05, y1: 1.15 },
      { x0: 1.95, x1: 3, y0: 1.05, y1: 1.15 },
    )
    const particles: number[][] = []
    for (let row = 0; row < 3; row++) for (let col = 0; col < 5; col++) {
      particles.push([1.2 + col * 0.15, 0.55 + row * 0.15, 0, 0])
    }
    const solver = seededSolver(layout, particles)
    const admitted = solver.snapshot().diagnostics.injected
    solver.step(1, 0)
    const snapshot = solver.snapshot()
    for (let i = 0; i < snapshot.count; i++) expect(snapshot.positions[i * 2 + 1]).toBeGreaterThan(1.2)
    expect(snapshot.diagnostics.injected).toBe(admitted)
    expect(snapshot.diagnostics.stored).toBe(admitted)
    expect(snapshot.diagnostics.massError).toBe(0)
  })

  it('keeps timestep partitioning deterministic and reset clears all accounting', () => {
    const layout = layoutFor(createEmptyGraph(2, 2))
    const first = new FreeSurfaceSolver(layout), second = new FreeSurfaceSolver(layout)
    first.step(0.5)
    for (let i = 0; i < 30; i++) second.step(1 / 60)
    expect(second.snapshot()).toEqual(first.snapshot())
    first.reset()
    expect(first.snapshot().diagnostics).toEqual({
      time: 0, count: 0, injected: 0, discharged: 0, escaped: 0, stored: 0,
      massError: 0, maxVelocity: 0, wetCells: 0, reachedExit: false, outletRate: 0, saturated: false,
    })
    first.step(0.5)
    expect(first.snapshot()).toEqual(second.snapshot())
  })
})
