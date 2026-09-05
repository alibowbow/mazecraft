import * as THREE from 'three'
import type { FluidLayout, FluidSnapshot } from './types'

type SurfaceStyle = 'calm' | 'natural' | 'dynamic'

const densityVertex = /* glsl */ `
  attribute float speed;
  uniform float uPointSize;
  varying float vSpeed;
  varying vec2 vCenter;
  void main() {
    vSpeed = speed;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    vCenter = gl_Position.xy / gl_Position.w * 0.5 + 0.5;
    gl_PointSize = uPointSize;
  }
`

const densityFragment = /* glsl */ `
  varying float vSpeed;
  varying vec2 vCenter;
  uniform sampler2D uWalls;
  uniform vec2 uResolution;
  void main() {
    vec2 uv = gl_FragCoord.xy / uResolution;
    // Reject splats across a solid wall, including the dry side of thin walls.
    if (texture2D(uWalls, uv).r > 0.5
      || texture2D(uWalls, mix(vCenter, uv, 0.33)).r > 0.5
      || texture2D(uWalls, mix(vCenter, uv, 0.67)).r > 0.5) discard;
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(p, p);
    if (r2 >= 1.0) discard;
    float kernel = pow(1.0 - r2, 3.0) * 0.18;
    gl_FragColor = vec4(kernel, kernel * vSpeed, 0.0, kernel);
  }
`

const waterVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.99, 1.0);
  }
`

const smoothFragment = /* glsl */ `
  uniform sampler2D uSource;
  uniform sampler2D uWalls;
  uniform vec2 uStep;
  varying vec2 vUv;
  void main() {
    if (texture2D(uWalls, vUv).r > 0.5) { gl_FragColor = vec4(0.0); return; }
    vec4 value = texture2D(uSource, vUv) * 0.4;
    float weight = 0.4;
    for (int i = -2; i <= 2; i++) {
      if (i == 0) continue;
      vec2 offset = uStep * float(i);
      float w = abs(i) == 1 ? 0.24 : 0.06;
      if (texture2D(uWalls, vUv + offset).r > 0.5
        || texture2D(uWalls, vUv + offset * 0.5).r > 0.5) continue;
      value += texture2D(uSource, vUv + offset) * w;
      weight += w;
    }
    gl_FragColor = value / weight;
  }
