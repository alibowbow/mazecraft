import * as THREE from 'three'
import type { FluidLayout } from './types'
import type { WaterAppearance } from './appearance'
import { getWaterTheme, type WaterLook } from './lookdev'
import { createTerraceElevation, createTerraceUniforms, TERRACE_ELEVATION_GLSL, warpTerraceGeometry } from './terraceElevation'
import { BasinField, BASIN_FIELD_GLSL } from './basinField'
import { BASIN_FLOOR_Z, type BasinSnapshot } from './basinSimulation'

/** Boundary loops preserve the user's active-cell silhouette, including holes. */
export function mazeBodyShapes(layout: FluidLayout): THREE.Shape[] {
  const { rows, cols, activeCells } = layout
  const edges = new Map<string, { a: THREE.Vector2; b: THREE.Vector2 }[]>()
  const key = (p: THREE.Vector2) => `${p.x},${p.y}`
  const active = (r: number, c: number) => r >= 0 && r < rows && c >= 0 && c < cols && !!activeCells[r * cols + c]
  const add = (x: number, y: number, xx: number, yy: number) => {
    const a = new THREE.Vector2(x, y), b = new THREE.Vector2(xx, yy)
    const list = edges.get(key(a)) ?? []; list.push({ a, b }); edges.set(key(a), list)
  }
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (active(r, c)) {
    if (!active(r - 1, c)) add(c, -r, c + 1, -r)
    if (!active(r, c + 1)) add(c + 1, -r, c + 1, -r - 1)
    if (!active(r + 1, c)) add(c + 1, -r - 1, c, -r - 1)
    if (!active(r, c - 1)) add(c, -r - 1, c, -r)
  }
  const loops: THREE.Vector2[][] = []
  while (edges.size) {
    const first = edges.values().next().value![0].a
    let p = first
    const loop: THREE.Vector2[] = []
    for (let i = 0; i < rows * cols * 4 + 4; i++) {
      const k = key(p), choices = edges.get(k)
      if (!choices?.length) break
      // At diagonal cell contacts keep each clockwise boundary separate.
      if (choices.length > 1 && loop.length) {
        const incoming = p.clone().sub(loop[loop.length - 1])
        const turn = (edge: { a: THREE.Vector2; b: THREE.Vector2 }) => {
          const outgoing = edge.b.clone().sub(edge.a)
          return Math.atan2(incoming.cross(outgoing), incoming.dot(outgoing))
        }
        choices.sort((a, b) => turn(b) - turn(a))
      }
      const edge = choices.pop()!
      if (!choices.length) edges.delete(k)
      loop.push(edge.a); p = edge.b
      if (key(p) === key(first)) break
    }
    if (loop.length >= 3) loops.push(loop)
  }
  const outer = loops.filter(points => THREE.ShapeUtils.isClockWise(points)).map(points => new THREE.Shape(points))
  const contains = (p: THREE.Vector2, points: THREE.Vector2[]) => {
    let inside = false
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const a = points[i], b = points[j]
      if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside
    }
    return inside
  }
  for (const hole of loops.filter(points => !THREE.ShapeUtils.isClockWise(points))) {
    outer.find(shape => contains(hole[0], shape.getPoints()))?.holes.push(new THREE.Path(hole))
  }
  return outer
}

/** Small cast radii soften the body without covering holes or joining islands. */
function roundedBodyPath(points: THREE.Vector2[], radius = 0.14): THREE.Path {
  const unique = points.filter((p, i) => i === 0 || !p.equals(points[i - 1]))
  if (unique.length > 1 && unique[0].equals(unique[unique.length - 1])) unique.pop()
  const corners = unique.filter((point, i) => {
    const before = unique[(i + unique.length - 1) % unique.length]
    const after = unique[(i + 1) % unique.length]
    return Math.abs(point.clone().sub(before).cross(after.clone().sub(point))) > 0.00001
  })
  const path = new THREE.Path()
  corners.forEach((point, i) => {
    const before = corners[(i + corners.length - 1) % corners.length]
    const after = corners[(i + 1) % corners.length]
    const incoming = point.clone().lerp(before, Math.min(0.25, radius / point.distanceTo(before)))
    const outgoing = point.clone().lerp(after, Math.min(0.25, radius / point.distanceTo(after)))
    if (i === 0) path.moveTo(incoming.x, incoming.y)
    else path.lineTo(incoming.x, incoming.y)
    path.quadraticCurveTo(point.x, point.y, outgoing.x, outgoing.y)
  })
  path.closePath()
  return path
}

