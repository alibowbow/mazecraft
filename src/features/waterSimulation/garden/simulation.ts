import type { BasinSnapshot } from '../freeSurface/basinSimulation'
import type { FluidLayout } from '../freeSurface/types'
import type { Edge, GardenLayout } from './layout'
import { gardenField, FAR, type GardenField } from './flowField'
import { PhysicsWorld, SOURCE_FLOW, TICK, NORIA_POTS } from './physics/world'
import { DRY } from './physics/shallowWater'
import { ScrewLift } from './physics/machines'
import { NO_WATER, surfacePlan, type SurfaceGrid } from './physics/surface'

/** Rectangular weir coefficient, Q = C·w·h^1.5 (SI), for reference and rendering. */
export const WEIR_COEFFICIENT = 1.705
/** Supply at 1× inflow, m³/s. */
export const GARDEN_SOURCE_FLOW = SOURCE_FLOW
/** Samples of the flow along each channel, for rendering. */
export const PROFILE_SAMPLES = 48

/** Edges whose water spends time in transit: chutes and norias. */
export function transportEdges(layout: GardenLayout): Edge[] {
  return layout.edges.filter(edge => (edge.delay ?? 0) > 0)
}

export interface GardenState {
  readonly time: number
  /** Mean water surface of each pool (absolute z). */
  readonly levels: Float32Array
  /** Discharge of each edge, from `a` towards `b` (m³/s). */
  readonly discharge: Float32Array
  /** Water passing through each pool (m³/s): the larger of in- and outflow. */
  readonly throughflow: Float32Array
  /** Wetting front: entry distance (m) reached so far; FAR once the bed is wet, -1 when dry. */
  readonly fronts: Float32Array
  readonly sourceRate: number
  /** Per tipper: tilt (rad), load as a share of its tipping volume, and pour rate (m³/s). */
  readonly tipperAngles: Float32Array
  readonly tipperLoads: Float32Array
  readonly tipperPours: Float32Array
  /** Per transport edge (see `transportEdges`): flow (m³/s) sampled along its channel, intake first. */
  readonly channelFlow: Float32Array
  /** Per noria: flow it lifts (m³/s). */
  readonly liftLoads: Float32Array
  /** Per siphon: 1 while primed and running. */
  readonly siphonPrimed: Float32Array
  /** Per wheel: its rotation (rad), as the renderer turns it. */
  readonly wheelAngles: Float32Array
  /** Per noria: wheel rotation (rad) and, per pot, how full it is (0–1). */
  readonly noriaAngles: Float32Array
  readonly noriaPots: Float32Array
  /**
   * The simulated water as a plan texture over the garden field: RGBA per
   * texel = surface height (absolute), depth, and velocity (x, y). Texels
   * without water carry their neighbours' surface so it runs on under walls.
   */
  readonly surface: Float32Array
  /** The beds the water runs over, absolute height per texel (static). */
  readonly bed: Float32Array
  /** Texel grid: world x0, y0, texel size, width, height. */
  readonly surfaceGrid: SurfaceGrid
}

export { NO_WATER, type SurfaceGrid } from './physics/surface'

export interface GardenSnapshot extends BasinSnapshot {
  readonly garden: GardenState
}

/**
 * The water garden driven by its physics engine (see physics/world.ts):
 * shallow-water flow in every basin, open-channel flow in the chutes and
 * troughs, free jets, and machinery moved by the water's weight and push.
 */
export class GardenSimulation {
  readonly world: PhysicsWorld
  private readonly field: GardenField
  private readonly levels: Float32Array
  private readonly discharge: Float32Array
  private readonly throughflow: Float32Array
  private readonly fronts: Float32Array
  private readonly tipperAngles: Float32Array
  private readonly tipperLoads: Float32Array
  private readonly tipperPours: Float32Array
  private readonly channelFlow: Float32Array
  private readonly liftLoads: Float32Array
  private readonly siphonPrimed: Float32Array
  private readonly wheelAngles: Float32Array
  private readonly noriaAngles: Float32Array
  private readonly noriaPots: Float32Array
  private readonly inflowSum: Float64Array
  private readonly outflowSum: Float64Array
  private readonly depth: Float32Array
  private readonly velocity: Float32Array
  private readonly connections: Uint8Array
  private readonly totalArea: number
  private readonly surface: Float32Array
  private readonly bed: Float32Array
  private readonly surfaceGrid: SurfaceGrid
  /** Per texel: owning domain (or -1) and its cell. */
  private readonly texelDomain: Int16Array
  private readonly texelCell: Int32Array
  private accumulator = 0

