import { describe, expect, it } from 'vitest'
import { createEmptyGraph, openPassage } from '../../core/maze'
import { buildWaterSimulation } from './waterModel'
import { fitWaterSimulationToBudget } from './waterPlaybackTiming'

const createVerticalGraph = () => {
  const graph = createEmptyGraph(4, 1)
  for (let row = 0; row < 3; row += 1) {
    openPassage(
      graph,
      { row, col: 0 },
      { row: row + 1, col: 0 },
    )
  }
  return graph
}

describe('fitWaterSimulationToBudget', () => {
  it('bounds long propagation while preserving order and drain timing', () => {
    const model = buildWaterSimulation(
      createVerticalGraph(),
      { row: 0, col: 0 },
      { row: 3, col: 0 },
      {
        downwardTravelMs: 1_000,
        cellFillMs: 500,
        drainDelayMs: 620,
        drainDurationMs: 1_500,
      },
    )
    const fitted = fitWaterSimulationToBudget(model, {
      maxExitMs: 2_200,
      maxFlowMs: 2_500,
    })

    expect(fitted).not.toBe(model)
    expect(fitted.exitArrivalMs).toBeLessThanOrEqual(2_200)
    expect(Math.max(...fitted.cells.map((cell) => cell.fullMs ?? 0)))
      .toBeLessThanOrEqual(2_500)
    expect(fitted.cells.map((cell) => cell.arrivalMs)).toEqual(
      [...fitted.cells]
        .sort((left, right) => left.index - right.index)
        .map((cell) => cell.arrivalMs),
    )
    expect(fitted.options.drainDelayMs).toBe(620)
    expect(fitted.options.drainDurationMs).toBe(1_500)
    expect(fitted.totalDurationMs).toBeGreaterThan(
      fitted.exitArrivalMs ?? 0,
    )
  })

  it('returns the original model when it already fits the budget', () => {
    const model = buildWaterSimulation(
      createVerticalGraph(),
      { row: 0, col: 0 },
      { row: 3, col: 0 },
    )

    expect(
      fitWaterSimulationToBudget(model, {
        maxExitMs: 20_000,
        maxFlowMs: 25_000,
      }),
    ).toBe(model)
  })

  it('rejects invalid playback budgets', () => {
    const model = buildWaterSimulation(
      createVerticalGraph(),
      { row: 0, col: 0 },
      { row: 3, col: 0 },
    )

    expect(() =>
      fitWaterSimulationToBudget(model, {
        maxExitMs: 0,
        maxFlowMs: 1_000,
      }),
    ).toThrow('maxExitMs')
  })
})
