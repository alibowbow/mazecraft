import * as THREE from 'three'
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js'
import { CASCADE_FLOORS, CASCADE_SILL_DEPTH, CASCADE_SPILLS, CASCADE_WALL_HEIGHT } from './cascadeTypes'

export interface CascadeSurface {
  shape: THREE.Shape
  floor: number
  area: number
}

interface BasinDesign {
  width: number
  front: number
  back: number
  floor: number
  outline: THREE.Shape
  water: THREE.Shape
  partitions: { path: THREE.Vector2[]; width: number; height: number }[]
  circles: { x: number; y: number; radius: number }[]
}

const WALL_CORE = 0.26
const WALL_BEVEL = 0.10
const PARTITION_CORE = 0.23
const PARTITION_BEVEL = 0.10
const TAU = Math.PI * 2

/** A gently bowed vessel silhouette, with long uninterrupted curved sides. */
function vesselOutline(width: number, front: number, back: number): THREE.Shape {
  const h = width / 2, depth = back - front
  const r = Math.min(0.70, depth * 0.23, width * 0.40)
  const bow = Math.min(1, width / 1.2)
  const shape = new THREE.Shape()
  shape.moveTo(-h + r, front)
  shape.lineTo(h - r, front)
  shape.bezierCurveTo(h - r * 0.28, front, h + 0.055 * bow, front + r * 0.35, h, front + r)
  shape.bezierCurveTo(h - 0.045 * bow, front + depth * 0.48, h + 0.075 * bow, back - r * 1.48, h - 0.025 * bow, back - r)
  shape.bezierCurveTo(h - 0.045 * bow, back - r * 0.28, h - r * 0.25, back, h - r, back)
  shape.lineTo(-h + r, back)
  shape.bezierCurveTo(-h + r * 0.25, back, -h - 0.035 * bow, back - r * 0.30, -h, back - r)
  shape.bezierCurveTo(-h + 0.075 * bow, back - depth * 0.49, -h - 0.065 * bow, front + r * 1.42, -h + 0.018 * bow, front + r)
  shape.bezierCurveTo(-h + 0.025 * bow, front + r * 0.31, -h + r * 0.28, front, -h + r, front)
  shape.closePath()
  return shape
}

function ellipse(x: number, y: number, rx: number, ry = rx): THREE.Shape {
  const shape = new THREE.Shape()
  shape.absellipse(x, y, rx, ry, 0, TAU, false, 0)
  return shape
}

function hole(shape: THREE.Shape): THREE.Path {
  const points = shape.getPoints(48)
  if (!THREE.ShapeUtils.isClockWise(points)) points.reverse()
  return new THREE.Path(points)
}

/** A single swept ribbon with round end caps, not intersecting box segments. */
function ribbon(points: readonly THREE.Vector2[], width: number): THREE.Shape {
  const radius = width / 2
  const normals = points.map((p, i) => {
    const previous = points[Math.max(0, i - 1)], next = points[Math.min(points.length - 1, i + 1)]
    const tangent = next.clone().sub(previous).normalize()
    return new THREE.Vector2(-tangent.y, tangent.x)
  })
  const shape = new THREE.Shape()
  const first = points[0].clone().addScaledVector(normals[0], radius)
  shape.moveTo(first.x, first.y)
  for (let i = 1; i < points.length; i++) {
    const p = points[i].clone().addScaledVector(normals[i], radius)
    shape.lineTo(p.x, p.y)
  }
  const last = points.length - 1
  const endAngle = Math.atan2(normals[last].y, normals[last].x)
  shape.absarc(points[last].x, points[last].y, radius, endAngle, endAngle - Math.PI, true)
  for (let i = last - 1; i >= 0; i--) {
    const p = points[i].clone().addScaledVector(normals[i], -radius)
    shape.lineTo(p.x, p.y)
  }
  const startAngle = Math.atan2(-normals[0].y, -normals[0].x)
  shape.absarc(points[0].x, points[0].y, radius, startAngle, startAngle - Math.PI, true)
  shape.closePath()
  return shape
}

function cubic(points: readonly [number, number][], divisions = 72): THREE.Vector2[] {
  return new THREE.CubicBezierCurve(
    new THREE.Vector2(...points[0]), new THREE.Vector2(...points[1]),
    new THREE.Vector2(...points[2]), new THREE.Vector2(...points[3]),
  ).getSpacedPoints(divisions)
}

