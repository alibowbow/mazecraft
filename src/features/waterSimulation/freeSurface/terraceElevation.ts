import * as THREE from 'three'

/** The fluid keeps its original XY topology; world Y is minus the fluid row. */
export interface TerraceElevationProfile {
  readonly knots: readonly { worldY: number; elevation: number }[]
  readonly breakpoints: readonly number[]
  readonly topWorldY: number
  readonly bottomWorldY: number
  readonly totalRise: number
  readonly plateauCount: number
}

export interface TerraceElevationOptions {
  plateauCount?: number
  totalRise?: number
  /** Width, in cells, of a descending spill slope across a row seam. */
  transitionWidth?: number
  outletDrop?: number
  inletRise?: number
}

export const MAX_TERRACE_KNOTS = 16

/**
 * A single profile drives the ceramic floor, walls, water and accessories.
 * Interior plateaus are flat and transitions coincide with whole-row seams.
 * The small outside-board shoulders keep bevels level at the inlet and outlet.
 */
export function createTerraceElevation(
  layout: { topY: number; bottomY: number },
  options: TerraceElevationOptions = {},
): TerraceElevationProfile {
  const rows = layout.bottomY - layout.topY
  if (!Number.isFinite(rows) || rows <= 0 || !Number.isFinite(layout.topY)) {
    throw new RangeError('Terraces need finite, ordered maze bounds.')
  }
  const requestedCount = options.plateauCount ?? Math.floor(rows / 2)
  const plateauCount = Math.min(4, Math.max(1, Math.min(Math.floor(rows), Math.round(requestedCount))))
  const totalRise = plateauCount > 1 ? options.totalRise ?? 1.2 : 0
  const transitionWidth = options.transitionWidth ?? 0.16
  const outletDrop = options.outletDrop ?? 0.52
  const inletRise = options.inletRise ?? 0.32
  if (![requestedCount, totalRise, transitionWidth, outletDrop, inletRise].every(Number.isFinite)
    || totalRise < 0 || transitionWidth <= 0 || transitionWidth > 0.5 || outletDrop < 0 || inletRise < 0) {
    throw new RangeError('Invalid terrace dimensions.')
  }
  const topWorldY = -layout.topY, bottomWorldY = -layout.bottomY
  const knots: { worldY: number; elevation: number }[] = [
    { worldY: bottomWorldY - 0.72, elevation: -outletDrop },
    { worldY: bottomWorldY - 0.14, elevation: 0 },
  ]
  for (let step = 1; step < plateauCount; step++) {
    const seamRow = layout.bottomY - Math.round(rows * step / plateauCount)
    knots.push(
      { worldY: -seamRow - transitionWidth / 2, elevation: totalRise * (step - 1) / (plateauCount - 1) },
      { worldY: -seamRow + transitionWidth / 2, elevation: totalRise * step / (plateauCount - 1) },
    )
  }
  knots.push(
    { worldY: topWorldY + 0.15, elevation: totalRise },
    { worldY: topWorldY + 0.85, elevation: totalRise + inletRise },
  )
  return { knots, breakpoints: knots.map(knot => knot.worldY), topWorldY, bottomWorldY, totalRise, plateauCount }
}

export function terraceElevationAt(profile: TerraceElevationProfile, worldY: number): number {
  const knots = profile.knots
  if (worldY <= knots[0].worldY) return knots[0].elevation
  for (let i = 1; i < knots.length; i++) {
    const a = knots[i - 1], b = knots[i]
    if (worldY <= b.worldY) {
      const t = (worldY - a.worldY) / (b.worldY - a.worldY)
      return a.elevation + (b.elevation - a.elevation) * t
    }
  }
  return knots[knots.length - 1].elevation
}

export function terraceElevationSlopeAt(profile: TerraceElevationProfile, worldY: number): number {
  const knots = profile.knots
  if (worldY < knots[0].worldY) return 0
  for (let i = 1; i < knots.length; i++) {
    const a = knots[i - 1], b = knots[i]
    if (worldY < b.worldY) return (b.elevation - a.elevation) / (b.worldY - a.worldY)
  }
  return 0
}