/** Reusable periodic caustic ridges: no cell search or random noise per frame. */
function createCausticTexture(): THREE.DataTexture {
  const size = 256, cells = 6, data = new Uint8Array(size * size)
  const fract = (n: number) => n - Math.floor(n)
  const seed = (x: number, y: number, offset: number) => fract(Math.sin(x * 127.1 + y * 311.7 + offset) * 43758.5453)
  const sites = Array.from({ length: cells * cells }, (_, i) => {
    const x = i % cells, y = Math.floor(i / cells)
    return [0.04 + seed(x, y, 0) * 0.92, 0.04 + seed(x, y, 73.19) * 0.92]
  })
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const px = x / size * cells, py = y / size * cells
    const ix = Math.floor(px), iy = Math.floor(py)
    let first = Infinity, second = Infinity
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const sx = ix + dx, sy = iy + dy
      const site = sites[((sy + cells) % cells) * cells + (sx + cells) % cells]
      const distance = Math.hypot(sx + site[0] - px, sy + site[1] - py)
      if (distance < first) { second = first; first = distance }
      else if (distance < second) second = distance
    }
    const ridge = Math.exp(-(second - first) * 23)
    data[y * size + x] = Math.round(ridge * 255)
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RedFormat)
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping
  texture.magFilter = THREE.LinearFilter
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.generateMipmaps = true
  texture.needsUpdate = true
  return texture
}

