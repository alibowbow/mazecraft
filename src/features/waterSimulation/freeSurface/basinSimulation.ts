import type { MazeProject } from '../../../core/maze'
import { buildHydraulicNetwork } from '../hydraulics/network'
import { createHydraulicSolver, resetHydraulicSolver, setHydraulicSource, stepHydraulicSolver, type HydraulicSolver } from '../hydraulics/solver'
import type { FluidDiagnostics, FluidLayout } from './types'

export const BASIN_INITIAL_DEPTH = 0.42
export const BASIN_OUTLET_SILL = 0.24
export const BASIN_OUTLET_SILL_DEPTH = BASIN_OUTLET_SILL
// ExtrudeGeometry's top cap includes the .085 bevel and lands exactly at z=0.
export const BASIN_FLOOR_Z = 0

/** A physical filled vessel, independent of the vertical 2D particle experiment. */
export interface BasinSnapshot {
  readonly rows: number
  readonly cols: number
  readonly depth: Float32Array
  /** Maze XY velocity, cells/second; Y increases toward the outlet. */
  readonly velocity: Float32Array
  /** Row-major portal flags: right=1, down=2, left=4, up=8; inactive=255. */
  readonly connections: Uint8Array
  readonly diagnostics: FluidDiagnostics
  readonly initialStoredVolume: number
  readonly sourceRate: number
}

/** Reuses the conservative finite-volume solver with an actually flat floor. */
export class BasinSimulation {
  readonly solver: HydraulicSolver
  private readonly initialVolumes: Float64Array
  private readonly depth: Float32Array
  private readonly velocity: Float32Array
  private readonly connections: Uint8Array
  private readonly contributions: Uint8Array
  private accumulator = 0
  private spilled = 0
  private sourceRate = 0
  private maximumDepth = 0.50
  private rimDepth = 1.05 - BASIN_FLOOR_Z

  constructor(project: MazeProject, layout: FluidLayout) {
    const network = buildHydraulicNetwork(project.mazeGraph,
      { row: layout.topY, col: Math.floor(layout.inletX) },
      { row: layout.bottomY - 1, col: Math.floor(layout.outletX) },
      { cellWidthMeters: 1, cellHeightMeters: 1, channelThicknessMeters: 1,
        passageWidthMeters: 0.82, maxOpeningDepthMeters: 0.55, frictionCoefficient: 0.18 })
    // The legacy network's default represents a vertical maze. This vessel has
    // one horizontal ceramic floor and matching floor-level internal portals.
    network.elevation.fill(0)
    network.edgeSillElevation.fill(0)
    network.storageArea.fill(0.86)
    this.initialVolumes = new Float64Array(network.nodeCount)
    const reached = new Uint8Array(network.nodeCount), queue = [network.sourceNode]
    reached[network.sourceNode] = 1
    for (let head = 0; head < queue.length; head++) {
      const node = queue[head]
      this.initialVolumes[node] = network.storageArea[node] * BASIN_INITIAL_DEPTH
      for (let i = network.adjacencyOffsets[node]; i < network.adjacencyOffsets[node + 1]; i++) {
        const next = network.adjacencyOtherNode[i]
        if (!reached[next]) { reached[next] = 1; queue.push(next) }
      }
    }
    this.solver = createHydraulicSolver(network, {
      initialVolumes: this.initialVolumes, dampingCoefficient: 0.7,
      source: { targetFlowRateCubicMetersPerSecond: 0.16, rampDurationSeconds: 0.6 },
      outlet: { mode: 'weir', boundaryHeadMeters: BASIN_OUTLET_SILL, weirWidthMeters: 0.48, dischargeCoefficient: 0.62 },
    })
    const count = layout.rows * layout.cols
    this.depth = new Float32Array(count)
    this.velocity = new Float32Array(count * 2)
    this.connections = new Uint8Array(count).fill(255)
    this.contributions = new Uint8Array(count)
    for (let node = 0; node < network.nodeCount; node++) this.connections[network.nodeCellIndex[node]] = 0
    for (let edge = 0; edge < network.edgeCount; edge++) {
      const a = network.nodeCellIndex[network.edgeFrom[edge]], b = network.nodeCellIndex[network.edgeTo[edge]]
      const horizontal = Math.abs(a - b) === 1 && Math.floor(a / layout.cols) === Math.floor(b / layout.cols)
      this.connections[a] |= horizontal ? 1 : 2
      this.connections[b] |= horizontal ? 4 : 8
    }
  }

