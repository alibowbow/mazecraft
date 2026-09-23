import * as THREE from 'three'
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js'
import type { GardenLayout } from './layout'
import { offset, regions, shapeOf, type Region, type Vec2 } from './polygon'

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

export interface GardenSolids {
  walls: THREE.BufferGeometry
  beds: THREE.BufferGeometry
  water: THREE.BufferGeometry
  trim: THREE.BufferGeometry
  planterSoil: THREE.BufferGeometry | null
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
    // Weirs stand on the lowest bed of their vessel.
    for (const sill of vessel.sills) for (const region of sill.regions) {
      const solid = roundedSolid(region, vessel.baseFloor - 0.05, sill.crest, 0.06)
      if (solid) walls.push(solid)
    }
    // Beds: the full interior at the lowest level, raised slabs for upper pools.
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
  // Water sheets: one flat region per pool, lifted to its level in the shader.
  for (const pool of layout.pools) {
    const geometry = new THREE.ShapeGeometry(toShape(pool.region), 4)
    geometry.deleteAttribute('uv')
    geometry.setAttribute('aPool', new THREE.Float32BufferAttribute(new Float32Array(geometry.getAttribute('position').count).fill(pool.index), 1))
    water.push(geometry)
  }
  // Spout channels: a cantilevered bed with two low cheeks.
  for (const edge of layout.edges) {
    if (edge.kind !== 'spout') continue
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
  const merge = (list: THREE.BufferGeometry[]) => {
    const merged = mergeGeometries(list, false)!
    list.forEach(geometry => geometry.dispose())
    merged.computeBoundingBox(); merged.computeBoundingSphere()
    return merged
  }
  return {
    walls: merge(walls), beds: merge(beds), water: merge(water), trim: merge(trim),
    planterSoil: soil.length ? merge(soil) : null,
  }
}
