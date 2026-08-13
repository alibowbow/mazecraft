export interface PrescribedInflowBoundary {
  /** Steady prescribed volume flow, cubic metres per second. */
  targetFlowRateCubicMetersPerSecond: number
  /** Linear ramp duration from zero to target flow, seconds. */
  rampDurationSeconds: number
  /** Simulation time at which the source begins, seconds. */
  startTimeSeconds: number
  enabled: boolean
}

export interface OutletBoundary {
  mode: 'orifice' | 'weir'
  /** Hydraulic head of the receiving environment, metres. */
  boundaryHeadMeters: number
  dischargeCoefficient: number
  /** Orifice area, square metres. */
  openingAreaSquareMeters: number
  /** Broad-crested weir width, metres. */
  weirWidthMeters: number
  gravityMetersPerSecondSquared: number
}

export const DEFAULT_PRESCRIBED_INFLOW: Readonly<PrescribedInflowBoundary> = {
  targetFlowRateCubicMetersPerSecond: 0.018,
  rampDurationSeconds: 0.75,
  startTimeSeconds: 0,
  enabled: true,
}

export const DEFAULT_OUTLET_BOUNDARY: Readonly<OutletBoundary> = {
  mode: 'orifice',
  boundaryHeadMeters: 0,
  dischargeCoefficient: 0.62,
  openingAreaSquareMeters: 0.04,
  weirWidthMeters: 0.58,
  gravityMetersPerSecondSquared: 9.81,
}

function assertFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite.`)
}

function assertNonNegative(name: string, value: number): void {
  assertFinite(name, value)
  if (value < 0) throw new RangeError(`${name} must be non-negative.`)
}

export function prescribedRampInflow(
  simulationTimeSeconds: number,
  boundary: Readonly<PrescribedInflowBoundary> = DEFAULT_PRESCRIBED_INFLOW,
): number {
  assertFinite('simulationTimeSeconds', simulationTimeSeconds)
  assertNonNegative(
    'targetFlowRateCubicMetersPerSecond',
    boundary.targetFlowRateCubicMetersPerSecond,
  )
  assertNonNegative('rampDurationSeconds', boundary.rampDurationSeconds)
  assertFinite('startTimeSeconds', boundary.startTimeSeconds)
  if (!boundary.enabled || simulationTimeSeconds <= boundary.startTimeSeconds) return 0
  if (boundary.rampDurationSeconds === 0) {
    return boundary.targetFlowRateCubicMetersPerSecond
  }
  const progress = Math.min(
    1,
    (simulationTimeSeconds - boundary.startTimeSeconds) /
      boundary.rampDurationSeconds,
  )
  return boundary.targetFlowRateCubicMetersPerSecond * progress
}

/** Head-responsive open boundary. Returned discharge is always outward. */
export function outletDischarge(
  exitHydraulicHeadMeters: number,
  boundary: Readonly<OutletBoundary> = DEFAULT_OUTLET_BOUNDARY,
): number {
  assertFinite('exitHydraulicHeadMeters', exitHydraulicHeadMeters)
  assertFinite('boundaryHeadMeters', boundary.boundaryHeadMeters)
  assertNonNegative('dischargeCoefficient', boundary.dischargeCoefficient)
  assertNonNegative('openingAreaSquareMeters', boundary.openingAreaSquareMeters)
  assertNonNegative('weirWidthMeters', boundary.weirWidthMeters)
  assertNonNegative(
    'gravityMetersPerSecondSquared',
    boundary.gravityMetersPerSecondSquared,
  )
  const excessHead = Math.max(
    0,
    exitHydraulicHeadMeters - boundary.boundaryHeadMeters,
  )
  if (excessHead === 0) return 0
  if (boundary.mode === 'weir') {
    return (
      boundary.dischargeCoefficient *
      boundary.weirWidthMeters *
      Math.sqrt(2 * boundary.gravityMetersPerSecondSquared) *
      Math.pow(excessHead, 1.5)
    )
  }
  return (
    boundary.dischargeCoefficient *
    boundary.openingAreaSquareMeters *
    Math.sqrt(2 * boundary.gravityMetersPerSecondSquared * excessHead)
  )
}
