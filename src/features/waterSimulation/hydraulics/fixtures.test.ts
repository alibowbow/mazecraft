import { describe, expect, it } from 'vitest'
import {
  createEmptyGraph,
  generateMaze,
  openPassage,
  type CellPosition,
  type MazeGraph,
} from '../../../core/maze'
import { getHydraulicDiagnostics } from './diagnostics'
import {
  buildHydraulicNetwork,
  findHydraulicEdge,
  type HydraulicNetwork,
} from './network'
import {
  advanceHydraulicSolver,
  createHydraulicSolver,
  setHydraulicSource,
  stepHydraulicSolver,
  type HydraulicSolver,
} from './solver'

type Passage = readonly [CellPosition, CellPosition]

const SOURCE_FLOW = 0.012
const STEP_SECONDS = 1 / 120

function graphWithPassages(
  rows: number,
  cols: number,
  passages: readonly Passage[],
): MazeGraph {
  const graph = createEmptyGraph(rows, cols)
  for (const [from, to] of passages) {
    if (!openPassage(graph, from, to)) {
      throw new Error(`Invalid fixture passage: ${JSON.stringify([from, to])}`)
    }
  }
  return graph
}

function solverFor(
  graph: MazeGraph,
  source: CellPosition,
  outlet: CellPosition,
  options: Parameters<typeof createHydraulicSolver>[1] = {},
): HydraulicSolver {
  const network = buildHydraulicNetwork(graph, source, outlet, {
    cellHeightMeters: 0.12,
    maxOpeningDepthMeters: 0.12,
  })
  return createHydraulicSolver(network, {
    source: {
      targetFlowRateCubicMetersPerSecond: SOURCE_FLOW,
      rampDurationSeconds: 0.15,
    },
    ...options,
  })
}

function transportedToward(
  solver: HydraulicSolver,
  edge: number,
  node: number,
): number {
  const signed = solver.state.cumulativeSignedVolume[edge]
  if (solver.network.edgeTo[edge] === node) return signed
  if (solver.network.edgeFrom[edge] === node) return -signed
  throw new RangeError('The requested node is not incident to this edge.')
}

function cloneWithReversedEdges(network: HydraulicNetwork): HydraulicNetwork {
  const edgeCount = network.edgeCount
  const edgeFrom = new Int32Array(edgeCount)
  const edgeTo = new Int32Array(edgeCount)
  const edgeLength = new Float64Array(edgeCount)
  const edgeWidth = new Float64Array(edgeCount)
  const edgeMaxOpeningDepth = new Float64Array(edgeCount)
  const edgeSillElevation = new Float64Array(edgeCount)
  const edgeResistance = new Float64Array(edgeCount)
  const degree = new Int32Array(network.nodeCount)

  for (let edge = 0; edge < edgeCount; edge += 1) {
    const original = edgeCount - 1 - edge
    edgeFrom[edge] = network.edgeFrom[original]
    edgeTo[edge] = network.edgeTo[original]
    edgeLength[edge] = network.edgeLength[original]
    edgeWidth[edge] = network.edgeWidth[original]
    edgeMaxOpeningDepth[edge] = network.edgeMaxOpeningDepth[original]
    edgeSillElevation[edge] = network.edgeSillElevation[original]
    edgeResistance[edge] = network.edgeResistance[original]
    degree[edgeFrom[edge]] += 1
    degree[edgeTo[edge]] += 1
  }

  const adjacencyOffsets = new Int32Array(network.nodeCount + 1)
  for (let node = 0; node < network.nodeCount; node += 1) {
    adjacencyOffsets[node + 1] = adjacencyOffsets[node] + degree[node]
  }
  const adjacencyEdges = new Int32Array(edgeCount * 2)
  const adjacencyOtherNode = new Int32Array(edgeCount * 2)
  const adjacencyOrientation = new Int8Array(edgeCount * 2)
  const cursor = new Int32Array(adjacencyOffsets)
  for (let edge = 0; edge < edgeCount; edge += 1) {
    const from = edgeFrom[edge]
    const to = edgeTo[edge]
    let slot = cursor[from]++
    adjacencyEdges[slot] = edge
    adjacencyOtherNode[slot] = to
    adjacencyOrientation[slot] = 1
    slot = cursor[to]++
    adjacencyEdges[slot] = edge
    adjacencyOtherNode[slot] = from
    adjacencyOrientation[slot] = -1
  }

  return {
    ...network,
    edgeFrom,
    edgeTo,
    edgeLength,
    edgeWidth,
    edgeMaxOpeningDepth,
    edgeSillElevation,
    edgeResistance,
    adjacencyOffsets,
    adjacencyEdges,
    adjacencyOtherNode,
    adjacencyOrientation,
  }
}

