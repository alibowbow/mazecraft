export const WATER_INLET_IMPACT_MS = 820
export const WATER_INLET_IMPACT_BURST_MS = 620
export const WATER_SURFACE_COUPLING_MS = 105

export type WaterInletState =
  | 'off'
  | 'falling'
  | 'impact'
  | 'steady'

export interface WaterInletLayout {
  boardTopY: number
  impactY: number
  nozzleY: number
  reservoirY: number
  dropHeight: number
}

export interface WaterInletSample {
  state: WaterInletState
  strength: number
  frontProgress: number
  impactStrength: number
}

export interface WaterHandoffSample extends WaterInletSample {
  surfaceGate: number
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value))

const smoothstep = (minimum: number, maximum: number, value: number) => {
  const normalized = clamp01(
    (value - minimum) / Math.max(0.0001, maximum - minimum),
  )
  return normalized * normalized * (3 - 2 * normalized)
}

/**
 * Positions the feed tank far enough above the entrance for gravity to read
 * clearly in a full-board shot. The impact follows the actual source cell,
 * which also keeps masked mazes and non-rectangular top edges aligned.
 */
export function resolveWaterInletLayout(
  graphRows: number,
  sourceY: number,
): WaterInletLayout {
  if (!Number.isFinite(graphRows) || graphRows <= 0) {
    throw new RangeError('graphRows must be a positive finite number.')
  }
  if (!Number.isFinite(sourceY)) {
    throw new RangeError('sourceY must be finite.')
  }

  const boardTopY = graphRows / 2
  // Anchor the feed to the actual entrance rather than the rectangular graph
  // boundary. Text and shape masks can leave many inactive rows above their
  // first opening; using boardTopY there produces an implausibly long jet.
  const dropHeight = Math.min(
    2.65,
    Math.max(2.08, 2.02 + graphRows * 0.009),
  )
  const nozzleY = sourceY + dropHeight
  const reservoirY = nozzleY + 0.68

  return {
    boardTopY,
    impactY: sourceY,
    nozzleY,
    reservoirY,
    dropHeight,
  }
}

export function sampleWaterInlet(elapsedMs: number): WaterInletSample {
  const elapsed = Math.max(0, Number.isFinite(elapsedMs) ? elapsedMs : 0)
  // The tank is a continuous feed. Reaching the outlet establishes a steady
  // through-flow; it must never turn the inlet off or stop the scene.
  const strength = smoothstep(0, 190, elapsed)
  const frontProgress = smoothstep(40, WATER_INLET_IMPACT_MS, elapsed)
  const impactStrength =
    smoothstep(
      WATER_INLET_IMPACT_MS,
      WATER_INLET_IMPACT_MS + 165,
      elapsed,
    )

  let state: WaterInletState
  if (elapsed <= 0 || strength <= 0.001) state = 'off'
  else if (elapsed < WATER_INLET_IMPACT_MS) state = 'falling'
  else if (elapsed < WATER_INLET_IMPACT_MS + WATER_INLET_IMPACT_BURST_MS) {
    state = 'impact'
  } else state = 'steady'

  return { state, strength, frontProgress, impactStrength }
}

export function getWaterFlowElapsedMs(elapsedMs: number): number {
  return Math.max(0, elapsedMs - WATER_INLET_IMPACT_MS)
}

export function sampleWaterHandoff(elapsedMs: number): WaterHandoffSample {
  const inlet = sampleWaterInlet(elapsedMs)
  return {
    ...inlet,
    surfaceGate: smoothstep(
      WATER_INLET_IMPACT_MS,
      WATER_INLET_IMPACT_MS + WATER_SURFACE_COUPLING_MS,
      Math.max(0, Number.isFinite(elapsedMs) ? elapsedMs : 0),
    ),
  }
}
