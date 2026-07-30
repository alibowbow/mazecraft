import type { WaterSimulationModel } from './waterModel'

export interface WaterPlaybackBudget {
  /** Latest acceptable first arrival at the bottom outlet. */
  maxExitMs: number
  /** Latest acceptable time for any reachable branch to finish filling. */
  maxFlowMs: number
}

const roundTime = (value: number) =>
  Math.round((value + Number.EPSILON) * 1_000) / 1_000

const assertPositiveFinite = (name: string, value: number) => {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number.`)
  }
}

/**
 * Compresses only the propagation portion of a water model so large or
 * winding mazes keep a cinematic, bounded runtime. Drain and settle durations
 * stay unchanged, preserving the same readable outlet beat on every grid.
 */
export function fitWaterSimulationToBudget(
  model: WaterSimulationModel,
  budget: WaterPlaybackBudget,
): WaterSimulationModel {
  assertPositiveFinite('maxExitMs', budget.maxExitMs)
  assertPositiveFinite('maxFlowMs', budget.maxFlowMs)

  const latestFullMs = model.cells.reduce(
    (latest, cell) => Math.max(latest, cell.fullMs ?? 0),
    0,
  )
  let scale = latestFullMs > 0
    ? Math.min(1, budget.maxFlowMs / latestFullMs)
    : 1
  if (model.exitArrivalMs !== null && model.exitArrivalMs > 0) {
    scale = Math.min(scale, budget.maxExitMs / model.exitArrivalMs)
  }
  if (scale >= 1) return model

  const scaleNullableTime = (value: number | null) =>
    value === null ? null : roundTime(value * scale)
  const cells = model.cells.map((cell) => ({
    ...cell,
    arrivalMs: scaleNullableTime(cell.arrivalMs),
    fullMs: scaleNullableTime(cell.fullMs),
  }))
  const segments = model.segments.map((segment) => ({
    ...segment,
    departureMs: roundTime(segment.departureMs * scale),
    arrivalMs: roundTime(segment.arrivalMs * scale),
  }))
  const exitArrivalMs = scaleNullableTime(model.exitArrivalMs)
  const scaledLatestFullMs = cells.reduce(
    (latest, cell) => Math.max(latest, cell.fullMs ?? 0),
    0,
  )
  const options = {
    ...model.options,
    downwardTravelMs: model.options.downwardTravelMs * scale,
    horizontalTravelMs: model.options.horizontalTravelMs * scale,
    upwardTravelMs: model.options.upwardTravelMs * scale,
    cellFillMs: model.options.cellFillMs * scale,
  }
  const globalDrainStart =
    exitArrivalMs === null
      ? scaledLatestFullMs
      : exitArrivalMs + options.drainDelayMs
  const totalDurationMs = roundTime(
    model.reachedExit
      ? Math.max(scaledLatestFullMs, globalDrainStart) +
          options.drainDurationMs
      : scaledLatestFullMs,
  )

  return {
    ...model,
    cells,
    segments,
    options,
    exitArrivalMs,
    totalDurationMs,
  }
}
