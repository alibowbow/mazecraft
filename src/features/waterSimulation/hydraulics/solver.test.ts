import { describe, expect, it } from 'vitest'
import {
  createEmptyGraph,
  openPassage,
  type CellPosition,
  type MazeGraph,
} from '../../../core/maze'
import { getHydraulicDiagnostics } from './diagnostics'
import { buildHydraulicNetwork, findHydraulicEdge } from './network'
import {
  advanceHydraulicSolver,
  createHydraulicSolver,
  setHydraulicSource,
  stepHydraulicSolver,
} from './solver'

type Passage = readonly [CellPosition, CellPosition]

function fixture(
  rows: number,
  cols: number,
  passages: readonly Passage[],
): MazeGraph {
  const graph = createEmptyGraph(rows, cols)
  for (const [from, to] of passages) {
    if (!openPassage(graph, from, to)) throw new Error('Invalid fixture passage.')
  }
  return graph
}

function simulate(
  graph: MazeGraph,
  source: CellPosition,
  outlet: CellPosition,
  seconds: number,
  options: Parameters<typeof createHydraulicSolver>[1] = {},
) {
  const network = buildHydraulicNetwork(graph, source, outlet, {
    cellHeightMeters: 0.12,
    maxOpeningDepthMeters: 0.12,
  })
  const solver = createHydraulicSolver(network, {
    source: {
      targetFlowRateCubicMetersPerSecond: 0.012,
      rampDurationSeconds: 0.15,
    },
    ...options,
  })
  advanceHydraulicSolver(solver, seconds)
  return solver
}