`

const waterFragment = /* glsl */ `
  uniform sampler2D uDensity;
  uniform vec2 uTexel;
  uniform vec2 uCenter;
  uniform vec2 uViewSize;
  uniform vec2 uMazeSize;
  uniform float uStyle;
  uniform float uTime;
  varying vec2 vUv;

  vec3 plate(vec2 uv) {
    vec2 world = uCenter + (uv - 0.5) * uViewSize;
    vec3 color = mix(vec3(0.948, 0.946, 0.926), vec3(0.995, 0.993, 0.978), uv.y);
    // Fine world-anchored ceramic grain makes the refracted background visible.
    float grain = sin(world.x * 47.0) * sin(world.y * 43.0);
    color += grain * 0.003;
    color -= dot(uv - vec2(0.5, 0.55), uv - vec2(0.5, 0.55)) * 0.025;
    return color;
  }

  void main() {
    vec2 world = uCenter + (vUv - 0.5) * uViewSize;
    vec2 maze = vec2(world.x, -world.y);
    float insideX = smoothstep(-0.04, 0.02, maze.x)
      * (1.0 - smoothstep(uMazeSize.x - 0.02, uMazeSize.x + 0.04, maze.x));
    float insideY = smoothstep(-0.04, 0.02, maze.y)
      * (1.0 - smoothstep(uMazeSize.y - 0.02, uMazeSize.y + 0.04, maze.y));
    float chamber = insideX * insideY;

    // A matte ivory plate keeps even very shallow, clear water readable.
    vec3 background = plate(vUv);
    background += chamber * vec3(0.005, 0.008, 0.010);

    vec2 sampleValue = texture2D(uDensity, vUv).rg;
    float density = sampleValue.r;
    float feather = max(fwidth(density) * 0.7, 0.006);
    float coverage = smoothstep(0.075 - feather, 0.075 + feather, density);
    if (coverage < 0.001) {
      gl_FragColor = vec4(background, 1.0);
      return;
    }

    // World-space differences keep highlights stable while zooming or changing quality.
    vec2 sampleStep = max(uTexel, vec2(0.045) / uViewSize);
    vec2 gradient = vec2(
      texture2D(uDensity, vUv + vec2(sampleStep.x, 0.0)).r
        - texture2D(uDensity, vUv - vec2(sampleStep.x, 0.0)).r,
      texture2D(uDensity, vUv + vec2(0.0, sampleStep.y)).r
        - texture2D(uDensity, vUv - vec2(0.0, sampleStep.y)).r
    ) / (2.0 * sampleStep * uViewSize);
    float speed = clamp(sampleValue.g / max(density, 0.001), 0.0, 1.0);
    float body = smoothstep(0.12, 0.30, density);
    float edge = 1.0 - smoothstep(0.10, 0.24, density);
    // Tiny optical ripples follow simulation time and local motion, never the boundary.
    vec2 ripple = vec2(sin(world.x * 19.0 + world.y * 11.0 + uTime * 2.1),
      cos(world.x * 13.0 - world.y * 17.0 - uTime * 1.7));
    vec3 normal = normalize(vec3(-gradient * 0.65 * (1.0 - body * 0.94)
      + ripple * speed * (0.025 + uStyle * 0.035), 1.0));
    // A bounded optical depth suppresses individual particle imprints inside
    // a full pool; this cross-section has no measured third-dimensional depth.
    float thickness = (1.0 - exp(-max(0.0, density - 0.055) * 7.0)) * 0.65;
    vec3 transmittance = exp(-vec3(1.8, 0.55, 0.30) * thickness);
    vec2 refraction = normal.xy * min(thickness, 0.6) * 0.07 / uViewSize;
    vec3 transmitted = plate(vUv + refraction) * transmittance
      + vec3(0.06, 0.32, 0.37) * (1.0 - transmittance);
    // Schlick at water IOR 1.333: F0 ~0.0204. A broad sky and softbox form the reflection.
    float fresnel = 0.0204 + 0.9796 * pow(1.0 - max(normal.z, 0.0), 5.0);
    vec3 reflected = mix(vec3(0.16, 0.29, 0.34), vec3(0.86, 0.94, 0.99),
      smoothstep(-0.4, 0.8, reflect(vec3(0.0, 0.0, -1.0), normal).y));
    float softbox = pow(max(dot(normal, normalize(vec3(-0.35, 0.55, 0.76))), 0.0), 42.0);
    vec3 water = mix(transmitted, reflected, fresnel);
    water += vec3(0.85, 0.94, 1.0) * softbox * (0.22 + edge * 0.55);
    // Aeration only at moving, exposed contours; quiet pools stay transparent.
    float foam = edge * smoothstep(0.24, 0.65, speed) * 0.20;
    water = mix(water, vec3(0.93, 0.98, 0.98), foam);
    water -= vec3(0.015, 0.035, 0.04) * max(normal.y, 0.0) * edge;
    gl_FragColor = vec4(mix(background, water, coverage), 1.0);
  }
