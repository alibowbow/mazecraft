import '../rendering/waterShaderEnhancer'
import * as THREE from 'three'
import { WaterFlowPhase } from './flowPhase'
import { WATER_ATLAS_COORDINATES } from '../rendering/waterSurfaceMath'
import type { DynamicStateTextureBuffer } from '../rendering/dynamicStateTexture'
import {
  parseBlenderWaterManifest,
  resolveBlenderWaterManifestUrl,
  type BlenderWaterAtlasManifest,
} from './manifest'

const INSTALL_FLAG = '__mazeCraftBlenderBakedWaterInstalled__' as const
const VERTEX_MARKER = '// MAZECRAFT_BLENDER_BAKED_WATER_VERTEX'
const FRAGMENT_MARKER = '// MAZECRAFT_BLENDER_BAKED_WATER_FRAGMENT'
const BASE_VERTEX_MARKER = '// MAZECRAFT_WATER_SURFACE_DYNAMICS_VERTEX'
const BASE_FRAGMENT_MARKER = '// MAZECRAFT_WATER_SURFACE_DYNAMICS_FRAGMENT'

export type BlenderWaterRuntimeStatus =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'fallback'

interface AtlasResult {
  readonly texture: THREE.Texture
  readonly manifest: BlenderWaterAtlasManifest
}

interface AtlasBinding {
  readonly material: THREE.ShaderMaterial
  readonly phase: WaterFlowPhase
  readonly phaseTexture: THREE.DataTexture
  readonly uniforms: {
    readonly uBlenderWaterPhase: { value: THREE.Texture }
    readonly uBlenderWaterAtlas: { value: THREE.Texture }
    readonly uBlenderWaterEnabled: { value: number }
    readonly uBlenderWaterFrames: { value: number }
    readonly uBlenderWaterRows: { value: number }
    readonly uBlenderWaterTexelSize: { value: THREE.Vector2 }
    readonly uBlenderWaterHeightStrength: { value: number }
    readonly uBlenderWaterNormalStrength: { value: number }
    readonly uBlenderWaterFoamStrength: { value: number }
  }
}

const neutralAtlas = new THREE.DataTexture(
  new Uint8Array([128, 128, 128, 0]),
  1,
  1,
  THREE.RGBAFormat,
  THREE.UnsignedByteType,
)
neutralAtlas.name = 'blender-water-neutral-atlas'
neutralAtlas.colorSpace = THREE.NoColorSpace
neutralAtlas.minFilter = THREE.NearestFilter
neutralAtlas.magFilter = THREE.NearestFilter
neutralAtlas.generateMipmaps = false
neutralAtlas.needsUpdate = true

let atlasPromise: Promise<AtlasResult | null> | null = null
let loadedAtlas: AtlasResult | null = null
let runtimeStatus: BlenderWaterRuntimeStatus = 'idle'
const activeBindings = new Set<AtlasBinding>()
const bindingByMaterial = new WeakMap<THREE.ShaderMaterial, AtlasBinding>()

const setRuntimeStatus = (status: BlenderWaterRuntimeStatus): void => {
  runtimeStatus = status
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.blenderWaterAtlas = status
  }
}

export function getBlenderWaterRuntimeStatus(): BlenderWaterRuntimeStatus {
  return runtimeStatus
}

const configureAtlasTexture = (texture: THREE.Texture): void => {
  texture.name = 'blender-water-runtime-atlas'
  texture.colorSpace = THREE.NoColorSpace
  texture.wrapS = THREE.ClampToEdgeWrapping
  texture.wrapT = THREE.ClampToEdgeWrapping
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.generateMipmaps = false
  texture.needsUpdate = true
}

