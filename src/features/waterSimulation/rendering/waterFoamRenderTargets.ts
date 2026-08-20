import * as THREE from 'three'

const HISTORY_VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`

/**
 * RGBA state layout used by the high-quality water surface:
 * R = advected foam history
 * G = encoded local surface displacement (-1..1 -> 0..1)
 * B = encoded vertical wave velocity (-1..1 -> 0..1)
 * A = advected turbulence / breaking-wave energy
 */
const HISTORY_FRAGMENT_SHADER = /* glsl */ `
  precision highp float;

  uniform sampler2D uPrevious;
  uniform sampler2D uSource;
  uniform vec2 uSourceSize;
  uniform vec2 uSourceTexelSize;
  uniform vec2 uSimulationSize;
  uniform vec2 uSimulationTexelSize;
  uniform float uDeltaSeconds;
  uniform float uSimulationTime;
  uniform float uBuildRate;
  uniform float uDecayRate;
  varying vec2 vUv;

  float saturate(float value) {
    return clamp(value, 0.0, 1.0);
  }

  float decodeSigned(float value) {
    return value * 2.0 - 1.0;
  }

  float encodeSigned(float value) {
    return value * 0.5 + 0.5;
  }

  vec4 sampleSource(vec2 uv) {
    // Manual bilinear reconstruction keeps the hydraulic texture on nearest
    // filtering, which works even when float-linear filtering is unavailable.
    vec2 position =
      clamp(uv, vec2(0.0), vec2(1.0)) * uSourceSize - 0.5;
    vec2 base = floor(position);
    vec2 blend = fract(position);
    vec2 maximumCell = uSourceSize - 1.0;
    vec2 cell00 = clamp(base, vec2(0.0), maximumCell);
    vec2 cell10 = clamp(
      base + vec2(1.0, 0.0),
      vec2(0.0),
      maximumCell
    );
    vec2 cell01 = clamp(
      base + vec2(0.0, 1.0),
      vec2(0.0),
      maximumCell
    );
    vec2 cell11 = clamp(base + vec2(1.0), vec2(0.0), maximumCell);
    vec4 state00 = texture2D(uSource, (cell00 + 0.5) / uSourceSize);
    vec4 state10 = texture2D(uSource, (cell10 + 0.5) / uSourceSize);
    vec4 state01 = texture2D(uSource, (cell01 + 0.5) / uSourceSize);
    vec4 state11 = texture2D(uSource, (cell11 + 0.5) / uSourceSize);
    return mix(
      mix(state00, state10, blend.x),
      mix(state01, state11, blend.x),
      blend.y
    );
  }

  float wetnessAt(vec2 uv) {
    return smoothstep(0.0015, 0.028, sampleSource(uv).r);
  }

  float sameHydraulicRegion(vec2 fromUv, vec2 toUv) {
    vec2 fromCell = floor(
      clamp(fromUv, vec2(0.0), vec2(0.999999)) * uSourceSize
    );
    vec2 toCell = floor(
      clamp(toUv, vec2(0.0), vec2(0.999999)) * uSourceSize
    );
    vec2 crossed = abs(toCell - fromCell);
    if (crossed.x + crossed.y < 0.5) return 1.0;
    if (
      crossed.x > 1.5 ||
      crossed.y > 1.5 ||
      crossed.x + crossed.y > 1.5
    ) return 0.0;

    vec4 fromState = sampleSource(fromUv);
    vec4 toState = sampleSource(toUv);
    vec2 averageVelocity = (fromState.gb + toState.gb) * 0.5;
    vec2 normal = crossed.x > crossed.y
      ? vec2(sign(toCell.x - fromCell.x), 0.0)
      : vec2(0.0, sign(toCell.y - fromCell.y));
    float normalFlow = abs(dot(averageVelocity, normal));
    float fromSpeed = length(fromState.gb);
    float toSpeed = length(toState.gb);
    float directionalCoherence = 0.0;
    if (fromSpeed > 0.002 && toSpeed > 0.002) {
      directionalCoherence = smoothstep(
        -0.05,
        0.72,
        dot(fromState.gb / fromSpeed, toState.gb / toSpeed)
      );
    }
    float signedContinuity = step(
      0.0,
      dot(fromState.gb, normal) * dot(toState.gb, normal)
    );
    float bothWet = wetnessAt(fromUv) * wetnessAt(toUv);
    return
      bothWet *
      directionalCoherence *
      signedContinuity *
      smoothstep(0.008, 0.085, normalFlow);
  }

  vec4 samplePreviousWithBoundary(vec2 uv, vec2 fallbackUv) {
    vec2 boundedUv = clamp(
      uv,
      uSimulationTexelSize * 0.5,
      vec2(1.0) - uSimulationTexelSize * 0.5
    );
    float regionGate = sameHydraulicRegion(fallbackUv, boundedUv);
    vec4 fallbackState = texture2D(uPrevious, fallbackUv);
    vec4 sampledState = texture2D(uPrevious, boundedUv);
    return mix(fallbackState, sampledState, regionGate);
  }

  float sampleHeight(vec2 uv, vec2 centerUv, float centerHeight) {
    if (uv.x <= 0.0 || uv.x >= 1.0 || uv.y <= 0.0 || uv.y >= 1.0) {
      return centerHeight;
    }
    if (wetnessAt(uv) < 0.02 || sameHydraulicRegion(centerUv, uv) < 0.08) {
      return centerHeight;
    }
    return decodeSigned(texture2D(uPrevious, uv).g);
  }

  float hash21(vec2 value) {
    value = fract(value * vec2(123.34, 345.45));
    value += dot(value, value + 34.345);
    return fract(value.x * value.y);
  }

  void main() {
    vec4 source = sampleSource(vUv);
    float wet = smoothstep(0.0015, 0.03, source.r);
    if (wet <= 0.0001) {
      gl_FragColor = vec4(0.0, 0.5, 0.5, 0.0);
      return;
    }

    float dt = clamp(uDeltaSeconds, 0.0, 0.05);
    float stepScale = dt * 60.0;
    vec2 flow = source.gb;
    float speed = length(flow);

    // Semi-Lagrangian transport. Velocity is stored in normalized hydraulic
    // units, so convert it into maze cells per second before UV backtracing.
    vec2 backtrace = flow * (1.45 * dt) / max(uSourceSize, vec2(1.0));
    vec2 backUv = clamp(
      vUv - backtrace,
      uSimulationTexelSize * 0.5,
      vec2(1.0) - uSimulationTexelSize * 0.5
    );
    if (
      wetnessAt(backUv) < 0.02 ||
      sameHydraulicRegion(vUv, backUv) < 0.08
    ) {
      backUv = vUv;
    }

    vec4 previous = samplePreviousWithBoundary(backUv, vUv);
    float previousFoam = saturate(previous.r);
    float height = decodeSigned(previous.g);
    float verticalVelocity = decodeSigned(previous.b);
    float previousTurbulence = saturate(previous.a);

    vec2 dx = vec2(uSimulationTexelSize.x, 0.0);
    vec2 dy = vec2(0.0, uSimulationTexelSize.y);
    float heightLeft = sampleHeight(backUv - dx, backUv, height);
    float heightRight = sampleHeight(backUv + dx, backUv, height);
    float heightDown = sampleHeight(backUv - dy, backUv, height);
    float heightUp = sampleHeight(backUv + dy, backUv, height);
    float laplacian =
      heightLeft + heightRight + heightDown + heightUp - 4.0 * height;

    vec4 sourceLeft = sampleSource(vUv - vec2(uSourceTexelSize.x, 0.0));
    vec4 sourceRight = sampleSource(vUv + vec2(uSourceTexelSize.x, 0.0));
    vec4 sourceDown = sampleSource(vUv - vec2(0.0, uSourceTexelSize.y));
    vec4 sourceUp = sampleSource(vUv + vec2(0.0, uSourceTexelSize.y));
    float divergence =
      (sourceRight.g - sourceLeft.g + sourceUp.b - sourceDown.b) * 0.5;
    float curl =
      (sourceRight.b - sourceLeft.b - sourceUp.g + sourceDown.g) * 0.5;
    float compression = saturate(-divergence * 2.8);
    float shear = saturate(abs(curl) * 2.4);

    float neighboringWetness = min(
      min(wetnessAt(vUv - dx), wetnessAt(vUv + dx)),
      min(wetnessAt(vUv - dy), wetnessAt(vUv + dy))
    );
    float hydraulicEdge = saturate(1.0 - neighboringWetness);
    float forcing = saturate(
      source.a * 0.72 +
      compression * 0.52 +
      shear * 0.38 +
      hydraulicEdge * speed * 0.34
    );

    vec2 noiseCell = floor(vUv * uSimulationSize);
    float signedNoise =
      hash21(noiseCell + floor(uSimulationTime * 23.0)) * 2.0 - 1.0;
    float coherentPulse = sin(
      dot(vUv * uSourceSize, vec2(7.17, 11.31)) +
      uSimulationTime * 13.7
    );
    float waveImpulse =
      (signedNoise * 0.55 + coherentPulse * 0.45) * forcing * 0.016;

    // Stable damped height-field update. Coefficients are normalized for a
    // fixed 60 Hz visual solve and remain bounded when a frame is subdivided.
    verticalVelocity += laplacian * (0.185 * stepScale);
    verticalVelocity -= height * (0.0075 * stepScale);
    verticalVelocity += waveImpulse * stepScale;
    verticalVelocity *= pow(0.971, stepScale);
    verticalVelocity = clamp(verticalVelocity, -0.42, 0.42);
    height += verticalVelocity * (0.31 * stepScale);
    height = clamp(height, -0.34, 0.34);

    float waveEnergy = saturate(
      abs(verticalVelocity) * 1.7 + abs(laplacian) * 2.2
    );
    float turbulenceSource = saturate(
      forcing * 0.74 +
      waveEnergy * 0.62 +
      speed * hydraulicEdge * 0.28
    );
    float turbulenceRetained = previousTurbulence * exp(-1.18 * dt);
    float turbulenceBuild = 1.0 - exp(-3.25 * turbulenceSource * dt);
    float turbulence = saturate(
      turbulenceRetained +
      (1.0 - turbulenceRetained) * turbulenceBuild
    );

    float foamSource = saturate(
      source.a * 0.72 +
      compression * 0.46 +
      shear * 0.28 +
      hydraulicEdge * speed * 0.42 +
      waveEnergy * 0.24 +
      turbulence * 0.18
    );
    float retainedFoam = previousFoam * exp(-uDecayRate * dt);
    float foamBuild = 1.0 - exp(-uBuildRate * foamSource * dt);
    float foam = saturate(
      retainedFoam + (1.0 - retainedFoam) * foamBuild
    );
    foam *= smoothstep(0.002, 0.035, source.r);

    gl_FragColor = vec4(
      foam,
      encodeSigned(height),
      encodeSigned(verticalVelocity),
      turbulence
    );
  }
