import type { Edge, GardenLayout } from '../layout'
import { pathLength } from '../layout'
import { rasterize, regionContains, type Vec2 } from '../polygon'
import {
  SPOUT_WHEEL_DROP, TIPPER_ARM, TIPPER_NODE, TIPPER_RADIUS, TIPPER_REST, TIPPER_TAIL, TIPPER_TIPPED, WHEEL_PADDLES, tipperPoint,
} from '../mechanics'
import { OpenChannel } from './channel'
import { BucketWheel, NoriaWheel, PaddleWheel, SiphonPipe } from './machines'
import { DRY, G, OVERFALL, ShallowWaterGrid } from './shallowWater'
import { TipperBody } from './tipper'

/** Plan resolution of the basin grids (m): three field texels per cell. */
export const GRID_CELL = 0.15
/** Supply at 1× inflow (m³/s): a generous garden cascade, 40 litres a second. */
export const SOURCE_FLOW = 0.04
/**
 * Beds fall gently towards their outlet, like a garden rill: water runs off
 * as a sheet instead of ponding over the whole bed before it can spill.
 */
export const BED_SLOPE = 0.03
export const BED_RISE_MAX = 0.15
/** Physics tick (s); the grids sub-step further when the flow is fast. */
export const TICK = 1 / 120

/** Noria pots: centre inset from the rim, radial depth, tangential width, axial depth. */
export const NORIA_POT = { inset: 0.12, depth: 0.24, width: 0.3, reach: 0.36 }
export const NORIA_POTS = 18
export const NORIA_SPILL = 0.13
/** Rim speed a noria's motor settles at under a full load (m/s). */
export const NORIA_RIM_SPEED = 1.1

export interface Domain {
  vessel: number
  grid: ShallowWaterGrid
  top: number
  /** Pool of each cell (-1 for walls and outside). */
  poolOf: Int32Array
  /** Cells of each pool of this vessel, keyed by pool index. */
  pools: Map<number, Int32Array>
}

interface Lip { edge: number; domain: number; cells: Int32Array; dir: Vec2; width: number; crest: number; z: number; at: Vec2 }
interface Notch { edge: number; domain: number; cells: Int32Array; crest: number; channel: number }
interface Sink { edge: number; domain: number; cells: Int32Array; crest: number; perimeter: number }

/** Water in the air between a lip and the surface it falls onto. */
interface Packet { arrive: number; domain: number; x: number; y: number; vx: number; vy: number; volume: number }

type JetTarget = { kind: 'tipper'; index: number } | { kind: 'wheel'; index: number } | { kind: 'free' }

const add = (a: Vec2, b: Vec2, s: number): Vec2 => [a[0] + b[0] * s, a[1] + b[1] * s]

function distanceToPolyline(x: number, y: number, points: readonly Vec2[]): number {
  let best = Infinity
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1], [bx, by] = points[i]
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2))
    best = Math.min(best, Math.hypot(x - ax - dx * t, y - ay - dy * t))
  }
  return best
}

/**
 * The whole garden as one coupled physical system: a shallow-water grid per
 * basin, open channels, free jets, tipping tubes, bucket and paddle wheels,
 * motor-driven norias and bell siphons. Every transfer moves a volume from
 * one store to another in the same tick, so
 * injected = stored + drained + escaped holds to round-off.
 */
export class PhysicsWorld {
  readonly domains: Domain[] = []
  readonly lips: Lip[] = []
  readonly notches: Notch[] = []
  readonly drains: Sink[] = []
  /** Crest cells of each weir, to measure the sheet running over it. */
  readonly weirs: { edge: number; domain: number; cells: Int32Array; length: number }[] = []
  readonly channels: OpenChannel[] = []
  /** Channel of each transport edge (chute, noria trough), by edge index. */
  readonly channelOf: Int32Array
  readonly tippers: TipperBody[] = []
  readonly bucketWheels: (BucketWheel | null)[] = []
  readonly paddleWheels: (PaddleWheel | null)[] = []
  private readonly paddleCells: { domain: number; cells: Int32Array }[] = []
  private readonly wheelFed: Uint8Array
  readonly norias: NoriaWheel[] = []
  readonly noriaIntakes: { domain: number; cells: Int32Array; trough: number; pourCell: number }[] = []
  readonly siphons: SiphonPipe[] = []
  readonly siphonIntakes: { domain: number; cells: Int32Array; pool: Int32Array }[] = []
  private packets: Packet[] = []
  /** Smoothed discharge of each edge (m³/s). */
  readonly discharge: Float64Array
  private readonly rawFlow: Float64Array
  readonly liftRates: Float64Array
  readonly tipperPours: Float64Array
  private readonly scoop = new Float64Array(64)
  private speedCheck = 0
  private gridSpeed: number[] = []
  time = 0
  injected = 0
  drained = 0
  escaped = 0
  sourceRate = 0
  drainRate = 0

