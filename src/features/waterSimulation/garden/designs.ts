import type { Polyline, Ring, Vec2 } from './polygon'

/**
 * Authored water gardens. Every basin is an open, gravity-fed maze: channels
 * between rounded ceramic walls, low weirs (sills) that split it into pools
 * at different levels, and spouts that pour into the next, lower basin.
 * Plan coordinates: x right, y away from the viewer, z up (metres).
 */
export type GardenId = 'atelier' | 'cascade' | 'split' | 'serpentine' | 'garden'

export interface SillSpec {
  /** Polyline across a gap, from one wall centreline to another. */
  points: Vec2[]
  /** Crest height above the basin's reference floor. */
  crest: number
  /** A paddle wheel turns over this step. */
  wheel?: boolean
}

/** Machinery a spout pours into: a tipping tube or a paddle wheel. */
export type SpoutDevice = 'tipper' | 'wheel'

export interface SpoutSpec {
  /** Point on the rim centreline. */
  at: Vec2
  /** Unit direction out of the basin. */
  direction: Vec2
  /** Clear channel width. */
  width: number
  /** Crest height above the basin's reference floor. */
  crest: number
  /** Cantilever beyond the rim's outer face. */
  length: number
  device?: SpoutDevice
}

export type Vec3 = readonly [number, number, number]

/**
 * A long open channel — aqueduct, slide or spiral — fed over a crest in the
 * rim like a spout. Its bed follows `path` (world x, y, z) from the rim's
 * outer face; water travels it at channel speed and pours off its end.
 */
export interface ChuteSpec {
  at: Vec2
  direction: Vec2
  width: number
  /** Crest above the basin's reference floor. */
  crest: number
  path: Vec3[]
}

/**
 * A noria: a great bucket wheel standing in a sump. Its buckets scoop water
 * at the bottom, carry it over the top and tip it into a trough (`path`)
 * that runs to a higher basin.
 */
export interface LiftSpec {
  center: Vec2
  /** Unit direction of the wheel's plane (the buckets rise on this side). */
  direction: Vec2
  radius: number
  /** Axle height. */
  hub: number
  width: number
  path: Vec3[]
}

/**
 * A bell siphon: the basin fills to `trigger`, the siphon primes and drains
 * it in a rush down to `stop`, then breaks and the basin fills again.
 */
export interface SiphonSpec {
  /** Bell position inside the basin. */
  at: Vec2
  /** Levels above the basin's reference floor. */
  trigger: number
  stop: number
  diameter: number
  /** Pipe from the bell over the rim to its mouth (world x, y, z). */
  path: Vec3[]
}

export interface VesselSpec {
  name: string
  /** Reference floor (top of the bed), absolute z. */
  floor: number
  wallHeight: number
  wallWidth: number
  rimWidth: number
  /** Closed rim centreline. */
  outline: Ring
  walls: Polyline[]
  /** Solid islands and planters, filled up to wall height. */
  islands: Ring[]
  sills: SillSpec[]
  spouts: SpoutSpec[]
  /** Pools containing a seed are lowered by `offset` (≤ 0). */
  floors: { seed: Vec2; offset: number }[]
  chutes?: ChuteSpec[]
  lifts?: LiftSpec[]
  siphons?: SiphonSpec[]
  /** Terminal drain for the receiving basin. */
  drain?: { crest: number; width: number; at: Vec2 }
  planters: Vec2[]
}

export interface SourceSpec {
  tower: Vec2
  lip: Vec2
  lipZ: number
  width: number
  /** Pier silhouette; the ring garden uses a round central column. */
  round?: boolean
}

export type PlantKind = 'olive' | 'rosemary' | 'fern' | 'stones'

export interface GardenDesign {
  id: GardenId
  vessels: VesselSpec[]
  source: SourceSpec
  plants: { kind: PlantKind; at: Vec2; scale: number; z?: number }[]
}

// ---------------------------------------------------------------------------
// Geometric helpers

const TAU = Math.PI * 2

export function roundedRect(cx: number, cy: number, width: number, height: number, radius: number): Ring {
  const r = Math.min(radius, width / 2, height / 2)
  const points: Vec2[] = []
  const corners: [number, number, number][] = [
    [cx + width / 2 - r, cy - height / 2 + r, -Math.PI / 2],
    [cx + width / 2 - r, cy + height / 2 - r, 0],
    [cx - width / 2 + r, cy + height / 2 - r, Math.PI / 2],
    [cx - width / 2 + r, cy - height / 2 + r, Math.PI],
  ]
  for (const [x, y, start] of corners) {
    for (let i = 0; i <= 10; i++) {
      const a = start + i / 10 * Math.PI / 2
      points.push([x + Math.cos(a) * r, y + Math.sin(a) * r])
    }
  }
  return points
}

export function circle(cx: number, cy: number, radius: number, count = Math.max(24, Math.ceil(radius * 40))): Ring {
  return Array.from({ length: count }, (_, i) => {
    const a = i / count * TAU
    return [cx + Math.cos(a) * radius, cy + Math.sin(a) * radius] as Vec2
  })
}

export function arc(cx: number, cy: number, radius: number, from: number, to: number, step = 0.05): Vec2[] {
  const count = Math.max(2, Math.ceil(Math.abs(to - from) * radius / step))
  return Array.from({ length: count + 1 }, (_, i) => {
    const a = from + (to - from) * i / count
    return [cx + Math.cos(a) * radius, cy + Math.sin(a) * radius] as Vec2
  })
}

