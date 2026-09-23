import type { BasinSnapshot } from '../freeSurface/basinSimulation'
import type { FluidLayout } from '../freeSurface/types'
import type { Edge, GardenLayout } from './layout'
import { gardenField, FAR, type GardenField } from './flowField'
import { FILLING, POURING, RETURNING, TIPPER_POUR_TIME, TIPPER_RETURN_TIME, TIPPER_TIP_TIME, TIPPER_TIPPED, TIPPING, tipperAngle, type TipperPhase } from './mechanics'

const STEP = 1 / 120
/** Rectangular sharp-crested weir, Q = C·w·h^1.5 (SI, Cd ≈ 0.62). */
export const WEIR_COEFFICIENT = 1.84
/** Supply at 1× inflow, m³/s. */
export const GARDEN_SOURCE_FLOW = 0.17
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
/**
 * Share of a pool's inflow that runs straight on over its outlets once the
 * wetting front has reached them: water streams down a terraced channel as a
 * sheet rather than waiting for every terrace to brim like a tank.
 */
export const RUN_THROUGH = 0.85
/** Discharge coefficient of a primed siphon pipe. */
const SIPHON_CD = 0.62
/** Samples of the flow along each channel, for rendering. */
export const PROFILE_SAMPLES = 48

/** Edges whose water spends time in transit: chutes and norias. */
export function transportEdges(layout: GardenLayout): Edge[] {
  return layout.edges.filter(edge => (edge.delay ?? 0) > 0)
}

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
  /** Per tipper: tilt (rad), load as a share of capacity, and surge rate (m³/s). */
  readonly tipperAngles: Float32Array
  readonly tipperLoads: Float32Array
  readonly tipperPours: Float32Array
  /** Per transport edge (see `transportEdges`): flow (m³/s) sampled along its channel, intake first. */
  readonly channelFlow: Float32Array
  /** Per noria: flow riding up in its buckets (m³/s). */
  readonly liftLoads: Float32Array
  /** Per siphon: 1 while primed and running. */
  readonly siphonPrimed: Float32Array
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
  /** Tipping tubes: stored load, phase, time in phase and current surge. */
  private readonly tipVolume: Float64Array
  private readonly tipPhase: Uint8Array
  private readonly tipTime: Float64Array
  private readonly tipPour: Float64Array
  private readonly tipperAngles: Float32Array
  private readonly tipperLoads: Float32Array
  private readonly tipperPours: Float32Array
  /** Transit lines: per transport, a ring of per-step volumes (plug flow). */
  private readonly lines: { edge: Edge; ring: Float64Array; head: number; steps: number; rise: number; held: number; arrived: number }[]
  private readonly lineOf: Int32Array
  private readonly primed: Uint8Array
  /** Inflow of each pool over the last step (m³/s), and how many outlets share its run-through. */
  private readonly recentInflow: Float64Array
  private readonly stepInflow: Float64Array
  private readonly runOutlets: Uint8Array
  private readonly channelFlow: Float32Array
  private readonly liftLoads: Float32Array
  private readonly siphonPrimed: Float32Array
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
    const tippers = layout.tippers.length
    this.tipVolume = new Float64Array(tippers)
    this.tipPhase = new Uint8Array(tippers)
    this.tipTime = new Float64Array(tippers)
    this.tipPour = new Float64Array(tippers)
    this.tipperAngles = new Float32Array(tippers)
    this.tipperLoads = new Float32Array(tippers)
    this.tipperPours = new Float32Array(tippers)
    this.lineOf = new Int32Array(layout.edges.length).fill(-1)
    this.lines = transportEdges(layout).map((edge, i) => {
      this.lineOf[edge.index] = i
      const steps = Math.max(1, Math.round(edge.delay! / STEP))
      return { edge, ring: new Float64Array(steps), head: 0, steps, rise: Math.round((edge.rise ?? 0) / STEP), held: 0, arrived: 0 }
    })
    this.primed = new Uint8Array(layout.siphons.length)
    this.recentInflow = new Float64Array(count)
    this.stepInflow = new Float64Array(count)
    this.runOutlets = new Uint8Array(count)
    for (const edge of layout.edges) if (this.runsThrough(edge)) this.runOutlets[edge.a]++
    this.channelFlow = new Float32Array(this.lines.length * PROFILE_SAMPLES)
    this.liftLoads = new Float32Array(layout.lifts.length)
    this.siphonPrimed = new Float32Array(layout.siphons.length)
  }

  /** Water in a transit line at `age` steps after it entered (m³ per step). */
  private lineAt(line: GardenSimulation['lines'][number], age: number): number {
    const j = Math.max(0, Math.min(line.steps - 1, Math.round(age)))
    return line.ring[(line.head - 1 - j + line.steps * 2) % line.steps]
  }

  /**
   * Each tube fills from its spout until it holds its capacity, swings down,
   * pours the whole load into the pool below in one surge and swings back.
   */
  private advanceTippers(): void {
    for (const tipper of this.layout.tippers) {
      const i = tipper.index
      let phase = this.tipPhase[i] as TipperPhase
      this.tipTime[i] += STEP
      const t = this.tipTime[i], load = this.tipVolume[i]
      if (phase === FILLING && load >= tipper.capacity) { phase = TIPPING; this.tipTime[i] = 0 }
      else if (phase === TIPPING && t >= TIPPER_TIP_TIME) { phase = POURING; this.tipTime[i] = 0 }
      else if (phase === POURING && t >= TIPPER_POUR_TIME) { phase = RETURNING; this.tipTime[i] = 0 }
      else if (phase === RETURNING && t >= TIPPER_RETURN_TIME) { phase = FILLING; this.tipTime[i] = 0 }
      this.tipPhase[i] = phase
      const angle = tipperAngle(phase, this.tipTime[i], load / tipper.capacity)
      const tilt = Math.max(0, Math.min(1, angle / TIPPER_TIPPED))
      // Whatever is left at the end of the pour leaves with it.
      const rate = phase === POURING && this.tipTime[i] + STEP >= TIPPER_POUR_TIME ? load / STEP : tilt * 1.8 * tipper.capacity / TIPPER_POUR_TIME
      const out = Math.min(load, rate * STEP)
      this.tipVolume[i] -= out
      this.volumes[tipper.pool] += out
      this.stepInflow[tipper.pool] += out
      this.tipPour[i] = out / STEP
    }
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
    // A spreading film is never deeper than the full pool would be.
    return this.floors[pool] + Math.min(this.volumes[pool] / (this.areas[pool] * share), Math.max(WETTING_FILM * 3, this.volumes[pool] / this.areas[pool] + 0.06))
  }

  /** The walls are sculpted, not simulated: their height never limits water. */
  setWallHeight(_multiplier: number): void {}

  /** Chutes, spouts, steps and drains carry run-through; norias and siphons do not. */
  private runsThrough(edge: Edge): boolean {
    return edge.kind === 'sill' || edge.kind === 'spout' || edge.kind === 'chute' || edge.kind === 'drain'
  }

  private runThrough(edge: Edge): number {
    return this.reachedOutlet(edge.a) ? RUN_THROUGH * this.recentInflow[edge.a] / Math.max(1, this.runOutlets[edge.a]) : 0
  }

  private computeFlows(): void {
    const { edges } = this.layout
    for (let k = 0; k < edges.length; k++) {
      const edge = edges[k]
      const levelA = this.level(edge.a)
      if (!this.reachedOutlet(edge.a) && (edge.b < 0 || !this.reachedOutlet(edge.b))) { this.flow[k] = 0; continue }
      if (edge.kind === 'siphon') {
        if (!this.reachedOutlet(edge.a)) { this.flow[k] = 0; continue }
        const i = edge.siphon!, mouth = edge.path![edge.path!.length - 1][2]
        if (this.primed[i] && levelA <= edge.crest) this.primed[i] = 0
        else if (!this.primed[i] && levelA >= edge.trigger!) this.primed[i] = 1
        const diameter = edge.width / Math.PI
        let q = this.primed[i] ? SIPHON_CD * Math.PI * diameter * diameter / 4 * Math.sqrt(2 * 9.81 * Math.max(0, levelA - mouth)) : 0
        // The bell's standpipe doubles as an overflow if the siphon can't keep up.
        const over = levelA - (edge.trigger! + 0.05)
        if (over > 0) q += WEIR_COEFFICIENT * edge.width * over ** 1.5
        this.flow[k] = Math.min(q, 0.5 * Math.max(0, levelA - this.floors[edge.a]) * this.areas[edge.a] / STEP)
        continue
      }
      if (edge.b < 0 || edge.kind !== 'sill') {
        if (!this.reachedOutlet(edge.a)) { this.flow[k] = 0; continue }
        // Drains and spouts only ever discharge outward and downward.
        const head = levelA - edge.crest
        let q = head > 0 ? WEIR_COEFFICIENT * edge.width * head ** 1.5 : 0
        if (edge.kind === 'spout' && edge.b >= 0 && edge.tipper === undefined) {
          const back = this.level(edge.b) - edge.crest
          q *= villemonte(Math.max(head, 1e-9), back)
        }
        q = Math.min(q, 0.5 * Math.max(0, head) * this.areas[edge.a] / STEP)
        this.flow[k] = edge.kind === 'lift' ? q : Math.max(q, this.runThrough(edge))
        continue
      }
      const levelB = this.level(edge.b)
      const forward = levelA >= levelB
      const up = forward ? edge.a : edge.b, down = forward ? edge.b : edge.a
      const upperLevel = forward ? levelA : levelB, lowerLevel = forward ? levelB : levelA
      const head = upperLevel - edge.crest
      const run = this.runThrough(edge)
      if (head <= 0 || !this.reachedOutlet(up)) { this.flow[k] = run; continue }
      let q = WEIR_COEFFICIENT * edge.width * head ** 1.5 * villemonte(head, lowerLevel - edge.crest)
      // Never transfer more than half of what would equalise the two pools.
      const a = this.areas[up], b = this.areas[down]
      const equalise = (upperLevel - Math.max(lowerLevel, edge.crest)) * a * b / (a + b)
      q = Math.min(q, 0.5 * equalise / STEP)
      this.flow[k] = forward ? Math.max(q, run) : run - q
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
      this.stepInflow.fill(0)
      this.stepInflow[pool] += this.sourceRate * STEP
      this.volumes[pool] += this.sourceRate * STEP
      this.injected += this.sourceRate * STEP
      this.drainRate = 0
      for (let k = 0; k < edges.length; k++) {
        const q = this.flow[k] * STEP, edge = edges[k]
        this.volumes[edge.a] -= q
        // While a tube is swung away, its jet falls straight into the pool.
        const line = this.lineOf[k]
        if (line >= 0) {
          // Plug flow: what enters now arrives after the line's transit time.
          const transit = this.lines[line]
          const out = transit.ring[transit.head]
          transit.ring[transit.head] = q
          transit.head = (transit.head + 1) % transit.steps
          transit.held += q - out
          transit.arrived = out / STEP
          this.volumes[edge.b] += out
          this.stepInflow[edge.b] += out
        } else if (edge.tipper !== undefined && this.tipPhase[edge.tipper] === FILLING) this.tipVolume[edge.tipper] += q
        else if (edge.b >= 0) {
          this.volumes[edge.b] += q
          if (q > 0) this.stepInflow[edge.b] += q; else this.stepInflow[edge.a] -= q
        } else { this.drained += q; this.drainRate += this.flow[k] }
      }
      this.advanceTippers()
      for (let i = 0; i < this.recentInflow.length; i++) this.recentInflow[i] = this.stepInflow[i] / STEP
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
    this.tipVolume.fill(0); this.tipPhase.fill(FILLING); this.tipTime.fill(0); this.tipPour.fill(0)
    for (const line of this.lines) { line.ring.fill(0); line.head = 0; line.held = 0; line.arrived = 0 }
    this.primed.fill(0)
    this.recentInflow.fill(0)
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
      if (to >= 0 && edge.tipper === undefined && this.lineOf[k] < 0) this.inflowSum[to] += Math.abs(q)
      const head = Math.max(0.02, this.level(from) - edge.crest)
      maxVelocity = Math.max(maxVelocity, Math.abs(q) / (edge.width * head))
    }
    let stored = 0, wetArea = 0
    this.lines.forEach((line, i) => {
      stored += line.held
      this.inflowSum[line.edge.b] += line.arrived
      const channel = line.steps - line.rise
      for (let s = 0; s < PROFILE_SAMPLES; s++) {
        this.channelFlow[i * PROFILE_SAMPLES + s] = this.lineAt(line, line.rise + s / (PROFILE_SAMPLES - 1) * (channel - 1)) / STEP
      }
      if (line.edge.lift !== undefined) {
        let riding = 0
        for (let j = 0; j < line.rise; j += 4) riding += this.lineAt(line, j)
        this.liftLoads[line.edge.lift] = line.rise ? riding / Math.ceil(line.rise / 4) / STEP : 0
      }
    })
    this.primed.forEach((value, i) => { this.siphonPrimed[i] = value })
    for (const tipper of this.layout.tippers) {
      const i = tipper.index, load = this.tipVolume[i]
      stored += load
      this.inflowSum[tipper.pool] += this.tipPour[i]
      this.tipperAngles[i] = tipperAngle(this.tipPhase[i] as TipperPhase, this.tipTime[i], load / tipper.capacity)
      this.tipperLoads[i] = Math.min(1, load / tipper.capacity)
      this.tipperPours[i] = this.tipPour[i]
    }
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
      garden: { time: this.time, levels: this.levels, discharge: this.discharge, throughflow: this.throughflow, fronts: this.fronts, sourceRate: this.sourceRate,
        tipperAngles: this.tipperAngles, tipperLoads: this.tipperLoads, tipperPours: this.tipperPours,
        channelFlow: this.channelFlow, liftLoads: this.liftLoads, siphonPrimed: this.siphonPrimed },
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
