import type { GardenLayout } from './layout'
import { rasterize, type Vec2 } from './polygon'

/** Plan-view texture shared by the water, bed, glaze and ground shaders. */
export interface GardenField {
  /** RGBA8: RG flow direction × route weight, B distance channel, A nearest pool + 1. */
  data: Uint8Array
  width: number
  height: number
  /** World bounds covered: x0, y0, width, height. */
  bounds: [number, number, number, number]
  cell: number
}

const SQRT2 = Math.SQRT2
const NEIGHBOURS: [number, number, number][] = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, SQRT2], [1, -1, SQRT2], [-1, 1, SQRT2], [-1, -1, SQRT2],
]

class Heap {
  private indices: number[] = []
  private keys: number[] = []
  get size() { return this.indices.length }
  push(index: number, key: number) {
    const { indices, keys } = this
    let i = indices.length
    indices.push(index); keys.push(key)
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (keys[parent] <= key) break
      indices[i] = indices[parent]; keys[i] = keys[parent]; i = parent
    }
    indices[i] = index; keys[i] = key
  }
  pop(): number {
    const { indices, keys } = this
    const top = indices[0], lastIndex = indices.pop()!, lastKey = keys.pop()!
    if (indices.length) {
      let i = 0
      for (;;) {
        let child = i * 2 + 1
        if (child >= indices.length) break
        if (child + 1 < indices.length && keys[child + 1] < keys[child]) child++
        if (keys[child] >= lastKey) break
        indices[i] = indices[child]; keys[i] = keys[child]; i = child
      }
      indices[i] = lastIndex; keys[i] = lastKey
    }
    return top
  }
}

/** Two-pass chamfer distance (in cells) to the nearest cell where `inside` is 0. */
function chamfer(inside: Uint8Array, width: number, height: number): Float32Array {
  const d = new Float32Array(width * height)
  for (let i = 0; i < d.length; i++) d[i] = inside[i] ? 1e6 : 0
  const relax = (i: number, j: number, cost: number) => { if (d[j] + cost < d[i]) d[i] = d[j] + cost }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x
    if (!d[i]) continue
    if (x > 0) relax(i, i - 1, 1)
    if (y > 0) { relax(i, i - width, 1); if (x > 0) relax(i, i - width - 1, SQRT2); if (x < width - 1) relax(i, i - width + 1, SQRT2) }
  }
  for (let y = height - 1; y >= 0; y--) for (let x = width - 1; x >= 0; x--) {
    const i = y * width + x
    if (!d[i]) continue
    if (x < width - 1) relax(i, i + 1, 1)
    if (y < height - 1) { relax(i, i + width, 1); if (x < width - 1) relax(i, i + width + 1, SQRT2); if (x > 0) relax(i, i + width - 1, SQRT2) }
  }
  return d
}