function upperU(cx: number, cy: number, rotation: number): THREE.Vector2[] {
  const curve = new THREE.CurvePath<THREE.Vector2>()
  curve.add(new THREE.LineCurve(new THREE.Vector2(-0.58, -0.43), new THREE.Vector2(-0.58, 0.09)))
  curve.add(new THREE.CubicBezierCurve(new THREE.Vector2(-0.58, 0.09), new THREE.Vector2(-0.58, 0.71), new THREE.Vector2(0.58, 0.71), new THREE.Vector2(0.58, 0.09)))
  curve.add(new THREE.LineCurve(new THREE.Vector2(0.58, 0.09), new THREE.Vector2(0.58, -0.43)))
  return curve.getSpacedPoints(100).map(p => new THREE.Vector2(cx + p.x * Math.cos(rotation) - p.y * Math.sin(rotation), cy + p.x * Math.sin(rotation) + p.y * Math.cos(rotation)))
}

function createDesign(): BasinDesign[] {
  const levels = [
    { width: 7.6, front: 1.65, back: 4.3 },
    { width: 9.2, front: -1.7, back: 1.65 },
    { width: 8.4, front: -4.25, back: -1.7 },
  ].map((level, i): BasinDesign => ({
    ...level, floor: CASCADE_FLOORS[i],
    outline: vesselOutline(level.width, level.front, level.back),
    water: vesselOutline(level.width - 0.34, level.front, level.back),
    partitions: [], circles: [],
  }))
  levels[0].partitions.push(
    { path: upperU(-1.64, 3.04, -0.12), width: PARTITION_CORE, height: 0.79 },
    { path: upperU(1.87, 3.02, 0.19), width: PARTITION_CORE, height: 0.86 },
  )
  const spiral = Array.from({ length: 141 }, (_, i) => {
    const t = i / 140, angle = -0.42 + t * 4.20, radius = 1.15 + t * t * 0.47
    return new THREE.Vector2(Math.cos(angle) * radius, Math.sin(angle) * radius * 0.78 - 0.08)
  })
  levels[1].partitions.push({ path: spiral, width: 0.25, height: 0.91 })
  levels[1].circles.push({ x: 0, y: 0, radius: 0.62 })
  // Two independent, flowing S strokes. Their open ends leave connected water
  // around the islands and a clear approach to the central lower outlet.
  levels[2].partitions.push(
    { path: cubic([[-3.00, -2.25], [0.10, -2.05], [-3.35, -3.65], [-0.78, -3.65]], 112), width: PARTITION_CORE, height: 0.83 },
    { path: cubic([[3.10, -3.66], [0.25, -3.89], [3.20, -2.48], [0.84, -2.30]], 112), width: PARTITION_CORE, height: 0.87 },
  )
  for (const level of levels) {
    for (const partition of level.partitions) level.water.holes.push(hole(ribbon(partition.path, partition.width + PARTITION_BEVEL * 2)))
    for (const circle of level.circles) level.water.holes.push(hole(ellipse(circle.x, circle.y, circle.radius)))
  }
  // The source pedestal occupies actual upper-basin floor area.
  levels[0].water.holes.push(hole(ellipse(0, 3.65, 0.25)))
  return levels
}

function shapeArea(shape: THREE.Shape): number {
  const points = shape.extractPoints(64)
  return Math.abs(THREE.ShapeUtils.area(points.shape)) - points.holes.reduce((sum, ring) => sum + Math.abs(THREE.ShapeUtils.area(ring)), 0)
}

/** Shared, GPU-free footprints for both volume conservation and water meshes. */
export function createCascadeSurfaces(): CascadeSurface[] {
  return createDesign().map(level => ({ shape: level.water, floor: level.floor, area: shapeArea(level.water) }))
}