const applyAtlasToBinding = (
  binding: AtlasBinding,
  atlas: AtlasResult,
): void => {
  const { manifest, texture } = atlas
  binding.uniforms.uBlenderWaterAtlas.value = texture
  binding.uniforms.uBlenderWaterEnabled.value = 1
  binding.uniforms.uBlenderWaterFrames.value = manifest.atlas.frames
  binding.uniforms.uBlenderWaterRows.value = manifest.atlas.rows
  binding.uniforms.uBlenderWaterTexelSize.value.set(
    1 / manifest.atlas.width,
    1 / manifest.atlas.height,
  )
  binding.uniforms.uBlenderWaterHeightStrength.value =
    manifest.runtime.heightStrength
  binding.uniforms.uBlenderWaterNormalStrength.value =
    manifest.runtime.normalStrength
  binding.uniforms.uBlenderWaterFoamStrength.value =
    manifest.runtime.foamStrength
  binding.material.userData.blenderWaterAtlas = 'ready'
}

const loadAtlas = (): Promise<AtlasResult | null> => {
  if (atlasPromise) return atlasPromise
  setRuntimeStatus('loading')
  atlasPromise = (async () => {
    try {
      const manifestUrl = resolveBlenderWaterManifestUrl()
      const response = await fetch(manifestUrl, { cache: 'force-cache' })
      if (!response.ok) {
        throw new Error(`Blender water manifest returned ${response.status}.`)
      }
      const manifest = parseBlenderWaterManifest(await response.json())
      const atlasUrl = new URL(manifest.atlas.file, manifestUrl).toString()
      const texture = await new THREE.TextureLoader().loadAsync(atlasUrl)
      configureAtlasTexture(texture)
      const result = Object.freeze({ texture, manifest })
      loadedAtlas = result
      for (const binding of activeBindings) {
        applyAtlasToBinding(binding, result)
      }
      setRuntimeStatus('ready')
      return result
    } catch {
      setRuntimeStatus('fallback')
      for (const binding of activeBindings) {
        binding.uniforms.uBlenderWaterEnabled.value = 0
        binding.material.userData.blenderWaterAtlas = 'fallback'
      }
      return null
    }
  })()
  return atlasPromise
}

function createBinding(material: THREE.ShaderMaterial): AtlasBinding {
  const existing = bindingByMaterial.get(material)
  if (existing) return existing
  const size = material.uniforms.uBoardSize.value as THREE.Vector2
  const phase = new WaterFlowPhase(size.x, size.y)
  const phaseTexture = new THREE.DataTexture(
    phase.data, size.x, size.y, THREE.RGBAFormat, THREE.FloatType,
  )
  phaseTexture.minFilter = THREE.NearestFilter
  phaseTexture.magFilter = THREE.NearestFilter
  phaseTexture.generateMipmaps = false
  phaseTexture.needsUpdate = true
  const binding: AtlasBinding = {
    material,
    phase,
    phaseTexture,
    uniforms: {
      uBlenderWaterPhase: { value: phaseTexture },
      uBlenderWaterAtlas: { value: neutralAtlas },
      uBlenderWaterEnabled: { value: 0 },
      uBlenderWaterFrames: { value: 1 },
      uBlenderWaterRows: { value: 8 },
      uBlenderWaterTexelSize: { value: new THREE.Vector2(1, 1) },
      uBlenderWaterHeightStrength: { value: 0.038 },
      uBlenderWaterNormalStrength: { value: 0.34 },
      uBlenderWaterFoamStrength: { value: 0.86 },
    },
  }
  bindingByMaterial.set(material, binding)
  activeBindings.add(binding)
  material.userData.blenderWaterAtlas = 'loading'
  material.addEventListener('dispose', () => {
    activeBindings.delete(binding)
    phaseTexture.dispose()
  })
  if (loadedAtlas) applyAtlasToBinding(binding, loadedAtlas)
  else void loadAtlas()
  return binding
}

/** Called only when the interpolated hydraulic snapshot advances. */
export function updateBlenderWaterFlow(
  material: THREE.ShaderMaterial,
  state: DynamicStateTextureBuffer,
): void {
  const binding = createBinding(material)
  binding.phase.update(state.data, state.stats.simulationTime)
  binding.phaseTexture.needsUpdate = true
}

