import * as THREE from 'three'
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js'
import type { FluidLayout, FluidWall } from './types'

const OUTER_CORNER_RADIUS = 0.18
const CHANNEL_CORNER_RADIUS = 0.38
const CROWN_WIDTH = 0.05
const CROWN_HEIGHT = 0.075
const WALL_HEIGHT = 1.05

/** The overhead basin spout needs a closed rim; keep the 2D funnel opening intact. */
export function ceramicBasinWallGeometry(layout: FluidLayout): THREE.BufferGeometry {
  const sourceCol = Math.floor(layout.inletX)
  const half = 0.075
  return ceramicWallGeometry([...layout.walls, {
    x0: sourceCol - half, x1: sourceCol + 1 + half,
    y0: layout.topY - half, y1: layout.topY + half,
  }])
}

/** A small glaze shoulder; thin inlet walls retain the source's clearance. */
function shoulder(wall: FluidWall): number {
  return Math.min(0.045, Math.max(0, Math.min(wall.x1 - wall.x0, wall.y1 - wall.y0) * 0.5 - 0.05) * 1.8)
}

function contains(points: readonly THREE.Vector2[], point: THREE.Vector2): boolean {
  let inside = false
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i], b = points[j]
    if ((a.y > point.y) !== (b.y > point.y)
      && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

/** Round both convex ends and concave channel bends, without rounding joints separately. */
function roundedPath<T extends THREE.Path>(points: readonly THREE.Vector2[], path: T): T {
  const circle = 0.5522847498307936
  for (let i = 0; i < points.length; i++) {
    const p = points[i], previous = points[(i + points.length - 1) % points.length], next = points[(i + 1) % points.length]
    const incoming = previous.clone().sub(p), outgoing = next.clone().sub(p)
    // All union boundaries keep ceramic to their right. Negative cross here
    // is an inward channel corner: give it a broad sweep while retaining the
    // smaller convex cap radius and the local edge-length clearance limit.
    const cornerRadius = incoming.cross(outgoing) < 0 ? CHANNEL_CORNER_RADIUS : OUTER_CORNER_RADIUS
    const radius = Math.min(cornerRadius, incoming.length() * 0.499, outgoing.length() * 0.499)
    incoming.setLength(radius); outgoing.setLength(radius)
    const a = p.clone().add(incoming), b = p.clone().add(outgoing)
    if (i === 0) path.moveTo(a.x, a.y)
    else path.lineTo(a.x, a.y)
    path.bezierCurveTo(a.x - incoming.x * circle, a.y - incoming.y * circle,
      b.x - outgoing.x * circle, b.y - outgoing.y * circle, b.x, b.y)
  }
  path.closePath()
  return path
}

/**
 * Exact rectangle union in a coordinate-compressed grid. Unlike overlapping
 * boxes, this produces no internal faces or seams at T/L/cross junctions.
 * Compression follows actual wall boundaries, so it cannot lose tiny ports,
 * edited walls, disconnected islands, or holes by raster approximation.
 */
export function ceramicWallShapes(input: readonly FluidWall[]): THREE.Shape[] {
  const snap = (n: number) => Math.round(n * 1e6) / 1e6
  const walls = input.filter(wall => wall.kind !== 'funnel').map(wall => {
    const pad = shoulder(wall)
    return { x0: snap(wall.x0 - pad), x1: snap(wall.x1 + pad), y0: snap(-wall.y1 - pad), y1: snap(-wall.y0 + pad) }
  })
  if (!walls.length) return []
  const xs = [...new Set(walls.flatMap(wall => [wall.x0, wall.x1]))].sort((a, b) => a - b)
  const ys = [...new Set(walls.flatMap(wall => [wall.y0, wall.y1]))].sort((a, b) => a - b)
  const nx = xs.length, ny = ys.length
  const xAt = new Map(xs.map((x, i) => [x, i])), yAt = new Map(ys.map((y, i) => [y, i]))
  const occupancy = new Int32Array(nx * ny)
  for (const wall of walls) {
    const x0 = xAt.get(wall.x0)!, x1 = xAt.get(wall.x1)!, y0 = yAt.get(wall.y0)!, y1 = yAt.get(wall.y1)!
    occupancy[y0 * nx + x0]++; occupancy[y0 * nx + x1]--
    occupancy[y1 * nx + x0]--; occupancy[y1 * nx + x1]++
  }
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const i = y * nx + x
    occupancy[i] += (x ? occupancy[i - 1] : 0) + (y ? occupancy[i - nx] : 0) - (x && y ? occupancy[i - nx - 1] : 0)
  }
  const solid = (x: number, y: number) => x >= 0 && y >= 0 && x < nx - 1 && y < ny - 1 && occupancy[y * nx + x] > 0
  const edges = new Map<number, number[]>()
  const add = (a: number, b: number) => { const list = edges.get(a) ?? []; list.push(b); edges.set(a, list) }
  for (let y = 0; y < ny - 1; y++) for (let x = 0; x < nx - 1; x++) if (solid(x, y)) {
    const a = y * nx + x, b = a + 1, d = a + nx, c = d + 1
    if (!solid(x - 1, y)) add(a, d)
    if (!solid(x, y + 1)) add(d, c)
    if (!solid(x + 1, y)) add(c, b)
    if (!solid(x, y - 1)) add(b, a)
  }
  const point = (index: number) => new THREE.Vector2(xs[index % nx], ys[Math.floor(index / nx)])
  const loops: THREE.Vector2[][] = []
  while (edges.size) {
    const first = edges.keys().next().value!
    let current = first, previous = -1
    const loop: THREE.Vector2[] = []
    do {
      const choices = edges.get(current)
      if (!choices?.length) throw new Error('Open ceramic wall boundary.')
      if (choices.length > 1 && previous >= 0) {
        const direction = point(current).sub(point(previous))
        const turn = (next: number) => { const out = point(next).sub(point(current)); return Math.atan2(direction.cross(out), direction.dot(out)) }
        choices.sort((a, b) => turn(b) - turn(a))
      }
      const next = choices.pop()!
      if (!choices.length) edges.delete(current)
      loop.push(point(current)); previous = current; current = next
    } while (current !== first)
    // Grid compression adds redundant vertices along long straight runs.
    const simplified = loop.filter((p, i) => {
      const a = loop[(i + loop.length - 1) % loop.length], b = loop[(i + 1) % loop.length]
      return Math.abs((p.x - a.x) * (b.y - p.y) - (p.y - a.y) * (b.x - p.x)) > 1e-10
    })
    if (simplified.length >= 3) loops.push(simplified)
  }
  const outer = loops.filter(loop => THREE.ShapeUtils.isClockWise(loop)).map(loop => ({ loop, area: Math.abs(THREE.ShapeUtils.area(loop)), shape: roundedPath(loop, new THREE.Shape()) }))
  outer.sort((a, b) => a.area - b.area)
  for (const hole of loops.filter(loop => !THREE.ShapeUtils.isClockWise(loop))) {
    outer.find(item => contains(item.loop, hole[0]))?.shape.holes.push(roundedPath(hole, new THREE.Path()))
  }
  return outer.map(item => item.shape)
}

