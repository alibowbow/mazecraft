export const WATER_INLET_IMPACT_MS = 820
export const WATER_INLET_IMPACT_BURST_MS = 620

export type WaterInletState =
  | 'off'
  | 'falling'
  | 'impact'
  | 'steady'
  | 'fading'

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

export function sampleWaterInlet(
  elapsedMs: number,
  completeAtMs: number,
): WaterInletSample {
  const elapsed = Math.max(0, Number.isFinite(elapsedMs) ? elapsedMs : 0)
  const completeAt = Math.max(
    WATER_INLET_IMPACT_MS + 1,
    Number.isFinite(completeAtMs) ? completeAtMs : WATER_INLET_IMPACT_MS + 1,
  )
  const fadeStart = Math.max(
    WATER_INLET_IMPACT_MS + WATER_INLET_IMPACT_BURST_MS,
    completeAt - 520,
  )
  const fade = 1 - smoothstep(fadeStart, completeAt, elapsed)
  const strength = smoothstep(0, 190, elapsed) * fade
  const frontProgress = smoothstep(40, WATER_INLET_IMPACT_MS, elapsed)
  const impactStrength =
    smoothstep(
      WATER_INLET_IMPACT_MS,
      WATER_INLET_IMPACT_MS + 165,
      elapsed,
    ) * fade

  let state: WaterInletState
  if (elapsed <= 0 || strength <= 0.001) state = 'off'
  else if (elapsed < WATER_INLET_IMPACT_MS) state = 'falling'
  else if (elapsed < WATER_INLET_IMPACT_MS + WATER_INLET_IMPACT_BURST_MS) {
    state = 'impact'
  } else if (elapsed < fadeStart) state = 'steady'
  else state = 'fading'

  return { state, strength, frontProgress, impactStrength }
}

export function getWaterFlowElapsedMs(elapsedMs: number): number {
  return Math.max(0, elapsedMs - WATER_INLET_IMPACT_MS)
}