  constructor(readonly layout: GardenLayout, readonly dx = GRID_CELL, origin?: Vec2) {
    const { bounds } = layout
    const gx0 = origin?.[0] ?? bounds.minX - 2.2, gy0 = origin?.[1] ?? bounds.minY - 2.2
    this.discharge = new Float64Array(layout.edges.length)
    this.rawFlow = new Float64Array(layout.edges.length)
    this.channelOf = new Int32Array(layout.edges.length).fill(-1)
    this.liftRates = new Float64Array(layout.lifts.length)
    this.tipperPours = new Float64Array(layout.tippers.length)
    layout.vessels.forEach(vessel => this.domains.push(this.buildDomain(vessel.index, gx0, gy0)))
    this.gridSpeed = this.domains.map(() => 3)
    // Transport channels: chutes and noria troughs.
    for (const edge of layout.edges) {
      if (edge.kind !== 'chute' && edge.kind !== 'lift') continue
      const width = edge.kind === 'lift' ? layout.lifts[edge.lift!].width * 0.9 : edge.width
      this.channelOf[edge.index] = this.channels.length
      this.channels.push(new OpenChannel(edge.path!, width))
    }
    for (const notch of this.notches) notch.channel = this.channelOf[notch.edge]
    const shape = { arm: TIPPER_ARM, tail: TIPPER_TAIL, radius: TIPPER_RADIUS, rest: TIPPER_REST, tipped: TIPPER_TIPPED, node: TIPPER_NODE }
    for (let i = 0; i < layout.tippers.length; i++) this.tippers.push(new TipperBody(shape))
    this.wheelFed = new Uint8Array(layout.wheels.length)
    for (const wheel of layout.wheels) {
      this.bucketWheels.push(wheel.overshot ? new BucketWheel(wheel.radius, wheel.width, WHEEL_PADDLES + 2) : null)
      this.paddleWheels.push(wheel.overshot ? null : new PaddleWheel(wheel.radius, wheel.width))
      const domain = wheel.overshot ? -1 : this.domainOfPool(layout.edges[wheel.edge].a)
      this.paddleCells.push({ domain, cells: domain >= 0 ? this.cellsNear(domain, wheel.center, 0.3) : new Int32Array(0) })
    }
    for (const lift of layout.lifts) {
      const potRadius = lift.radius - NORIA_POT.inset
      const capacity = NORIA_POT.width * NORIA_POT.reach * NORIA_POT.depth
      this.norias.push(new NoriaWheel(lift.radius, potRadius, NORIA_POT.depth, capacity, NORIA_POTS, NORIA_SPILL, NORIA_RIM_SPEED))
      const domain = this.domainOfPool(lift.pool)
      const grid = this.domains[domain].grid
      // The pots dip on the trough side of the wheel, under its axle.
      const [dx, dy] = lift.direction, ax = -dy, ay = dx
      const start = lift.path[0]
      const side = Math.sign((start[0] - lift.center[0]) * ax + (start[1] - lift.center[1]) * ay) || 1
      const cells: number[] = []
      for (let c = 0; c < grid.count; c++) {
        if (grid.solid[c]) continue
        const [x, y] = grid.centre(c)
        const along = (x - lift.center[0]) * dx + (y - lift.center[1]) * dy
        const across = ((x - lift.center[0]) * ax + (y - lift.center[1]) * ay) * side
        if (Math.abs(along) < 0.55 && across > lift.width / 2 - 0.1 && across < lift.width / 2 + NORIA_POT.reach + 0.15) cells.push(c)
      }
      // The sump's overflow pipe: whatever the pots cannot keep up with.
      const sump = layout.pools[lift.pool]
      this.drains.push({ edge: -1, domain, cells: this.domains[domain].pools.get(lift.pool)!, crest: sump.brim - 0.14, perimeter: 0.6 })
      const trough = this.channelOf[lift.edge]
      const pour = this.noriaPour(lift.index)
      this.noriaIntakes.push({ domain, cells: Int32Array.from(cells.length ? cells : this.cellsNear(domain, lift.center, 0.6)), trough, pourCell: this.channels[trough].cellNear(pour[0], pour[1]) })
    }
    for (const siphon of layout.siphons) {
      const edge = layout.edges[siphon.edge]
      this.siphons.push(new SiphonPipe(pathLength(siphon.path), siphon.diameter * 0.55, siphon.path[siphon.path.length - 1][2], edge.trigger!, edge.crest))
      const domain = this.domainOfPool(siphon.pool)
      this.siphonIntakes.push({ domain, cells: this.cellsNear(domain, siphon.at, siphon.diameter * 1.9), pool: this.domains[domain].pools.get(siphon.pool)! })
    }
  }