  constructor(readonly layout: GardenLayout, private readonly grid: Pick<FluidLayout, 'rows' | 'cols' | 'activeCellCount'>, cell?: number) {
    this.world = new PhysicsWorld(layout, cell)
    this.field = gardenField(layout)
    const pools = layout.pools.length
    this.levels = new Float32Array(pools)
    this.discharge = new Float32Array(layout.edges.length)
    this.throughflow = new Float32Array(pools)
    this.fronts = new Float32Array(pools)
    this.inflowSum = new Float64Array(pools)
    this.outflowSum = new Float64Array(pools)
    this.tipperAngles = new Float32Array(layout.tippers.length)
    this.tipperLoads = new Float32Array(layout.tippers.length)
    this.tipperPours = new Float32Array(layout.tippers.length)
    this.channelFlow = new Float32Array(this.world.channels.length * PROFILE_SAMPLES)
    this.liftLoads = new Float32Array(layout.lifts.length)
    this.siphonPrimed = new Float32Array(layout.siphons.length)
    this.wheelAngles = new Float32Array(layout.wheels.length)
    this.noriaAngles = new Float32Array(layout.lifts.length)
    this.noriaPots = new Float32Array(layout.lifts.length * NORIA_POTS)
    const cells = grid.rows * grid.cols
    this.depth = new Float32Array(cells)
    this.velocity = new Float32Array(cells * 2)
    this.connections = new Uint8Array(cells).fill(255)
    this.totalArea = layout.pools.reduce((sum, pool) => sum + pool.area, 0)
    // Plan texture aligned with the physics grids (they share the field's origin).
    const plan = surfacePlan(layout, this.world)
    this.surfaceGrid = plan.grid
    this.surface = new Float32Array(plan.grid.width * plan.grid.height * 4)
    this.bed = plan.bed
    this.texelDomain = plan.texelDomain
    this.texelCell = plan.texelCell
    this.fillSurface()
  }

  /** Write the simulated water into the plan texture. */
  private fillSurface(): void {
    const { surface, texelDomain, texelCell, world } = this
    const { width, height } = this.surfaceGrid
    const count = width * height
    for (let t = 0; t < count; t++) {
      const d = texelDomain[t], o = t * 4
      if (d < 0) { surface[o] = NO_WATER; surface[o + 1] = 0; surface[o + 2] = 0; surface[o + 3] = 0; continue }
      const grid = world.domains[d].grid, c = texelCell[t], h = grid.h[c]
      if (h > DRY * 10) {
        const [u, v] = grid.velocity(c)
        surface[o] = grid.bed[c] + h; surface[o + 1] = h; surface[o + 2] = u; surface[o + 3] = v
      } else { surface[o] = NO_WATER; surface[o + 1] = 0; surface[o + 2] = 0; surface[o + 3] = 0 }
    }
    // Carry the surface a few texels on under walls and over dry edges, so
    // the water mesh meets its banks without dipping.
    for (let pass = 0; pass < 3; pass++) {
      for (let j = 1; j < height - 1; j++) for (let i = 1; i < width - 1; i++) {
        const t = j * width + i, o = t * 4
        if (surface[o + 1] > 0 || surface[o] > NO_WATER + 1) continue
        let best = NO_WATER
        for (const n of [t - 1, t + 1, t - width, t + width]) if (surface[n * 4] > best) best = surface[n * 4]
        if (best > NO_WATER + 1) surface[o] = best - 1e-4
      }
    }
  }

  /** Mean surface of a pool's wet water (absolute z). */
  level(pool: number): number { return this.world.poolLevel(pool) }

  /** The walls are sculpted, not simulated: their height never limits water. */
  setWallHeight(_multiplier: number): void {}

  advance(seconds: number, inflow: number): void {
    if (!Number.isFinite(seconds) || seconds <= 0) return
    const requested = Number.isFinite(inflow) ? Math.max(0, Math.min(2.5, inflow)) : 0
    this.accumulator += Math.min(0.5, seconds)
    while (this.accumulator + 1e-10 >= TICK) {
      this.world.step(TICK, requested)
      this.accumulator = Math.max(0, this.accumulator - TICK)
    }
  }

  reset(): void {
    this.world.reset()
    this.accumulator = 0
  }

