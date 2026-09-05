import { describe, expect, it } from 'vitest'
import { createEmptyGraph, openPassage, type MazeGraph } from '../../../core/maze'
import { createTestProject } from '../../../test/projectFixture'
import { buildFluidLayout } from './layout'
import { FreeSurfaceSolver } from './solver'

function layoutFor(graph: MazeGraph, startCol = 0, endCol = graph.cols - 1) {
  return buildFluidLayout(createTestProject({
    mazeGraph: graph,
    startCell: { row: 0, col: startCol },
    endCell: { row: graph.rows - 1, col: endCol },
  }))
}

describe('free surface liquid', () => {
  it('accelerates a falling particle under gravity and admits only actual particles', () => {
    const graph = createEmptyGraph(4, 1)
    for (let row = 0; row < 3; row++) openPassage(graph, { row, col: 0 }, { row: row + 1, col: 0 })
    const layout = layoutFor(graph)
    const solver = new FreeSurfaceSolver(layout)
    solver.step(1 / 60)
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
    const layout = layoutFor(graph, 0, 0)
    const solver = new FreeSurfaceSolver(layout)
    solver.step(1)
    const flowing = solver.snapshot()
    // A 36-cell maze requests 110 particles/s. Previously only 60 arrived even
    // with an open passage, because a single busy lane discarded its budget.
    expect(flowing.diagnostics.injected / layout.particleArea).toBeGreaterThanOrEqual(107)
    expect(flowing.diagnostics.injected / layout.particleArea).toBeLessThanOrEqual(110)
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
    let basinParticles = 0, settledAboveHalfHeight = 0
    for (let i = 0; i < snapshot.count; i++) {
      const x = snapshot.positions[i * 2], y = snapshot.positions[i * 2 + 1]
      if (x < 0 || x >= 1 || y < 0 || y >= 1) continue
      basinParticles++
      const speed = Math.hypot(snapshot.velocities[i * 2], snapshot.velocities[i * 2 + 1])
      if (y < 0.5 && speed < 0.75) settledAboveHalfHeight++
    }
    // Count water inside the basin, excluding the funnel and fast falling jet.
    // The former supply left only 28 particles here and no settled upper half.
    expect(basinParticles).toBeGreaterThanOrEqual(40)
    expect(settledAboveHalfHeight).toBeGreaterThanOrEqual(3)
    expect(snapshot.diagnostics.discharged).toBe(0)
    expect(snapshot.diagnostics.escaped).toBe(0)
    expect(snapshot.diagnostics.massError).toBe(0)
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