  /** Where a noria's pots pour: over the trough, beside the top of the wheel. */
  noriaPour(index: number): [number, number, number] {
    const lift = this.layout.lifts[index]
    const [dx, dy] = lift.direction, ax = -dy, ay = dx, start = lift.path[0]
    const side = Math.sign((start[0] - lift.center[0]) * ax + (start[1] - lift.center[1]) * ay) || 1
    const across = side * (lift.width / 2 + 0.03 + NORIA_POT.reach / 2)
    return [lift.center[0] + ax * across, lift.center[1] + ay * across, lift.hub + lift.radius - NORIA_POT.inset - NORIA_POT.depth / 2]
  }

  private domainOfPool(pool: number): number {
    return this.domains.findIndex(domain => domain.pools.has(pool))
  }

  private cellsNear(domain: number, [x, y]: Vec2, radius: number): Int32Array {
    const grid = this.domains[domain].grid, cells: number[] = []
    for (let c = 0; c < grid.count; c++) {
      if (grid.solid[c]) continue
      const [cx, cy] = grid.centre(c)
      if (Math.hypot(cx - x, cy - y) <= radius) cells.push(c)
    }
    if (!cells.length) {
      let best = -1, distance = Infinity
      for (let c = 0; c < grid.count; c++) {
        if (grid.solid[c]) continue
        const [cx, cy] = grid.centre(c), d = Math.hypot(cx - x, cy - y)
        if (d < distance) { distance = d; best = c }
      }
      if (best >= 0) cells.push(best)
    }
    return Int32Array.from(cells)
  }