/** Split a vessel rim into true open ribbons at both its incoming/outgoing ports. */
function perimeterRibbons(level: BasinDesign, index: number): THREE.Shape[] {
  const centerline = vesselOutline(level.width - 0.40, level.front + 0.20, level.back - 0.20)
  const points = centerline.getSpacedPoints(420).slice(0, -1)
  const outgoing = CASCADE_SPILLS[index], incoming = index > 0 ? CASCADE_SPILLS[index - 1] : null
  const inGap = (p: THREE.Vector2) => {
    const clearance = outgoing.width / 2 + WALL_CORE / 2 + WALL_BEVEL + 0.09
    if (p.y < level.front + 0.57 && Math.abs(p.x - outgoing.x) < clearance) return true
    return incoming !== null && p.y > level.back - 0.57 && Math.abs(p.x - incoming.x) < incoming.width / 2 + WALL_CORE / 2 + WALL_BEVEL + 0.09
  }
  const start = points.findIndex(inGap)
  const shapes: THREE.Shape[] = []
  let run: THREE.Vector2[] = []
  for (let i = 1; i <= points.length; i++) {
    const p = points[(Math.max(0, start) + i) % points.length]
    if (inGap(p)) {
      if (run.length > 1) shapes.push(ribbon(run, WALL_CORE))
      run = []
    } else run.push(p)
  }
  if (run.length > 1) shapes.push(ribbon(run, WALL_CORE))
  return shapes
}

function ellipseRibbon(cx: number, cy: number, rx: number, ry: number, width: number, gap?: (p: THREE.Vector2) => boolean): THREE.Shape {
  const points = Array.from({ length: 181 }, (_, i) => {
    // Starting at the front keeps a front port in one contiguous removed arc.
    const angle = -Math.PI / 2 + i / 180 * TAU
    return new THREE.Vector2(cx + Math.cos(angle) * rx, cy + Math.sin(angle) * ry)
  })
  if (gap) return ribbon(points.filter(p => !gap(p)), width)
  const shape = ellipse(cx, cy, rx + width / 2, ry + width / 2)
  shape.holes.push(hole(ellipse(cx, cy, rx - width / 2, ry - width / 2)))
  return shape
}

/** Fully modeled porcelain vessels. Caller retains ownership of supplied materials. */
export class CascadeGeometry {
  readonly group = new THREE.Group()
  readonly surfaces: CascadeSurface[]
  private readonly geometries: THREE.BufferGeometry[] = []
  private readonly adjustableWalls: THREE.Mesh[] = []

  constructor(porcelain: THREE.MeshPhysicalMaterial, floorMaterials: THREE.Material[]) {
    this.group.name = 'mediterranean-cascade-sculpture'
    const design = createDesign()
    this.surfaces = design.map(level => ({ shape: level.water, floor: level.floor, area: shapeArea(level.water) }))
    for (let i = 0; i < design.length; i++) {
      const level = design[i]
      const floor = floorMaterials[i] ?? porcelain
      const body = this.extrusion(level.outline, level.floor + 0.55, 0.12)
      this.mesh(body, [floor, porcelain], `cascade-basin-${i}-body`, -0.55)
      const foot = this.extrusion(vesselOutline(level.width - 0.13, level.front + 0.04, level.back - 0.04), 0.19, 0.10)
      this.mesh(foot, porcelain, `cascade-basin-${i}-rounded-foot`, -0.70)
      for (const [part, shape] of perimeterRibbons(level, i).entries()) {
        const wall = this.mesh(this.extrusion(shape, CASCADE_WALL_HEIGHT, WALL_BEVEL), porcelain, `cascade-basin-${i}-rim-${part}`, level.floor)
        this.adjustableWalls.push(wall)
      }
      for (const [part, partition] of level.partitions.entries()) {
        const wall = this.mesh(this.extrusion(ribbon(partition.path, partition.width), partition.height, PARTITION_BEVEL), porcelain, `cascade-basin-${i}-curved-partition-${part}`, level.floor)
        this.adjustableWalls.push(wall)
      }
      for (const circle of level.circles) {
        this.mesh(this.extrusion(ellipse(circle.x, circle.y, circle.radius - 0.10), CASCADE_WALL_HEIGHT, 0.10), porcelain, 'cascade-circular-fountain-island', level.floor)
      }
      const spill = CASCADE_SPILLS[i]
      const lip = vesselOutline(spill.width - 0.16, spill.y - 0.10, spill.y + 0.36)
      this.mesh(this.extrusion(lip, CASCADE_SILL_DEPTH, 0.09), porcelain, `cascade-spill-${i}-rounded-sill`, level.floor).position.x = spill.x
    }
    this.addSource(porcelain)
    this.addFountainBowl(porcelain)
    this.addReceivingTrough(porcelain, floorMaterials[2] ?? porcelain)
    this.group.userData.cascadeCoordinates = {
      sourceWater: [0, 3.65, 3.13], sourceSpout: [0, 3.10, 3.12],
      fountainWater: [0, 0, 2.06], fountainWaterRadius: 0.22,
      receiverWater: [0, -5.15, -0.42], receiverWaterRadii: [1.18, 0.58],
    }
  }

