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

  it('keeps an upward blind branch dry while feeding lower and level storage', () => {
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
    expect(horizontal).toMatchObject({
      reachable: true,
      drainage: 'drains',
    })
    expect(horizontal?.peakLevel).toBe(model.options.minimumWetLevel)
    expect(upward).toMatchObject({
      reachable: false,
      arrivalMs: null,
      peakLevel: 0,
    })
    expect(model.reachedExit).toBe(true)
  })

  it('spreads one conserved wetting front through symmetric level branches', () => {
    const graph = createGraph(3, 5, [
      [{ row: 0, col: 2 }, { row: 1, col: 2 }],
      [{ row: 1, col: 2 }, { row: 2, col: 2 }],
      [{ row: 1, col: 2 }, { row: 1, col: 1 }],
      [{ row: 1, col: 1 }, { row: 1, col: 0 }],
      [{ row: 1, col: 2 }, { row: 1, col: 3 }],
      [{ row: 1, col: 3 }, { row: 1, col: 4 }],
    ])
    const model = buildWaterSimulation(
      graph,
      { row: 0, col: 2 },
      { row: 2, col: 2 },
    )

    const reachable = model.cells.filter((cell) => cell.reachable)
    expect(reachable).toHaveLength(7)
    expect(scheduleAt(model, 2, 2)?.branch).toBe(0)
    expect(scheduleAt(model, 1, 1)?.peakLevel).toBeCloseTo(
      scheduleAt(model, 1, 3)?.peakLevel ?? 0,
      8,
    )
    expect(scheduleAt(model, 1, 0)?.peakLevel).toBeCloseTo(
      scheduleAt(model, 1, 4)?.peakLevel ?? 0,
      8,
    )
    expect(model.massBalance.injectedBeforeBreakthrough).toBe(
      model.massBalance.storedAtBreakthrough,
    )
    expect(model.massBalance.conservationError).toBeLessThan(1e-8)
    expect(new Set(reachable.map((cell) => cell.order)).size).toBe(7)
  })

  it('wets complete lower side passages before climbing an uphill outlet route', () => {
    const graph = createGraph(5, 5, [
      [{ row: 0, col: 2 }, { row: 1, col: 2 }],
      [{ row: 1, col: 2 }, { row: 2, col: 2 }],
      [{ row: 2, col: 2 }, { row: 3, col: 2 }],
      [{ row: 3, col: 2 }, { row: 3, col: 3 }],
      [{ row: 3, col: 3 }, { row: 2, col: 3 }],
      [{ row: 2, col: 3 }, { row: 2, col: 4 }],
      [{ row: 2, col: 4 }, { row: 3, col: 4 }],
      [{ row: 3, col: 4 }, { row: 4, col: 4 }],
      [{ row: 1, col: 2 }, { row: 1, col: 1 }],
      [{ row: 1, col: 1 }, { row: 2, col: 1 }],
      [{ row: 3, col: 2 }, { row: 3, col: 1 }],
      [{ row: 3, col: 1 }, { row: 4, col: 1 }],
    ])
    const model = buildWaterSimulation(
      graph,
      { row: 0, col: 2 },
      { row: 4, col: 4 },
    )
    const earlySide = scheduleAt(model, 2, 1)
    const lateSide = scheduleAt(model, 4, 1)
    const uphill = scheduleAt(model, 2, 3)

    expect(earlySide).toMatchObject({ reachable: true })
    expect(lateSide).toMatchObject({ reachable: true })
    expect(earlySide?.peakLevel).toBeGreaterThanOrEqual(
      model.options.minimumWetLevel,
    )
    expect(lateSide?.peakLevel).toBeGreaterThanOrEqual(
      model.options.minimumWetLevel,
    )
    expect(lateSide?.arrivalMs).toBeLessThan(uphill?.arrivalMs ?? 0)
  })

  it('splits source volume fairly into level branches before outlet flow', () => {
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

    expect(scheduleAt(model, 1, 0)).toMatchObject({
      reachable: true,
      peakLevel: model.options.minimumWetLevel,
    })
    expect(scheduleAt(model, 1, 2)).toMatchObject({
      reachable: true,
      peakLevel: model.options.minimumWetLevel,
    })
    expect(scheduleAt(model, 1, 0)?.arrivalMs).toBe(
      scheduleAt(model, 1, 2)?.arrivalMs,
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
      isDeadEnd: true,
    })
    expect(scheduleAt(model, 2, 0)?.retainedLevel).toBe(
      scheduleAt(model, 2, 0)?.peakLevel,
    )
    expect(scheduleAt(model, 2, 0)?.retainedLevel).toBeLessThan(
      model.options.pooledLevel,
    )
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

  it('handles a 150 by 150 maze without recursion or leaving the active graph', () => {
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

    const wetCells = model.cells.filter((cell) => cell.reachable)
    expect(wetCells.length).toBeGreaterThan(0)
    expect(wetCells.length).toBeLessThanOrEqual(22_500)
    expect(model.segments).toHaveLength(wetCells.length - 1)
    expect(model.reachedExit).toBe(true)
    expect(model.totalDurationMs).toBeGreaterThan(model.exitArrivalMs ?? 0)
    expect(model.massBalance.conservationError).toBeLessThan(1e-8)
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
    expect(() =>
      buildWaterSimulation(
        graph,
        { row: 0, col: 0 },
        { row: 1, col: 1 },
        { minimumWetLevel: 0.8 },
      ),
    ).toThrow('minimumWetLevel')
  })
})

describe('sampleWaterSimulation', () => {
  it('interpolates fill levels, then establishes through-flow while retaining pools', () => {
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
      level: (scheduleAt(model, 0, 1)?.peakLevel ?? 0) / 2,
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
      level: scheduleAt(model, 0, 1)?.retainedLevel,
      state: 'wet',
    })
    expect(frameAt(model, model.totalDurationMs, 2, 0)).toMatchObject({
      state: 'pooled',
    })
    expect(frameAt(model, model.totalDurationMs, 2, 0)?.level).toBe(
      scheduleAt(model, 2, 0)?.retainedLevel,
    )
    expect(frameAt(model, model.totalDurationMs, 3, 1)).toMatchObject({
      level: scheduleAt(model, 3, 1)?.retainedLevel,
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
