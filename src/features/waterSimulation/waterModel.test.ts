import { describe, expect, it } from 'vitest'
import {
  createEmptyGraph,
  generateMaze,
  openPassage,
  type CellPosition,
  type MazeGraph,
} from '../../core/maze'
import {
  buildWaterSimulation,
  sampleWaterSimulation,
  type WaterSimulationModel,
} from './waterModel'

type Passage = readonly [CellPosition, CellPosition]

function createGraph(
  rows: number,
  cols: number,
  passages: readonly Passage[],
): MazeGraph {
  const graph = createEmptyGraph(rows, cols)
  for (const [from, to] of passages) {
    expect(openPassage(graph, from, to)).toBe(true)
  }
  return graph
}

function scheduleAt(
  model: WaterSimulationModel,
  row: number,
  col: number,
) {
  return model.cells.find(
    (cell) => cell.position.row === row && cell.position.col === col,
  )
}

function frameAt(
  model: WaterSimulationModel,
  elapsedMs: number,
  row: number,
  col: number,
) {
  return sampleWaterSimulation(model, elapsedMs).cells.find(
    (cell) => cell.position.row === row && cell.position.col === col,
  )
}

describe('buildWaterSimulation', () => {
  it('flows from the top source to the bottom exit in arrival order', () => {
    const graph = createGraph(3, 1, [
      [{ row: 0, col: 0 }, { row: 1, col: 0 }],
      [{ row: 1, col: 0 }, { row: 2, col: 0 }],
    ])

    const model = buildWaterSimulation(
      graph,
      { row: 0, col: 0 },
      { row: 2, col: 0 },
    )

    expect(model.reachedExit).toBe(true)
    expect(model.exitArrivalMs).toBe(420)
    expect(model.cells.map((cell) => cell.arrivalMs)).toEqual([0, 210, 420])
    expect(model.cells.map((cell) => cell.depth)).toEqual([0, 1, 2])
    expect(model.cells.map((cell) => cell.order)).toEqual([0, 1, 2])
    expect(model.cells.map((cell) => cell.branch)).toEqual([0, 0, 0])
    expect(model.segments).toHaveLength(2)
    expect(model.segments[0]).toMatchObject({
      fromIndex: 0,
      toIndex: 1,
      direction: 'bottom',
      departureMs: 120,
      arrivalMs: 210,
    })
  })

  it('strongly prefers down, then horizontal, then upward propagation', () => {
    const graph = createGraph(3, 3, [
      [{ row: 0, col: 0 }, { row: 1, col: 0 }],
      [{ row: 1, col: 0 }, { row: 1, col: 1 }],
      [{ row: 1, col: 1 }, { row: 2, col: 1 }],
      [{ row: 2, col: 1 }, { row: 2, col: 2 }],
      [{ row: 1, col: 1 }, { row: 1, col: 2 }],
      [{ row: 1, col: 1 }, { row: 0, col: 1 }],
    ])

    const model = buildWaterSimulation(
      graph,
      { row: 0, col: 0 },
      { row: 2, col: 2 },
    )
    const downward = scheduleAt(model, 2, 1)
    const horizontal = scheduleAt(model, 1, 2)
    const upward = scheduleAt(model, 0, 1)

    expect(downward?.arrivalMs).toBeLessThan(horizontal?.arrivalMs ?? 0)
    expect(horizontal?.arrivalMs).toBeLessThan(upward?.arrivalMs ?? 0)
    expect(
      (upward?.arrivalMs ?? 0) - (horizontal?.arrivalMs ?? 0),
    ).toBeGreaterThan(
      (horizontal?.arrivalMs ?? 0) - (downward?.arrivalMs ?? 0),
    )
    expect(model.reachedExit).toBe(true)
  })

  it('branches through every reachable corridor instead of following only the solution', () => {
    const graph = createGraph(3, 3, [
      [{ row: 0, col: 1 }, { row: 1, col: 1 }],
      [{ row: 1, col: 1 }, { row: 2, col: 1 }],
      [{ row: 1, col: 1 }, { row: 1, col: 0 }],
      [{ row: 1, col: 1 }, { row: 1, col: 2 }],
    ])
    const model = buildWaterSimulation(
      graph,
      { row: 0, col: 1 },
      { row: 2, col: 1 },
    )

    const reachable = model.cells.filter((cell) => cell.reachable)
    expect(reachable).toHaveLength(5)
    expect(scheduleAt(model, 2, 1)?.branch).toBe(0)
    expect(scheduleAt(model, 1, 2)?.branch).toBe(1)
    expect(scheduleAt(model, 1, 0)?.branch).toBe(2)
    expect(scheduleAt(model, 1, 0)?.isDeadEnd).toBe(true)
    expect(scheduleAt(model, 1, 2)?.isDeadEnd).toBe(true)
    expect(new Set(reachable.map((cell) => cell.order)).size).toBe(5)
  })

  it('slows each water front when the current cell splits into more branches', () => {
    const graph = createGraph(3, 3, [
      [{ row: 0, col: 1 }, { row: 1, col: 1 }],
      [{ row: 1, col: 1 }, { row: 2, col: 1 }],
      [{ row: 1, col: 1 }, { row: 1, col: 0 }],
      [{ row: 1, col: 1 }, { row: 1, col: 2 }],
    ])
    const unimpeded = buildWaterSimulation(
      graph,
      { row: 0, col: 1 },
      { row: 2, col: 1 },
      { branchSlowdown: 0 },
    )
    const split = buildWaterSimulation(
      graph,
      { row: 0, col: 1 },
      { row: 2, col: 1 },
      { branchSlowdown: 1 },
    )

    expect(scheduleAt(split, 2, 1)?.arrivalMs).toBeGreaterThan(
      scheduleAt(unimpeded, 2, 1)?.arrivalMs ?? Number.POSITIVE_INFINITY,
    )
    expect(scheduleAt(split, 1, 0)?.arrivalMs).toBeGreaterThan(
      scheduleAt(unimpeded, 1, 0)?.arrivalMs ?? Number.POSITIVE_INFINITY,
    )
  })

  it('marks low blind branches as pooled while the outlet route drains', () => {
    const graph = createGraph(4, 3, [
      [{ row: 0, col: 1 }, { row: 1, col: 1 }],
      [{ row: 1, col: 1 }, { row: 2, col: 1 }],
      [{ row: 2, col: 1 }, { row: 3, col: 1 }],
      [{ row: 1, col: 1 }, { row: 1, col: 0 }],
      [{ row: 1, col: 0 }, { row: 2, col: 0 }],
    ])
    const model = buildWaterSimulation(
      graph,
      { row: 0, col: 1 },
      { row: 3, col: 1 },
    )

    expect(scheduleAt(model, 0, 1)?.drainage).toBe('drains')
    expect(scheduleAt(model, 1, 0)?.drainage).toBe('drains')
    expect(scheduleAt(model, 2, 0)).toMatchObject({
      drainage: 'pools',
      retainedLevel: 0.92,
      isDeadEnd: true,
    })
    expect(scheduleAt(model, 3, 1)?.drainage).toBe('exit')
  })

  it('returns an unreachable exit without inventing flow through walls', () => {
    const graph = createGraph(3, 2, [
      [{ row: 0, col: 0 }, { row: 1, col: 0 }],
    ])
    const model = buildWaterSimulation(
      graph,
      { row: 0, col: 0 },
      { row: 2, col: 1 },
    )

    expect(model.reachedExit).toBe(false)
    expect(model.exitArrivalMs).toBeNull()
    expect(scheduleAt(model, 2, 1)).toMatchObject({
      reachable: false,
      arrivalMs: null,
      fullMs: null,
      depth: null,
      branch: null,
      order: null,
      drainage: 'unreachable',
    })
    expect(model.segments).toHaveLength(1)
  })

  it('is deterministic and never mutates the maze graph', () => {
    const graph = createGraph(3, 3, [
      [{ row: 0, col: 1 }, { row: 1, col: 1 }],
      [{ row: 1, col: 1 }, { row: 2, col: 1 }],
      [{ row: 1, col: 1 }, { row: 1, col: 0 }],
      [{ row: 1, col: 1 }, { row: 1, col: 2 }],
    ])
    const before = structuredClone(graph)

    const first = buildWaterSimulation(
      graph,
      { row: 0, col: 1 },
      { row: 2, col: 1 },
    )
    const second = buildWaterSimulation(
      graph,
      { row: 0, col: 1 },
      { row: 2, col: 1 },
    )

    expect(second).toEqual(first)
    expect(graph).toEqual(before)
  })

  it('handles a 150 by 150 maze without recursion or omitted corridors', () => {
    const generated = generateMaze({
      rows: 150,
      cols: 150,
      seed: 'large-water-model',
      algorithm: 'dfs',
    })
    const model = buildWaterSimulation(
      generated.graph,
      generated.start,
      generated.end,
      { enforceVerticalEndpoints: false },
    )

    expect(model.cells.filter((cell) => cell.reachable)).toHaveLength(22_500)
    expect(model.segments).toHaveLength(22_499)
    expect(model.reachedExit).toBe(true)
    expect(model.totalDurationMs).toBeGreaterThan(model.exitArrivalMs ?? 0)
  })

  it('uses the topmost and bottommost active mask rows for vertical endpoints', () => {
    const graph = createEmptyGraph(5, 3, {
      mask: [
        false, false, false,
        false, true, false,
        false, true, false,
        false, true, false,
        false, false, false,
      ],
    })
    openPassage(graph, { row: 1, col: 1 }, { row: 2, col: 1 })
    openPassage(graph, { row: 2, col: 1 }, { row: 3, col: 1 })

    expect(() =>
      buildWaterSimulation(
        graph,
        { row: 1, col: 1 },
        { row: 3, col: 1 },
      ),
    ).not.toThrow()
  })

  it('rejects non-vertical endpoints by default and allows an explicit override', () => {
    const graph = createGraph(3, 1, [
      [{ row: 0, col: 0 }, { row: 1, col: 0 }],
      [{ row: 1, col: 0 }, { row: 2, col: 0 }],
    ])

    expect(() =>
      buildWaterSimulation(
        graph,
        { row: 1, col: 0 },
        { row: 2, col: 0 },
      ),
    ).toThrow('topmost')
    expect(() =>
      buildWaterSimulation(
        graph,
        { row: 0, col: 0 },
        { row: 1, col: 0 },
      ),
    ).toThrow('bottommost')
    expect(() =>
      buildWaterSimulation(
        graph,
        { row: 1, col: 0 },
        { row: 2, col: 0 },
        { enforceVerticalEndpoints: false },
      ),
    ).not.toThrow()
  })

  it('rejects inactive endpoints and invalid physical settings', () => {
    const graph = createEmptyGraph(2, 2, {
      mask: [true, false, true, true],
    })
    openPassage(graph, { row: 0, col: 0 }, { row: 1, col: 0 })
    openPassage(graph, { row: 1, col: 0 }, { row: 1, col: 1 })

    expect(() =>
      buildWaterSimulation(
        graph,
        { row: 0, col: 1 },
        { row: 1, col: 1 },
      ),
    ).toThrow('source')
    expect(() =>
      buildWaterSimulation(
        graph,
        { row: 0, col: 0 },
        { row: 1, col: 1 },
        { downwardTravelMs: 0 },
      ),
    ).toThrow('downwardTravelMs')
    expect(() =>
      buildWaterSimulation(
        graph,
        { row: 0, col: 0 },
        { row: 1, col: 1 },
        { residualFilmLevel: 0.8, pooledLevel: 0.5 },
      ),
    ).toThrow('pooledLevel')
  })
})