const loopPassages: readonly Passage[] = [
  [{ row: 0, col: 1 }, { row: 1, col: 1 }],
  [{ row: 1, col: 1 }, { row: 1, col: 0 }],
  [{ row: 1, col: 0 }, { row: 2, col: 0 }],
  [{ row: 2, col: 0 }, { row: 2, col: 1 }],
  [{ row: 1, col: 1 }, { row: 1, col: 2 }],
  [{ row: 1, col: 2 }, { row: 2, col: 2 }],
  [{ row: 2, col: 2 }, { row: 2, col: 1 }],
]

describe('hydraulic fixture phenomena', () => {
  it('preserves a symmetric T split when left/right cells and packed indices are mirrored', () => {
    const originalGraph = graphWithPassages(2, 4, [
      [{ row: 0, col: 1 }, { row: 1, col: 1 }],
      [{ row: 1, col: 1 }, { row: 1, col: 0 }],
      [{ row: 1, col: 1 }, { row: 1, col: 2 }],
    ])
    const mirroredGraph = graphWithPassages(2, 4, [
      [{ row: 0, col: 2 }, { row: 1, col: 2 }],
      [{ row: 1, col: 2 }, { row: 1, col: 3 }],
      [{ row: 1, col: 2 }, { row: 1, col: 1 }],
    ])
    const original = solverFor(
      originalGraph,
      { row: 0, col: 1 },
      { row: 1, col: 1 },
      { outlet: { openingAreaSquareMeters: 0 } },
    )
    const mirrored = solverFor(
      mirroredGraph,
      { row: 0, col: 2 },
      { row: 1, col: 2 },
      { outlet: { openingAreaSquareMeters: 0 } },
    )
    advanceHydraulicSolver(original, 10)
    advanceHydraulicSolver(mirrored, 10)

    const originalJunction = original.network.cellToNode[5]
    const originalLeft = original.network.cellToNode[4]
    const originalRight = original.network.cellToNode[6]
    const mirroredJunction = mirrored.network.cellToNode[6]
    const mirroredLeft = mirrored.network.cellToNode[5]
    const mirroredRight = mirrored.network.cellToNode[7]
    const branchVolume = (
      solver: HydraulicSolver,
      firstNode: number,
      secondNode: number,
    ) =>
      solver.state.cumulativeAbsoluteVolume[
        findHydraulicEdge(solver.network, firstNode, secondNode)
      ]

    const originalToLeft = branchVolume(
      original,
      originalJunction,
      originalLeft,
    )
    const originalToRight = branchVolume(
      original,
      originalJunction,
      originalRight,
    )
    const mirroredToLeft = branchVolume(
      mirrored,
      mirroredJunction,
      mirroredLeft,
    )
    const mirroredToRight = branchVolume(
      mirrored,
      mirroredJunction,
      mirroredRight,
    )

    expect(originalToLeft).toBeCloseTo(originalToRight, 10)
    expect(mirroredToLeft).toBeCloseTo(mirroredToRight, 10)
    expect(mirroredToRight).toBeCloseTo(originalToLeft, 10)
    expect(mirroredToLeft).toBeCloseTo(originalToRight, 10)
    expect(mirrored.state.depth[mirroredLeft]).toBeCloseTo(
      original.state.depth[originalRight],
      10,
    )
    expect(mirrored.state.depth[mirroredRight]).toBeCloseTo(
      original.state.depth[originalLeft],
      10,
    )
  })

  it('holds water in a U-shaped low basin until its free surface crosses the uphill sill', () => {
    const graph = graphWithPassages(4, 3, [
      [{ row: 0, col: 0 }, { row: 1, col: 0 }],
      [{ row: 1, col: 0 }, { row: 2, col: 0 }],
      [{ row: 2, col: 0 }, { row: 2, col: 1 }],
      [{ row: 2, col: 1 }, { row: 1, col: 1 }],
      [{ row: 1, col: 1 }, { row: 1, col: 2 }],
      [{ row: 1, col: 2 }, { row: 2, col: 2 }],
      [{ row: 2, col: 2 }, { row: 3, col: 2 }],
    ])
    const solver = solverFor(
      graph,
      { row: 0, col: 0 },
      { row: 3, col: 2 },
    )
    const basinBottom = solver.network.cellToNode[7]
    const uphillNode = solver.network.cellToNode[4]
    const spillEdge = findHydraulicEdge(
      solver.network,
      basinBottom,
      uphillNode,
    )
    const sill = solver.network.edgeSillElevation[spillEdge]
    let lastBelowSillTransport = 0
    let observedBelowSill = false
    let observedOverflow = false

    for (let step = 0; step < 3_600; step += 1) {
      stepHydraulicSolver(solver)
      const bottomHead = solver.state.hydraulicHead[basinBottom]
      const transported = solver.state.cumulativeAbsoluteVolume[spillEdge]
      if (solver.state.volume[basinBottom] > 0 && bottomHead < sill - 1e-4) {
        observedBelowSill = true
        lastBelowSillTransport = transported
        expect(solver.state.openingArea[spillEdge]).toBe(0)
        expect(Math.abs(solver.state.discharge[spillEdge])).toBeLessThan(1e-8)
      }
      if (bottomHead > sill + 1e-4 && transported > lastBelowSillTransport) {
        observedOverflow = true
        break
      }
    }

    expect(observedBelowSill).toBe(true)
    expect(lastBelowSillTransport).toBe(0)
    expect(observedOverflow).toBe(true)
    expect(solver.state.openingArea[spillEdge]).toBeGreaterThan(0)
    expect(solver.state.cumulativeAbsoluteVolume[spillEdge]).toBeGreaterThan(0)
  })

  it('develops signed downhill flow and settles toward a friction-limited discharge', () => {
    const graph = graphWithPassages(4, 1, [
      [{ row: 0, col: 0 }, { row: 1, col: 0 }],
      [{ row: 1, col: 0 }, { row: 2, col: 0 }],
      [{ row: 2, col: 0 }, { row: 3, col: 0 }],
    ])
    const solver = solverFor(
      graph,
      { row: 0, col: 0 },
      { row: 3, col: 0 },
    )
    advanceHydraulicSolver(solver, 12)
    const firstSteadySample = Array.from(solver.state.discharge)
    advanceHydraulicSolver(solver, 4)
    const secondSteadySample = Array.from(solver.state.discharge)

    for (let edge = 0; edge < solver.network.edgeCount; edge += 1) {
      expect(solver.network.edgeFrom[edge]).toBeLessThan(
        solver.network.edgeTo[edge],
      )
      expect(firstSteadySample[edge]).toBeGreaterThan(0)
      expect(secondSteadySample[edge]).toBeGreaterThan(0)
      expect(Math.abs(secondSteadySample[edge] - firstSteadySample[edge])).toBeLessThan(
        SOURCE_FLOW * 0.08,
      )
      expect(Math.abs(secondSteadySample[edge])).toBeLessThan(
        solver.state.openingArea[edge] *
          solver.options.maximumVelocityMetersPerSecond,
      )
    }
    expect(solver.cumulativeOutletVolume).toBeGreaterThan(0)

    const baselineNetwork = buildHydraulicNetwork(
      graph,
      { row: 0, col: 0 },
      { row: 3, col: 0 },
      { cellHeightMeters: 0.12, maxOpeningDepthMeters: 0.12 },
    )
    const higherFrictionNetwork = buildHydraulicNetwork(
      graph,
      { row: 0, col: 0 },
      { row: 3, col: 0 },
      { cellHeightMeters: 0.12, maxOpeningDepthMeters: 0.12 },
    )
    for (let edge = 0; edge < higherFrictionNetwork.edgeCount; edge += 1) {
      higherFrictionNetwork.edgeResistance[edge] *= 5
    }
    const transientOptions = {
      source: {
        targetFlowRateCubicMetersPerSecond: SOURCE_FLOW,
        rampDurationSeconds: 0.15,
      },
    } as const
    const baseline = createHydraulicSolver(baselineNetwork, transientOptions)
    const higherFriction = createHydraulicSolver(
      higherFrictionNetwork,
      transientOptions,
    )
    advanceHydraulicSolver(baseline, 4)
    advanceHydraulicSolver(higherFriction, 4)
    expect(higherFriction.cumulativeOutletVolume).toBeLessThan(
      baseline.cumulativeOutletVolume,
    )
  })

  it('fills a dead end, then permits actual backflow when the main path drains', () => {
    const graph = graphWithPassages(3, 2, [
      [{ row: 0, col: 0 }, { row: 1, col: 0 }],
      [{ row: 1, col: 0 }, { row: 2, col: 0 }],
      [{ row: 1, col: 0 }, { row: 1, col: 1 }],
    ])
    const solver = solverFor(
      graph,
      { row: 0, col: 0 },
      { row: 2, col: 0 },
    )
    const junction = solver.network.cellToNode[2]
    const deadEnd = solver.network.cellToNode[3]
    const branch = findHydraulicEdge(solver.network, junction, deadEnd)

    advanceHydraulicSolver(solver, 10)
    const filledVolume = solver.state.volume[deadEnd]
    const outwardTransport = transportedToward(solver, branch, deadEnd)
    expect(filledVolume).toBeGreaterThan(0)
    expect(outwardTransport).toBeGreaterThan(0)

    setHydraulicSource(solver, false)
    let observedBackflow = false
    for (let step = 0; step < 2_400; step += 1) {
      stepHydraulicSolver(solver)
      const dischargeTowardDeadEnd =
        solver.network.edgeTo[branch] === deadEnd
          ? solver.state.discharge[branch]
          : -solver.state.discharge[branch]
      if (dischargeTowardDeadEnd < -1e-7) observedBackflow = true
    }

    expect(observedBackflow).toBe(true)
    expect(solver.state.volume[deadEnd]).toBeLessThan(filledVolume)
    expect(transportedToward(solver, branch, deadEnd)).toBeLessThan(
      outwardTransport,
    )
  })

  it('conserves the local volume balance where two branches merge', () => {
    const graph = graphWithPassages(4, 3, [
      [{ row: 0, col: 1 }, { row: 1, col: 1 }],
      [{ row: 1, col: 1 }, { row: 1, col: 0 }],
      [{ row: 1, col: 0 }, { row: 2, col: 0 }],
      [{ row: 2, col: 0 }, { row: 2, col: 1 }],
      [{ row: 1, col: 1 }, { row: 1, col: 2 }],
      [{ row: 1, col: 2 }, { row: 2, col: 2 }],
      [{ row: 2, col: 2 }, { row: 2, col: 1 }],
      [{ row: 2, col: 1 }, { row: 3, col: 1 }],
    ])
    const solver = solverFor(
      graph,
      { row: 0, col: 1 },
      { row: 3, col: 1 },
    )
    advanceHydraulicSolver(solver, 20)

    const left = solver.network.cellToNode[6]
    const merge = solver.network.cellToNode[7]
    const right = solver.network.cellToNode[8]
    const outlet = solver.network.cellToNode[10]
    const leftEdge = findHydraulicEdge(solver.network, left, merge)
    const rightEdge = findHydraulicEdge(solver.network, right, merge)
    const downstreamEdge = findHydraulicEdge(solver.network, merge, outlet)
    const branchInput =
      transportedToward(solver, leftEdge, merge) +
      transportedToward(solver, rightEdge, merge)
    const downstreamOutput = -transportedToward(
      solver,
      downstreamEdge,
      merge,
    )

    expect(transportedToward(solver, leftEdge, merge)).toBeGreaterThan(0)
    expect(transportedToward(solver, rightEdge, merge)).toBeGreaterThan(0)
    expect(downstreamOutput).toBeGreaterThan(0)
    expect(branchInput - downstreamOutput).toBeCloseTo(
      solver.state.volume[merge],
      10,
    )
  })

  it('is invariant to edge-array order on a loop and damps after source shutoff', () => {
    const graph = graphWithPassages(3, 3, loopPassages)
    const network = buildHydraulicNetwork(
      graph,
      { row: 0, col: 1 },
      { row: 2, col: 1 },
      { cellHeightMeters: 0.12, maxOpeningDepthMeters: 0.12 },
    )
    const options = {
      source: {
        targetFlowRateCubicMetersPerSecond: SOURCE_FLOW,
        rampDurationSeconds: 0.15,
      },
    } as const
    const normal = createHydraulicSolver(network, options)
    const reversed = createHydraulicSolver(cloneWithReversedEdges(network), options)
    advanceHydraulicSolver(normal, 12)
    advanceHydraulicSolver(reversed, 12)

    expect(reversed.cumulativeOutletVolume).toBeCloseTo(
      normal.cumulativeOutletVolume,
      10,
    )
    for (let node = 0; node < network.nodeCount; node += 1) {
      expect(reversed.state.depth[node]).toBeCloseTo(normal.state.depth[node], 10)
    }

    setHydraulicSource(normal, false)
    let earlyPeak = 0
    for (let step = 0; step < 240; step += 1) {
      stepHydraulicSolver(normal)
      for (const discharge of normal.state.discharge) {
        earlyPeak = Math.max(earlyPeak, Math.abs(discharge))
      }
    }
    let latePeak = 0
    for (let step = 0; step < 2_400; step += 1) {
      stepHydraulicSolver(normal)
      if (step >= 2_160) {
        for (const discharge of normal.state.discharge) {
          latePeak = Math.max(latePeak, Math.abs(discharge))
        }
      }
    }
    expect(earlyPeak).toBeGreaterThan(0)
    expect(latePeak).toBeLessThan(earlyPeak)
  })

  it('responds continuously to outlet head instead of switching a fixed flow on', () => {
    const graph = graphWithPassages(1, 1, [])
    const network = buildHydraulicNetwork(
      graph,
      { row: 0, col: 0 },
      { row: 0, col: 0 },
    )
    const area = network.storageArea[0]
    const makeSolver = (depth: number) =>
      createHydraulicSolver(network, {
        source: { enabled: false },
        initialVolumes: [area * depth],
      })
    const dry = makeSolver(0)
    const shallow = makeSolver(0.1)
    const slightlyDeeper = makeSolver(0.1001)

    stepHydraulicSolver(dry)
    stepHydraulicSolver(shallow)
    stepHydraulicSolver(slightlyDeeper)

    expect(dry.outletDischarge).toBe(0)
    expect(shallow.outletDischarge).toBeGreaterThan(0)
    expect(slightlyDeeper.outletDischarge).toBeGreaterThan(
      shallow.outletDischarge,
    )
    expect(
      (slightlyDeeper.outletDischarge - shallow.outletDischarge) /
        shallow.outletDischarge,
    ).toBeLessThan(0.01)
  })

  it('keeps every state finite, bounded and nonnegative under aggressive forcing', () => {
    const graph = graphWithPassages(3, 3, loopPassages)
    const solver = solverFor(
      graph,
      { row: 0, col: 1 },
      { row: 2, col: 1 },
      {
        source: {
          targetFlowRateCubicMetersPerSecond: 0.03,
          rampDurationSeconds: 0.1,
        },
        outlet: { openingAreaSquareMeters: 0.07 },
        maximumVelocityMetersPerSecond: 3,
      },
    )
    advanceHydraulicSolver(solver, 30)
    const diagnostics = getHydraulicDiagnostics(solver)

    for (const volume of solver.state.volume) {
      expect(Number.isFinite(volume)).toBe(true)
      expect(volume).toBeGreaterThanOrEqual(0)
    }
    for (const values of [
      solver.state.depth,
      solver.state.hydraulicHead,
      solver.state.netInflow,
      solver.state.pressureProxy,
      solver.state.discharge,
      solver.state.velocity,
      solver.state.openingArea,
      solver.state.cumulativeSignedVolume,
      solver.state.cumulativeAbsoluteVolume,
    ]) {
      for (const value of values) expect(Number.isFinite(value)).toBe(true)
    }
    expect(diagnostics.maxVelocity).toBeLessThanOrEqual(3)
    expect(Math.max(...solver.state.depth)).toBeLessThan(
      solver.network.geometry.maxOpeningDepthMeters * 5,
    )
    expect(diagnostics.relativeMassError).toBeLessThan(1e-5)
  })

  it('advances a 150x150 solver without recursion or typed-array bounds errors', () => {
    const generated = generateMaze({
      rows: 150,
      cols: 150,
      seed: 'hydraulic-solver-large',
      algorithm: 'dfs',
    })
    const network = buildHydraulicNetwork(
      generated.graph,
      generated.start,
      generated.end,
    )
    const solver = createHydraulicSolver(network, {
      source: {
        targetFlowRateCubicMetersPerSecond: SOURCE_FLOW,
        rampDurationSeconds: 0,
      },
    })

    advanceHydraulicSolver(solver, STEP_SECONDS * 3)
    const diagnostics = getHydraulicDiagnostics(solver)

    expect(solver.simulationTime).toBeCloseTo(STEP_SECONDS * 3, 12)
    expect(solver.state.volume).toHaveLength(22_500)
    expect(solver.state.discharge).toHaveLength(network.edgeCount)
    expect(solver.state.volume[network.sourceNode]).toBeGreaterThanOrEqual(0)
    expect(Number.isFinite(solver.state.volume[network.outletNode])).toBe(true)
    expect(Number.isFinite(diagnostics.currentStoredVolume)).toBe(true)
    expect(diagnostics.relativeMassError).toBeLessThan(1e-5)
  })
})