/** Replace each corner of an open polyline with a circular fillet. */
export function filleted(points: readonly Vec2[], radius: number): Vec2[] {
  if (points.length < 3 || radius <= 0) return points.slice()
  const result: Vec2[] = [points[0]]
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i - 1], [x, y] = points[i], [nx, ny] = points[i + 1]
    const inLength = Math.hypot(x - px, y - py), outLength = Math.hypot(nx - x, ny - y)
    const ux = (x - px) / inLength, uy = (y - py) / inLength, vx = (nx - x) / outLength, vy = (ny - y) / outLength
    const turn = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
    if (Math.abs(turn) < 1e-3) { result.push(points[i]); continue }
    const cut = Math.min(radius * Math.tan(Math.abs(turn) / 2), inLength * 0.5, outLength * 0.5)
    const r = cut / Math.tan(Math.abs(turn) / 2)
    const sx = x - ux * cut, sy = y - uy * cut
    const side = Math.sign(turn)
    const cx = sx - uy * r * side, cy = sy + ux * r * side
    const a0 = Math.atan2(sy - cy, sx - cx)
    const steps = Math.max(3, Math.ceil(Math.abs(turn) * r / 0.04))
    for (let k = 0; k <= steps; k++) {
      const a = a0 + turn * k / steps
      result.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r])
    }
  }
  result.push(points[points.length - 1])
  return result
}

function hashSeed(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619) }
  return h >>> 0
}

