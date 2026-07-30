import {
  ArrowDown,
  Gauge,
  Pause,
  Play,
  RotateCcw,
  Scan,
  Waves,
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { Modal } from '../../components/Modal'
import {
  getActiveCell,
  getVisualOpeningDirection,
  type CellPosition,
  type MazeGraph,
  type MazeProject,
  type WallDirection,
} from '../../core/maze'
import {
  buildWaterSimulation,
  type WaterCellSchedule,
  type WaterSimulationModel,
} from './waterModel'

export type WaterEffectQuality = 'auto' | 'low' | 'high'

interface WaterSimulationDialogProps {
  open: boolean
  project: MazeProject
  quality: WaterEffectQuality
  onClose: () => void
}

interface WaterPlaybackStatus {
  elapsedMs: number
  filledCells: number
  totalCells: number
  reachedExit: boolean
  complete: boolean
}

interface WallSpec {
  x: number
  y: number
  width: number
  height: number
}

type ReachableWaterCell = WaterCellSchedule & {
  reachable: true
  arrivalMs: number
  fullMs: number
  order: number
}

interface WaterInstance {
  cell: ReachableWaterCell
  instanceIndex: number
}

const EMPTY_STATUS: WaterPlaybackStatus = {
  elapsedMs: 0,
  filledCells: 0,
  totalCells: 0,
  reachedExit: false,
  complete: false,
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value))

const positionKey = ({ row, col }: CellPosition) => `${row}:${col}`

const openingKey = (position: CellPosition, direction: WallDirection | null) =>
  direction ? `${positionKey(position)}:${direction}` : ''

const cellScenePosition = (graph: MazeGraph, position: CellPosition) => ({
  x: position.col - graph.cols / 2 + 0.5,
  y: graph.rows / 2 - position.row - 0.5,
})

const resolveQuality = (quality: WaterEffectQuality): 'low' | 'high' => {
  if (quality !== 'auto') return quality
  if (typeof navigator === 'undefined') return 'low'
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory
  return navigator.hardwareConcurrency <= 4 || (memory !== undefined && memory <= 4)
    ? 'low'
    : 'high'
}

const isReachableWaterCell = (
  cell: WaterCellSchedule,
): cell is ReachableWaterCell =>
  cell.reachable &&
  cell.arrivalMs !== null &&
  cell.fullMs !== null &&
  cell.order !== null &&
  Number.isFinite(cell.arrivalMs) &&
  Number.isFinite(cell.fullMs)

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
  ) => {
    if (!openings.has(openingKey(position, direction))) {
      walls.push({ x, y, width, height })
    }
  }

  for (const cell of graph.cells) {
    if (!cell.active) continue
    const { x, y } = cellScenePosition(graph, cell)
    if (cell.walls.top) addWall(cell, 'top', x, y + 0.5, 1.06, 0.075)
    if (cell.walls.left) addWall(cell, 'left', x - 0.5, y, 0.075, 1.06)

    const right = getActiveCell(graph, { row: cell.row, col: cell.col + 1 })
    if (!right && cell.walls.right) {
      addWall(cell, 'right', x + 0.5, y, 0.075, 1.06)
    }
    const bottom = getActiveCell(graph, { row: cell.row + 1, col: cell.col })
    if (!bottom && cell.walls.bottom) {
      addWall(cell, 'bottom', x, y - 0.5, 1.06, 0.075)
    }
  }
  return walls
}