  setWallHeight(multiplier: number): void {
    if (!Number.isFinite(multiplier)) return
    // Leave visible freeboard even at the smallest supported wall setting.
    this.rimDepth = 1.05 * Math.max(0.55, multiplier) - BASIN_FLOOR_Z
    this.maximumDepth = Math.min(0.50, Math.max(0.43, this.rimDepth - 0.10))
  }

  advance(seconds: number, inflow: number): void {
    if (!Number.isFinite(seconds) || seconds <= 0) return
    const requested = Number.isFinite(inflow) ? Math.min(2.5, Math.max(0, inflow)) : 0
    const dt = 1 / 120, { network, state } = this.solver
    this.accumulator += Math.min(0.5, seconds)
    while (this.accumulator + 1e-10 >= dt) {
      const room = Math.max(0, this.maximumDepth - state.depth[network.sourceNode])
      const target = Math.min(0.16 * requested * Math.min(1, room / 0.055), room * network.storageArea[network.sourceNode] / dt)
      setHydraulicSource(this.solver, { enabled: requested > 0, targetFlowRateCubicMetersPerSecond: target })
      const before = this.solver.cumulativeInjectedVolume
      stepHydraulicSolver(this.solver, dt)
      this.sourceRate = (this.solver.cumulativeInjectedVolume - before) / dt
      // A transient pressure surge can overflow a vessel. Count removed water
      // explicitly instead of clipping its rendered height and hiding volume.
      for (let node = 0; node < network.nodeCount; node++) {
        const limit = network.storageArea[node] * this.rimDepth
        if (state.volume[node] > limit) {
          this.spilled += state.volume[node] - limit
          state.volume[node] = limit
          state.depth[node] = this.rimDepth
          state.hydraulicHead[node] = this.rimDepth
        }
      }
      this.accumulator = Math.max(0, this.accumulator - dt)
    }
  }

  reset(): void {
    resetHydraulicSolver(this.solver, this.initialVolumes)
    this.accumulator = 0; this.spilled = 0; this.sourceRate = 0
  }

  snapshot(): BasinSnapshot {
    const { network, state } = this.solver
    this.depth.fill(0); this.velocity.fill(0); this.contributions.fill(0)
    let stored = 0, wetCells = 0, maxVelocity = 0
    for (let node = 0; node < network.nodeCount; node++) {
      const cell = network.nodeCellIndex[node]
      this.depth[cell] = state.depth[node]
      stored += state.volume[node]
      if (state.depth[node] > 0.002) wetCells++
    }
    for (let edge = 0; edge < network.edgeCount; edge++) {
      const a = network.nodeCellIndex[network.edgeFrom[edge]], b = network.nodeCellIndex[network.edgeTo[edge]]
      const x = network.nodeCol[network.edgeTo[edge]] - network.nodeCol[network.edgeFrom[edge]]
      const y = network.nodeRow[network.edgeTo[edge]] - network.nodeRow[network.edgeFrom[edge]]
      const speed = state.velocity[edge]
      this.velocity[a * 2] += speed * x; this.velocity[a * 2 + 1] += speed * y
      this.velocity[b * 2] += speed * x; this.velocity[b * 2 + 1] += speed * y
      this.contributions[a]++; this.contributions[b]++
      maxVelocity = Math.max(maxVelocity, Math.abs(speed))
    }
    for (let cell = 0; cell < this.depth.length; cell++) if (this.contributions[cell]) {
      this.velocity[cell * 2] /= this.contributions[cell]
      this.velocity[cell * 2 + 1] /= this.contributions[cell]
    }
    const injected = this.solver.cumulativeInjectedVolume, discharged = this.solver.cumulativeOutletVolume
    return {
      rows: network.rows, cols: network.cols, depth: this.depth, velocity: this.velocity, connections: this.connections,
      initialStoredVolume: this.solver.initialStoredVolume, sourceRate: this.sourceRate,
      diagnostics: {
        time: this.solver.simulationTime, count: 0, injected, discharged, escaped: this.spilled, stored,
        massError: Math.abs(this.solver.initialStoredVolume + injected - stored - discharged - this.spilled),
        maxVelocity, wetCells, reachedExit: discharged > 1e-8, outletRate: this.solver.outletDischarge,
        saturated: state.depth[network.sourceNode] >= this.maximumDepth - 0.002,
      },
    }
  }
}