/** Mulberry32: small, deterministic, independent of the maze core's RNG. */
export function seededRandom(seed: string): () => number {
  let state = hashSeed(seed)
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---------------------------------------------------------------------------
// Lattice labyrinths

export type Side = 'north' | 'south' | 'east' | 'west'
export interface Cell { i: number; j: number }

export interface LatticeOptions {
  cols: number
  rows: number
  pitch: number
  /** World position of lattice vertex (0, 0): the south-west corner. */
  origin: Vec2
  seed: string
  /** Merged open rooms (internal walls removed). */
  rooms?: { i: number; j: number; w: number; h: number }[]
  /** Cells that become solid islands. */
  solids?: Cell[]
  entry: Cell
  exits: (Cell & { side: Side })[]
  /** Probability of continuing straight in the depth-first carve. */
  straightness?: number
  corner?: number
}

export interface Lattice {
  walls: Polyline[]
  islands: Ring[]
  /** Unique tree route from the entry to each exit, as cell lists. */
  routes: Cell[][]
  center(cell: Cell): Vec2
  vertex(i: number, j: number): Vec2
  /** Sill across the passage between two consecutive route cells. */
  sillBetween(a: Cell, b: Cell): Vec2[]
  spout(exit: Cell & { side: Side }): { at: Vec2; direction: Vec2 }
  bounds: { x0: number; y0: number; x1: number; y1: number }
}

const DIRS: [number, number][] = [[1, 0], [0, 1], [-1, 0], [0, -1]]

export function lattice(options: LatticeOptions): Lattice {
  const { cols, rows, pitch, origin } = options
  const random = seededRandom(options.seed)
  const index = (i: number, j: number) => j * cols + i
  const solid = new Uint8Array(cols * rows)
  for (const cell of options.solids ?? []) solid[index(cell.i, cell.j)] = 1
  // Union-find groups room cells into one node of the spanning tree.
  const group = Int32Array.from({ length: cols * rows }, (_, i) => i)
  const find = (a: number): number => { while (group[a] !== a) a = group[a] = group[group[a]]; return a }
  const roomOf = new Int32Array(cols * rows).fill(-1)
  ;(options.rooms ?? []).forEach((room, r) => {
    for (let j = room.j; j < room.j + room.h; j++) for (let i = room.i; i < room.i + room.w; i++) {
      roomOf[index(i, j)] = r
      group[find(index(i, j))] = find(index(room.i, room.j))
    }
  })
  const open = new Set<string>()
  const edgeKey = (a: number, b: number) => a < b ? `${a}:${b}` : `${b}:${a}`
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const r = roomOf[index(i, j)]
    if (r < 0) continue
    if (i + 1 < cols && roomOf[index(i + 1, j)] === r) open.add(edgeKey(index(i, j), index(i + 1, j)))
    if (j + 1 < rows && roomOf[index(i, j + 1)] === r) open.add(edgeKey(index(i, j), index(i, j + 1)))
  }
  // Depth-first carve over room-merged nodes; a straightness bias makes
  // long, readable water corridors rather than a field of one-cell stubs.
  const visited = new Uint8Array(cols * rows)
  const markVisited = (cell: number) => {
    const root = find(cell)
    for (let k = 0; k < cols * rows; k++) if (find(k) === root) visited[k] = 1
  }
  const cellsOf = (cell: number) => {
    const root = find(cell), members: number[] = []
    for (let k = 0; k < cols * rows; k++) if (find(k) === root) members.push(k)
    return members
  }
  const start = index(options.entry.i, options.entry.j)
  markVisited(start)
  const stack: { cell: number; dir: number }[] = [{ cell: start, dir: -1 }]
  const straightness = options.straightness ?? 0.45
  while (stack.length) {
    const top = stack[stack.length - 1]
    const candidates: { from: number; to: number; dir: number }[] = []
    for (const member of cellsOf(top.cell)) {
      const i = member % cols, j = Math.floor(member / cols)
      DIRS.forEach(([dx, dy], dir) => {
        const ni = i + dx, nj = j + dy
        if (ni < 0 || nj < 0 || ni >= cols || nj >= rows) return
        const next = index(ni, nj)
        if (solid[next] || visited[next]) return
        candidates.push({ from: member, to: next, dir })
      })
    }
    if (!candidates.length) { stack.pop(); continue }
    let choice = candidates[Math.floor(random() * candidates.length)]
    const straight = candidates.filter(c => c.dir === top.dir && c.from === top.cell)
    if (straight.length && random() < straightness) choice = straight[0]
    open.add(edgeKey(choice.from, choice.to))
    markVisited(choice.to)
    stack.push({ cell: choice.to, dir: choice.dir })
  }
  const passable = (a: number, b: number) => open.has(edgeKey(a, b))
  // Routes through the tree (BFS over open passages).
  const routes = options.exits.map(exit => {
    const goal = index(exit.i, exit.j)
    const previous = new Int32Array(cols * rows).fill(-2)
    previous[start] = -1
    const queue = [start]
    for (let head = 0; head < queue.length; head++) {
      const cell = queue[head]
      if (cell === goal) break
      const i = cell % cols, j = Math.floor(cell / cols)
      for (const [dx, dy] of DIRS) {
        const ni = i + dx, nj = j + dy
        if (ni < 0 || nj < 0 || ni >= cols || nj >= rows) continue
        const next = index(ni, nj)
        if (previous[next] !== -2 || !passable(cell, next)) continue
        previous[next] = cell
        queue.push(next)
      }
    }
    if (previous[goal] === -2) throw new Error(`Lattice exit ${exit.i},${exit.j} is unreachable`)
    const route: Cell[] = []
    for (let cell = goal; cell !== -1; cell = previous[cell]) route.push({ i: cell % cols, j: Math.floor(cell / cols) })
    return route.reverse()
  })
  const vertex = (i: number, j: number): Vec2 => [origin[0] + i * pitch, origin[1] + j * pitch]
  // Wall segments on interior lattice lines where no passage exists.
  const adjacency = new Map<string, string[]>()
  const vkey = (i: number, j: number) => `${i},${j}`
  const addSegment = (a: [number, number], b: [number, number]) => {
    const ka = vkey(...a), kb = vkey(...b)
    adjacency.set(ka, [...(adjacency.get(ka) ?? []), kb])
    adjacency.set(kb, [...(adjacency.get(kb) ?? []), ka])
  }
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const a = index(i, j)
    if (i + 1 < cols) {
      const b = index(i + 1, j)
      if (!passable(a, b) && !solid[a] && !solid[b]) addSegment([i + 1, j], [i + 1, j + 1])
    }
    if (j + 1 < rows) {
      const b = index(i, j + 1)
      if (!passable(a, b) && !solid[a] && !solid[b]) addSegment([i, j + 1], [i + 1, j + 1])
    }
  }
  const used = new Set<string>()
  const segKey = (a: string, b: string) => a < b ? `${a}|${b}` : `${b}|${a}`
  const parse = (key: string) => key.split(',').map(Number) as [number, number]
  const chains: [number, number][][] = []
  const walk = (from: string, to: string) => {
    const chain = [parse(from)]
    let previous = from, current = to
    used.add(segKey(from, to))
    for (;;) {
      chain.push(parse(current))
      const next = adjacency.get(current)!
      if (next.length !== 2) break
      const onward = next[0] === previous ? next[1] : next[0]
      if (used.has(segKey(current, onward))) break
      used.add(segKey(current, onward))
      previous = current; current = onward
    }
    chains.push(chain)
  }
  for (const [key, next] of adjacency) if (next.length !== 2) for (const other of next) if (!used.has(segKey(key, other))) walk(key, other)
  for (const [key, next] of adjacency) for (const other of next) if (!used.has(segKey(key, other))) walk(key, other)
  const corner = options.corner ?? pitch * 0.3
  const walls: Polyline[] = chains.map(chain => {
    // Collapse collinear lattice steps before filleting the true corners.
    const compact = chain.filter((point, k) => {
      if (k === 0 || k === chain.length - 1) return true
      const [a, b, c] = [chain[k - 1], point, chain[k + 1]]
      return (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) !== 0
    })
    return { points: filleted(compact.map(([i, j]) => vertex(i, j)), corner), closed: false }
  })
  const islands = (options.solids ?? []).map(cell => roundedRect(
    origin[0] + (cell.i + 0.5) * pitch, origin[1] + (cell.j + 0.5) * pitch, pitch + 0.02, pitch + 0.02, pitch * 0.22))
  const center = (cell: Cell): Vec2 => [origin[0] + (cell.i + 0.5) * pitch, origin[1] + (cell.j + 0.5) * pitch]
  return {
    walls, islands, routes, center, vertex,
    sillBetween(a, b) {
      if (a.i !== b.i) { const i = Math.max(a.i, b.i); return [vertex(i, a.j), vertex(i, a.j + 1)] }
      const j = Math.max(a.j, b.j); return [vertex(a.i, j), vertex(a.i + 1, j)]
    },
    spout(exit) {
      const { i, j } = exit
      switch (exit.side) {
        case 'south': return { at: [origin[0] + (i + 0.5) * pitch, origin[1]], direction: [0, -1] }
        case 'north': return { at: [origin[0] + (i + 0.5) * pitch, origin[1] + rows * pitch], direction: [0, 1] }
        case 'east': return { at: [origin[0] + cols * pitch, origin[1] + (j + 0.5) * pitch], direction: [1, 0] }
        default: return { at: [origin[0], origin[1] + (j + 0.5) * pitch], direction: [-1, 0] }
      }
    },
    bounds: { x0: origin[0], y0: origin[1], x1: origin[0] + cols * pitch, y1: origin[1] + rows * pitch },
  }
}

