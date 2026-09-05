import * as THREE from 'three'
import type { FluidLayout, FluidSnapshot } from './types'

type SurfaceStyle = 'calm' | 'natural' | 'dynamic'

const densityVertex = /* glsl */ `
  attribute float speed;
  uniform float uPointSize;
  varying float vSpeed;
  void main() {
    vSpeed = speed;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = uPointSize;
  }
`

const densityFragment = /* glsl */ `
  varying float vSpeed;
  void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(p, p);
    if (r2 >= 1.0) discard;
    float kernel = pow(1.0 - r2, 3.0) * 0.28;
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

const waterFragment = /* glsl */ `
  uniform sampler2D uDensity;
  uniform vec2 uTexel;
  uniform vec2 uCenter;
  uniform vec2 uViewSize;
  uniform vec2 uMazeSize;
  uniform float uStyle;
  varying vec2 vUv;

  void main() {
    vec2 world = uCenter + (vUv - 0.5) * uViewSize;
    vec2 maze = vec2(world.x, -world.y);
    float insideX = smoothstep(-0.04, 0.02, maze.x)
      * (1.0 - smoothstep(uMazeSize.x - 0.02, uMazeSize.x + 0.04, maze.x));
    float insideY = smoothstep(-0.04, 0.02, maze.y)
      * (1.0 - smoothstep(uMazeSize.y - 0.02, uMazeSize.y + 0.04, maze.y));
    float chamber = insideX * insideY;

    // A matte ivory plate keeps even very shallow, clear water readable.
    vec3 background = mix(vec3(0.948, 0.946, 0.926), vec3(0.995, 0.993, 0.978), vUv.y);
    background += chamber * vec3(0.005, 0.008, 0.010);
    float vignette = dot(vUv - vec2(0.5, 0.55), vUv - vec2(0.5, 0.55));
    background -= vignette * 0.025;

    vec2 sampleValue = texture2D(uDensity, vUv).rg;
    float density = sampleValue.r;
    float feather = max(fwidth(density) * 0.7, 0.006);
    float coverage = smoothstep(0.105 - feather, 0.105 + feather, density);
    if (coverage < 0.001) {
      gl_FragColor = vec4(background, 1.0);
      return;
    }

    vec2 gradient = vec2(
      texture2D(uDensity, vUv + vec2(uTexel.x, 0.0)).r
        - texture2D(uDensity, vUv - vec2(uTexel.x, 0.0)).r,
      texture2D(uDensity, vUv + vec2(0.0, uTexel.y)).r
        - texture2D(uDensity, vUv - vec2(0.0, uTexel.y)).r
    );
    vec3 normal = normalize(vec3(-gradient * 11.0, 1.0));
    float speed = clamp(sampleValue.g / max(density, 0.001), 0.0, 1.0);
    float body = smoothstep(0.105, 0.49, density);
    float edge = 1.0 - smoothstep(0.105, 0.19, density);
    float lowerEdge = max(normal.y, 0.0) * edge;

    vec3 paleWater = vec3(0.23, 0.79, 0.88);
    vec3 deepWater = vec3(0.045, 0.49, 0.68);
    deepWater = mix(deepWater, vec3(0.025, 0.45, 0.66), uStyle * 0.2);
    vec3 water = mix(paleWater, deepWater, body * 0.62);
    // Density gives coherent absorption; velocity only changes the broad tint.
    water = mix(water, vec3(0.30, 0.83, 0.90), speed * 0.08);
    water = mix(background, water, 0.75 + body * 0.14);
    float broadLight = pow(max(dot(normal, normalize(vec3(-0.38, 0.65, 0.78))), 0.0), 18.0);
    water += vec3(0.30, 0.38, 0.38) * broadLight * edge * (0.55 + uStyle * 0.12);
    water += vec3(0.13, 0.20, 0.19) * edge * 0.35;
    water -= vec3(0.025, 0.070, 0.085) * lowerEdge;
    // Very small refraction follows the actual surface normal, never a noise map.
    water += vec3(gradient.y - gradient.x) * 0.055;
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
  private readonly densityTarget: THREE.WebGLRenderTarget
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
    this.densityMaterial = new THREE.ShaderMaterial({
      vertexShader: densityVertex,
      fragmentShader: densityFragment,
      uniforms: { uPointSize: { value: 1 } },
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
        uDensity: { value: this.densityTarget.texture },
        uTexel: { value: new THREE.Vector2(1, 1) },
        uCenter: { value: new THREE.Vector2() },
        uViewSize: { value: new THREE.Vector2(1, 1) },
        uMazeSize: { value: new THREE.Vector2(layout.cols, layout.rows) },
        uStyle: { value: 0.5 },
      },
      depthTest: false,
      depthWrite: false,
    })
    const screenGeometry = new THREE.PlaneGeometry(2, 2)
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
    this.densityMaterial.uniforms.uPointSize.value = Math.max(1, this.layout.radius * 5.0 * this.densityTarget.height / this.viewHeight)
  }

  private draw(): void {
    if (this.disposed) return
    this.renderer.info.reset()
    this.renderer.setRenderTarget(this.densityTarget)
    this.renderer.setClearColor(0x000000, 0)
    this.renderer.render(this.densityScene, this.camera)
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
    for (const geometry of this.geometries) geometry.dispose()
    for (const material of this.materials) material.dispose()
    this.scene.clear()
    this.densityScene.clear()
    this.renderer.dispose()
    this.renderer.forceContextLoss()
    this.canvas.remove()
  }
}
