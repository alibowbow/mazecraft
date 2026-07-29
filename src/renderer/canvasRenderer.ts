import { getVisualOpeningDirection } from '../core/maze/graph'
import type { CellWalls, WallDirection } from '../core/maze/types'
import {
  DEFAULT_MAZE_RENDER_THEME,
  isPointInMaze,
  type MazeHit,
  type MazeParticle,
  type MazePoint,
  type MazeRenderFrame,
  type MazeRenderModel,
  type MazeRenderTheme,
  type MazeScreenPoint,
  type MazeViewport,
} from './types'

export interface MazeCanvasRendererOptions {
  theme?: Partial<MazeRenderTheme>
  devicePixelRatio?: number
  fitPadding?: number
  minScale?: number
  maxScale?: number
}

interface StaticLayers {
  floor: HTMLCanvasElement
  walls: HTMLCanvasElement
  cellPixels: number
  floorSignature: string
}

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value))

const createLayerCanvas = (width: number, height: number): HTMLCanvasElement => {
  const layer = document.createElement('canvas')
  layer.width = Math.max(1, Math.ceil(width))
  layer.height = Math.max(1, Math.ceil(height))
  return layer
}

const drawRoundedRect = (
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void => {
  const safeRadius = Math.min(radius, width / 2, height / 2)
  context.beginPath()
  context.roundRect(x, y, width, height, safeRadius)
}

const cellCenter = ({ row, col }: MazePoint): MazeScreenPoint => ({
  x: col + 0.5,
  y: row + 0.5,
})

const isInterpolatedPointVisible = (
  point: MazePoint,
  model: MazeRenderModel,
): boolean =>
  Number.isFinite(point.row) &&
  Number.isFinite(point.col) &&
  point.row >= 0 &&
  point.col >= 0 &&
  point.row <= model.graph.rows - 1 &&
  point.col <= model.graph.cols - 1

const drawPathLine = (
  context: CanvasRenderingContext2D,
  points: ReadonlyArray<MazePoint>,
  color: string,
  width: number,
  opacity = 1,
): void => {
  if (points.length === 0) return
  context.save()
  context.strokeStyle = color
  context.lineWidth = width
  context.lineCap = 'round'
  context.lineJoin = 'round'
  context.globalAlpha = opacity
  context.beginPath()
  const first = cellCenter(points[0])
  context.moveTo(first.x, first.y)
  for (let index = 1; index < points.length; index += 1) {
    const point = cellCenter(points[index])
    context.lineTo(point.x, point.y)
  }
  context.stroke()
  context.restore()
}

/**
 * Imperative Canvas 2D renderer. The graph is never mutated here: resize,
 * viewport gestures and animation frames only change presentation state.
 */
export class MazeCanvasRenderer {
  readonly canvas: HTMLCanvasElement

  private readonly context: CanvasRenderingContext2D
  private model: MazeRenderModel | null = null
  private theme: MazeRenderTheme
  private viewport: MazeViewport = { scale: 20, x: 0, y: 0 }
  private cssWidth = 1
  private cssHeight = 1
  private pixelRatio: number
  private fitPadding: number
  private minScale: number
  private maxScale: number
  private staticLayers: StaticLayers | null = null
  private staticRevision = 0
  private builtRevision = -1
  private hasFitOnce = false

  constructor(canvas: HTMLCanvasElement, options: MazeCanvasRendererOptions = {}) {
    const context = canvas.getContext('2d')
    if (!context) {
      throw new Error('Canvas 2D 컨텍스트를 사용할 수 없습니다.')
    }
    this.canvas = canvas
    this.context = context
    this.theme = { ...DEFAULT_MAZE_RENDER_THEME, ...options.theme }
    this.pixelRatio =
      options.devicePixelRatio ??
      (typeof window !== 'undefined' ? clamp(window.devicePixelRatio || 1, 1, 3) : 1)
    this.fitPadding = options.fitPadding ?? 28
    // 150×150 must still fit inside a narrow phone canvas (roughly
    // 1.7 CSS pixels per cell after padding).
    this.minScale = Math.max(0.25, options.minScale ?? 0.5)
    this.maxScale = Math.max(this.minScale, options.maxScale ?? 160)
  }

  getModel(): MazeRenderModel | null {
    return this.model
  }

  setModel(model: MazeRenderModel | null, options: { fit?: boolean } = {}): void {
    const previous = this.model
    if (previous?.graph !== model?.graph) {
      this.invalidateStaticLayer()
    }
    this.model = model
    if (!model) {
      this.hasFitOnce = false
      return
    }
    const dimensionsChanged =
      previous !== null &&
      (previous.graph.rows !== model.graph.rows ||
        previous.graph.cols !== model.graph.cols)
    const projectChanged =
      previous?.projectId !== undefined &&
      model.projectId !== undefined &&
      previous.projectId !== model.projectId
    if (options.fit || !this.hasFitOnce || dimensionsChanged || projectChanged) {
      this.fit()
    } else {
      this.constrainViewport()
    }
  }

  setTheme(theme: Partial<MazeRenderTheme>): void {
    const next = { ...this.theme, ...theme }
    const staticColorsChanged =
      next.mazeFill !== this.theme.mazeFill ||
      next.wall !== this.theme.wall ||
      next.wallShadow !== this.theme.wallShadow ||
      next.invalid !== this.theme.invalid
    this.theme = next
    if (staticColorsChanged) this.invalidateStaticLayer()
  }

  getTheme(): Readonly<MazeRenderTheme> {
    return this.theme
  }

  getViewport(): Readonly<MazeViewport> {
    return this.viewport
  }

  setViewport(viewport: MazeViewport): void {
    this.viewport = {
      scale: clamp(viewport.scale, this.minScale, this.maxScale),
      x: viewport.x,
      y: viewport.y,
    }
    this.constrainViewport()
  }

  resize(width: number, height: number, pixelRatio = this.pixelRatio): void {
    const nextWidth = Math.max(1, Math.round(width))
    const nextHeight = Math.max(1, Math.round(height))
    const nextRatio = clamp(pixelRatio || 1, 1, 3)
    if (
      nextWidth === this.cssWidth &&
      nextHeight === this.cssHeight &&
      nextRatio === this.pixelRatio
    ) {
      return
    }

    const centerBefore =
      this.model && this.hasFitOnce
        ? this.screenToWorld({ x: this.cssWidth / 2, y: this.cssHeight / 2 })
        : null
    this.cssWidth = nextWidth
    this.cssHeight = nextHeight
    this.pixelRatio = nextRatio
    this.canvas.width = Math.ceil(nextWidth * nextRatio)
    this.canvas.height = Math.ceil(nextHeight * nextRatio)

    if (centerBefore) {
      this.viewport.x = nextWidth / 2 - centerBefore.x * this.viewport.scale
      this.viewport.y = nextHeight / 2 - centerBefore.y * this.viewport.scale
      this.constrainViewport()
    } else if (this.model) {
      this.fit()
    }
  }

  fit(padding = this.fitPadding): void {
    if (!this.model) return
    const { rows, cols } = this.model.graph
    const usableWidth = Math.max(1, this.cssWidth - padding * 2)
    const usableHeight = Math.max(1, this.cssHeight - padding * 2)
    const scale = clamp(
      Math.min(usableWidth / Math.max(1, cols), usableHeight / Math.max(1, rows)),
      this.minScale,
      this.maxScale,
    )
    this.viewport = {
      scale,
      x: (this.cssWidth - cols * scale) / 2,
      y: (this.cssHeight - rows * scale) / 2,
    }
    this.hasFitOnce = true
  }

  panBy(deltaX: number, deltaY: number): void {
    this.viewport.x += deltaX
    this.viewport.y += deltaY
    this.constrainViewport()
  }

  zoomAt(factor: number, screenPoint: MazeScreenPoint): void {
    if (!Number.isFinite(factor) || factor <= 0) return
    const before = this.screenToWorld(screenPoint)
    const scale = clamp(this.viewport.scale * factor, this.minScale, this.maxScale)
    this.viewport.scale = scale
    this.viewport.x = screenPoint.x - before.x * scale
    this.viewport.y = screenPoint.y - before.y * scale
    this.constrainViewport()
  }

  screenToWorld(point: MazeScreenPoint): MazeScreenPoint {
    return {
      x: (point.x - this.viewport.x) / this.viewport.scale,
      y: (point.y - this.viewport.y) / this.viewport.scale,
    }
  }

  worldToScreen(point: MazeScreenPoint): MazeScreenPoint {
    return {
      x: point.x * this.viewport.scale + this.viewport.x,
      y: point.y * this.viewport.scale + this.viewport.y,
    }
  }

  hitTest(screenPoint: MazeScreenPoint, preferWall = false): MazeHit | null {
    if (!this.model) return null
    const world = this.screenToWorld(screenPoint)
    const col = Math.floor(world.x)
    const row = Math.floor(world.y)
    const position = { row, col }
    if (!isPointInMaze(position, this.model)) return null

    if (preferWall) {
      const localX = world.x - col
      const localY = world.y - row
      const distances: ReadonlyArray<[keyof CellWalls, number]> = [
        ['left', localX],
        ['right', 1 - localX],
        ['top', localY],
        ['bottom', 1 - localY],
      ]
      const [wall, distance] = distances.reduce((best, candidate) =>
        candidate[1] < best[1] ? candidate : best,
      )
      const threshold = clamp(8 / this.viewport.scale, 0.08, 0.28)
      if (distance <= threshold) {
        return { kind: 'wall', row, col, wall, x: world.x, y: world.y }
      }
    }

    return { kind: 'cell', row, col, x: world.x, y: world.y }
  }

  invalidateStaticLayer(): void {
    this.staticRevision += 1
  }

  render(frame: MazeRenderFrame = {}): void {
    const context = this.context
    context.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0)
    context.clearRect(0, 0, this.cssWidth, this.cssHeight)
    context.fillStyle = this.theme.canvas
    context.fillRect(0, 0, this.cssWidth, this.cssHeight)

    if (!this.model) return
    const layers = this.ensureStaticLayers()
    const { rows, cols } = this.model.graph

    context.save()
    context.translate(this.viewport.x, this.viewport.y)
    context.scale(this.viewport.scale, this.viewport.scale)
    context.imageSmoothingEnabled = true

    context.drawImage(layers.floor, 0, 0, layers.floor.width, layers.floor.height, 0, 0, cols, rows)
    this.drawReveal(frame)
    this.drawVisited(frame.visited ?? [])
    this.drawWater(frame)
    this.drawSolution(frame.solution ?? [], frame.solutionProgress)
    this.drawGeneration(frame)
    context.drawImage(layers.walls, 0, 0, layers.walls.width, layers.walls.height, 0, 0, cols, rows)
    this.drawEndpoints(frame.showLabels !== false)
    this.drawMarkers(frame)
    this.drawGhost(frame)
    if (frame.player && isPointInMaze(frame.player, this.model)) {
      this.drawPlayer(frame.player)
    }
    this.drawParticles(frame.particles ?? [])
    context.restore()
  }

  dispose(): void {
    this.staticLayers = null
    this.model = null
  }

  private ensureStaticLayers(): StaticLayers {
    if (this.staticLayers && this.builtRevision === this.staticRevision) {
      return this.staticLayers
    }
    if (!this.model) {
      throw new Error('미로 모델이 설정되지 않았습니다.')
    }

    const { graph } = this.model
    const longestSide = Math.max(graph.rows, graph.cols)
    // Keep both cached layers below roughly 32 MB in total at the 150×150
    // target size; a 4096² cache per layer is needlessly expensive on phones.
    const cellPixels = clamp(Math.floor(2048 / Math.max(1, longestSide)), 5, 28)
    const width = graph.cols * cellPixels
    const height = graph.rows * cellPixels
    const canReuse =
      this.staticLayers?.floor.width === width &&
      this.staticLayers.floor.height === height &&
      this.staticLayers.cellPixels === cellPixels
    const floor = canReuse
      ? this.staticLayers!.floor
      : createLayerCanvas(width, height)
    const walls = canReuse
      ? this.staticLayers!.walls
      : createLayerCanvas(width, height)
    const floorContext = floor.getContext('2d')
    const wallContext = walls.getContext('2d')
    if (!floorContext || !wallContext) {
      throw new Error('정적 미로 레이어를 만들 수 없습니다.')
    }

    let activeHash = 2166136261
    for (const cell of graph.cells) {
      if (cell.active) {
        activeHash ^= cell.index + 1
        activeHash = Math.imul(activeHash, 16777619)
      }
    }
    const floorSignature = `${graph.rows}:${graph.cols}:${activeHash >>> 0}:${this.theme.invalid}:${this.theme.mazeFill}`
    if (!canReuse || this.staticLayers?.floorSignature !== floorSignature) {
      floorContext.setTransform(1, 0, 0, 1, 0, 0)
      floorContext.clearRect(0, 0, width, height)
      floorContext.fillStyle = this.theme.invalid
      floorContext.fillRect(0, 0, width, height)
      floorContext.fillStyle = this.theme.mazeFill
      for (const cell of graph.cells) {
        if (!cell.active) continue
        floorContext.fillRect(
          cell.col * cellPixels,
          cell.row * cellPixels,
          cellPixels + 0.5,
          cellPixels + 0.5,
        )
      }
    }

    const wallWidth = clamp(cellPixels * 0.09, 1.25, 3.25)
    const wallSegments = new Set<string>()
    const visualOpenings = new Map<number, WallDirection>()
    for (const endpoint of [this.model.start, this.model.end]) {
      const direction = getVisualOpeningDirection(graph, endpoint)
      if (direction) {
        visualOpenings.set(endpoint.row * graph.cols + endpoint.col, direction)
      }
    }
    const addWall = (x1: number, y1: number, x2: number, y2: number): void => {
      const key =
        x1 < x2 || (x1 === x2 && y1 <= y2)
          ? `${x1},${y1},${x2},${y2}`
          : `${x2},${y2},${x1},${y1}`
      wallSegments.add(key)
    }

    for (const cell of graph.cells) {
      if (!cell.active) continue
      const x = cell.col * cellPixels
      const y = cell.row * cellPixels
      const opening = visualOpenings.get(cell.index)
      if (cell.walls.top && opening !== 'top') addWall(x, y, x + cellPixels, y)
      if (cell.walls.right && opening !== 'right') addWall(x + cellPixels, y, x + cellPixels, y + cellPixels)
      if (cell.walls.bottom && opening !== 'bottom') addWall(x, y + cellPixels, x + cellPixels, y + cellPixels)
      if (cell.walls.left && opening !== 'left') addWall(x, y, x, y + cellPixels)
    }

    wallContext.setTransform(1, 0, 0, 1, 0, 0)
    wallContext.clearRect(0, 0, width, height)
    wallContext.lineCap = 'round'
    wallContext.lineJoin = 'round'
    wallContext.shadowColor = this.theme.wallShadow
    wallContext.shadowBlur = Math.max(0.5, wallWidth)
    wallContext.strokeStyle = this.theme.wall
    wallContext.lineWidth = wallWidth
    wallContext.beginPath()
    for (const encoded of wallSegments) {
      const [x1, y1, x2, y2] = encoded.split(',').map(Number)
      wallContext.moveTo(x1, y1)
      wallContext.lineTo(x2, y2)
    }
    wallContext.stroke()

    this.staticLayers = { floor, walls, cellPixels, floorSignature }
    this.builtRevision = this.staticRevision
    return this.staticLayers
  }

  private drawReveal(frame: MazeRenderFrame): void {
    if (!this.model || !frame.reveal || frame.reveal.cells.length === 0) return
    const { reveal } = frame
    const context = this.context
    context.save()
    context.beginPath()
    for (const point of reveal.cells) {
      if (!isPointInMaze(point, this.model)) continue
      context.rect(point.col, point.row, 1.001, 1.001)
    }
    context.clip()
    context.globalAlpha = clamp(reveal.opacity ?? 1, 0, 1)
    if (reveal.source) {
      context.drawImage(reveal.source, 0, 0, this.model.graph.cols, this.model.graph.rows)
    } else {
      context.fillStyle = reveal.color ?? this.theme.visited
      context.fillRect(0, 0, this.model.graph.cols, this.model.graph.rows)
    }
    context.restore()
  }

  private drawVisited(visited: ReadonlyArray<MazePoint>): void {
    if (!this.model || visited.length === 0) return
    const context = this.context
    context.save()
    context.fillStyle = this.theme.visited
    for (const point of visited) {
      if (!isPointInMaze(point, this.model)) continue
      context.fillRect(point.col + 0.06, point.row + 0.06, 0.88, 0.88)
    }
    context.restore()
  }

  private drawSolution(solution: ReadonlyArray<MazePoint>, progress = 1): void {
    if (!this.model || solution.length === 0 || progress <= 0) return
    const safePoints = solution.filter((point) => isPointInMaze(point, this.model!))
    const pointCount = clamp(Math.ceil(safePoints.length * clamp(progress, 0, 1)), 1, safePoints.length)
    drawPathLine(
      this.context,
      safePoints.slice(0, pointCount),
      this.theme.solution,
      0.15,
      0.82,
    )
  }

  private drawWater(frame: MazeRenderFrame): void {
    if (!this.model || !frame.water || frame.water.cells.length === 0) return
    const context = this.context
    context.save()
    context.globalAlpha = clamp(frame.water.opacity, 0, 1)
    context.fillStyle = frame.water.color ?? this.theme.solution
    for (const point of frame.water.cells) {
      if (!isPointInMaze(point, this.model)) continue
      context.fillRect(point.col, point.row, 1.001, 1.001)
    }
    context.restore()
  }

  private drawGeneration(frame: MazeRenderFrame): void {
    if (!this.model || !frame.generation?.edges.length) return
    const progress = clamp(frame.generation.progress, 0, 1)
    if (progress <= 0) return
    const count = Math.min(
      frame.generation.edges.length,
      Math.max(1, Math.ceil(frame.generation.edges.length * progress)),
    )
    const context = this.context
    context.save()
    context.strokeStyle = frame.generation.color ?? this.theme.solution
    context.lineWidth = 0.2
    context.lineCap = 'round'
    context.globalAlpha = 0.7
    context.beginPath()
    for (let index = 0; index < count; index += 1) {
      const edge = frame.generation.edges[index]
      if (
        !isPointInMaze(edge.from, this.model) ||
        !isPointInMaze(edge.to, this.model)
      ) {
        continue
      }
      const from = cellCenter(edge.from)
      const to = cellCenter(edge.to)
      context.moveTo(from.x, from.y)
      context.lineTo(to.x, to.y)
    }
    context.stroke()
    context.restore()
  }

  private drawMarkers(frame: MazeRenderFrame): void {
    if (!this.model) return
    const context = this.context

    for (const checkpoint of this.model.checkpoints ?? []) {
      if (!isPointInMaze(checkpoint, this.model)) continue
      const isActive =
        checkpoint.id !== undefined && frame.activeCheckpointIds?.has(checkpoint.id)
      const center = cellCenter(checkpoint)
      context.save()
      context.globalAlpha = isActive ? 1 : 0.72
      context.fillStyle = this.theme.checkpoint
      drawRoundedRect(context, center.x - 0.27, center.y - 0.27, 0.54, 0.54, 0.12)
      context.fill()
      context.fillStyle = '#ffffff'
      context.font = '700 0.28px system-ui, sans-serif'
      context.textAlign = 'center'
      context.textBaseline = 'middle'
      context.fillText(checkpoint.label?.slice(0, 2) || 'C', center.x, center.y + 0.01)
      context.restore()
    }

    for (const item of this.model.collectibles ?? []) {
      if (!isPointInMaze(item, this.model)) continue
      if (item.id !== undefined && frame.collectedItemIds?.has(item.id)) continue
      const center = cellCenter(item)
      context.save()
      context.fillStyle = this.theme.collectible
      context.translate(center.x, center.y)
      context.rotate(Math.PI / 4)
      drawRoundedRect(context, -0.2, -0.2, 0.4, 0.4, 0.07)
      context.fill()
      context.restore()
    }
  }

  private drawGhost(frame: MazeRenderFrame): void {
    if (!this.model) return
    const trail = (frame.ghostTrail ?? []).filter((point) =>
      isInterpolatedPointVisible(point, this.model!),
    )
    if (trail.length > 1) {
      this.context.save()
      this.context.setLineDash([0.18, 0.16])
      drawPathLine(this.context, trail, this.theme.ghost, 0.1, 0.38)
      this.context.restore()
    }
    if (!frame.ghost || !isInterpolatedPointVisible(frame.ghost, this.model)) return
    const center = cellCenter(frame.ghost)
    this.context.save()
    this.context.globalAlpha = 0.58
    this.context.fillStyle = this.theme.ghost
    this.context.beginPath()
    this.context.arc(center.x, center.y, 0.27, 0, Math.PI * 2)
    this.context.fill()
    this.context.strokeStyle = '#ffffff'
    this.context.lineWidth = 0.07
    this.context.stroke()
    this.context.restore()
  }

  private drawPlayer(player: MazePoint): void {
    const center = cellCenter(player)
    const context = this.context
    context.save()
    context.shadowColor = 'rgba(15, 23, 42, 0.26)'
    context.shadowBlur = 0.12
    context.fillStyle = this.theme.player
    context.beginPath()
    context.arc(center.x, center.y, 0.3, 0, Math.PI * 2)
    context.fill()
    context.shadowColor = 'transparent'
    context.strokeStyle = '#ffffff'
    context.lineWidth = 0.075
    context.stroke()
    context.restore()
  }

  private drawParticles(particles: ReadonlyArray<MazeParticle>): void {
    if (particles.length === 0) return
    const context = this.context
    context.save()
    for (const particle of particles) {
      if (!Number.isFinite(particle.x) || !Number.isFinite(particle.y)) continue
      context.globalAlpha = clamp(particle.opacity, 0, 1)
      context.fillStyle = particle.color ?? this.theme.solution
      context.beginPath()
      context.arc(particle.x, particle.y, Math.max(0.01, particle.radius), 0, Math.PI * 2)
      context.fill()
    }
    context.restore()
  }

  private drawEndpoints(showLabels: boolean): void {
    if (!this.model) return
    const drawEndpoint = (point: MazePoint, label: 'S' | 'E', color: string): void => {
      if (!isPointInMaze(point, this.model!)) return
      const center = cellCenter(point)
      const context = this.context
      context.save()
      context.fillStyle = color
      context.beginPath()
      context.arc(center.x, center.y, 0.31, 0, Math.PI * 2)
      context.fill()
      context.strokeStyle = '#ffffff'
      context.lineWidth = 0.065
      context.stroke()
      if (showLabels && this.viewport.scale >= 8) {
        context.fillStyle = '#ffffff'
        context.font = '800 0.31px system-ui, sans-serif'
        context.textAlign = 'center'
        context.textBaseline = 'middle'
        context.fillText(label, center.x, center.y + 0.012)
      }
      context.restore()
    }

    drawEndpoint(this.model.start, 'S', this.theme.start)
    drawEndpoint(this.model.end, 'E', this.theme.end)
  }

  private constrainViewport(): void {
    if (!this.model || this.cssWidth <= 1 || this.cssHeight <= 1) return
    const mazeWidth = this.model.graph.cols * this.viewport.scale
    const mazeHeight = this.model.graph.rows * this.viewport.scale
    const visibleX = Math.min(44, this.cssWidth / 2, Math.max(8, mazeWidth / 2))
    const visibleY = Math.min(44, this.cssHeight / 2, Math.max(8, mazeHeight / 2))
    this.viewport.x = clamp(this.viewport.x, visibleX - mazeWidth, this.cssWidth - visibleX)
    this.viewport.y = clamp(this.viewport.y, visibleY - mazeHeight, this.cssHeight - visibleY)
  }
}
