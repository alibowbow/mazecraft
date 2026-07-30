import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import {
  getActiveCell,
  getVisualOpeningDirection,
  type CellPosition,
  type MazeGraph,
  type MazeProject,
  type WallDirection,
} from '../../core/maze'
import {
  buildWaterSurfaceTimeline,
  type WaterSurfaceTimeline,
} from './waterSurfaceTimeline'
import type {
  WaterCellSchedule,
  WaterSimulationModel,
} from './waterModel'

export interface WaterPlaybackStatus {
  elapsedMs: number
  filledCells: number
  totalCells: number
  reachedExit: boolean
  complete: boolean
}

export interface WaterRuntimeMetrics {
  atlasWidth: number
  atlasHeight: number
  drawCalls: number
  triangles: number
}

export type ResolvedWaterQuality = 'low' | 'high'

interface WallSpec {
  x: number
  y: number
  width: number
  height: number
  orientation: 'horizontal' | 'vertical'
}

interface ParticleSeed {
  phase: number
  drift: number
  size: number
  lift: number
  depth: number
}

interface BubbleSeed extends ParticleSeed {
  cell: WaterCellSchedule
}

const WATER_VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vWorldPosition;

  void main() {
    vUv = uv;
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPosition.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`

const WATER_FRAGMENT_SHADER = /* glsl */ `
  precision highp float;

  uniform sampler2D uSchedule;
  uniform sampler2D uField;
  uniform float uTime;
  uniform float uDrainStart;
  uniform float uDrainDuration;
  uniform vec2 uBoardSize;
  uniform vec3 uCameraPosition;
  varying vec2 vUv;
  varying vec3 vWorldPosition;

  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  float valueNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x),
      mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0)), f.x),
      f.y
    );
  }

  void main() {
    vec4 schedule = texture2D(uSchedule, vUv);
    vec4 field = texture2D(uField, vUv);
    float mask = smoothstep(0.08, 0.86, field.r);
    if (mask < 0.01 || schedule.r < 0.0) discard;

    float arrival = schedule.r;
    float fullAt = max(schedule.g, arrival + 1.0);
    float retained = clamp(schedule.b, 0.0, 1.0);
    vec2 flow = normalize(field.gb * 2.0 - 1.0 + vec2(0.0001));
    vec2 channelUv = vUv * uBoardSize;
    float frontNoise = valueNoise(
      channelUv * 3.7 + flow * uTime * 0.00012
    );
    float frontRipple = sin(
      dot(channelUv, vec2(-flow.y, flow.x) * 15.0) +
      schedule.a * 6.283
    ) * 22.0;
    float frontTime =
      uTime + (frontNoise - 0.5) * 105.0 + frontRipple;

    float wet = smoothstep(arrival - 18.0, arrival + 92.0, frontTime);
    float fill = smoothstep(arrival, fullAt, frontTime);
    float localDrainStart = max(fullAt, uDrainStart);
    float draining = smoothstep(
      localDrainStart,
      localDrainStart + max(1.0, uDrainDuration),
      uTime
    );
    float level = mix(1.0, retained, draining);
    float visibleWater = wet * mix(0.34, 1.0, fill);

    float frontAge = max(0.0, frontTime - arrival);
    float leadingFoam =
      exp(-pow(frontAge / 82.0, 2.0)) *
      step(arrival, uTime) *
      (1.0 - draining);

    float directionalWave = sin(
      dot(channelUv, flow * 11.0) -
      uTime * 0.0085 +
      schedule.a * 8.0
    );
    float crossWave = sin(
      dot(channelUv, vec2(-flow.y, flow.x) * 17.0) +
      uTime * 0.005
    );
    float noise = valueNoise(channelUv * 3.1 + flow * uTime * 0.00075);
    float surface = directionalWave * 0.46 + crossWave * 0.22 + noise * 0.74;
    vec3 normal = normalize(vec3(
      dFdx(surface) * 1.8,
      dFdy(surface) * 1.8,
      1.0
    ));
    vec3 viewDirection = normalize(uCameraPosition - vWorldPosition);
    float fresnel = pow(1.0 - clamp(dot(normal, viewDirection), 0.0, 1.0), 2.5);
    float studioHighlight = pow(
      max(dot(normal, normalize(vec3(-0.35, 0.58, 0.74))), 0.0),
      18.0
    );

    vec3 shallowCyan = vec3(0.06, 0.82, 0.93);
    vec3 deepCyan = vec3(0.005, 0.41, 0.68);
    vec3 bodyColor = mix(
      shallowCyan,
      deepCyan,
      clamp(0.36 + level * 0.42 + noise * 0.12, 0.0, 1.0)
    );
    bodyColor += vec3(0.18, 0.50, 0.66) * fresnel;
    bodyColor += vec3(0.78, 0.96, 1.0) * studioHighlight * 0.72;
    bodyColor = mix(bodyColor, vec3(0.82, 0.985, 1.0), leadingFoam * 0.82);

    float contactRim = smoothstep(0.08, 0.5, mask) -
      smoothstep(0.54, 0.96, mask);
    bodyColor += vec3(0.03, 0.26, 0.46) * contactRim * 0.7;

    float alpha = mask * visibleWater * mix(0.18, 0.91, level);
    alpha = max(alpha, leadingFoam * mask * 0.9);
    if (alpha < 0.018) discard;
    gl_FragColor = vec4(bodyColor, alpha);
  }
