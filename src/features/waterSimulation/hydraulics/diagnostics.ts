import type { HydraulicNetwork } from './network'

export interface HydraulicDiagnostics {
  simulationTime: number
  cumulativeInjectedVolume: number
  cumulativeOutletVolume: number
  currentStoredVolume: number
  expectedStoredVolume: number
  absoluteMassError: number
  relativeMassError: number
  maxVelocity: number
  activeFlowEdgeCount: number
  outletDischarge: number
}

export interface HydraulicDiagnosticSource {
  readonly network: HydraulicNetwork
  readonly state: {
    readonly volume: Float64Array
    readonly velocity: Float64Array
  }
  readonly simulationTime: number
  readonly initialStoredVolume: number
  readonly cumulativeInjectedVolume: number
  readonly cumulativeOutletVolume: number
  readonly outletDischarge: number
  readonly activeFlowThreshold: number
}

/** Re-sums node storage independently from the boundary integrators. */
export function getHydraulicDiagnostics(
  solver: HydraulicDiagnosticSource,
  target: HydraulicDiagnostics = {
    simulationTime: 0,
    cumulativeInjectedVolume: 0,
    cumulativeOutletVolume: 0,
    currentStoredVolume: 0,
    expectedStoredVolume: 0,
    absoluteMassError: 0,
    relativeMassError: 0,
    maxVelocity: 0,
    activeFlowEdgeCount: 0,
    outletDischarge: 0,
  },
): HydraulicDiagnostics {
  let stored = 0
  for (let node = 0; node < solver.network.nodeCount; node += 1) {
    stored += solver.state.volume[node]
  }
  let maxVelocity = 0
  let activeFlowEdgeCount = 0
  for (let edge = 0; edge < solver.network.edgeCount; edge += 1) {
    const velocity = Math.abs(solver.state.velocity[edge])
    if (velocity > maxVelocity) maxVelocity = velocity
    if (velocity > solver.activeFlowThreshold) activeFlowEdgeCount += 1
  }
  const expected =
    solver.initialStoredVolume +
    solver.cumulativeInjectedVolume -
    solver.cumulativeOutletVolume
  const absoluteMassError = Math.abs(expected - stored)
  const denominator = Math.max(Math.abs(expected), Math.abs(stored), 1e-12)

  target.simulationTime = solver.simulationTime
  target.cumulativeInjectedVolume = solver.cumulativeInjectedVolume
  target.cumulativeOutletVolume = solver.cumulativeOutletVolume
  target.currentStoredVolume = stored
  target.expectedStoredVolume = expected
  target.absoluteMassError = absoluteMassError
  target.relativeMassError = absoluteMassError / denominator
  target.maxVelocity = maxVelocity
  target.activeFlowEdgeCount = activeFlowEdgeCount
  target.outletDischarge = solver.outletDischarge
  return target
}