`

export interface WaterSurfaceHistoryResolution {
  readonly sourceWidth: number
  readonly sourceHeight: number
  readonly width: number
  readonly height: number
  readonly pixelsPerCell: number
}

/**
 * Expands the cell-resolution hydraulic field into a bounded visual solve.
 * The longest side is kept at or below 512 texels for predictable mobile GPU
 * cost while retaining up to twelve visual texels per cell.
 */
export function resolveWaterSurfaceHistoryResolution(
  sourceWidth: number,
  sourceHeight: number,
  maximumSize = 512,
): WaterSurfaceHistoryResolution {
  if (
    !Number.isInteger(sourceWidth) ||
    !Number.isInteger(sourceHeight) ||
    sourceWidth < 1 ||
    sourceHeight < 1 ||
    sourceWidth > 512 ||
    sourceHeight > 512
  ) {
    throw new RangeError(
      'Water history source dimensions must be integers from 1 to 512.',
    )
  }
  if (
    !Number.isInteger(maximumSize) ||
    maximumSize < 32 ||
    maximumSize > 2_048
  ) {
    throw new RangeError(
      'Water history maximumSize must be an integer from 32 to 2048.',
    )
  }
  const longestSide = Math.max(sourceWidth, sourceHeight)
  const fittingScale = Math.max(1, Math.floor(maximumSize / longestSide))
  const pixelsPerCell = Math.max(1, Math.min(12, fittingScale))
  return {
    sourceWidth,
    sourceHeight,
    width: sourceWidth * pixelsPerCell,
    height: sourceHeight * pixelsPerCell,
    pixelsPerCell,
  }
}

/**
 * High-quality, flow-coupled water history. It preserves the public foam
 * texture contract while using the remaining channels for a local wave solve.
 */
export class WaterFoamRenderTargets {
  readonly sourceWidth: number
  readonly sourceHeight: number
  readonly width: number
  readonly height: number
  readonly pixelsPerCell: number

  private front: THREE.WebGLRenderTarget | null = null
  private back: THREE.WebGLRenderTarget | null = null
  private readonly scene = new THREE.Scene()
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private readonly material: THREE.ShaderMaterial
  private readonly quad: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>
  private simulationTime = 0

  constructor(width: number, height: number) {
    const resolution = resolveWaterSurfaceHistoryResolution(width, height)
    this.sourceWidth = resolution.sourceWidth
    this.sourceHeight = resolution.sourceHeight
    this.width = resolution.width
    this.height = resolution.height
    this.pixelsPerCell = resolution.pixelsPerCell

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uPrevious: { value: null },
        uSource: { value: null },
        uSourceSize: {
          value: new THREE.Vector2(this.sourceWidth, this.sourceHeight),
        },
        uSourceTexelSize: {
          value: new THREE.Vector2(1 / this.sourceWidth, 1 / this.sourceHeight),
        },
        uSimulationSize: { value: new THREE.Vector2(this.width, this.height) },
        uSimulationTexelSize: {
          value: new THREE.Vector2(1 / this.width, 1 / this.height),
        },
        uDeltaSeconds: { value: 0 },
        uSimulationTime: { value: 0 },
        uBuildRate: { value: 2.1 },
        uDecayRate: { value: 0.62 },
      },
      vertexShader: HISTORY_VERTEX_SHADER,
      fragmentShader: HISTORY_FRAGMENT_SHADER,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    })
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material)
    this.quad.frustumCulled = false
    this.scene.add(this.quad)
  }

  get texture(): THREE.Texture {
    if (!this.front) {
      throw new Error('Water history render targets must be reset before use.')
    }
    return this.front.texture
  }

  private ensureTargets(renderer: THREE.WebGLRenderer): void {
    if (this.front && this.back) return
    const supportsHalfFloat =
      renderer.extensions.has('EXT_color_buffer_float') ||
      renderer.extensions.has('EXT_color_buffer_half_float')
    const options: THREE.RenderTargetOptions = {
      format: THREE.RGBAFormat,
      type: supportsHalfFloat ? THREE.HalfFloatType : THREE.UnsignedByteType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    }
    this.front = new THREE.WebGLRenderTarget(this.width, this.height, options)
    this.back = new THREE.WebGLRenderTarget(this.width, this.height, options)
    this.front.texture.name = 'water-surface-history-a'
    this.back.texture.name = 'water-surface-history-b'
    this.front.texture.colorSpace = THREE.NoColorSpace
    this.back.texture.colorSpace = THREE.NoColorSpace
  }

  reset(renderer: THREE.WebGLRenderer): void {
    this.ensureTargets(renderer)
    const previousTarget = renderer.getRenderTarget()
    const previousColor = renderer.getClearColor(new THREE.Color())
    const previousAlpha = renderer.getClearAlpha()
    renderer.setClearColor(new THREE.Color(0, 0.5, 0.5), 0)
    renderer.setRenderTarget(this.front)
    renderer.clear(true, false, false)
    renderer.setRenderTarget(this.back)
    renderer.clear(true, false, false)
    renderer.setRenderTarget(previousTarget)
    renderer.setClearColor(previousColor, previousAlpha)
    this.simulationTime = 0
  }

  step(
    renderer: THREE.WebGLRenderer,
    source: THREE.Texture,
    deltaSeconds: number,
    buildRate: number,
    decayRate: number,
  ): THREE.Texture {
    if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0 || deltaSeconds > 1) {
      throw new RangeError('Water history delta must be in the range [0, 1].')
    }
    if (!Number.isFinite(buildRate) || buildRate < 0) {
      throw new RangeError('Foam build rate must be non-negative and finite.')
    }
    if (!Number.isFinite(decayRate) || decayRate < 0) {
      throw new RangeError('Foam decay rate must be non-negative and finite.')
    }
    this.ensureTargets(renderer)
    if (!this.front || !this.back || deltaSeconds === 0) return this.texture

    let front: THREE.WebGLRenderTarget = this.front
    let back: THREE.WebGLRenderTarget = this.back
    const previousTarget = renderer.getRenderTarget()
    const fixedStep = 1 / 60
    let remaining = Math.min(deltaSeconds, 0.25)
    let substeps = 0
    while (remaining > 1e-7 && substeps < 15) {
      const dt = Math.min(fixedStep, remaining)
      this.simulationTime += dt
      this.material.uniforms.uPrevious.value = front.texture
      this.material.uniforms.uSource.value = source
      this.material.uniforms.uDeltaSeconds.value = dt
      this.material.uniforms.uSimulationTime.value = this.simulationTime
      this.material.uniforms.uBuildRate.value = buildRate
      this.material.uniforms.uDecayRate.value = decayRate
      renderer.setRenderTarget(back)
      renderer.render(this.scene, this.camera)
      const previousFront: THREE.WebGLRenderTarget = front
      front = back
      back = previousFront
      remaining -= dt
      substeps += 1
    }
    this.front = front
    this.back = back
    renderer.setRenderTarget(previousTarget)
    return front.texture
  }

  dispose(): void {
    this.front?.dispose()
    this.back?.dispose()
    this.front = null
    this.back = null
    this.quad.geometry.dispose()
    this.material.dispose()
    this.scene.clear()
  }
}