export function buildGardenField(layout: GardenLayout, cell = 0.05, margin = 2.2): GardenField {
  const x0 = layout.bounds.minX - margin, y0 = layout.bounds.minY - margin
  const width = Math.ceil((layout.bounds.maxX - layout.bounds.minX + margin * 2) / cell)
  const height = Math.ceil((layout.bounds.maxY - layout.bounds.minY + margin * 2) / cell)
  const grid = { x0, y0, cell, width, height }
  const count = width * height
  const pool = new Int16Array(count).fill(-1)
  const footprint = new Uint8Array(count)
  for (const p of layout.pools) rasterize(p.region, grid, i => { pool[i] = p.index })
  for (const vessel of layout.vessels) for (const region of vessel.footprint) rasterize(region, grid, i => { footprint[i] = 1 })
  const cellOf = ([x, y]: Vec2) => {
    const cx = Math.floor((x - x0) / cell), cy = Math.floor((y - y0) / cell)
    return cx >= 0 && cy >= 0 && cx < width && cy < height ? cy * width + cx : -1
  }
  const wet = Uint8Array.from(pool, id => id >= 0 ? 1 : 0)
  const wallDistance = chamfer(wet, width, height)
  const outsideDistance = chamfer(Uint8Array.from(footprint, inside => inside ? 0 : 1), width, height)
  // Nearest pool label for walls and rims: a breadth-first spread from water.
  const nearest = Int16Array.from(pool)
  const reach = Math.ceil(0.8 / cell)
  let frontier: number[] = []
  for (let i = 0; i < count; i++) if (pool[i] >= 0) frontier.push(i)
  for (let step = 0; step < reach && frontier.length; step++) {
    const next: number[] = []
    for (const i of frontier) {
      const x = i % width, y = (i / width) | 0
      for (const [dx, dy] of NEIGHBOURS.slice(0, 4)) {
        const nx = x + dx, ny = y + dy
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
        const j = ny * width + nx
        if (nearest[j] >= 0 || !footprint[j]) continue
        nearest[j] = nearest[i]
        next.push(j)
      }
    }
    frontier = next
  }
  // Geodesic distances from every pool's inflows and to its outflows.
  // Float64: a float32 store can round up and re-trigger equal relaxations.
  const toExit = new Float64Array(count).fill(Infinity)
  const fromEntry = new Float64Array(count).fill(Infinity)
  const seeds = (target: Float64Array, points: Vec2[], owner: number, radius: number) => {
    const heap = new Heap()
    const r = Math.ceil(radius / cell)
    for (const point of points) {
      const center = cellOf(point)
      if (center < 0) continue
      const cx = center % width, cy = (center / width) | 0
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        const x = cx + dx, y = cy + dy
        if (x < 0 || y < 0 || x >= width || y >= height || dx * dx + dy * dy > r * r) continue
        const i = y * width + x
        if (pool[i] === owner && target[i] > 0) { target[i] = 0; heap.push(i, 0) }
      }
    }
    while (heap.size) {
      const i = heap.pop()
      const x = i % width, y = (i / width) | 0
      for (const [dx, dy, cost] of NEIGHBOURS) {
        const nx = x + dx, ny = y + dy
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
        const j = ny * width + nx
        if (pool[j] !== owner) continue
        const next = target[i] + cost * cell
        if (next < target[j]) { target[j] = next; heap.push(j, next) }
      }
    }
  }
  const along = (points: Vec2[]): Vec2[] => {
    const result: Vec2[] = []
    for (let k = 1; k < points.length; k++) {
      const [ax, ay] = points[k - 1], [bx, by] = points[k]
      const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 0.05))
      for (let s = 0; s <= n; s++) result.push([ax + (bx - ax) * s / n, ay + (by - ay) * s / n])
    }
    return result.length ? result : points
  }
  for (const p of layout.pools) {
    const exits: Vec2[] = [], entries: Vec2[] = []
    for (const edge of layout.edges) {
      const points = edge.kind === 'sill' ? along(edge.points) : edge.kind === 'spout' ? [edge.points[0]] : edge.points
      if (edge.a === p.index) exits.push(...points)
      if (edge.b === p.index) entries.push(...(edge.kind === 'spout' ? [edge.landing!] : points))
    }
    if (layout.source.pool === p.index) entries.push(layout.source.landing)
    seeds(toExit, exits, p.index, 0.45)
    seeds(fromEntry, entries.length ? entries : exits, p.index, 0.45)
  }
  // Main-route weight: cells on a shortest entry→exit path carry the current;
  // dead ends and side bays are nearly still.
  const shortest = new Float32Array(layout.pools.length).fill(Infinity)
  for (let i = 0; i < count; i++) if (pool[i] >= 0 && Number.isFinite(toExit[i] + fromEntry[i])) {
    shortest[pool[i]] = Math.min(shortest[pool[i]], toExit[i] + fromEntry[i])
  }
  const vx = new Float32Array(count), vy = new Float32Array(count)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x
    const owner = pool[i]
    if (owner < 0 || !Number.isFinite(toExit[i])) continue
    const sample = (dx: number, dy: number) => {
      const nx = x + dx, ny = y + dy
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) return toExit[i]
      const j = ny * width + nx
      return pool[j] === owner && Number.isFinite(toExit[j]) ? toExit[j] : toExit[i]
    }
    let gx = (sample(1, 0) - sample(-1, 0)) / 2, gy = (sample(0, 1) - sample(0, -1)) / 2
    const length = Math.hypot(gx, gy)
    if (length < 1e-6) continue
    gx /= length; gy /= length
    const excess = Math.max(0, toExit[i] + fromEntry[i] - shortest[owner])
    const weight = Math.exp(-excess / 0.9) * Math.min(1, 0.25 + wallDistance[i] * cell / 0.18)
    vx[i] = -gx * weight; vy[i] = -gy * weight
  }
  // Two in-pool box passes remove the lattice's diagonal staircase.
  for (let pass = 0; pass < 2; pass++) {
    const sx = vx.slice(), sy = vy.slice()
    for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
      const i = y * width + x
      if (pool[i] < 0) continue
      let ax = 0, ay = 0, n = 0
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const j = i + dy * width + dx
        if (pool[j] !== pool[i]) continue
        ax += sx[j]; ay += sy[j]; n++
      }
      vx[i] = ax / n; vy[i] = ay / n
    }
  }
  const data = new Uint8Array(count * 4)
  const byte = (value: number) => Math.max(0, Math.min(255, Math.round(value * 255)))
  for (let i = 0; i < count; i++) {
    data[i * 4] = byte(0.5 + vx[i] * 0.5)
    data[i * 4 + 1] = byte(0.5 + vy[i] * 0.5)
    // Water: distance to the nearest wall (0–0.5 m). Ground: distance to
    // the sculpture (0–2 m), encoded in the upper half. Solids stay at 0.
    data[i * 4 + 2] = pool[i] >= 0
      ? byte(Math.min(0.5, wallDistance[i] * cell) / 0.5 * 0.5)
      : footprint[i] ? 0 : byte(0.5 + Math.min(2, outsideDistance[i] * cell) / 2 * 0.5)
    data[i * 4 + 3] = nearest[i] >= 0 ? nearest[i] + 1 : 0
  }
  return { data, width, height, bounds: [x0, y0, width * cell, height * cell], cell }
}