/** The ceramic rim follows the lattice boundary with softened corners. */
function latticeRim(maze: Lattice, radius: number): Ring {
  const { x0, y0, x1, y1 } = maze.bounds
  return roundedRect((x0 + x1) / 2, (y0 + y1) / 2, x1 - x0, y1 - y0, radius)
}

/** Choose sills on a route at the given fractions, avoiding room/island corners. */
function routeSills(maze: Lattice, route: Cell[], fractions: number[], avoid: (cell: Cell) => boolean): { points: Vec2[]; downstream: Cell }[] {
  const result: { points: Vec2[]; downstream: Cell }[] = []
  let lastIndex = 1
  for (const fraction of fractions) {
    let k = Math.max(lastIndex + 1, Math.round(fraction * (route.length - 1)))
    const { x0, y0, x1, y1 } = maze.bounds
    // A step line must end on a wall or on the straight part of the rim;
    // the rim's rounded corners do not pass through lattice corners.
    const atCorner = (a: Cell, b: Cell) => maze.sillBetween(a, b).some(([x, y]) =>
      (Math.abs(x - x0) < 1e-6 || Math.abs(x - x1) < 1e-6) && (Math.abs(y - y0) < 1e-6 || Math.abs(y - y1) < 1e-6))
    while (k < route.length - 1 && (avoid(route[k - 1]) || avoid(route[k]) || atCorner(route[k - 1], route[k]))) k++
    if (k >= route.length - 1) break
    result.push({ points: maze.sillBetween(route[k - 1], route[k]), downstream: route[k] })
    lastIndex = k
  }
  return result
}

/** Where a spout's water meets the pool below (matches the layout compiler). */
export function spoutLanding(spout: { at: Vec2; direction: Vec2 }, rimWidth: number, length: number): Vec2 {
  const reach = rimWidth / 2 + length + 0.2
  return [spout.at[0] + spout.direction[0] * reach, spout.at[1] + spout.direction[1] * reach]
}

/** A small receiving basin tucked against the vessel, below its last spout. */
function drainBasin(spout: { at: Vec2; direction: Vec2 }, rimWidth: number, length: number, width: number, depth: number, floor = 0.06): VesselSpec {
  const landing = spoutLanding(spout, rimWidth, length)
  const [dx, dy] = spout.direction
  const reach = depth / 2 - 0.45
  const cx = landing[0] + dx * reach, cy = landing[1] + dy * reach
  const along = Math.abs(dx) > Math.abs(dy)
  return {
    name: 'receiving-basin', floor, wallHeight: 0.46, wallWidth: WALL, rimWidth: 0.4,
    outline: roundedRect(cx, cy, along ? depth : width, along ? width : depth, Math.min(width, depth) * 0.45),
    walls: [], islands: [], sills: [], spouts: [], floors: [], planters: [],
    drain: { crest: 0.12, width: 2.0, at: [cx + dx * 0.2, cy + dy * 0.2] },
  }
}

/** A round basin with no inner walls. */
function roundBasin(name: string, center: Vec2, radius: number, floor: number, wallHeight: number, rimWidth: number, extra: Partial<VesselSpec> = {}): VesselSpec {
  return {
    name, floor, wallHeight, wallWidth: 0.3, rimWidth, outline: circle(center[0], center[1], radius, Math.max(48, Math.ceil(radius * 60))),
    walls: [], islands: [], sills: [], spouts: [], floors: [], planters: [], ...extra,
  }
}

const along = (origin: Vec2, u: Vec2, v: Vec2, a: number, b: number): Vec2 => [origin[0] + u[0] * a + v[0] * b, origin[1] + u[1] * a + v[1] * b]

/** Descending helical channel around `center`, sweeping `sweep` radians from angle `a0`. */
function helix(center: Vec2, radius: number, a0: number, sweep: number, z0: number, z1: number): Vec3[] {
  const count = Math.max(8, Math.ceil(Math.abs(sweep) * radius / 0.14))
  return Array.from({ length: count + 1 }, (_, k) => {
    const t = k / count, a = a0 + sweep * t
    return [center[0] + Math.cos(a) * radius, center[1] + Math.sin(a) * radius, z0 + (z1 - z0) * t] as Vec3
  })
}

export interface TailOptions {
  /** Which side of the course the tower stands on (+1: left of the flow). */
  side: 1 | -1
  /** Full turns of the spiral before it straightens out (plus three quarters). */
  turns?: number
  noriaRadius?: number
}

/** Length of the cantilever a machine tail expects on the spout that feeds it. */
export const TAIL_SPOUT_LENGTH = 0.8

/**
 * The machine run that closes every course. The last spout tips into a sump;
 * a great noria lifts the water to a trough that feeds a head tank on a
 * tower; a spiral chute winds down around the tower into a cistern; a bell
 * siphon empties the cistern in rushes into the receiving basin and its drain.
 */
