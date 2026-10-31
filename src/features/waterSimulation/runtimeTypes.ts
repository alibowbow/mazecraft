/** Contracts between the water runtime and the screens that show it. */

export type ResolvedWaterQuality = 'low' | 'high'

export type WaterSurfaceStyle = 'calm' | 'natural' | 'dynamic'

export type WaterInletState = 'off' | 'falling' | 'impact' | 'steady'

/** Where the physics runs: the fluid worker, or the main thread (3D basins, no-Worker fallback). */
export type WaterSolverMode = 'worker' | 'main-thread'

export type WaterFoamMode = 'procedural' | 'history'

export interface WaterPlaybackStatus {
  elapsedMs: number
  simulationTime: number
  filledCells: number
  totalCells: number
  reachedExit: boolean
  complete: boolean
  inletState: WaterInletState
  inletVisible: boolean
  outletVisible: boolean
  activeFlowEdgeCount: number
  cumulativeInjectedVolume: number
  cumulativeOutletVolume: number
  currentStoredVolume: number
  absoluteMassError: number
  relativeMassError: number
  maxVelocity: number
  outletDischarge: number
}

export interface WaterRuntimeMetrics {
  atlasWidth: number
  atlasHeight: number
  closedWallLeakTexels: number
  drawCalls: number
  triangles: number
  inletDropHeight: number
  inletContactGap: number
  outletDropHeight: number
  physicsStepHz: number
  snapshotHz: number
  solverMode: WaterSolverMode
  waveBands: number
  foamMode: WaterFoamMode
}
