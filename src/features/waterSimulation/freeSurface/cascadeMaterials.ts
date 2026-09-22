import * as THREE from 'three'
import type { WaterAppearance } from './appearance'
import type { CascadeState } from './cascadeTypes'

export interface CascadeMaterials {
  porcelain: THREE.MeshPhysicalMaterial
  water: THREE.MeshPhysicalMaterial
  floors: [THREE.MeshPhysicalMaterial, THREE.MeshPhysicalMaterial, THREE.MeshPhysicalMaterial]
  environment: THREE.WebGLRenderTarget
  update(state: CascadeState, style: number): void
  setAppearance(appearance: WaterAppearance): void
  dispose(): void
}

/** Two different, seamless wave spectra avoid a repeated cross-wave lattice. */
function waveTexture(seed: number): THREE.DataTexture {
  const size = 256, height = new Float32Array(size * size), pixels = new Uint8Array(size * size * 4)
  const fract = (value: number) => value - Math.floor(value)
  const random = (value: number) => fract(Math.sin(value * 127.1 + seed * 31.7) * 43758.5453)
  const waves = Array.from({ length: 11 }, (_, i) => ({
    x: Math.round(random(i + 1) * 13) - 6,
    y: Math.round(random(i + 17) * 13) - 6,
    phase: random(i + 29) * Math.PI * 2,
    weight: 0.6 + random(i + 41) * 0.4,
  }))
  const tau = Math.PI * 2
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size, v = y / size
    const a = u + Math.sin(v * tau + seed) * 0.043 + Math.sin(u * tau * 2 - v * tau) * 0.018
    const b = v + Math.sin(u * tau + seed * 0.7) * 0.054
    let value = 0
    for (const wave of waves) value += Math.sin((a * wave.x + b * wave.y) * tau + wave.phase) * wave.weight / Math.max(2, Math.hypot(wave.x, wave.y))
    height[y * size + x] = value
  }
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = (height[y * size + (x + 1) % size] - height[y * size + (x + size - 1) % size]) * 3.8
    const dy = (height[((y + 1) % size) * size + x] - height[((y + size - 1) % size) * size + x]) * 3.8
    const length = Math.hypot(dx, dy, 1), index = (y * size + x) * 4
    pixels[index] = Math.round((0.5 - dx / length * 0.5) * 255)
    pixels[index + 1] = Math.round((0.5 - dy / length * 0.5) * 255)
    pixels[index + 2] = Math.round((0.5 + 0.5 / length) * 255)
    pixels[index + 3] = 255
  }
  const texture = new THREE.DataTexture(pixels, size, size, THREE.RGBAFormat)
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping
  texture.minFilter = THREE.LinearMipmapLinearFilter; texture.magFilter = THREE.LinearFilter
  texture.generateMipmaps = true; texture.anisotropy = 4; texture.needsUpdate = true
  texture.name = `cascade-wave-normal-${seed}`
  return texture
}

/** Refracted-ray density gives irregular caustics instead of a bright grid. */
function causticTexture(normal: THREE.DataTexture): THREE.DataTexture {
  const size = 256, energy = new Float32Array(size * size)
  const source = normal.image.data as Uint8Array
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const index = (y * size + x) * 4
    const tx = x - (source[index] / 255 * 2 - 1) * 23
    const ty = y - (source[index + 1] / 255 * 2 - 1) * 23
    const ix = Math.floor(tx), iy = Math.floor(ty), fx = tx - ix, fy = ty - iy
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const cell = ((iy + dy + size) % size) * size + (ix + dx + size) % size
      energy[cell] += (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy)
    }
  }
  const data = Uint8Array.from(energy, value => Math.round(Math.min(1, Math.max(0, value - 0.7) / 3.5) * 255))
  const texture = new THREE.DataTexture(data, size, size, THREE.RedFormat)
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping
  texture.minFilter = THREE.LinearMipmapLinearFilter; texture.magFilter = THREE.LinearFilter
  texture.generateMipmaps = true; texture.needsUpdate = true
  texture.name = 'cascade-refracted-light-density'
  return texture
}