export function machineTail(spout: { at: Vec2; direction: Vec2 }, rimWidth: number, options: TailOptions): VesselSpec[] {
  const u = spout.direction, v: Vec2 = [-u[1] * options.side, u[0] * options.side]
  const lipEnd = along(spout.at, u, v, rimWidth / 2 + TAIL_SPOUT_LENGTH, 0)
  const R = options.noriaRadius ?? 1.85, hub = 0.1 + R
  const wheel = along(lipEnd, u, v, 1.35, 0)
  const sump = roundBasin('noria-sump', along(wheel, u, v, -0.35, 0), 1.5, 0.05, 0.5, 0.4, {
    lifts: [{
      center: wheel, direction: v, radius: R, hub, width: 0.5,
      path: [[...along(wheel, u, v, 0.55, 0), hub + 0.85 * R], [...along(wheel, u, v, 0.55, 3.35), hub + 0.85 * R - 0.1]] as Vec3[],
    }],
  })
  const tower = along(wheel, u, v, 0.55, 3.9)
  const cupRadius = 0.75, crest = 0.1, cupFloor = hub + 0.85 * R - 1.0
  const helixRadius = 1.3
  // Start facing away from the trough, wind counter-clockwise (seen from
  // above, relative to the course) and leave heading down-course.
  const a0 = Math.atan2(v[1], v[0]), aEnd = Math.atan2(u[1], u[0])
  let sweep = ((aEnd - a0) * options.side % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2)
  sweep = (sweep + Math.PI * 2 * (options.turns ?? 1)) * options.side
  const top = cupFloor + crest, low = 1.98
  const out = (r: number): Vec2 => along(tower, u, v, 0, r)
  const spiral = helix(tower, helixRadius, a0, sweep, top - 0.02, low + 0.04)
  const cistern = along(tower, u, v, helixRadius + 1.7, 0)
  const cup = roundBasin('head-tank', tower, cupRadius, cupFloor, 0.7, 0.24, {
    chutes: [{
      at: out(cupRadius), direction: v, width: 0.6, crest,
      path: [[...out(cupRadius + 0.12), top], [...out(helixRadius), top - 0.01], ...spiral.slice(1), [...along(tower, u, v, helixRadius + 0.9, 0), low]] as Vec3[],
    }],
  })
  const receiving = along(cistern, u, v, 2.5, 0)
  const siphonBasin = roundBasin('siphon-cistern', cistern, 0.85, 0.95, 0.9, 0.3, {
    siphons: [{
      at: cistern, trigger: 0.32, stop: 0.1, diameter: 0.42,
      path: [[...cistern, 1.0], [...cistern, 2.02], [...along(cistern, u, v, 1.9, 0), 2.02], [...along(cistern, u, v, 1.9, 0), 0.72]] as Vec3[],
    }],
  })
  const drain = roundBasin('receiving-basin', receiving, 0.95, 0.04, 0.56, 0.4, { drain: { crest: 0.12, width: 2.0, at: receiving } })
  return [sump, cup, siphonBasin, drain]
}

function inRoom(rooms: LatticeOptions['rooms'] = [], solids: Cell[] = []) {
  return (cell: Cell) => rooms.some(room => cell.i >= room.i - 1 && cell.i <= room.i + room.w && cell.j >= room.j - 1 && cell.j <= room.j + room.h)
    || solids.some(solid => Math.abs(solid.i - cell.i) + Math.abs(solid.j - cell.j) <= 1)
}


// ---------------------------------------------------------------------------
// The five collection pieces

const WALL = 0.34
const RIM = 0.5
/** Horizontal travel of the source pour, lip to landing (m). */
export const SOURCE_THROW = 0.3

function source(landing: Vec2, towerOffset: Vec2, lipZ: number, width = 0.44): SourceSpec {
  const length = Math.hypot(towerOffset[0], towerOffset[1])
  // The pour leaves the lip with some forward speed: set the lip back
  // towards the tower so the water lands in the middle of the entry cell.
  const lip: Vec2 = [landing[0] + towerOffset[0] / length * SOURCE_THROW, landing[1] + towerOffset[1] / length * SOURCE_THROW]
  return { tower: [landing[0] + towerOffset[0], landing[1] + towerOffset[1]], lip, lipZ, width }
}

function towards(from: Vec2, to: Vec2, distance: number): Vec2 {
  const d = Math.hypot(to[0] - from[0], to[1] - from[1]) || 1
  return [from[0] + (to[0] - from[0]) / d * distance, from[1] + (to[1] - from[1]) / d * distance]
}

/** Origin that centres `cell` of a lattice on a given landing point. */
function originFor(landing: Vec2, cell: Cell, pitch: number): Vec2 {
  return [landing[0] - (cell.i + 0.5) * pitch, landing[1] - (cell.j + 0.5) * pitch]
}