  private extrusion(shape: THREE.Shape, height: number, bevel: number): THREE.BufferGeometry {
    const crown = Math.min(bevel, height * 0.28)
    const source = new THREE.ExtrudeGeometry(shape, {
      depth: height - 2 * crown, bevelEnabled: true, bevelSize: bevel,
      bevelThickness: crown, bevelSegments: 8, curveSegments: 32, steps: 1,
    })
    source.translate(0, 0, crown)
    source.deleteAttribute('normal'); source.deleteAttribute('uv')
    const geometry = mergeVertices(source, 1e-5)
    source.dispose()
    geometry.computeVertexNormals()
    const position = geometry.getAttribute('position'), uv = new Float32Array(position.count * 2)
    for (let i = 0; i < position.count; i++) { uv[i * 2] = position.getX(i); uv[i * 2 + 1] = position.getY(i) }
    geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
    geometry.computeBoundingBox(); geometry.computeBoundingSphere()
    this.geometries.push(geometry)
    return geometry
  }

  private mesh(geometry: THREE.BufferGeometry, material: THREE.Material | THREE.Material[], name: string, z: number): THREE.Mesh {
    const mesh = new THREE.Mesh(geometry, material)
    mesh.position.z = z; mesh.name = name; mesh.castShadow = true; mesh.receiveShadow = true
    this.group.add(mesh)
    return mesh
  }

  private addSource(material: THREE.MeshPhysicalMaterial): void {
    this.mesh(this.extrusion(ellipse(0, 3.65, 0.16), 1.10, 0.09), material, 'cascade-source-sculpted-pedestal', 1.90)
    this.mesh(this.extrusion(ellipse(0, 3.65, 0.48, 0.42), 0.22, 0.10), material, 'cascade-source-cup-base', 2.78)
    const rim = ellipseRibbon(0, 3.65, 0.47, 0.40, 0.10, p => p.y < 3.40 && Math.abs(p.x) < 0.24)
    this.mesh(this.extrusion(rim, 0.42, 0.09), material, 'cascade-source-open-ivory-cup', 3.00)
    this.mesh(this.extrusion(vesselOutline(0.31, 3.08, 3.44), 0.10, 0.09), material, 'cascade-source-ivory-spout', 3.02)
  }

  private addFountainBowl(material: THREE.MeshPhysicalMaterial): void {
    this.mesh(this.extrusion(ellipse(0, 0, 0.33), 0.10, 0.09), material, 'cascade-fountain-bowl-base', 1.90)
    const bowl = ellipseRibbon(0, 0, 0.32, 0.32, 0.04, p => p.y < -0.16 && Math.abs(p.x) < 0.23)
    this.mesh(this.extrusion(bowl, 0.24, 0.09), material, 'cascade-fountain-circular-bowl', 1.94)
    this.mesh(this.extrusion(vesselOutline(0.13, -0.66, -0.20), 0.105, 0.09), material, 'cascade-fountain-ivory-return-spout', 1.93)
  }

  private addReceivingTrough(material: THREE.MeshPhysicalMaterial, floor: THREE.Material): void {
    const outline = ellipse(0, -5.15, 1.55, 0.93)
    this.mesh(this.extrusion(outline, 0.13, 0.10), [floor, material], 'cascade-receiving-trough-base', -0.68)
    const rim = ellipseRibbon(0, -5.15, 1.40, 0.80, 0.26)
    this.mesh(this.extrusion(rim, 0.39, 0.10), material, 'cascade-receiving-trough-rounded-rim', -0.55)
  }

  setWallHeight(multiplier: number): void {
    const height = Number.isFinite(multiplier) ? THREE.MathUtils.clamp(multiplier, 0.55, 1.75) : 1
    for (const wall of this.adjustableWalls) wall.scale.z = height
  }

  dispose(): void {
    for (const geometry of this.geometries) geometry.dispose()
    this.geometries.length = 0
    this.group.clear()
  }
}
