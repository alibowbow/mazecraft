import { expect, it } from 'vitest'
import { createEmptyGraph, openPassage } from '../../../core/maze'
import { createTestProject } from '../../../test/projectFixture'
import { buildFluidLayout } from './layout'
import { FreeSurfaceSolver } from './solver'

it.each([2, 4, 6])('preserves pool area after %s seconds of supply', (seconds) => {
  const graph = createEmptyGraph(3, 4)
  for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) {
    if (row < 2) openPassage(graph, { row, col }, { row: row + 1, col })
    if (col < 2) openPassage(graph, { row, col }, { row, col: col + 1 })
  }
  const layout = buildFluidLayout(createTestProject({ mazeGraph: graph,
    startCell: { row: 0, col: 1 }, endCell: { row: 2, col: 3 } }))
  const solver = new FreeSurfaceSolver(layout)
  solver.step(seconds)
  solver.step(4, 0)
  const snapshot = solver.snapshot()
  const heights: number[] = []
  for (let i = 0; i < snapshot.count; i++) if (snapshot.positions[i * 2 + 1] > 0) heights.push(snapshot.positions[i * 2 + 1])
  heights.sort((a, b) => a - b)
  const surface = heights[Math.floor(heights.length * 0.05)] - layout.radius
  const occupiedArea = (3 - 0.1) * (2.95 - surface)
  expect(snapshot.diagnostics.escaped).toBe(0)
  expect(snapshot.diagnostics.massError).toBe(0)
  // Sampling and the top 5% exclusion permit a small free-surface deficit,
  // but the occupied volume must not change drastically with pool depth.
  expect(occupiedArea / snapshot.diagnostics.stored).toBeGreaterThan(0.88)
  expect(occupiedArea / snapshot.diagnostics.stored).toBeLessThan(1.02)
}, 30_000)

it('spills over a return passage with a bounded admitted volume', () => {
  const graph = createEmptyGraph(4, 3)
  for (const [a, b] of [
    [[0, 0], [1, 0]], [[1, 0], [2, 0]], [[2, 0], [2, 1]],
    [[2, 1], [1, 1]], [[1, 1], [1, 2]], [[1, 2], [2, 2]], [[2, 2], [3, 2]],
  ]) openPassage(graph, { row: a[0], col: a[1] }, { row: b[0], col: b[1] })
  const layout = buildFluidLayout(createTestProject({ mazeGraph: graph,
    startCell: { row: 0, col: 0 }, endCell: { row: 3, col: 2 } }))
  const solver = new FreeSurfaceSolver(layout)
  solver.step(1)
  expect(solver.snapshot().diagnostics.reachedExit).toBe(false)
  for (let tick = 0; tick < 120 * 5; tick++) {
    solver.step(1 / 120)
    if (solver.snapshot().diagnostics.reachedExit) break
  }
  const { diagnostics } = solver.snapshot()
  expect(diagnostics.reachedExit).toBe(true)
  // Original solver needed 210 particles / 4.116 cell² for this geometry.
  // Bound volume as well as time so a faster emitter cannot hide compression.
  expect(diagnostics.injected).toBeLessThanOrEqual(200 * layout.particleArea)
  expect(diagnostics.injected).toBeGreaterThan(2.5)
  expect(diagnostics.time).toBeLessThan(3.6)
  expect(diagnostics.escaped).toBe(0)
  expect(diagnostics.massError).toBe(0)
}, 30_000)
