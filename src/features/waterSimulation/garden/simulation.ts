import type { BasinSnapshot } from '../freeSurface/basinSimulation'
import type { FluidLayout } from '../freeSurface/types'
import type { GardenLayout } from './layout'
import { gardenField, FAR, type GardenField } from './flowField'

const STEP = 1 / 120
/** Rectangular sharp-crested weir, Q = C·w·h^1.5 (SI, Cd ≈ 0.62). */
export const WEIR_COEFFICIENT = 1.84
/** Supply at 1× inflow, m³/s. */
export const GARDEN_SOURCE_FLOW = 0.14
/**
 * A dry bed wets progressively: new water first spreads as a thin film from
 * the pool's inflow along the channels (in geodesic order), and only once
 * the whole bed is wet does the level rise towards the weirs.
 */
export const WETTING_FILM = 0.02
/** Hydraulics run in real time. */
export const HYDRAULIC_TIME_LAPSE = 1
/**
 * A spreading film cannot outrun gravity: the wetting front advances at
 * most this fast (m/s), roughly √(g·h) for a few centimetres of water.
 */
export const FRONT_SPEED = 0.75
const FREEBOARD = 0.04

export interface GardenState {
  readonly time: number
  /** Absolute water level of each pool. */
  readonly levels: Float32Array
  /** Signed discharge of each edge, positive from `a` towards `b` (m³/s). */
  readonly discharge: Float32Array
  /** Water passing through each pool (m³/s): the larger of in- and outflow. */
  readonly throughflow: Float32Array
  /** Wetting front: entry distance (m) reached so far; FAR once the bed is wet, -1 when dry. */
  readonly fronts: Float32Array
  readonly sourceRate: number
}

export interface GardenSnapshot extends BasinSnapshot {
  readonly garden: GardenState
}

function villemonte(upstreamHead: number, downstreamHead: number): number {
  if (downstreamHead <= 0) return 1
  const ratio = Math.min(1, downstreamHead / upstreamHead)
  return Math.pow(Math.max(0, 1 - ratio ** 1.5), 0.385)
}

/**
 * Well-mixed pools exchange water only over the weirs that separate them.
 * Every transfer is subtracted from one pool and added to another in the
 * same fixed step, so `initial + injected = stored + drained + escaped`.
 */
export class GardenSimulation {
  private readonly volumes: Float64Array
  private readonly initialVolumes: Float64Array
  private readonly initialStoredVolume: number
  private readonly floors: Float64Array
  private readonly areas: Float64Array
  private readonly maxLevels: Float64Array
  private readonly flow: Float64Array
  private readonly outflow: Float64Array
  private readonly inflowSum: Float64Array
  private readonly levels: Float32Array
  private readonly discharge: Float32Array
  private readonly throughflow: Float32Array
  private readonly fronts: Float32Array
  /** Wetting front per pool (m along the wetting order); -1 while dry. */
  private readonly front: Float64Array
  private readonly field: GardenField
  private readonly depth: Float32Array
  private readonly velocity: Float32Array
  private readonly connections: Uint8Array
  private readonly totalArea: number
  private time = 0
  private accumulator = 0
  private injected = 0
  private drained = 0
  private escaped = 0
  private sourceRate = 0
  private drainRate = 0

  constructor(readonly layout: GardenLayout, private readonly grid: Pick<FluidLayout, 'rows' | 'cols' | 'activeCellCount'>) {
    const count = layout.pools.length
    this.floors = Float64Array.from(layout.pools, pool => pool.floor)
    this.areas = Float64Array.from(layout.pools, pool => pool.area)
    this.maxLevels = Float64Array.from(layout.pools, pool => pool.brim - FREEBOARD)
    this.totalArea = this.areas.reduce((sum, area) => sum + area, 0)
    // Every garden starts dry; the only water is what the source supplies.
    this.initialVolumes = new Float64Array(count)
    this.initialStoredVolume = 0
    this.field = gardenField(layout)
    this.volumes = this.initialVolumes.slice()
    this.flow = new Float64Array(layout.edges.length)
    this.outflow = new Float64Array(count)
    this.inflowSum = new Float64Array(count)
    this.levels = new Float32Array(count)
    this.discharge = new Float32Array(layout.edges.length)
    this.throughflow = new Float32Array(count)
    this.fronts = new Float32Array(count)
    this.front = new Float64Array(count).fill(-1)
    const cells = grid.rows * grid.cols
    this.depth = new Float32Array(cells)
    this.velocity = new Float32Array(cells * 2)
    this.connections = new Uint8Array(cells).fill(255)
  }

