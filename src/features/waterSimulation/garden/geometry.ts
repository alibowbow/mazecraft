import * as THREE from 'three'
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js'
import { TessellateModifier } from 'three/addons/modifiers/TessellateModifier.js'
import type { GardenLayout } from './layout'
import { offset, regionContains, regions, shapeOf, strokes, union, type Region, type Vec2 } from './polygon'
import type { Vec3 } from './designs'

/** No wall-height scaling for solids tagged with this floor. */
const UNSCALED = 99

function toShape(region: Region): THREE.Shape {
  const shape = new THREE.Shape(region.outer.map(([x, y]) => new THREE.Vector2(x, y)))
  shape.holes = region.holes.map(hole => new THREE.Path(hole.map(([x, y]) => new THREE.Vector2(x, y))))
  return shape
}

/**
 * A solid with vertical faces and a rounded crown and foot. The profile is
 * made by insetting the outline by the bevel radius, then letting the extrude
 * bevel grow it back, so the faces land exactly on the compiled outline.
 */
function roundedSolid(region: Region, bottom: number, top: number, radius: number, floor = UNSCALED): THREE.BufferGeometry | null {
  const r = Math.min(radius, (top - bottom) * 0.45)
  const inset = regions(offset(shapeOf(region), -r))
  if (!inset.length) return null
  const parts = inset.map(part => {
    const source = new THREE.ExtrudeGeometry(toShape(part), {
      depth: Math.max(0.001, top - bottom - 2 * r), bevelEnabled: true, bevelSize: r, bevelThickness: r,
      bevelSegments: 6, curveSegments: 4, steps: 1,
    })
    source.translate(0, 0, bottom + r)
    source.deleteAttribute('normal'); source.deleteAttribute('uv')
    const merged = mergeVertices(source, 1e-5)
    source.dispose()
    return merged
  })
  const geometry = parts.length > 1 ? mergeGeometries(parts)! : parts[0]
  if (parts.length > 1) parts.forEach(part => part.dispose())
  geometry.computeVertexNormals()
  const count = geometry.getAttribute('position').count
  geometry.setAttribute('aFloor', new THREE.Float32BufferAttribute(new Float32Array(count).fill(floor), 1))
  return geometry
}

function flat(region: Region, z: number): THREE.BufferGeometry {
  const indexed = new THREE.ShapeGeometry(toShape(region), 4)
  indexed.translate(0, 0, z)
  indexed.deleteAttribute('uv')
  // Beds merge with the (non-indexed) extruded pool slabs.
  const geometry = indexed.toNonIndexed()
  indexed.dispose()
  return geometry
}

function slab(region: Region, bottom: number, top: number): THREE.BufferGeometry {
  const geometry = new THREE.ExtrudeGeometry(toShape(region), { depth: top - bottom, bevelEnabled: false, curveSegments: 4 })
  geometry.translate(0, 0, bottom)
  geometry.deleteAttribute('uv')
  return geometry
}

/** Oriented rounded box: `from`→`to` along its length, crown at `top`. */
function beam(from: Vec2, to: Vec2, width: number, bottom: number, top: number, radius: number): THREE.BufferGeometry | null {
  const dx = to[0] - from[0], dy = to[1] - from[1], length = Math.hypot(dx, dy)
  const ux = dx / length, uy = dy / length, px = -uy * width / 2, py = ux * width / 2
  const outline: Region = { outer: [
    [from[0] - px, from[1] - py], [to[0] - px, to[1] - py], [to[0] + px, to[1] + py], [from[0] + px, from[1] + py],
  ], holes: [] }
  return roundedSolid(outline, bottom, top, radius)
}

/** Channel cross-section: inner half-width is added at build time. */
export const CHANNEL_WALL = 0.14
const CHANNEL_SIDE = 0.05, CHANNEL_BOTTOM = 0.07

/** Resample a polyline at about `step` spacing, keeping its vertices. */
export function resample(path: readonly Vec3[], step: number): Vec3[] {
  const result: Vec3[] = [path[0]]
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i]
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / step))
    for (let k = 1; k <= n; k++) result.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n, a[2] + (b[2] - a[2]) * k / n])
  }
  return result
}

