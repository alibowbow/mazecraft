import { describe, expect, it } from 'vitest'
import {
  createEmptyGraph,
  generateMaze,
  openPassage,
  type CellPosition,
  type MazeGraph,
} from '../../../core/maze'
import {
  buildHydraulicNetwork,
  findHydraulicEdge,
  findHydraulicNode,
  outletDischarge,
  prescribedRampInflow,
} from './index'

type Passage = readonly [CellPosition, CellPosition]

function graphWithPassages(
  rows: number,
  cols: number,
  passages: readonly Passage[],
  mask?: boolean[],
): MazeGraph {
  const graph = createEmptyGraph(rows, cols, { mask })
  for (const [from, to] of passages) expect(openPassage(graph, from, to)).toBe(true)
  return graph
}

describe('buildHydraulicNetwork', () => {
  it('packs active masked cells and preserves bidirectional cell mappings', () => {
    const graph = graphWithPassages(
      3,
      3,
      [[{ row: 0, col: 1 }, { row: 1, col: 1 }]],
      [false, true, false, false, true, true, false, false, false],
    )
    const network = buildHydraulicNetwork(
      graph,
      { row: 0, col: 1 },
      { row: 1, col: 2 },
    )

    expect(network.nodeCount).toBe(3)
    expect(Array.from(network.nodeCellIndex)).toEqual([1, 4, 5])
    expect(Array.from(network.cellToNode)).toEqual([-1, 0, -1, -1, 1, 2, -1, -1, -1])
    expect(findHydraulicNode(network, { row: 1, col: 2 })).toBe(2)
    expect(findHydraulicNode(network, { row: 2, col: 0 })).toBe(-1)
  })

  it('creates each reciprocal open passage once and builds complete CSR adjacency', () => {
    const graph = graphWithPassages(2, 2, [
      [{ row: 0, col: 0 }, { row: 0, col: 1 }],
      [{ row: 0, col: 0 }, { row: 1, col: 0 }],
      [{ row: 0, col: 1 }, { row: 1, col: 1 }],
      [{ row: 1, col: 0 }, { row: 1, col: 1 }],
    ])
    const network = buildHydraulicNetwork(
      graph,
      { row: 0, col: 0 },
      { row: 1, col: 1 },
    )

    expect(network.edgeCount).toBe(4)
    expect(network.adjacencyEdges).toHaveLength(8)
    expect(Array.from(network.adjacencyOffsets)).toEqual([0, 2, 4, 6, 8])
    expect(findHydraulicEdge(network, 0, 1)).toBeGreaterThanOrEqual(0)
    expect(findHydraulicEdge(network, 1, 0)).toBe(findHydraulicEdge(network, 0, 1))
    expect(findHydraulicEdge(network, 0, 3)).toBe(-1)
  })

  it('uses row-down elevations and higher-floor sills for vertical spill edges', () => {
    const graph = graphWithPassages(3, 1, [
      [{ row: 0, col: 0 }, { row: 1, col: 0 }],
      [{ row: 1, col: 0 }, { row: 2, col: 0 }],
    ])
    const network = buildHydraulicNetwork(
      graph,
      { row: 0, col: 0 },
      { row: 2, col: 0 },
      { cellHeightMeters: 0.5 },
    )

    expect(Array.from(network.elevation)).toEqual([1, 0.5, 0])
    expect(Array.from(network.edgeSillElevation)).toEqual([1, 0.5])
    expect(network.edgeLength.every((length) => length === 0.5)).toBe(true)
    expect(network.sourceNode).toBe(0)
    expect(network.outletNode).toBe(2)
  })

  it('builds a 150x150 packed network without recursion or inactive access', () => {
    const generated = generateMaze({
      rows: 150,
      cols: 150,
      seed: 'hydraulic-network-large',
      algorithm: 'dfs',
    })
    const network = buildHydraulicNetwork(
      generated.graph,
      generated.start,
      generated.end,
    )

    expect(network.nodeCount).toBe(22_500)
    expect(network.edgeCount).toBe(22_499)
    expect(network.adjacencyEdges).toHaveLength(44_998)
    expect(network.nodeCellIndex[22_499]).toBe(22_499)
    expect(network.adjacencyOffsets[network.nodeCount]).toBe(network.edgeCount * 2)
  })
})

describe('hydraulic boundaries', () => {
  it('ramps prescribed inflow continuously and can be disabled', () => {
    const boundary = {
      targetFlowRateCubicMetersPerSecond: 0.02,
      rampDurationSeconds: 2,
      startTimeSeconds: 1,
      enabled: true,
    }
    expect(prescribedRampInflow(1, boundary)).toBe(0)
    expect(prescribedRampInflow(2, boundary)).toBeCloseTo(0.01)
    expect(prescribedRampInflow(4, boundary)).toBeCloseTo(0.02)
    expect(prescribedRampInflow(4, { ...boundary, enabled: false })).toBe(0)
  })

  it('makes outlet flow a continuous increasing function of excess head', () => {
    const dry = outletDischarge(0)
    const shallow = outletDischarge(0.1)
    const deep = outletDischarge(0.4)
    expect(dry).toBe(0)
    expect(shallow).toBeGreaterThan(0)
    expect(deep).toBeGreaterThan(shallow)
  })
})