export function resetBlenderWaterFlow(material: THREE.ShaderMaterial): void {
  const binding = bindingByMaterial.get(material)
  if (!binding) return
  binding.phase.reset()
  binding.phaseTexture.needsUpdate = true
}

const replaceRequired = (
  source: string,
  search: string,
  replacement: string,
): string | null => {
  if (!source.includes(search)) return null
  return source.replace(search, replacement)
}

const BLENDER_WATER_UNIFORMS = /* glsl */ `
  uniform sampler2D uBlenderWaterAtlas;
  uniform sampler2D uBlenderWaterPhase;
  uniform float uBlenderWaterEnabled;
  uniform float uBlenderWaterFrames;
  uniform float uBlenderWaterRows;
  uniform vec2 uBlenderWaterTexelSize;
  uniform float uBlenderWaterHeightStrength;
  uniform float uBlenderWaterNormalStrength;
  uniform float uBlenderWaterFoamStrength;
`

const BLENDER_WATER_SAMPLING = /* glsl */ `
  float blenderPortalOpen(vec2 cell, vec2 direction) {
    vec2 center = (cell + 0.5) / uBoardSize;
    vec2 portal = center + direction * 0.49 / uBoardSize;
    return step(0.5, texture2D(uTopology, portal).r);
  }

  vec2 blenderTileAndOrientation(vec2 sampleUv) {
    vec2 cell = clamp(
      floor(clamp(sampleUv, vec2(0.0), vec2(0.999999)) * uBoardSize),
      vec2(0.0),
      uBoardSize - 1.0
    );
    vec2 center = (cell + 0.5) / uBoardSize;
    vec4 topology = texture2D(uTopology, center);
    float top = blenderPortalOpen(cell, vec2(0.0, 1.0));
    float right = blenderPortalOpen(cell, vec2(1.0, 0.0));
    float bottom = blenderPortalOpen(cell, vec2(0.0, -1.0));
    float left = blenderPortalOpen(cell, vec2(-1.0, 0.0));
    float count = top + right + bottom + left;
    float row = 7.0;
    float orientation = 0.0;

    if (topology.g > 0.5) {
      row = 5.0;
      orientation = 0.0;
    } else if (topology.b > 0.5) {
      row = 6.0;
      orientation = 0.0;
    } else if (count > 3.5) {
      row = 3.0;
    } else if (count > 2.5) {
      row = 2.0;
      if (bottom < 0.5) orientation = 0.0;
      else if (left < 0.5) orientation = 1.0;
      else if (top < 0.5) orientation = 2.0;
      else orientation = 3.0;
    } else if (count > 1.5) {
      float vertical = top * bottom;
      float horizontal = left * right;
      if (vertical + horizontal > 0.5) {
        row = 0.0;
        orientation = horizontal > 0.5 ? 1.0 : 0.0;
      } else {
        row = 1.0;
        if (top > 0.5 && right > 0.5) orientation = 0.0;
        else if (right > 0.5 && bottom > 0.5) orientation = 1.0;
        else if (bottom > 0.5 && left > 0.5) orientation = 2.0;
        else orientation = 3.0;
      }
    } else if (count > 0.5) {
      row = 4.0;
      if (top > 0.5) orientation = 0.0;
      else if (right > 0.5) orientation = 1.0;
      else if (bottom > 0.5) orientation = 2.0;
      else orientation = 3.0;
    }
    return vec2(row, orientation);
  }

${WATER_ATLAS_COORDINATES}
  vec4 blenderAtlasFrame(vec2 localUv, float row, float frame) {
    vec2 inset = vec2(
      uBlenderWaterTexelSize.x * uBlenderWaterFrames * 1.25,
      uBlenderWaterTexelSize.y * uBlenderWaterRows * 1.25
    );
    vec2 safeUv = clamp(localUv, inset, vec2(1.0) - inset);
    return texture2D(
      uBlenderWaterAtlas,
      vec2(
        (frame + safeUv.x) / uBlenderWaterFrames,
        (row + safeUv.y) / uBlenderWaterRows
      )
    );
  }

  vec4 sampleBlenderWater(vec2 sampleUv) {
    vec2 cellPosition =
      clamp(sampleUv, vec2(0.0), vec2(0.999999)) * uBoardSize;
    vec2 cell = floor(cellPosition);
    vec2 tile = blenderTileAndOrientation(sampleUv);
    vec2 localUv = blenderRotateToCanonical(fract(cellPosition), tile.y);
    float seed = fract(dot(cell, vec2(0.754877666, 0.569840296)));
    vec3 travel = texture2D(
      uBlenderWaterPhase, (cell + 0.5) / uBoardSize
    ).rgb;
    float cycles = blenderTravelCycles(travel, tile);
    float framePosition = fract(cycles + seed) * uBlenderWaterFrames;
    float frame0 = floor(framePosition);
    float frame1 = mod(frame0 + 1.0, uBlenderWaterFrames);
    float blend = fract(framePosition);
    vec4 surface = mix(
      blenderAtlasFrame(localUv, tile.x, frame0),
      blenderAtlasFrame(localUv, tile.x, frame1),
      blend
    );
    surface.rg = blenderNormalToWorld(surface.rg * 2.0 - 1.0, tile.y) * 0.5 + 0.5;
    // Fade sub-cell detail at shared borders; independently phased cells must
    // agree on zero displacement there. Macro hydraulic surface stays intact.
    vec2 edgeDistance = min(localUv, vec2(1.0) - localUv);
    float edgeGate = smoothstep(0.0, 0.12, min(edgeDistance.x, edgeDistance.y));
    return mix(vec4(0.5, 0.5, 0.5, 0.0), surface, edgeGate);
  }
`

