import ClipperLib from 'clipper-lib'

/** Garden plan coordinates: x to the right, y away from the viewer, metres. */
export type Vec2 = readonly [number, number]
export type Ring = Vec2[]

/** One connected area. The outer ring is counter-clockwise, holes clockwise. */
export interface Region {
  outer: Ring
  holes: Ring[]
}

export interface Polyline {
  points: readonly Vec2[]
  closed?: boolean
  /** Overrides the owner's default stroke width. */
  width?: number
}

const SCALE = 20_000
const ARC_TOLERANCE = 0.0025 * SCALE
const { Clipper, ClipperOffset, ClipType, PolyType, PolyFillType, JoinType, EndType } = ClipperLib

function toPath(ring: readonly Vec2[]): ClipperLib.Path {
  return ring.map(([x, y]) => ({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) }))
}

function fromPath(path: ClipperLib.Path): Ring {
  return path.map(point => [point.X / SCALE, point.Y / SCALE] as Vec2)
}

/** Integer-domain shapes, kept opaque so callers never mix scales. */
export interface Shape2 { readonly paths: ClipperLib.Paths }

export const EMPTY: Shape2 = { paths: [] }

export function polygon(...rings: readonly (readonly Vec2[])[]): Shape2 {
  return union({ paths: rings.map(toPath) })
}

/** Round-capped, round-jointed walls of the given half width, already unioned. */
export function strokes(lines: readonly Polyline[], halfWidth: number): Shape2 {
  const offset = new ClipperOffset(2, ARC_TOLERANCE)
  for (const line of lines) {
    if (line.points.length < 2) continue
    offset.AddPath(toPath(line.points), JoinType.jtRound, line.closed ? EndType.etClosedLine : EndType.etOpenRound)
  }
  const paths: ClipperLib.Paths = []
  offset.Execute(paths, halfWidth * SCALE)
  return union({ paths })
}

export function offset(shape: Shape2, delta: number): Shape2 {
  if (!shape.paths.length) return EMPTY
  const clipper = new ClipperOffset(2, ARC_TOLERANCE)
  clipper.AddPaths(shape.paths, JoinType.jtRound, EndType.etClosedPolygon)
  const paths: ClipperLib.Paths = []
  clipper.Execute(paths, delta * SCALE)
  return { paths }
}

function execute(type: number, subject: Shape2, clip: Shape2): Shape2 {
  const clipper = new Clipper()
  clipper.AddPaths(subject.paths, PolyType.ptSubject, true)
  clipper.AddPaths(clip.paths, PolyType.ptClip, true)
  const paths: ClipperLib.Paths = []
  clipper.Execute(type, paths, PolyFillType.pftNonZero, PolyFillType.pftNonZero)
  return { paths }
}

export function union(...shapes: Shape2[]): Shape2 {
  const [first = EMPTY, ...rest] = shapes
  return execute(ClipType.ctUnion, first, { paths: rest.flatMap(shape => shape.paths) })
}

export function difference(subject: Shape2, ...clips: Shape2[]): Shape2 {
  return execute(ClipType.ctDifference, subject, { paths: clips.flatMap(shape => shape.paths) })
}

export function intersection(subject: Shape2, clip: Shape2): Shape2 {
  return execute(ClipType.ctIntersection, subject, clip)
}

/**
 * Morphological rounding: concave junctions receive a fillet of `concave`,
 * convex corners (cut ends, notches) a radius of `convex`.
 */
export function soften(shape: Shape2, concave: number, convex: number): Shape2 {
  let result = shape
  if (convex > 0) result = offset(offset(result, -convex), convex)
  if (concave > 0) result = offset(offset(result, concave), -concave)
  return result
}

/** Outer rings with their own holes; nested islands become separate regions. */
export function regions(shape: Shape2): Region[] {
  const clipper = new Clipper()
  clipper.AddPaths(shape.paths, PolyType.ptSubject, true)
  const tree = new ClipperLib.PolyTree()
  clipper.Execute(ClipType.ctUnion, tree, PolyFillType.pftNonZero, PolyFillType.pftNonZero)
  const result: Region[] = []
  const visit = (node: ClipperLib.PolyNode) => {
    for (const child of node.Childs()) {
      if (child.IsHole()) continue
      const outer = orient(fromPath(child.Contour()), true)
      const holes = child.Childs().map(hole => orient(fromPath(hole.Contour()), false))
      result.push({ outer, holes })
      for (const hole of child.Childs()) visit(hole)
    }
  }
  visit(tree)
  return result
}