/** Include once in a vertex/fragment shader. All heights use board coordinates. */
export const TERRACE_ELEVATION_GLSL = /* glsl */ `
  uniform vec2 uTerraceKnots[${MAX_TERRACE_KNOTS}];
  uniform int uTerraceKnotCount;
  float terraceElevation(float worldY) {
    float height = uTerraceKnots[0].y;
    for (int i = 1; i < ${MAX_TERRACE_KNOTS}; i++) {
      if (i < uTerraceKnotCount) {
        vec2 a = uTerraceKnots[i - 1];
        vec2 b = uTerraceKnots[i];
        float t = clamp((worldY - a.x) / max(0.000001, b.x - a.x), 0.0, 1.0);
        height = mix(height, b.y, t);
      }
    }
    return height;
  }
  float terraceElevationSlope(float worldY) {
    if (worldY < uTerraceKnots[0].x) return 0.0;
    for (int i = 1; i < 16; i++) {
      if (i < uTerraceKnotCount && worldY < uTerraceKnots[i].x) {
        vec2 a = uTerraceKnots[i - 1];
        vec2 b = uTerraceKnots[i];
        return (b.y - a.y) / max(0.000001, b.x - a.x);
      }
    }
    return 0.0;
  }
`

export function createTerraceUniforms(profile: TerraceElevationProfile): Record<string, THREE.IUniform> {
  return {
    uTerraceKnots: { value: Array.from({ length: MAX_TERRACE_KNOTS }, (_, i) => {
      const knot = profile.knots[Math.min(i, profile.knots.length - 1)]
      return new THREE.Vector2(knot.worldY, knot.elevation)
    }) },
    uTerraceKnotCount: { value: profile.knots.length },
  }
}

type Vertex = Record<string, number[]>

/**
 * Split static triangles exactly at each elevation knot before deformation.
 * Position/UV/normal and other ordinary vertex attributes and material groups
 * survive the split. The source is never changed; callers own the result.
 */
export function splitTerraceGeometry(source: THREE.BufferGeometry, profile: TerraceElevationProfile): THREE.BufferGeometry {
  const position = source.getAttribute('position')
  if (!position || position.itemSize !== 3) throw new TypeError('A 3D position attribute is required.')
  const names = Object.keys(source.attributes)
  const attributes = names.map(name => source.getAttribute(name))
  const data: Record<string, number[]> = Object.fromEntries(names.map(name => [name, []]))
  const index = source.getIndex()
  const count = index?.count ?? position.count
  const read = (slot: number): Vertex => {
    const vertexIndex = index ? index.getX(slot) : slot
    return Object.fromEntries(names.map((name, attributeIndex) => {
      const attr = attributes[attributeIndex]
      return [name, Array.from({ length: attr.itemSize }, (_, component) => attr.getComponent(vertexIndex, component))]
    }))
  }
  const intersection = (a: Vertex, b: Vertex, y: number): Vertex => {
    const t = (y - a.position[1]) / (b.position[1] - a.position[1])
    const vertex = Object.fromEntries(names.map(name => [name, a[name].map((value, component) => value + (b[name][component] - value) * t)]))
    vertex.position[1] = y
    return vertex
  }
  const clip = (polygon: Vertex[], y: number, lower: boolean): Vertex[] => {
    const result: Vertex[] = []
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i], b = polygon[(i + 1) % polygon.length]
      const insideA = lower ? a.position[1] <= y : a.position[1] >= y
      const insideB = lower ? b.position[1] <= y : b.position[1] >= y
      if (insideA) result.push(a)
      if (insideA !== insideB) result.push(intersection(a, b, y))
    }
    return result
  }
  const output = new THREE.BufferGeometry()
  let emitted = 0
  const emit = (polygon: Vertex[]) => {
    for (let i = 1; i < polygon.length - 1; i++) {
      const triangle = [polygon[0], polygon[i], polygon[i + 1]]
      const [a, b, c] = triangle.map(vertex => vertex.position)
      const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
      const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
      const areaSquared = (ab[1] * ac[2] - ab[2] * ac[1]) ** 2 + (ab[2] * ac[0] - ab[0] * ac[2]) ** 2 + (ab[0] * ac[1] - ab[1] * ac[0]) ** 2
      if (areaSquared < 1e-20) continue
      for (const vertex of triangle) for (const name of names) data[name].push(...vertex[name])
      emitted += 3
    }
  }
  const groups = source.groups.length ? source.groups : [{ start: 0, count, materialIndex: 0 }]
  for (const group of groups) {
    const start = emitted
    for (let i = group.start; i + 2 < Math.min(count, group.start + group.count); i += 3) {
      const a = index ? index.getX(i) : i
      const b = index ? index.getX(i + 1) : i + 1
      const c = index ? index.getX(i + 2) : i + 2
      const minY = Math.min(position.getY(a), position.getY(b), position.getY(c))
      const maxY = Math.max(position.getY(a), position.getY(b), position.getY(c))
      let firstCut = -1
      for (let cut = 0; cut < profile.breakpoints.length; cut++) {
        const y = profile.breakpoints[cut]
        if (y > minY + 1e-9 && y < maxY - 1e-9) { firstCut = cut; break }
      }
      if (firstCut < 0) {
        // Most crown/bevel triangles fit inside one plateau. Preserve them
        // directly: no per-vertex objects, attribute arrays or polygon clips.
        for (let attributeIndex = 0; attributeIndex < names.length; attributeIndex++) {
          const attr = attributes[attributeIndex], target = data[names[attributeIndex]]
          for (let component = 0; component < attr.itemSize; component++) target.push(attr.getComponent(a, component))
          for (let component = 0; component < attr.itemSize; component++) target.push(attr.getComponent(b, component))
          for (let component = 0; component < attr.itemSize; component++) target.push(attr.getComponent(c, component))
        }
        emitted += 3
        continue
      }
      let polygon = [read(i), read(i + 1), read(i + 2)]
      for (let cut = firstCut; cut < profile.breakpoints.length; cut++) {
        const y = profile.breakpoints[cut]
        if (y <= minY + 1e-9 || y >= maxY - 1e-9) continue
        emit(clip(polygon, y, true))
        polygon = clip(polygon, y, false)
      }
      emit(polygon)
    }
    if (emitted > start) output.addGroup(start, emitted - start, group.materialIndex)
  }
  for (const name of names) output.setAttribute(name, new THREE.Float32BufferAttribute(data[name], source.getAttribute(name).itemSize))
  output.name = source.name
  output.computeBoundingBox(); output.computeBoundingSphere()
  return output
}

