/** Coordinates are maze-cell units, x rightwards and y downwards. */
export interface FluidWall { x0: number; y0: number; x1: number; y1: number }

export interface FluidLayout {
  rows: number
  cols: number
  activeCellCount: number
  activeCells: Uint8Array
  walls: FluidWall[]
  inletX: number
  inletY: number
  outletX: number
  outletY: number
  topY: number
  bottomY: number
  minX: number
  maxX: number
  minY: number
  maxY: number
  radius: number
  capacity: number
  particleArea: number
}

export interface FluidDiagnostics {
  time: number
  count: number
  injected: number
  discharged: number
  escaped: number
  stored: number
  massError: number
  maxVelocity: number
  wetCells: number
  reachedExit: boolean
  outletRate: number
  saturated: boolean
}

export interface FluidSnapshot {
  positions: Float32Array
  velocities: Float32Array
  count: number
  diagnostics: FluidDiagnostics
}
