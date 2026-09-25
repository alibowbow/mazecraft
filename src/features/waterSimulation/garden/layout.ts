import type { GardenKey } from './index'
import { createGardenDesign, SOURCE_THROW, type ChuteSpec, type GardenDesign, type GardenId, type LiftSpec, type SiphonSpec, type Vec3, type VesselSpec } from './designs'
import {
  boundsOf, difference, offset, polygon, regionArea, regionContains, regions, simplifyRing, soften, strokes, union,
  type Bounds, type Region, type Shape2, type Vec2,
} from './polygon'
import {
  SILL_WHEEL_LIFT, SILL_WHEEL_RADIUS, SPOUT_WHEEL_DROP, spoutWheelRadius, TIPPER_RADIUS, tipperFrame, tipperLanding, type TipperFrame,
} from './mechanics'

/** Walls are cut this far under their faces so water edges hide inside them. */
export const WATER_TUCK = 0.03
export const SPOUT_SILL_RADIUS = 0.07
/**
 * Weirs are not walls: a pool ends where the bed steps down. The step is
 * modelled as a hair-thin cut that separates the two pools' water.
 */
export const STEP_CUT = 0.006
/** Water standing on a terrace below its step edge (the wetting film). */
export const BED_DEPTH = 0.03
/** Receiving troughs keep a real pool below their drain. */
export const TROUGH_DEPTH = 0.17
/** Water speed along open channels (m/s). */
export const CHUTE_SPEED = 1.5
/** Rim speed of a noria's buckets (m/s). */
export const LIFT_SPEED = 0.85
/** Axial speed of the water pockets in an Archimedes screw (m/s). */
export const SCREW_AXIAL_SPEED = 0.55
/** A noria's buckets only fill once the sump stands this deep. */
export const LIFT_SILL = 0.06

export interface CompiledVessel {
  index: number
  spec: VesselSpec
  /** Full-height ceramic (rim, walls, islands), outer faces. */
  walls: Region[]
  /** Low weirs, outer faces, with absolute crest heights. */
  sills: { regions: Region[]; crest: number; edge: number }[]
  /** The rim's inner area: bed of the basin. */
  interior: Region[]
  /** The rim's outer silhouette on the ground. */
  footprint: Region[]
  baseFloor: number
  top: number
}

export interface Pool {
  index: number
  vessel: number
  region: Region
  area: number
  floor: number
  /** Highest level before water would reach the tops of its walls. */
  brim: number
}

export type EdgeKind = 'sill' | 'spout' | 'drain' | 'chute' | 'lift' | 'siphon'

export interface Edge {
  index: number
  kind: EdgeKind
  /** Upstream side by construction; flow may still reverse when submerged. */
  a: number
  /** Receiving pool, or -1 for the terminal drain. */
  b: number
  crest: number
  width: number
  /** Crest line (sills), rim point (spouts) or drain point. */
  points: Vec2[]
  /** Unit normal pointing from pool a towards pool b. */
  normal: Vec2
  /** Spouts: channel start (inside the rim), end and landing. */
  lipStart?: Vec2
  lipEnd?: Vec2
  landing?: Vec2
  /** The spout's water runs down a hanging rain chain. */
  chain?: boolean
  /** Index into `tippers` when this spout pours into a tipping tube. */
  tipper?: number
  /** Chutes, noria troughs and siphon pipes: centreline (world). */
  path?: Vec3[]
  /** Transit time from intake to landing (s). */
  delay?: number
  /** Noria: part of the delay spent riding the wheel (s). */
  rise?: number
  /** Siphons: absolute level at which the siphon primes, and index into `siphons`. */
  trigger?: number
  siphon?: number
  /** Noria index into `lifts`. */
  lift?: number
}

export interface Lift extends LiftSpec { index: number; edge: number; pool: number; base: number }
export interface Siphon extends SiphonSpec { index: number; edge: number; pool: number; base: number }

/** A tipping tube between a spout and the pool below it. */
export interface Tipper extends TipperFrame {
  index: number
  edge: number
  /** Pool that receives each surge. */
  pool: number
  width: number
  /** Load (m³) at which the tube tips. */
  capacity: number
  landing: Vec2
  /** Bed under the pivot, where its two posts stand. */
  base: number
}