export interface TerraceGeometryWarpOptions {
  mode?: 'translate' | 'fixed-bottom'
  /** Anchor plane is unchanged, while topZ is raised by the full terrace height. */
  bottomZ?: number
  topZ?: number
}

/** Static CPU warp; shader-displaced water can use splitTerraceGeometry alone. */
export function warpTerraceGeometry(
  source: THREE.BufferGeometry,
  profile: TerraceElevationProfile,
  options: TerraceGeometryWarpOptions = {},
): THREE.BufferGeometry {
  const fixedBottom = options.mode === 'fixed-bottom'
  const bottom = options.bottomZ ?? -0.65, top = options.topZ ?? 0
  if (fixedBottom && (!Number.isFinite(bottom) || !Number.isFinite(top) || top <= bottom)) {
    throw new RangeError('The fixed bottom must be below the top.')
  }
  const result = splitTerraceGeometry(source, profile)
  const position = result.getAttribute('position'), normal = result.getAttribute('normal')
  const transformedNormal = new THREE.Vector3()
  for (let triangle = 0; triangle < position.count; triangle += 3) {
    // At a seam each triangle uses its own side's slope, preserving the crease.
    const centerY = (position.getY(triangle) + position.getY(triangle + 1) + position.getY(triangle + 2)) / 3
    const slope = terraceElevationSlopeAt(profile, centerY)
    for (let i = triangle; i < triangle + 3; i++) {
      const y = position.getY(i), z = position.getZ(i), height = terraceElevationAt(profile, y)
      const weight = fixedBottom ? THREE.MathUtils.clamp((z - bottom) / (top - bottom), 0, 1) : 1
      const weightSlope = fixedBottom && z > bottom && z < top ? 1 / (top - bottom) : 0
      position.setZ(i, z + height * weight)
      if (normal) {
        const scaleZ = 1 + height * weightSlope
        transformedNormal.set(normal.getX(i), normal.getY(i) - slope * weight * normal.getZ(i) / scaleZ, normal.getZ(i) / scaleZ).normalize()
        normal.setXYZ(i, transformedNormal.x, transformedNormal.y, transformedNormal.z)
      }
    }
  }
  if (!normal) result.computeVertexNormals()
  result.computeBoundingBox(); result.computeBoundingSphere()
  return result
}
