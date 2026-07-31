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
import {
  getWaterFlowElapsedMs,
  resolveWaterInletLayout,
  sampleWaterInlet,
  WATER_INLET_IMPACT_MS,
  type WaterInletLayout,
  type WaterInletState,
} from './waterInletVisual'

export interface WaterPlaybackStatus {
  elapsedMs: number
  filledCells: number
  totalCells: number
  reachedExit: boolean
  complete: boolean
  inletState: WaterInletState
  inletVisible: boolean
}

export interface WaterRuntimeMetrics {
  atlasWidth: number
  atlasHeight: number
  drawCalls: number
  triangles: number
  inletDropHeight: number
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
  uniform vec2 uImpactCenter;
  uniform float uImpactStrength;
  uniform float uFlowGate;
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
    float frontNoise =
      valueNoise(channelUv * 1.55 + flow * uTime * 0.00016) * 0.68 +
      valueNoise(channelUv * 0.42 - flow * uTime * 0.00009) * 0.32;
    float frontRipple = sin(
      dot(channelUv, vec2(-flow.y, flow.x) * 4.8) +
      valueNoise(channelUv * 0.31) * 3.4
    ) * 38.0;
    float frontTime =
      uTime + (frontNoise - 0.5) * 210.0 + frontRipple;

    float wet = smoothstep(arrival - 48.0, arrival + 145.0, frontTime);
    float fill = smoothstep(arrival + 20.0, fullAt + 90.0, frontTime);
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
      exp(-pow(frontAge / 108.0, 2.0)) *
      step(arrival, uTime) *
      (1.0 - draining);

    float directionalWave = sin(
      dot(channelUv, flow * 11.0) -
      uTime * 0.0085 +
      valueNoise(channelUv * 0.22) * 4.0
    );
    float crossWave = sin(
      dot(channelUv, vec2(-flow.y, flow.x) * 17.0) +
      uTime * 0.005
    );
    float broadNoise = valueNoise(
      channelUv * 0.58 + flow * uTime * 0.00022
    );
    float fineNoise = valueNoise(
      channelUv * 2.25 - flow * uTime * 0.00072
    );
    float flowStreak = pow(
      max(
        0.0,
        sin(
          dot(channelUv, flow * 5.2) - uTime * 0.008 +
          broadNoise * 4.6
        ) * 0.5 + 0.5
      ),
      6.0
    );
    float impactDistance = length((vUv - uImpactCenter) * uBoardSize);
    float impactPhase = fract(uTime * 0.00128);
    float impactRing = exp(-pow(
      (impactDistance - (0.08 + impactPhase * 0.42)) / 0.045,
      2.0
    )) * (1.0 - impactPhase) * uImpactStrength;
    float impactChurn = sin(
      impactDistance * 34.0 - uTime * 0.022
    ) * exp(-impactDistance * 5.4) * uImpactStrength;
    float surface = directionalWave * 0.44 + crossWave * 0.2 +
      (broadNoise - 0.5) * 1.15 + (fineNoise - 0.5) * 0.32 +
      impactChurn * 0.52;
    vec3 normal = normalize(vec3(
      dFdx(surface) * 1.8,
      dFdy(surface) * 1.8,
      1.0
    ));
    vec3 viewDirection = normalize(uCameraPosition - vWorldPosition);
    float fresnel = pow(1.0 - clamp(dot(normal, viewDirection), 0.0, 1.0), 2.5);
    float studioHighlight = pow(
      max(dot(normal, normalize(vec3(-0.35, 0.58, 0.74))), 0.0),
      11.0
    );

    vec3 shallowCyan = vec3(0.06, 0.82, 0.93);
    vec3 deepCyan = vec3(0.005, 0.41, 0.68);
    vec3 bodyColor = mix(
      shallowCyan,
      deepCyan,
      clamp(0.33 + level * 0.4 + broadNoise * 0.18, 0.0, 1.0)
    );
    bodyColor += vec3(0.05, 0.31, 0.39) * (broadNoise - 0.5) * 0.72;
    bodyColor += vec3(0.55, 0.93, 1.0) * flowStreak * 0.2;
    bodyColor += vec3(0.18, 0.50, 0.66) * fresnel;
    bodyColor += vec3(0.78, 0.96, 1.0) * studioHighlight * 0.46;
    bodyColor = mix(bodyColor, vec3(0.82, 0.985, 1.0), leadingFoam * 0.82);
    bodyColor = mix(bodyColor, vec3(0.28, 0.88, 0.96), impactRing * 0.38);

