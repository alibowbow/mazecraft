import * as THREE from 'three'

/**
 * Post-processing for the water gardens, in the order a film camera would:
 * the scene is rendered once into a multisampled half-float (HDR) target,
 * then ambient occlusion is estimated from its depth, bright highlights
 * bloom through a mip chain, and one composite pass exposes, tone maps,
 * grades and dithers the image for the screen. There is no vignette: the
 * backdrop must meet the page colour at the canvas edge without a seam.
 *
 * Tiers trade cost for detail; the renderer steps down when frames run long.
 *   3: 4× MSAA, 16-sample AO, 5-level bloom
 *   2: 4× MSAA,  8-sample AO, 5-level bloom
 *   1: 2× MSAA, no AO,        4-level bloom
 *   0: post off (direct tone-mapped render)
 */
export type PostTier = 0 | 1 | 2 | 3

interface TierSpec { samples: number; ao: number; bloom: number }
const TIERS: Record<Exclude<PostTier, 0>, TierSpec> = {
  3: { samples: 4, ao: 16, bloom: 5 },
  2: { samples: 4, ao: 8, bloom: 5 },
  1: { samples: 2, ao: 0, bloom: 4 },
}

/** Look of the finished image. Neutral so glaze and water keep their hues. */
export const GRADE = {
  /** View-space AO radius (m) and strength. */
  aoRadius: 0.4,
  aoIntensity: 3.2,
  aoStrength: 0.8,
  /** Scene-referred threshold and soft knee of the bloom, and its mix. */
  bloomThreshold: 1.05,
  bloomKnee: 0.45,
  bloomStrength: 0.12,
  saturation: 1.06,
  contrast: 0.14,
  shadowTint: [0.975, 0.995, 1.03] as const,
  highlightTint: [1.02, 1.0, 0.975] as const,
}