  snapshot(): GardenSnapshot {
    const { layout, world } = this
    const { edges } = layout
    this.inflowSum.fill(0); this.outflowSum.fill(0)
    this.inflowSum[layout.source.pool] += world.sourceRate
    for (let k = 0; k < edges.length; k++) {
      const q = world.discharge[k], edge = edges[k]
      this.discharge[k] = q
      this.outflowSum[edge.a] += q
      if (edge.b >= 0) this.inflowSum[edge.b] += q
    }
    let stored = 0, wetArea = 0
    for (let i = 0; i < layout.pools.length; i++) {
      const share = world.wetShare(i)
      this.levels[i] = world.poolLevel(i)
      if (share <= 0) this.fronts[i] = -1
      else if (share >= 0.97) this.fronts[i] = FAR
      else {
        const order = this.field.wettingOrder[i]
        this.fronts[i] = order.length ? order[Math.min(order.length - 1, Math.floor(share * order.length))] : FAR
      }
      wetArea += layout.pools[i].area * share
      this.throughflow[i] = Math.max(this.inflowSum[i], this.outflowSum[i])
    }
    world.channels.forEach((channel, c) => {
      for (let s = 0; s < PROFILE_SAMPLES; s++) {
        const k = Math.round(s / (PROFILE_SAMPLES - 1) * (channel.n - 1))
        this.channelFlow[c * PROFILE_SAMPLES + s] = channel.h[k] > DRY ? Math.max(channel.discharge(k), channel.discharge(k + 1), channel.h[k] * channel.width * 0.3) : 0
      }
    })
    world.tippers.forEach((tube, i) => {
      this.tipperAngles[i] = tube.angle
      this.tipperLoads[i] = Math.min(1, tube.volume / tube.tipVolume)
      this.tipperPours[i] = world.tipperPours[i]
    })
    layout.wheels.forEach((wheel, i) => {
      const bucket = world.bucketWheels[i], paddle = world.paddleWheels[i]
      // Overshot wheels turn forward, undershot ones backward about their axle.
      this.wheelAngles[i] = bucket ? bucket.angle : -(paddle?.angle ?? 0)
    })
    world.norias.forEach((lifter, i) => {
      this.liftLoads[i] = world.liftRates[i]
      if (lifter instanceof ScrewLift) {
        // Screws turn forwards; each slot is a pocket along the flights.
        this.noriaAngles[i] = lifter.angle
        for (let k = 0; k < NORIA_POTS; k++) this.noriaPots[i * NORIA_POTS + k] = k < lifter.count ? lifter.fill(k) : 0
      } else {
        this.noriaAngles[i] = -lifter.angle
        for (let k = 0; k < NORIA_POTS; k++) this.noriaPots[i * NORIA_POTS + k] = lifter.pots[k] / lifter.capacity
      }
    })
    world.siphons.forEach((pipe, i) => { this.siphonPrimed[i] = pipe.primed ? 1 : 0 })
    stored = world.stored()
    this.fillSurface()
    let maxVelocity = 0
    for (const domain of world.domains) for (const u of domain.grid.u) maxVelocity = Math.max(maxVelocity, Math.abs(u))
    const saturated = world.poolLevel(layout.source.pool) >= layout.pools[layout.source.pool].brim - 0.05
    return {
      rows: this.grid.rows, cols: this.grid.cols, depth: this.depth, velocity: this.velocity, connections: this.connections,
      initialStoredVolume: 0, sourceRate: world.sourceRate,
      garden: {
        time: world.time, levels: this.levels, discharge: this.discharge, throughflow: this.throughflow, fronts: this.fronts, sourceRate: world.sourceRate,
        tipperAngles: this.tipperAngles, tipperLoads: this.tipperLoads, tipperPours: this.tipperPours,
        channelFlow: this.channelFlow, liftLoads: this.liftLoads, siphonPrimed: this.siphonPrimed,
        wheelAngles: this.wheelAngles, noriaAngles: this.noriaAngles, noriaPots: this.noriaPots,
        surface: this.surface, bed: this.bed, surfaceGrid: this.surfaceGrid,
      },
      diagnostics: {
        time: world.time, count: 0, injected: world.injected, discharged: world.drained, escaped: world.escaped, stored,
        massError: Math.abs(world.injected - world.drained - world.escaped - stored),
        maxVelocity, wetCells: Math.round(this.grid.activeCellCount * wetArea / this.totalArea),
        reachedExit: world.drained > 1e-8 || world.drainRate > 1e-8, outletRate: world.drainRate, saturated,
      },
    }
  }
}