    float contactRim = smoothstep(0.08, 0.5, mask) -
      smoothstep(0.54, 0.96, mask);
    bodyColor += vec3(0.03, 0.26, 0.46) * contactRim * 0.7;

    float alpha = mask * visibleWater * mix(0.18, 0.91, level);
    alpha *= mix(0.88, 1.04, broadNoise);
    alpha = max(alpha, leadingFoam * mask * 0.9);
    alpha = max(alpha, impactRing * mask * 0.94);
    alpha *= uFlowGate;
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
  schedule.minFilter = THREE.LinearFilter
  schedule.magFilter = THREE.LinearFilter
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
      uImpactCenter: { value: new THREE.Vector2(0.5, 0.5) },
      uImpactStrength: { value: 0 },
      uFlowGate: { value: 0 },
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

interface FallingJetGeometryData {
  ringCount: number
  radialSegments: number
}

function createFallingJetGeometry(
  ringCount: number,
  radialSegments: number,
): THREE.BufferGeometry {
  const vertexCount = ringCount * radialSegments
  const positions = new Float32Array(vertexCount * 3)
  const normals = new Float32Array(vertexCount * 3)
  const uvs = new Float32Array(vertexCount * 2)
  const indices: number[] = []

  for (let ring = 0; ring < ringCount; ring += 1) {
    const verticalUv = ring / Math.max(1, ringCount - 1)
    for (let segment = 0; segment < radialSegments; segment += 1) {
      const vertexIndex = ring * radialSegments + segment
      uvs[vertexIndex * 2] = segment / radialSegments
      uvs[vertexIndex * 2 + 1] = verticalUv
      if (ring < ringCount - 1) {
        const nextSegment = (segment + 1) % radialSegments
        const nextRing = vertexIndex + radialSegments
        const nextRingSegment = ring * radialSegments + nextSegment + radialSegments
        indices.push(
          vertexIndex,
          nextRing,
          ring * radialSegments + nextSegment,
          ring * radialSegments + nextSegment,
          nextRing,
          nextRingSegment,
        )
      }
    }
  }

  const geometry = new THREE.BufferGeometry()
  const positionAttribute = new THREE.BufferAttribute(positions, 3)
  const normalAttribute = new THREE.BufferAttribute(normals, 3)
  positionAttribute.setUsage(THREE.DynamicDrawUsage)
  normalAttribute.setUsage(THREE.DynamicDrawUsage)
  geometry.setAttribute('position', positionAttribute)
  geometry.setAttribute('normal', normalAttribute)
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
  geometry.setIndex(indices)
  geometry.userData.fallingJet = { ringCount, radialSegments }
  return geometry
}

function updateFallingJetGeometry(
  geometry: THREE.BufferGeometry,
  dropHeight: number,
  elapsedMs: number,
  frontProgress: number,
  strength: number,
  radiusScale = 1,
) {
  const data = geometry.userData.fallingJet as FallingJetGeometryData
  const position = geometry.getAttribute('position') as THREE.BufferAttribute
  const normal = geometry.getAttribute('normal') as THREE.BufferAttribute
  const time = elapsedMs / 1_000
  const visibleFront = Math.max(0.001, frontProgress)

  for (let ring = 0; ring < data.ringCount; ring += 1) {
    const streamProgress = ring / Math.max(1, data.ringCount - 1)
    const isAheadOfFront = streamProgress > visibleFront
    const renderedProgress = isAheadOfFront ? visibleFront : streamProgress
    const lowerBreakup = smoothstep(0.66, 1, renderedProgress)
    const centerX =
      Math.sin(time * 7.7 - renderedProgress * 10.8) *
        (0.016 + renderedProgress * 0.024) +
      Math.sin(time * 13.1 - renderedProgress * 19.4) * 0.009
    const centerZ =
      Math.sin(time * 8.9 - renderedProgress * 8.2) *
      (0.009 + renderedProgress * 0.008)
    const radiusNoise =
      Math.sin(time * 9.8 - renderedProgress * 15.2) * 0.065 +
      Math.sin(time * 16.7 + renderedProgress * 21.0) * 0.032
    const baseRadius = THREE.MathUtils.lerp(0.145, 0.098, renderedProgress)
    const pinch = 1 - lowerBreakup * (0.08 + Math.sin(time * 12 + ring) * 0.05)
    const radius = isAheadOfFront
      ? 0.0008
      : baseRadius *
        radiusScale *
        (1 + radiusNoise) *
        pinch *
        (0.8 + strength * 0.2)
    const y = -dropHeight * renderedProgress

    for (let segment = 0; segment < data.radialSegments; segment += 1) {
      const vertexIndex = ring * data.radialSegments + segment
      const angle = (segment / data.radialSegments) * Math.PI * 2
      const cosine = Math.cos(angle)
      const sine = Math.sin(angle)
      position.setXYZ(
        vertexIndex,
        centerX + cosine * radius,
        y,
        centerZ + sine * radius,
      )
      normal.setXYZ(vertexIndex, cosine, 0.08 * lowerBreakup, sine)
    }
  }
  position.needsUpdate = true
  normal.needsUpdate = true
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
  private readonly inletHighlight: THREE.Mesh
  private readonly outletJet: THREE.Mesh
  private readonly reservoirWater: THREE.Mesh
  private readonly impactPool: THREE.Mesh
  private readonly impactRings: THREE.Mesh[]
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
  private readonly inletLayout: WaterInletLayout
  private readonly reachableCells: WaterCellSchedule[]
  private readonly environmentTarget: THREE.WebGLRenderTarget
  private readonly pmremGenerator: THREE.PMREMGenerator
  private readonly completeAt: number
  private readonly introCameraPosition = new THREE.Vector3()
  private readonly introTarget = new THREE.Vector3()
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
  private cameraIntroCancelled = false
  private lastVisualElapsedMs = -1
  private needsRender = true
  private lastStatusSignature = ''

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
    this.inletLayout = resolveWaterInletLayout(
      project.mazeGraph.rows,
      this.sourcePosition.y,
    )
    this.timeline = buildWaterSurfaceTimeline(project.mazeGraph, model, {
      pixelsPerCell: quality === 'high' ? 16 : 5,
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
    this.waterSurfaceMaterial.uniforms.uImpactCenter.value.set(
      (this.sourcePosition.x + project.mazeGraph.cols / 2) /
        project.mazeGraph.cols,
      (this.sourcePosition.y + project.mazeGraph.rows / 2) /
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
      model.totalDurationMs + WATER_INLET_IMPACT_MS,
      (model.exitArrivalMs ?? 0) + WATER_INLET_IMPACT_MS + 1_450,
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
      this.cameraIntroCancelled = true
    })

    this.addEnvironment()
    this.addMaze()
    this.addWaterSurface()
    const streams = this.addReservoirAndStreams()
    this.inletJet = streams.inletJet
    this.inletHighlight = streams.inletHighlight
    this.outletJet = streams.outletJet
    this.reservoirWater = streams.reservoirWater
    this.impactPool = streams.impactPool
    this.impactRings = streams.impactRings

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
    this.needsRender = true
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
    this.lastVisualElapsedMs = -1
    this.lastStatusAt = -Infinity
    this.lastStatusSignature = ''
    this.cameraIntroCancelled = this.reducedMotion
    this.resetEffects()
    this.fitCamera()
    this.onStatus({
      elapsedMs: 0,
      filledCells: 0,
      totalCells: this.reachableCells.length,
      reachedExit: false,
      complete: false,
      inletState: 'off',
      inletVisible: false,
    })
  }

  resetCamera() {
    this.cameraIntroCancelled = true
    this.camera.position.copy(this.initialCameraPosition)
    this.controls.target.copy(this.initialTarget)
    this.controls.update()
    this.needsRender = true
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
          opacity: 0.085,
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
    startLabel.scale.set(0.42, 0.42, 1)
    startLabel.position.set(
      this.sourcePosition.x - 0.3,
      this.sourcePosition.y + 0.27,
      0.76,
    )
    const endLabel = createLabelSprite('E', this.project.visualTheme.endColor)
    endLabel.scale.set(0.42, 0.42, 1)
    endLabel.position.set(
      this.exitPosition.x + 0.3,
      this.exitPosition.y - 0.27,
      0.76,
    )
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
      color: 0x08baf2,
      emissive: 0x0088b8,
      emissiveIntensity: 0.18,
      roughness: 0.05,
      metalness: 0,
      transmission: this.quality === 'high' ? 0.12 : 0,
      ior: 1.333,
      thickness: 0.14,
      clearcoat: 1,
      clearcoatRoughness: 0.03,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      envMapIntensity: 1.3,
    })
  }

  private addReservoirAndStreams() {
    const graph = this.project.mazeGraph
    const { nozzleY, reservoirY, impactY, dropHeight } = this.inletLayout
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
      new RoundedBoxGeometry(1.72, 0.88, 0.56, 4, 0.13),
      glassMaterial,
    )
    reservoir.position.set(this.sourcePosition.x, reservoirY, 0.23)
    reservoir.renderOrder = 14
    this.scene.add(reservoir)

    const waterMaterial = this.createWaterParticleMaterial()
    const reservoirWater = new THREE.Mesh(
      new RoundedBoxGeometry(1.46, 0.48, 0.34, 4, 0.09),
      waterMaterial,
    )
    reservoirWater.position.set(
      this.sourcePosition.x,
      reservoirY - 0.08,
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
        0.11,
        0.14,
        0.44,
        this.quality === 'high' ? 20 : 10,
      ),
      nozzleMaterial,
    )
    nozzle.position.set(this.sourcePosition.x, nozzleY + 0.2, 0.34)
    nozzle.castShadow = this.quality === 'high'
    this.scene.add(nozzle)

    const inletJetMaterial = new THREE.MeshStandardMaterial({
      color: 0x18bfe3,
      roughness: 0.42,
      metalness: 0,
      emissive: 0x006a80,
      emissiveIntensity: 0.1,
      envMapIntensity: 0.22,
      depthWrite: true,
    })
    const inletJet = new THREE.Mesh(
      createFallingJetGeometry(
        this.quality === 'high' ? 28 : 18,
        this.quality === 'high' ? 14 : 8,
      ),
      inletJetMaterial,
    )
    inletJet.position.set(this.sourcePosition.x, nozzleY, 0.36)
    inletJet.frustumCulled = false
    inletJet.renderOrder = 8
    this.scene.add(inletJet)

    const inletHighlight = new THREE.Mesh(
      inletJet.geometry.clone(),
      new THREE.MeshBasicMaterial({
        color: 0xd6faff,
        transparent: true,
        opacity: 0.11,
        depthTest: false,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    )
    inletHighlight.position.copy(inletJet.position)
    inletHighlight.frustumCulled = false
    inletHighlight.renderOrder = 9
    this.scene.add(inletHighlight)

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
    outletJet.frustumCulled = false
    this.scene.add(outletJet)

    const impactPool = new THREE.Mesh(
      new THREE.CircleGeometry(0.34, this.quality === 'high' ? 40 : 20),
      new THREE.MeshStandardMaterial({
        color: 0x1bbfdf,
        roughness: 0.38,
        emissive: 0x006a80,
        emissiveIntensity: 0.08,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      }),
    )
    impactPool.position.set(this.sourcePosition.x, impactY, 0.205)
    impactPool.renderOrder = 7
    this.scene.add(impactPool)

    const impactRings = Array.from({ length: 3 }, (_, index) => {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(
          0.15,
          0.018 + index * 0.004,
          this.quality === 'high' ? 8 : 5,
          this.quality === 'high' ? 40 : 20,
        ),
        new THREE.MeshBasicMaterial({
          color: index === 0 ? 0x8cecff : 0x36c9e6,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          blending: THREE.NormalBlending,
        }),
      )
      ring.position.set(this.sourcePosition.x, impactY, 0.235 + index * 0.003)
      ring.renderOrder = 10
      this.scene.add(ring)
      return ring
    })

    updateFallingJetGeometry(inletJet.geometry, dropHeight, 0, 0, 0)
    updateFallingJetGeometry(inletHighlight.geometry, dropHeight, 0, 0, 0, 0.34)

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

    return {
      inletJet,
      inletHighlight,
      outletJet,
      reservoirWater,
      impactPool,
      impactRings,
    }
  }

  private addParticleSystems() {
    const dropletGeometry = new THREE.SphereGeometry(
      0.075,
      this.quality === 'high' ? 12 : 6,
      this.quality === 'high' ? 9 : 5,
    )
    const waterMaterial = this.createWaterParticleMaterial()
    const inletCount = this.quality === 'high' ? 46 : 14
    const outletCount = this.quality === 'high' ? 42 : 14
    const splashCount = this.quality === 'high' ? 64 : 16
    const bubbleCount = Math.min(
      this.quality === 'high' ? 62 : 22,
      Math.max(10, Math.ceil(this.reachableCells.length * 0.48)),
    )

    const inletDroplets = new THREE.InstancedMesh(
      dropletGeometry,
      waterMaterial,
      inletCount,
    )
    inletDroplets.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    inletDroplets.frustumCulled = false
    inletDroplets.renderOrder = 9
    this.scene.add(inletDroplets)

    const outletDroplets = new THREE.InstancedMesh(
      dropletGeometry.clone(),
      waterMaterial.clone(),
      outletCount,
    )
    outletDroplets.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    outletDroplets.frustumCulled = false
    outletDroplets.renderOrder = 9
    this.scene.add(outletDroplets)

    const foamMaterial = new THREE.MeshStandardMaterial({
      color: 0x62dceb,
      roughness: 0.35,
      metalness: 0,
      emissive: 0x006d7c,
      emissiveIntensity: 0.07,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    })
    const splashDroplets = new THREE.InstancedMesh(
      new THREE.SphereGeometry(
        0.105,
        this.quality === 'high' ? 12 : 6,
        this.quality === 'high' ? 9 : 5,
      ),
      foamMaterial,
      splashCount,
    )
    splashDroplets.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    splashDroplets.frustumCulled = false
    splashDroplets.renderOrder = 11
    this.scene.add(splashDroplets)

    const bubbleGeometry = new THREE.SphereGeometry(
      0.016,
      this.quality === 'high' ? 8 : 5,
      this.quality === 'high' ? 6 : 4,
    )
    const bubbleMaterial = new THREE.MeshPhysicalMaterial({
      color: 0xf3fdff,
      roughness: 0.04,
      transmission: this.quality === 'high' ? 0.72 : 0,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
      clearcoat: 1,
    })
    const bubbles = new THREE.InstancedMesh(
      bubbleGeometry,
      bubbleMaterial,
      bubbleCount,
    )
    bubbles.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    bubbles.frustumCulled = false
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
    this.inletJet.visible = false
    this.inletHighlight.visible = false
    updateFallingJetGeometry(
      this.inletJet.geometry,
      this.inletLayout.dropHeight,
      0,
      0,
      0,
    )
    updateFallingJetGeometry(
      this.inletHighlight.geometry,
      this.inletLayout.dropHeight,
      0,
      0,
      0,
      0.34,
    )
    this.outletJet.scale.set(1, 0.001, 1)
    this.outletJet.visible = false
    this.impactPool.visible = false
    ;(this.impactPool.material as THREE.MeshStandardMaterial).opacity = 0
    for (const ring of this.impactRings) {
      ring.visible = false
      ;(ring.material as THREE.MeshBasicMaterial).opacity = 0
    }
    this.waterSurfaceMaterial.uniforms.uImpactStrength.value = 0
    this.waterSurfaceMaterial.uniforms.uFlowGate.value = 0
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

  private updateStreams() {
    const graph = this.project.mazeGraph
    const inlet = sampleWaterInlet(this.elapsedMs, this.completeAt)
    const flowElapsedMs = getWaterFlowElapsedMs(this.elapsedMs)
    updateFallingJetGeometry(
      this.inletJet.geometry,
      this.inletLayout.dropHeight,
      this.elapsedMs,
      inlet.frontProgress,
      inlet.strength,
    )
    updateFallingJetGeometry(
      this.inletHighlight.geometry,
      this.inletLayout.dropHeight,
      this.elapsedMs,
      inlet.frontProgress,
      inlet.strength,
      0.34,
    )
    this.inletJet.visible = inlet.strength > 0.01
    this.inletHighlight.visible = inlet.strength > 0.01
    this.waterSurfaceMaterial.uniforms.uImpactStrength.value =
      inlet.impactStrength
    this.waterSurfaceMaterial.uniforms.uFlowGate.value = smoothstep(
      WATER_INLET_IMPACT_MS,
      WATER_INLET_IMPACT_MS + 220,
      this.elapsedMs,
    )

    const impactPulse =
      inlet.impactStrength *
      (0.9 + Math.sin(flowElapsedMs * 0.018) * 0.1)
    this.impactPool.visible = impactPulse > 0.01
    this.impactPool.scale.set(
      0.8 + impactPulse * 0.34,
      0.58 + impactPulse * 0.18,
      1,
    )
    ;(this.impactPool.material as THREE.MeshStandardMaterial).opacity =
      impactPulse * 0.24

    for (let index = 0; index < this.impactRings.length; index += 1) {
      const ring = this.impactRings[index]
      const phase =
        ((Math.max(0, flowElapsedMs) * 0.0013 + index / 3) % 1 + 1) % 1
      const burstFade = 1 - smoothstep(
        WATER_INLET_IMPACT_MS + 720,
        WATER_INLET_IMPACT_MS + 1_900,
        this.elapsedMs,
      )
      const ringStrength =
        inlet.impactStrength *
        (0.18 + burstFade * 0.82) *
        Math.sin(phase * Math.PI) *
        (1 - phase * 0.68)
      ring.visible = ringStrength > 0.015
      ring.scale.setScalar(0.55 + phase * 2.15)
      ;(ring.material as THREE.MeshBasicMaterial).opacity = ringStrength * 0.055
    }

    const outletStart = this.model.exitArrivalMs ?? Number.MAX_SAFE_INTEGER
    const outletStrength =
      smoothstep(outletStart, outletStart + 320, flowElapsedMs) *
      (1 - smoothstep(this.completeAt - 320, this.completeAt, this.elapsedMs))
    const outletLength = 0.88 * outletStrength
    this.outletJet.scale.set(
      0.9 + Math.sin(flowElapsedMs * 0.009) * 0.1,
      Math.max(0.001, outletLength),
      1.1 - Math.sin(flowElapsedMs * 0.009) * 0.1,
    )
    this.outletJet.position.set(
      this.exitPosition.x,
      -graph.rows / 2 - outletLength / 2,
      0.28,
    )
    this.outletJet.visible = outletStrength > 0.01

    const reservoirPulse = 1 + Math.sin(this.elapsedMs * 0.004) * 0.025
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

  private updateInletParticles() {
    const inlet = sampleWaterInlet(this.elapsedMs, this.completeAt)
    for (let index = 0; index < this.inletSeeds.length; index += 1) {
      const seed = this.inletSeeds[index]
      if (inlet.strength < 0.02) {
        this.hideParticle(this.inletDroplets, index)
        continue
      }
      const phase = (this.elapsedMs * 0.00182 + seed.phase) % 1
      if (phase > inlet.frontProgress + 0.035) {
        this.hideParticle(this.inletDroplets, index)
        continue
      }
      const gravityProgress = phase * phase
      const y =
        this.inletLayout.nozzleY -
        gravityProgress * this.inletLayout.dropHeight
      this.particleDummy.position.set(
        this.sourcePosition.x +
          seed.drift * (0.022 + gravityProgress * 0.09) +
          Math.sin(this.elapsedMs * 0.007 + index) * 0.014,
        y,
        0.36 + seed.depth * (0.045 + gravityProgress * 0.055),
      )
      this.particleDummy.rotation.set(0, 0, seed.drift * 0.12)
      this.particleDummy.scale.set(
        seed.size * inlet.strength * (0.56 - gravityProgress * 0.1),
        seed.size * (0.85 + gravityProgress * 1.2) * inlet.strength,
        seed.size * 0.52 * inlet.strength,
      )
      this.particleDummy.updateMatrix()
      this.inletDroplets.setMatrixAt(index, this.particleDummy.matrix)
    }
    this.inletDroplets.instanceMatrix.needsUpdate = true
  }

  private updateSplashParticles() {
    const inlet = sampleWaterInlet(this.elapsedMs, this.completeAt)
    const sinceImpactMs = this.elapsedMs - WATER_INLET_IMPACT_MS
    for (let index = 0; index < this.splashSeeds.length; index += 1) {
      const seed = this.splashSeeds[index]
      if (inlet.impactStrength < 0.02 || sinceImpactMs < 0) {
        this.hideParticle(this.splashDroplets, index)
        continue
      }
      const lifetime = 0.48 + seed.lift * 0.22
      const crownCount = this.quality === 'high' ? 20 : 8
      const initialCrown = sinceImpactMs < 700 && index < crownCount
      const phase = initialCrown
        ? clamp01(sinceImpactMs / (520 + seed.phase * 180))
        : ((sinceImpactMs / (lifetime * 1_000) + seed.phase) % 1 + 1) % 1
      const age = phase * lifetime
      const crownDirection =
        crownCount <= 1 ? 0 : (index / (crownCount - 1)) * 2 - 1
      const horizontalVelocity = initialCrown
        ? crownDirection * (1.85 + seed.size * 0.42)
        : seed.drift * (0.58 + seed.size * 0.2)
      const verticalVelocity = initialCrown
        ? 1.72 + (1 - Math.abs(crownDirection)) * 0.72 + seed.lift * 0.22
        : 0.94 + seed.lift * 0.5
      const verticalPosition =
        verticalVelocity * age - 0.5 * (initialCrown ? 5.1 : 4.15) * age * age
      const depthVelocity = seed.depth *
        (initialCrown ? 0.48 : 0.18 + seed.size * 0.08)
      this.particleDummy.position.set(
        this.sourcePosition.x + horizontalVelocity * age,
        this.inletLayout.impactY + verticalPosition,
        0.25 + depthVelocity * age + Math.sin(phase * Math.PI) * 0.13,
      )
      const verticalSpeed =
        verticalVelocity - (initialCrown ? 5.1 : 4.15) * age
      this.particleDummy.rotation.set(
        0,
        0,
        Math.atan2(verticalSpeed, horizontalVelocity) - Math.PI / 2,
      )
      const initialBurst = Math.exp(-Math.max(0, sinceImpactMs) / 700)
      const splashStrength =
        inlet.impactStrength * (0.25 + initialBurst * 0.75)
      const fade = Math.sin(phase * Math.PI) * splashStrength
      this.particleDummy.scale.set(
        Math.max(0.001, seed.size * fade * 0.46),
        Math.max(0.001, seed.size * fade * (0.7 + Math.abs(verticalSpeed) * 0.45)),
        Math.max(0.001, seed.size * fade * 0.42),
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
    const flowElapsedMs = getWaterFlowElapsedMs(this.elapsedMs)
    const outletStrength =
      smoothstep(outletStart, outletStart + 320, flowElapsedMs) *
      (1 - smoothstep(this.completeAt - 280, this.completeAt, this.elapsedMs))
    for (let index = 0; index < this.outletSeeds.length; index += 1) {
      const seed = this.outletSeeds[index]
      if (outletStrength < 0.02) {
        this.hideParticle(this.outletDroplets, index)
        continue
      }
      const phase =
        ((flowElapsedMs - outletStart) * 0.0018 + seed.phase + 10) % 1
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

  private updateBubbles() {
    const flowElapsedMs = getWaterFlowElapsedMs(this.elapsedMs)
    for (let index = 0; index < this.bubbleSeeds.length; index += 1) {
      const seed = this.bubbleSeeds[index]
      const arrival = seed.cell?.arrivalMs
      if (
        arrival === null ||
        arrival === undefined ||
        flowElapsedMs < arrival + 80
      ) {
        this.hideParticle(this.bubbles, index)
        continue
      }
      const drainStart =
        (this.model.exitArrivalMs ?? Number.MAX_SAFE_INTEGER) +
        this.model.options.drainDelayMs
      const drained =
        seed.cell.retainedLevel < 0.2 &&
        flowElapsedMs >
          drainStart + this.model.options.drainDurationMs * 0.72
      if (drained) {
        this.hideParticle(this.bubbles, index)
        continue
      }
      const position = cellScenePosition(
        this.project.mazeGraph,
        seed.cell.position,
      )
      const phase = (flowElapsedMs * 0.00042 + seed.phase) % 1
      this.particleDummy.position.set(
        position.x +
          seed.drift * 0.22 +
          Math.sin(flowElapsedMs * 0.002 + index) * 0.045,
        position.y - 0.27 + phase * 0.52,
        0.22 + seed.depth * 0.08,
      )
      this.particleDummy.rotation.set(0, 0, 0)
      const pulse = 0.62 + Math.sin(flowElapsedMs * 0.006 + index) * 0.16
      this.particleDummy.scale.setScalar(seed.size * pulse)
      this.particleDummy.updateMatrix()
      this.bubbles.setMatrixAt(index, this.particleDummy.matrix)
    }
    this.bubbles.instanceMatrix.needsUpdate = true
  }

  private updateEffects(now: number) {
    this.updateStreams()
    const impactBurstActive =
      this.elapsedMs >= WATER_INLET_IMPACT_MS &&
      this.elapsedMs < WATER_INLET_IMPACT_MS + 1_400
    // The status callback and pause button can land between throttled particle
    // frames. Keep the short impact crown in lockstep with simulation time so
    // a paused collision frame never loses the actual splash.
    if (impactBurstActive) this.updateSplashParticles()
    if (now - this.lastParticleAt < (this.quality === 'high' ? 24 : 44)) return
    this.lastParticleAt = now
    this.updateInletParticles()
    if (!impactBurstActive) this.updateSplashParticles()
    this.updateOutletParticles()
    this.updateBubbles()
  }

  private emitStatus(now: number) {
    if (now - this.lastStatusAt < 140) return
    this.lastStatusAt = now
    const flowElapsedMs = getWaterFlowElapsedMs(this.elapsedMs)
    if (this.elapsedMs >= WATER_INLET_IMPACT_MS) {
      while (
        this.visibleCursor < this.reachableCells.length &&
        (this.reachableCells[this.visibleCursor].arrivalMs ?? Number.MAX_SAFE_INTEGER) <=
          flowElapsedMs
      ) {
        this.visibleCursor += 1
      }
    }
    const complete = this.elapsedMs >= this.completeAt
    const inlet = sampleWaterInlet(this.elapsedMs, this.completeAt)
    const status: WaterPlaybackStatus = {
      elapsedMs: this.elapsedMs,
      filledCells: this.visibleCursor,
      totalCells: this.reachableCells.length,
      reachedExit:
        this.model.exitArrivalMs !== null &&
        flowElapsedMs >= this.model.exitArrivalMs,
      complete,
      inletState: inlet.state,
      inletVisible: inlet.strength > 0.01,
    }
    const signature = [
      Math.round(status.elapsedMs),
      status.filledCells,
      status.reachedExit,
      status.complete,
      status.inletState,
      status.inletVisible,
    ].join(':')
    if (signature === this.lastStatusSignature) return
    this.lastStatusSignature = signature
    this.onStatus(status)
  }

  private emitMetrics() {
    if (this.metricsEmitted || this.renderer.info.render.calls < 1) return
    this.metricsEmitted = true
    this.onMetrics({
      atlasWidth: this.timeline.width,
      atlasHeight: this.timeline.height,
      drawCalls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      inletDropHeight: this.inletLayout.dropHeight,
    })
  }

  private fitCamera() {
    const graph = this.project.mazeGraph
    const boardWidth = graph.cols + 1.8
    const topExtent = this.inletLayout.reservoirY + 0.58
    const bottomExtent = -graph.rows / 2 - 1.42
    const boardHeight = topExtent - bottomExtent
    const sceneCenterY = (topExtent + bottomExtent) / 2
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
      sceneCenterY + boardHeight * 0.008,
      distance,
    )
    this.controls.target.set(0, sceneCenterY, 0.08)
    this.camera.lookAt(this.controls.target)
    this.initialCameraPosition.copy(this.camera.position)
    this.initialTarget.copy(this.controls.target)

    const introHeight = Math.max(4.2, this.inletLayout.dropHeight + 1.7)
    const introDistance =
      (introHeight / (2 * Math.tan(verticalFov / 2))) * 1.04
    const introCenterY =
      (this.inletLayout.nozzleY + this.inletLayout.impactY) / 2 + 0.18
    this.introCameraPosition.set(
      this.sourcePosition.x + 0.12,
      introCenterY,
      introDistance,
    )
    this.introTarget.set(this.sourcePosition.x, introCenterY, 0.16)

    if (
      !this.reducedMotion &&
      !this.cameraIntroCancelled &&
      this.elapsedMs < 2_350
    ) {
      this.camera.position.copy(this.introCameraPosition)
      this.controls.target.copy(this.introTarget)
      this.camera.lookAt(this.controls.target)
    }
  }

  private updateCameraIntro() {
    if (this.reducedMotion || this.cameraIntroCancelled) return
    const progress = smoothstep(520, 2_350, this.elapsedMs)
    this.camera.position.lerpVectors(
      this.introCameraPosition,
      this.initialCameraPosition,
      progress,
    )
    this.controls.target.lerpVectors(
      this.introTarget,
      this.initialTarget,
      progress,
    )
    this.camera.lookAt(this.controls.target)
    if (progress >= 0.999) this.cameraIntroCancelled = true
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
    this.needsRender = true
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
    const visualTimeChanged = this.elapsedMs !== this.lastVisualElapsedMs
    if (visualTimeChanged) {
      this.waterSurfaceMaterial.uniforms.uTime.value =
        getWaterFlowElapsedMs(this.elapsedMs)
      this.updateEffects(now)
      this.updateCameraIntro()
      this.lastVisualElapsedMs = this.elapsedMs
    }
    const controlsChanged = this.controls.update()
    this.emitStatus(now)
    if (!visualTimeChanged && !controlsChanged && !this.needsRender) return
    this.waterSurfaceMaterial.uniforms.uCameraPosition.value.copy(
      this.camera.position,
    )
    this.renderer.render(this.scene, this.camera)
    this.emitMetrics()
    this.needsRender = false

    if (
      this.reducedMotion &&
      this.elapsedMs >= this.completeAt &&
      now - this.lastCameraInteractionAt > 500
    ) {
      this.paused = true
    }
  }
}