/** Adds Blender-baked local height displacement to the enhanced water mesh. */
export function enhanceBlenderWaterVertexShader(source: string): string {
  if (source.includes(VERTEX_MARKER)) return source
  let next = replaceRequired(
    source,
    `  ${BASE_VERTEX_MARKER}\n`,
    `  ${BASE_VERTEX_MARKER}\n  ${VERTEX_MARKER}\n${BLENDER_WATER_UNIFORMS}`,
  )
  if (!next) return source
  next = replaceRequired(
    next,
    '  float finiteDepthPhaseScale(float waveNumberPerCell, float normalizedDepth) {\n',
    `${BLENDER_WATER_SAMPLING}\n  float finiteDepthPhaseScale(float waveNumberPerCell, float normalizedDepth) {\n`,
  )
  if (!next) return source
  next = replaceRequired(
    next,
    '    vec3 transformed = position;\n',
    `    vec4 blenderSurface = sampleBlenderWater(uv);
    float blenderSurfaceGate =
      uBlenderWaterEnabled *
      smoothstep(0.0015, 0.055, depth) *
      motion;
    vec3 transformed = position;
`,
  )
  if (!next) return source
  return (
    replaceRequired(
      next,
      '    vUv = uv;\n',
      `    transformed.z += mask *
      (blenderSurface.b * 2.0 - 1.0) *
      uBlenderWaterHeightStrength * blenderSurfaceGate;
    vUv = uv;
`,
    ) ?? source
  )
}