  private reach(pool: number): number {
    const order = this.field.wettingOrder[pool]
    return order.length ? order[order.length - 1] : 0
  }

  /** Whole bed wet: side bays included. */
  private wet(pool: number): boolean {
    return this.front[pool] >= this.reach(pool) - 1e-9
  }

  /** A pool can spill as soon as its front has run down to its outlet. */
  private reachedOutlet(pool: number): boolean {
    return this.front[pool] >= this.field.outletKey[pool] - 0.3
  }

  /** Wetted share of a pool's bed behind its front. */
  private wetShare(pool: number): number {
    const order = this.field.wettingOrder[pool], front = this.front[pool]
    if (front < 0 || !order.length) return 0
    let low = 0, high = order.length
    while (low < high) { const mid = (low + high) >> 1; if (order[mid] <= front) low = mid + 1; else high = mid }
    return low / order.length
  }

  private advanceFronts(): void {
    for (let i = 0; i < this.volumes.length; i++) {
      if (this.volumes[i] <= 1e-9) { this.front[i] = -1; continue }
      const order = this.field.wettingOrder[i]
      const share = Math.min(1, this.volumes[i] / (this.areas[i] * WETTING_FILM))
      const target = share >= 1 || !order.length ? this.reach(i) : order[Math.floor(share * order.length)]
      if (this.front[i] < 0) this.front[i] = 0
      this.front[i] = Math.min(Math.max(this.front[i], target), this.front[i] + FRONT_SPEED * STEP)
    }
  }

  /** Water stands on the wetted part of the bed only. */
  level(pool: number): number {
    const share = this.wet(pool) ? 1 : Math.max(0.05, this.wetShare(pool))
    return this.floors[pool] + this.volumes[pool] / (this.areas[pool] * share)
  }

  /** The walls are sculpted, not simulated: their height never limits water. */
  setWallHeight(_multiplier: number): void {}

  private computeFlows(): void {
    const { edges } = this.layout
    for (let k = 0; k < edges.length; k++) {
      const edge = edges[k]
      const levelA = this.level(edge.a)
      if (!this.reachedOutlet(edge.a) && (edge.b < 0 || !this.reachedOutlet(edge.b))) { this.flow[k] = 0; continue }
      if (edge.b < 0 || edge.kind === 'spout') {
        if (!this.reachedOutlet(edge.a)) { this.flow[k] = 0; continue }
        // Drains and spouts only ever discharge outward and downward.
        const head = levelA - edge.crest
        let q = head > 0 ? WEIR_COEFFICIENT * edge.width * head ** 1.5 : 0
        if (edge.kind === 'spout' && edge.b >= 0) {
          const back = this.level(edge.b) - edge.crest
          q *= villemonte(Math.max(head, 1e-9), back)
        }
        q = Math.min(q, 0.5 * Math.max(0, head) * this.areas[edge.a] / STEP)
        this.flow[k] = q
        continue
      }
      const levelB = this.level(edge.b)
      const forward = levelA >= levelB
      const up = forward ? edge.a : edge.b, down = forward ? edge.b : edge.a
      const upperLevel = forward ? levelA : levelB, lowerLevel = forward ? levelB : levelA
      const head = upperLevel - edge.crest
      if (head <= 0 || !this.reachedOutlet(up)) { this.flow[k] = 0; continue }
      let q = WEIR_COEFFICIENT * edge.width * head ** 1.5 * villemonte(head, lowerLevel - edge.crest)
      // Never transfer more than half of what would equalise the two pools.
      const a = this.areas[up], b = this.areas[down]
      const equalise = (upperLevel - Math.max(lowerLevel, edge.crest)) * a * b / (a + b)
      q = Math.min(q, 0.5 * equalise / STEP)
      this.flow[k] = forward ? q : -q
    }
  }