  private buildDomain(vessel: number, gx0: number, gy0: number): Domain {
    const { layout, dx } = this
    const compiled = layout.vessels[vessel], spec = compiled.spec
    const openings = layout.edges.filter(edge => (edge.kind === 'spout' || edge.kind === 'chute') && layout.pools[edge.a].vessel === vessel)
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    const grow = (x: number, y: number) => { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y) }
    for (const region of compiled.footprint) for (const [x, y] of region.outer) grow(x, y)
    for (const edge of openings) {
      const end = edge.kind === 'spout' ? edge.lipEnd! : add(edge.points[0], edge.normal, spec.rimWidth / 2)
      grow(end[0] + edge.width, end[1] + edge.width); grow(end[0] - edge.width, end[1] - edge.width)
    }
    const i0 = Math.floor((minX - 0.3 - gx0) / dx), j0 = Math.floor((minY - 0.3 - gy0) / dx)
    const nx = Math.ceil((maxX + 0.3 - gx0) / dx) - i0, ny = Math.ceil((maxY + 0.3 - gy0) / dx) - j0
    const grid = new ShallowWaterGrid({ x0: gx0 + i0 * dx, y0: gy0 + j0 * dx, dx, nx, ny })
    const poolOf = new Int32Array(grid.count).fill(-1)
    const spec2 = { x0: grid.x0, y0: grid.y0, cell: dx, width: nx, height: ny }
    for (const pool of layout.pools) {
      if (pool.vessel !== vessel) continue
      rasterize(pool.region, spec2, c => { poolOf[c] = pool.index; grid.solid[c] = 0; grid.bed[c] = pool.floor })
    }
    // Weirs: a one-cell crest along each step line.
    for (const sill of compiled.sills) {
      const edge = layout.edges[sill.edge]
      const crestCells: number[] = []
      for (let c = 0; c < grid.count; c++) {
        const [x, y] = grid.centre(c)
        if (distanceToPolyline(x, y, edge.points) > dx * 0.6) continue
        if (grid.solid[c]) {
          // A cell centred on the step line itself falls in neither pool.
          const point: Vec2 = [x, y]
          if (!compiled.interior.some(region => regionContains(region, point)) || compiled.walls.some(region => regionContains(region, point))) continue
          grid.solid[c] = 0; poolOf[c] = edge.a; grid.bed[c] = edge.crest
        } else grid.bed[c] = Math.max(grid.bed[c], edge.crest)
        crestCells.push(c)
      }
      let length = 0
      for (let k = 1; k < edge.points.length; k++) length += Math.hypot(edge.points[k][0] - edge.points[k - 1][0], edge.points[k][1] - edge.points[k - 1][1])
      this.weirs.push({ edge: edge.index, domain: this.domains.length, cells: Int32Array.from(crestCells), length: Math.min(length, edge.width + 0.4) })
    }
    // Spout and chute notches: a channel at crest height through the rim.
    for (const edge of openings) {
      const at = edge.points[0], dir = edge.normal, across: Vec2 = [-dir[1], dir[0]]
      const end = edge.kind === 'spout' ? Math.hypot(edge.lipEnd![0] - at[0], edge.lipEnd![1] - at[1]) : spec.rimWidth / 2
      const lip: number[] = []
      for (let c = 0; c < grid.count; c++) {
        const [x, y] = grid.centre(c)
        const s = (x - at[0]) * dir[0] + (y - at[1]) * dir[1], t = (x - at[0]) * across[0] + (y - at[1]) * across[1]
        if (Math.abs(t) > edge.width / 2 || s < -(spec.rimWidth / 2 + 0.3) || s > end) continue
        if (s < -spec.rimWidth / 2 && poolOf[c] >= 0) continue
        grid.solid[c] = 0; grid.bed[c] = edge.crest; poolOf[c] = edge.a
        if (s > end - dx) lip.push(c)
      }
      if (!lip.length) continue
      const cells = Int32Array.from(lip)
      if (edge.kind === 'spout') this.lips.push({ edge: edge.index, domain: this.domains.length, cells, dir, width: edge.width, crest: edge.crest, z: edge.crest, at: edge.lipEnd! })
      else this.notches.push({ edge: edge.index, domain: this.domains.length, cells, crest: edge.crest, channel: -1 })
    }
    this.slopeBeds(grid, poolOf, vessel)
    for (let c = 0; c < grid.count; c++) if (grid.solid[c]) grid.bed[c] = compiled.top
    const pools = new Map<number, Int32Array>()
    for (const pool of layout.pools) if (pool.vessel === vessel) {
      const cells: number[] = []
      for (let c = 0; c < grid.count; c++) if (poolOf[c] === pool.index) cells.push(c)
      pools.set(pool.index, Int32Array.from(cells))
    }
    const domain: Domain = { vessel, grid, top: compiled.top, pools, poolOf }
    for (const edge of layout.edges) {
      if (edge.kind !== 'drain' || layout.pools[edge.a].vessel !== vessel) continue
      const cells: number[] = []
      for (let c = 0; c < grid.count; c++) {
        if (grid.solid[c]) continue
        const [x, y] = grid.centre(c)
        if (Math.hypot(x - edge.points[0][0], y - edge.points[0][1]) <= 0.35) cells.push(c)
      }
      this.drains.push({ edge: edge.index, domain: this.domains.length, cells: Int32Array.from(cells), crest: edge.crest, perimeter: edge.width })
    }
    return domain
  }

  /**
   * Raise each running pool's bed with its path distance to the nearest
   * outlet (weir, spout, chute or drain). Tanks feeding a noria or siphon
   * stay level.
   */
  private slopeBeds(grid: ShallowWaterGrid, poolOf: Int32Array, vessel: number): void {
    const { layout } = this
    const { nx, ny } = grid
    const crest = new Uint8Array(grid.count)
    for (let c = 0; c < grid.count; c++) if (poolOf[c] >= 0 && grid.bed[c] > layout.pools[poolOf[c]].floor + 1e-6) crest[c] = 1
    for (const pool of layout.pools) {
      if (pool.vessel !== vessel) continue
      if (layout.edges.some(edge => edge.a === pool.index && (edge.kind === 'lift' || edge.kind === 'siphon'))) continue
      const outlets = layout.edges.filter(edge => edge.a === pool.index)
      const distance = new Float64Array(grid.count).fill(Infinity)
      const queue: number[] = []
      for (let c = 0; c < grid.count; c++) {
        if (poolOf[c] !== pool.index || grid.solid[c]) continue
        const [x, y] = grid.centre(c)
        const near = outlets.some(edge => edge.kind === 'sill'
          ? distanceToPolyline(x, y, edge.points) < 0.3
          : Math.hypot(x - edge.points[0][0], y - edge.points[0][1]) < (edge.kind === 'drain' ? 0.5 : 0.45 + edge.width / 2))
        if (near) { distance[c] = 0; queue.push(c) }
      }
      // Breadth-first relaxation (8-neighbour chamfer) within the pool.
      for (let head = 0; head < queue.length; head++) {
        const c = queue[head], i = c % nx, j = (c - i) / nx
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue
          const ni = i + di, nj = j + dj
          if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue
          const n = nj * nx + ni
          if (poolOf[n] !== pool.index || grid.solid[n]) continue
          const next = distance[c] + (di && dj ? Math.SQRT2 : 1) * this.dx
          if (next < distance[n] - 1e-9) { distance[n] = next; queue.push(n) }
        }
      }
      for (let c = 0; c < grid.count; c++) {
        if (poolOf[c] !== pool.index || crest[c] || !Number.isFinite(distance[c])) continue
        grid.bed[c] = pool.floor + Math.min(BED_RISE_MAX, BED_SLOPE * distance[c])
      }
    }
  }

  /**
   * The first surface below `z` under the plan point: a basin's water or bed,
   * or the top of a wall (from which the water splashes into that basin).
   */
  private surfaceBelow(x: number, y: number, z: number): { domain: number; surface: number } | null {
    let best: { domain: number; surface: number } | null = null
    this.domains.forEach((domain, index) => {
      const cell = domain.grid.cellAt(x, y)
      if (cell < 0) return
      const inside = this.layout.vessels[domain.vessel].footprint.some(region => regionContains(region, [x, y]))
      if (!inside && domain.grid.solid[cell]) return
      const surface = domain.grid.solid[cell] ? domain.top : domain.grid.bed[cell] + domain.grid.h[cell]
      if (surface < z - 1e-3 && (!best || surface > best.surface)) best = { domain: index, surface }
    })
    return best
  }

  /** Launch water from (x, y, z) with horizontal velocity (vx, vy): it lands where gravity takes it. */
  private launch(x: number, y: number, z: number, vx: number, vy: number, volume: number): void {
    if (volume <= 0) return
    let target = this.surfaceBelow(x, y, z)
    let time = target ? Math.sqrt(2 * Math.max(0, z - target.surface) / G) : 0
    for (let k = 0; k < 2; k++) {
      const next = this.surfaceBelow(x + vx * time, y + vy * time, z)
      if (!next) break
      target = next
      time = Math.sqrt(2 * Math.max(0, z - target.surface) / G)
    }
    const lx = x + vx * time, ly = y + vy * time
    const landing = this.surfaceBelow(lx, ly, z)
    if (!landing) { this.escaped += volume; return }
    this.packets.push({ arrive: this.time + time, domain: landing.domain, x: lx, y: ly, vx, vy, volume })
  }

  private jetTarget(edge: Edge): JetTarget {
    if (edge.tipper !== undefined) return { kind: 'tipper', index: edge.tipper }
    const wheel = this.layout.wheels.findIndex(w => w.edge === edge.index && w.overshot)
    return wheel >= 0 ? { kind: 'wheel', index: wheel } : { kind: 'free' }
  }

  poolLevel(pool: number): number {
    const domain = this.domains[this.domainOfPool(pool)]
    const cells = domain?.pools.get(pool)
    if (!cells || !cells.length) return this.layout.pools[pool].floor
    const surface = domain.grid.surface(cells)
    return Number.isFinite(surface) ? surface : this.layout.pools[pool].floor - 0.01
  }

  /** Share of a pool's cells that are wet. */
  wetShare(pool: number): number {
    const domain = this.domains[this.domainOfPool(pool)]
    const cells = domain?.pools.get(pool)
    if (!cells || !cells.length) return 0
    let wet = 0
    for (let k = 0; k < cells.length; k++) if (domain.grid.h[cells[k]] > 0.003) wet++
    return wet / cells.length
  }

  step(dt: number, inflow: number): void {
    const { layout } = this
    this.rawFlow.fill(0)
    this.tipperPours.fill(0)
    this.wheelFed.fill(0)
    // The source pump: its lip pours into the first basin, unless it is brimming.
    const source = layout.source
    const first = this.poolLevel(source.pool)
    const brimming = first >= layout.pools[source.pool].brim - 0.04
    this.sourceRate = brimming ? 0 : SOURCE_FLOW * Math.max(0, Math.min(2.5, inflow))
    if (this.sourceRate > 0) {
      const volume = this.sourceRate * dt
      this.injected += volume
      const q = this.sourceRate / source.width, speed = Math.cbrt(G * q)
      this.launch(source.lip[0], source.lip[1], source.lipZ, source.direction[0] * speed, source.direction[1] * speed, volume)
    }
    // Basins.
    if (++this.speedCheck % 6 === 0) this.gridSpeed = this.domains.map(domain => domain.grid.maxSpeed() + 0.5)
    this.domains.forEach((domain, index) => {
      const steps = Math.max(1, Math.ceil(dt * this.gridSpeed[index] / (0.4 * this.dx)))
      for (let n = 0; n < steps; n++) domain.grid.step(dt / steps)
      // Anything over the rim is lost from the garden.
      const { grid } = domain
      for (let c = 0; c < grid.count; c++) {
        const over = grid.bed[c] + grid.h[c] - domain.top
        if (over > 0 && !grid.solid[c]) { grid.h[c] -= over; this.escaped += over * this.dx * this.dx }
      }
    })
    // The sheet over each weir, for the renderer's nappes.
    for (const weir of this.weirs) {
      const grid = this.domains[weir.domain].grid, edge = layout.edges[weir.edge]
      let q = 0
      for (let k = 0; k < weir.cells.length; k++) {
        const c = weir.cells[k]
        if (grid.h[c] <= DRY) continue
        const [u, v] = grid.velocity(c)
        q += (u * edge.normal[0] + v * edge.normal[1]) * grid.h[c]
      }
      // Cells along the line cover its length once (diagonals more densely).
      this.rawFlow[weir.edge] = Math.max(0, q * weir.length / Math.max(1, weir.cells.length))
    }
    // Spout lips: free overfall into the air.
    for (const lip of this.lips) {
      const grid = this.domains[lip.domain].grid, edge = layout.edges[lip.edge]
      let volume = 0, momentum = 0
      for (let k = 0; k < lip.cells.length; k++) {
        const c = lip.cells[k], head = grid.h[c]
        if (head <= DRY) continue
        const out = Math.min(OVERFALL * this.dx * Math.pow(head, 1.5) * dt, head * this.dx * this.dx * 0.9)
        grid.h[c] -= out / (this.dx * this.dx)
        volume += out; momentum += out * Math.sqrt(G * head)
      }
      if (volume <= 0) continue
      this.rawFlow[lip.edge] += volume / dt
      const speed = momentum / volume
      this.pourFromLip(edge, lip, volume, speed, dt)
    }
    // Chute intakes feed their channels.
    for (const notch of this.notches) {
      const grid = this.domains[notch.domain].grid, channel = this.channels[notch.channel]
      let volume = 0
      const back = channel.h[0]
      for (let k = 0; k < notch.cells.length; k++) {
        const c = notch.cells[k], head = grid.h[c]
        if (head <= DRY) continue
        const submerged = back > 0 ? Math.pow(Math.max(0, 1 - Math.pow(Math.min(1, back / head), 1.5)), 0.385) : 1
        const out = Math.min(OVERFALL * this.dx * Math.pow(head, 1.5) * submerged * dt, head * this.dx * this.dx * 0.9)
        grid.h[c] -= out / (this.dx * this.dx)
        volume += out
      }
      channel.add(0, volume)
      this.rawFlow[notch.edge] += volume / dt
    }
    // Drains: a standpipe ring, Q = C·perimeter·H^1.5.
    this.drainRate = 0
    for (const sink of this.drains) {
      const grid = this.domains[sink.domain].grid
      const level = grid.surface(sink.cells)
      if (!Number.isFinite(level) || level <= sink.crest) continue
      const taken = grid.withdraw(sink.cells, OVERFALL * sink.perimeter * Math.pow(level - sink.crest, 1.5) * dt)
      this.drained += taken; this.drainRate += taken / dt
      if (sink.edge >= 0) this.rawFlow[sink.edge] += taken / dt
    }
    // Bell siphons.
    layout.siphons.forEach((siphon, i) => {
      const intake = this.siphonIntakes[i], grid = this.domains[intake.domain].grid
      const level = grid.surface(intake.pool)
      const pipe = this.siphons[i]
      const q = pipe.step(dt, Number.isFinite(level) ? level : -1e3)
      // Above the bell the standpipe overflows as a ring weir.
      const edge = layout.edges[siphon.edge]
      const over = Number.isFinite(level) ? level - (edge.trigger! + 0.05) : -1
      const wanted = q * dt + (over > 0 ? OVERFALL * Math.PI * siphon.diameter * Math.pow(over, 1.5) * dt : 0)
      const taken = grid.withdraw(intake.cells, wanted)
      if (taken < q * dt * 0.5 && pipe.primed) pipe.primed = false
      this.rawFlow[siphon.edge] += taken / dt
      const mouth = siphon.path[siphon.path.length - 1]
      this.launch(mouth[0], mouth[1], mouth[2], 0, 0, taken)
    })
    // Norias: the motor turns the wheel, the pots scoop from the sump.
    layout.lifts.forEach((lift, i) => {
      const noria = this.norias[i], intake = this.noriaIntakes[i], grid = this.domains[intake.domain].grid
      const level = grid.surface(intake.cells)
      const wet = Number.isFinite(level)
      if (!wet && noria.speed === 0 && noria.held() === 0) return
      const scoop = this.scoop
      const wanted = wet ? noria.demand(dt, lift.hub, level, scoop) : 0
      const taken = wanted > 0 ? grid.withdraw(intake.cells, wanted) : 0
      noria.step(dt, scoop, wanted > 0 ? taken / wanted : 0)
      this.channels[intake.trough].add(intake.pourCell, noria.poured)
      this.rawFlow[lift.edge] += noria.poured / dt
      this.liftRates[i] += (noria.poured / dt - this.liftRates[i]) * Math.min(1, dt / 0.4)
    })
    // Channels run, and pour off their ends.
    for (const edge of layout.edges) {
      const index = this.channelOf[edge.index]
      if (index < 0) continue
      const channel = this.channels[index]
      channel.step(dt)
      if (channel.outflow > 0) {
        const n = channel.n - 1
        this.launch(channel.px[n] + channel.exit[0] * channel.ds / 2, channel.py[n] + channel.exit[1] * channel.ds / 2, channel.bed[n] + channel.h[n] * 0.7,
          channel.exit[0] * channel.exitSpeed, channel.exit[1] * channel.exitSpeed, channel.outflow)
      }
    }
    // Tipping tubes pour from their mouths when they swing down.
    layout.tippers.forEach((tipper, i) => {
      const tube = this.tippers[i]
      tube.step(dt, 0)
      if (tube.poured > 0) {
        const [x, y, z] = tipperPoint(tipper, -TIPPER_ARM, tube.angle, -TIPPER_RADIUS * 0.5)
        this.launch(x, y, z, -tipper.direction[0] * 0.3, -tipper.direction[1] * 0.3, tube.poured)
        this.tipperPours[i] = tube.poured / dt
      }
    })
    // Undershot wheels are dragged by the sheet over their weir.
    layout.wheels.forEach((wheel, i) => {
      const paddle = this.paddleWheels[i], { domain: index, cells } = this.paddleCells[i]
      if (!paddle || index < 0 || !cells.length) return
      const grid = this.domains[index].grid
      const level = grid.surface(cells)
      let flow = 0
      for (let k = 0; k < cells.length; k++) {
        const [u, v] = grid.velocity(cells[k])
        flow += u * wheel.direction[0] + v * wheel.direction[1]
      }
      const depth = Number.isFinite(level) ? level - (wheel.z - wheel.radius) : 0
      const force = paddle.step(dt, flow / cells.length, depth)
      if (force !== 0) grid.push(cells, wheel.direction[0], wheel.direction[1], force * dt)
    })
    // Overshot wheels with no jet this tick still turn and empty their buckets.
    layout.wheels.forEach((w, i) => {
      const wheel = this.bucketWheels[i]
      if (!wheel || this.wheelFed[i]) return
      wheel.step(dt, 0, 0, 0)
      let spilled = 0
      for (let k = 0; k < wheel.count; k++) spilled += wheel.spilled[k]
      if (spilled > 0) this.launch(w.center[0] + w.direction[0] * w.radius * 0.6, w.center[1] + w.direction[1] * w.radius * 0.6, w.z, 0, 0, spilled)
    })
    // Water in flight lands.
    this.time += dt
    if (this.packets.length) {
      const pending: Packet[] = []
      for (const packet of this.packets) {
        if (packet.arrive > this.time) { pending.push(packet); continue }
        const missed = this.domains[packet.domain].grid.deposit(packet.x, packet.y, packet.volume, packet.vx, packet.vy)
        this.escaped += missed
      }
      this.packets = pending
    }
    for (let k = 0; k < this.discharge.length; k++) this.discharge[k] += (this.rawFlow[k] - this.discharge[k]) * Math.min(1, dt / 0.25)
  }

  /** Water leaving a spout lip meets its tipping tube or wheel, or falls free. */
  private pourFromLip(edge: Edge, lip: Lip, volume: number, speed: number, dt: number): void {
    const target = this.jetTarget(edge)
    const [x, y] = lip.at, z = lip.z + Math.pow(volume / dt / (OVERFALL * lip.width), 2 / 3) * 0.7
    const vx = lip.dir[0] * speed, vy = lip.dir[1] * speed
    if (target.kind === 'tipper') {
      const tube = this.tippers[target.index], tipper = this.layout.tippers[target.index]
      // Does the falling sheet meet the tube's mouth?
      const [mx, my, mz] = tipperPoint(tipper, -TIPPER_ARM, tube.angle)
      const fall = Math.sqrt(2 * Math.max(0, z - mz) / G)
      const reach = Math.hypot(x + vx * fall - mx, y + vy * fall - my)
      const caught = reach < TIPPER_RADIUS * 1.3 ? volume * tube.catchShare(lip.width) : 0
      if (caught > 0) tube.volume += caught
      this.launch(x, y, z, vx, vy, volume - caught)
      return
    }
    if (target.kind === 'wheel') {
      const layoutWheel = this.layout.wheels[target.index], wheel = this.bucketWheels[target.index]!
      this.wheelFed[target.index] = 1
      // The sheet strikes the rim near the top, on the downstream side.
      const fall = Math.sqrt(2 * SPOUT_WHEEL_DROP / G)
      const jetSpeed = Math.hypot(speed, G * fall)
      const missed = wheel.step(dt, volume, 0.35, jetSpeed)
      let spilled = missed
      for (let k = 0; k < wheel.count; k++) spilled += wheel.spilled[k]
      const [cx, cy] = layoutWheel.center, dir = layoutWheel.direction
      // Emptying buckets turn over on the downstream side, low on the wheel.
      this.launch(cx + dir[0] * layoutWheel.radius * 0.6, cy + dir[1] * layoutWheel.radius * 0.6, layoutWheel.z, dir[0] * 0.4, dir[1] * 0.4, spilled)
      return
    }
    this.launch(x, y, z, vx, vy, volume)
  }

  stored(): number {
    let sum = 0
    for (const domain of this.domains) sum += domain.grid.volume()
    for (const channel of this.channels) sum += channel.volume()
    for (const packet of this.packets) sum += packet.volume
    for (const tube of this.tippers) sum += tube.volume
    for (const wheel of this.bucketWheels) if (wheel) sum += wheel.held()
    for (const noria of this.norias) sum += noria.held()
    return sum
  }

  reset(): void {
    for (const domain of this.domains) domain.grid.reset()
    for (const channel of this.channels) channel.reset()
    for (const tube of this.tippers) tube.reset()
    for (const wheel of this.bucketWheels) wheel?.reset()
    for (const wheel of this.paddleWheels) wheel?.reset()
    for (const noria of this.norias) noria.reset()
    for (const pipe of this.siphons) pipe.reset()
    this.packets = []
    this.discharge.fill(0); this.rawFlow.fill(0); this.liftRates.fill(0); this.tipperPours.fill(0)
    this.time = 0; this.injected = 0; this.drained = 0; this.escaped = 0; this.sourceRate = 0; this.drainRate = 0
  }
}