const QUAD_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }`

const VIEW_GLSL = /* glsl */ `
  uniform sampler2D tDepth;
  uniform mat4 uProjectionInverse;
  vec3 viewAt(vec2 uv, float depth) {
    vec4 p = uProjectionInverse * vec4(vec3(uv, depth) * 2.0 - 1.0, 1.0);
    return p.xyz / p.w;
  }
  vec3 viewAt(vec2 uv) { return viewAt(uv, texture2D(tDepth, uv).r); }
  float interleavedNoise(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }`

/** Scalable ambient obscurance on a disk of view-space radius uRadius. */
const AO_FRAGMENT = /* glsl */ `
  ${VIEW_GLSL}
  uniform mat4 uProjection;
  uniform vec2 uDepthTexel;
  uniform float uRadius;
  uniform float uIntensity;
  uniform float uOrtho;
  varying vec2 vUv;
  void main() {
    float depth = texture2D(tDepth, vUv).r;
    if (depth >= 1.0) { gl_FragColor = vec4(1.0, 1e4, 0.0, 1.0); return; }
    vec3 p = viewAt(vUv, depth);
    // Normal from the flatter of the one-sided differences on each axis, so
    // silhouettes don't bend the normals of what lies in front of them.
    vec3 r = viewAt(vUv + vec2(uDepthTexel.x, 0.0)) - p, l = p - viewAt(vUv - vec2(uDepthTexel.x, 0.0));
    vec3 u = viewAt(vUv + vec2(0.0, uDepthTexel.y)) - p, d = p - viewAt(vUv - vec2(0.0, uDepthTexel.y));
    vec3 n = normalize(cross(abs(r.z) < abs(l.z) ? r : l, abs(u.z) < abs(d.z) ? u : d));
    float perspective = uOrtho > 0.5 ? 1.0 : 1.0 / max(1e-3, -p.z);
    vec2 reach = vec2(uProjection[0][0], uProjection[1][1]) * 0.5 * uRadius * perspective;
    float angle = interleavedNoise(gl_FragCoord.xy) * 6.2831853;
    float occlusion = 0.0;
    for (int i = 0; i < AO_SAMPLES; i++) {
      float f = (float(i) + 0.5) / float(AO_SAMPLES);
      float a = angle + float(i) * 2.3999632;
      vec3 v = viewAt(vUv + vec2(cos(a), sin(a)) * sqrt(f) * reach) - p;
      float vv = dot(v, v);
      float falloff = max(0.0, 1.0 - vv / (uRadius * uRadius));
      occlusion += falloff * max(0.0, dot(v, n) * inversesqrt(vv + 1e-6) - 0.08);
    }
    float ao = clamp(1.0 - uIntensity * occlusion / float(AO_SAMPLES), 0.0, 1.0);
    gl_FragColor = vec4(ao, -p.z, 0.0, 1.0);
  }`

/** Depth-aware separable blur of the AO (r) guided by its view depth (g). */
const BLUR_FRAGMENT = /* glsl */ `
  uniform sampler2D tInput;
  uniform vec2 uStep;
  uniform float uOrtho;
  varying vec2 vUv;
  void main() {
    vec2 centre = texture2D(tInput, vUv).rg;
    // Depth tolerance: fixed for an orthographic view, relative in perspective.
    float tolerance = uOrtho > 0.5 ? 0.06 : 0.02 * centre.g;
    float sum = centre.r, total = 1.0;
    for (int i = -4; i <= 4; i++) {
      if (i == 0) continue;
      vec2 s = texture2D(tInput, vUv + uStep * float(i)).rg;
      float w = exp(-float(i * i) / 10.0) * max(0.0, 1.0 - abs(s.g - centre.g) / tolerance);
      sum += s.r * w; total += w;
    }
    gl_FragColor = vec4(sum / total, centre.g, 0.0, 1.0);
  }`

const LUMA = 'vec3(0.2126, 0.7152, 0.0722)'

/** 13-tap downsample; the first level also thresholds with a firefly-safe Karis average. */
const DOWN_FRAGMENT = /* glsl */ `
  uniform sampler2D tInput;
  uniform vec2 uTexel;
  uniform float uPrefilter;
  uniform float uExposure;
  uniform float uThreshold;
  uniform float uKnee;
  varying vec2 vUv;
  vec3 tap(float x, float y) { return texture2D(tInput, vUv + uTexel * vec2(x, y)).rgb; }
  float karis(vec3 c) { return 1.0 / (1.0 + dot(c, ${LUMA}) * uExposure); }
  void main() {
    vec3 a = tap(-2.0, 2.0), b = tap(0.0, 2.0), c = tap(2.0, 2.0);
    vec3 d = tap(-2.0, 0.0), e = tap(0.0, 0.0), f = tap(2.0, 0.0);
    vec3 g = tap(-2.0, -2.0), h = tap(0.0, -2.0), i = tap(2.0, -2.0);
    vec3 j = tap(-1.0, 1.0), k = tap(1.0, 1.0), l = tap(-1.0, -1.0), m = tap(1.0, -1.0);
    vec3 color;
    if (uPrefilter > 0.5) {
      vec3 g0 = (a + b + d + e) * 0.25, g1 = (b + c + e + f) * 0.25, g2 = (d + e + g + h) * 0.25, g3 = (e + f + h + i) * 0.25, g4 = (j + k + l + m) * 0.25;
      float w0 = karis(g0) * 0.125, w1 = karis(g1) * 0.125, w2 = karis(g2) * 0.125, w3 = karis(g3) * 0.125, w4 = karis(g4) * 0.5;
      color = (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) / (w0 + w1 + w2 + w3 + w4) * uExposure;
      float brightness = max(color.r, max(color.g, color.b));
      float soft = clamp(brightness - uThreshold + uKnee, 0.0, 2.0 * uKnee);
      soft = soft * soft / (4.0 * uKnee + 1e-5);
      color *= max(soft, brightness - uThreshold) / max(brightness, 1e-5);
    } else {
      color = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
    }
    gl_FragColor = vec4(color, 1.0);
  }`

/** 3×3 tent upsample of the coarser level, added to this level's downsample. */
const UP_FRAGMENT = /* glsl */ `
  uniform sampler2D tCoarse;
  uniform sampler2D tFine;
  uniform vec2 uTexel;
  varying vec2 vUv;
  vec3 tap(float x, float y) { return texture2D(tCoarse, vUv + uTexel * vec2(x, y)).rgb; }
  void main() {
    vec3 up = (tap(-1.0, -1.0) + tap(1.0, -1.0) + tap(-1.0, 1.0) + tap(1.0, 1.0)
      + 2.0 * (tap(0.0, -1.0) + tap(-1.0, 0.0) + tap(1.0, 0.0) + tap(0.0, 1.0)) + 4.0 * tap(0.0, 0.0)) / 16.0;
    gl_FragColor = vec4(texture2D(tFine, vUv).rgb + up, 1.0);
  }`

const COMPOSITE_FRAGMENT = /* glsl */ `
  ${VIEW_GLSL}
  uniform sampler2D tScene;
  uniform sampler2D tAo;
  uniform sampler2D tBloom;
  uniform vec2 uAoSize;
  uniform float uAoStrength;
  uniform float uBloomStrength;
  uniform float uExposure;
  uniform float uSaturation;
  uniform float uContrast;
  uniform vec3 uShadowTint;
  uniform vec3 uHighlightTint;
  varying vec2 vUv;

  vec3 neutral(vec3 color) {
    const float start = 0.8 - 0.04;
    const float desaturation = 0.15;
    float x = min(color.r, min(color.g, color.b));
    float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
    color -= offset;
    float peak = max(color.r, max(color.g, color.b));
    if (peak < start) return color;
    float d = 1.0 - start;
    float newPeak = 1.0 - d * d / (peak + d - start);
    color *= newPeak / peak;
    float g = 1.0 - 1.0 / (desaturation * (peak - newPeak) + 1.0);
    return mix(color, vec3(newPeak), g);
  }
  vec3 encode(vec3 c) {
    c = clamp(c, 0.0, 1.0);
    return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
  }
  // Joint bilateral upsample: the half-resolution AO texels that lie at this
  // pixel's depth count, so occlusion never bleeds across silhouettes.
  float occlusion(float z) {
    vec2 p = vUv * uAoSize - 0.5;
    vec2 f = fract(p);
    ivec2 base = ivec2(floor(p)), size = ivec2(uAoSize) - 1;
    float sum = 0.0, total = 0.0;
    for (int j = 0; j < 2; j++) for (int i = 0; i < 2; i++) {
      vec2 s = texelFetch(tAo, clamp(base + ivec2(i, j), ivec2(0), size), 0).rg;
      float w = (i == 0 ? 1.0 - f.x : f.x) * (j == 0 ? 1.0 - f.y : f.y) + 1e-4;
      w /= 1e-3 + abs(s.g - z) * 40.0;
      sum += s.r * w; total += w;
    }
    return sum / total;
  }
  void main() {
    vec3 color = texture2D(tScene, vUv).rgb;
    #if AO_ENABLED
      float depth = texture2D(tDepth, vUv).r;
      if (depth < 1.0) color *= mix(1.0, occlusion(-viewAt(vUv, depth).z), uAoStrength);
    #endif
    color = color * uExposure + texture2D(tBloom, vUv).rgb * uBloomStrength;
    color = neutral(color);
    float luma = dot(color, ${LUMA});
    color = max(vec3(0.0), mix(vec3(luma), color, uSaturation));
    color *= mix(uShadowTint, uHighlightTint, smoothstep(0.0, 0.9, luma));
    vec3 display = encode(color);
    display = mix(display, display * display * (3.0 - 2.0 * display), uContrast);
    display += (interleavedNoise(gl_FragCoord.xy) - 0.5) / 255.0;
    gl_FragColor = vec4(display, 1.0);
  }`

/** What the composite pass does to an unoccluded, unbloomed pixel (for inversion). */
export function displayOf(linear: readonly [number, number, number], exposure: number): [number, number, number] {
  let color = linear.map(value => value * exposure)
  const x = Math.min(...color)
  const offset = x < 0.08 ? x - 6.25 * x * x : 0.04
  color = color.map(value => value - offset)
  const peak = Math.max(...color), start = 0.76
  if (peak >= start) {
    const d = 1 - start, newPeak = 1 - d * d / (peak + d - start)
    const g = 1 - 1 / (0.15 * (peak - newPeak) + 1)
    color = color.map(value => value * newPeak / peak * (1 - g) + newPeak * g)
  }
  const luma = color[0] * 0.2126 + color[1] * 0.7152 + color[2] * 0.0722
  const tone = Math.min(1, Math.max(0, luma / 0.9)), blend = tone * tone * (3 - 2 * tone)
  return color.map((value, k) => {
    let c = Math.max(0, luma + (value - luma) * GRADE.saturation) * (GRADE.shadowTint[k] + (GRADE.highlightTint[k] - GRADE.shadowTint[k]) * blend)
    c = Math.min(1, Math.max(0, c))
    const s = c < 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055
    return s + (s * s * (3 - 2 * s) - s) * GRADE.contrast
  }) as [number, number, number]
}

/**
 * The scene-linear colour that the composite shows as `display` (an sRGB
 * colour, as authored). Lets the backdrop and the ground's fade meet the
 * page colour exactly, whatever the tone curve and grade.
 */
export function sceneColorFor(display: THREE.Color, exposure: number): THREE.Color {
  const target = display.clone().convertLinearToSRGB()
  const goal: [number, number, number] = [target.r, target.g, target.b]
  const guess: [number, number, number] = [display.r, display.g, display.b]
  // Newton's method with a numerical Jacobian: the tone curve's toe couples
  // the channels (its offset follows the darkest one).
  for (let iteration = 0; iteration < 30; iteration++) {
    const shown = displayOf(guess, exposure)
    const residual = shown.map((value, k) => goal[k] - value)
    if (Math.max(...residual.map(Math.abs)) < 1e-6) break
    const jacobian = [0, 1, 2].map(k => {
      const h = Math.max(1e-6, guess[k] * 1e-4), probe: [number, number, number] = [...guess]
      probe[k] += h
      return displayOf(probe, exposure).map((value, row) => (value - shown[row]) / h)
    })
    // Columns are d(shown)/d(guess_k); solve J·step = residual by Cramer's rule.
    const m = (row: number, column: number) => jacobian[column][row]
    const det3 = (c0: number[], c1: number[], c2: number[]) =>
      c0[0] * (c1[1] * c2[2] - c1[2] * c2[1]) - c1[0] * (c0[1] * c2[2] - c0[2] * c2[1]) + c2[0] * (c0[1] * c1[2] - c0[2] * c1[1])
    const columns = [0, 1, 2].map(column => [0, 1, 2].map(row => m(row, column)))
    const det = det3(columns[0], columns[1], columns[2])
    if (Math.abs(det) < 1e-12) break
    for (let k = 0; k < 3; k++) {
      const replaced = columns.map((column, c) => c === k ? residual : column)
      guess[k] = Math.max(0, guess[k] + det3(replaced[0], replaced[1], replaced[2]) / det)
    }
  }
  return new THREE.Color().setRGB(guess[0], guess[1], guess[2], THREE.LinearSRGBColorSpace)
}

export function postSupported(renderer: THREE.WebGLRenderer): boolean {
  return renderer.capabilities.isWebGL2 && (renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float'))
}

/** Starting tier for this device: software rasterisers and small devices start low. */
export function initialPostTier(renderer: THREE.WebGLRenderer): PostTier {
  if (!postSupported(renderer)) return 0
  const pinned = pinnedPostTier()
  if (pinned !== null) return pinned
  const gl = renderer.getContext()
  const info = gl.getExtension('WEBGL_debug_renderer_info')
  const name = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER))
  if (/swiftshader|llvmpipe|software|basic render/i.test(name)) return 1
  const coarse = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches
  const memory = typeof navigator !== 'undefined' ? (navigator as Navigator & { deviceMemory?: number }).deviceMemory : undefined
  return coarse || (memory !== undefined && memory <= 4) ? 2 : 3
}

/** A tier pinned from the address bar (?post=0…3); it then never adapts. */
export function pinnedPostTier(): PostTier | null {
  if (typeof location === 'undefined') return null
  const value = new URLSearchParams(location.search).get('post')
  return value !== null && /^[0-3]$/.test(value) ? Number(value) as PostTier : null
}

const halfFloatTarget = (width: number, height: number, filter: THREE.MagnificationTextureFilter = THREE.LinearFilter) => new THREE.WebGLRenderTarget(width, height, {
  type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: filter, magFilter: filter,
  depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
})

export class GardenPost {
  private spec: TierSpec
  private width = 0
  private height = 0
  private sceneTarget: THREE.WebGLRenderTarget
  private aoTarget: THREE.WebGLRenderTarget
  private aoBlur: THREE.WebGLRenderTarget
  private down: THREE.WebGLRenderTarget[] = []
  private up: THREE.WebGLRenderTarget[] = []
  private readonly quadScene = new THREE.Scene()
  private readonly quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private readonly quad: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>
  private aoMaterial: THREE.ShaderMaterial
  private readonly blurMaterial: THREE.ShaderMaterial
  private readonly downMaterial: THREE.ShaderMaterial
  private readonly upMaterial: THREE.ShaderMaterial
  private compositeMaterial: THREE.ShaderMaterial

  constructor(private readonly renderer: THREE.WebGLRenderer, readonly tier: Exclude<PostTier, 0>) {
    this.spec = TIERS[tier]
    const geometry = new THREE.BufferGeometry()
    // One oversized triangle covers the screen without a diagonal seam.
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3))
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2))
    this.blurMaterial = this.material(BLUR_FRAGMENT, { tInput: { value: null }, uStep: { value: new THREE.Vector2() }, uOrtho: { value: 1 } })
    this.downMaterial = this.material(DOWN_FRAGMENT, {
      tInput: { value: null }, uTexel: { value: new THREE.Vector2() }, uPrefilter: { value: 0 }, uExposure: { value: 1 },
      uThreshold: { value: GRADE.bloomThreshold }, uKnee: { value: GRADE.bloomKnee },
    })
    this.upMaterial = this.material(UP_FRAGMENT, { tCoarse: { value: null }, tFine: { value: null }, uTexel: { value: new THREE.Vector2() } })
    this.aoMaterial = this.createAoMaterial()
    this.compositeMaterial = this.createCompositeMaterial()
    this.quad = new THREE.Mesh(geometry, this.compositeMaterial)
    this.quad.frustumCulled = false
    this.quadScene.add(this.quad)
    this.sceneTarget = this.createSceneTarget(1, 1)
    this.aoTarget = halfFloatTarget(1, 1, THREE.NearestFilter)
    this.aoBlur = halfFloatTarget(1, 1, THREE.NearestFilter)
  }

  /** The target the scene is drawn into (shaders are compiled against it). */
  get target(): THREE.WebGLRenderTarget { return this.sceneTarget }

  private material(fragmentShader: string, uniforms: Record<string, THREE.IUniform>, defines: Record<string, number> = {}): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({ vertexShader: QUAD_VERTEX, fragmentShader, uniforms, defines, depthTest: false, depthWrite: false, toneMapped: false })
  }

  private createAoMaterial(): THREE.ShaderMaterial {
    return this.material(AO_FRAGMENT, {
      tDepth: { value: null }, uProjection: { value: new THREE.Matrix4() }, uProjectionInverse: { value: new THREE.Matrix4() },
      uDepthTexel: { value: new THREE.Vector2() }, uRadius: { value: GRADE.aoRadius }, uIntensity: { value: GRADE.aoIntensity }, uOrtho: { value: 1 },
    }, { AO_SAMPLES: Math.max(1, this.spec.ao) })
  }

  private createCompositeMaterial(): THREE.ShaderMaterial {
    return this.material(COMPOSITE_FRAGMENT, {
      tScene: { value: null }, tDepth: { value: null }, tAo: { value: null }, tBloom: { value: null },
      uProjectionInverse: { value: new THREE.Matrix4() }, uAoSize: { value: new THREE.Vector2(1, 1) },
      uAoStrength: { value: GRADE.aoStrength }, uBloomStrength: { value: GRADE.bloomStrength }, uExposure: { value: 1 },
      uSaturation: { value: GRADE.saturation }, uContrast: { value: GRADE.contrast },
      uShadowTint: { value: new THREE.Vector3(...GRADE.shadowTint) }, uHighlightTint: { value: new THREE.Vector3(...GRADE.highlightTint) },
    }, { AO_ENABLED: this.spec.ao > 0 ? 1 : 0 })
  }

  private createSceneTarget(width: number, height: number): THREE.WebGLRenderTarget {
    const target = new THREE.WebGLRenderTarget(width, height, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      depthBuffer: true, stencilBuffer: false, generateMipmaps: false,
      samples: Math.min(this.spec.samples, this.renderer.capabilities.maxSamples),
    })
    target.depthTexture = new THREE.DepthTexture(width, height, THREE.UnsignedIntType)
    target.texture.name = 'garden-hdr-scene'
    return target
  }

  /** Drawing-buffer size in pixels. */
  setSize(width: number, height: number): void {
    width = Math.max(1, Math.round(width)); height = Math.max(1, Math.round(height))
    if (width === this.width && height === this.height) return
    this.width = width; this.height = height
    this.sceneTarget.setSize(width, height)
    const halfWidth = Math.max(1, width >> 1), halfHeight = Math.max(1, height >> 1)
    this.aoTarget.setSize(halfWidth, halfHeight)
    this.aoBlur.setSize(halfWidth, halfHeight)
    for (const target of [...this.down, ...this.up]) target.dispose()
    this.down = []; this.up = []
    let w = halfWidth, h = halfHeight
    for (let level = 0; level < this.spec.bloom; level++) {
      this.down.push(halfFloatTarget(w, h))
      if (level < this.spec.bloom - 1) this.up.push(halfFloatTarget(w, h))
      w = Math.max(1, w >> 1); h = Math.max(1, h >> 1)
    }
  }

  private pass(material: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null): void {
    this.quad.material = material
    this.renderer.setRenderTarget(target)
    this.renderer.render(this.quadScene, this.quadCamera)
  }

  render(scene: THREE.Scene, camera: THREE.Camera, exposure: number): void {
    const renderer = this.renderer
    const size = renderer.getDrawingBufferSize(new THREE.Vector2())
    this.setSize(size.x, size.y)
    renderer.setRenderTarget(this.sceneTarget)
    renderer.render(scene, camera)
    const shadows = renderer.shadowMap.enabled
    renderer.shadowMap.enabled = false
    const depth = this.sceneTarget.depthTexture

    if (this.spec.ao > 0) {
      const ao = this.aoMaterial.uniforms
      ao.tDepth.value = depth
      ao.uProjection.value.copy(camera.projectionMatrix)
      ao.uProjectionInverse.value.copy(camera.projectionMatrixInverse)
      ao.uDepthTexel.value.set(1 / this.width, 1 / this.height)
      ao.uOrtho.value = (camera as THREE.OrthographicCamera).isOrthographicCamera ? 1 : 0
      this.pass(this.aoMaterial, this.aoTarget)
      const blur = this.blurMaterial.uniforms
      blur.uOrtho.value = ao.uOrtho.value
      blur.tInput.value = this.aoTarget.texture
      blur.uStep.value.set(1 / this.aoTarget.width, 0)
      this.pass(this.blurMaterial, this.aoBlur)
      blur.tInput.value = this.aoBlur.texture
      blur.uStep.value.set(0, 1 / this.aoTarget.height)
      this.pass(this.blurMaterial, this.aoTarget)
    }

    const down = this.downMaterial.uniforms
    let source = this.sceneTarget.texture, sourceWidth = this.width, sourceHeight = this.height
    for (let level = 0; level < this.down.length; level++) {
      down.tInput.value = source
      down.uTexel.value.set(1 / sourceWidth, 1 / sourceHeight)
      down.uPrefilter.value = level === 0 ? 1 : 0
      down.uExposure.value = exposure
      this.pass(this.downMaterial, this.down[level])
      source = this.down[level].texture; sourceWidth = this.down[level].width; sourceHeight = this.down[level].height
    }
    const up = this.upMaterial.uniforms
    let coarse = this.down[this.down.length - 1]
    for (let level = this.down.length - 2; level >= 0; level--) {
      up.tCoarse.value = coarse.texture
      up.tFine.value = this.down[level].texture
      up.uTexel.value.set(1 / coarse.width, 1 / coarse.height)
      this.pass(this.upMaterial, this.up[level])
      coarse = this.up[level]
    }

    const composite = this.compositeMaterial.uniforms
    composite.tScene.value = this.sceneTarget.texture
    composite.tDepth.value = depth
    composite.tAo.value = this.aoTarget.texture
    composite.uAoSize.value.set(this.aoTarget.width, this.aoTarget.height)
    composite.tBloom.value = coarse.texture
    composite.uBloomStrength.value = GRADE.bloomStrength / this.down.length
    composite.uProjectionInverse.value.copy(camera.projectionMatrixInverse)
    composite.uExposure.value = exposure
    this.pass(this.compositeMaterial, null)
    renderer.shadowMap.enabled = shadows
  }

  dispose(): void {
    for (const target of [this.sceneTarget, this.aoTarget, this.aoBlur, ...this.down, ...this.up]) {
      target.depthTexture?.dispose()
      target.dispose()
    }
    this.quad.geometry.dispose()
    for (const material of [this.aoMaterial, this.blurMaterial, this.downMaterial, this.upMaterial, this.compositeMaterial]) material.dispose()
  }
}

/**
 * Watches frame pacing while the garden animates and steps the tier down
 * when frames keep running long. Idle gaps (paused, hidden tab) are ignored.
 */
export class PostGovernor {
  private last = 0
  private average = 16
  private slow = 0

  /** Record a drawn frame; returns true when the tier should step down. */
  frame(now: number): boolean {
    const interval = now - this.last
    this.last = now
    if (interval <= 0 || interval > 1000) return false
    this.average += (interval - this.average) * 0.08
    // Well past 30 fps for a sustained stretch (sooner when very slow).
    if (this.average > 42) this.slow += this.average > 90 ? 4 : 1
    else this.slow = Math.max(0, this.slow - 2)
    if (this.slow < 150) return false
    this.slow = 0
    this.average = 16
    return true
  }
}