describe('sampleWaterSimulation', () => {
  it('interpolates fill levels, then drains corridors while retaining pools', () => {
    const graph = createGraph(4, 3, [
      [{ row: 0, col: 1 }, { row: 1, col: 1 }],
      [{ row: 1, col: 1 }, { row: 2, col: 1 }],
      [{ row: 2, col: 1 }, { row: 3, col: 1 }],
      [{ row: 1, col: 1 }, { row: 1, col: 0 }],
      [{ row: 1, col: 0 }, { row: 2, col: 0 }],
    ])
    const model = buildWaterSimulation(
      graph,
      { row: 0, col: 1 },
      { row: 3, col: 1 },
    )

    expect(frameAt(model, 60, 0, 1)).toMatchObject({
      level: 0.5,
      state: 'filling',
    })
    expect(frameAt(model, 60, 1, 1)).toMatchObject({
      level: 0,
      state: 'dry',
    })
    expect(sampleWaterSimulation(model, model.exitArrivalMs ?? 0).reachedExit)
      .toBe(true)

    const completed = sampleWaterSimulation(model, model.totalDurationMs)
    expect(completed.progress).toBe(1)
    expect(frameAt(model, model.totalDurationMs, 0, 1)).toMatchObject({
      level: 0.06,
      state: 'wet',
    })
    expect(frameAt(model, model.totalDurationMs, 2, 0)).toMatchObject({
      level: 0.92,
      state: 'pooled',
    })
    expect(frameAt(model, model.totalDurationMs, 3, 1)).toMatchObject({
      level: 0,
      state: 'outlet',
    })
  })

  it('keeps reachedExit false until the exact exit arrival time', () => {
    const graph = createGraph(2, 1, [
      [{ row: 0, col: 0 }, { row: 1, col: 0 }],
    ])
    const model = buildWaterSimulation(
      graph,
      { row: 0, col: 0 },
      { row: 1, col: 0 },
    )
    const exitArrival = model.exitArrivalMs ?? 0

    expect(sampleWaterSimulation(model, exitArrival - 0.001).reachedExit).toBe(
      false,
    )
    expect(sampleWaterSimulation(model, exitArrival).reachedExit).toBe(true)
  })

  it('clamps invalid or negative sample time without changing the model', () => {
    const graph = createGraph(2, 1, [
      [{ row: 0, col: 0 }, { row: 1, col: 0 }],
    ])
    const model = buildWaterSimulation(
      graph,
      { row: 0, col: 0 },
      { row: 1, col: 0 },
    )
    const before = structuredClone(model)

    expect(sampleWaterSimulation(model, Number.NaN).elapsedMs).toBe(0)
    expect(sampleWaterSimulation(model, -500).elapsedMs).toBe(0)
    expect(model).toEqual(before)
  })
})
