import * as THREE from 'three'
import type { FluidLayout, FluidSnapshot } from './types'
import { buildSolidMask, WATER_WALL_VISIBILITY } from './surfaceField'

type SurfaceStyle = 'calm' | 'natural' | 'dynamic'

const densityVertex = /* glsl */ `
  attribute vec2 center;
  attribute vec2 velocity;
  uniform float uRadius;
  varying vec2 vLocal;
  varying vec2 vCenter;
  varying vec2 vPoint;
  varying float vSpeed;
  varying float vStretch;
  void main() {
    float speed = length(velocity);
    vec2 direction = speed > 0.05 ? velocity / speed : vec2(0.0, 1.0);
    vec2 side = vec2(-direction.y, direction.x);
    vStretch = 1.0 + smoothstep(0.6, 5.0, speed);
    float width = mix(1.0, 0.88, vStretch - 1.0);
    vec2 offset = (direction * position.y * vStretch + side * position.x * width) * uRadius;
    vLocal = position.xy;
    vCenter = center;
    vPoint = center + offset;
    vSpeed = min(speed / 12.0, 1.0);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(vPoint.x, -vPoint.y, 0.0, 1.0);
  }
`

const densityFragment = /* glsl */ `
  ${WATER_WALL_VISIBILITY}
  varying vec2 vLocal;
  varying vec2 vCenter;
  varying vec2 vPoint;
  varying float vSpeed;
  varying float vStretch;
  void main() {
    float r2 = dot(vLocal, vLocal);
    if (r2 >= 1.0) discard;
    if (clearSegment(vCenter, vPoint) < 0.5) discard;
    // Elongate only the optical footprint; particle positions/mass are untouched.
    float kernel = pow(1.0 - r2, 3.0) * 0.34 / sqrt(vStretch);
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

const filterFragment = /* glsl */ `
  ${WATER_WALL_VISIBILITY}
  uniform sampler2D uInput;
  uniform vec2 uStep;
  uniform vec2 uCenter;
  uniform vec2 uViewSize;
  varying vec2 vUv;
  vec2 mazeAt(vec2 uv) {
    vec2 p = uCenter + (uv - 0.5) * uViewSize;
    return vec2(p.x, -p.y);
  }
  void main() {
    vec2 here = mazeAt(vUv);
    if (wallAt(here) > 0.5) { gl_FragColor = vec4(0.0); return; }
    vec2 sum = texture2D(uInput, vUv).rg * 0.227027;
    float weight = 0.227027;
    for (int i = -2; i <= 2; i++) {
      if (i == 0) continue;
      float offset = abs(i) == 1 ? 1.384615 : 3.230769;
      float w = abs(i) == 1 ? 0.316216 : 0.070270;
      vec2 uv = vUv + uStep * offset * sign(float(i));
      vec2 there = mazeAt(uv);
      // Each filter segment is at most .113 cells long, shorter than two walls.
      float open = (1.0 - wallAt(there)) * (1.0 - wallAt((here + there) * 0.5));
      sum += texture2D(uInput, uv).rg * w * open;
      weight += w * open;
    }
    vec2 field = sum / weight;
    gl_FragColor = vec4(field, smoothstep(0.095, 0.135, field.r), 1.0);
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
  uniform float uOpticalLod;
  varying vec2 vUv;

  float wetAt(vec2 uv) {
    return textureLod(uDensity, uv, uOpticalLod).b;
  }
  void main() {
    vec2 world = uCenter + (vUv - 0.5) * uViewSize;
    vec2 maze = vec2(world.x, -world.y);
    float insideX = smoothstep(-0.04, 0.02, maze.x)
      * (1.0 - smoothstep(uMazeSize.x - 0.02, uMazeSize.x + 0.04, maze.x));
    float insideY = smoothstep(-0.04, 0.02, maze.y)
      * (1.0 - smoothstep(uMazeSize.y - 0.02, uMazeSize.y + 0.04, maze.y));
    float chamber = insideX * insideY;
    vec3 background = mix(vec3(0.948, 0.946, 0.926), vec3(0.995, 0.993, 0.978), vUv.y);
    background += chamber * vec3(0.005, 0.008, 0.010);
    background -= dot(vUv - vec2(0.5, 0.55), vUv - vec2(0.5, 0.55)) * 0.025;

    vec2 field = texture2D(uDensity, vUv).rg;
    float density = field.r;
    float feather = max(fwidth(density) * 0.65, 0.006);
    float coverage = smoothstep(0.105 - feather, 0.105 + feather, density);
    if (coverage < 0.001) { gl_FragColor = vec4(background, 1.0); return; }

    // Shade the outside meniscus, never every particle's density peak.
    vec2 gradient = vec2(
      texture2D(uDensity, vUv + vec2(uTexel.x, 0.0)).r
        - texture2D(uDensity, vUv - vec2(uTexel.x, 0.0)).r,
      texture2D(uDensity, vUv + vec2(0.0, uTexel.y)).r
        - texture2D(uDensity, vUv - vec2(0.0, uTexel.y)).r
    );
    vec2 outward = -gradient / max(length(gradient), 0.0001);
    float distancePixels = (density - 0.105) / max(length(gradient) * 0.5, 0.0001);
    float rim = 1.0 - smoothstep(0.25, 1.6, distancePixels);
    float depthTone = clamp(maze.y / max(uMazeSize.y, 1.0), 0.0, 1.0);
    float speed = clamp(field.g / max(density, 0.001), 0.0, 1.0);

    // Optical thickness comes from the continuous silhouette, not raw density
    // peaks. Broad samples make a jet read as one curved ribbon of clear water.
    vec2 offset = vec2(0.15) / uViewSize;
    float left = wetAt(vUv - vec2(offset.x, 0.0));
    float right = wetAt(vUv + vec2(offset.x, 0.0));
    float down = wetAt(vUv - vec2(0.0, offset.y));
    float up = wetAt(vUv + vec2(0.0, offset.y));
    float core = wetAt(vUv);
    float thickness = 0.18 + core * 0.95 + depthTone * 0.20;
    vec3 transmission = exp(-vec3(2.1, 0.43, 0.19) * thickness);
    vec3 water = background * transmission;
    water += vec3(0.025, 0.12, 0.16) * (1.0 - transmission);

    vec3 normal = normalize(vec3(vec2(left - right, down - up) * 1.35, 1.0));
    float reflection = pow(max(dot(normal, normalize(vec3(-0.42, 0.32, 1.0))), 0.0), 36.0);
    float fresnel = 0.02 + 0.32 * pow(1.0 - normal.z, 3.0);
    water = mix(water, vec3(0.84, 0.95, 1.0), fresnel);
    water += vec3(0.36, 0.40, 0.40) * reflection * (0.65 + uStyle * 0.20);
    // Only moving water receives a subtle travelling light band. Time is the
    // accepted physics snapshot's time, so pause and still pools stay still.
    float motion = smoothstep(0.025, 0.3, speed);
    float band = pow(0.5 + 0.5 * sin(maze.x * 6.4 + sin(maze.y * 3.1 - uTime * 1.7) * 0.8), 8.0);
    water += vec3(0.035, 0.045, 0.05) * band * motion * (0.6 + uStyle * 0.4);
    float sky = pow(max(dot(outward, normalize(vec2(-0.3, 1.0))), 0.0), 4.0);
    water += vec3(0.40, 0.43, 0.40) * rim * sky * 0.72;
    water -= vec3(0.045, 0.055, 0.045) * rim * max(-outward.y, 0.0);
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
  private readonly filterScene = new THREE.Scene()
  private readonly filterTarget: THREE.WebGLRenderTarget
  private readonly surfaceTarget: THREE.WebGLRenderTarget
  private readonly wallTexture: THREE.DataTexture
  private readonly filterMaterial: THREE.ShaderMaterial
  private readonly densityMaterial: THREE.ShaderMaterial
  private readonly waterMaterial: THREE.ShaderMaterial
  private readonly particleGeometry = new THREE.InstancedBufferGeometry()
  private readonly particles: THREE.Mesh
  private readonly positionAttribute: THREE.InstancedBufferAttribute
  private readonly velocityAttribute: THREE.InstancedBufferAttribute
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
    this.filterTarget = this.densityTarget.clone()
    this.surfaceTarget = this.densityTarget.clone()
    // Mip-averaged binary coverage supplies a smooth thickness field without
    // the stepped rings caused by a few distant silhouette samples.
    this.surfaceTarget.texture.generateMipmaps = true
    this.surfaceTarget.texture.minFilter = THREE.LinearMipmapLinearFilter
    const mask = buildSolidMask(layout, Math.min(4096, this.renderer.capabilities.maxTextureSize))
    this.wallTexture = new THREE.DataTexture(mask.data, mask.width, mask.height, THREE.RedFormat)
    this.wallTexture.minFilter = this.wallTexture.magFilter = THREE.NearestFilter
    this.wallTexture.unpackAlignment = 1
    this.wallTexture.needsUpdate = true
    const wallUniforms = {
      uWalls: { value: this.wallTexture },
      uWallBounds: { value: new THREE.Vector4(...mask.bounds) },
    }
    this.densityMaterial = new THREE.ShaderMaterial({
      vertexShader: densityVertex,
      fragmentShader: densityFragment,
      uniforms: { ...wallUniforms, uRadius: { value: layout.radius * 2.8 } },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
    })
    this.positionAttribute = new THREE.InstancedBufferAttribute(new Float32Array(layout.capacity * 2), 2).setUsage(THREE.DynamicDrawUsage)
    this.velocityAttribute = new THREE.InstancedBufferAttribute(new Float32Array(layout.capacity * 2), 2).setUsage(THREE.DynamicDrawUsage)
    this.particleGeometry.setAttribute('position', new THREE.Float32BufferAttribute([
      -1, -1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, 1, 1, 0, -1, 1, 0,
    ], 3))
    this.particleGeometry.setAttribute('center', this.positionAttribute)
    this.particleGeometry.setAttribute('velocity', this.velocityAttribute)
    this.particleGeometry.instanceCount = 0
    this.particles = new THREE.Mesh(this.particleGeometry, this.densityMaterial)
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
        uOpticalLod: { value: 0 },
      },
      depthTest: false,
      depthWrite: false,
    })
    this.filterMaterial = new THREE.ShaderMaterial({
      vertexShader: waterVertex,
      fragmentShader: filterFragment,
      uniforms: {
        ...wallUniforms,
        uInput: { value: this.densityTarget.texture },
        uStep: { value: new THREE.Vector2() },
        uCenter: this.waterMaterial.uniforms.uCenter,
        uViewSize: this.waterMaterial.uniforms.uViewSize,
      },
      depthTest: false,
      depthWrite: false,
    })
    const screenGeometry = new THREE.PlaneGeometry(2, 2)
    const filter = new THREE.Mesh(screenGeometry, this.filterMaterial)
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
      this.geometries.push(geometry)
      this.materials.push(material)
    }
    addMesh(shadowPositions, shadowColors, true)
    addMesh(fillPositions, fillColors, false)
  }

  render(snapshot: FluidSnapshot): void {
    if (this.disposed) return
    this.waterMaterial.uniforms.uTime.value = snapshot.diagnostics.time
    const count = Math.min(snapshot.count, this.layout.capacity)
    const positions = this.positionAttribute.array as Float32Array
    const velocities = this.velocityAttribute.array as Float32Array
    for (let i = 0; i < count * 2; i++) {
      positions[i] = snapshot.positions[i]
      velocities[i] = snapshot.velocities[i]
    }
    this.positionAttribute.clearUpdateRanges()
    this.velocityAttribute.clearUpdateRanges()
    if (count > 0) {
      this.positionAttribute.addUpdateRange(0, count * 2)
      this.velocityAttribute.addUpdateRange(0, count * 2)
      this.positionAttribute.needsUpdate = true
      this.velocityAttribute.needsUpdate = true
    }
    this.particleGeometry.instanceCount = count
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
    this.filterTarget.setSize(width, height)
    this.surfaceTarget.setSize(width, height)
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
    this.waterMaterial.uniforms.uOpticalLod.value = Math.max(0, Math.log2(0.28 * this.surfaceTarget.height / this.viewHeight))
  }

  private draw(): void {
    if (this.disposed) return
    this.renderer.info.reset()
    this.renderer.setRenderTarget(this.densityTarget)
    this.renderer.setClearColor(0x000000, 0)
    this.renderer.render(this.densityScene, this.camera)
    this.filterMaterial.uniforms.uInput.value = this.densityTarget.texture
    this.filterMaterial.uniforms.uStep.value.set(0.035 / this.viewWidth, 0)
    this.renderer.setRenderTarget(this.filterTarget)
    this.renderer.render(this.filterScene, this.camera)
    this.filterMaterial.uniforms.uInput.value = this.filterTarget.texture
    this.filterMaterial.uniforms.uStep.value.set(0, 0.035 / this.viewHeight)
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
    this.filterTarget.dispose()
    this.surfaceTarget.dispose()
    this.filterMaterial.dispose()
    this.wallTexture.dispose()
    for (const geometry of this.geometries) geometry.dispose()
    for (const material of this.materials) material.dispose()
    this.scene.clear()
    this.densityScene.clear()
    this.filterScene.clear()
    this.renderer.dispose()
    this.renderer.forceContextLoss()
    this.canvas.remove()
  }
}