/** A paddle wheel driven by one edge's discharge (purely kinetic). */
export interface Wheel {
  index: number
  edge: number
  center: Vec2
  z: number
  /** Unit vector along the axle. */
  axis: Vec2
  /** Unit direction the water travels under/over it. */
  direction: Vec2
  radius: number
  width: number
  /** Overshot wheels are fed from above by a spout; undershot ones sit on a step. */
  overshot: boolean
  /** Bed below the wheel, for its supports. */
  base: number
}

export interface GardenLayout {
  id: string
  design: GardenDesign
  vessels: CompiledVessel[]
  pools: Pool[]
  edges: Edge[]
  tippers: Tipper[]
  wheels: Wheel[]
  lifts: Lift[]
  siphons: Siphon[]
  source: { pool: number; tower: Vec2; lip: Vec2; landing: Vec2; lipZ: number; width: number; direction: Vec2; round: boolean }
  bounds: Bounds
  height: number
}

const normalize = ([x, y]: Vec2): Vec2 => { const l = Math.hypot(x, y) || 1; return [x / l, y / l] }

export function pathLength(path: readonly Vec3[]): number {
  let length = 0
  for (let i = 1; i < path.length; i++) length += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1], path[i][2] - path[i - 1][2])
  return length
}

/** Horizontal direction of a path's last segment. */
function endDirection(path: readonly Vec3[]): Vec2 {
  const a = path[path.length - 2], b = path[path.length - 1]
  return normalize([b[0] - a[0], b[1] - a[1]])
}
const add = (a: Vec2, b: Vec2, s = 1): Vec2 => [a[0] + b[0] * s, a[1] + b[1] * s]

function polylineLength(points: readonly Vec2[]): number {
  let length = 0
  for (let i = 1; i < points.length; i++) length += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1])
  return length
}

function midpoint(points: readonly Vec2[]): { point: Vec2; tangent: Vec2 } {
  const half = polylineLength(points) / 2
  let walked = 0
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i]
    const step = Math.hypot(b[0] - a[0], b[1] - a[1])
    if (walked + step >= half) {
      const t = (half - walked) / (step || 1)
      return { point: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], tangent: normalize([b[0] - a[0], b[1] - a[1]]) }
    }
    walked += step
  }
  return { point: points[0], tangent: [1, 0] }
}

function notch(at: Vec2, direction: Vec2, halfWidth: number, halfLength: number): Shape2 {
  const [dx, dy] = direction, px = -dy, py = dx
  const corners: Vec2[] = [
    [at[0] - dx * halfLength - px * halfWidth, at[1] - dy * halfLength - py * halfWidth],
    [at[0] + dx * halfLength - px * halfWidth, at[1] + dy * halfLength - py * halfWidth],
    [at[0] + dx * halfLength + px * halfWidth, at[1] + dy * halfLength + py * halfWidth],
    [at[0] - dx * halfLength + px * halfWidth, at[1] - dy * halfLength + py * halfWidth],
  ]
  return polygon(corners)
}

function smooth(region: Region): Region {
  return { outer: simplifyRing(region.outer), holes: region.holes.map(hole => simplifyRing(hole)) }
}