function atelier(): GardenDesign {
  const pitch = 1.25, cols = 7, rows = 6
  const origin: Vec2 = [-cols * pitch / 2, -rows * pitch / 2 + 0.6]
  const rooms = [{ i: 3, j: 2, w: 2, h: 2 }, { i: 0, j: 0, w: 2, h: 2 }]
  const solids = [{ i: 6, j: 3 }]
  const entry = { i: 0, j: 5 }, exit = { i: 5, j: 0, side: 'south' as const }
  const maze = lattice({ cols, rows, pitch, origin, seed: 'atelier-garden-v2', rooms, solids, entry, exits: [exit], straightness: 0.55 })
  const floor = 0.95, height = 0.95
  // Steps may not touch a merged room (its inner vertices carry no wall).
  const insideRoom = (cell: Cell) => rooms.some(room => cell.i >= room.i && cell.i < room.i + room.w && cell.j >= room.j && cell.j < room.j + room.h)
    || solids.some(solid => solid.i === cell.i && solid.j === cell.j)
  const sills = routeSills(maze, maze.routes[0], [0.12, 0.26, 0.4, 0.54, 0.68, 0.82], insideRoom)
  const fountain = maze.vertex(4, 3)
  const spiralCenter = maze.vertex(1, 1)
  const spiral = Array.from({ length: 160 }, (_, k) => {
    const t = k / 159, a = Math.PI * 0.75 + t * Math.PI * 1.8, r = 0.14 + t * 0.58
    return [spiralCenter[0] + Math.cos(a) * r, spiralCenter[1] + Math.sin(a) * r] as Vec2
  })
  const spout = maze.spout(exit)
  const main: VesselSpec = {
    name: 'porcelain-garden', floor, wallHeight: height, wallWidth: WALL, rimWidth: RIM,
    outline: latticeRim(maze, 0.9),
    walls: [...maze.walls, { points: spiral, width: 0.24 }],
    islands: [...maze.islands, circle(fountain[0], fountain[1], 0.5)],
    sills: sills.map((sill, k) => ({ points: sill.points, crest: 0.56 - 0.08 * k, wheel: k % 2 === 1 })),
    spouts: [{ ...spout, width: 0.62, crest: 0.56 - 0.08 * sills.length, length: TAIL_SPOUT_LENGTH, device: 'tipper' }],
    floors: sills.map((sill, k) => ({ seed: maze.center(sill.downstream), offset: -0.1 * (k + 1) })),
    planters: [maze.center({ i: 6, j: 3 })],
  }
  const { x0, y0, x1, y1 } = maze.bounds
  return {
    id: 'atelier',
    vessels: [main, ...machineTail(spout, RIM, { side: 1, turns: 2 })],
    source: source(maze.center(entry), [0, 1.95], floor + height + 0.3),
    plants: [
      { kind: 'olive', at: [x0 - 1.2, y1 - 0.4], scale: 1.89 },
      { kind: 'rosemary', at: [x1 + 1.0, y0 + 1.4], scale: 1.59 },
      { kind: 'stones', at: [x0 - 1.0, y0 + 0.6], scale: 1.1 },
      { kind: 'fern', at: [x1 + 0.9, y1 - 0.5], scale: 1.45 },
    ],
  }
}

function cascade(): GardenDesign {
  const pitch = 1.1, cols = 4, rows = 3, length = 0.45
  const floors = [3.1, 2.0, 0.76]
  const exits = [3, 0, 3]
  const vessels: VesselSpec[] = []
  let landing: Vec2 = [-0.8, 3.4]
  let firstLanding: Vec2 = landing
  let spout: { at: Vec2; direction: Vec2 } = { at: [0, 0], direction: [0, -1] }
  for (let level = 0; level < 3; level++) {
    const entry = { i: level === 1 ? 1 : 2, j: rows - 1 }
    const origin = originFor(landing, entry, pitch)
    const exit = { i: exits[level], j: 0, side: 'south' as const }
    const maze = lattice({ cols, rows, pitch, origin, seed: `cascade-level-${level}`, entry, exits: [exit], straightness: 0.35 })
    spout = maze.spout(exit)
    const sills = routeSills(maze, maze.routes[0], [0.34, 0.67], () => false)
    vessels.push({
      name: `cascade-basin-${level}`, floor: floors[level], wallHeight: 0.88, wallWidth: 0.32, rimWidth: RIM,
      outline: latticeRim(maze, 0.75), walls: maze.walls, islands: [],
      sills: sills.map((sill, k) => ({ points: sill.points, crest: 0.2 - 0.07 * k, wheel: k === 0 })),
      // Two tipping tubes relay the water down; the last fall turns a wheel.
      spouts: [{ ...spout, width: 0.78, crest: 0.2 - 0.07 * sills.length, length: level < 2 ? length : TAIL_SPOUT_LENGTH, device: level < 2 ? 'tipper' : 'wheel' }],
      floors: sills.map(sill => ({ seed: maze.center(sill.downstream), offset: -0.1 })),
      planters: [],
    })
    if (level === 0) firstLanding = maze.center(entry)
    landing = spoutLanding(spout, RIM, length)
  }
  vessels.push(...machineTail(spout, RIM, { side: 1 }))
  return {
    id: 'cascade', vessels, source: source(firstLanding, [0, 1.85], floors[0] + 0.88 + 0.3, 0.42),
    plants: [
      { kind: 'olive', at: [-4.2, 2.6], scale: 1.81 },
      { kind: 'rosemary', at: [3.9, -1.4], scale: 1.52 },
      { kind: 'stones', at: [3.6, 3.4], scale: 1.0 },
      { kind: 'fern', at: [-4.1, -4.4], scale: 1.38 },
    ],
  }
}