`

/** Render the particle solver's free surface; no independent animation clock. */
export class FreeSurfaceRenderer {
  readonly canvas: HTMLCanvasElement
  private readonly renderer: THREE.WebGLRenderer
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100)
  private readonly scene = new THREE.Scene()
  private readonly densityScene = new THREE.Scene()
  private readonly wallScene = new THREE.Scene()
  private readonly filterScene = new THREE.Scene()
  private readonly densityTarget: THREE.WebGLRenderTarget
  private readonly wallTarget: THREE.WebGLRenderTarget
  private readonly smoothTarget: THREE.WebGLRenderTarget
  private readonly surfaceTarget: THREE.WebGLRenderTarget
  private readonly smoothMaterial: THREE.ShaderMaterial
  private readonly densityMaterial: THREE.ShaderMaterial
  private readonly waterMaterial: THREE.ShaderMaterial
  private readonly particleGeometry = new THREE.BufferGeometry()
  private readonly particles: THREE.Points
  private readonly positionAttribute: THREE.BufferAttribute
  private readonly speedAttribute: THREE.BufferAttribute
  private readonly geometries: THREE.BufferGeometry[] = []
  private readonly materials: THREE.Material[] = []
  private readonly observer: ResizeObserver
  private readonly pointers = new Map<number, { x: number; y: number }>()
  private width = 1
  private height = 1
  private viewWidth = 1
  private viewHeight = 1
  private zoom = 1
  private panX = 0
  private panY = 0
  private pinchDistance = 0
  private disposed = false
  private drawCalls = 0
  private triangles = 0

  constructor(
    private readonly mount: HTMLElement,
    private readonly layout: FluidLayout,
    private readonly quality: 'low' | 'high',
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality === 'high' ? 2 : 1.35))
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.setClearColor(0xf4f3ed, 1)
    this.renderer.info.autoReset = false
    this.canvas = this.renderer.domElement
    this.canvas.className = 'water-simulation-canvas free-surface-canvas'
    this.canvas.setAttribute('aria-label', '중력에 따라 흐르는 미로의 물. 드래그로 이동하고 스크롤 또는 두 손가락으로 확대합니다.')
    this.canvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;cursor:grab;outline:none;'
    this.canvas.tabIndex = 0
    this.mount.appendChild(this.canvas)
    this.camera.position.z = 20

    this.densityTarget = new THREE.WebGLRenderTarget(1, 1, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: false,
      stencilBuffer: false,
    })
    this.wallTarget = this.densityTarget.clone()
    this.wallTarget.texture.minFilter = THREE.NearestFilter
    this.wallTarget.texture.magFilter = THREE.NearestFilter
    this.smoothTarget = this.densityTarget.clone()
    this.surfaceTarget = this.densityTarget.clone()
    this.densityMaterial = new THREE.ShaderMaterial({
      vertexShader: densityVertex,
      fragmentShader: densityFragment,
      uniforms: {
        uPointSize: { value: 1 }, uWalls: { value: this.wallTarget.texture },
        uResolution: { value: new THREE.Vector2(1, 1) },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
    })
    this.positionAttribute = new THREE.BufferAttribute(new Float32Array(layout.capacity * 3), 3).setUsage(THREE.DynamicDrawUsage)
    this.speedAttribute = new THREE.BufferAttribute(new Float32Array(layout.capacity), 1).setUsage(THREE.DynamicDrawUsage)
    this.particleGeometry.setAttribute('position', this.positionAttribute)
    this.particleGeometry.setAttribute('speed', this.speedAttribute)
    this.particleGeometry.setDrawRange(0, 0)
    this.particles = new THREE.Points(this.particleGeometry, this.densityMaterial)
    this.particles.frustumCulled = false
    this.densityScene.add(this.particles)

    this.waterMaterial = new THREE.ShaderMaterial({
      vertexShader: waterVertex,
      fragmentShader: waterFragment,
      uniforms: {
        uDensity: { value: this.surfaceTarget.texture },
        uTexel: { value: new THREE.Vector2(1, 1) },
        uCenter: { value: new THREE.Vector2() },
        uViewSize: { value: new THREE.Vector2(1, 1) },
        uMazeSize: { value: new THREE.Vector2(layout.cols, layout.rows) },
        uStyle: { value: 0.5 },
        uTime: { value: 0 },
      },
      depthTest: false,
      depthWrite: false,
    })
    const screenGeometry = new THREE.PlaneGeometry(2, 2)
    this.smoothMaterial = new THREE.ShaderMaterial({
      vertexShader: waterVertex, fragmentShader: smoothFragment,
      uniforms: {
        uSource: { value: this.densityTarget.texture },
        uWalls: { value: this.wallTarget.texture }, uStep: { value: new THREE.Vector2() },
      },
      depthTest: false, depthWrite: false,
    })
    const filter = new THREE.Mesh(screenGeometry, this.smoothMaterial)
    filter.frustumCulled = false
    this.filterScene.add(filter)
    const surface = new THREE.Mesh(screenGeometry, this.waterMaterial)
    surface.frustumCulled = false
    surface.renderOrder = -10
    this.scene.add(surface)
    this.geometries.push(screenGeometry)
    this.buildWalls()

    this.canvas.addEventListener('pointerdown', this.onPointerDown)
    this.canvas.addEventListener('pointermove', this.onPointerMove)
    this.canvas.addEventListener('pointerup', this.onPointerUp)
    this.canvas.addEventListener('pointercancel', this.onPointerUp)
    this.canvas.addEventListener('lostpointercapture', this.onPointerUp)
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false })
    this.canvas.addEventListener('dblclick', this.onDoubleClick)
    this.canvas.addEventListener('keydown', this.onKeyDown)
    this.observer = new ResizeObserver(() => this.resize())
    this.observer.observe(mount)
    this.resize()
  }

  get metrics(): { drawCalls: number; triangles: number } {
    return { drawCalls: this.drawCalls, triangles: this.triangles }
  }

  private buildWalls(): void {
    const fillPositions: number[] = []
    const fillColors: number[] = []
    const shadowPositions: number[] = []
    const shadowColors: number[] = []
    const addRect = (positions: number[], colors: number[], x0: number, y0: number, x1: number, y1: number, z: number, top: THREE.Color, bottom: THREE.Color) => {
      if (x1 <= x0 || y1 <= y0) return
      const vertices = [[x0, -y0], [x0, -y1], [x1, -y1], [x0, -y0], [x1, -y1], [x1, -y0]]
      for (let i = 0; i < vertices.length; i++) {
        positions.push(vertices[i][0], vertices[i][1], z)
        const c = i === 0 || i === 3 || i === 5 ? top : bottom
        colors.push(c.r, c.g, c.b)
      }
    }
    const top = new THREE.Color('#39444a')
    const bottom = new THREE.Color('#26363d')
    const rim = new THREE.Color('#6f7b7f')
    const shadow = new THREE.Color('#4e636b')
    for (const wall of this.layout.walls) {
      const { x0, y0, x1, y1 } = wall
      addRect(shadowPositions, shadowColors, x0 + 0.018, y0 + 0.024, x1 + 0.025, y1 + 0.035, 0.05, shadow, shadow)
      addRect(fillPositions, fillColors, x0, y0, x1, y1, 0.1, top, bottom)
      const bevel = Math.min(0.014, (x1 - x0) * 0.18, (y1 - y0) * 0.18)
      addRect(fillPositions, fillColors, x0, y0, x1, y0 + bevel, 0.11, rim, top)
      addRect(fillPositions, fillColors, x0, y0 + bevel, x0 + bevel, y1, 0.11, rim, top)
    }
    const addMesh = (positions: number[], colors: number[], shadowLayer: boolean) => {
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
      const material = new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: shadowLayer,
        opacity: shadowLayer ? 0.13 : 1,
        depthWrite: !shadowLayer,
        side: THREE.DoubleSide,
      })
      const mesh = new THREE.Mesh(geometry, material)
      mesh.renderOrder = shadowLayer ? 0 : 1
      this.scene.add(mesh)
      if (!shadowLayer) {
        const maskMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide })
        this.wallScene.add(new THREE.Mesh(geometry, maskMaterial))
        this.materials.push(maskMaterial)
      }
      this.geometries.push(geometry)
      this.materials.push(material)
    }
    addMesh(shadowPositions, shadowColors, true)
    addMesh(fillPositions, fillColors, false)
  }

  render(snapshot: FluidSnapshot): void {
    if (this.disposed) return
    const count = Math.min(snapshot.count, this.layout.capacity)
    const positions = this.positionAttribute.array as Float32Array
    const speeds = this.speedAttribute.array as Float32Array
    for (let i = 0; i < count; i++) {
      positions[i * 3] = snapshot.positions[i * 2]
      positions[i * 3 + 1] = -snapshot.positions[i * 2 + 1]
      positions[i * 3 + 2] = 0
      speeds[i] = Math.min(1, Math.hypot(snapshot.velocities[i * 2], snapshot.velocities[i * 2 + 1]) / 12)
    }
    this.positionAttribute.clearUpdateRanges()
    this.speedAttribute.clearUpdateRanges()
    if (count > 0) {
      this.positionAttribute.addUpdateRange(0, count * 3)
      this.speedAttribute.addUpdateRange(0, count)
      this.positionAttribute.needsUpdate = true
      this.speedAttribute.needsUpdate = true
    }
    this.particleGeometry.setDrawRange(0, count)
    this.waterMaterial.uniforms.uTime.value = snapshot.diagnostics.time
    this.draw()
  }

  setSurfaceStyle(style: SurfaceStyle): void {
    if (this.disposed) return
    this.waterMaterial.uniforms.uStyle.value = style === 'calm' ? 0 : style === 'dynamic' ? 1 : 0.5
    this.draw()
  }

  resize(): void {
    if (this.disposed) return
    this.width = Math.max(1, this.mount.clientWidth)
    this.height = Math.max(1, this.mount.clientHeight)
    this.renderer.setSize(this.width, this.height, false)
    const ratio = this.renderer.getPixelRatio()
    const maxSize = this.quality === 'high' ? 2048 : 1280
    const scale = Math.min(ratio, maxSize / Math.max(this.width, this.height))
    const width = Math.max(1, Math.round(this.width * scale))
    const height = Math.max(1, Math.round(this.height * scale))
    this.densityTarget.setSize(width, height)
    this.wallTarget.setSize(width, height)
    this.smoothTarget.setSize(width, height)
    this.surfaceTarget.setSize(width, height)
    this.densityMaterial.uniforms.uResolution.value.set(width, height)
    this.waterMaterial.uniforms.uTexel.value.set(1 / width, 1 / height)
    this.updateCamera()
    this.draw()
  }

  resetCamera(): void {
    if (this.disposed) return
    this.zoom = 1
    this.panX = 0
    this.panY = 0
    this.updateCamera()
    this.draw()
  }

  private updateCamera(): void {
    const contentWidth = this.layout.maxX - this.layout.minX + 0.65
    const contentHeight = this.layout.maxY - this.layout.minY + 0.65
    const aspect = this.width / this.height
    this.viewHeight = Math.max(contentHeight, contentWidth / aspect) / this.zoom
    this.viewWidth = this.viewHeight * aspect
    const x = (this.layout.minX + this.layout.maxX) * 0.5 + this.panX
    const y = -(this.layout.minY + this.layout.maxY) * 0.5 + this.panY
    this.camera.left = x - this.viewWidth * 0.5
    this.camera.right = x + this.viewWidth * 0.5
    this.camera.top = y + this.viewHeight * 0.5
    this.camera.bottom = y - this.viewHeight * 0.5
    this.camera.updateProjectionMatrix()
    this.waterMaterial.uniforms.uCenter.value.set(x, y)
    this.waterMaterial.uniforms.uViewSize.value.set(this.viewWidth, this.viewHeight)
    this.densityMaterial.uniforms.uPointSize.value = Math.max(1, this.layout.radius * 6.8 * this.densityTarget.height / this.viewHeight)
  }

  private draw(): void {
    if (this.disposed) return
    this.renderer.info.reset()
    this.renderer.setRenderTarget(this.wallTarget)
    this.renderer.setClearColor(0x000000, 0)
    this.renderer.render(this.wallScene, this.camera)
    this.renderer.setRenderTarget(this.densityTarget)
    this.renderer.setClearColor(0x000000, 0)
    this.renderer.render(this.densityScene, this.camera)
    // Two separable, wall-aware smoothing passes. Radius is in maze units.
    this.smoothMaterial.uniforms.uSource.value = this.densityTarget.texture
    this.smoothMaterial.uniforms.uStep.value.set(this.layout.radius * 0.9 / this.viewWidth, 0)
    this.renderer.setRenderTarget(this.smoothTarget)
    this.renderer.render(this.filterScene, this.camera)
    this.smoothMaterial.uniforms.uSource.value = this.smoothTarget.texture
    this.smoothMaterial.uniforms.uStep.value.set(0, this.layout.radius * 0.9 / this.viewHeight)
    this.renderer.setRenderTarget(this.surfaceTarget)
    this.renderer.render(this.filterScene, this.camera)
    this.renderer.setRenderTarget(null)
    this.renderer.setClearColor(0xf4f3ed, 1)
    this.renderer.render(this.scene, this.camera)
    this.drawCalls = this.renderer.info.render.calls
    this.triangles = this.renderer.info.render.triangles
  }

  private onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
    this.canvas.setPointerCapture(event.pointerId)
    this.canvas.style.cursor = 'grabbing'
    if (this.pointers.size === 2) this.pinchDistance = this.getPinchDistance()
  }

  private onPointerMove = (event: PointerEvent): void => {
    const previous = this.pointers.get(event.pointerId)
    if (!previous) return
    const dx = event.clientX - previous.x
    const dy = event.clientY - previous.y
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
    if (this.pointers.size === 2) {
      const distance = this.getPinchDistance()
      if (this.pinchDistance > 0) this.zoom = THREE.MathUtils.clamp(this.zoom * distance / this.pinchDistance, 0.75, 6)
      this.pinchDistance = distance
      this.panX -= dx * this.viewWidth / this.width * 0.5
      this.panY += dy * this.viewHeight / this.height * 0.5
    } else {
      this.panX -= dx * this.viewWidth / this.width
      this.panY += dy * this.viewHeight / this.height
    }
    this.updateCamera()
    this.draw()
  }

  private onPointerUp = (event: PointerEvent): void => {
    this.pointers.delete(event.pointerId)
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId)
    if (this.pointers.size < 2) this.pinchDistance = 0
    if (this.pointers.size === 0) this.canvas.style.cursor = 'grab'
  }

  private getPinchDistance(): number {
    const points = [...this.pointers.values()]
    return points.length < 2 ? 0 : Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y)
  }

  private onWheel = (event: WheelEvent): void => {
    event.preventDefault()
    const rect = this.canvas.getBoundingClientRect()
    const x = (event.clientX - rect.left) / this.width - 0.5
    const y = 0.5 - (event.clientY - rect.top) / this.height
    const oldWidth = this.viewWidth
    const oldHeight = this.viewHeight
    this.zoom = THREE.MathUtils.clamp(this.zoom * Math.exp(-event.deltaY * 0.0012), 0.75, 6)
    this.updateCamera()
    this.panX += x * (oldWidth - this.viewWidth)
    this.panY += y * (oldHeight - this.viewHeight)
    this.updateCamera()
    this.draw()
  }

  private onDoubleClick = (): void => this.resetCamera()

  private onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Home' || event.key === '0') {
      event.preventDefault()
      this.resetCamera()
    } else if (event.key === '+' || event.key === '=' || event.key === '-') {
      event.preventDefault()
      this.zoom = THREE.MathUtils.clamp(this.zoom * (event.key === '-' ? 1 / 1.2 : 1.2), 0.75, 6)
      this.updateCamera()
      this.draw()
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.observer.disconnect()
    this.canvas.removeEventListener('pointerdown', this.onPointerDown)
    this.canvas.removeEventListener('pointermove', this.onPointerMove)
    this.canvas.removeEventListener('pointerup', this.onPointerUp)
    this.canvas.removeEventListener('pointercancel', this.onPointerUp)
    this.canvas.removeEventListener('lostpointercapture', this.onPointerUp)
    this.canvas.removeEventListener('wheel', this.onWheel)
    this.canvas.removeEventListener('dblclick', this.onDoubleClick)
    this.canvas.removeEventListener('keydown', this.onKeyDown)
    for (const id of this.pointers.keys()) {
      if (this.canvas.hasPointerCapture(id)) this.canvas.releasePointerCapture(id)
    }
    this.pointers.clear()
    this.particleGeometry.dispose()
    this.densityMaterial.dispose()
    this.waterMaterial.dispose()
    this.densityTarget.dispose()
    this.wallTarget.dispose()
    this.smoothTarget.dispose()
    this.surfaceTarget.dispose()
    this.smoothMaterial.dispose()
    for (const geometry of this.geometries) geometry.dispose()
    for (const material of this.materials) material.dispose()
    this.scene.clear()
    this.densityScene.clear()
    this.wallScene.clear()
    this.filterScene.clear()
    this.renderer.dispose()
    this.renderer.forceContextLoss()
    this.canvas.remove()
  }
}