/** Deterministic compile of an authored garden into solids, pools and weirs. */
export function compileGarden(design: GardenDesign): GardenLayout {
  const vessels: CompiledVessel[] = []
  const pools: Pool[] = []
  const edges: Edge[] = []
  const pendingSpouts: { vessel: number; spout: VesselSpec['spouts'][number] }[] = []
  const pendingChutes: { vessel: number; chute: ChuteSpec }[] = []
  const pendingLifts: { vessel: number; lift: LiftSpec }[] = []
  const pendingSiphons: { vessel: number; siphon: SiphonSpec }[] = []
  const sillWheels: number[] = []
  design.vessels.forEach((spec, vesselIndex) => {
    const rim = { points: spec.outline, closed: true }
    let rimShape = strokes([rim], spec.rimWidth / 2)
    const openings = [...spec.spouts, ...(spec.chutes ?? [])]
    for (const spout of openings) rimShape = difference(rimShape, notch(spout.at, normalize(spout.direction), spout.width / 2, spec.rimWidth))
    const widths = [...new Set(spec.walls.map(wall => wall.width ?? spec.wallWidth))]
    const wallShapes = widths.map(width => strokes(spec.walls.filter(wall => (wall.width ?? spec.wallWidth) === width), width / 2))
    const raw = union(rimShape, ...wallShapes, polygon(...spec.islands))
    const walls = soften(raw, 0.1, 0.07)
    const sillShapes = spec.sills.map(sill => {
      // Reach a little into the walls at both ends so the cut always seals.
      const p = sill.points, n = p.length
      const extend = (from: Vec2, to: Vec2): Vec2 => { const d = normalize([to[0] - from[0], to[1] - from[1]]); return add(to, d, 0.1) }
      return strokes([{ points: [extend(p[1], p[0]), ...p, extend(p[n - 2], p[n - 1])] }], STEP_CUT)
    })
    const spoutSills = openings.map(spout => {
      const direction = normalize(spout.direction), across: Vec2 = [-direction[1], direction[0]]
      return strokes([{ points: [add(spout.at, across, -spout.width / 2 - 0.05), add(spout.at, across, spout.width / 2 + 0.05)] }], SPOUT_SILL_RADIUS)
    })
    const interior = polygon(spec.outline)
    const obstacles = union(offset(union(walls, ...spoutSills), -WATER_TUCK), ...sillShapes)
    const free = regions(difference(interior, obstacles)).filter(region => regionArea(region) > 0.04)
    const vesselPools = free.map(region => {
      const offsets = spec.floors.filter(floor => regionContains(region, floor.seed)).map(floor => floor.offset)
      const pool: Pool = {
        index: pools.length, vessel: vesselIndex, region: smooth(region), area: regionArea(region),
        floor: spec.floor + Math.min(0, ...offsets), brim: spec.floor + spec.wallHeight,
      }
      pools.push(pool)
      return pool
    })
    const poolAt = (point: Vec2) => vesselPools.find(pool => regionContains(pool.region, point))
    const compiled: CompiledVessel = {
      index: vesselIndex, spec,
      walls: regions(walls).map(smooth),
      sills: [], interior: regions(interior), footprint: regions(offset(interior, spec.rimWidth / 2)),
      baseFloor: Math.min(spec.floor, ...vesselPools.map(pool => pool.floor)),
      top: spec.floor + spec.wallHeight,
    }
    spec.sills.forEach((sill, k) => {
      const { point, tangent } = midpoint(sill.points)
      const normal: Vec2 = [-tangent[1], tangent[0]]
      let a: Pool | undefined, b: Pool | undefined
      for (const distance of [0.2, 0.28, 0.38, 0.5, 0.65]) {
        a ??= poolAt(add(point, normal, distance))
        b ??= poolAt(add(point, normal, -distance))
      }
      if (!a || !b || a === b) throw new Error(`${design.id}/${spec.name}: sill ${k} does not separate two pools`)
      const crest = spec.floor + sill.crest
      // By convention the upstream side is the pool with the higher floor.
      const [up, down, n] = a.floor >= b.floor ? [a, b, [-normal[0], -normal[1]] as Vec2] : [b, a, normal]
      const edge: Edge = {
        index: edges.length, kind: 'sill', a: up.index, b: down.index, crest,
        width: Math.max(0.2, polylineLength(sill.points) - spec.wallWidth), points: sill.points.slice(), normal: n,
      }
      edges.push(edge)
      if (sill.wheel) sillWheels.push(edge.index)
      compiled.sills.push({ regions: regions(sillShapes[k]).map(smooth), crest, edge: edge.index })
    })
    for (const spout of spec.spouts) pendingSpouts.push({ vessel: vesselIndex, spout })
    for (const chute of spec.chutes ?? []) pendingChutes.push({ vessel: vesselIndex, chute })
    for (const lift of spec.lifts ?? []) pendingLifts.push({ vessel: vesselIndex, lift })
    for (const siphon of spec.siphons ?? []) pendingSiphons.push({ vessel: vesselIndex, siphon })
    if (spec.drain) {
      const pool = poolAt(spec.drain.at)
      if (!pool) throw new Error(`${design.id}/${spec.name}: drain is outside the water`)
      edges.push({ index: edges.length, kind: 'drain', a: pool.index, b: -1, crest: spec.floor + spec.drain.crest, width: spec.drain.width, points: [spec.drain.at], normal: [0, -1] })
    }
    vessels.push(compiled)
  })
  const findPool = (point: Vec2, below: number, except = -1) => pools.find(pool => pool.vessel !== except
    && design.vessels[pool.vessel].floor < below && regionContains(pool.region, point))
  const tippers: Tipper[] = [], wheels: Wheel[] = []
  const spoutWheels: number[] = []
  for (const { vessel, spout } of pendingSpouts) {
    const spec = design.vessels[vessel]
    const direction = normalize(spout.direction)
    const inner = add(spout.at, direction, -(spec.rimWidth / 2 + 0.16))
    const source = pools.find(pool => pool.vessel === vessel && regionContains(pool.region, inner))
    const lipEnd = add(spout.at, direction, spec.rimWidth / 2 + spout.length)
    const crest = spec.floor + spout.crest
    const frame = spout.device === 'tipper' ? tipperFrame(lipEnd, direction, crest) : null
    // A rain chain hangs from the lip: its water arrives right under it.
    const landing = frame ? tipperLanding(frame) : add(lipEnd, direction, spout.device === 'chain' ? 0.06 : 0.2)
    const target = findPool(landing, crest, vessel)
    if (!source) throw new Error(`${design.id}/${spec.name}: spout has no pool behind it`)
    if (!target) throw new Error(`${design.id}/${spec.name}: spout at ${spout.at.map(v => v.toFixed(2))} lands outside every lower pool (${landing.map(v => v.toFixed(2))})`)
    const edge: Edge = {
      index: edges.length, kind: 'spout', a: source.index, b: target.index, crest, width: spout.width,
      points: [spout.at], normal: direction, lipStart: add(spout.at, direction, -spec.rimWidth / 2), lipEnd, landing,
      ...(spout.device === 'chain' ? { chain: true } : {}),
    }
    edges.push(edge)
    if (frame) {
      edge.tipper = tippers.length
      tippers.push({
        ...frame, index: tippers.length, edge: edge.index, pool: target.index, width: TIPPER_RADIUS * 2,
        capacity: Math.max(0.06, Math.min(0.15, target.area * 0.04)), landing, base: 0,
      })
    } else if (spout.device === 'wheel') spoutWheels.push(edge.index)
  }
  const lifts: Lift[] = [], siphons: Siphon[] = []
  for (const { vessel, chute } of pendingChutes) {
    const spec = design.vessels[vessel]
    const direction = normalize(chute.direction)
    const source = pools.find(pool => pool.vessel === vessel && regionContains(pool.region, add(chute.at, direction, -(spec.rimWidth / 2 + 0.16))))
    const end = chute.path[chute.path.length - 1]
    const landing = add([end[0], end[1]], endDirection(chute.path), 0.22)
    const target = findPool(landing, end[2], vessel)
    if (!source) throw new Error(`${design.id}/${spec.name}: chute has no pool behind it`)
    if (!target) throw new Error(`${design.id}/${spec.name}: chute lands outside every lower pool (${landing.map(v => v.toFixed(2))})`)
    edges.push({
      index: edges.length, kind: 'chute', a: source.index, b: target.index, crest: spec.floor + chute.crest, width: chute.width,
      points: [chute.at], normal: direction, lipStart: add(chute.at, direction, -spec.rimWidth / 2), lipEnd: [chute.path[0][0], chute.path[0][1]],
      landing, path: chute.path.slice(), delay: pathLength(chute.path) / CHUTE_SPEED,
    })
  }
  for (const { vessel, lift } of pendingLifts) {
    const spec = design.vessels[vessel]
    const source = pools.find(pool => pool.vessel === vessel && regionContains(pool.region, lift.center))
    const end = lift.path[lift.path.length - 1]
    const landing = add([end[0], end[1]], endDirection(lift.path), 0.22)
    const target = findPool(landing, end[2])
    if (!source) throw new Error(`${design.id}/${spec.name}: noria stands outside its sump`)
    if (!target) throw new Error(`${design.id}/${spec.name}: noria trough lands outside every basin (${landing.map(v => v.toFixed(2))})`)
    const rise = lift.kind === 'screw' ? (lift.length ?? 4) / SCREW_AXIAL_SPEED : Math.PI * lift.radius / LIFT_SPEED
    const edge: Edge = {
      index: edges.length, kind: 'lift', a: source.index, b: target.index, crest: source.floor + LIFT_SILL, width: lift.width * 4,
      points: [lift.center], normal: normalize(lift.direction), landing, path: lift.path.slice(),
      delay: rise + pathLength(lift.path) / CHUTE_SPEED, rise, lift: lifts.length,
    }
    edges.push(edge)
    lifts.push({ ...lift, index: lifts.length, edge: edge.index, pool: source.index, base: source.floor })
  }
  for (const { vessel, siphon } of pendingSiphons) {
    const spec = design.vessels[vessel]
    const source = pools.find(pool => pool.vessel === vessel && regionContains(pool.region, siphon.at))
    const mouth = siphon.path[siphon.path.length - 1]
    const landing: Vec2 = [mouth[0], mouth[1]]
    const target = findPool(landing, mouth[2], vessel)
    if (!source) throw new Error(`${design.id}/${spec.name}: siphon bell stands outside the water`)
    if (!target) throw new Error(`${design.id}/${spec.name}: siphon discharges outside every lower pool`)
    const edge: Edge = {
      index: edges.length, kind: 'siphon', a: source.index, b: target.index, crest: spec.floor + siphon.stop, width: Math.PI * siphon.diameter,
      points: [siphon.at], normal: endDirection(siphon.path), landing, path: siphon.path.slice(),
      trigger: spec.floor + siphon.trigger, siphon: siphons.length,
    }
    edges.push(edge)
    siphons.push({ ...siphon, index: siphons.length, edge: edge.index, pool: source.index, base: spec.floor })
  }
  // Orient every step downstream: its upper side is the pool the water
  // reaches first from the source.
  const hops = new Array<number>(pools.length).fill(Infinity)
  const firstPool = findPool(add(design.source.lip, normalize([design.source.lip[0] - design.source.tower[0], design.source.lip[1] - design.source.tower[1]]), SOURCE_THROW), design.source.lipZ)
  if (firstPool) {
    hops[firstPool.index] = 0
    for (let changed = true; changed;) {
      changed = false
      for (const edge of edges) if (edge.b >= 0) {
        const next = Math.min(hops[edge.a], hops[edge.b]) + 1
        if (hops[edge.a] > next) { hops[edge.a] = next; changed = true }
        if (hops[edge.b] > next) { hops[edge.b] = next; changed = true }
      }
    }
  }
  for (const edge of edges) if (edge.kind === 'sill' && hops[edge.b] < hops[edge.a]) {
    const a = edge.a
    edge.a = edge.b; edge.b = a
    edge.normal = [-edge.normal[0], -edge.normal[1]]
  }
  // Raise each bed to a fixed depth below its lowest outlet: pools fill in
  // seconds rather than minutes, and walls keep plenty of freeboard.
  for (const pool of pools) {
    // Sumps (noria) and siphon basins keep their authored depth.
    if (edges.some(edge => edge.a === pool.index && (edge.kind === 'lift' || edge.kind === 'siphon'))) continue
    const outlets = edges.filter(edge => edge.a === pool.index && edge.kind !== 'drain').map(edge => edge.crest)
    // Terraces: the bed sits just under its step edge, so the water runs
    // shallow across each level and pours over the edge onto the next.
    if (outlets.length) pool.floor = Math.min(...outlets) - BED_DEPTH
  }
  for (const vessel of vessels) {
    const own = pools.filter(pool => pool.vessel === vessel.index)
    if (own.length) vessel.baseFloor = Math.min(...own.map(pool => pool.floor))
  }
  // Machinery stands on the finished beds.
  for (const tipper of tippers) tipper.base = pools[tipper.pool].floor
  for (const lift of lifts) { lift.base = pools[lift.pool].floor; edges[lift.edge].crest = lift.base + LIFT_SILL }
  for (const index of spoutWheels) {
    const edge = edges[index], floor = pools[edge.b].floor
    const radius = spoutWheelRadius(edge.crest, floor)
    wheels.push({
      index: wheels.length, edge: index, center: add(edge.lipEnd!, edge.normal, radius * 0.75), z: edge.crest - SPOUT_WHEEL_DROP - radius,
      axis: [-edge.normal[1], edge.normal[0]], direction: edge.normal, radius, width: edge.width * 0.92, overshot: true, base: floor,
    })
  }
  for (const index of sillWheels) {
    const edge = edges[index]
    const { point, tangent } = midpoint(edge.points)
    wheels.push({
      index: wheels.length, edge: index, center: add(point, edge.normal, SILL_WHEEL_RADIUS + 0.04), z: edge.crest + SILL_WHEEL_LIFT,
      axis: tangent, direction: edge.normal, radius: SILL_WHEEL_RADIUS, width: Math.max(0.3, edge.width * 0.78), overshot: false,
      base: pools[edge.b].floor,
    })
  }
  const { source: sourceSpec } = design
  const direction = normalize([sourceSpec.lip[0] - sourceSpec.tower[0], sourceSpec.lip[1] - sourceSpec.tower[1]])
  const landing = add(sourceSpec.lip, direction, SOURCE_THROW)
  const sourcePool = findPool(landing, sourceSpec.lipZ)
  if (!sourcePool) throw new Error(`${design.id}: the source lands outside the water`)
  const bounds = boundsOf([
    ...vessels.flatMap(vessel => vessel.footprint.map(region => region.outer)),
    [sourceSpec.tower],
    ...edges.filter(edge => edge.path).map(edge => edge.path!.map(([x, y]) => [x, y] as Vec2)),
    ...lifts.map(lift => lift.kind === 'screw'
      ? [lift.center, add(lift.center, normalize(lift.direction), (lift.length ?? 4) * Math.cos(lift.incline ?? 0.5))]
      : [add(lift.center, normalize(lift.direction), lift.radius), add(lift.center, normalize(lift.direction), -lift.radius)]),
  ])
  return {
    id: design.id, design, vessels, pools, edges, tippers, wheels, lifts, siphons,
    source: { pool: sourcePool.index, tower: sourceSpec.tower, lip: sourceSpec.lip, landing, lipZ: sourceSpec.lipZ, width: sourceSpec.width, direction, round: !!sourceSpec.round },
    bounds, height: Math.max(sourceSpec.lipZ + 0.3, ...vessels.map(vessel => vessel.top),
      ...edges.flatMap(edge => edge.path?.map(point => point[2] + 0.2) ?? []),
      ...lifts.map(lift => lift.kind === 'screw' ? lift.hub + (lift.length ?? 4) * Math.sin(lift.incline ?? 0.5) + lift.radius + 0.3 : lift.hub + lift.radius + 0.2)),
  }
}

const cache = new Map<string, GardenLayout>()
const crafted = new Map<string, GardenDesign>()
/** Crafted gardens kept compiled at once: the current one and a few before it. */
const CRAFTED_KEPT = 4

/**
 * Make a crafted garden available under `key` (it must start with "craft-").
 * Older crafted gardens are forgotten; presets stay cached for the page.
 */
export function registerGardenDesign(key: `craft-${string}`, design: GardenDesign): void {
  if (crafted.has(key)) return
  crafted.set(key, { ...design, id: key })
  while (crafted.size > CRAFTED_KEPT) {
    const oldest = crafted.keys().next().value!
    crafted.delete(oldest); cache.delete(oldest)
  }
}

/** Compiled once per page; the design is static and fully deterministic. */
export function gardenLayout(id: GardenKey): GardenLayout {
  let layout = cache.get(id)
  if (!layout) {
    const design = id.startsWith('craft-') ? crafted.get(id) : createGardenDesign(id as GardenId)
    if (!design) throw new Error(`Unknown water garden: ${id}`)
    layout = compileGarden(design); cache.set(id, layout)
  }
  return layout
}