export class SculptedSurface {
  readonly water: THREE.Mesh
  readonly body: THREE.Mesh
  readonly foundation: THREE.Mesh
  readonly waterMaterial = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.065, metalness: 0, ior: 1.333, transmission: 0.92, thickness: 0.42, clearcoat: 0, envMapIntensity: 0.8, side: THREE.FrontSide })
  readonly floorMaterial = new THREE.MeshPhysicalMaterial({ roughness: 0.28, clearcoat: 0.65, clearcoatRoughness: 0.2, envMapIntensity: 0.5 })
  readonly sideMaterial = new THREE.MeshPhysicalMaterial({ roughness: 0.3, clearcoat: 0.48, clearcoatRoughness: 0.24, envMapIntensity: 0.55 })
  readonly baseMaterial = new THREE.MeshPhysicalMaterial({ roughness: 0.4, clearcoat: 0.25, envMapIntensity: 0.4 })
  private readonly waterDepth = new THREE.MeshDepthMaterial({ colorWrite: false, depthWrite: false })
  readonly uniforms: Record<string, THREE.IUniform>
  private geometry: THREE.BufferGeometry[] = []
  private readonly contactTexture: THREE.DataTexture
  private readonly causticTexture = createCausticTexture()
  private readonly basin: BasinField

  constructor(layout: FluidLayout, surface: THREE.Texture, bounds: THREE.Vector4) {
    const terraces = createTerraceElevation(layout)
    this.basin = new BasinField(layout.rows, layout.cols)
    // A static, local ambient-occlusion field gives the ceramic joints depth.
    // Only wall neighbourhoods are rasterized; no per-frame CPU work is needed.
    const size = 512, contact = new Uint8Array(size * size).fill(255)
    for (const wall of layout.walls) {
      if (wall.kind === 'funnel') continue
      const pad = 0.34
      const x0 = Math.max(0, Math.floor((wall.x0 - pad - bounds.x) / bounds.z * size))
      const x1 = Math.min(size - 1, Math.ceil((wall.x1 + pad - bounds.x) / bounds.z * size))
      const y0 = Math.max(0, Math.floor((-wall.y1 - pad - bounds.y) / bounds.w * size))
      const y1 = Math.min(size - 1, Math.ceil((-wall.y0 + pad - bounds.y) / bounds.w * size))
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const px = bounds.x + (x + 0.5) / size * bounds.z
        const py = -(bounds.y + (y + 0.5) / size * bounds.w)
        const distance = Math.hypot(Math.max(wall.x0 - px, 0, px - wall.x1), Math.max(wall.y0 - py, 0, py - wall.y1))
        contact[y * size + x] = Math.min(contact[y * size + x], Math.round(255 * (1 - 0.32 * Math.exp(-distance / 0.15))))
      }
    }
    this.contactTexture = new THREE.DataTexture(contact, size, size, THREE.RedFormat)
    this.contactTexture.minFilter = this.contactTexture.magFilter = THREE.LinearFilter
    this.contactTexture.needsUpdate = true
    this.uniforms = {
      uLiquid: { value: surface }, uLiquidTime: { value: 0 }, uLiquidStyle: { value: 0.6 },
      uLiquidBounds: { value: bounds }, uLiquidLod: { value: 2.0 }, uStone: { value: 0 }, uContact: { value: this.contactTexture },
      uCaustic: { value: this.causticTexture }, uLiquidTint: { value: new THREE.Color('#ffffff') },
      uBasin: { value: this.basin.texture }, uBasinSize: { value: this.basin.size }, uBasinEnabled: { value: 0 },
      uBasinFloorZ: { value: BASIN_FLOOR_Z },
      ...createTerraceUniforms(terraces),
    }
    const common = `
      uniform sampler2D uLiquid;
      uniform float uLiquidTime;
      uniform float uLiquidStyle;
      uniform float uLiquidLod;
      uniform float uBasinFloorZ;
      uniform vec4 uLiquidBounds;
      varying vec2 vLiquidUv;
      varying vec2 vBodyPoint;
      ${BASIN_FIELD_GLSL}
      vec4 liquidField(vec2 uv) {
        if (uBasinEnabled > 0.5) {
          vec4 basin = basinAt(uLiquidBounds.xy + uv * uLiquidBounds.zw);
          return vec4(basin.r, length(basin.gb) * basin.r, basin.a, basin.r);
        }
        return texture2D(uLiquid, uv);
      }
      vec2 ripplePhase(vec2 p, float t) {
        return vec2(dot(p, vec2(4.1, 2.3)) - t * 1.5,
          dot(p, vec2(-2.2, 5.8)) - t * 1.1);
      }
      float rippleHash(vec2 p) {
        vec3 h = fract(vec3(p.xyx) * 0.1031);
        h += dot(h, h.yzx + 33.33);
        return fract((h.x + h.y) * h.z);
      }
      float rippleNoise(vec2 p) {
        vec2 cell = floor(p), local = fract(p);
        vec2 blend = local * local * (3.0 - 2.0 * local);
        return mix(mix(rippleHash(cell), rippleHash(cell + vec2(1.0, 0.0)), blend.x),
          mix(rippleHash(cell + vec2(0.0, 1.0)), rippleHash(cell + vec2(1.0, 1.0)), blend.x), blend.y);
      }
    `
    const fieldFunctions = `
      float liquidHeight(vec2 p) {
        if (uBasinEnabled > 0.5) {
          vec2 world = uLiquidBounds.xy + p * uLiquidBounds.zw;
          vec4 basin = basinAt(world);
          float speed = min(1.0, length(basin.gb) * 2.0);
          vec2 phase = ripplePhase(world - basin.gb * uLiquidTime * 0.06, uLiquidTime);
          float waves = (sin(phase.x) * 0.0028 + sin(phase.y) * 0.0018) * (0.2 + speed * 0.8) * uLiquidStyle;
          return uBasinFloorZ + basin.r + waves * smoothstep(0.002, 0.07, basin.r);
        }
        vec4 f = texture2DLodEXT(uLiquid, p, uLiquidLod);
        vec2 world = uLiquidBounds.xy + p * uLiquidBounds.zw;
        float speed = smoothstep(0.02, 0.35, f.g / max(f.r, 0.01));
        vec2 phase = ripplePhase(world, uLiquidTime);
        float waves = sin(phase.x) * 0.008 + sin(phase.y) * 0.004;
        return 0.018 + f.b * (0.10 + waves * speed * uLiquidStyle);
      }
    `.replaceAll('texture2DLodEXT', 'textureLod')
    this.waterMaterial.onBeforeCompile = shader => {
      Object.assign(shader.uniforms, this.uniforms)
      shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>\n${common}\n${fieldFunctions}\n${TERRACE_ELEVATION_GLSL}`)
        .replace('#include <beginnormal_vertex>', `
          #include <beginnormal_vertex>
          vec2 liquidUv = uv;
          vec2 du = vec2(0.032) / uLiquidBounds.zw;
          float gx = (liquidHeight(liquidUv + vec2(du.x, 0.0)) - liquidHeight(liquidUv - vec2(du.x, 0.0))) / 0.064;
          float gy = (liquidHeight(liquidUv + vec2(0.0, du.y)) - liquidHeight(liquidUv - vec2(0.0, du.y))) / 0.064;
          // Coverage is not a wave slope. A shallow meniscus avoids turning
          // every particle boundary into a sharp chrome reflection.
          float worldY = uLiquidBounds.y + liquidUv.y * uLiquidBounds.w;
          float terraceSlope = (terraceElevation(worldY + 0.008) - terraceElevation(worldY - 0.008)) / 0.016;
          vec2 liquidSlope = clamp(vec2(-gx, -gy), vec2(-0.16), vec2(0.16));
          objectNormal = normalize(vec3(liquidSlope.x, liquidSlope.y - terraceSlope, 1.0));
        `).replace('#include <begin_vertex>', `
          #include <begin_vertex>
          transformed.z = liquidHeight(uv) + terraceElevation(uLiquidBounds.y + uv.y * uLiquidBounds.w);
          vLiquidUv = uv; vBodyPoint = position.xy;
        `)
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\n${common}`)
        .replace('#include <alphatest_fragment>', `
          #include <alphatest_fragment>
          vec4 acceptedLiquid = liquidField(vLiquidUv);
          float density = acceptedLiquid.r;
          if (uBasinEnabled > 0.5 ? acceptedLiquid.b < 0.5 || density < 0.002 : density < 0.105) discard;
        `)
        .replace('#include <normal_fragment_maps>', `
          #include <normal_fragment_maps>
          vec4 flow = liquidField(vLiquidUv);
          float motion = smoothstep(0.025, 0.35, flow.g / max(flow.r, 0.01));
          if (uBasinEnabled > 0.5) motion = 0.24 + motion * 0.76;
          vec2 p = uLiquidBounds.xy + vLiquidUv * uLiquidBounds.zw;
          vec2 phase = ripplePhase(p, uLiquidTime);
          vec2 micro = vec2(cos(phase.x) * 0.023 + cos(phase.y) * 0.014,
            cos(phase.x) * 0.013 - cos(phase.y) * 0.026);
          // One dominant, gently wandering wave train carries small, unequal
          // cross-ripples. Smooth wave packets prevent crossed periodic waves
          // from turning the reflected light into an even lattice of dots.
          vec2 drift = p + vec2(-0.024, 0.016) * uLiquidTime;
          vec2 warp = vec2(rippleNoise(drift * 0.68), rippleNoise(drift * 0.91 + vec2(5.2, -9.1))) - 0.5;
          vec2 wavePoint = p + warp * 0.64;
          float packet = smoothstep(0.22, 0.85, rippleNoise(drift * 0.47 + vec2(-3.7, 8.6)));
          vec3 capillaryPhase = vec3(dot(wavePoint, vec2(5.8, 9.5)) - uLiquidTime * 1.32,
            dot(wavePoint + warp.yx * 0.21, vec2(15.3, -4.7)) - uLiquidTime * 2.01,
            dot(wavePoint, vec2(-22.0, 13.0)) + uLiquidTime * 1.61);
          vec3 capillaryFilter = vec3(1.0) - smoothstep(vec3(0.7), vec3(2.2), fwidth(capillaryPhase));
          vec3 capillary = cos(capillaryPhase) * capillaryFilter;
          vec2 fineSlope = (vec2(0.52, 0.85) * capillary.x * 0.052
            + vec2(0.96, -0.29) * capillary.y * 0.016
            + vec2(-0.86, 0.51) * capillary.z * 0.006) * (0.22 + packet * 0.78);
          float interior = smoothstep(0.105, 0.24, flow.r);
          vec3 worldRipple = vec3((micro * motion + fineSlope * (0.55 + motion * 0.45)) * uLiquidStyle * interior, 0.0);
          normal = normalize(normal + mat3(viewMatrix) * worldRipple);
        `)
        .replace('#include <transmission_fragment>', THREE.ShaderChunk.transmission_fragment.replace(
          'material.thickness = thickness;',
          // Vary optical depth only where accepted liquid exists. This does
          // not fill a cell, blur across a wall, or change the wet footprint.
          'material.thickness = uBasinEnabled > 0.5 ? max(0.012, density) : thickness * mix(0.32, 1.15, smoothstep(0.105, 0.68, density));',
        ))
    }
    this.waterMaterial.customProgramCacheKey = () => 'atelier-physical-basin-v4'
    this.floorMaterial.onBeforeCompile = shader => {
      Object.assign(shader.uniforms, this.uniforms)
      shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>\n${common}`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>\nvBodyPoint = position.xy; vLiquidUv = (position.xy - uLiquidBounds.xy) / uLiquidBounds.zw;`)
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\n${common}\nuniform float uStone;\nuniform sampler2D uContact;\nuniform sampler2D uCaustic;\nuniform vec3 uLiquidTint;`)
        .replace('#include <color_fragment>', `
          #include <color_fragment>
          float grain = fract(sin(dot(floor(vBodyPoint * 160.0), vec2(12.9898, 78.233))) * 43758.5453);
          float vein = sin(vBodyPoint.y * 15.0 + sin(vBodyPoint.x * 2.3) * 0.8);
          float ceramicCloud = sin(vBodyPoint.x * 0.84 + sin(vBodyPoint.y * 1.1)) * sin(vBodyPoint.y * 0.67);
          diffuseColor.rgb *= 0.977 + grain * 0.018 + ceramicCloud * 0.012 + vein * uStone * 0.025;
          diffuseColor.rgb *= texture2D(uContact, vLiquidUv).r;
        `)
        .replace('#include <lights_fragment_end>', `
          #include <lights_fragment_end>
          vec4 liquid = liquidField(vLiquidUv);
          float wet = uBasinEnabled > 0.5 ? liquid.b * smoothstep(0.003, 0.045, liquid.r) : smoothstep(0.12, 0.29, liquid.r);
          float motion = smoothstep(0.03, 0.30, liquid.g / max(liquid.r, 0.01));
          if (uBasinEnabled > 0.5) motion = 0.22 + motion * 0.78;
          float t = uLiquidTime * motion;
          vec2 phase = ripplePhase(vBodyPoint, t);
          vec2 warp = vec2(sin(phase.x), sin(phase.y)) * 0.044 * uLiquidStyle;
          vec2 causticUv = vBodyPoint * 0.29 + warp + vec2(t * 0.008, -t * 0.004);
          float primary = texture2D(uCaustic, causticUv).r;
          vec2 secondaryUv = mat2(0.80, 0.60, -0.60, 0.80) * causticUv * 1.17 + vec2(0.21, 0.37) - warp * 0.7;
          float secondary = texture2D(uCaustic, secondaryUv).r;
          float focus = 0.5 + 0.5 * sin(phase.x * 0.43 + sin(phase.y * 0.61));
          float caustic = pow(primary, 1.3) * (0.22 + focus * focus * 0.78) + pow(secondary, 2.0) * 0.20;
          // Concentrate received sunlight on the bed. A wall's shadow must
          // suppress the caustic too; water never makes the floor emissive.
          reflectedLight.directDiffuse *= mix(1.0, 0.91 + caustic * 2.7, wet);
        `)
    }
    this.floorMaterial.customProgramCacheKey = () => 'atelier-ceramic-basin-floor-v2'
    this.sideMaterial.onBeforeCompile = shader => {
      shader.uniforms.uStone = this.uniforms.uStone
      shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vCastPosition;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCastPosition = position;')
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vCastPosition;\nuniform float uStone;')
        .replace('#include <color_fragment>', `
          #include <color_fragment>
          float cloud = sin(dot(vCastPosition.xy, vec2(1.27, 0.78)) + sin(vCastPosition.y * 1.8));
          float grain = fract(sin(dot(floor(vCastPosition * 140.0), vec3(12.9898, 78.233, 49.17))) * 43758.5453);
          float strata = sin(vCastPosition.z * 53.0 + cloud * 1.2);
          diffuseColor.rgb *= 0.988 + cloud * 0.011 + grain * 0.01 + strata * uStone * 0.018;
        `)
    }
    this.sideMaterial.customProgramCacheKey = () => 'atelier-cast-side-v1'
    const width = bounds.z, height = bounds.w
    const columns = Math.min(256, Math.max(64, Math.ceil(width * 12)))
    const rowCount = Math.min(256, Math.max(64, Math.ceil(height * 12)))
    // Include every spill lip exactly. A regular grid can jump over narrow
    // steps on large mazes; this retains the compact indexed mesh and adds
    // only a handful of rows instead of splitting every water triangle.
    const waterRows = Array.from({ length: rowCount + 1 }, (_, row) => bounds.y + height * row / rowCount)
    waterRows.push(...terraces.breakpoints.filter(y => y > bounds.y && y < bounds.y + height))
    const uniqueRows = [...new Set(waterRows)].sort((a, b) => b - a)
    const waterGeometry = new THREE.PlaneGeometry(width, height, columns, uniqueRows.length - 1)
    const waterPositions = waterGeometry.getAttribute('position'), waterUv = waterGeometry.getAttribute('uv')
    for (let row = 0; row < uniqueRows.length; row++) for (let col = 0; col <= columns; col++) {
      const index = row * (columns + 1) + col
      waterPositions.setY(index, uniqueRows[row] - bounds.y - height / 2)
      waterUv.setY(index, (uniqueRows[row] - bounds.y) / height)
    }
    this.water = new THREE.Mesh(waterGeometry, this.waterMaterial)
    this.water.position.set(bounds.x + width / 2, bounds.y + height / 2, 0)
    this.water.name = 'physical-displaced-water'
    this.water.frustumCulled = false
    this.water.receiveShadow = false
    // VSM also draws receivers into its depth pass. Clear liquid transmits
    // light, and its unclipped carrier plane must never cast a solid shadow.
    this.water.customDepthMaterial = this.waterDepth
    const shapes = mazeBodyShapes(layout).map(outline => {
      const shape = new THREE.Shape()
      shape.curves = roundedBodyPath(outline.getPoints()).curves
      shape.holes = outline.holes.map(hole => roundedBodyPath(hole.getPoints(), 0.10))
      return shape
    })
    const flatBody = new THREE.ExtrudeGeometry(shapes, { depth: 0.49, bevelEnabled: true, bevelSize: 0.07, bevelThickness: 0.085, bevelSegments: 5, steps: 1, curveSegments: 5 })
    flatBody.translate(0, 0, -0.575)
    const bodyGeometry = warpTerraceGeometry(flatBody, terraces, { mode: 'fixed-bottom', bottomZ: -0.66, topZ: -0.085 })
    flatBody.dispose()
    this.body = new THREE.Mesh(bodyGeometry, [this.floorMaterial, this.sideMaterial])
    this.body.name = 'sculpted-maze-body'; this.body.castShadow = true; this.body.receiveShadow = true
    const baseGeometry = new THREE.ExtrudeGeometry(shapes, { depth: 0.03, bevelEnabled: false, steps: 1, curveSegments: 5 })
    baseGeometry.translate(0, 0, -0.62)
    this.foundation = new THREE.Mesh(baseGeometry, this.baseMaterial)
    // The underside remains available to the presentation API but is housed
    // inside one continuous cast, rather than forming a second thin board.
    this.foundation.name = 'concealed-ceramic-foundation'; this.foundation.visible = false
    this.geometry.push(waterGeometry, bodyGeometry, baseGeometry)
  }

  setLook(look: WaterLook) {
    const p = getWaterTheme(look.theme)
    this.floorMaterial.color.set(p.floor); this.floorMaterial.roughness = Math.max(0.16, p.roughness)
    this.sideMaterial.color.set(p.wall); this.baseMaterial.color.set(p.slab)
    this.sideMaterial.roughness = Math.min(0.8, p.roughness + 0.06)
    this.floorMaterial.clearcoat = look.theme === 'terrace' || look.theme === 'basalt' ? 0.12 : 0.65
    this.sideMaterial.clearcoat = look.theme === 'terrace' || look.theme === 'basalt' ? 0.08 : 0.48
    this.uniforms.uStone.value = look.theme === 'terrace' || look.theme === 'basalt' ? 1 : 0
  }
  setBasinSnapshot(snapshot: BasinSnapshot) {
    this.basin.update(snapshot)
    this.uniforms.uBasinEnabled.value = 1
    this.uniforms.uLiquidTime.value = snapshot.diagnostics.time
  }
  setAppearance(appearance: WaterAppearance) {
    const tint = new THREE.Color(appearance.color ?? '#ffffff')
    this.waterMaterial.color.copy(tint).lerp(new THREE.Color('#ffffff'), appearance.color ? 0.72 : 1)
    ;(this.uniforms.uLiquidTint.value as THREE.Color).copy(tint)
    if (appearance.color) {
      this.waterMaterial.attenuationColor.copy(tint).lerp(new THREE.Color('#ffffff'), 0.05)
      this.waterMaterial.attenuationDistance = 0.75 + (1 - appearance.opacity) * 1.8
    } else {
      // Clear shallow water must not lay a gray absorption veil over the bed.
      // Its visibility comes from refraction, moving reflections and caustics.
      this.waterMaterial.color.set('#ffffff')
      this.waterMaterial.attenuationColor.set('#d9d9d9')
      this.waterMaterial.attenuationDistance = 1.7 + (1 - appearance.opacity) * 4.0
    }
    this.waterMaterial.thickness = 0.24 + appearance.opacity * 0.44
  }
  update(time: number, style: number) {
    this.uniforms.uLiquidTime.value = time; this.uniforms.uLiquidStyle.value = style
    const image = this.uniforms.uLiquid.value.image
    const bounds = this.uniforms.uLiquidBounds.value as THREE.Vector4
    // One mip-filtered height lookup replaces five neighbouring samples. The
    // world-space smoothing radius stays constant as the canvas is resized.
    this.uniforms.uLiquidLod.value = Math.max(1, Math.log2(0.12 * Math.max(image.width / bounds.z, image.height / bounds.w)))
  }
  dispose() { this.basin.dispose(); this.contactTexture.dispose(); this.causticTexture.dispose(); this.geometry.forEach(g => g.dispose()); [this.waterDepth, this.waterMaterial, this.floorMaterial, this.sideMaterial, this.baseMaterial].forEach(m => m.dispose()) }
}
