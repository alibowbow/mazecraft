import * as THREE from 'three'

const FOAM_HISTORY_VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`

const FOAM_HISTORY_FRAGMENT_SHADER = /* glsl */ `
  precision highp float;

  uniform sampler2D uPrevious;
  uniform sampler2D uSource;
  uniform float uDeltaSeconds;
  uniform float uBuildRate;
  uniform float uDecayRate;
  varying vec2 vUv;

  void main() {
    float previous = texture2D(uPrevious, vUv).r;
    float source = clamp(texture2D(uSource, vUv).a, 0.0, 1.0);
    float retained = previous * exp(-uDecayRate * uDeltaSeconds);
    float build = 1.0 - exp(-uBuildRate * source * uDeltaSeconds);
    float history = clamp(retained + (1.0 - retained) * build, 0.0, 1.0);
    gl_FragColor = vec4(history, history, history, 1.0);
  }
`

/**
 * High-quality foam persistence. Both targets are bounded to 512 px per axis,
 * keep their own GPU history, and are explicitly disposable by the runtime.
 */
export class WaterFoamRenderTargets {
  readonly width: number
  readonly height: number

  private front: THREE.WebGLRenderTarget
  private back: THREE.WebGLRenderTarget
  private readonly scene = new THREE.Scene()
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private readonly material: THREE.ShaderMaterial
  private readonly quad: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>

  constructor(width: number, height: number) {
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < 1 ||
      height < 1 ||
      width > 512 ||
      height > 512
    ) {
      throw new RangeError('Foam render-target dimensions must be integers from 1 to 512.')
    }
    this.width = width
    this.height = height
    const options: THREE.RenderTargetOptions = {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    }
    this.front = new THREE.WebGLRenderTarget(width, height, options)
    this.back = new THREE.WebGLRenderTarget(width, height, options)
    this.front.texture.name = 'water-foam-history-a'
    this.back.texture.name = 'water-foam-history-b'
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uPrevious: { value: this.front.texture },
        uSource: { value: null },
        uDeltaSeconds: { value: 0 },
        uBuildRate: { value: 2.1 },
        uDecayRate: { value: 0.62 },
      },
      vertexShader: FOAM_HISTORY_VERTEX_SHADER,
      fragmentShader: FOAM_HISTORY_FRAGMENT_SHADER,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    })
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material)
    this.quad.frustumCulled = false
    this.scene.add(this.quad)
  }

  get texture(): THREE.Texture {
    return this.front.texture
  }

  reset(renderer: THREE.WebGLRenderer): void {
    const previousTarget = renderer.getRenderTarget()
    const previousColor = renderer.getClearColor(new THREE.Color())
    const previousAlpha = renderer.getClearAlpha()
    renderer.setClearColor(0x000000, 0)
    renderer.setRenderTarget(this.front)
    renderer.clear(true, false, false)
    renderer.setRenderTarget(this.back)
    renderer.clear(true, false, false)
    renderer.setRenderTarget(previousTarget)
    renderer.setClearColor(previousColor, previousAlpha)
  }

  step(
    renderer: THREE.WebGLRenderer,
    source: THREE.Texture,
    deltaSeconds: number,
    buildRate: number,
    decayRate: number,
  ): THREE.Texture {
    if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0 || deltaSeconds > 1) {
      throw new RangeError('Foam history delta must be in the range [0, 1].')
    }
    if (deltaSeconds === 0) return this.front.texture
    if (!Number.isFinite(buildRate) || buildRate < 0) {
      throw new RangeError('Foam build rate must be non-negative and finite.')
    }
    if (!Number.isFinite(decayRate) || decayRate < 0) {
      throw new RangeError('Foam decay rate must be non-negative and finite.')
    }

    this.material.uniforms.uPrevious.value = this.front.texture
    this.material.uniforms.uSource.value = source
    this.material.uniforms.uDeltaSeconds.value = deltaSeconds
    this.material.uniforms.uBuildRate.value = buildRate
    this.material.uniforms.uDecayRate.value = decayRate
    const previousTarget = renderer.getRenderTarget()
    renderer.setRenderTarget(this.back)
    renderer.render(this.scene, this.camera)
    renderer.setRenderTarget(previousTarget)
    const previousFront = this.front
    this.front = this.back
    this.back = previousFront
    return this.front.texture
  }

  dispose(): void {
    this.front.dispose()
    this.back.dispose()
    this.quad.geometry.dispose()
    this.material.dispose()
    this.scene.clear()
  }
}