describe('dynamic head-discharge solver', () => {
  it('forms continuous downhill flow without negative or non-finite state', () => {
    const graph = fixture(3, 1, [
      [{ row: 0, col: 0 }, { row: 1, col: 0 }],
      [{ row: 1, col: 0 }, { row: 2, col: 0 }],
    ])
    const solver = simulate(
      graph,
      { row: 0, col: 0 },
      { row: 2, col: 0 },
      12,
    )
    expect(solver.state.cumulativeAbsoluteVolume[0]).toBeGreaterThan(0)
    expect(solver.state.cumulativeAbsoluteVolume[1]).toBeGreaterThan(0)
    expect(solver.cumulativeOutletVolume).toBeGreaterThan(0)
    for (const value of solver.state.volume) {
      expect(Number.isFinite(value)).toBe(true)
      expect(value).toBeGreaterThanOrEqual(0)
    }
  })

  it('splits a symmetric T branch without index-direction bias', () => {
    const graph = fixture(2, 3, [
      [{ row: 0, col: 1 }, { row: 1, col: 1 }],
      [{ row: 1, col: 1 }, { row: 1, col: 0 }],
      [{ row: 1, col: 1 }, { row: 1, col: 2 }],
    ])
    const solver = simulate(
      graph,
      { row: 0, col: 1 },
      { row: 1, col: 1 },
      10,
      { outlet: { openingAreaSquareMeters: 0 } },
    )
    const center = solver.network.cellToNode[4]
    const left = solver.network.cellToNode[3]
    const right = solver.network.cellToNode[5]
    const leftEdge = findHydraulicEdge(solver.network, center, left)
    const rightEdge = findHydraulicEdge(solver.network, center, right)
    const leftVolume = solver.state.cumulativeAbsoluteVolume[leftEdge]
    const rightVolume = solver.state.cumulativeAbsoluteVolume[rightEdge]
    expect(Math.abs(leftVolume - rightVolume) / Math.max(leftVolume, rightVolume)).toBeLessThan(0.02)
  })

  it('responds to increased branch resistance', () => {
    const graph = fixture(2, 3, [
      [{ row: 0, col: 1 }, { row: 1, col: 1 }],
      [{ row: 1, col: 1 }, { row: 1, col: 0 }],
      [{ row: 1, col: 1 }, { row: 1, col: 2 }],
    ])
    const network = buildHydraulicNetwork(
      graph,
      { row: 0, col: 1 },
      { row: 1, col: 1 },
      { cellHeightMeters: 0.12, maxOpeningDepthMeters: 0.12 },
    )
    const center = network.cellToNode[4]
    const left = network.cellToNode[3]
    const right = network.cellToNode[5]
    const leftEdge = findHydraulicEdge(network, center, left)
    const rightEdge = findHydraulicEdge(network, center, right)
    network.edgeResistance[rightEdge] *= 6
    const solver = createHydraulicSolver(network, {
      source: { targetFlowRateCubicMetersPerSecond: 0.012, rampDurationSeconds: 0.1 },
      outlet: { openingAreaSquareMeters: 0 },
    })
    advanceHydraulicSolver(solver, 10)
    expect(solver.state.cumulativeAbsoluteVolume[leftEdge]).toBeGreaterThan(
      solver.state.cumulativeAbsoluteVolume[rightEdge],
    )
  })

  it('stores below an uphill sill and spills only after head rises above it', () => {
    const graph = fixture(2, 1, [
      [{ row: 1, col: 0 }, { row: 0, col: 0 }],
    ])
    const network = buildHydraulicNetwork(
      graph,
      { row: 1, col: 0 },
      { row: 0, col: 0 },
      { cellHeightMeters: 0.12, maxOpeningDepthMeters: 0.12 },
    )
    const edge = 0
    const belowSill = createHydraulicSolver(network, {
      source: { enabled: false },
      outlet: { openingAreaSquareMeters: 0 },
      initialVolumes: [0, network.storageArea[1] * 0.08],
    })
    stepHydraulicSolver(belowSill, 0.5)
    expect(Math.abs(belowSill.state.discharge[edge])).toBeLessThan(1e-8)

    const aboveSill = createHydraulicSolver(network, {
      source: { enabled: false },
      outlet: { openingAreaSquareMeters: 0 },
      initialVolumes: [0, network.storageArea[1] * 0.17],
    })
    stepHydraulicSolver(aboveSill, 0.5)
    expect(aboveSill.state.cumulativeAbsoluteVolume[edge]).toBeGreaterThan(0)
  })

  it('drains dynamically after the source is switched off', () => {
    const graph = fixture(2, 1, [
      [{ row: 0, col: 0 }, { row: 1, col: 0 }],
    ])
    const solver = simulate(
      graph,
      { row: 0, col: 0 },
      { row: 1, col: 0 },
      8,
    )
    const before = solver.state.volume.reduce((total, value) => total + value, 0)
    const outletBefore = solver.cumulativeOutletVolume
    setHydraulicSource(solver, false)
    advanceHydraulicSolver(solver, 8)
    const after = solver.state.volume.reduce((total, value) => total + value, 0)
    expect(after).toBeLessThan(before)
    expect(solver.cumulativeOutletVolume).toBeGreaterThan(outletBefore)
  })

  it('independently conserves mass over 60 simulated seconds', () => {
    const graph = fixture(4, 2, [
      [{ row: 0, col: 0 }, { row: 1, col: 0 }],
      [{ row: 1, col: 0 }, { row: 1, col: 1 }],
      [{ row: 1, col: 1 }, { row: 2, col: 1 }],
      [{ row: 2, col: 1 }, { row: 2, col: 0 }],
      [{ row: 2, col: 0 }, { row: 3, col: 0 }],
    ])
    const solver = simulate(
      graph,
      { row: 0, col: 0 },
      { row: 3, col: 0 },
      60,
    )
    const diagnostics = getHydraulicDiagnostics(solver)
    expect(diagnostics.relativeMassError).toBeLessThan(1e-5)
    expect(diagnostics.activeFlowEdgeCount).toBeGreaterThan(0)
    expect(diagnostics.maxVelocity).toBeLessThanOrEqual(
      solver.options.maximumVelocityMetersPerSecond,
    )
  })

  it('converges between 1/120s and 1/240s fixed steps', () => {
    const graph = fixture(3, 1, [
      [{ row: 0, col: 0 }, { row: 1, col: 0 }],
      [{ row: 1, col: 0 }, { row: 2, col: 0 }],
    ])
    const coarse = simulate(
      graph,
      { row: 0, col: 0 },
      { row: 2, col: 0 },
      10,
      { physicsStepSeconds: 1 / 120 },
    )
    const fine = simulate(
      graph,
      { row: 0, col: 0 },
      { row: 2, col: 0 },
      10,
      { physicsStepSeconds: 1 / 240 },
    )
    expect(coarse.cumulativeOutletVolume).toBeCloseTo(
      fine.cumulativeOutletVolume,
      2,
    )
    for (let node = 0; node < coarse.network.nodeCount; node += 1) {
      expect(coarse.state.depth[node]).toBeCloseTo(fine.state.depth[node], 2)
    }
  })
})