/** Linear floating-point studio HDRI, including radiance well above display white. */
export function studioHdri(renderer: THREE.WebGLRenderer): THREE.WebGLRenderTarget {
  const width = 512, height = 256, pixels = new Float32Array(width * height * 4)
  const panels = [
    // One dominant window at the daylight key. Narrow hot edges read as glaze
    // highlights; the wider, lower-energy center provides soft studio fill.
    { direction: [-0.72, 0.30, 1.35], width: 0.30, height: 0.48, gaussian: true, radiance: [6, 5.6, 5.0] },
    { direction: [-0.91, 0.27, 0.78], width: 0.055, height: 0.60, fade: 0.45, verticalFade: 0.30, radiance: [30, 27, 23] },
    { direction: [-0.70, -0.36, 0.42], width: 0.065, height: 0.42, fade: 0.45, verticalFade: 0.25, radiance: [18, 16, 14] },
    // Overhead diffusion strip is reflected by the shallow glazed wall crowns.
    // Its narrow width leaves the oblique pool reflection direction clear.
    { direction: [0.15, 0.24, 1.0], width: 0.08, height: 0.42, gaussian: true, radiance: [8, 7.6, 7.0] },
    { direction: [-0.48, 0.61, 1.0], width: 0.075, height: 0.30, gaussian: true, radiance: [14, 13, 11] },
    { direction: [0.75, -0.3, 0.55], width: 0.28, height: 0.50, gaussian: true, radiance: [0.9, 1.1, 1.3] },
  ].map(panel => {
    const direction = new THREE.Vector3(...panel.direction).normalize()
    const right = new THREE.Vector3().crossVectors(direction, new THREE.Vector3(0, 0, 1)).normalize()
    return { ...panel, direction, right, up: new THREE.Vector3().crossVectors(right, direction).normalize() }
  })
  const direction = new THREE.Vector3()
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const latitude = ((y + 0.5) / height - 0.5) * Math.PI
    const longitude = ((x + 0.5) / width - 0.5) * Math.PI * 2
    direction.set(Math.cos(latitude) * Math.cos(longitude), Math.sin(latitude), Math.cos(latitude) * Math.sin(longitude))
    const sky = THREE.MathUtils.smoothstep(direction.z, -0.12, 0.7)
    const index = (y * width + x) * 4
    // Open daylight and white courtyard walls illuminate the entire glaze,
    // including faces that do not happen to reflect a studio panel.
    pixels[index] = 0.17 + sky * 0.17
    pixels[index + 1] = 0.18 + sky * 0.18
    pixels[index + 2] = 0.20 + sky * 0.19
    for (const panel of panels) {
      const facing = direction.dot(panel.direction)
      if (facing <= 0) continue
      const a = Math.abs(direction.dot(panel.right) / facing), b = Math.abs(direction.dot(panel.up) / facing)
      const u = a / panel.width, v = b / panel.height
      // Smoothly truncate the Gaussian before the panel boundary. There is no
      // constant-brightness center for wave normals to reveal as flat spots.
      const weight = panel.gaussian
        ? Math.exp(-3.2 * u * u - 0.45 * v * v)
          * (1 - THREE.MathUtils.smoothstep(u, 0.78, 1))
          * (1 - THREE.MathUtils.smoothstep(v, 0.70, 1))
        : (1 - THREE.MathUtils.smoothstep(u, 1 - (panel.fade ?? 0.14), 1))
          * (1 - THREE.MathUtils.smoothstep(v, 1 - (panel.verticalFade ?? 0.06), 1))
      for (let channel = 0; channel < 3; channel++) pixels[index + channel] += panel.radiance[channel] * weight
    }
    pixels[index + 3] = 1
  }
  const hdr = new THREE.DataTexture(pixels, width, height, THREE.RGBAFormat, THREE.FloatType)
  hdr.colorSpace = THREE.LinearSRGBColorSpace
  hdr.mapping = THREE.EquirectangularReflectionMapping
  hdr.minFilter = hdr.magFilter = THREE.LinearFilter
  hdr.needsUpdate = true; hdr.name = 'cascade-studio-linear-hdri'
  const generator = new THREE.PMREMGenerator(renderer)
  const environment = generator.fromEquirectangular(hdr)
  generator.dispose(); hdr.dispose()
  environment.texture.name = 'cascade-studio-hdri-pmrem'
  return environment
}