function split(): GardenDesign {
  const pitch = 1.0, length = 0.47
  const top = lattice({ cols: 5, rows: 3, pitch, origin: [-2.5, 1.5], seed: 'twin-top', entry: { i: 2, j: 2 },
    exits: [{ i: 0, j: 0, side: 'west' }, { i: 4, j: 0, side: 'east' }], rooms: [{ i: 1, j: 1, w: 3, h: 1 }], straightness: 0.3 })
  const topFloor = 2.5
  const topSpouts = [top.spout({ i: 0, j: 0, side: 'west' }), top.spout({ i: 4, j: 0, side: 'east' })]
  const vessels: VesselSpec[] = [{
    name: 'twin-upper', floor: topFloor, wallHeight: 0.72, wallWidth: 0.32, rimWidth: RIM,
    outline: latticeRim(top, 0.8), walls: top.walls, islands: [], sills: [],
    spouts: topSpouts.map(spout => ({ ...spout, width: 0.5, crest: 0.18, length, device: 'wheel' as const })),
    floors: [], planters: [],
  }]
  const sideFloor = 1.6
  const sideSpouts: { at: Vec2; direction: Vec2 }[] = []
  topSpouts.forEach((topSpout, k) => {
    const west = k === 0
    const cols = 3, rows = 4
    const entry = { i: west ? cols - 1 : 0, j: rows - 1 }
    const exit = { i: west ? cols - 1 : 0, j: 0, side: 'south' as const }
    const maze = lattice({ cols, rows, pitch, origin: originFor(spoutLanding(topSpout, RIM, length), entry, pitch),
      seed: `twin-side-${k}`, entry, exits: [exit], straightness: 0.4 })
    const spout = maze.spout(exit)
    sideSpouts.push(spout)
    const sills = routeSills(maze, maze.routes[0], [0.34, 0.67], () => false)
    vessels.push({
      name: `twin-${west ? 'west' : 'east'}`, floor: sideFloor, wallHeight: 0.78, wallWidth: 0.32, rimWidth: RIM,
      outline: latticeRim(maze, 0.7), walls: maze.walls, islands: [],
      sills: sills.map((sill, k) => ({ points: sill.points, crest: 0.34 - 0.08 * k, wheel: k === 1 })),
      spouts: [{ ...spout, width: 0.5, crest: 0.34 - 0.08 * sills.length, length, device: 'tipper' }],
      floors: sills.map(sill => ({ seed: maze.center(sill.downstream), offset: -0.1 })), planters: [],
    })
  })
  // The confluence receives both side spouts in its two end columns.
  const [westLanding, eastLanding] = sideSpouts.map(spout => spoutLanding(spout, RIM, length))
  const lowCols = 7, lowPitch = (eastLanding[0] - westLanding[0]) / (lowCols - 1)
  const lowEntry = { i: 0, j: 1 }, lowExit = { i: 3, j: 0, side: 'south' as const }
  const low = lattice({ cols: lowCols, rows: 2, pitch: lowPitch, origin: originFor(westLanding, lowEntry, lowPitch), seed: 'twin-low',
    entry: lowEntry, exits: [lowExit, { i: lowCols - 1, j: 1, side: 'east' }], straightness: 0.7 })
  const lowSpout = low.spout(lowExit)
  vessels.push({
    name: 'twin-confluence', floor: 0.6, wallHeight: 0.72, wallWidth: 0.32, rimWidth: RIM,
    outline: latticeRim(low, 0.7), walls: low.walls, islands: [], sills: [],
    spouts: [{ ...lowSpout, width: 0.8, crest: 0.18, length: TAIL_SPOUT_LENGTH, device: 'wheel' }], floors: [], planters: [],
  })
  vessels.push(...machineTail(lowSpout, RIM, { side: 1, turns: 2 }))
  return {
    id: 'split', vessels,
    source: source(top.center({ i: 2, j: 2 }), [0, 1.8], topFloor + 0.72 + 0.3, 0.42),
    plants: [
      { kind: 'olive', at: [-5.2, 3.6], scale: 1.59 },
      { kind: 'olive', at: [5.3, 3.3], scale: 1.45 },
      { kind: 'rosemary', at: [5.6, -3.4], scale: 1.45 },
      { kind: 'stones', at: [-5.5, -3.4], scale: 1.0 },
    ],
  }
}

function serpentine(): GardenDesign {
  // A ribbon: wavy walls leave alternate turns open. Each turn carries a
  // weir, so the water steps down along one long channel, run by run.
  const width = 8.6, runs = 5, runDepth = 1.22, step = 0.14
  const x0 = -width / 2, y0 = -runs * runDepth / 2 + 0.35
  const floor = 1.25
  const wave = (x: number, k: number) => Math.sin((x - x0) / width * TAU * 1.5 + k * 0.9) * 0.17
  const walls: Polyline[] = []
  const sills: SillSpec[] = []
  const floors: VesselSpec['floors'] = []
  const gap = 1.05
  // Run 0 is the southern (front) run; the water enters the northern run.
  const runFloor = (run: number) => -step * (runs - 1 - run)
  for (let k = 1; k < runs; k++) {
    const openEast = (runs - k) % 2 === 1
    const y = y0 + k * runDepth
    const start = openEast ? x0 : x0 + gap, end = openEast ? x0 + width - gap : x0 + width
    const points: Vec2[] = []
    for (let s = 0; s <= 90; s++) {
      const x = start + (end - start) * s / 90
      points.push([x, y + wave(x, k)])
    }
    walls.push({ points })
    const tipX = openEast ? end : start
    const rimX = openEast ? x0 + width : x0
    // Weir from the wall tip to the rim: run k spills into run k - 1.
    sills.push({ points: [[tipX, y + wave(tipX, k)], [rimX, y + wave(tipX, k)]], crest: runFloor(k) + 0.3, wheel: true })
    floors.push({ seed: [0, y - runDepth / 2], offset: runFloor(k - 1) })
  }
  const exitEast = runs % 2 === 0
  const spout = { at: [exitEast ? x0 + width - 0.75 : x0 + 0.75, y0] as Vec2, direction: [0, -1] as Vec2 }
  const main: VesselSpec = {
    name: 'ribbon-rill', floor, wallHeight: 0.76, wallWidth: 0.32, rimWidth: RIM,
    outline: roundedRect(0, y0 + runs * runDepth / 2, width, runs * runDepth, 0.85),
    walls, islands: [], sills, spouts: [{ ...spout, width: 0.6, crest: runFloor(0) + 0.3, length: TAIL_SPOUT_LENGTH, device: 'tipper' }],
    floors, planters: [],
  }
  const landing: Vec2 = [(runs - 1) % 2 === 0 ? x0 + 0.62 : x0 + width - 0.62, y0 + runs * runDepth - runDepth / 2]
  return {
    id: 'serpentine',
    vessels: [main, ...machineTail(spout, RIM, { side: -1 })],
    source: source(landing, [0, 1.85], floor + 0.76 + 0.3),
    plants: [
      { kind: 'olive', at: [-5.6, 2.6], scale: 1.74 },
      { kind: 'rosemary', at: [5.5, 1.2], scale: 1.59 },
      { kind: 'fern', at: [5.3, -2.6], scale: 1.45 },
      { kind: 'stones', at: [-5.4, -2.2], scale: 1.1 },
    ],
  }
}