`

const clamp01 = (value: number) => Math.max(0, Math.min(1, value))

const smoothstep = (minimum: number, maximum: number, value: number) => {
  const normalized = clamp01((value - minimum) / Math.max(0.0001, maximum - minimum))
  return normalized * normalized * (3 - 2 * normalized)
}

const positionKey = ({ row, col }: CellPosition) => `${row}:${col}`

const openingKey = (position: CellPosition, direction: WallDirection | null) =>
  direction ? `${positionKey(position)}:${direction}` : ''

const cellScenePosition = (graph: MazeGraph, position: CellPosition) => ({
  x: position.col - graph.cols / 2 + 0.5,
  y: graph.rows / 2 - position.row - 0.5,
})

const seededUnit = (index: number, salt: number) => {
  const value = Math.sin(index * 91.733 + salt * 37.719) * 43_758.5453
  return value - Math.floor(value)
}

const collectWallSpecs = (
  graph: MazeGraph,
  start: CellPosition,
  end: CellPosition,
): WallSpec[] => {
  const openings = new Set([
    openingKey(start, getVisualOpeningDirection(graph, start)),
    openingKey(end, getVisualOpeningDirection(graph, end)),
  ])
  const walls: WallSpec[] = []

  const addWall = (
    position: CellPosition,
    direction: WallDirection,
    x: number,
    y: number,
    width: number,
    height: number,
    orientation: WallSpec['orientation'],
  ) => {
    if (!openings.has(openingKey(position, direction))) {
      walls.push({ x, y, width, height, orientation })
    }
  }

  for (const cell of graph.cells) {
    if (!cell.active) continue
    const { x, y } = cellScenePosition(graph, cell)
    if (cell.walls.top) {
      addWall(cell, 'top', x, y + 0.5, 1.12, 0.16, 'horizontal')
    }
    if (cell.walls.left) {
      addWall(cell, 'left', x - 0.5, y, 0.16, 1.12, 'vertical')
    }

    const right = getActiveCell(graph, { row: cell.row, col: cell.col + 1 })
    if (!right && cell.walls.right) {
      addWall(cell, 'right', x + 0.5, y, 0.16, 1.12, 'vertical')
    }
    const bottom = getActiveCell(graph, { row: cell.row + 1, col: cell.col })
    if (!bottom && cell.walls.bottom) {
      addWall(cell, 'bottom', x, y - 0.5, 1.12, 0.16, 'horizontal')
    }
  }
  return walls
}

const createLabelSprite = (text: string, fill: string) => {
  const canvas = document.createElement('canvas')
  canvas.width = 128
  canvas.height = 128
  const context = canvas.getContext('2d')
  if (context) {
    context.clearRect(0, 0, 128, 128)
    context.fillStyle = fill
    context.beginPath()
    context.arc(64, 64, 43, 0, Math.PI * 2)
    context.fill()
    context.lineWidth = 5
    context.strokeStyle = 'rgba(255,255,255,.96)'
    context.stroke()
    context.fillStyle = '#ffffff'
    context.font = '800 58px system-ui, sans-serif'
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.fillText(text, 64, 68)
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
    }),
  )
  sprite.scale.set(0.56, 0.56, 1)
  sprite.renderOrder = 30
  return sprite
}

const createParticleSeeds = (count: number, salt: number): ParticleSeed[] =>
  Array.from({ length: count }, (_, index) => ({
    phase: seededUnit(index, salt),
    drift: seededUnit(index, salt + 1) * 2 - 1,
    size: 0.58 + seededUnit(index, salt + 2) * 0.72,
    lift: 0.45 + seededUnit(index, salt + 3) * 0.72,
    depth: seededUnit(index, salt + 4) * 2 - 1,
  }))

function createStudioGradientTexture() {
  const canvas = document.createElement('canvas')
  canvas.width = 16
  canvas.height = 512
  const context = canvas.getContext('2d')
  if (context) {
    const gradient = context.createLinearGradient(0, 0, 0, canvas.height)
    gradient.addColorStop(0, '#f8fbfc')
    gradient.addColorStop(0.5, '#dfeaec')
    gradient.addColorStop(1, '#b8cdd1')
    context.fillStyle = gradient
    context.fillRect(0, 0, canvas.width, canvas.height)
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  return texture
}

function createWaterSurfaceMaterial(timeline: WaterSurfaceTimeline) {
  const schedule = new THREE.DataTexture(
    timeline.schedule,
    timeline.width,
    timeline.height,
    THREE.RGBAFormat,
    THREE.FloatType,
  )
  schedule.minFilter = THREE.NearestFilter
  schedule.magFilter = THREE.NearestFilter
  schedule.generateMipmaps = false
  schedule.flipY = false
  schedule.needsUpdate = true

  const field = new THREE.DataTexture(
    timeline.field,
    timeline.width,
    timeline.height,
    THREE.RGBAFormat,
    THREE.UnsignedByteType,
  )
  field.minFilter = THREE.LinearFilter
  field.magFilter = THREE.LinearFilter
  field.generateMipmaps = false
  field.flipY = false
  field.needsUpdate = true

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uSchedule: { value: schedule },
      uField: { value: field },
      uTime: { value: 0 },
      uDrainStart: { value: Number.MAX_SAFE_INTEGER },
      uDrainDuration: { value: 1 },
      uBoardSize: { value: new THREE.Vector2(1, 1) },
      uCameraPosition: { value: new THREE.Vector3() },
    },
    vertexShader: WATER_VERTEX_SHADER,
    fragmentShader: WATER_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    side: THREE.FrontSide,
    toneMapped: true,
  })
  return { material, schedule, field }
}

export class WaterSceneRuntime {
  private readonly scene = new THREE.Scene()
  private readonly camera = new THREE.PerspectiveCamera(29, 1, 0.1, 2_000)
  private readonly renderer: THREE.WebGLRenderer
  private readonly controls: OrbitControls
  private readonly resizeObserver: ResizeObserver
  private readonly clock = new THREE.Clock()
  private readonly timeline: WaterSurfaceTimeline
  private readonly waterSurfaceMaterial: THREE.ShaderMaterial
  private readonly scheduleTexture: THREE.DataTexture
  private readonly fieldTexture: THREE.DataTexture
  private readonly inletJet: THREE.Mesh
  private readonly outletJet: THREE.Mesh
  private readonly reservoirWater: THREE.Mesh
  private readonly inletDroplets: THREE.InstancedMesh
  private readonly outletDroplets: THREE.InstancedMesh
  private readonly splashDroplets: THREE.InstancedMesh
  private readonly bubbles: THREE.InstancedMesh
  private readonly inletSeeds: ParticleSeed[]
  private readonly outletSeeds: ParticleSeed[]
  private readonly splashSeeds: ParticleSeed[]
  private readonly bubbleSeeds: BubbleSeed[]
  private readonly particleDummy = new THREE.Object3D()
  private readonly initialCameraPosition = new THREE.Vector3()
  private readonly initialTarget = new THREE.Vector3()
  private readonly sourcePosition: { x: number; y: number }
  private readonly exitPosition: { x: number; y: number }
  private readonly reachableCells: WaterCellSchedule[]
  private readonly environmentTarget: THREE.WebGLRenderTarget
  private readonly pmremGenerator: THREE.PMREMGenerator
  private readonly completeAt: number
  private frameId = 0
  private elapsedMs = 0
  private speed = 1
  private paused = false
  private requestedPaused = false
  private disposed = false
  private visibleCursor = 0
  private lastStatusAt = -Infinity
  private lastAspect = 0
  private lastParticleAt = -Infinity
  private lastCameraInteractionAt = 0
  private metricsEmitted = false

  constructor(
    private readonly mount: HTMLDivElement,
    private readonly project: MazeProject,
    private readonly model: WaterSimulationModel,
    private readonly quality: ResolvedWaterQuality,
    private readonly onStatus: (status: WaterPlaybackStatus) => void,
    private readonly onError: (message: string) => void,
    private readonly onMetrics: (metrics: WaterRuntimeMetrics) => void,
    private readonly reducedMotion: boolean,
  ) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: quality === 'high',
      alpha: false,
      powerPreference: quality === 'high' ? 'high-performance' : 'low-power',
    })
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 0.94
    this.renderer.setPixelRatio(
      Math.min(window.devicePixelRatio || 1, quality === 'high' ? 1.5 : 1.05),
    )
    this.renderer.setClearColor(0xdfeaec, 1)
    if (quality === 'high') {
      this.renderer.shadowMap.enabled = true
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    }
    this.renderer.domElement.className = 'water-simulation-canvas'
    this.renderer.domElement.setAttribute('aria-hidden', 'true')
    this.renderer.domElement.addEventListener(
      'webglcontextlost',
      this.handleContextLost,
      false,
    )
    this.mount.replaceChildren(this.renderer.domElement)

    this.pmremGenerator = new THREE.PMREMGenerator(this.renderer)
    this.environmentTarget = this.pmremGenerator.fromScene(
      new RoomEnvironment(),
      quality === 'high' ? 0.05 : 0.1,
    )
    this.scene.environment = this.environmentTarget.texture

    this.sourcePosition = cellScenePosition(
      project.mazeGraph,
      project.startCell,
    )
    this.exitPosition = cellScenePosition(project.mazeGraph, project.endCell)
    this.timeline = buildWaterSurfaceTimeline(project.mazeGraph, model, {
      pixelsPerCell: quality === 'high' ? 12 : 5,
      maxTextureSize: 1_024,
    })
    const waterSurface = createWaterSurfaceMaterial(this.timeline)
    this.waterSurfaceMaterial = waterSurface.material
    this.scheduleTexture = waterSurface.schedule
    this.fieldTexture = waterSurface.field
    this.waterSurfaceMaterial.uniforms.uBoardSize.value.set(
      project.mazeGraph.cols,
      project.mazeGraph.rows,
    )
    this.waterSurfaceMaterial.uniforms.uDrainStart.value =
      model.exitArrivalMs === null
        ? Number.MAX_SAFE_INTEGER
        : model.exitArrivalMs + model.options.drainDelayMs
    this.waterSurfaceMaterial.uniforms.uDrainDuration.value =
      model.options.drainDurationMs

    this.reachableCells = model.cells
      .filter(
        (cell) =>
          cell.reachable &&
          cell.arrivalMs !== null &&
          Number.isFinite(cell.arrivalMs),
      )
      .sort(
        (left, right) =>
          (left.arrivalMs ?? 0) - (right.arrivalMs ?? 0) ||
          left.index - right.index,
      )
    this.completeAt = Math.max(
      model.totalDurationMs,
      (model.exitArrivalMs ?? 0) + 1_450,
    )

    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = !reducedMotion
    this.controls.dampingFactor = 0.075
    this.controls.enablePan = false
    this.controls.minDistance = 4
    this.controls.maxDistance =
      Math.max(project.mazeGraph.rows, project.mazeGraph.cols) * 3.4
    this.controls.rotateSpeed = 0.32
    this.controls.zoomSpeed = 0.72
    this.controls.minAzimuthAngle = -0.18
    this.controls.maxAzimuthAngle = 0.18
    this.controls.minPolarAngle = Math.PI / 2 - 0.14
    this.controls.maxPolarAngle = Math.PI / 2 + 0.14
    this.controls.addEventListener('start', () => {
      this.lastCameraInteractionAt = performance.now()
    })

    this.addEnvironment()
    this.addMaze()
    this.addWaterSurface()
    const streams = this.addReservoirAndStreams()
    this.inletJet = streams.inletJet
    this.outletJet = streams.outletJet
    this.reservoirWater = streams.reservoirWater

    const particleSystems = this.addParticleSystems()
    this.inletDroplets = particleSystems.inletDroplets
    this.outletDroplets = particleSystems.outletDroplets
    this.splashDroplets = particleSystems.splashDroplets
    this.bubbles = particleSystems.bubbles
    this.inletSeeds = particleSystems.inletSeeds
    this.outletSeeds = particleSystems.outletSeeds
    this.splashSeeds = particleSystems.splashSeeds
    this.bubbleSeeds = particleSystems.bubbleSeeds
    this.resetEffects()

    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(this.mount)
    document.addEventListener('visibilitychange', this.handleVisibilityChange)
    this.resize()
    this.clock.start()
    this.tick()
  }

  setPaused(paused: boolean) {
    this.requestedPaused = paused
    this.paused = paused || document.hidden
    this.clock.getDelta()
  }

  setSpeed(speed: number) {
    this.speed = speed
  }

  restart() {
    this.elapsedMs = 0
    this.visibleCursor = 0
    this.paused = false
    this.requestedPaused = false
    this.waterSurfaceMaterial.uniforms.uTime.value = 0
    this.resetEffects()
    this.onStatus({
      elapsedMs: 0,
      filledCells: 0,
      totalCells: this.reachableCells.length,
      reachedExit: false,
      complete: false,
    })
  }

  resetCamera() {
    this.camera.position.copy(this.initialCameraPosition)
    this.controls.target.copy(this.initialTarget)
    this.controls.update()
  }

  dispose() {
    this.disposed = true
    cancelAnimationFrame(this.frameId)
    this.resizeObserver.disconnect()
    document.removeEventListener(
      'visibilitychange',
      this.handleVisibilityChange,
    )
    this.renderer.domElement.removeEventListener(
      'webglcontextlost',
      this.handleContextLost,
      false,
    )
    this.controls.dispose()
    this.scheduleTexture.dispose()
    this.fieldTexture.dispose()
    this.environmentTarget.dispose()
    this.pmremGenerator.dispose()
    this.scene.traverse((object) => {
      if (
        object instanceof THREE.Mesh ||
        object instanceof THREE.InstancedMesh ||
        object instanceof THREE.Points
      ) {
        object.geometry.dispose()
        const materials = Array.isArray(object.material)
          ? object.material
          : [object.material]
        for (const material of materials) {
          if ('map' in material && material.map instanceof THREE.Texture) {
            material.map.dispose()
          }
          material.dispose()
        }
      } else if (object instanceof THREE.Sprite) {
        object.material.map?.dispose()
        object.material.dispose()
      }
    })
    this.renderer.dispose()
    this.renderer.forceContextLoss()
    this.mount.replaceChildren()
  }

  private handleVisibilityChange = () => {
    this.paused = this.requestedPaused || document.hidden
    this.clock.getDelta()
  }

  private handleContextLost = (event: Event) => {
    event.preventDefault()
    this.paused = true
    this.requestedPaused = true
    this.onError('그래픽 컨텍스트가 종료되었습니다. 창을 닫고 다시 열어 주세요.')
  }

  private addEnvironment() {
    const graph = this.project.mazeGraph
    const gradientTexture = createStudioGradientTexture()
    const background = new THREE.Mesh(
      new THREE.PlaneGeometry(graph.cols * 3.2 + 12, graph.rows * 3.2 + 12),
      new THREE.MeshBasicMaterial({ map: gradientTexture }),
    )
    background.position.z = -1.25
    this.scene.add(background)

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8aa3aa, 2.35))
    const keyLight = new THREE.DirectionalLight(0xffffff, 3.9)
    keyLight.position.set(-9, 13, 18)
    if (this.quality === 'high') {
      keyLight.castShadow = true
      keyLight.shadow.mapSize.set(1_024, 1_024)
      keyLight.shadow.camera.near = 2
      keyLight.shadow.camera.far = 60
      const shadowSpan =
        Math.max(this.project.mazeGraph.cols, this.project.mazeGraph.rows) * 0.8
      keyLight.shadow.camera.left = -shadowSpan
      keyLight.shadow.camera.right = shadowSpan
      keyLight.shadow.camera.top = shadowSpan
      keyLight.shadow.camera.bottom = -shadowSpan
      keyLight.shadow.bias = -0.0007
    }
    this.scene.add(keyLight)

    const fillLight = new THREE.DirectionalLight(0x77d6ff, 1.45)
    fillLight.position.set(10, -4, 12)
    this.scene.add(fillLight)
    const warmRim = new THREE.DirectionalLight(0xffb46e, 1.1)
    warmRim.position.set(-12, 4, 7)
    this.scene.add(warmRim)
  }

  private addMaze() {
    const graph = this.project.mazeGraph
    const board = new THREE.Mesh(
      new RoundedBoxGeometry(
        graph.cols + 0.72,
        graph.rows + 0.72,
        0.28,
        this.quality === 'high' ? 5 : 2,
        0.16,
      ),
      new THREE.MeshStandardMaterial({
        color: 0xf7f5ef,
        roughness: 0.62,
        metalness: 0,
        envMapIntensity: 0.72,
      }),
    )
    board.position.z = -0.19
    board.receiveShadow = true
    this.scene.add(board)

    const inset = new THREE.Mesh(
      new RoundedBoxGeometry(
        graph.cols + 0.18,
        graph.rows + 0.18,
        0.08,
        this.quality === 'high' ? 4 : 2,
        0.1,
      ),
      new THREE.MeshStandardMaterial({
        color: 0xeaf3f5,
        roughness: 0.36,
        metalness: 0,
        envMapIntensity: 0.9,
      }),
    )
    inset.position.z = -0.015
    inset.receiveShadow = true
    this.scene.add(inset)

    const walls = collectWallSpecs(
      graph,
      this.project.startCell,
      this.project.endCell,
    )
    const horizontalWalls = walls.filter(
      (wall) => wall.orientation === 'horizontal',
    )
    const verticalWalls = walls.filter(
      (wall) => wall.orientation === 'vertical',
    )
    const wallMaterial = new THREE.MeshPhysicalMaterial({
      color: 0xff4b0b,
      roughness: 0.22,
      metalness: 0,
      clearcoat: 0.48,
      clearcoatRoughness: 0.19,
      envMapIntensity: 1.18,
    })
    const horizontalGeometry =
      this.quality === 'high'
        ? new RoundedBoxGeometry(1.12, 0.16, 0.68, 3, 0.052)
        : new THREE.BoxGeometry(1.12, 0.16, 0.64)
    const verticalGeometry =
      this.quality === 'high'
        ? new RoundedBoxGeometry(0.16, 1.12, 0.68, 3, 0.052)
        : new THREE.BoxGeometry(0.16, 1.12, 0.64)
    const dummy = new THREE.Object3D()

    const horizontalMesh = new THREE.InstancedMesh(
      horizontalGeometry,
      wallMaterial,
      horizontalWalls.length,
    )
    horizontalWalls.forEach((wall, index) => {
      dummy.position.set(wall.x, wall.y, 0.31)
      dummy.rotation.set(0, 0, 0)
      dummy.scale.set(wall.width / 1.12, wall.height / 0.16, 1)
      dummy.updateMatrix()
      horizontalMesh.setMatrixAt(index, dummy.matrix)
    })
    horizontalMesh.instanceMatrix.needsUpdate = true
    horizontalMesh.castShadow = this.quality === 'high'
    horizontalMesh.receiveShadow = true
    this.scene.add(horizontalMesh)

    const verticalMesh = new THREE.InstancedMesh(
      verticalGeometry,
      wallMaterial,
      verticalWalls.length,
    )
    verticalWalls.forEach((wall, index) => {
      dummy.position.set(wall.x, wall.y, 0.31)
      dummy.rotation.set(0, 0, 0)
      dummy.scale.set(wall.width / 0.16, wall.height / 1.12, 1)
      dummy.updateMatrix()
      verticalMesh.setMatrixAt(index, dummy.matrix)
    })
    verticalMesh.instanceMatrix.needsUpdate = true
    verticalMesh.castShadow = this.quality === 'high'
    verticalMesh.receiveShadow = true
    this.scene.add(verticalMesh)

    if (this.quality === 'high' && graph.cells.length <= 3_600) {
      const cover = new THREE.Mesh(
        new RoundedBoxGeometry(
          graph.cols + 0.42,
          graph.rows + 0.42,
          0.055,
          5,
          0.13,
        ),
        new THREE.MeshPhysicalMaterial({
          color: 0xf4fdff,
          transparent: true,
          opacity: 0.14,
          transmission: 0.92,
          ior: 1.49,
          thickness: 0.06,
          roughness: 0.08,
          metalness: 0,
          clearcoat: 1,
          clearcoatRoughness: 0.04,
          envMapIntensity: 1.35,
          depthWrite: false,
        }),
      )
      cover.position.z = 0.68
      cover.renderOrder = 20
      this.scene.add(cover)
    }

    const startLabel = createLabelSprite(
      'S',
      this.project.visualTheme.startColor,
    )
    startLabel.position.set(this.sourcePosition.x, this.sourcePosition.y, 0.76)
    const endLabel = createLabelSprite('E', this.project.visualTheme.endColor)
    endLabel.position.set(this.exitPosition.x, this.exitPosition.y, 0.76)
    this.scene.add(startLabel, endLabel)
  }

  private addWaterSurface() {
    const graph = this.project.mazeGraph
    const surface = new THREE.Mesh(
      new THREE.PlaneGeometry(graph.cols, graph.rows, 1, 1),
      this.waterSurfaceMaterial,
    )
    surface.position.z = 0.16
    surface.renderOrder = 5
    this.scene.add(surface)
  }

  private createWaterParticleMaterial() {
    return new THREE.MeshPhysicalMaterial({
      color: 0x23baf2,
      roughness: 0.05,
      metalness: 0,
      transmission: this.quality === 'high' ? 0.26 : 0,
      ior: 1.333,
      thickness: 0.14,
      clearcoat: 1,
      clearcoatRoughness: 0.03,
      transparent: true,
      opacity: 0.88,
      depthWrite: false,
      envMapIntensity: 1.3,
    })
  }

  private addReservoirAndStreams() {
    const graph = this.project.mazeGraph
    const topEdge = graph.rows / 2
    const reservoirY = topEdge + 0.72
    const glassMaterial = new THREE.MeshPhysicalMaterial({
      color: 0xf6fdff,
      transparent: true,
      opacity: this.quality === 'high' ? 0.24 : 0.42,
      transmission: this.quality === 'high' ? 0.82 : 0,
      ior: 1.49,
      thickness: 0.16,
      roughness: 0.1,
      clearcoat: 1,
      depthWrite: false,
      envMapIntensity: 1.25,
    })
    const reservoir = new THREE.Mesh(
      new RoundedBoxGeometry(1.5, 0.72, 0.5, 4, 0.12),
      glassMaterial,
    )
    reservoir.position.set(this.sourcePosition.x, reservoirY, 0.23)
    reservoir.renderOrder = 14
    this.scene.add(reservoir)

    const waterMaterial = this.createWaterParticleMaterial()
    const reservoirWater = new THREE.Mesh(
      new RoundedBoxGeometry(1.25, 0.4, 0.3, 4, 0.09),
      waterMaterial,
    )
    reservoirWater.position.set(
      this.sourcePosition.x,
      reservoirY - 0.06,
      0.24,
    )
    reservoirWater.renderOrder = 6
    this.scene.add(reservoirWater)

    const nozzleMaterial = new THREE.MeshPhysicalMaterial({
      color: 0xdde6e9,
      roughness: 0.18,
      metalness: 0.72,
      clearcoat: 0.46,
      envMapIntensity: 1.45,
    })
    const nozzle = new THREE.Mesh(
      new THREE.CylinderGeometry(
        0.095,
        0.12,
        0.38,
        this.quality === 'high' ? 20 : 10,
      ),
      nozzleMaterial,
    )
    nozzle.position.set(this.sourcePosition.x, topEdge + 0.2, 0.29)
    nozzle.castShadow = this.quality === 'high'
    this.scene.add(nozzle)

    const inletJet = new THREE.Mesh(
      new THREE.CylinderGeometry(
        0.055,
        0.095,
        1,
        this.quality === 'high' ? 18 : 8,
      ),
      waterMaterial.clone(),
    )
    inletJet.renderOrder = 8
    this.scene.add(inletJet)

    const outletJet = new THREE.Mesh(
      new THREE.CylinderGeometry(
        0.1,
        0.055,
        1,
        this.quality === 'high' ? 18 : 8,
      ),
      waterMaterial.clone(),
    )
    outletJet.renderOrder = 8
    this.scene.add(outletJet)

    const tray = new THREE.Mesh(
      new RoundedBoxGeometry(1.25, 0.23, 0.5, 4, 0.08),
      new THREE.MeshStandardMaterial({
        color: 0xf2f5f3,
        roughness: 0.34,
        metalness: 0.04,
      }),
    )
    tray.position.set(
      this.exitPosition.x,
      -graph.rows / 2 - 1.12,
      0.03,
    )
    tray.receiveShadow = true
    tray.castShadow = this.quality === 'high'
    this.scene.add(tray)

    return { inletJet, outletJet, reservoirWater }
  }

  private addParticleSystems() {
    const dropletGeometry = new THREE.SphereGeometry(
      0.075,
      this.quality === 'high' ? 12 : 6,
      this.quality === 'high' ? 9 : 5,
    )
    const waterMaterial = this.createWaterParticleMaterial()
    const inletCount = this.quality === 'high' ? 34 : 12
    const outletCount = this.quality === 'high' ? 42 : 14
    const splashCount = this.quality === 'high' ? 38 : 10
    const bubbleCount = Math.min(
      this.quality === 'high' ? 180 : 48,
      Math.max(12, this.reachableCells.length),
    )

    const inletDroplets = new THREE.InstancedMesh(
      dropletGeometry,
      waterMaterial,
      inletCount,
    )
    inletDroplets.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    inletDroplets.renderOrder = 9
    this.scene.add(inletDroplets)

    const outletDroplets = new THREE.InstancedMesh(
      dropletGeometry.clone(),
      waterMaterial.clone(),
      outletCount,
    )
    outletDroplets.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    outletDroplets.renderOrder = 9
    this.scene.add(outletDroplets)

    const foamMaterial = new THREE.MeshPhysicalMaterial({
      color: 0xd9fbff,
      roughness: 0.1,
      transmission: this.quality === 'high' ? 0.18 : 0,
      transparent: true,
      opacity: 0.84,
      depthWrite: false,
      clearcoat: 1,
    })
    const splashDroplets = new THREE.InstancedMesh(
      dropletGeometry.clone(),
      foamMaterial,
      splashCount,
    )
    splashDroplets.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    splashDroplets.renderOrder = 11
    this.scene.add(splashDroplets)

    const bubbleGeometry = new THREE.SphereGeometry(
      0.025,
      this.quality === 'high' ? 8 : 5,
      this.quality === 'high' ? 6 : 4,
    )
    const bubbleMaterial = new THREE.MeshPhysicalMaterial({
      color: 0xf3fdff,
      roughness: 0.04,
      transmission: this.quality === 'high' ? 0.72 : 0,
      transparent: true,
      opacity: 0.62,
      depthWrite: false,
      clearcoat: 1,
    })
    const bubbles = new THREE.InstancedMesh(
      bubbleGeometry,
      bubbleMaterial,
      bubbleCount,
    )
    bubbles.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    bubbles.renderOrder = 12
    this.scene.add(bubbles)

    const inletSeeds = createParticleSeeds(inletCount, 11)
    const outletSeeds = createParticleSeeds(outletCount, 29)
    const splashSeeds = createParticleSeeds(splashCount, 47)
    const bubbleSeeds: BubbleSeed[] = createParticleSeeds(
      bubbleCount,
      71,
    ).map((seed, index) => ({
      ...seed,
      cell:
        this.reachableCells[
          Math.floor(
            seededUnit(index, 83) * Math.max(1, this.reachableCells.length),
          )
        ] ?? this.reachableCells[0],
    }))

    return {
      inletDroplets,
      outletDroplets,
      splashDroplets,
      bubbles,
      inletSeeds,
      outletSeeds,
      splashSeeds,
      bubbleSeeds,
    }
  }

  private hideParticle(mesh: THREE.InstancedMesh, index: number) {
    this.particleDummy.position.set(0, 0, -20)
    this.particleDummy.rotation.set(0, 0, 0)
    this.particleDummy.scale.setScalar(0.001)
    this.particleDummy.updateMatrix()
    mesh.setMatrixAt(index, this.particleDummy.matrix)
  }

  private resetEffects() {
    this.inletJet.scale.set(1, 0.001, 1)
    this.outletJet.scale.set(1, 0.001, 1)
    this.outletJet.visible = false
    for (let index = 0; index < this.inletSeeds.length; index += 1) {
      this.hideParticle(this.inletDroplets, index)
    }
    for (let index = 0; index < this.outletSeeds.length; index += 1) {
      this.hideParticle(this.outletDroplets, index)
    }
    for (let index = 0; index < this.splashSeeds.length; index += 1) {
      this.hideParticle(this.splashDroplets, index)
    }
    for (let index = 0; index < this.bubbleSeeds.length; index += 1) {
      this.hideParticle(this.bubbles, index)
    }
    this.inletDroplets.instanceMatrix.needsUpdate = true
    this.outletDroplets.instanceMatrix.needsUpdate = true
    this.splashDroplets.instanceMatrix.needsUpdate = true
    this.bubbles.instanceMatrix.needsUpdate = true
  }

  private updateStreams(now: number) {
    const graph = this.project.mazeGraph
    const topEdge = graph.rows / 2
    const pourIn = smoothstep(0, 360, this.elapsedMs)
    const pourOut = 1 - smoothstep(this.completeAt - 480, this.completeAt, this.elapsedMs)
    const inletStrength = pourIn * pourOut
    const inletLength = 0.7 * inletStrength
    this.inletJet.scale.set(
      0.9 + Math.sin(now * 0.012) * 0.08,
      Math.max(0.001, inletLength),
      1.1 - Math.sin(now * 0.012) * 0.08,
    )
    this.inletJet.position.set(
      this.sourcePosition.x,
      topEdge + 0.01 - inletLength / 2,
      0.3,
    )
    this.inletJet.visible = inletStrength > 0.01

    const outletStart = this.model.exitArrivalMs ?? Number.MAX_SAFE_INTEGER
    const outletStrength =
      smoothstep(outletStart, outletStart + 320, this.elapsedMs) *
      (1 - smoothstep(this.completeAt - 320, this.completeAt, this.elapsedMs))
    const outletLength = 0.88 * outletStrength
    this.outletJet.scale.set(
      0.9 + Math.sin(now * 0.009) * 0.1,
      Math.max(0.001, outletLength),
      1.1 - Math.sin(now * 0.009) * 0.1,
    )
    this.outletJet.position.set(
      this.exitPosition.x,
      -graph.rows / 2 - outletLength / 2,
      0.28,
    )
    this.outletJet.visible = outletStrength > 0.01

    const reservoirPulse = 1 + Math.sin(now * 0.004) * 0.025
    const reservoirLevel = 1 - smoothstep(
      this.completeAt - 620,
      this.completeAt,
      this.elapsedMs,
    ) * 0.18
    this.reservoirWater.scale.set(
      reservoirPulse,
      reservoirLevel,
      2 - reservoirPulse,
    )
  }

  private updateInletParticles(now: number) {
    const graph = this.project.mazeGraph
    const topEdge = graph.rows / 2
    const pourStrength =
      smoothstep(0, 260, this.elapsedMs) *
      (1 - smoothstep(this.completeAt - 420, this.completeAt, this.elapsedMs))
    for (let index = 0; index < this.inletSeeds.length; index += 1) {
      const seed = this.inletSeeds[index]
      if (pourStrength < 0.02) {
        this.hideParticle(this.inletDroplets, index)
        continue
      }
      const phase = (this.elapsedMs * 0.0024 + seed.phase) % 1
      const y = topEdge + 0.14 - phase * 0.86
      this.particleDummy.position.set(
        this.sourcePosition.x +
          seed.drift * 0.07 +
          Math.sin(now * 0.007 + index) * 0.018,
        y,
        0.28 + seed.depth * 0.075,
      )
      this.particleDummy.rotation.set(0, 0, seed.drift * 0.12)
      this.particleDummy.scale.set(
        seed.size * pourStrength,
        seed.size * (1.1 + phase * 0.9) * pourStrength,
        seed.size * 0.8 * pourStrength,
      )
      this.particleDummy.updateMatrix()
      this.inletDroplets.setMatrixAt(index, this.particleDummy.matrix)
    }
    this.inletDroplets.instanceMatrix.needsUpdate = true
  }

  private updateSplashParticles() {
    const graph = this.project.mazeGraph
    const topEdge = graph.rows / 2
    const active =
      smoothstep(120, 420, this.elapsedMs) *
      (1 - smoothstep(this.completeAt - 360, this.completeAt, this.elapsedMs))
    for (let index = 0; index < this.splashSeeds.length; index += 1) {
      const seed = this.splashSeeds[index]
      if (active < 0.02) {
        this.hideParticle(this.splashDroplets, index)
        continue
      }
      const phase = (this.elapsedMs * 0.00165 + seed.phase) % 1
      const arc = Math.sin(phase * Math.PI)
      this.particleDummy.position.set(
        this.sourcePosition.x + seed.drift * phase * 0.42,
        topEdge - 0.18 + arc * seed.lift * 0.22 - phase * 0.22,
        0.32 + seed.depth * 0.12 + arc * 0.13,
      )
      this.particleDummy.rotation.set(0, 0, seed.drift * phase)
      const fade = Math.sin(phase * Math.PI) * active
      this.particleDummy.scale.setScalar(
        Math.max(0.001, seed.size * fade * 0.75),
      )
      this.particleDummy.updateMatrix()
      this.splashDroplets.setMatrixAt(index, this.particleDummy.matrix)
    }
    this.splashDroplets.instanceMatrix.needsUpdate = true
  }

  private updateOutletParticles() {
    const graph = this.project.mazeGraph
    const bottomEdge = -graph.rows / 2
    const outletStart = this.model.exitArrivalMs ?? Number.MAX_SAFE_INTEGER
    const outletStrength =
      smoothstep(outletStart, outletStart + 320, this.elapsedMs) *
      (1 - smoothstep(this.completeAt - 280, this.completeAt, this.elapsedMs))
    for (let index = 0; index < this.outletSeeds.length; index += 1) {
      const seed = this.outletSeeds[index]
      if (outletStrength < 0.02) {
        this.hideParticle(this.outletDroplets, index)
        continue
      }
      const phase =
        ((this.elapsedMs - outletStart) * 0.0018 + seed.phase + 10) % 1
      const fan = Math.sin(phase * Math.PI)
      this.particleDummy.position.set(
        this.exitPosition.x + seed.drift * fan * 0.32,
        bottomEdge - 0.12 - phase * (0.78 + seed.lift * 0.18),
        0.27 + seed.depth * 0.11 + fan * 0.1,
      )
      this.particleDummy.rotation.set(0, 0, seed.drift * 0.45)
      const fade = Math.sin(phase * Math.PI) * outletStrength
      this.particleDummy.scale.set(
        seed.size * fade,
        seed.size * fade * (1.1 + phase),
        seed.size * fade * 0.82,
      )
      this.particleDummy.updateMatrix()
      this.outletDroplets.setMatrixAt(index, this.particleDummy.matrix)
    }
    this.outletDroplets.instanceMatrix.needsUpdate = true
  }

  private updateBubbles(now: number) {
    for (let index = 0; index < this.bubbleSeeds.length; index += 1) {
      const seed = this.bubbleSeeds[index]
      const arrival = seed.cell?.arrivalMs
      if (
        arrival === null ||
        arrival === undefined ||
        this.elapsedMs < arrival + 80
      ) {
        this.hideParticle(this.bubbles, index)
        continue
      }
      const drainStart =
        (this.model.exitArrivalMs ?? Number.MAX_SAFE_INTEGER) +
        this.model.options.drainDelayMs
      const drained =
        seed.cell.retainedLevel < 0.2 &&
        this.elapsedMs >
          drainStart + this.model.options.drainDurationMs * 0.72
      if (drained) {
        this.hideParticle(this.bubbles, index)
        continue
      }
      const position = cellScenePosition(
        this.project.mazeGraph,
        seed.cell.position,
      )
      const phase = (this.elapsedMs * 0.00042 + seed.phase) % 1
      this.particleDummy.position.set(
        position.x +
          seed.drift * 0.22 +
          Math.sin(now * 0.002 + index) * 0.045,
        position.y - 0.27 + phase * 0.52,
        0.22 + seed.depth * 0.08,
      )
      this.particleDummy.rotation.set(0, 0, 0)
      const pulse = 0.62 + Math.sin(now * 0.006 + index) * 0.16
      this.particleDummy.scale.setScalar(seed.size * pulse)
      this.particleDummy.updateMatrix()
      this.bubbles.setMatrixAt(index, this.particleDummy.matrix)
    }
    this.bubbles.instanceMatrix.needsUpdate = true
  }

  private updateEffects(now: number) {
    this.updateStreams(now)
    if (now - this.lastParticleAt < (this.quality === 'high' ? 24 : 44)) return
    this.lastParticleAt = now
    this.updateInletParticles(now)
    this.updateSplashParticles()
    this.updateOutletParticles()
    this.updateBubbles(now)
  }

  private emitStatus(now: number) {
    if (now - this.lastStatusAt < 140) return
    this.lastStatusAt = now
    while (
      this.visibleCursor < this.reachableCells.length &&
      (this.reachableCells[this.visibleCursor].arrivalMs ?? Number.MAX_SAFE_INTEGER) <=
        this.elapsedMs
    ) {
      this.visibleCursor += 1
    }
    const complete = this.elapsedMs >= this.completeAt
    this.onStatus({
      elapsedMs: this.elapsedMs,
      filledCells: this.visibleCursor,
      totalCells: this.reachableCells.length,
      reachedExit:
        this.model.exitArrivalMs !== null &&
        this.elapsedMs >= this.model.exitArrivalMs,
      complete,
    })
  }

  private emitMetrics() {
    if (this.metricsEmitted || this.renderer.info.render.calls < 1) return
    this.metricsEmitted = true
    this.onMetrics({
      atlasWidth: this.timeline.width,
      atlasHeight: this.timeline.height,
      drawCalls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
    })
  }

  private fitCamera() {
    const graph = this.project.mazeGraph
    const boardWidth = graph.cols + 1.8
    const boardHeight = graph.rows + 3.6
    const verticalFov = THREE.MathUtils.degToRad(this.camera.fov)
    const horizontalFov =
      2 *
      Math.atan(
        Math.tan(verticalFov / 2) * Math.max(0.2, this.camera.aspect),
      )
    const distanceForHeight = boardHeight / (2 * Math.tan(verticalFov / 2))
    const distanceForWidth = boardWidth / (2 * Math.tan(horizontalFov / 2))
    const distance = Math.max(distanceForHeight, distanceForWidth) * 1.035
    const isNarrow = this.camera.aspect < 0.72
    this.camera.position.set(
      isNarrow ? boardWidth * 0.025 : boardWidth * 0.065,
      boardHeight * 0.015,
      distance,
    )
    this.controls.target.set(0, 0, 0.08)
    this.camera.lookAt(this.controls.target)
    this.initialCameraPosition.copy(this.camera.position)
    this.initialTarget.copy(this.controls.target)
  }

  private resize() {
    const width = Math.max(1, this.mount.clientWidth)
    const height = Math.max(1, this.mount.clientHeight)
    const nextAspect = width / height
    const shouldRefit =
      this.lastAspect === 0 || Math.abs(nextAspect - this.lastAspect) > 0.08
    this.lastAspect = nextAspect
    this.renderer.setSize(width, height, false)
    this.camera.aspect = nextAspect
    this.camera.updateProjectionMatrix()
    if (shouldRefit) this.fitCamera()
  }

  private tick = () => {
    if (this.disposed) return
    this.frameId = requestAnimationFrame(this.tick)
    // Advance by wall time, not frame count. A tight 50 ms cap made the water
    // run in slow motion on low-FPS mobile GPUs and software WebGL.
    const deltaMs = Math.min(5_000, this.clock.getDelta() * 1_000)
    if (!this.paused) {
      this.elapsedMs = Math.min(
        this.completeAt,
        this.elapsedMs + deltaMs * this.speed,
      )
    }
    const now = performance.now()
    this.waterSurfaceMaterial.uniforms.uTime.value = this.elapsedMs
    this.waterSurfaceMaterial.uniforms.uCameraPosition.value.copy(
      this.camera.position,
    )
    this.updateEffects(now)
    this.controls.update()
    this.renderer.render(this.scene, this.camera)
    this.emitMetrics()
    this.emitStatus(now)

    if (
      this.reducedMotion &&
      this.elapsedMs >= this.completeAt &&
      now - this.lastCameraInteractionAt > 500
    ) {
      this.paused = true
    }
  }
}