/** Horizontal unit tangent at each sample (averaged at corners). */
export function tangents(points: readonly Vec3[]): Vec2[] {
  return points.map((_, i) => {
    const a = points[Math.max(0, i - 1)], b = points[Math.min(points.length - 1, i + 1)]
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1
    return [dx / l, dy / l] as Vec2
  })
}

/**
 * Sweep a closed, counter-clockwise profile (side, up) along a path. Normals
 * are exact per profile face and continuous along the path.
 */
export function sweep(points: readonly Vec3[], profile: readonly [number, number][]): THREE.BufferGeometry {
  const t = tangents(points)
  const positions: number[] = [], normals: number[] = []
  const at = (i: number, [a, b]: readonly [number, number]) => {
    const [tx, ty] = t[i]
    return [points[i][0] - ty * a, points[i][1] + tx * a, points[i][2] + b]
  }
  for (let j = 0; j < profile.length; j++) {
    const p = profile[j], q = profile[(j + 1) % profile.length]
    const dx = q[0] - p[0], dy = q[1] - p[1], l = Math.hypot(dx, dy) || 1
    const ns = dy / l, nu = -dx / l
    for (let i = 0; i + 1 < points.length; i++) {
      const A = at(i, p), B = at(i, q), C = at(i + 1, q), D = at(i + 1, p)
      const n = (k: number) => [-t[k][1] * ns, t[k][0] * ns, nu]
      positions.push(...A, ...B, ...D, ...B, ...C, ...D)
      normals.push(...n(i), ...n(i), ...n(i + 1), ...n(i), ...n(i + 1), ...n(i + 1))
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  return geometry
}

function channelProfile(width: number): [number, number][] {
  const w = width / 2, o = w + CHANNEL_SIDE
  return [[-o, CHANNEL_WALL], [-o, -CHANNEL_BOTTOM], [o, -CHANNEL_BOTTOM], [o, CHANNEL_WALL], [w, CHANNEL_WALL], [w, 0], [-w, 0], [-w, CHANNEL_WALL]]
}

function box(center: [number, number, number], size: [number, number, number], heading = 0): THREE.BufferGeometry {
  const geometry = new THREE.BoxGeometry(...size)
  geometry.rotateZ(heading)
  geometry.translate(...center)
  return geometry
}

export interface GardenSolids {
  walls: THREE.BufferGeometry
  beds: THREE.BufferGeometry
  water: THREE.BufferGeometry
  trim: THREE.BufferGeometry
  planterSoil: THREE.BufferGeometry | null
  /** Brass fittings: the source pipe and drain rings. */
  brass: THREE.BufferGeometry
  /** Dark openings: the pipe bore and drain holes. */
  openings: THREE.BufferGeometry
}

/** Where the source pipe discharges, and at what height. */
export function sourceMouth(layout: GardenLayout): { x: number; y: number; z: number } {
  const { source } = layout
  return { x: source.tower[0] + source.direction[0] * 0.66, y: source.tower[1] + source.direction[1] * 0.66, z: source.lipZ + 0.17 }
}

function clean(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const result = geometry.index ? geometry.toNonIndexed() : geometry
  for (const name of Object.keys(result.attributes)) if (name !== 'position' && name !== 'normal') result.deleteAttribute(name)
  return result
}

/** Critical depth over a broad crest carrying `q` m³/s across `width` m. */
export function criticalDepth(q: number, width: number): number {
  return Math.pow(Math.max(0, q) / (1.705 * Math.max(0.05, width)), 2 / 3)
}

export function buildGardenSolids(layout: GardenLayout): GardenSolids {
  const walls: THREE.BufferGeometry[] = []
  const beds: THREE.BufferGeometry[] = []
  const water: THREE.BufferGeometry[] = []
  const trim: THREE.BufferGeometry[] = []
  const soil: THREE.BufferGeometry[] = []
  for (const vessel of layout.vessels) {
    const { spec } = vessel
    // Rim, maze walls and islands: one continuous cast from the ground up.
    for (const region of vessel.walls) {
      const solid = roundedSolid(region, 0, vessel.top, 0.11, spec.floor)
      if (solid) walls.push(solid)
    }
    // Beds: the full interior at the lowest level, raised terraces for upper
    // pools. Each terrace edge is a clean step the water pours over.
    for (const region of vessel.interior) beds.push(flat(region, vessel.baseFloor))
    for (const pool of layout.pools.filter(p => p.vessel === vessel.index)) {
      if (pool.floor > vessel.baseFloor + 0.001) {
        for (const region of regions(offset(shapeOf(pool.region), 0.045))) beds.push(slab(region, vessel.baseFloor, pool.floor))
      }
    }
    for (const at of spec.planters) {
      const disc = new THREE.CircleGeometry(0.32, 32)
      disc.deleteAttribute('uv')
      disc.translate(at[0], at[1], vessel.top - 0.035)
      soil.push(disc)
    }
  }
  // Water sheets: one region per pool, finely tessellated so the vertex
  // shader can raise real waves; lifted to the pool's level on the GPU.
  const tessellate = new TessellateModifier(0.14, 9)
  for (const pool of layout.pools) {
    // Each pool's sheet reaches over the steps it spills across, so water
    // meets water at every step instead of leaving a dry seam of bed.
    const steps = layout.edges.filter(edge => edge.kind === 'sill' && edge.a === pool.index)
    const sheet = steps.length
      ? regions(union(shapeOf(pool.region), strokes(steps.map(edge => ({ points: edge.points })), 0.035)))
      : [pool.region]
    const flatSheet = mergeGeometries(sheet.map(region => new THREE.ShapeGeometry(toShape(region), 4).toNonIndexed()), false)!
    flatSheet.deleteAttribute('uv'); flatSheet.deleteAttribute('normal')
    const geometry = tessellate.modify(flatSheet)
    flatSheet.dispose()
    for (const name of Object.keys(geometry.attributes)) if (name !== 'position') geometry.deleteAttribute(name)
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(geometry.getAttribute('position').count * 3).map((_, i) => i % 3 === 2 ? 1 : 0), 3))
    geometry.setAttribute('aPool', new THREE.Float32BufferAttribute(new Float32Array(geometry.getAttribute('position').count).fill(pool.index), 1))
    water.push(geometry)
  }
  // Spout channels: a cantilevered bed with two low cheeks.
  for (const edge of layout.edges) {
    if (edge.kind !== 'spout' && edge.kind !== 'chute') continue
    const start = edge.lipStart!, end = edge.lipEnd!
    const cheek = 0.1
    const across: Vec2 = [-edge.normal[1], edge.normal[0]]
    const side = (sign: number, width: number): [Vec2, Vec2] => {
      const shift = sign * (edge.width / 2 + width / 2)
      return [[start[0] + across[0] * shift, start[1] + across[1] * shift], [end[0] + across[0] * shift, end[1] + across[1] * shift]]
    }
    const bed = beam(start, end, edge.width + cheek * 2, edge.crest - 0.16, edge.crest, 0.04)
    if (bed) trim.push(bed)
    for (const sign of [-1, 1]) {
      const [a, b] = side(sign, cheek)
      const wall = beam(a, b, cheek, edge.crest - 0.16, edge.crest + 0.13, 0.045)
      if (wall) trim.push(wall)
    }
  }
  // Chutes and noria troughs: a glazed U channel on posts. Posts stand on the
  // ground, on a basin rim, or on the turn of channel below.
  const brass: THREE.BufferGeometry[] = [], openings: THREE.BufferGeometry[] = []
  const channels = layout.edges.filter(edge => edge.path && edge.kind !== 'siphon')
  const samples = channels.map(edge => resample(edge.path!, 0.1))
  channels.forEach((edge, c) => {
    const points = samples[c]
    trim.push(sweep(points, channelProfile(edge.kind === 'lift' ? layout.lifts[edge.lift!].width * 0.9 : edge.width)))
    const half = (edge.kind === 'lift' ? layout.lifts[edge.lift!].width * 0.9 : edge.width) / 2 + CHANNEL_SIDE
    const tangent = tangents(points)
    let walked = 0.6
    for (let i = 1; i < points.length - 1; i++) {
      walked += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1])
      if (walked < 1.25) continue
      walked = 0
      const [x, y, z] = points[i]
      const top = z - CHANNEL_BOTTOM
      let bottom = 0
      for (const vessel of layout.vessels) if (vessel.footprint.some(region => regionContains(region, [x, y]))) bottom = Math.max(bottom, vessel.top)
      samples.forEach((other, o) => other.forEach((point, k) => {
        if (o === c && Math.abs(k - i) < 25) return
        if (point[2] < top - 0.05 && Math.hypot(point[0] - x, point[1] - y) < half + 0.1) bottom = Math.max(bottom, point[2] + CHANNEL_WALL)
      }))
      if (top - bottom < 0.05) continue
      const heading = Math.atan2(tangent[i][1], tangent[i][0])
      trim.push(box([x, y, (top + bottom) / 2], [0.09, half * 2 - 0.02, top - bottom], heading))
      trim.push(box([x, y, top - 0.02], [0.14, half * 2 + 0.06, 0.05], heading))
    }
  })
  // Siphons: a ceramic bell over the intake and a brass pipe to the mouth.
  for (const siphon of layout.siphons) {
    const edge = layout.edges[siphon.edge]
    const floor = layout.pools[siphon.pool].floor
    const r = siphon.diameter / 2
    const bellTop = edge.trigger! + 0.1
    const bell = new THREE.CylinderGeometry(r * 1.9, r * 2.1, bellTop - floor - 0.04, 32, 1, false)
    bell.rotateX(Math.PI / 2)
    bell.translate(siphon.at[0], siphon.at[1], (bellTop + floor + 0.04) / 2)
    trim.push(clean(bell))
    const dome = new THREE.SphereGeometry(r * 1.9, 32, 12, 0, Math.PI * 2, 0, Math.PI / 2)
    dome.rotateX(Math.PI / 2)
    dome.translate(siphon.at[0], siphon.at[1], bellTop)
    trim.push(clean(dome))
    const path = siphon.path.slice(1)
    path.unshift([siphon.at[0], siphon.at[1], bellTop + r * 1.5])
    for (let i = 1; i < path.length; i++) {
      const a = new THREE.Vector3(...path[i - 1]), b = new THREE.Vector3(...path[i])
      const length = a.distanceTo(b)
      const pipe = new THREE.CylinderGeometry(r * 0.55, r * 0.55, length, 24, 1, true)
      pipe.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize()))
      pipe.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2)
      brass.push(clean(pipe))
      const elbow = new THREE.SphereGeometry(r * 0.6, 20, 12)
      elbow.translate(b.x, b.y, b.z)
      if (i < path.length - 1) brass.push(clean(elbow))
    }
    const mouth = path[path.length - 1]
    const ring = new THREE.TorusGeometry(r * 0.58, 0.02, 10, 28)
    ring.translate(mouth[0], mouth[1], mouth[2])
    brass.push(clean(ring))
    const bore = new THREE.CircleGeometry(r * 0.52, 24)
    bore.rotateX(Math.PI)
    bore.translate(mouth[0], mouth[1], mouth[2] - 0.005)
    openings.push(clean(bore))
  }
  // Source tower: a square pier with an open channel running to its lip.
  const { source } = layout
  const [tx, ty] = source.tower
  const pierOutline: Vec2[] = source.round
    ? Array.from({ length: 48 }, (_, i) => [tx + Math.cos(i / 48 * Math.PI * 2) * 0.36, ty + Math.sin(i / 48 * Math.PI * 2) * 0.36] as Vec2)
    : [[tx - 0.36, ty - 0.36], [tx + 0.36, ty - 0.36], [tx + 0.36, ty + 0.36], [tx - 0.36, ty + 0.36]]
  const pier = roundedSolid({ outer: pierOutline, holes: [] }, 0, source.lipZ + 0.02, 0.1)
  if (pier) trim.push(pier)
  // A shallow cap basin crowns the pier: the water seems to well up in it.
  const cap = roundedSolid({ outer: source.round
    ? Array.from({ length: 48 }, (_, i) => [tx + Math.cos(i / 48 * Math.PI * 2) * 0.46, ty + Math.sin(i / 48 * Math.PI * 2) * 0.46] as Vec2)
    : [[tx - 0.46, ty - 0.46], [tx + 0.46, ty - 0.46], [tx + 0.46, ty + 0.46], [tx - 0.46, ty + 0.46]], holes: [] }, source.lipZ + 0.02, source.lipZ + 0.16, 0.06)
  if (cap) trim.push(cap)
  const across: Vec2 = [-source.direction[1], source.direction[0]]
  const channelStart: Vec2 = [source.tower[0] + source.direction[0] * 0.2, source.tower[1] + source.direction[1] * 0.2]
  const bed = beam(channelStart, source.lip, source.width + 0.2, source.lipZ - 0.16, source.lipZ, 0.04)
  if (bed) trim.push(bed)
  for (const sign of [-1, 1]) {
    const shift = sign * (source.width / 2 + 0.05)
    const a: Vec2 = [channelStart[0] + across[0] * shift, channelStart[1] + across[1] * shift]
    const b: Vec2 = [source.lip[0] + across[0] * shift, source.lip[1] + across[1] * shift]
    const cheek = beam(a, b, 0.1, source.lipZ - 0.16, source.lipZ + 0.14, 0.045)
    if (cheek) trim.push(cheek)
  }
  // Source pipe: a brass spout leaving the pier cap over the channel.
  const mouth = sourceMouth(layout)
  const pipeRadius = Math.min(0.09, source.width * 0.22)
  const heading = Math.atan2(source.direction[1], source.direction[0])
  const place = (geometry: THREE.BufferGeometry, x: number, y: number, z: number) => {
    geometry.rotateZ(heading - Math.PI / 2)
    geometry.translate(x, y, z)
    return geometry
  }
  const pipe = new THREE.CylinderGeometry(pipeRadius, pipeRadius, 0.58, 24, 1, true)
  brass.push(clean(place(pipe, source.tower[0] + source.direction[0] * 0.37, source.tower[1] + source.direction[1] * 0.37, mouth.z)))
  const lipRing = new THREE.TorusGeometry(pipeRadius, 0.018, 10, 28)
  lipRing.rotateX(Math.PI / 2)
  brass.push(clean(place(lipRing, mouth.x, mouth.y, mouth.z)))
  const bore = new THREE.CircleGeometry(pipeRadius * 0.95, 24)
  bore.rotateX(Math.PI / 2)
  openings.push(clean(place(bore, source.tower[0] + source.direction[0] * 0.6, source.tower[1] + source.direction[1] * 0.6, mouth.z)))
  // Drains: a brass ring and a dark throat on the trough floor.
  for (const edge of layout.edges) if (edge.kind === 'drain') {
    const [x, y] = edge.points[0]
    const floor = layout.pools[edge.a].floor
    const ring = new THREE.TorusGeometry(0.15, 0.026, 12, 40)
    ring.translate(x, y, floor + 0.012)
    brass.push(clean(ring))
    const hole = new THREE.CircleGeometry(0.14, 40)
    hole.translate(x, y, floor + 0.004)
    openings.push(clean(hole))
    for (let bar = -2; bar <= 2; bar++) {
      const grate = new THREE.BoxGeometry(0.02, 0.26 * Math.cos(Math.asin(bar * 0.05 / 0.14)), 0.012)
      grate.translate(x + bar * 0.05, y, floor + 0.01)
      brass.push(clean(grate))
    }
  }
  const merge = (list: THREE.BufferGeometry[]) => {
    const merged = mergeGeometries(list, false)!
    list.forEach(geometry => geometry.dispose())
    merged.computeBoundingBox(); merged.computeBoundingSphere()
    return merged
  }
  return {
    walls: merge(walls), beds: merge(beds), water: merge(water), trim: merge(trim.map(clean)),
    planterSoil: soil.length ? merge(soil) : null,
    brass: merge(brass), openings: merge(openings),
  }
}