export function createCascadeMaterials(renderer: THREE.WebGLRenderer): CascadeMaterials {
  const normalA = waveTexture(17), normalB = waveTexture(63), caustic = causticTexture(normalA)
  const environment = studioHdri(renderer)
  const time = { value: 0 }, strength = { value: 1 }
  // An explicit map preserves each material's intensity. Three substitutes
  // scene.environmentIntensity when a Standard/Physical material's map is null.
  const porcelain = new THREE.MeshPhysicalMaterial({ color: 0xf7f5f0, clearcoat: 1, clearcoatRoughness: 0.1, roughness: 0.15, metalness: 0, envMap: environment.texture, envMapIntensity: 1.15, shadowSide: THREE.BackSide })
  const water = new THREE.MeshPhysicalMaterial({ color: 0x38b6d3, transmission: 0.92, transparent: true, ior: 1.333, roughness: 0.08, metalness: 0, thickness: 0.42, attenuationColor: 0xc4f2f7, attenuationDistance: 3.5, normalMap: normalA, normalScale: new THREE.Vector2(0.22, 0.22), envMap: environment.texture, envMapIntensity: 0.22, depthWrite: false })
  water.userData.cascadeNormalMaps = [normalA, normalB]
  const vertexPoint = `varying vec3 vCascadePoint;`
  const worldPoint = `vCascadePoint = (modelMatrix * vec4(transformed, 1.0)).xyz;`
  porcelain.onBeforeCompile = shader => {
    shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>\n${vertexPoint}`)
      .replace('#include <project_vertex>', `${worldPoint}\n#include <project_vertex>`)
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\n${vertexPoint}`)
      .replace('#include <clearcoat_normal_fragment_maps>', `
        #include <clearcoat_normal_fragment_maps>
        #ifdef USE_CLEARCOAT
          vec3 p = vCascadePoint;
          vec3 glazeSlope = vec3(cos(p.x * 7.1 + p.y * 2.3) * 0.026,
            cos(p.y * 6.3 - p.x * 1.7) * 0.021, sin(p.x * 4.2 + p.y * 5.1 + p.z * 3.0) * 0.026);
          clearcoatNormal = normalize(clearcoatNormal + mat3(viewMatrix) * glazeSlope);
        #endif
      `)
  }
  porcelain.customProgramCacheKey = () => 'cascade-cast-glaze-v1'
  water.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, { uCascadeTime: time, uCascadeStrength: strength, uCascadeNormalB: { value: normalB } })
    shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>\n${vertexPoint}`)
      .replace('#include <project_vertex>', `${worldPoint}\n#include <project_vertex>`)
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\n${vertexPoint}\nuniform float uCascadeTime;\nuniform float uCascadeStrength;\nuniform sampler2D uCascadeNormalB;`)
      .replace('#include <normal_fragment_maps>', `
        vec2 firstUv = vCascadePoint.xy * 0.47 + vec2(0.044, 0.017) * uCascadeTime;
        vec2 secondUv = mat2(0.80, 0.60, -0.60, 0.80) * vCascadePoint.xy * 0.63 - vec2(0.031, 0.039) * uCascadeTime;
        vec3 firstNormal = texture2D(normalMap, firstUv).xyz * 2.0 - 1.0;
        vec3 secondNormal = texture2D(uCascadeNormalB, secondUv).xyz * 2.0 - 1.0;
        vec2 waterSlope = (firstNormal.xy * 0.64 + secondNormal.xy * 0.36) * normalScale * uCascadeStrength;
        normal = normalize(normal + mat3(viewMatrix) * vec3(waterSlope, 0.0));
      `)
  }
  water.customProgramCacheKey = () => 'cascade-dual-normal-water-v1'
  const floorDepth = [{ value: 0.46 }, { value: 0.46 }, { value: 0.46 }]
  const floors = floorDepth.map((depth, index) => {
    const material = porcelain.clone()
    material.name = `cascade-caustic-floor-${index}`
    material.onBeforeCompile = shader => {
      Object.assign(shader.uniforms, { uCascadeTime: time, uCascadeDepth: depth, uCascadeCaustic: { value: caustic } })
      shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>\n${vertexPoint}`)
        .replace('#include <project_vertex>', `${worldPoint}\n#include <project_vertex>`)
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\n${vertexPoint}\nuniform float uCascadeTime;\nuniform float uCascadeDepth;\nuniform sampler2D uCascadeCaustic;`)
        .replace('#include <lights_fragment_end>', `
          #include <lights_fragment_end>
          vec2 p = vCascadePoint.xy * 0.38;
          vec2 causticWarp = vec2(sin(p.y * 3.1 + uCascadeTime * 0.43), sin(p.x * 2.7 - uCascadeTime * 0.37)) * 0.029;
          float a = texture2D(uCascadeCaustic, p + causticWarp + vec2(0.021, -0.017) * uCascadeTime).r;
          float b = texture2D(uCascadeCaustic, mat2(0.71, 0.71, -0.71, 0.71) * p * 1.31 - causticWarp - vec2(0.016, 0.024) * uCascadeTime).r;
          float wet = smoothstep(0.005, 0.08, uCascadeDepth);
          float focus = pow(a, 1.35) * 0.85 + pow(b, 1.8) * 0.32;
          reflectedLight.directDiffuse *= mix(1.0, 0.96 + focus * 1.1, wet);
        `)
    }
    material.customProgramCacheKey = () => 'cascade-refracted-caustic-floor-v1'
    return material
  }) as CascadeMaterials['floors']
  return {
    porcelain, water, floors, environment,
    update(state, style) {
      time.value = state.time
      strength.value = THREE.MathUtils.clamp(style, 0.45, 1.5)
      floorDepth.forEach((depth, index) => {
        depth.value = state.depths[index]
        // Submerged glaze meets water (n=1.333), not air. Keeping the dry
        // air/glaze Fresnel response underneath transmission doubles the white
        // window reflection and makes turquoise pools look milky.
        const wet = THREE.MathUtils.smoothstep(depth.value, 0.005, 0.04)
        floors[index].ior = THREE.MathUtils.lerp(1.5, 1.5 / 1.333, wet)
        floors[index].clearcoat = THREE.MathUtils.lerp(1, 0.08, wet)
      })
      water.thickness = Math.max(0.08, (state.depths[0] + state.depths[1] + state.depths[2]) / 3)
    },
    setAppearance(appearance) {
      const clear = appearance.profile === 'clear' || !appearance.color
      const opacity = THREE.MathUtils.clamp(Number.isFinite(appearance.opacity) ? appearance.opacity : 0.72, 0.1, 0.9)
      water.color.set(clear ? 0xffffff : appearance.profile === 'aqua' ? 0x38b6d3 : appearance.color!)
      water.attenuationColor.set(clear ? 0xf5fcff : 0xc4f2f7)
      water.attenuationDistance = clear ? 5 + (1 - opacity) * 8 : 1.8 + (1 - opacity) * 6
      // The required surface transmission remains physical for every dye.
      water.transmission = 0.92
    },
    dispose() {
      porcelain.dispose(); water.dispose(); floors.forEach(material => material.dispose())
      normalA.dispose(); normalB.dispose(); caustic.dispose(); environment.dispose()
    },
  }
}