/** One static physical surface, with a real rounded crown and smooth normals. */
export function ceramicWallGeometry(input: readonly FluidWall[]): THREE.BufferGeometry {
  const shapes = ceramicWallShapes(input)
  const detail = input.length > 1600 ? 2 : input.length > 650 ? 3 : 6
  const geometry = new THREE.ExtrudeGeometry(shapes, {
    depth: WALL_HEIGHT - CROWN_HEIGHT * 2,
    bevelEnabled: true, bevelSize: CROWN_WIDTH, bevelThickness: CROWN_HEIGHT,
    bevelSegments: Math.min(5, detail + 1), steps: 1, curveSegments: detail,
  })
  geometry.translate(0, 0, CROWN_HEIGHT)
  // The extrusion duplicates every face normal. Weld positions first so the
  // crown catches a continuous highlight instead of a stack of flat stripes.
  geometry.deleteAttribute('normal'); geometry.deleteAttribute('uv')
  const smooth = mergeVertices(geometry, 1e-5)
  geometry.dispose()
  // Disconnected wall islands share two material draws, rather than a draw
  // for each island. Preserve cap/side material assignment while regrouping.
  if (smooth.index && smooth.groups.length > 2) {
    const byMaterial = [[], []] as number[][]
    for (const group of smooth.groups) {
      for (let i = group.start; i < group.start + group.count; i++) byMaterial[group.materialIndex ?? 0].push(smooth.index.getX(i))
    }
    smooth.setIndex([...byMaterial[0], ...byMaterial[1]]); smooth.clearGroups()
    smooth.addGroup(0, byMaterial[0].length, 0); smooth.addGroup(byMaterial[0].length, byMaterial[1].length, 1)
  }
  smooth.computeVertexNormals(); smooth.computeBoundingBox(); smooth.computeBoundingSphere()
  return smooth
}