export function shapeOf(region: Region): Shape2 {
  return { paths: [toPath(region.outer), ...region.holes.map(toPath)] }
}

export function ringArea(ring: readonly Vec2[]): number {
  let area = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) area += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1])
  return -area / 2
}

function orient(ring: Ring, counterClockwise: boolean): Ring {
  return (ringArea(ring) > 0) === counterClockwise ? ring : ring.slice().reverse()
}

export function regionArea(region: Region): number {
  return Math.abs(ringArea(region.outer)) - region.holes.reduce((sum, hole) => sum + Math.abs(ringArea(hole)), 0)
}

export function shapeArea(shape: Shape2): number {
  return regions(shape).reduce((sum, region) => sum + regionArea(region), 0)
}

function inRing(ring: readonly Vec2[], x: number, y: number): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[i], [bx, by] = ring[j]
    if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) inside = !inside
  }
  return inside
}

export function regionContains(region: Region, [x, y]: Vec2): boolean {
  return inRing(region.outer, x, y) && !region.holes.some(hole => inRing(hole, x, y))
}

export interface Bounds { minX: number; minY: number; maxX: number; maxY: number }

export function boundsOf(rings: readonly (readonly Vec2[])[]): Bounds {
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  for (const ring of rings) for (const [x, y] of ring) {
    bounds.minX = Math.min(bounds.minX, x); bounds.maxX = Math.max(bounds.maxX, x)
    bounds.minY = Math.min(bounds.minY, y); bounds.maxY = Math.max(bounds.maxY, y)
  }
  return bounds
}

/** Removes points closer than `tolerance` to a straight run; keeps curves smooth. */
export function simplifyRing(ring: Ring, tolerance = 0.004): Ring {
  if (ring.length < 8) return ring
  const keep = new Uint8Array(ring.length)
  const stack: [number, number][] = [[0, ring.length - 1]]
  keep[0] = keep[ring.length - 1] = 1
  while (stack.length) {
    const [a, b] = stack.pop()!
    const [ax, ay] = ring[a], [bx, by] = ring[b]
    const length = Math.hypot(bx - ax, by - ay) || 1
    let farthest = -1, distance = tolerance
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((bx - ax) * (ay - ring[i][1]) - (ax - ring[i][0]) * (by - ay)) / length
      if (d > distance) { distance = d; farthest = i }
    }
    if (farthest >= 0) { keep[farthest] = 1; stack.push([a, farthest], [farthest, b]) }
  }
  return ring.filter((_, i) => keep[i])
}

/** Scanline rasterisation (even-odd) of a region into a cell grid. */
export function rasterize(region: Region, grid: { x0: number; y0: number; cell: number; width: number; height: number }, visit: (index: number) => void): void {
  const edges: [number, number, number, number][] = []
  for (const ring of [region.outer, ...region.holes]) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) edges.push([ring[j][0], ring[j][1], ring[i][0], ring[i][1]])
  }
  const crossings: number[] = []
  for (let row = 0; row < grid.height; row++) {
    const y = grid.y0 + (row + 0.5) * grid.cell
    crossings.length = 0
    for (const [ax, ay, bx, by] of edges) {
      if ((ay > y) !== (by > y)) crossings.push(ax + (bx - ax) * (y - ay) / (by - ay))
    }
    crossings.sort((a, b) => a - b)
    for (let k = 0; k + 1 < crossings.length; k += 2) {
      const from = Math.max(0, Math.ceil((crossings[k] - grid.x0) / grid.cell - 0.5))
      const to = Math.min(grid.width - 1, Math.floor((crossings[k + 1] - grid.x0) / grid.cell - 0.5))
      for (let col = from; col <= to; col++) visit(row * grid.width + col)
    }
  }
}