/** Adds baked normals, foam and caustic energy to the enhanced fragment shader. */
export function enhanceBlenderWaterFragmentShader(source: string): string {
  if (source.includes(FRAGMENT_MARKER)) return source
  let next = replaceRequired(
    source,
    `  ${BASE_FRAGMENT_MARKER}\n`,
    `  ${BASE_FRAGMENT_MARKER}\n  ${FRAGMENT_MARKER}\n${BLENDER_WATER_UNIFORMS}`,
  )
  if (!next) return source
  next = replaceRequired(
    next,
    '  void main() {\n',
    `${BLENDER_WATER_SAMPLING}\n  void main() {\n`,
  )
  if (!next) return source
  next = replaceRequired(
    next,
    '    float motion = smoothstep(0.002, 0.12, speed);\n',
    `    float motion = smoothstep(0.002, 0.12, speed);
    vec4 blenderSurface = sampleBlenderWater(vUv);
    float blenderSurfaceGate =
      uBlenderWaterEnabled *
      smoothstep(0.0015, 0.055, depth) *
      motion;
`,
  )
  if (!next) return source
  next = replaceRequired(
    next,
    `    vec2 simulatedSlope = waterWorldSlope(
      dFdx(vWorldPosition.xy), dFdy(vWorldPosition.xy),
      dFdx(simulatedHeight), dFdy(simulatedHeight)
    ) * 0.04;`,
    `    vec2 simulatedSlope = waterWorldSlope(
      dFdx(vWorldPosition.xy), dFdy(vWorldPosition.xy),
      dFdx(simulatedHeight), dFdy(simulatedHeight)
    ) * 0.04;
    simulatedSlope -=
      (blenderSurface.rg * 2.0 - 1.0) *
      uBlenderWaterNormalStrength * blenderSurfaceGate;`,
  )
  if (!next) return source
  next = replaceRequired(
    next,
    '    bodyColor += vec3(0.12, 0.72, 0.61) * caustic * 0.12;\n',
    `    bodyColor += vec3(0.12, 0.72, 0.61) * caustic * 0.12;
    float blenderCaustic =
      smoothstep(0.045, 0.42, length(blenderSurface.rg - 0.5)) *
      (1.0 - smoothstep(0.45, 0.95, depth)) * blenderSurfaceGate;
    bodyColor += vec3(0.08, 0.58, 0.5) * blenderCaustic * 0.16;
`,
  )
  if (!next) return source
  return (
    replaceRequired(
      next,
      `    float bubbleStructure = mix(
      0.7,
      1.1,
      detailA.b * detailB.a * mix(0.72, 1.0, turbulence)
    );`,
      `    foam = max(
      foam,
      blenderSurface.a *
        uBlenderWaterFoamStrength * blenderSurfaceGate
    );
    float bubbleStructure = mix(
      0.7,
      1.1,
      detailA.b * detailB.a * mix(0.72, 1.0, turbulence)
    );`,
    ) ?? source
  )
}

function isMazeWaterSurface(material: THREE.ShaderMaterial): boolean {
  const uniforms = material.uniforms
  return Boolean(
    uniforms.uTopology &&
      uniforms.uDynamicState &&
      uniforms.uFoamHistory &&
      uniforms.uWaveTime &&
      uniforms.uFlowGate,
  )
}

/** Chains after the hydraulic shader enhancer and adds the Blender atlas layer. */
export function installBlenderBakedWater(): void {
  type ShaderMaterialPrototype = typeof THREE.ShaderMaterial.prototype & {
    [INSTALL_FLAG]?: boolean
  }
  const prototype = THREE.ShaderMaterial.prototype as ShaderMaterialPrototype
  if (prototype[INSTALL_FLAG]) return
  prototype[INSTALL_FLAG] = true
  const original = prototype.onBeforeCompile
  type CompileParameters = Parameters<
    THREE.ShaderMaterial['onBeforeCompile']
  >

  prototype.onBeforeCompile = function (
    this: THREE.ShaderMaterial,
    shader: CompileParameters[0],
    renderer: CompileParameters[1],
  ): void {
    original.call(this, shader, renderer)
    if (!isMazeWaterSurface(this)) return
    const binding = createBinding(this)
    Object.assign(shader.uniforms, binding.uniforms)
    shader.vertexShader = enhanceBlenderWaterVertexShader(shader.vertexShader)
    shader.fragmentShader = enhanceBlenderWaterFragmentShader(
      shader.fragmentShader,
    )
  }
}

installBlenderBakedWater()