  advance(seconds: number, inflow: number): void {
    if (!Number.isFinite(seconds) || seconds <= 0) return
    const requested = Number.isFinite(inflow) ? Math.max(0, Math.min(2.5, inflow)) : 0
    const { edges, source } = this.layout
    this.accumulator += Math.min(0.5, seconds) * HYDRAULIC_TIME_LAPSE
    while (this.accumulator + 1e-10 >= STEP) {
      this.advanceFronts()
      this.computeFlows()
      this.outflow.fill(0)
      for (let k = 0; k < edges.length; k++) {
        const q = this.flow[k], edge = edges[k]
        if (q > 0) this.outflow[edge.a] += q
        else if (q < 0) this.outflow[edge.b] -= q
      }
      // A pool can never give away more water than it holds.
      for (let k = 0; k < edges.length; k++) {
        const q = this.flow[k], giver = q >= 0 ? edges[k].a : edges[k].b
        const limit = 0.9 * this.volumes[giver] / STEP
        if (this.outflow[giver] > limit && this.outflow[giver] > 0) this.flow[k] *= limit / this.outflow[giver]
      }
      const pool = source.pool
      const room = (this.maxLevels[pool] - this.level(pool)) * this.areas[pool] / STEP + this.outflow[pool]
      this.sourceRate = Math.max(0, Math.min(GARDEN_SOURCE_FLOW * requested, room))
      this.volumes[pool] += this.sourceRate * STEP
      this.injected += this.sourceRate * STEP
      this.drainRate = 0
      for (let k = 0; k < edges.length; k++) {
        const q = this.flow[k] * STEP, edge = edges[k]
        this.volumes[edge.a] -= q
        if (edge.b >= 0) this.volumes[edge.b] += q
        else { this.drained += q; this.drainRate += this.flow[k] }
      }
      for (let i = 0; i < this.volumes.length; i++) {
        const limit = (this.maxLevels[i] + FREEBOARD - this.floors[i]) * this.areas[i]
        if (this.volumes[i] > limit) { this.escaped += this.volumes[i] - limit; this.volumes[i] = limit }
        if (this.volumes[i] < 0) this.volumes[i] = 0
      }
      this.time += STEP / HYDRAULIC_TIME_LAPSE
      this.accumulator = Math.max(0, this.accumulator - STEP)
    }
  }

  reset(): void {
    this.volumes.set(this.initialVolumes)
    this.flow.fill(0)
    this.front.fill(-1)
    this.time = 0; this.accumulator = 0
    this.injected = 0; this.drained = 0; this.escaped = 0
    this.sourceRate = 0; this.drainRate = 0
  }

  snapshot(): GardenSnapshot {
    const { edges } = this.layout
    this.inflowSum.fill(0); this.outflow.fill(0)
    this.inflowSum[this.layout.source.pool] += this.sourceRate
    let maxVelocity = 0
    for (let k = 0; k < edges.length; k++) {
      const q = this.flow[k], edge = edges[k]
      this.discharge[k] = q
      const [from, to] = q >= 0 ? [edge.a, edge.b] : [edge.b, edge.a]
      this.outflow[from] += Math.abs(q)
      if (to >= 0) this.inflowSum[to] += Math.abs(q)
      const head = Math.max(0.02, this.level(from) - edge.crest)
      maxVelocity = Math.max(maxVelocity, Math.abs(q) / (edge.width * head))
    }
    let stored = 0, wetArea = 0
    for (let i = 0; i < this.volumes.length; i++) {
      const film = this.areas[i] * WETTING_FILM
      const volume = this.volumes[i]
      if (volume <= 1e-9 || this.front[i] < 0) {
        this.levels[i] = this.floors[i] - 0.01; this.fronts[i] = -1
      } else if (!this.wet(i)) {
        // Spreading: water stands on the wetted part of the bed only.
        const share = Math.max(1e-3, this.wetShare(i))
        this.fronts[i] = this.front[i]
        this.levels[i] = Math.max(this.floors[i] + WETTING_FILM, this.level(i))
        wetArea += this.areas[i] * share
      } else {
        this.fronts[i] = FAR
        this.levels[i] = this.level(i)
        wetArea += this.areas[i]
      }
      this.throughflow[i] = Math.max(this.inflowSum[i], this.outflow[i])
      stored += volume
    }
    return {
      rows: this.grid.rows, cols: this.grid.cols, depth: this.depth, velocity: this.velocity, connections: this.connections,
      initialStoredVolume: this.initialStoredVolume, sourceRate: this.sourceRate,
      garden: { time: this.time, levels: this.levels, discharge: this.discharge, throughflow: this.throughflow, fronts: this.fronts, sourceRate: this.sourceRate },
      diagnostics: {
        time: this.time, count: 0, injected: this.injected, discharged: this.drained, escaped: this.escaped, stored,
        massError: Math.abs(this.initialStoredVolume + this.injected - this.drained - this.escaped - stored),
        maxVelocity, wetCells: Math.round(this.grid.activeCellCount * wetArea / this.totalArea),
        reachedExit: this.drained > 1e-8 || this.drainRate > 1e-8, outletRate: this.drainRate,
        saturated: this.level(this.layout.source.pool) >= this.maxLevels[this.layout.source.pool] - 0.002,
      },
    }
  }
}