const createTextSprite = (text: string, fill: string) => {
  const canvas = document.createElement('canvas')
  canvas.width = 128
  canvas.height = 128
  const context = canvas.getContext('2d')
  if (context) {
    context.clearRect(0, 0, 128, 128)
    context.fillStyle = fill
    context.beginPath()
    context.arc(64, 64, 49, 0, Math.PI * 2)
    context.fill()
    context.lineWidth = 7
    context.strokeStyle = 'rgba(255,255,255,.94)'
    context.stroke()
    context.fillStyle = '#ffffff'
    context.font = '800 62px system-ui, sans-serif'
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
  sprite.scale.set(0.78, 0.78, 1)
  sprite.renderOrder = 10
  return sprite
}

class WaterSceneRuntime {
  private readonly scene = new THREE.Scene()
  private readonly camera = new THREE.PerspectiveCamera(34, 1, 0.1, 2_000)
  private readonly renderer: THREE.WebGLRenderer
  private readonly controls: OrbitControls
  private readonly resizeObserver: ResizeObserver
  private readonly clock = new THREE.Clock()
  private readonly waterMesh: THREE.InstancedMesh
  private readonly waterInstances: WaterInstance[]
  private readonly nozzleStream: THREE.Mesh
  private readonly exitStream: THREE.Mesh
  private readonly waterDummy = new THREE.Object3D()
  private readonly initialCameraPosition = new THREE.Vector3()
  private readonly initialTarget = new THREE.Vector3()
  private frameId = 0
  private elapsedMs = 0
  private speed = 1
  private paused = false
  private requestedPaused = false
  private disposed = false
  private visibleCursor = 0
  private activeInstances = new Set<number>()
  private lastStatusAt = -Infinity
  private exitSplash = 0
  private lastAspect = 0

  constructor(
    private readonly mount: HTMLDivElement,
    private readonly project: MazeProject,
    private readonly model: WaterSimulationModel,
    quality: 'low' | 'high',
    private readonly onStatus: (status: WaterPlaybackStatus) => void,
    private readonly onError: (message: string) => void,
    reducedMotion: boolean,
  ) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: quality === 'high',
      alpha: false,
      powerPreference: quality === 'high' ? 'high-performance' : 'low-power',
    })
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.08
    this.renderer.setPixelRatio(
      Math.min(window.devicePixelRatio || 1, quality === 'high' ? 2 : 1.25),
    )
    this.renderer.setClearColor(0x07131f, 1)
    this.renderer.domElement.className = 'water-simulation-canvas'
    this.renderer.domElement.setAttribute('aria-hidden', 'true')
    this.renderer.domElement.addEventListener(
      'webglcontextlost',
      this.handleContextLost,
      false,
    )
    this.mount.replaceChildren(this.renderer.domElement)

    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = !reducedMotion
    this.controls.dampingFactor = 0.07
    this.controls.enablePan = true
    this.controls.minDistance = 4
    this.controls.maxDistance = Math.max(project.mazeGraph.rows, project.mazeGraph.cols) * 4
    this.controls.rotateSpeed = 0.52
    this.controls.zoomSpeed = 0.8
    this.controls.panSpeed = 0.7

    this.addEnvironment()
    this.addMaze(quality)
    const water = this.addWater(quality)
    this.waterMesh = water.mesh
    this.waterInstances = water.instances
    const streams = this.addStreams(quality)
    this.nozzleStream = streams.nozzle
    this.exitStream = streams.exit
    this.resetWaterInstances()

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
    this.activeInstances.clear()
    this.exitSplash = 0
    this.paused = false
    this.requestedPaused = false
    this.resetWaterInstances()
    this.onStatus({
      elapsedMs: 0,
      filledCells: 0,
      totalCells: this.waterInstances.length,
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

  private addEnvironment() {
    this.scene.fog = new THREE.FogExp2(0x07131f, 0.009)
    this.scene.add(new THREE.HemisphereLight(0xccecff, 0x142235, 2.1))
    const keyLight = new THREE.DirectionalLight(0xffffff, 3.3)
    keyLight.position.set(-8, 14, 18)
    this.scene.add(keyLight)
    const rimLight = new THREE.DirectionalLight(0x3ab8ff, 2.1)
    rimLight.position.set(14, -5, 10)
    this.scene.add(rimLight)

    const graph = this.project.mazeGraph
    const backdrop = new THREE.Mesh(
      new THREE.PlaneGeometry(graph.cols * 2.2, graph.rows * 2.2),
      new THREE.MeshBasicMaterial({
        color: 0x081726,
        transparent: true,
        opacity: 0.92,
      }),
    )
    backdrop.position.z = -0.42
    this.scene.add(backdrop)
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

  private addMaze(quality: 'low' | 'high') {
    const graph = this.project.mazeGraph
    const activeCells = graph.cells.filter((cell) => cell.active)
    const plateGeometry = new THREE.BoxGeometry(0.96, 0.96, 0.1)
    const plateMaterial =
      quality === 'high'
        ? new THREE.MeshPhysicalMaterial({
            color: 0xa8dce9,
            transparent: true,
            opacity: 0.19,
            transmission: 0.46,
            roughness: 0.18,
            metalness: 0,
            clearcoat: 0.8,
            depthWrite: false,
          })
        : new THREE.MeshStandardMaterial({
            color: 0x92c9d8,
            transparent: true,
            opacity: 0.2,
            roughness: 0.34,
            depthWrite: false,
          })
    const plates = new THREE.InstancedMesh(
      plateGeometry,
      plateMaterial,
      activeCells.length,
    )
    const dummy = new THREE.Object3D()
    activeCells.forEach((cell, index) => {
      const { x, y } = cellScenePosition(graph, cell)
      dummy.position.set(x, y, -0.11)
      dummy.scale.set(1, 1, 1)
      dummy.updateMatrix()
      plates.setMatrixAt(index, dummy.matrix)
    })
    plates.instanceMatrix.needsUpdate = true
    plates.renderOrder = 1
    this.scene.add(plates)

    const wallSpecs = collectWallSpecs(
      graph,
      this.project.startCell,
      this.project.endCell,
    )
    const wallGeometry = new THREE.BoxGeometry(1, 1, 0.54)
    const wallMaterial =
      quality === 'high'
        ? new THREE.MeshPhysicalMaterial({
            color: 0xd7f4fb,
            transparent: true,
            opacity: 0.64,
            transmission: 0.3,
            roughness: 0.12,
            metalness: 0.02,
            clearcoat: 1,
          })
        : new THREE.MeshStandardMaterial({
            color: 0xbfe8f2,
            transparent: true,
            opacity: 0.72,
            roughness: 0.24,
          })
    const walls = new THREE.InstancedMesh(
      wallGeometry,
      wallMaterial,
      wallSpecs.length,
    )
    wallSpecs.forEach((wall, index) => {
      dummy.position.set(wall.x, wall.y, 0.13)
      dummy.scale.set(wall.width, wall.height, 1)
      dummy.updateMatrix()
      walls.setMatrixAt(index, dummy.matrix)
    })
    walls.instanceMatrix.needsUpdate = true
    walls.renderOrder = 3
    this.scene.add(walls)

    const start = cellScenePosition(graph, this.project.startCell)
    const end = cellScenePosition(graph, this.project.endCell)
    const startLabel = createTextSprite('S', this.project.visualTheme.startColor)
    startLabel.position.set(start.x, start.y, 0.74)
    const endLabel = createTextSprite('E', this.project.visualTheme.endColor)
    endLabel.position.set(end.x, end.y, 0.74)
    this.scene.add(startLabel, endLabel)
  }

  private addWater(quality: 'low' | 'high') {
    const graph = this.project.mazeGraph
    const cells = this.model.cells
      .filter(isReachableWaterCell)
      .sort(
        (left, right) =>
          left.arrivalMs - right.arrivalMs ||
          left.order - right.order ||
          left.index - right.index,
      )
    const waterGeometry = new THREE.SphereGeometry(
      0.5,
      quality === 'high' ? 14 : 7,
      quality === 'high' ? 10 : 5,
    )
    const waterMaterial =
      quality === 'high'
        ? new THREE.MeshPhysicalMaterial({
            color: 0x168cf0,
            emissive: 0x073d70,
            emissiveIntensity: 0.34,
            transparent: true,
            opacity: 0.8,
            transmission: 0.18,
            roughness: 0.09,
            metalness: 0,
            clearcoat: 1,
            depthWrite: false,
          })
        : new THREE.MeshStandardMaterial({
            color: 0x188de8,
            emissive: 0x063960,
            emissiveIntensity: 0.24,
            transparent: true,
            opacity: 0.82,
            roughness: 0.2,
            depthWrite: false,
          })
    const mesh = new THREE.InstancedMesh(waterGeometry, waterMaterial, cells.length)
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    mesh.renderOrder = 2
    const instances = cells.map((cell, instanceIndex) => ({
      cell,
      instanceIndex,
    }))
    this.scene.add(mesh)
    return { mesh, instances }
  }

  private addStreams(quality: 'low' | 'high') {
    const graph = this.project.mazeGraph
    const start = cellScenePosition(graph, this.project.startCell)
    const end = cellScenePosition(graph, this.project.endCell)
    const material =
      quality === 'high'
        ? new THREE.MeshPhysicalMaterial({
            color: 0x1b9cff,
            emissive: 0x074c84,
            emissiveIntensity: 0.42,
            transparent: true,
            opacity: 0.85,
            transmission: 0.15,
            roughness: 0.08,
            clearcoat: 1,
          })
        : new THREE.MeshStandardMaterial({
            color: 0x1b9cff,
            emissive: 0x063b65,
            emissiveIntensity: 0.3,
            transparent: true,
            opacity: 0.86,
            roughness: 0.18,
          })
    const nozzle = new THREE.Mesh(
      new THREE.CylinderGeometry(0.1, 0.135, 1.08, quality === 'high' ? 16 : 8),
      material,
    )
    nozzle.position.set(start.x, start.y + 0.92, 0.25)
    nozzle.scale.y = 0.001
    this.scene.add(nozzle)

    const exit = new THREE.Mesh(
      new THREE.CylinderGeometry(0.14, 0.08, 1.34, quality === 'high' ? 16 : 8),
      material.clone(),
    )
    exit.position.set(end.x, end.y - 1.02, 0.22)
    exit.scale.y = 0.001
    this.scene.add(exit)
    return { nozzle, exit }
  }

  private fitCamera() {
    const graph = this.project.mazeGraph
    const boardWidth = graph.cols + 1.4
    const boardHeight = graph.rows + 3.2
    const verticalFov = THREE.MathUtils.degToRad(this.camera.fov)
    const horizontalFov =
      2 *
      Math.atan(
        Math.tan(verticalFov / 2) * Math.max(0.2, this.camera.aspect),
      )
    const distanceForHeight =
      boardHeight / (2 * Math.tan(verticalFov / 2))
    const distanceForWidth =
      boardWidth / (2 * Math.tan(horizontalFov / 2))
    const distance = Math.max(distanceForHeight, distanceForWidth) * 1.08
    this.camera.position.set(
      boardWidth * 0.06,
      boardHeight * 0.015,
      distance,
    )
    this.controls.target.set(0, 0, 0)
    this.camera.lookAt(this.controls.target)
    this.initialCameraPosition.copy(this.camera.position)
    this.initialTarget.copy(this.controls.target)
  }

  private resetWaterInstances() {
    for (const instance of this.waterInstances) {
      const { x, y } = cellScenePosition(
        this.project.mazeGraph,
        instance.cell.position,
      )
      this.waterDummy.position.set(x, y, 0.18)
      this.waterDummy.scale.setScalar(0.001)
      this.waterDummy.updateMatrix()
      this.waterMesh.setMatrixAt(instance.instanceIndex, this.waterDummy.matrix)
    }
    this.waterMesh.instanceMatrix.needsUpdate = true
    this.nozzleStream.scale.y = 0.001
    this.exitStream.scale.y = 0.001
  }

  private setWaterLevel(instance: WaterInstance, level: number, now: number) {
    const { x, y } = cellScenePosition(
      this.project.mazeGraph,
      instance.cell.position,
    )
    const safeLevel = Math.max(0.001, clamp01(level))
    const ripple = 1 + Math.sin(now * 0.006 + instance.cell.order * 0.53) * 0.025
    this.waterDummy.position.set(x, y, 0.18 + safeLevel * 0.045)
    this.waterDummy.scale.set(
      (0.82 + safeLevel * 0.16) * ripple,
      (0.82 + safeLevel * 0.16) / ripple,
      0.2 + safeLevel * 0.22,
    )
    this.waterDummy.updateMatrix()
    this.waterMesh.setMatrixAt(instance.instanceIndex, this.waterDummy.matrix)
  }

  private updateWater(now: number) {
    while (
      this.visibleCursor < this.waterInstances.length &&
      this.waterInstances[this.visibleCursor].cell.arrivalMs <= this.elapsedMs
    ) {
      this.activeInstances.add(this.visibleCursor)
      this.visibleCursor += 1
    }

    let matrixChanged = false
    for (const cursor of [...this.activeInstances]) {
      const instance = this.waterInstances[cursor]
      const fillDuration = Math.max(
        90,
        instance.cell.fullMs - instance.cell.arrivalMs,
      )
      const level = clamp01(
        (this.elapsedMs - instance.cell.arrivalMs) / fillDuration,
      )
      this.setWaterLevel(instance, level, now)
      matrixChanged = true
      if (level >= 1) this.activeInstances.delete(cursor)
    }

    if (
      this.model.exitArrivalMs !== null &&
      this.elapsedMs >=
        this.model.exitArrivalMs + this.model.options.drainDelayMs
    ) {
      const globalDrainStart =
        this.model.exitArrivalMs + this.model.options.drainDelayMs
      for (const instance of this.waterInstances) {
        const drainStart = Math.max(instance.cell.fullMs, globalDrainStart)
        if (this.elapsedMs < drainStart) continue
        const drainProgress = clamp01(
          (this.elapsedMs - drainStart) /
            this.model.options.drainDurationMs,
        )
        const level =
          1 - (1 - instance.cell.retainedLevel) * drainProgress
        this.setWaterLevel(instance, level, now)
        matrixChanged = true
      }
    }

    if (this.model.exitArrivalMs !== null) {
      const exitProgress = clamp01(
        (this.elapsedMs - this.model.exitArrivalMs) / 520,
      )
      this.exitSplash = Math.max(this.exitSplash, exitProgress)
      this.exitStream.scale.y = Math.max(0.001, this.exitSplash)
      this.exitStream.visible = this.exitSplash > 0
      const pulse = 0.92 + Math.sin(now * 0.009) * 0.08
      this.exitStream.scale.x = pulse
      this.exitStream.scale.z = 2 - pulse
    }

    const inletProgress = clamp01(this.elapsedMs / 320)
    this.nozzleStream.scale.y =
      Math.max(0.001, inletProgress) * (0.96 + Math.sin(now * 0.011) * 0.04)
    this.nozzleStream.scale.x = 0.94 + Math.sin(now * 0.008) * 0.06
    this.nozzleStream.scale.z = 2 - this.nozzleStream.scale.x
    if (matrixChanged) this.waterMesh.instanceMatrix.needsUpdate = true
  }

  private emitStatus(now: number) {
    if (now - this.lastStatusAt < 100) return
    this.lastStatusAt = now
    const completeAt = Math.max(
      this.model.totalDurationMs,
      (this.model.exitArrivalMs ?? 0) + 1_000,
    )
    this.onStatus({
      elapsedMs: this.elapsedMs,
      filledCells: this.visibleCursor,
      totalCells: this.waterInstances.length,
      reachedExit:
        this.model.exitArrivalMs !== null &&
        this.elapsedMs >= this.model.exitArrivalMs,
      complete: this.elapsedMs >= completeAt,
    })
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
    const deltaMs = Math.min(50, this.clock.getDelta() * 1_000)
    const completeAt = Math.max(
      this.model.totalDurationMs,
      (this.model.exitArrivalMs ?? 0) + 1_000,
    )
    if (!this.paused) {
      this.elapsedMs = Math.min(completeAt, this.elapsedMs + deltaMs * this.speed)
    }
    const now = performance.now()
    this.updateWater(now)
    this.controls.update()
    this.renderer.render(this.scene, this.camera)
    this.emitStatus(now)
  }
}

export default function WaterSimulationDialog({
  open,
  project,
  quality,
  onClose,
}: WaterSimulationDialogProps) {
  const stageRef = useRef<HTMLDivElement>(null)
  const runtimeRef = useRef<WaterSceneRuntime | null>(null)
  const [status, setStatus] = useState<WaterPlaybackStatus>(EMPTY_STATUS)
  const [paused, setPaused] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [renderState, setRenderState] = useState<
    'initializing' | 'ready' | 'error'
  >('initializing')
  const [errorMessage, setErrorMessage] = useState('')
  const resolvedQuality = useMemo(() => resolveQuality(quality), [quality])
  const reducedMotion = useMemo(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    [],
  )
  const model = useMemo(
    () =>
      buildWaterSimulation(
        project.mazeGraph,
        project.startCell,
        project.endCell,
      ),
    [project.mazeGraph, project.startCell, project.endCell],
  )
  const reachableCellCount = useMemo(
    () => model.cells.filter((cell) => cell.reachable).length,
    [model],
  )

  useEffect(() => {
    if (!open || !stageRef.current) return
    const mount = stageRef.current
    setStatus({ ...EMPTY_STATUS, totalCells: reachableCellCount })
    setPaused(false)
    setRenderState('initializing')
    setErrorMessage('')
    try {
      const runtime = new WaterSceneRuntime(
        mount,
        project,
        model,
        resolvedQuality,
        (next) => {
          setStatus(next)
          if (next.complete) setPaused(true)
        },
        (message) => {
          setRenderState('error')
          setErrorMessage(message)
        },
        reducedMotion,
      )
      runtime.setSpeed(speed)
      runtimeRef.current = runtime
      setRenderState('ready')
    } catch (error) {
      setRenderState('error')
      setErrorMessage(
        error instanceof Error
          ? error.message
          : '이 브라우저에서 3D 화면을 시작할 수 없습니다.',
      )
    }
    return () => {
      runtimeRef.current?.dispose()
      runtimeRef.current = null
    }
  }, [
    model,
    open,
    project,
    reachableCellCount,
    reducedMotion,
    resolvedQuality,
  ])

  useEffect(() => {
    runtimeRef.current?.setSpeed(speed)
  }, [speed])

  useEffect(() => {
    runtimeRef.current?.setPaused(paused)
  }, [paused])

  const restart = useCallback(() => {
    runtimeRef.current?.restart()
    setPaused(false)
  }, [])

  const togglePlayback = () => {
    if (status.complete) {
      restart()
      return
    }
    setPaused((value) => !value)
  }

  const progress =
    status.totalCells > 0
      ? Math.round((status.filledCells / status.totalCells) * 100)
      : 0
  const statusLabel = status.complete
    ? '시뮬레이션 완료'
    : status.reachedExit
      ? '물이 출구로 배출되고 있습니다'
      : paused
        ? '일시정지'
        : status.filledCells > 1
          ? '열린 통로를 따라 분기 중'
          : '상단 입구에서 물을 붓는 중'
  const phase = renderState === 'error'
    ? 'error'
    : status.complete
      ? 'complete'
      : status.reachedExit
        ? 'reached-exit'
        : paused
          ? 'paused'
          : 'pouring'

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="3D 물 미로 시뮬레이션"
      description="S는 최상단 입구, E는 최하단 출구입니다. 물은 정답을 미리 알지 못하고 열린 통로마다 분기하며 중력 방향으로 흐릅니다."
      width="min(1180px, calc(100vw - 24px))"
      className="water-simulation-modal"
      closeLabel="3D 물 시뮬레이션 닫기"
    >
      <div className="water-simulation-shell">
        <div
          ref={stageRef}
          className="water-simulation-stage"
          data-testid="water-simulation-stage"
          data-renderer={renderState}
          data-phase={phase}
          data-quality={resolvedQuality}
          data-start-edge="top"
          data-end-edge="bottom"
          data-filled-cells={status.filledCells}
          data-reached-exit={status.reachedExit}
          role="img"
          aria-label={`${project.title}의 3D 물 흐름. 물이 최상단 시작점에서 최하단 종료점으로 흐릅니다.`}
        >
          <div className="water-direction-badge inlet" aria-hidden="true">
            <strong>S · 입구</strong>
            <span>위에서 물 주입</span>
            <ArrowDown size={16} />
          </div>
          <div className="water-direction-badge outlet" aria-hidden="true">
            <strong>E · 출구</strong>
            <span>아래로 배출</span>
          </div>
          {renderState === 'initializing' && (
            <div className="water-stage-message">
              <Waves size={28} />
              <strong>3D 미로를 만드는 중…</strong>
            </div>
          )}
          {renderState === 'error' && (
            <div className="water-stage-message error" role="alert">
              <strong>3D 화면을 열지 못했습니다.</strong>
              <span>{errorMessage}</span>
            </div>
          )}
        </div>

        <div className="water-simulation-progress" aria-hidden="true">
          <span style={{ width: `${progress}%` }} />
        </div>

        <div className="water-simulation-status">
          <div className="water-status-copy" aria-live="polite">
            <span className={status.reachedExit ? 'reached' : ''}>
              <Waves size={16} />
              {statusLabel}
            </span>
            <small>
              {status.filledCells.toLocaleString()} /{' '}
              {status.totalCells.toLocaleString()} 셀 · {progress}%
            </small>
          </div>
          <div className="water-simulation-controls">
            <button
              className="button secondary"
              onClick={togglePlayback}
              disabled={renderState !== 'ready'}
              aria-label={
                status.complete
                  ? '물을 처음부터 다시 붓기'
                  : paused
                    ? '물 시뮬레이션 재생'
                    : '물 시뮬레이션 일시정지'
              }
            >
              {status.complete ? (
                <RotateCcw size={17} />
              ) : paused ? (
                <Play size={17} />
              ) : (
                <Pause size={17} />
              )}
              {status.complete ? '다시 붓기' : paused ? '계속' : '일시정지'}
            </button>
            <button
              className="button secondary"
              onClick={restart}
              disabled={renderState !== 'ready'}
            >
              <RotateCcw size={17} />
              처음부터
            </button>
            <button
              className="button secondary"
              onClick={() => runtimeRef.current?.resetCamera()}
              disabled={renderState !== 'ready'}
            >
              <Scan size={17} />
              화면 맞춤
            </button>
            <label className="water-speed-control">
              <Gauge size={16} aria-hidden="true" />
              <span>속도</span>
              <select
                aria-label="물 흐름 속도"
                value={speed}
                onChange={(event) => setSpeed(Number(event.target.value))}
              >
                <option value={0.5}>0.5×</option>
                <option value={1}>1×</option>
                <option value={2}>2×</option>
                <option value={4}>4×</option>
              </select>
            </label>
          </div>
        </div>

        <div className="water-simulation-legend">
          <span>
            한 손가락 드래그: 회전
          </span>
          <span>두 손가락: 확대·이동</span>
          <span>
            품질 {resolvedQuality === 'high' ? '고화질' : '절전'}
          </span>
        </div>
      </div>
    </Modal>
  )
}
