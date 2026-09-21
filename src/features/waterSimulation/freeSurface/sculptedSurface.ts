import * as THREE from 'three'
import type { FluidLayout } from './types'
import type { WaterAppearance } from './appearance'
import { getWaterTheme, type WaterLook } from './lookdev'

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

export class SculptedSurface {
  readonly water: THREE.Mesh
  readonly body: THREE.Mesh
  readonly foundation: THREE.Mesh
  readonly waterMaterial = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.12, metalness: 0, ior: 1.333, transmission: 0.96, thickness: 0.38, clearcoat: 0.1, clearcoatRoughness: 0.16, envMapIntensity: 0.7, side: THREE.FrontSide })
  readonly floorMaterial = new THREE.MeshPhysicalMaterial({ roughness: 0.3, clearcoat: 0.5, clearcoatRoughness: 0.25, envMapIntensity: 0.55 })
  readonly sideMaterial = new THREE.MeshPhysicalMaterial({ roughness: 0.4, clearcoat: 0.24, envMapIntensity: 0.4 })
  readonly baseMaterial = new THREE.MeshPhysicalMaterial({ roughness: 0.4, clearcoat: 0.25, envMapIntensity: 0.4 })
  private readonly waterDepth = new THREE.MeshDepthMaterial({ colorWrite: false, depthWrite: false })
  readonly uniforms: Record<string, THREE.IUniform>
  private geometry: THREE.BufferGeometry[] = []
  private readonly contactTexture: THREE.DataTexture

  constructor(layout: FluidLayout, surface: THREE.Texture, bounds: THREE.Vector4) {
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
        contact[y * size + x] = Math.min(contact[y * size + x], Math.round(255 * (1 - 0.27 * Math.exp(-distance / 0.12))))
      }
    }
    this.contactTexture = new THREE.DataTexture(contact, size, size, THREE.RedFormat)
    this.contactTexture.minFilter = this.contactTexture.magFilter = THREE.LinearFilter
    this.contactTexture.needsUpdate = true
    this.uniforms = {
      uLiquid: { value: surface }, uLiquidTime: { value: 0 }, uLiquidStyle: { value: 0.6 },
      uLiquidBounds: { value: bounds }, uLiquidLod: { value: 2.0 }, uStone: { value: 0 }, uContact: { value: this.contactTexture },
    }
    const common = `
      uniform sampler2D uLiquid;
      uniform float uLiquidTime;
      uniform float uLiquidStyle;
      uniform float uLiquidLod;
      uniform vec4 uLiquidBounds;
      varying vec2 vLiquidUv;
      varying vec2 vBodyPoint;
    `
    const fieldFunctions = `
      float liquidHeight(vec2 p) {
        vec4 f = texture2DLodEXT(uLiquid, p, uLiquidLod);
        vec2 world = uLiquidBounds.xy + p * uLiquidBounds.zw;
        float speed = smoothstep(0.02, 0.35, f.g / max(f.r, 0.01));
        float waves = sin(dot(world, vec2(3.4, 5.7)) - uLiquidTime * 3.0) * 0.013
          + sin(dot(world, vec2(-7.1, 3.2)) - uLiquidTime * 4.5) * 0.006;
        return 0.024 + f.b * (0.15 + waves * speed * uLiquidStyle);
      }
    `.replaceAll('texture2DLodEXT', 'textureLod')
    this.waterMaterial.onBeforeCompile = shader => {
      Object.assign(shader.uniforms, this.uniforms)
      shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>\n${common}\n${fieldFunctions}`)
        .replace('#include <beginnormal_vertex>', `
          #include <beginnormal_vertex>
          vec2 liquidUv = uv;
          vec2 du = vec2(0.032) / uLiquidBounds.zw;
          float gx = (liquidHeight(liquidUv + vec2(du.x, 0.0)) - liquidHeight(liquidUv - vec2(du.x, 0.0))) / 0.064;
          float gy = (liquidHeight(liquidUv + vec2(0.0, du.y)) - liquidHeight(liquidUv - vec2(0.0, du.y))) / 0.064;
          objectNormal = normalize(vec3(clamp(vec2(-gx, -gy), vec2(-0.7), vec2(0.7)), 1.0));
        `).replace('#include <begin_vertex>', `
          #include <begin_vertex>
          transformed.z = liquidHeight(uv);
          vLiquidUv = uv; vBodyPoint = position.xy;
        `)
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\n${common}`)
        .replace('#include <alphatest_fragment>', `
          #include <alphatest_fragment>
          float density = texture2D(uLiquid, vLiquidUv).r;
          if (density < 0.105) discard;
        `)
        .replace('#include <normal_fragment_maps>', `
          #include <normal_fragment_maps>
          vec4 flow = texture2D(uLiquid, vLiquidUv);
          float motion = smoothstep(0.025, 0.35, flow.g / max(flow.r, 0.01));
          vec2 p = uLiquidBounds.xy + vLiquidUv * uLiquidBounds.zw;
          vec2 micro = vec2(cos(dot(p, vec2(12.3, 7.1)) - uLiquidTime * 5.0), sin(dot(p, vec2(-9.2, 16.3)) - uLiquidTime * 6.2));
          vec3 worldRipple = vec3(micro * motion * uLiquidStyle * 0.10, 0.0);
          normal = normalize(normal + mat3(viewMatrix) * worldRipple);
        `)
    }
    this.waterMaterial.customProgramCacheKey = () => 'atelier-physical-liquid-v1'
    this.floorMaterial.onBeforeCompile = shader => {
      Object.assign(shader.uniforms, this.uniforms)
      shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>\n${common}`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>\nvBodyPoint = position.xy; vLiquidUv = (position.xy - uLiquidBounds.xy) / uLiquidBounds.zw;`)
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\n${common}\nuniform float uStone;\nuniform sampler2D uContact;`)
        .replace('#include <color_fragment>', `
          #include <color_fragment>
          float grain = fract(sin(dot(floor(vBodyPoint * 160.0), vec2(12.9898, 78.233))) * 43758.5453);
          float vein = sin(vBodyPoint.y * 15.0 + sin(vBodyPoint.x * 2.3) * 0.8);
          diffuseColor.rgb *= 0.985 + grain * 0.025 + vein * uStone * 0.025;
          diffuseColor.rgb *= texture2D(uContact, vLiquidUv).r;
        `)
        .replace('#include <emissivemap_fragment>', `
          #include <emissivemap_fragment>
          vec4 liquid = texture2D(uLiquid, vLiquidUv);
          float wet = smoothstep(0.12, 0.32, liquid.r);
          float motion = smoothstep(0.03, 0.30, liquid.g / max(liquid.r, 0.01));
          vec2 p = vBodyPoint * 5.5;
          float t = uLiquidTime * 0.6 * motion;
          float caustic = pow(max(0.0, 1.0 - abs(sin(p.x + sin(p.y + t)) + sin(p.y * 1.24 - t)) * 1.6), 5.0);
          totalEmissiveRadiance += vec3(0.65, 0.85, 0.72) * caustic * wet;
        `)
    }
    this.floorMaterial.customProgramCacheKey = () => 'atelier-ceramic-floor-v1'
    const width = bounds.z, height = bounds.w
    const waterGeometry = new THREE.PlaneGeometry(width, height, Math.min(256, Math.max(64, Math.ceil(width * 12))), Math.min(256, Math.max(64, Math.ceil(height * 12))))
    this.water = new THREE.Mesh(waterGeometry, this.waterMaterial)
    this.water.position.set(bounds.x + width / 2, bounds.y + height / 2, 0)
    this.water.name = 'physical-displaced-water'
    this.water.frustumCulled = false
    this.water.receiveShadow = true
    // VSM also draws receivers into its depth pass. Clear liquid transmits
    // light, and its unclipped carrier plane must never cast a solid shadow.
    this.water.customDepthMaterial = this.waterDepth
    const shapes = mazeBodyShapes(layout)
    const bodyGeometry = new THREE.ExtrudeGeometry(shapes, { depth: 0.32, bevelEnabled: true, bevelSize: 0.09, bevelThickness: 0.055, bevelSegments: 3, steps: 1, curveSegments: 2 })
    bodyGeometry.translate(0, 0, -0.375)
    this.body = new THREE.Mesh(bodyGeometry, [this.floorMaterial, this.sideMaterial])
    this.body.name = 'sculpted-maze-body'; this.body.castShadow = true; this.body.receiveShadow = true
    const baseGeometry = new THREE.ExtrudeGeometry(shapes, { depth: 0.12, bevelEnabled: true, bevelSize: 0.15, bevelThickness: 0.065, bevelSegments: 3, steps: 1, curveSegments: 2 })
    baseGeometry.translate(0, 0, -0.57)
    this.foundation = new THREE.Mesh(baseGeometry, this.baseMaterial)
    this.foundation.name = 'stepped-ceramic-foundation'; this.foundation.castShadow = true; this.foundation.receiveShadow = true
    this.geometry.push(waterGeometry, bodyGeometry, baseGeometry)
  }

  setLook(look: WaterLook) {
    const p = getWaterTheme(look.theme)
    this.floorMaterial.color.set(p.floor); this.floorMaterial.roughness = Math.max(0.16, p.roughness)
    this.sideMaterial.color.set(p.wall); this.baseMaterial.color.set(p.slab)
    this.uniforms.uStone.value = look.theme === 'terrace' || look.theme === 'basalt' ? 1 : 0
  }
  setAppearance(appearance: WaterAppearance) {
    const tint = new THREE.Color(appearance.color ?? '#dceef0')
    this.waterMaterial.color.copy(tint).lerp(new THREE.Color('#ffffff'), appearance.color ? 0.65 : 0.98)
    if (appearance.color) {
      this.waterMaterial.attenuationColor.copy(tint).lerp(new THREE.Color('#ffffff'), 0.12)
      this.waterMaterial.attenuationDistance = Math.max(0.18, (1 - appearance.opacity) * 1.4)
    } else {
      // Neutral shallow absorption makes clear water legible on pale ceramic
      // while preserving the floor's hue and physical transmission.
      this.waterMaterial.color.set('#ffffff')
      this.waterMaterial.attenuationColor.set('#868686')
      this.waterMaterial.attenuationDistance = 0.55 + (1 - appearance.opacity) * 3
    }
    this.waterMaterial.thickness = 0.18 + appearance.opacity * 0.3
  }
  update(time: number, style: number) {
    this.uniforms.uLiquidTime.value = time; this.uniforms.uLiquidStyle.value = style
    const image = this.uniforms.uLiquid.value.image
    const bounds = this.uniforms.uLiquidBounds.value as THREE.Vector4
    // One mip-filtered height lookup replaces five neighbouring samples. The
    // world-space smoothing radius stays constant as the canvas is resized.
    this.uniforms.uLiquidLod.value = Math.max(1, Math.log2(0.12 * Math.max(image.width / bounds.z, image.height / bounds.w)))
  }
  dispose() { this.contactTexture.dispose(); this.geometry.forEach(g => g.dispose()); [this.waterDepth, this.waterMaterial, this.floorMaterial, this.sideMaterial, this.baseMaterial].forEach(m => m.dispose()) }
}