function waterGarden(): GardenDesign {
  // Concentric labyrinth. A central column pours into the inner ring; each
  // ring wall has one weir gap, and a radial baffle beside it sends the
  // water the long way round before it can step outward.
  const cx = 0, cy = 0.5, floor = 0.95
  const radii = [1.38, 2.3, 3.22]
  const rim = 4.25
  const gapAngles = [-Math.PI / 2 + 0.1, Math.PI / 2 + 0.25, -Math.PI / 2 - 0.35]
  const gapHalf = [0.3, 0.2, 0.15]
  const walls: Polyline[] = []
  const sills: SillSpec[] = []
  const floors: VesselSpec['floors'] = []
  radii.forEach((r, k) => {
    const g = gapAngles[k], h = gapHalf[k]
    walls.push({ points: arc(cx, cy, r, g + h, g + TAU - h) })
    sills.push({ points: arc(cx, cy, r, g - h - 0.05, g + h + 0.05), crest: 0.4 - 0.1 * k, wheel: true })
    const outer = k + 1 < radii.length ? radii[k + 1] : rim
    const b = g - h - 0.32
    walls.push({ points: [[cx + Math.cos(b) * r, cy + Math.sin(b) * r], [cx + Math.cos(b) * outer, cy + Math.sin(b) * outer]] })
    const mid = (r + outer) / 2
    floors.push({ seed: [cx + Math.cos(g + 1.6) * mid, cy + Math.sin(g + 1.6) * mid], offset: -0.1 * (k + 1) })
  })
  // Inner baffle: the column pours just above it, so the inner ring flows
  // counter-clockwise all the way round to its weir.
  walls.push({ points: [[cx + 0.6, cy], [cx + radii[0], cy]] })
  const spoutAngle = -Math.PI / 2 + 0.55
  const spout = { at: [cx + Math.cos(spoutAngle) * rim, cy + Math.sin(spoutAngle) * rim] as Vec2, direction: [Math.cos(spoutAngle), Math.sin(spoutAngle)] as Vec2 }
  const main: VesselSpec = {
    name: 'ring-garden', floor, wallHeight: 0.8, wallWidth: 0.32, rimWidth: 0.55,
    outline: circle(cx, cy, rim, 220), walls,
    islands: [circle(cx, cy, 0.55, 64)],
    sills, spouts: [{ ...spout, width: 0.6, crest: 0.04, length: TAIL_SPOUT_LENGTH, device: 'tipper' }], floors, planters: [],
  }
  const landing: Vec2 = [cx + 0.98, cy + 0.42]
  return {
    id: 'garden',
    vessels: [main, ...machineTail(spout, 0.55, { side: 1, noriaRadius: 1.7 })],
    source: { tower: [cx, cy], lip: towards(landing, [cx, cy], SOURCE_THROW), lipZ: floor + 0.8 + 0.35, width: 0.34, round: true },
    plants: [
      { kind: 'olive', at: [-4.6, 4.0], scale: 1.81 },
      { kind: 'rosemary', at: [-4.9, -2.6], scale: 1.59 },
      { kind: 'fern', at: [4.8, 3.2], scale: 1.45 },
      { kind: 'stones', at: [4.4, -3.8], scale: 1.0 },
    ],
  }
}

/** Companion planting: low shrubs and pebbles beside each authored accent. */
function withCompanions(build: () => GardenDesign): () => GardenDesign {
  return () => {
    const design = build()
    const extra: GardenDesign['plants'] = []
    design.plants.forEach((plant, i) => {
      if (plant.kind === 'stones') return
      const angle = i * 2.1 + 0.6
      extra.push({ kind: i % 2 ? 'fern' : 'rosemary', at: [plant.at[0] + Math.cos(angle) * 0.9, plant.at[1] + Math.sin(angle) * 0.9], scale: plant.scale * 0.6 })
      extra.push({ kind: 'stones', at: [plant.at[0] - Math.cos(angle) * 0.7, plant.at[1] - Math.sin(angle) * 0.7], scale: 0.55 })
    })
    design.plants.push(...extra)
    return design
  }
}

const builders: Record<GardenId, () => GardenDesign> = {
  atelier: withCompanions(atelier), cascade: withCompanions(cascade), split: withCompanions(split),
  serpentine: withCompanions(serpentine), garden: withCompanions(waterGarden),
}

export const GARDEN_IDS = Object.keys(builders) as GardenId[]

export function createGardenDesign(id: GardenId): GardenDesign {
  const builder = builders[id]
  if (!builder) throw new RangeError(`Unknown water garden: ${id}`)
  return builder()
}
